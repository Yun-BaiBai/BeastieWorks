'use strict';
// v8 B5: the review gremlin (spec section 7). Scheduler rules, the reviewer on scripted sessions, and the workbench
// with the demo cast. No model. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3'), load = require('../load-ts.cjs');
const { Scheduler } = load('src/main/v8/scheduler.ts');
const { Dispatcher } = load('src/main/v8/dispatcher.ts');
const { Reviewer } = load('src/main/v8/reviewer.ts');
const { FakeShell } = load('src/main/v8/fakeShell.ts');
const { V8Workbench } = load('src/main/v8/workbench.ts');

const done = (extra = '') => ({ kind: 'done', summary: '把减号改成了加号' + extra, changed: ['calc.py'], verification: { command: 'python test_calc.py', output: 'ok' } });
const checks = (ok = [true, true, true]) => [
  { label: '对上原话了吗', ok: ok[0], detail: 'x' }, { label: '有验证输出吗', ok: ok[1], detail: 'y' }, { label: '有没有多改', ok: ok[2], detail: 'z' }];
const pass = { verdict: 'pass', reason: '三条都对', checks: checks() };
const fail = why => ({ verdict: 'fail', reason: why, checks: checks([false, true, true]) });

async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 15)); }
  assert.fail('timed out waiting for ' + what);
}

function sched(t, review = true) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const s = new Scheduler(db, { review });
  const open = text => s.openTicket({ fromMessageId: s.bossSaid(text), routingNote: '' });
  /** Launch the ticket and hand in a report for it; returns the report's message id. */
  const report = (id, r = done()) => {
    const l = s.nextLaunches().find(x => x.ticketId === id);
    s.reportReceived(l.assignmentId, r);
    return s.messages(id).filter(m => m.kind === 'report').pop().id;
  };
  return { s, open, report };
}

test('a "done" waits for review; a pass reaches the boss and is recorded with its checks', t => {
  const { s, open, report } = sched(t);
  const id = open('修 calc');
  const m = report(id);
  assert.equal(s.state(id), 'WORKING', 'still the gremlins\' business');
  assert.deepEqual(s.pendingReviews().map(p => p.reportMessageId), [m]);
  assert.equal(s.recordReview(m, pass), 'passed');
  assert.equal(s.state(id), 'REVIEW');
  assert.deepEqual(s.pendingReviews(), []);
  const [r] = s.reviews({ ticketId: id });
  assert.equal(r.verdict, 'passed');
  assert.deepEqual(r.checks.map(c => c.label), ['对上原话了吗', '有验证输出吗', '有没有多改']);
  assert.equal(s.recordReview(m, pass), 'stale', 'a second verdict on the same report changes nothing');
});

test('a fail goes back to the same gremlin with the reason; the second fail hands it to the boss', t => {
  const { s, open, report } = sched(t);
  const id = open('修 calc');
  assert.equal(s.recordReview(report(id), fail('没跑测试')), 'rejected');
  assert.equal(s.state(id), 'QUEUED');
  const l = s.nextLaunches().find(x => x.ticketId === id);
  assert.deepEqual(s.assignmentContext(l.assignmentId).reviewNotes, ['没跑测试']);
  s.reportReceived(l.assignmentId, done('，又改了一次'));
  const second = s.messages(id).filter(m => m.kind === 'report').pop().id;
  assert.equal(s.recordReview(second, fail('还是没对上原话')), 'escalated');
  assert.equal(s.state(id), 'REVIEW', 'after two rejections the boss decides');
  assert.ok(s.messages(id).some(m => m.author === 'system' && /审查打回了 2 次/.test(String(m.body))));
  assert.equal(s.reviews({ ticketId: id }).length, 2);
});

test('verdicts are checked: a pass with a failed check, or a malformed verdict, is refused', t => {
  const { s, open, report } = sched(t);
  const m = report(open('修 calc'));
  assert.throws(() => s.recordReview(m, { verdict: 'pass', reason: '好', checks: checks([true, false, true]) }), /V8_REVIEW_CONTRADICTS_CHECKS/);
  for (const bad of [null, { verdict: 'maybe', reason: 'x', checks: checks() }, { verdict: 'pass', reason: '', checks: checks() }, { verdict: 'pass', reason: 'x', checks: [] }]) {
    assert.throws(() => s.recordReview(m, bad), /V8_REVIEW_INVALID/);
  }
  assert.equal(s.pendingReviews().length, 1, 'still waiting for a real verdict');
});

