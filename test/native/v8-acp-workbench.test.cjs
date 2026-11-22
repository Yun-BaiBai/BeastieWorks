'use strict';
// Step 2 of the final plan: the lead and the gremlins played by agents from the roster (ACP). The app's tools reach
// them through the relay (host-tool-relay.cjs); the lead opens a ticket, a gremlin does it in its own folder and
// reports, the lead hears about it. No model: a stand-in agent that uses the tools like a real one.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { V8Workbench } = load('src/main/v8/workbench.ts');
const { describePermission } = load('src/main/v8/acpShell.ts');

const AGENT = path.join(__dirname, '..', 'fixtures', 'fake-acp-tools-agent.cjs');

async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('timed out waiting for ' + what);
}

async function bench(t, extraEnv = {}, more = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-acp-bench-'));
  const log = path.join(dir, 'log'); fs.mkdirSync(log);
  const node = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const launched = [];
  const acpLaunch = async agent => {
    launched.push(agent);
    return agent === 'gone' ? null : { label: 'Fake ' + agent, command: process.execPath, args: [AGENT], env: { ELECTRON_RUN_AS_NODE: '1', FAKE_TOOLS_LOG: log, ...extraEnv }, node, modes: { lead: 'closed', worker: 'open' }, light: { env: { LIGHT_MARK: 'light' }, sessionMeta: { light: true } } };
  };
  const settings = { shell: 'acp', review: false, slots: 1, emergencySlot: false, acp: { lead: { agent: 'lead-agent' }, worker: { agent: 'worker-agent' } }, ...more };
  const b = new V8Workbench({ stateDir: path.join(dir, 'state'), settings, acpLaunch });
  t.after(async () => { await b.shutdown().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  await b.start();
  return { b, dir, log, launched };
}

test('the lead opens a ticket with its own tool; a gremlin does it in its own folder and reports; the lead tells the boss', async t => {
  const { b, log, launched } = await bench(t);
  b.say('在项目里加一个 hello.txt，写一句你好');
  await until(() => b.scheduler.tickets().length === 1, 'the lead to open a ticket');
  const ticket = () => b.scheduler.tickets()[0];
  await until(() => ticket().state === 'REVIEW' || ticket().state === 'DONE', 'the gremlin to report done', 40000);
  const report = b.scheduler.latestReport(ticket().id);
  assert.equal(report.kind, 'done');
  assert.deepEqual(report.changed, ['hello-ticket-1.txt']);
  // The file is in the ticket's own folder, not in the project.
  const delivery = b.delivery(ticket().id);
  assert.ok(delivery, 'the boss can open the delivery');
  await until(() => b.scheduler.messages(null).some(m => m.author === 'lead' && /小怪干完了/.test(m.body)), 'the lead to tell the boss');
  // Each role started its own agent; the lead got only the lead's tools, the gremlin only the report tool.
  assert.ok(launched.includes('lead-agent') && launched.includes('worker-agent'));
  const seen = fs.readFileSync(path.join(log, 'tools.txt'), 'utf8');
  assert.match(seen, /lead-room: list_tickets,list_desks,open_ticket,forward_to_ticket,stop_ticket,move_to_front,reply_to_boss,ask_boss/);
  assert.match(seen, /: submit_report\n/);
  // The lead's session was put in the agent's closed mode, the gremlin's in the open one.
  const modes = fs.readFileSync(path.join(log, 'modes.txt'), 'utf8');
  assert.match(modes, /lead-room mode=closed/);
  assert.match(modes, /mode=open/);
});

test('a gremlin\'s write outside its own folder is refused by the approval rule', async t => {
  const { b } = await bench(t, { FAKE_TOOLS_OUTSIDE: '1' });
  const asked = [];
  b.dispatcher.onActivity(a => { if (a.type === 'approval') asked.push(a); });
  b.say('加一个 hello.txt');
  await until(() => b.scheduler.tickets().length === 1 && b.scheduler.latestReport(b.scheduler.tickets()[0].id), 'a report', 40000);
  const id = b.scheduler.tickets()[0].id;
  // The write outside was asked about and refused; the write inside was allowed.
  assert.deepEqual(asked.map(a => [a.tool, /outside\.txt/.test(a.detail), a.allowed]), [['edit', true, false], ['edit', false, true]]);
  assert.equal(b.scheduler.latestReport(id).kind, 'done');
});

test('permission requests are described the way the approval rule reads them', () => {
  assert.deepEqual(describePermission({ kind: 'edit', title: 'Write a.txt', locations: [{ path: 'D:/w/a.txt' }] }), { tool: 'edit', detail: 'Write a.txt\nPath: D:/w/a.txt' });
  assert.deepEqual(describePermission({ kind: 'execute', title: 'Run', rawInput: { command: ['powershell.exe', '-Command', 'npm test'] } }), { tool: 'bash', detail: 'Run\nCommand: npm test' });
  assert.deepEqual(describePermission({ kind: 'other', title: 'x', rawInput: { command: 'bash -lc "git status"' } }), { tool: 'bash', detail: 'x\nCommand: git status' });
  assert.deepEqual(describePermission({ kind: 'edit', title: 'Edit', rawInput: { changes: { 'D:/w/b.txt': {} } } }), { tool: 'edit', detail: 'Edit\nPath: D:/w/b.txt' });
  // Antigravity's own field names (Orca acp-dialects/antigravity-dialect.ts), first real Antigravity ticket 2026-11-21.
  const agy = describePermission({ kind: 'execute', title: 'run_command', rawInput: { CommandLine: 'npm test', Cwd: 'D:/w' } });
  assert.deepEqual(agy, { tool: 'bash', detail: 'run_command\nCommand: npm test\nCwd: D:/w' });
  const { directoryPolicy } = load('src/main/v8/approval.ts');
  const allow = directoryPolicy({ workdir: () => 'D:/w' });
  assert.equal(allow({ ticketId: 1, tool: agy.tool, detail: agy.detail }), true, 'npm test in the ticket folder is allowed');
  const away = describePermission({ kind: 'execute', title: 'run_command', rawInput: { CommandLine: 'npm test', Cwd: 'D:/elsewhere' } });
  assert.equal(allow({ ticketId: 1, tool: away.tool, detail: away.detail }), false, 'run from another folder it is not');
});

test('a role whose agent cannot be started says so instead of hanging', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-acp-gone-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const b = new V8Workbench({ stateDir: dir, settings: { shell: 'acp', acp: { lead: { agent: 'gone' }, worker: { agent: 'gone' } } }, acpLaunch: async () => null });
  await assert.rejects(b.start(), /V8_ACP_AGENT_UNAVAILABLE: gone/);
  await b.shutdown().catch(() => undefined);
});

test('a permission request for one of the app\'s own tools is recognised however the agent names it', () => {
  const { ownTool } = load('src/main/v8/acpShell.ts');
  const ours = new Set(['open_ticket', 'submit_report']);
  assert.equal(ownTool({ title: 'Allow beastie to run open_ticket?', kind: 'other' }, ours), 'open_ticket');
  assert.equal(ownTool({ title: 'mcp__beastie__submit_report', kind: 'other' }, ours), 'submit_report');
  assert.equal(ownTool({ title: 'beastie.open_ticket', rawInput: { message_id: 3 } }, ours), 'open_ticket');
  assert.equal(ownTool({ title: 'reopen_tickets', kind: 'other' }, ours), null);
  // Naming our tool does not make a write or a command ours.
  assert.equal(ownTool({ title: 'open_ticket', kind: 'edit', locations: [{ path: 'C:/x' }] }, ours), null);
  assert.equal(ownTool({ title: 'submit_report', kind: 'execute', rawInput: { command: 'rm -rf x' } }, ours), null);
});

test('step 3: two gremlins work at once; a different agent reviews each once; accepting puts both into the project', async t => {
  const more = { review: true, slots: 2, acp: { lead: { agent: 'lead-agent' }, worker: { agent: 'worker-agent' }, reviewer: { agent: 'review-agent' } } };
  const { b, log, launched } = await bench(t, { FAKE_TOOLS_DELAY: '6000' }, more);
  b.say('加一个问候文件');
  b.say('再加一个问候文件');
  await until(() => b.scheduler.tickets().length === 2, 'two tickets');
  await until(() => b.scheduler.tickets().every(x => x.state === 'REVIEW'), 'both reviewed and waiting for the boss', 60000);
  // Both worked at the same time: each started before the other finished.
  const lines = fs.readFileSync(path.join(log, 'working.txt'), 'utf8').trim().split('\n').map(l => l.split(' '));
  const at = (what, who) => Number(lines.find(([w, d]) => w === what && d === who)[2]);
  assert.ok(at('start', 'ticket-1') < at('end', 'ticket-2') && at('start', 'ticket-2') < at('end', 'ticket-1'), 'the two tickets overlapped');
  // Each was reviewed exactly once, by the reviewer's own agent.
  assert.deepEqual(fs.readFileSync(path.join(log, 'reviews.txt'), 'utf8').trim().split('\n').sort(), ['ticket-1', 'ticket-2']);
  assert.ok(launched.includes('review-agent'));
  for (const x of b.scheduler.tickets()) assert.equal(b.delivery(x.id).reviewPassed, true);
  // The board says who reviews, and that it is not the gremlins' agent.
  assert.match(b.board().harness.label, /审查用 review-agent/);
  // Accepting puts each ticket's file into the project.
  for (const x of b.scheduler.tickets()) b.accept(x.id);
  assert.equal(fs.readFileSync(path.join(b.projectRoot, 'hello-ticket-1.txt'), 'utf8'), '你好\n');
  assert.equal(fs.readFileSync(path.join(b.projectRoot, 'hello-ticket-2.txt'), 'utf8'), '你好\n');
  assert.ok(b.scheduler.tickets().every(x => x.state === 'DONE'));
});

test('the board warns when the reviewer is the same agent as the gremlins (requirement 32: review by another maker)', async t => {
  const { b } = await bench(t, {}, { review: true, acp: { lead: { agent: 'codex-acp' }, worker: { agent: 'codex-acp' } } });
  assert.match(b.board().harness.label, /审查和干活是同一家/);
});

test('work that reached the boss unreviewed (reviewer signed out) can be reviewed again once it is back', async t => {
  const flag = path.join(os.tmpdir(), 'v8-signed-out-' + process.pid);
  t.after(() => fs.rmSync(flag, { force: true }));
  const more = { review: true, acp: { lead: { agent: 'lead-agent' }, worker: { agent: 'worker-agent' }, reviewer: { agent: 'review-agent' } } };
  const { b, log } = await bench(t, { FAKE_TOOLS_SIGNED_OUT_FLAG: flag }, more);
  b.say('加一个问候文件');
  await until(() => b.scheduler.tickets().length === 1, 'a ticket');
  const id = b.scheduler.tickets()[0].id;
  // Sign the reviewer out just before it starts.
  await until(() => b.scheduler.latestReport(id)?.kind === 'done', 'the report');
  fs.writeFileSync(flag, 'x');
  await until(() => /审查没给结论/.test(b.delivery(id)?.reviewNote ?? ''), 'review skipped', 40000);
  assert.equal(b.scheduler.tickets()[0].state, 'REVIEW');
  // Signed in again; the boss asks for the review.
  fs.rmSync(flag);
  b.reviewAgain(id);
  await until(() => b.delivery(id)?.reviewPassed === true, 'reviewed this time', 40000);
  assert.equal(b.delivery(id).reviewNote, null);
  assert.equal(fs.readFileSync(path.join(log, 'reviews.txt'), 'utf8').trim(), 'ticket-1');
  // Once reviewed there is nothing more to review.
  assert.throws(() => b.reviewAgain(id), /V8_NOTHING_TO_REVIEW/);
});

test('the lead and the reviewer start light (no skills, memory, plugins); the gremlins keep the full setup', async t => {
  const more = { review: true, acp: { lead: { agent: 'lead-agent' }, worker: { agent: 'worker-agent' }, reviewer: { agent: 'review-agent' } } };
  const { b, log } = await bench(t, {}, more);
  b.say('加一个问候文件');
  await until(() => b.scheduler.tickets()[0]?.state === 'REVIEW', 'reviewed and waiting', 40000);
  const lines = fs.readFileSync(path.join(log, 'light.txt'), 'utf8').trim().split('\n');
  // Sessions: the lead's room, the gremlin's ticket folder, then the reviewer in the same ticket folder.
  assert.match(lines[0], /^lead-room env=light meta=\{"light":true\}$/);
  assert.match(lines[1], /^ticket-1 env=- meta=null$/);
  assert.match(lines[2], /^ticket-1 env=light meta=\{"light":true\}$/);
});

test('Codex light settings: unused features off and every skill off by path', t => {
  const { codexLight, QUIRKS } = load('src/main/v8/acpQuirks.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-light-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const p of ['.codex/skills/a', '.codex/skills/.system/b', '.agents/skills/c', '.agents/skills/group/d']) {
    fs.mkdirSync(path.join(home, p), { recursive: true });
    fs.writeFileSync(path.join(home, p, 'SKILL.md'), 'x');
  }
  const c = JSON.parse(codexLight({ USERPROFILE: home, HOME: home }).env.CODEX_CONFIG);
  assert.equal(c['features.memories'], false);
  assert.equal(c['features.plugins'], false);
  assert.deepEqual(c['skills.config'].map(s => path.relative(home, s.path).split(path.sep).join('/')).sort(),
    ['.agents/skills/c/SKILL.md', '.agents/skills/group/d/SKILL.md', '.codex/skills/.system/b/SKILL.md', '.codex/skills/a/SKILL.md']);
  assert.ok(c['skills.config'].every(s => s.enabled === false));
  // Claude: no user settings (and so no skills, plugins or CLAUDE.md) for these two roles.
  assert.deepEqual(QUIRKS['claude-acp'].light({}), { sessionMeta: { claudeCode: { options: { settingSources: [] } } } });
});
