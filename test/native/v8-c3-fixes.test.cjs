'use strict';
// The fixes for the whole-program review by another maker's agent (C3, 2026-11-21, work/c3-review/report.md):
// each test shows a hole the review found and that it is closed now.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1; uses git, no agent and no model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const load = require('../load-ts.cjs');
const { TicketWorkspaces, BIG_FILE } = load('src/main/v8/workspace.ts');
const { directoryPolicy, readOnlyPolicy } = load('src/main/v8/approval.ts');

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => {
    // Read-only files left by a failed assertion must not block the clean-up.
    const walk = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); try { fs.chmodSync(p, 0o666); } catch { /* fine */ } if (fs.statSync(p).isDirectory()) walk(p); } };
    try { walk(dir); } catch { /* fine */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return dir;
}

test('finding 1: every file of a request is checked, a command over several lines is several commands, code on the command line is refused', t => {
  const dir = tmp(t, 'v8-c3-pol-');
  const ok = directoryPolicy({ workdir: () => dir });
  const ask = (tool, detail) => ok({ ticketId: 1, tool, detail: 'x\n' + detail });
  assert.equal(ask('edit', 'Path: a.txt\nPath: b.txt'), true);
  assert.equal(ask('edit', 'Path: a.txt\nPath: C:/Windows/evil.txt'), false, 'the second file is checked too');
  assert.equal(ask('bash', 'Command: echo ok\nrm -rf src'), false, 'the second line is checked too');
  assert.equal(ask('bash', 'Command: echo ok\ncurl http://x'), false);
  assert.equal(ask('bash', 'Command: echo ok\nPath: a.txt'), true, 'the next field ends the command');
  for (const bad of ['node -e 1', 'node --eval "require(1)"', 'node -p 1', 'python -c "import os"', 'node --require ./x.js test.js']) assert.equal(ask('bash', 'Command: ' + bad), false, bad);
  for (const good of ['node test/run.js', 'node --test test/', 'npm test', 'python test_calc.py']) assert.equal(ask('bash', 'Command: ' + good), true, good);
  const ro = readOnlyPolicy(dir);
  assert.equal(ro('read', 'Read\nPath: a.txt\nPath: C:/Users/x/secret.txt'), false, 'read-only rule: every file too');
  assert.equal(ro('bash', 'x\nCommand: git log\nrm -rf .'), false);
});

function film(t) {
  const dir = tmp(t, 'v8-c3-film-');
  const root = path.join(dir, 'film');
  fs.mkdirSync(path.join(root, 'footage'), { recursive: true });
  fs.writeFileSync(path.join(root, 'script.txt'), 'scene 1\n');
  fs.writeFileSync(path.join(root, 'footage', 'take 1.mp4'), Buffer.alloc(BIG_FILE + 1024, 7));
  return { root, dir, spaces: new TicketWorkspaces(root, path.join(dir, 'state')) };
}

test('finding 2: a linked big file cannot be changed in place while its ticket is open; the project\'s file stays whole', t => {
  const { root, spaces } = film(t);
  const work = spaces.ensure(1);
  const inTicket = path.join(work, 'footage', 'take 1.mp4'), inProject = path.join(root, 'footage', 'take 1.mp4');
  assert.throws(() => fs.writeFileSync(inTicket, 'overwritten'), /EPERM|EACCES/, 'writing through the link is refused');
  assert.equal(fs.statSync(inProject).size, BIG_FILE + 1024, 'the project\'s footage is untouched');
  const policy = directoryPolicy({ workdir: () => work, protectedFiles: () => spaces.big(1).filter(b => b.linked).map(b => b.path) });
  assert.equal(policy({ ticketId: 1, tool: 'write', detail: 'x\nPath: footage/take 1.mp4' }), false, 'and the approval rule refuses it');
  assert.equal(policy({ ticketId: 1, tool: 'write', detail: 'x\nPath: footage/take 1-graded.mp4' }), true, 'a new file beside it is fine');
  spaces.release(1);
  fs.writeFileSync(inProject, Buffer.alloc(10, 1));
  assert.equal(fs.statSync(inProject).size, 10, 'once the ticket is over the boss can change his file again');
});

test('finding 13: a second ticket does not take the big files into the snapshot store', t => {
  const { spaces } = film(t);
  spaces.ensure(1);
  const second = spaces.ensure(2);
  const tree = execFileSync('git', ['-C', second, 'ls-files'], { encoding: 'utf8' });
  assert.doesNotMatch(tree, /take 1\.mp4/, 'still not stored');
  assert.equal(spaces.big(2).length, 1, 'still linked');
});

test('finding 14: output in out/, dist/ and logs is part of the work unless the project itself ignores it', t => {
  const { root, spaces } = film(t);
  fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n');
  const work = spaces.ensure(1);
  fs.mkdirSync(path.join(work, 'out'));
  fs.writeFileSync(path.join(work, 'out', 'cut.txt'), 'the edit\n');
  fs.writeFileSync(path.join(work, 'render.log'), 'done\n');
  fs.mkdirSync(path.join(work, 'dist'));
  fs.writeFileSync(path.join(work, 'dist', 'x.js'), 'x\n');
  fs.mkdirSync(path.join(work, '__pycache__'));
  fs.writeFileSync(path.join(work, '__pycache__', 'a.pyc'), 'x');
  const paths = spaces.changes(1).map(c => c.path).sort();
  assert.deepEqual(paths, ['out/cut.txt', 'render.log'], 'out/ and the log are delivered; the project\'s own ignore and caches are not');
});

test('finding 3: accepting is all or nothing: a failure part way puts every file back', t => {
  const { root, spaces } = film(t);
  fs.writeFileSync(path.join(root, 'a.txt'), 'old a\n');
  const work = spaces.ensure(1);
  fs.writeFileSync(path.join(work, 'a.txt'), 'new a\n');
  fs.writeFileSync(path.join(work, 'z.txt'), 'new z\n');
  // Putting z.txt in place fails (a full disk, a file held open), after a.txt was already swapped.
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to).endsWith('z.txt')) throw Object.assign(new Error('EBUSY: held open'), { code: 'EBUSY' }); return rename(from, to); };
  try { assert.throws(() => spaces.apply(1), /EBUSY/); } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'old a\n', 'a.txt is put back');
  assert.equal(fs.existsSync(path.join(root, 'z.txt')), false, 'z.txt never arrived');
  assert.deepEqual(fs.readdirSync(root).filter(n => n.includes('.beastie-')), [], 'no half-made files left behind');
});

test('finding 3: a folder where a new file should go is a conflict, and nothing goes in', t => {
  const { root, spaces } = film(t);
  const work = spaces.ensure(1);
  fs.writeFileSync(path.join(work, 'script.txt'), 'scene 1\nscene 2\n');
  fs.writeFileSync(path.join(work, 'z.txt'), 'new z\n');
  fs.mkdirSync(path.join(root, 'z.txt'));
  const r = spaces.apply(1);
  assert.deepEqual(r.conflicts, ['z.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'script.txt'), 'utf8'), 'scene 1\n', 'nothing went in');
});
