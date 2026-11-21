'use strict';
// v8: one workbench folder per project. Tickets of different projects never mix, numbers start at 1 in each,
// switching projects closes one workbench and opens the other, and coming back finds everything as it was.
// Fake shell, no model. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execFileSync } = require('node:child_process');
const load = require('../load-ts.cjs');
const { projectKey, projectStateDir, listProjects } = load('src/main/v8/projects.ts');
const { WorkbenchHost } = load('src/main/v8/host.ts');

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), '# ' + path.basename(dir) + '\n');
  git(dir, 'add', '-A');
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'init']);
  return dir;
}
async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 15)); }
  assert.fail('timed out waiting for ' + what);
}
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-proj-'));
  const closers = [];
  t.after(async () => { for (const c of closers) await c(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, closers };
}

test('project folders: one per project path, stable, case-insensitive; the demo has its own', t => {
  const h = home(t);
  const a = path.join(h.dir, 'Shop Site'), b = path.join(h.dir, 'blog');
  assert.equal(projectKey(a), projectKey(a.toUpperCase()));
  assert.notEqual(projectKey(a), projectKey(b));
  assert.match(projectKey(a), /^shop-site-[0-9a-f]{8}$/);
  assert.equal(projectKey(null), 'demo');
  const base = path.join(h.dir, 'v8');
  const da = projectStateDir(base, a, 100), db = projectStateDir(base, b, 200);
  assert.notEqual(da, db);
  assert.equal(projectStateDir(base, a, 999), da, 'the same folder every time');
  projectStateDir(base, null, 300);
  assert.deepEqual(listProjects(base).map(p => [p.name, p.root === null ? null : path.basename(p.root), p.createdAt]), [['Shop Site', 'Shop Site', 100], ['blog', 'blog', 200], ['演示项目', null, 300]]);
});

test('switching projects: separate tickets and numbering; work running when you leave is picked up when you come back', async t => {
  const h = home(t);
  const A = repo(path.join(h.dir, 'proj-a')), B = repo(path.join(h.dir, 'proj-b'));
  let settings = { projectRoot: A };
  const host = new WorkbenchHost({ base: path.join(h.dir, 'v8'), settings: () => settings, enabled: () => true, onChange: () => undefined, demoPace: 0.02 });
  h.closers.push(() => host.shutdown());

  const a1 = await host.get();
  a1.say('A 的首页标题改一下');
  await until(() => a1.scheduler.tickets()[0]?.state === 'REVIEW', 'A ticket 1');
  a1.say('A 的列表太慢');                         // works until spoken to: still running when we leave
  await until(() => a1.scheduler.tickets()[1]?.state === 'WORKING', 'A ticket 2 at work');

  settings = { projectRoot: B };
  const b1 = await host.get();
  assert.notEqual(b1, a1, 'a different workbench');
  assert.equal(host.current(), b1);
  assert.deepEqual(b1.scheduler.tickets(), [], 'B starts empty');
  b1.say('B 的页脚改一下');
  await until(() => b1.scheduler.tickets()[0]?.state === 'REVIEW', 'B ticket 1');
  assert.equal(b1.scheduler.tickets()[0].id, 1, 'numbering starts at 1 in every project');
  assert.equal(b1.board().project, 'proj-b');

  settings = { projectRoot: A };
  const a2 = await host.get();
  const back = a2.scheduler.tickets();
  assert.deepEqual(back.map(x => x.originalRequest), ['A 的首页标题改一下', 'A 的列表太慢']);
  assert.equal(back[0].state, 'REVIEW');
  await until(() => a2.scheduler.state(2) === 'WORKING', 'A ticket 2 recovered');
  assert.ok(a2.scheduler.messages(2).some(m => /重启/.test(String(m.body))), 'it knows it was interrupted');
  await a2.tell(2, '继续');
  await until(() => a2.scheduler.state(2) === 'REVIEW', 'A ticket 2 finished after coming back');

  // Each project's ticket folders live in its own workbench folder, and the boss's repositories get no branches:
  // the work stays in the app's private snapshot store until the boss accepts it.
  const branches = repoDir => git(repoDir, 'branch', '--list', 'gw/*').split('\n').map(s => s.replace(/^[*+ ]+/, '').trim()).filter(Boolean);
  assert.equal(branches(A).length, 0);
  assert.equal(branches(B).length, 0);
  assert.equal(a2.scheduler.tickets().length, 2);
  assert.deepEqual(listProjects(path.join(h.dir, 'v8')).map(p => p.name), ['proj-a', 'proj-b']);
});

test('calls during a switch all get the new workbench; a settings change also reopens; off means nothing opens', async t => {
  const h = home(t);
  const A = repo(path.join(h.dir, 'a')), B = repo(path.join(h.dir, 'b'));
  let settings = { projectRoot: A }, on = true;
  const host = new WorkbenchHost({ base: path.join(h.dir, 'v8'), settings: () => settings, enabled: () => on, onChange: () => undefined, demoPace: 0.02 });
  h.closers.push(() => host.shutdown());
  const a = await host.get();
  settings = { projectRoot: B };
  const [x, y, z] = await Promise.all([host.get(), host.get(), host.get()]);
  assert.ok(x === y && y === z && x !== a, 'one new workbench for all callers');
  settings = { projectRoot: B, slots: 3 };
  assert.equal(await host.get(), x, 'more slots apply to the same workbench (A1)');
  settings = { projectRoot: B, slots: 3, review: false };
  const w = await host.get();
  assert.notEqual(w, x, 'a settings change reopens');
  assert.equal(w.scheduler.slots().filter(s => !s.emergency).length, 3);
  on = false;
  await assert.rejects(host.get(), /V8_WORKBENCH_OFF/);
});