test('stale verdicts are ignored: the boss spoke or stopped the ticket meanwhile', t => {
  const { s, open, report } = sched(t);
  const a = open('第一件'), m1 = report(a);
  s.tellTicket(a, '再加一个按钮');
  assert.equal(s.recordReview(m1, pass), 'stale');
  const g = sched(t);
  const b = g.open('第二件'), m2 = g.report(b);
  g.s.stopTicket(b);
  assert.equal(g.s.recordReview(m2, pass), 'stale', 'a stopped ticket is not reviewed');
  assert.equal(g.s.state(b), 'STOPPED');
});

test('only "done" waits for review; questions and failures reach the boss directly; review can be off', t => {
  const { s, open, report } = sched(t);
  const q = open('问一下');
  report(q, { kind: 'question', question: '带日期吗？' });
  assert.equal(s.state(q), 'ANSWER');
  const off = sched(t, false);
  const id = off.open('修 calc');
  off.report(id);
  assert.equal(off.s.state(id), 'REVIEW');
  assert.deepEqual(off.s.pendingReviews(), []);
});

test('no verdict at all: the boss gets the work unreviewed, with a note saying so', t => {
  const { s, open, report } = sched(t);
  const id = open('修 calc');
  const m = report(id);
  assert.equal(s.skipReview(m, '审查会话崩了'), true);
  assert.equal(s.state(id), 'REVIEW');
  assert.ok(s.messages(id).some(m2 => /审查没给结论/.test(String(m2.body))));
  assert.equal(s.skipReview(m, 'again'), false);
});

// ---------- the reviewer on scripted sessions ----------

function reviewerRig(t, reviewerScript) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const s = new Scheduler(db, { review: true });
  const shell = new FakeShell(spec => spec.role === 'reviewer' ? reviewerScript() : ({
    async onPrompt(c) { await c.hostTool('submit_report', done()); c.settle(); },
  }));
  const d = new Dispatcher(s, shell, { workdir: id => 'D:/work/ticket-' + id });
  const activity = [];
  d.onActivity(a => activity.push(a));
  const r = new Reviewer(s, d, shell, { model: null, cwd: id => 'D:/work/ticket-' + id, diff: () => '+    return a + b\n-    return a - b' });
  r.start();
  t.after(async () => { await r.stop(); await d.shutdown(); });
  const open = async text => { const id = s.openTicket({ fromMessageId: s.bossSaid(text), routingNote: '' }); await d.pump(); return id; };
  return { s, d, shell, activity, open };
}

test('the reviewer sees exactly the boss words, the diff and the verification output, and its pass reaches the boss', async t => {
  const f = reviewerRig(t, () => ({ async onPrompt(c) {
    const allowed = [await c.approval('submit_review', 'Allow tool: submit_review'), await c.approval('bash', 'Allow tool: bash\nCommand: ls')];
    c.asked = allowed;
    await c.hostTool('submit_review', pass); c.settle();
  } }));
  const id = await f.open('calc.py 的 add 算错了');
  await until(() => f.s.state(id) === 'REVIEW', 'the review');
  const rs = f.shell.sessions.find(x => x.spec.role === 'reviewer');
  assert.equal(rs.spec.builtinTools, false, 'the reviewer has no hands');
  assert.deepEqual(rs.spec.hostTools.map(h => h.name), ['submit_review']);
  assert.deepEqual(rs.asked, [true, false], 'its own tool only');
  const brief = rs.heard[0].text;
  for (const part of ['calc.py 的 add 算错了', '+    return a + b', 'python test_calc.py', '把减号改成了加号']) assert.ok(brief.includes(part), part);
  assert.ok(rs.closed);
  assert.ok(f.activity.some(a => a.type === 'reviewed' && a.outcome === 'passed'));
});

