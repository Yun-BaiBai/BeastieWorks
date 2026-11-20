'use strict';
// v8 B3: the oh-my-pi shell over its RPC protocol, one git worktree per ticket, and the directory approval rule.
// The omp process is played by test/fixtures/fake-omp-rpc.cjs (same NDJSON protocol, no model).
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3'), load = require('../load-ts.cjs');
const { Scheduler } = load('src/main/v8/scheduler.ts');
const { Dispatcher } = load('src/main/v8/dispatcher.ts');
const { OmpShell, ompArgs } = load('src/main/v8/ompShell.ts');
const { TicketWorkspaces, inside } = load('src/main/v8/workspace.ts');
const { directoryPolicy } = load('src/main/v8/approval.ts');
const { LEAD_SYSTEM, WORKER_SYSTEM, LEAD_TOOLS, REPORT_TOOL } = load('src/main/v8/prompts.ts');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-omp-rpc.cjs');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function repo(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-omp-'));
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

async function until(check, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('timed out waiting for ' + what);
}

function line(t, o = {}) {
  const { home, root, first } = repo(t);
  const db = new Database(':memory:');
  const s = new Scheduler(db);
  const spaces = new TicketWorkspaces(root, path.join(home, 'work'));
  const log = path.join(home, 'omp.log');
  process.env.SHOULD_NOT_LEAK = 'secret';
  const shell = new OmpShell({ exe: process.execPath, prefixArgs: [FAKE], agentDir: path.join(home, 'agent'), sessionDir: path.join(home, 'sessions'),
    env: { ELECTRON_RUN_AS_NODE: '1', OPENAI_API_KEY: 'test-key', FAKE_OMP_LOG: log }, readyTimeoutMs: 20000 });
  const d = new Dispatcher(s, shell, { workdir: id => spaces.ensure(id), approve: directoryPolicy({ workdir: id => spaces.path(id) }) });
  const activity = [];
  d.onActivity(a => activity.push(a));
  first.push(async () => { await d.shutdown(); db.close(); delete process.env.SHOULD_NOT_LEAK; });
  const open = text => s.openTicket({ fromMessageId: s.bossSaid(text), routingNote: '' });
  const frames = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { home, root, s, d, spaces, activity, open, frames, ...o };
}

test('omp arguments: the lead gets no tools and its own system prompt; a gremlin keeps the tools and gets ours appended', () => {
  const base = { cwd: 'D:/w', model: 'openai/gpt-5.4-mini', sessionRef: null };
  const lead = ompArgs({ ...base, role: 'lead', systemPrompt: LEAD_SYSTEM, hostTools: LEAD_TOOLS, builtinTools: false }, { sessionDir: 'D:/s' });
  for (const flag of ['--no-tools', '--no-lsp', '--no-skills', '--no-context-files']) assert.ok(lead.includes(flag), flag);
  assert.equal(lead[lead.indexOf('--system-prompt') + 1], LEAD_SYSTEM);
  const worker = ompArgs({ ...base, role: 'worker', systemPrompt: WORKER_SYSTEM, hostTools: [REPORT_TOOL], builtinTools: true }, { sessionDir: 'D:/s' });
  assert.ok(!worker.includes('--no-tools'));
  assert.equal(worker[worker.indexOf('--append-system-prompt') + 1], WORKER_SYSTEM);
  for (const a of [lead, worker]) {
    assert.equal(a[a.indexOf('--approval-mode') + 1], 'always-ask', 'never auto-approve');
    assert.equal(a[a.indexOf('--model') + 1], 'openai/gpt-5.4-mini');
    assert.ok(!a.includes('--auto-approve'));
  }
});

test('omp arguments: a spending cap is passed to omp and must be sane', () => {
  const spec = { cwd: 'D:/w', model: null, sessionRef: null, role: 'worker', systemPrompt: 'x', hostTools: [], builtinTools: true };
  const a = ompArgs(spec, { sessionDir: 'D:/s', maxCostUsd: 1 });
  assert.equal(a[a.indexOf('--max-cost') + 1], '1');
  assert.ok(!ompArgs(spec, { sessionDir: 'D:/s' }).includes('--max-cost'));
  for (const bad of [0, -1, 1000, NaN]) assert.throws(() => ompArgs(spec, { sessionDir: 'D:/s', maxCostUsd: bad }), /V8_MAX_COST_INVALID/);
});

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

