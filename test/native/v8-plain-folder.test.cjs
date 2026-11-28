'use strict';
// Step 3 of the final plan, requirement 3: any folder is a project (a novel, music, not only code), and accepting a
// ticket puts its work into the project. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const load = require('../load-ts.cjs');
const { TicketWorkspaces } = load('src/main/v8/workspace.ts');

function setup(t, git) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-folder-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const project = path.join(root, '我的小说'), state = path.join(root, 'state');
  fs.mkdirSync(path.join(project, '章节'), { recursive: true });
  fs.writeFileSync(path.join(project, '章节', '第一章.md'), '天亮了。\r\n');
  fs.writeFileSync(path.join(project, '大纲.txt'), '三幕\n');
  fs.writeFileSync(path.join(project, '封面.bin'), Buffer.from([0, 1, 2, 255]));
  if (git) {
    const g = (...a) => execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
    g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'start');
  }
  return { project, spaces: new TicketWorkspaces(project, path.join(state, 'work')) };
}

const list = dir => { const out = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') continue; const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(path.relative(dir, p).split(path.sep).join('/')); } }; walk(dir); return out.sort(); };

for (const git of [false, true]) {
  const kind = git ? 'a git repository' : 'a plain folder';

  test(`${kind}: a ticket works on its own copy; accepting puts exactly its changes in`, t => {
    const { project, spaces } = setup(t, git);
    const dir = spaces.ensure(1);
    assert.notEqual(dir, project);
    assert.deepEqual(list(dir), ['大纲.txt', '封面.bin', '章节/第一章.md']);
    // The gremlin edits one file, adds one, removes one; the project is untouched until accepted.
    fs.writeFileSync(path.join(dir, '章节', '第一章.md'), '天亮了。\r\n她出门了。\r\n');
    fs.writeFileSync(path.join(dir, '章节', '第二章.md'), '下雨。\n');
    fs.rmSync(path.join(dir, '大纲.txt'));
    assert.equal(fs.readFileSync(path.join(project, '章节', '第一章.md'), 'utf8'), '天亮了。\r\n');
    assert.match(spaces.diff(1), /她出门了/);
    // File names stay as written, not git's octal escapes (老板 2026-11-28: the delivery page could not match them).
    assert.match(spaces.diff(1), /^\+\+\+ b\/章节\/第二章\.md$/m);
    const r = spaces.apply(1);
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual(r.applied.sort(), ['大纲.txt', '章节/第一章.md', '章节/第二章.md'].sort());
    assert.equal(fs.readFileSync(path.join(project, '章节', '第一章.md'), 'utf8'), '天亮了。\r\n她出门了。\r\n');
    assert.equal(fs.readFileSync(path.join(project, '章节', '第二章.md'), 'utf8'), '下雨。\n');
    assert.equal(fs.existsSync(path.join(project, '大纲.txt')), false);
    assert.deepEqual([...fs.readFileSync(path.join(project, '封面.bin'))], [0, 1, 2, 255], 'an untouched binary file is left as it was');
    if (!git) assert.equal(fs.existsSync(path.join(project, '.git')), false, 'nothing is written into a plain folder');
    if (git) assert.equal(execFileSync('git', ['-C', project, 'branch', '--list', 'gw/*']).toString().trim(), '', 'no branches in the boss\'s repository');
  });

  test(`${kind}: a file the boss changed meanwhile is not overwritten, and nothing goes in`, t => {
    const { project, spaces } = setup(t, git);
    const dir = spaces.ensure(1);
    fs.writeFileSync(path.join(dir, '章节', '第一章.md'), '小怪的版本\n');
    fs.writeFileSync(path.join(dir, '新文件.md'), 'x\n');
    fs.writeFileSync(path.join(project, '章节', '第一章.md'), '老板自己改的\n');
    const r = spaces.apply(1);
    assert.deepEqual(r, { applied: [], conflicts: ['章节/第一章.md'] });
    assert.equal(fs.readFileSync(path.join(project, '章节', '第一章.md'), 'utf8'), '老板自己改的\n');
    assert.equal(fs.existsSync(path.join(project, '新文件.md')), false, 'all or nothing');
  });

  test(`${kind}: two tickets start from the folder as it is when each starts, and both can be accepted`, t => {
    const { project, spaces } = setup(t, git);
    const one = spaces.ensure(1);
    fs.writeFileSync(path.join(one, '大纲.txt'), '三幕\n加一幕\n');
    assert.deepEqual(spaces.apply(1).conflicts, []);
    // Ticket 2 starts after ticket 1 was accepted, so it sees ticket 1's work, committed or not.
    const two = spaces.ensure(2);
    assert.equal(fs.readFileSync(path.join(two, '大纲.txt'), 'utf8'), '三幕\n加一幕\n');
    fs.writeFileSync(path.join(two, '章节', '第三章.md'), '完。\n');
    assert.deepEqual(spaces.apply(2), { applied: ['章节/第三章.md'], conflicts: [] });
    assert.equal(fs.readFileSync(path.join(project, '大纲.txt'), 'utf8'), '三幕\n加一幕\n');
  });
}

test('test caches are never put into the project; a log or build output is, unless the project ignores it (C3 finding 14)', t => {
  const { project, spaces } = setup(t, false);
  const dir = spaces.ensure(1);
  fs.mkdirSync(path.join(dir, '__pycache__'));
  fs.writeFileSync(path.join(dir, '__pycache__', 'x.pyc'), 'junk');
  fs.writeFileSync(path.join(dir, 'run.log'), 'render done\n');
  fs.writeFileSync(path.join(dir, '大纲.txt'), '四幕\n');
  assert.deepEqual(spaces.apply(1).applied.sort(), ['run.log', '大纲.txt']);
  assert.equal(fs.existsSync(path.join(project, '__pycache__')), false);
  assert.equal(fs.readFileSync(path.join(project, 'run.log'), 'utf8'), 'render done\n');
});