test('a reviewer that contradicts itself is told so and corrects its verdict; one that stays silent is skipped', async t => {
  const f = reviewerRig(t, () => ({ async onPrompt(c, text) {
    if (/还没有调用 submit_review/.test(text)) { c.settle(); return; }
    if (/沉默/.test(text)) { c.settle(); return; }
    const first = await c.hostTool('submit_review', { verdict: 'pass', reason: '好', checks: checks([true, false, true]) });
    c.firstError = first.ok ? null : first.error;
    await c.hostTool('submit_review', fail('验证输出不对'));
    c.settle();
  } }));
  const id = await f.open('修 calc');
  await until(() => f.activity.some(a => a.type === 'reviewed'), 'the corrected verdict');
  assert.match(f.shell.sessions.find(x => x.spec.role === 'reviewer').firstError, /pass 时三条都必须 ok/);
  assert.equal(f.activity.find(a => a.type === 'reviewed').outcome, 'rejected');
  await until(() => f.s.messages(id).filter(m => m.kind === 'report').length === 2, 'the gremlin redoing it');

  const g = reviewerRig(t, () => ({ async onPrompt(c) { c.settle(); } }));
  const quiet = await g.open('沉默的审查');
  await until(() => g.s.state(quiet) === 'REVIEW', 'the skipped review');
  assert.ok(g.activity.some(a => a.type === 'reviewed' && a.outcome === 'skipped'));
});

// ---------- the workbench with the demo cast ----------

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-rev-'));
  const closers = [];
  t.after(async () => { for (const c of closers) await c(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, closers };
}

test('workbench: the boss hears about done work only after review passed; the board and the pages show the verdicts', async t => {
  const h = home(t);
  const b = new V8Workbench({ stateDir: h.dir, settings: {}, demoPace: 0.02 });
  h.closers.push(() => b.shutdown());
  await b.start();
  b.say('首页的标题改一下');
  await until(() => b.scheduler.tickets()[0]?.state === 'REVIEW', 'the reviewed ticket');
  const id = b.scheduler.tickets()[0].id;
  await until(() => b.board().talk.some(l => l.author === 'lead' && /审查通过/.test(l.text)), 'the lead passing the review on');
  // Before review spoke, the lead said nothing about the work being done.
  const leadLines = b.scheduler.messages(null).filter(m => m.author === 'lead').map(m => String(m.body));
  assert.ok(!leadLines.some(l => /交了报告|做完了。/.test(l)), leadLines.join(' | '));
  const board = b.board();
  assert.equal(board.review.enabled, true);
  assert.equal(board.review.passedToday, 1);
  assert.equal(board.review.lastPassed, b.scheduler.ticket(id).title);
  assert.equal(b.delivery(id).reviewPassed, true);
  const detail = b.reviewDetail();
  assert.equal(detail.history.length, 1);
  assert.equal(detail.latest.checks.length, 3);
  assert.ok(board.feed.some(f => f.who === '审查'));
});

test('workbench: rejected twice, the work comes to the boss marked as such; the gremlin heard the reasons', async t => {
  const h = home(t);
  const b = new V8Workbench({ stateDir: h.dir, settings: {}, demoPace: 0.02 });
  h.closers.push(() => b.shutdown());
  await b.start();
  b.say('这个审查不过');
  await until(() => b.scheduler.tickets()[0]?.state === 'REVIEW', 'the escalated ticket', 20000);
  const id = b.scheduler.tickets()[0].id;
  const d = b.delivery(id);
  assert.equal(d.reviewPassed, false);
  assert.match(d.reviewNote, /审查打回了两次/);
  assert.equal(b.scheduler.reviews({ ticketId: id }).length, 2);
  assert.equal(b.scheduler.messages(id).filter(m => m.kind === 'report').length, 2, 'two rounds of work');
});

test('workbench with review off: done work goes straight to the boss', async t => {
  const h = home(t);
  const b = new V8Workbench({ stateDir: h.dir, settings: { review: false }, demoPace: 0.02 });
  h.closers.push(() => b.shutdown());
  await b.start();
  b.say('首页的标题改一下');
  await until(() => b.scheduler.tickets()[0]?.state === 'REVIEW', 'the ticket');
  assert.equal(b.board().review.enabled, false);
  assert.equal(b.scheduler.reviews().length, 0);
});
