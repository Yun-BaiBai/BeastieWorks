'use strict';
// v8 S2: the ticket-level line of defence. Quota refusals that Magpie could not absorb put a ticket in 等额度 instead
// of failing it; it goes on when the quota is back, or when the boss switches account or model. The three-state probe
// warns on silence and stops a gremlin past the hard limit. Closing a harness takes its whole process tree with it.
// No model, no account: fake shells and the fake omp. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3'), load = require('../load-ts.cjs');
const { Scheduler } = load('src/main/v8/scheduler.ts');
const { Dispatcher } = load('src/main/v8/dispatcher.ts');
const { FakeShell } = load('src/main/v8/fakeShell.ts');
const { OmpShell } = load('src/main/v8/ompShell.ts');
const { V8Workbench } = load('src/main/v8/workbench.ts');
const { quotaRefusal, probeLive } = load('src/main/v8/hotswap.ts');
const { isAlive } = load('src/main/procKill.ts');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-omp-rpc.cjs');
const done = { kind: 'done', summary: '改好了', changed: ['a.txt'], verification: { command: 'node -e 0', output: 'ok' } };
const LATER = 2_000_000_000;          // unix seconds, far ahead

async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); }
  assert.fail('timed out waiting for ' + what);
}

function scope(t) {
  const undo = [];
  t.after(async () => { for (const fn of undo.reverse()) { try { await fn(); } catch { /* keep cleaning */ } } });
  return {
    defer: fn => undo.push(fn),
    tmp: name => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), name)); undo.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })); return dir; },
  };
}

/** A gremlin that is refused for quota on its first turn and reports done on the next. Records every spec it got. */
function quotaOnce(specs) {
  let turns = 0;
  return spec => ({
    async onPrompt(c) {
      specs.push(spec);
      if (++turns === 1) { c.settle('error', `HTTP 429 resets=${LATER}: You exceeded your current quota`); return; }
      await c.hostTool('submit_report', done);
      c.settle('completed');
    },
  });
}

test('quota refusals are told apart from other errors, with the reset time when one was given', () => {
  const now = 1_000_000;
  assert.deepEqual(quotaRefusal(`HTTP 429 resets=${LATER}: quota`, now), { resetsAt: LATER * 1000 });
  assert.deepEqual(quotaRefusal('Rate limit reached for gpt. Please try again in 20s.', now), { resetsAt: now + 20_000 });
  assert.deepEqual(quotaRefusal('usage limit reached, try again in 2 hours', now), { resetsAt: now + 7_200_000 });
  assert.deepEqual(quotaRefusal('insufficient_quota', now), { resetsAt: null });
  assert.equal(quotaRefusal('ENOENT: no such file', now), null);
  assert.equal(quotaRefusal(undefined, now), null);
});

test('the three-state probe: quiet only warns; past the hard limit it is stalled', () => {
  const L = { silentMs: 100, hardMs: 1000 };
  assert.equal(probeLive(50, 0, 40, L).status, 'ACTIVE');
  assert.equal(probeLive(200, 0, 50, L).status, 'SUSPECT_SILENT');
  assert.equal(probeLive(200, 0, 150, L).status, 'ACTIVE', 'any event resets the silence');
  assert.equal(probeLive(1000, 0, 999, L).status, 'CONFIRMED_STALLED');
});

test('scheduler: out of quota is 等额度, not failed; it goes on in the same session; any new assignment ends the wait', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  let clock = 1000;
  const s = new Scheduler(db, { clock: () => ++clock });
  const open = text => s.openTicket({ fromMessageId: s.bossSaid(text), routingNote: '去工位' });
  const a = open('一'), b = open('二');
  const l1 = s.nextLaunches()[0];
  s.assignmentStarted(l1.assignmentId, 'session-a');
  assert.equal(s.assignmentOutOfQuota(l1.assignmentId, { resetsAt: LATER * 1000, detail: 'HTTP 429' }), 'WAITING_QUOTA');
  assert.equal(s.ticket(a).quotaWait.resetsAt, LATER * 1000);
  assert.deepEqual(s.quotaWaits().map(w => w.ticketId), [a]);
  assert.equal(s.latestReport(a), null, 'no failure report was written');
  assert.deepEqual(s.nextLaunches().map(l => l.ticketId), [b], 'the freed slot goes to the next ticket');
  s.resumeFromQuota(a, 'reset');
  assert.equal(s.state(a), 'QUEUED');
  assert.deepEqual(s.quotaWaits(), []);
  assert.throws(() => s.resumeFromQuota(a, 'reset'), /V8_NOT_WAITING_QUOTA/);
});

test('scheduler: the boss speaking to a ticket that waits for quota ends the wait', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const s = new Scheduler(db);
  const id = s.openTicket({ fromMessageId: s.bossSaid('一'), routingNote: '去工位' });
  const l = s.nextLaunches()[0];
  s.assignmentStarted(l.assignmentId, 'session');
  s.assignmentOutOfQuota(l.assignmentId, { resetsAt: null, detail: 'quota' });
  assert.equal(s.state(id), 'WAITING_QUOTA');
  assert.equal(s.ticket(id).quotaWait.resetsAt, null);
  s.tellTicket(id, '换个思路接着干');
  assert.equal(s.state(id), 'QUEUED');
  assert.deepEqual(s.quotaWaits(), []);
});