test('the whole line over the omp protocol: worktree, approvals, report, cost; the main checkout stays untouched', async t => {
  const f = line(t);
  const id = f.open('calc.py 的 add 算错了，修一下');
  await f.d.pump();
  await until(() => f.s.state(id) === 'REVIEW', 'the report');
  const dir = f.spaces.path(id);
  assert.match(fs.readFileSync(path.join(dir, 'calc.py'), 'utf8'), /a \+ b/);
  assert.match(fs.readFileSync(path.join(f.root, 'calc.py'), 'utf8'), /a - b/, 'the main checkout is untouched');
  const frames = f.frames();
  const env = frames.find(x => x.env).env;
  assert.deepEqual(env, { key: true, agentDir: path.join(f.home, 'agent').replace(/\\/g, '/'), secret: null, magpieKey: null }, 'the key reaches omp; nothing else from the app does (no gateway: no Magpie key)');
  assert.deepEqual(frames.find(x => x.type === 'set_host_tools').tools.map(x => x.name), ['submit_report']);
  assert.ok(frames.find(x => x.type === 'set_host_tools').tools.every(x => x.loadMode === 'essential'), 'host tools are first-class tools');
  assert.deepEqual(frames.filter(x => x.type === 'extension_ui_response').map(x => x.value), ['Approve', 'Approve']);
  assert.ok(frames.some(x => x.type === 'host_tool_result' && !x.isError));
  assert.ok(f.activity.some(a => a.type === 'cost' && a.usd > 0));
  assert.ok(f.activity.some(a => a.type === 'said' && a.text === '交了报告'));
  assert.deepEqual(f.activity.filter(a => a.type === 'tool' && a.phase === 'start').map(a => a.name), ['read', 'edit']);
  assert.match(f.s.latestReport(id).summary, /把减号改成了加号/);
});

test('a write outside the ticket directory is refused; the gremlin reports blocked; retry resumes the same session file', async t => {
  const f = line(t);
  const id = f.open('越界改一下');
  await f.d.pump();
  await until(() => f.s.state(id) === 'BLOCKED', 'the blocked report');
  assert.ok(!fs.existsSync(path.join(f.home, 'work', 'outside.txt')));
  assert.match(f.s.latestReport(id).tried, /edit=Deny/);
  f.s.retryTicket(id);
  await f.d.pump();
  await until(() => f.frames().some(x => x.type === 'switch_session'), 'the resume');
  const sw = f.frames().find(x => x.type === 'switch_session');
  assert.ok(sw.sessionPath.endsWith('.jsonl'));
  // The retry prompt no longer asks for the out-of-bounds write, so this time the gremlin finishes inside its directory.
  await until(() => f.s.state(id) === 'REVIEW' && f.d.running().length === 0, 'the second report');
});

test('a command that reaches the network is refused', async t => {
  const f = line(t);
  const id = f.open('联网查一下');
  await f.d.pump();
  await until(() => f.s.state(id) === 'BLOCKED', 'the blocked report');
  assert.match(f.s.latestReport(id).tried, /bash=Deny/);
});

test('steering reaches the running omp turn; stopping aborts it and ends the process', async t => {
  const f = line(t);
  const a = f.open('首页太慢了');
  await f.d.pump();
  await until(() => f.frames().filter(x => x.type === 'extension_ui_response').length === 2, 'the approvals');
  await f.d.tell(a, '别动图片尺寸');
  await until(() => f.s.state(a) === 'REVIEW', 'the steered report');
  assert.match(f.s.latestReport(a).summary, /老板说：别动图片尺寸/);
  const b = f.open('列表也慢');
  await f.d.pump();
  await until(() => f.frames().filter(x => x.type === 'extension_ui_response').length === 4, 'the second gremlin');
  await f.d.stop(b);
  assert.equal(f.s.state(b), 'STOPPED');
  assert.ok(f.frames().some(x => x.type === 'abort'));
  assert.deepEqual(f.d.running(), []);
});

test('an omp process that dies mid-turn fails the ticket with its exit code', async t => {
  const f = line(t);
  const id = f.open('崩溃一下');
  await f.d.pump();
  await until(() => f.s.state(id) === 'FAILED', 'the failure');
  assert.match(f.s.latestReport(id).reason, /omp exited \(3\)/);
});

test('an omp that never says ready is a failure to open, not a hang', async t => {
  const { home, root } = repo(t);
  const db = new Database(':memory:');
  t.after(() => db.close());
  const s = new Scheduler(db);
  const shell = new OmpShell({ exe: process.execPath, prefixArgs: ['-e', 'setTimeout(()=>{},60000)'], agentDir: home, sessionDir: home, env: { ELECTRON_RUN_AS_NODE: '1' }, readyTimeoutMs: 800 });
  const d = new Dispatcher(s, shell, { workdir: () => root });
  const id = s.openTicket({ fromMessageId: s.bossSaid('修一下'), routingNote: '' });
  await d.pump();
  await until(() => s.state(id) === 'FAILED', 'the failure');
  assert.match(s.latestReport(id).reason, /开不了会话：omp did not start/);
});
