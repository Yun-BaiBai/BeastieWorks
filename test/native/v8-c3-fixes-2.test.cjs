'use strict';
// More fixes for the C3 whole-program review (work/c3-review/report.md): accepting only what waits for the boss,
// a pass only for the report it reviewed, the spend kept across restarts, a new session told the whole task, and a
// session that opens after its ticket was stopped closed at once. Demo gremlins and stub sessions; no model.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3'), load = require('../load-ts.cjs');
const { V8Workbench } = load('src/main/v8/workbench.ts');
const { Scheduler } = load('src/main/v8/scheduler.ts');
const { Dispatcher } = load('src/main/v8/dispatcher.ts');

async function until(check, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
  assert.fail('timed out waiting for ' + what);
}
/** A folder for one test; removed after the test's workbenches are shut down (closers run first). */
function dir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-c3b-'));
  const closers = [];
  t.after(async () => { for (const c of closers) await c().catch(() => undefined); fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  later.set(d, closers);
  return d;
}
const later = new Map();

test('finding 4: accepting work that is not waiting for the boss writes nothing into the project', async t => {
  const stateDir = dir(t);
  const b = new V8Workbench({ stateDir, settings: {}, demoPace: 1 });   // slow demo: the ticket is still at work
  later.get(stateDir).push(() => b.shutdown());
  await b.start();
  b.say('首页的标题改一下');
  await until(() => b.scheduler.tickets()[0]?.state === 'WORKING', 'work under way');
  const id = b.scheduler.tickets()[0].id;
  assert.throws(() => b.accept(id), /V8_NOT_AWAITING_REVIEW/);
  assert.equal(b.scheduler.state(id), 'WORKING');
});

test('finding 12: what a ticket spent and how far it may go are still known after a restart', async t => {
  const stateDir = dir(t);
  const settings = { maxCostUsd: 0.5 };
  const a = new V8Workbench({ stateDir, settings, demoPace: 1 });
  await a.start();
  a.say('首页的标题改一下');
  await until(() => a.scheduler.tickets().length === 1, 'a ticket');
  const id = a.scheduler.tickets()[0].id;
  a['track']({ type: 'cost', ticketId: id, usd: 0.3, basis: 'reported' });
  a['allowance'].set(id, 0.8); a['keepSpend'](id);
  await a.shutdown();
  const b = new V8Workbench({ stateDir, settings, demoPace: 1 });
  later.get(stateDir).push(() => b.shutdown());
  assert.equal(b['live'](id).cost, 0.3, 'the spend so far is read back');
  assert.equal(b['allowance'].get(id), 0.8, 'and how far the boss let it go');
});

test('finding 10: a pass counts only for the report it reviewed; redone work is not shown as passed', async t => {
  const stateDir = dir(t);
  const b = new V8Workbench({ stateDir, settings: { review: true }, demoPace: 0.02 });
  later.get(stateDir).push(() => b.shutdown());
  await b.start();
  b.say('首页的标题改一下');
  await until(() => b.scheduler.reviews({}).some(r => r.verdict === 'passed'), 'a passed review');
  const id = b.scheduler.tickets()[0].id;
  assert.equal(b['reviewOf'](id).reviewPassed, true);
  // The same ticket hands in another report (redone after the boss spoke): that one has not been reviewed.
  const s = b.scheduler, db = b['db'];
  const a = db.prepare('SELECT id FROM v8_assignments WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(id).id;
  db.prepare("INSERT INTO v8_messages(ticket_id,assignment_id,author,kind,body,created_at) VALUES(?,?,'worker','report',?,?)")
    .run(id, a, JSON.stringify({ kind: 'done', summary: '又改了', changed: [], verification: { command: 'x', output: 'y' } }), Date.now());
  assert.equal(b['reviewOf'](id).reviewPassed, false, 'the newer report was not reviewed');
  assert.ok(s.reviews({ ticketId: id })[0].verdict === 'passed', 'the old pass is still on record');
});

/** A stub session: remembers what it was told and whether it was closed. */
function stubShell(o = {}) {
  const opened = [];
  return {
    opened,
    async open(spec) {
      if (o.wait) await o.wait;
      const s = { ref: o.ref ? o.ref(spec) : 'r-' + opened.length, spec, prompts: [], closed: false,
        onEvent: () => () => undefined, prompt(t) { s.prompts.push(t); }, steer() {}, abort() {}, async close() { s.closed = true; }, respondApproval() {}, respondHostTool() {} };
      opened.push(s);
      return s;
    },
  };
}

test('finding 8: an agent that cannot carry on an old session gets the whole task again in the new one', async t => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  const s = new Scheduler(db);
  // The first session is "old-1"; asked to load it, the agent opens a new one instead ("new-2").
  const shell = stubShell({ ref: spec => spec.sessionRef ? 'new-2' : 'old-1' });
  const d = new Dispatcher(s, shell, { workdir: () => 'D:/work/t' });
  t.after(async () => { await d.shutdown(); db.close(); });
  await d.start();
  const id = s.openTicket({ fromMessageId: s.bossSaid('把登录页的报错改清楚'), routingNote: '' });
  await d.pump();
  await until(() => shell.opened.length === 1, 'the first session');
  // The gremlin stops (the app restarted, say) and the ticket goes on in "the same" session.
  const asg = db.prepare('SELECT id FROM v8_assignments WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(id).id;
  await d.shutdown();
  const d2 = new Dispatcher(s, shell, { workdir: () => 'D:/work/t' });
  t.after(() => d2.shutdown());
  s.assignmentExited(asg, 'gone');
  s.retryTicket(id, { fresh: false });
  await d2.start(); await d2.pump();
  await until(() => shell.opened.length === 2, 'the second session');
  const second = shell.opened[1];
  assert.equal(second.spec.sessionRef, 'old-1', 'it asked to carry on the old session');
  assert.match(second.prompts[0], /把登录页的报错改清楚/, 'the new session is told the whole task, the boss\'s words included');
});

test('finding 6: a session that finishes opening after its ticket was stopped is closed, and the gremlin never starts', async t => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  const s = new Scheduler(db);
  let go; const wait = new Promise(r => { go = r; });
  const shell = stubShell({ wait });
  const d = new Dispatcher(s, shell, { workdir: () => 'D:/work/t' });
  t.after(async () => { await d.shutdown(); db.close(); });
  await d.start();
  const id = s.openTicket({ fromMessageId: s.bossSaid('改一下'), routingNote: '' });
  const pumping = d.pump();
  await until(() => d.isOpening(id), 'opening');
  const stopping = d.stop(id);   // waits for the session still opening
  go();
  await stopping; await pumping;
  await until(() => shell.opened.length === 1, 'it opened');
  assert.equal(shell.opened[0].closed, true, 'closed at once');
  assert.deepEqual(shell.opened[0].prompts, [], 'and never told to start');
  assert.deepEqual(d.running(), []);
});