test('scheduler: per-ticket model and account pins; a fresh retry forgets the old session', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const s = new Scheduler(db);
  const id = s.openTicket({ fromMessageId: s.bossSaid('一'), routingNote: '去工位' });
  assert.deepEqual(s.ticketSupply(id), { model: null, account: null, effort: null });
  s.setTicketSupply(id, { account: 'acct-2' });
  s.setTicketSupply(id, { model: 'deepseek/deepseek-chat' });
  assert.deepEqual(s.ticketSupply(id), { model: 'deepseek/deepseek-chat', account: 'acct-2', effort: null });
  s.setTicketSupply(id, { account: null });
  assert.deepEqual(s.ticketSupply(id), { model: 'deepseek/deepseek-chat', account: null, effort: null });
  assert.throws(() => s.setTicketSupply(id, { model: 'has space' }), /V8_SUPPLY_OVERRIDE_INVALID/);
  const l = s.nextLaunches()[0];
  s.assignmentStarted(l.assignmentId, 'old-session');
  s.reportReceived(l.assignmentId, { kind: 'failed', reason: 'harness crashed' });
  s.retryTicket(id, { fresh: true });
  assert.equal(s.nextLaunches()[0].sessionRef, null, 'a new session, picking up from the directory');
});

test('dispatcher: a quota refusal frees the slot, the board learns of it, and a pinned account reaches the session', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const s = new Scheduler(db);
  const specs = [];
  const shell = new FakeShell(quotaOnce(specs));
  const d = new Dispatcher(s, shell, { workdir: () => os.tmpdir() });
  const seen = [];
  d.onActivity(a => seen.push(a));
  const id = s.openTicket({ fromMessageId: s.bossSaid('一'), routingNote: '去工位' });
  s.setTicketSupply(id, { account: 'acct-2', model: 'gpt-x' });
  await d.start();
  await until(() => s.state(id) === 'WAITING_QUOTA', 'the ticket to wait for quota');
  const q = seen.find(a => a.type === 'quota');
  assert.equal(q.resetsAt, LATER * 1000);
  assert.equal(specs[0].supplyAccount, 'acct-2');
  assert.equal(specs[0].model, 'gpt-x');
  s.resumeFromQuota(id, 'account');
  await d.pump();
  await until(() => s.state(id) === 'REVIEW', 'the second turn to report');
  assert.equal(specs.length, 2);
  await d.shutdown();
});

test('dispatcher: silence warns, the hard limit stops the gremlin and hands the ticket to the boss', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const s = new Scheduler(db);
  const shell = new FakeShell(() => ({ onPrompt() { /* never answers */ } }));
  const d = new Dispatcher(s, shell, { workdir: () => os.tmpdir(), probe: { silentMs: 60, hardMs: 400, intervalMs: 20 } });
  const seen = [];
  d.onActivity(a => seen.push(a));
  const id = s.openTicket({ fromMessageId: s.bossSaid('一'), routingNote: '去工位' });
  await d.start();
  await until(() => seen.some(a => a.type === 'probe' && a.status === 'SUSPECT_SILENT'), 'the yellow warning', 5000);
  assert.equal(s.state(id), 'WORKING', 'yellow never stops anything');
  await until(() => s.state(id) === 'FAILED', 'the hard limit', 5000);
  assert.ok(seen.some(a => a.type === 'probe' && a.status === 'CONFIRMED_STALLED'));
  assert.match(s.latestReport(id).reason, /还没交报告/);
  await d.shutdown();
});

test('workbench: a ticket waiting for quota goes on by itself once the reset time has passed', async t => {
  const sc = scope(t), dir = sc.tmp('v8-hotswap-bench-');
  let now = Date.now();
  const specs = [], worker = quotaOnce(specs);
  const b = new V8Workbench({ stateDir: dir, settings: { review: false, slots: 1, emergencySlot: false }, shell: new FakeShell(spec => spec.role === 'lead' ? ({ async onPrompt(c, text) {
    const m = /消息 #(\d+)/.exec(text); if (m) await c.hostTool('open_ticket', { message_id: Number(m[1]), routing_note: '' }); c.settle('completed');
  } }) : worker(spec)), clock: () => now, quotaPollMs: 60_000 });
  sc.defer(() => b.shutdown());
  await b.start();
  b.say('一号活');
  await until(() => b.board().resting.length === 1, 'the ticket to rest');
  const ticket = b.board().resting[0];
  assert.equal(ticket.quotaWait.resetsAt, LATER * 1000);
  assert.ok(b.board().feed.some(f => /等额度/.test(f.text)), 'the feed says why');
  assert.equal(await b.checkQuota(), 0, 'not yet');
  now = LATER * 1000 + 1;
  assert.equal(await b.checkQuota(), 1);
  await until(() => b.scheduler.state(ticket.id) === 'REVIEW', 'the ticket to go on and finish');
  assert.equal(specs.length, 2);
});

test('closing an omp session also ends what omp started', async t => {
  const sc = scope(t), home = sc.tmp('v8-hotswap-tree-');
  const log = path.join(home, 'omp.log');
  const shell = new OmpShell({ exe: process.execPath, prefixArgs: [FAKE], agentDir: path.join(home, 'agent'), sessionDir: path.join(home, 's'), env: { FAKE_OMP_LOG: log, ELECTRON_RUN_AS_NODE: '1' } });
  const session = await shell.open({ role: 'worker', cwd: home, model: null, sessionRef: null, systemPrompt: 'x', hostTools: [], builtinTools: true });
  session.prompt('孙进程');
  let gc = 0;
  await until(() => { try { gc = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(r => r.grandchild)?.grandchild ?? 0; } catch { gc = 0; } return gc > 0; }, 'the grandchild to start');
  sc.defer(() => { try { process.kill(gc); } catch { /* gone */ } });
  assert.equal(isAlive(gc), true);
  await session.close();
  await until(() => !isAlive(gc), 'the grandchild to be gone', 10000);
});
