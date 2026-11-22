'use strict';
// 要求第 3 条: a video project of a few GB is not copied for every ticket. Big files stay out of the snapshot store and
// the ticket folder links to the project's own file; new big files the gremlin makes are accepted like any other.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1; uses git, no agent and no model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const load = require('../load-ts.cjs');
const { TicketWorkspaces, BIG_FILE } = load('src/main/v8/workspace.ts');

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-big-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(dir, 'film');
  fs.mkdirSync(path.join(root, 'footage'), { recursive: true });
  fs.writeFileSync(path.join(root, 'script.txt'), 'scene 1\n');
  fs.writeFileSync(path.join(root, 'footage', 'take 1.mp4'), Buffer.alloc(BIG_FILE + 1024, 7));
  return { root, spaces: new TicketWorkspaces(root, path.join(dir, 'state')), dir };
}

test('a big file is linked into the ticket, not copied and not stored', t => {
  const { root, spaces } = project(t);
  const work = spaces.ensure(1);
  const inTicket = path.join(work, 'footage', 'take 1.mp4'), inProject = path.join(root, 'footage', 'take 1.mp4');
  assert.ok(fs.existsSync(inTicket), 'the gremlin sees the footage');
  assert.equal(fs.statSync(inTicket).ino, fs.statSync(inProject).ino, 'the same file, not a copy');
  assert.equal(fs.readFileSync(path.join(work, 'script.txt'), 'utf8'), 'scene 1\n', 'small files are the ticket\'s own copy');
  const tree = execFileSync('git', ['-C', work, 'ls-files'], { encoding: 'utf8' });
  assert.doesNotMatch(tree, /take 1\.mp4/, 'the footage is not in the snapshot store');
  assert.deepEqual(spaces.changes(1), [], 'nothing changed yet');
});

test('a new big output and an edited script are accepted; a removed big file is removed', t => {
  const { root, spaces } = project(t);
  const work = spaces.ensure(2);
  fs.writeFileSync(path.join(work, 'script.txt'), 'scene 1\nscene 2\n');
  fs.writeFileSync(path.join(work, 'cut.mp4'), Buffer.alloc(BIG_FILE + 10, 9));
  // The linked footage is read-only while the ticket is open (C3 finding 2): removing it means making it writable first.
  fs.chmodSync(path.join(work, 'footage', 'take 1.mp4'), 0o666);
  fs.rmSync(path.join(work, 'footage', 'take 1.mp4'));
  const changes = spaces.changes(2).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(changes, [{ status: 'A', path: 'cut.mp4' }, { status: 'D', path: 'footage/take 1.mp4' }, { status: 'M', path: 'script.txt' }]);
  const diff = spaces.diff(2);
  assert.match(diff, /大文件 footage\/take 1\.mp4.*删掉了/);
  assert.match(diff, /大文件 cut\.mp4.*新做的/, 'a new big output is a line, not its bytes');
  assert.match(diff, /\+scene 2/, 'the script\'s change is shown as usual');
  const r = spaces.apply(2);
  assert.deepEqual(r.conflicts, []);
  assert.equal(fs.statSync(path.join(root, 'cut.mp4')).size, BIG_FILE + 10);
  assert.ok(!fs.existsSync(path.join(root, 'footage', 'take 1.mp4')));
  assert.equal(fs.readFileSync(path.join(root, 'script.txt'), 'utf8'), 'scene 1\nscene 2\n');
});

test('a big file the boss replaced in the project since the ticket started is not overwritten', t => {
  const { root, spaces } = project(t);
  const work = spaces.ensure(3);
  // The gremlin replaces the footage with a new file (a new file, not a rewrite through the link); the linked file is
  // read-only while the ticket is open, so it is made writable first.
  fs.chmodSync(path.join(work, 'footage', 'take 1.mp4'), 0o666);
  fs.rmSync(path.join(work, 'footage', 'take 1.mp4'));
  fs.writeFileSync(path.join(work, 'footage', 'take 1.mp4'), Buffer.alloc(BIG_FILE + 2048, 1));
  // Meanwhile the boss replaced the project's copy too.
  fs.rmSync(path.join(root, 'footage', 'take 1.mp4'));
  fs.writeFileSync(path.join(root, 'footage', 'take 1.mp4'), Buffer.alloc(BIG_FILE + 4096, 2));
  const r = spaces.apply(3);
  assert.deepEqual(r.conflicts, ['footage/take 1.mp4']);
  assert.equal(fs.statSync(path.join(root, 'footage', 'take 1.mp4')).size, BIG_FILE + 4096, 'the boss\'s file stays');
});
