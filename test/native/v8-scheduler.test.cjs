'use strict';
// v8 B1: ticket states, reports and the scheduler (spec work/claude-v8-direction-20261113/v8-规范.md, sections 1–5).
// No shell and no model: the shell layer is played by hand. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const Database = require('better-sqlite3'), load = require('../load-ts.cjs');
const { Scheduler } = load('src/main/v8/scheduler.ts');
const { ticketState } = load('src/main/v8/ticketState.ts');
const { validateReport, routingNoteWords } = load('src/main/v8/reports.ts');

const done = { kind: 'done', summary: '把减号改成了加号', changed: ['calc.py'], verification: { command: 'python test_calc.py', output: 'ok' } };
const question = { kind: 'question', question: '文件名要带日期吗？', options: [{ id: 'yes', label: '带' }, { id: 'no', label: '不带' }], recommended: 'yes' };

function fixture(t) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  let clock = 1_000;
  const s = new Scheduler(db, { clock: () => ++clock });
  t.after(() => db.close());
  /** The boss says something and the lead opens a ticket from it. */
  const open = (text, note = '去工位') => s.openTicket({ fromMessageId: s.bossSaid(text), routingNote: note });
  const state = id => s.state(id);
  /** Launch whatever fits and return the launch for one ticket. */
  const launch = id => s.nextLaunches().find(l => l.ticketId === id);
  return { db, s, open, state, launch };
}

test('ticketState: every state, in the spec order', () => {
  const A = (status, id = 1) => ({ id, status });
  const R = (kind, review = 'not_required') => ({ kind, review });
  const cases = [
    [{ ended: 'done', latestAssignment: A('RUNNING'), latestReport: null }, 'DONE'],
    [{ ended: 'stopped', latestAssignment: A('ENDED'), latestReport: R('question') }, 'STOPPED'],
    [{ ended: null, latestAssignment: null, latestReport: null }, 'QUEUED'],
    [{ ended: null, latestAssignment: A('PENDING'), latestReport: null }, 'QUEUED'],
    [{ ended: null, latestAssignment: A('RUNNING'), latestReport: null }, 'WORKING'],
    [{ ended: null, latestAssignment: A('ENDED'), latestReport: R('question') }, 'ANSWER'],
    [{ ended: null, latestAssignment: A('ENDED'), latestReport: R('done') }, 'REVIEW'],
    [{ ended: null, latestAssignment: A('ENDED'), latestReport: R('done', 'passed') }, 'REVIEW'],
    [{ ended: null, latestAssignment: A('ENDED'), latestReport: R('done', 'pending') }, 'WORKING'],
    [{ ended: null, latestAssignment: A('ENDED'), latestReport: R('nothing') }, 'REVIEW'],
    [{ ended: null, latestAssignment: A('ENDED'), latestReport: R('blocked') }, 'BLOCKED'],
    [{ ended: null, latestAssignment: A('ENDED'), latestReport: R('failed') }, 'FAILED'],
    [{ ended: null, latestAssignment: A('INTERRUPTED'), latestReport: null }, 'IDLE'],
  ];
  for (const [facts, want] of cases) assert.equal(ticketState(facts), want, JSON.stringify(facts));
});

test('reports: "done" needs verification output; unknown fields are dropped; bad shapes are refused', () => {
  assert.throws(() => validateReport({ ...done, verification: { command: 'python t.py', output: '' } }), /V8_DONE_NEEDS_VERIFICATION/);
  assert.throws(() => validateReport({ ...done, verification: undefined }), /V8_DONE_NEEDS_VERIFICATION/);
  assert.deepEqual(validateReport({ ...done, extra: 'x' }), done);
  assert.throws(() => validateReport({ ...question, recommended: 'maybe' }), /V8_REPORT_INVALID/);
  assert.throws(() => validateReport({ ...question, options: [{ id: 'a', label: '1' }, { id: 'a', label: '2' }] }), /V8_REPORT_INVALID/);
  assert.deepEqual(validateReport({ kind: 'question', question: '为什么？' }), { kind: 'question', question: '为什么？', options: [] });
  for (const bad of [null, [], { kind: 'great' }, { kind: 'blocked', where: '测试' }, { kind: 'failed', reason: '  ' }]) assert.throws(() => validateReport(bad), /V8_REPORT_INVALID/);
});

test('routing notes: at most 30 words, a CJK character counting half', () => {
  assert.equal(routingNoteWords('fix the export button'), 4);
  assert.equal(routingNoteWords('导出按钮'), 2);
  assert.equal(routingNoteWords('看 src/export.ts 第 42 行'), 4);
});

test('openTicket: copies the boss words, only from a boss message, one ticket per message, short notes only', t => {
  const { s, open } = fixture(t);
  const said = s.bossSaid('导出按钮点了没反应，修一下');
  const id = s.openTicket({ fromMessageId: said, routingNote: '前端，导出', title: '导出按钮' });
  const v = s.tickets().find(x => x.id === id);
  assert.equal(v.originalRequest, '导出按钮点了没反应，修一下');
  assert.equal(v.title, '导出按钮');
  assert.equal(v.state, 'QUEUED');
  assert.equal(v.queuePosition, 1);
  assert.throws(() => s.openTicket({ fromMessageId: said, routingNote: '' }), /V8_MESSAGE_ALREADY_TICKETED/);
  assert.throws(() => s.openTicket({ fromMessageId: s.leadSaid('我自己编一个任务'), routingNote: '' }), /V8_NEEDS_BOSS_MESSAGE/);
  assert.throws(() => s.openTicket({ fromMessageId: s.bossSaid('再修一个'), routingNote: 'word '.repeat(31) }), /V8_ROUTING_NOTE_TOO_LONG/);
  assert.equal(s.tickets().length, 1);
  // Without a title the boss words become the title, trimmed and cut at 40 characters.
  const other = open('  注册之后收到两封一样的欢迎邮件，帮我查一下到底是哪里重复发送了  ');
  assert.equal(s.tickets().find(x => x.id === other).title, '注册之后收到两封一样的欢迎邮件，帮我查一下到底是哪里重复发送了');
  const long = open('改'.repeat(60));
  assert.equal(s.tickets().find(x => x.id === long).title.length, 40);
});

test('the main line: queued → working → done → 等你看 → accepted, and the slot frees up', t => {
  const { s, open, state, launch } = fixture(t);
  const id = open('导出按钮点了没反应');
  const l = launch(id);
  assert.deepEqual({ ...l, assignmentId: undefined }, { assignmentId: undefined, ticketId: id, slotId: 'slot-1', sessionRef: null, recovery: false });
  assert.equal(state(id), 'WORKING');
  assert.equal(s.tickets()[0].slotId, 'slot-1');
  s.assignmentStarted(l.assignmentId, 'session-a');
  assert.equal(s.reportReceived(l.assignmentId, done), 'REVIEW');
  assert.equal(s.tickets()[0].slotId, null);
  assert.throws(() => s.reportReceived(l.assignmentId, done), /V8_ASSIGNMENT_NOT_RUNNING/);
  s.confirmTicket(id);
  assert.equal(state(id), 'DONE');
  assert.throws(() => s.confirmTicket(id), /V8_NOT_AWAITING_REVIEW/);
  const report = s.messages(id).find(m => m.kind === 'report');
  assert.deepEqual(report.body, done);
  assert.equal(report.author, 'worker');
});

test('a question waits for the boss; his answer goes back to the same session ahead of the line', t => {
  const { s, open, state, launch } = fixture(t);
  const a = open('导出按钮点了没反应'), b = open('注册邮件发两遍');
  const la = launch(a);
  s.assignmentStarted(la.assignmentId, 'session-a');
  assert.equal(s.reportReceived(la.assignmentId, question), 'ANSWER');
  // The slot is free again, so the next ticket in line takes it.
  const lb = launch(b);
  assert.ok(lb);
  assert.deepEqual(s.tellTicket(a, '带日期'), { kind: 'queued', assignmentId: la.assignmentId + 2 });
  assert.equal(state(a), 'QUEUED');
  s.reportReceived(lb.assignmentId, done);
  const again = launch(a);
  assert.equal(again.sessionRef, 'session-a');
  assert.equal(state(a), 'WORKING');
});

test('a boss message to a running gremlin steers it; one to a queued ticket rides along and jumps the line', t => {
  const { s, open, state, launch } = fixture(t);
  const a = open('第一件'), b = open('第二件'), c = open('第三件');
  const la = launch(a);
  assert.deepEqual(s.tellTicket(a, '别动工具栏的样式'), { kind: 'steer', assignmentId: la.assignmentId });
  assert.equal(state(a), 'WORKING');
  assert.equal(s.tickets().find(x => x.id === b).queuePosition, 1);
  assert.equal(s.tellTicket(c, '这个先做').kind, 'queued');
  assert.equal(s.tickets().find(x => x.id === c).queuePosition, 1);
  assert.equal(s.tickets().find(x => x.id === b).queuePosition, 2);
  s.reportReceived(la.assignmentId, done);
  assert.equal(launch(c).ticketId, c);
});

test('blocked and failed: retry or a boss reply starts a new assignment; retry only from those states', t => {
  const { s, open, state, launch } = fixture(t);
  const id = open('首页加载太慢');
  assert.throws(() => s.retryTicket(id), /V8_NOT_RETRYABLE/);
  let l = launch(id);
  assert.equal(s.reportReceived(l.assignmentId, { kind: 'blocked', where: '装不了依赖', tried: '换了源也不行' }), 'BLOCKED');
  s.retryTicket(id);
  assert.equal(state(id), 'QUEUED');
  l = launch(id);
  assert.equal(s.reportReceived(l.assignmentId, { kind: 'failed', reason: '仓库里没有首页' }), 'FAILED');
  s.tellTicket(id, '首页在 site/ 目录下');
  assert.equal(state(id), 'QUEUED');
});

test('a session that ends without a report shows up as a failure, once', t => {
  const { s, open, launch } = fixture(t);
  const id = open('导出按钮');
  const l = launch(id);
  assert.equal(s.assignmentExited(l.assignmentId, 'exit code 3'), 'FAILED');
  assert.equal(s.assignmentExited(l.assignmentId, 'again'), null);
  const r = s.messages(id).filter(m => m.kind === 'report');
  assert.equal(r.length, 1);
  assert.equal(r[0].author, 'system');
  assert.match(r[0].body.reason, /exit code 3/);
});

test('stop: running work is aborted, queued work dropped, the ticket stays stopped', t => {
  const { s, open, state, launch } = fixture(t);
  const a = open('第一件'), b = open('第二件');
  const la = launch(a);
  assert.deepEqual(s.stopTicket(a), { abort: [la.assignmentId] });
  assert.equal(state(a), 'STOPPED');
  assert.deepEqual(s.stopTicket(b), { abort: [] });
  assert.equal(state(b), 'STOPPED');
  assert.deepEqual(s.nextLaunches(), []);
  assert.throws(() => s.tellTicket(a, '继续'), /V8_TICKET_STOPPED/);
  assert.throws(() => s.stopTicket(a), /V8_TICKET_ENDED/);
  assert.throws(() => s.reportReceived(la.assignmentId, done), /V8_ASSIGNMENT_NOT_RUNNING/);
});

test('a finished ticket is reopened by a new boss message and keeps its session', t => {
  const { s, open, state, launch } = fixture(t);
  const id = open('侧边栏错位');
  const l = launch(id);
  s.assignmentStarted(l.assignmentId, 'session-x');
  s.reportReceived(l.assignmentId, done);
  s.confirmTicket(id);
  s.tellTicket(id, '平板上也错位了');
  assert.equal(state(id), 'QUEUED');
  assert.equal(s.tickets()[0].endedAt, null);
  assert.equal(launch(id).sessionRef, 'session-x');
  assert.ok(s.messages(id).some(m => m.author === 'system' && /重新打开/.test(m.body)));
});

test('restart: running assignments become interrupted and are queued again as recovery, oldest ticket first', t => {
  const { s, open, state } = fixture(t);
  s.setSlots([{ id: 'slot-1', label: '工位 01', model: null, emergency: false }, { id: 'slot-2', label: '工位 02', model: null, emergency: false }]);
  const a = open('第一件'), b = open('第二件'), c = open('第三件');
  const first = s.nextLaunches();
  assert.deepEqual(first.map(l => l.ticketId), [a, b]);
  const fresh = s.recoverAfterRestart();
  assert.equal(fresh.length, 2);
  assert.equal(state(a), 'QUEUED');
  assert.deepEqual(s.recoverAfterRestart(), []);
  const again = s.nextLaunches();
  assert.deepEqual(again.map(l => [l.ticketId, l.recovery]), [[a, true], [b, true]]);
  assert.equal(state(c), 'QUEUED');
  assert.ok(s.messages(a).some(m => /重启/.test(m.body)));
});

test('the emergency slot only takes work the boss just spoke to', t => {
  const { s, open, launch } = fixture(t);
  s.setSlots([{ id: 'slot-1', label: '工位 01', model: null, emergency: false }, { id: 'urgent', label: '应急', model: null, emergency: true }]);
  const a = open('第一件'), b = open('第二件');
  assert.deepEqual(s.nextLaunches().map(l => [l.ticketId, l.slotId]), [[a, 'slot-1']]);
  assert.deepEqual(s.nextLaunches(), []);
  s.tellTicket(b, '这个急');
  assert.deepEqual(s.nextLaunches().map(l => [l.ticketId, l.slotId]), [[b, 'urgent']]);
  assert.equal(launch(b), undefined);
});

test('review rework goes ahead of the queue but never takes the emergency slot', t => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  let clock = 1_000;
  const s = new Scheduler(db, { clock: () => ++clock, review: true });
  t.after(() => db.close());
  s.setSlots([{ id: 'slot-1', label: '工位 01', model: null, emergency: false }, { id: 'urgent', label: '应急', model: null, emergency: true }]);
  const open = text => s.openTicket({ fromMessageId: s.bossSaid(text), routingNote: '去工位' });
  const a = open('第一件'), b = open('第二件');
  const first = s.nextLaunches();
  assert.deepEqual(first.map(l => [l.ticketId, l.slotId]), [[a, 'slot-1']]);
  s.reportReceived(first[0].assignmentId, done);
  const m = s.pendingReviews()[0].reportMessageId;
  assert.equal(s.recordReview(m, { verdict: 'fail', reason: '没跑测试', checks: [{ label: '对上原话了吗', ok: true, detail: '对上了' }, { label: '有验证结果吗', ok: false, detail: '没有' }, { label: '有没有多改', ok: true, detail: '没有' }] }), 'rejected');
  // The rework goes before b, into the normal slot; b still waits, and the emergency slot stays free for the boss.
  assert.deepEqual(s.nextLaunches().map(l => [l.ticketId, l.slotId]), [[a, 'slot-1']]);
  assert.equal(s.state(b), 'QUEUED');
});

test('move to front: a queued ticket jumps ordinary work, but not work the boss spoke to', t => {
  const { s, open } = fixture(t);
  const a = open('一'), b = open('二'), c = open('三'), d = open('四');
  const first = s.nextLaunches();
  assert.deepEqual(first.map(l => l.ticketId), [a]);
  assert.deepEqual([b, c, d].map(id => s.tickets().find(x => x.id === id).queuePosition), [1, 2, 3]);
  assert.equal(s.moveToFront(d), 1);
  assert.deepEqual([d, b, c].map(id => s.tickets().find(x => x.id === id).queuePosition), [1, 2, 3]);
  s.tellTicket(c, '这个急');
  assert.equal(s.tickets().find(x => x.id === c).queuePosition, 1, 'the boss speaking to a ticket still comes first');
  assert.equal(s.moveToFront(b), 2, 'b goes ahead of d but behind the boss-urgent c');
  assert.throws(() => s.moveToFront(a), /V8_NOT_QUEUED/, 'only queued tickets move');
  s.reportReceived(first[0].assignmentId, done);
  assert.deepEqual(s.nextLaunches().map(l => l.ticketId), [c]);
});

test('slots: at least one normal slot, ids unique, a busy slot cannot be removed', t => {
  const { s, open } = fixture(t);
  assert.deepEqual(s.slots(), [{ id: 'slot-1', label: '工位 01', model: null, emergency: false }]);
  assert.throws(() => s.setSlots([{ id: 'u', label: '应急', model: null, emergency: true }]), /V8_SLOTS_NEED_ONE_NORMAL/);
  assert.throws(() => s.setSlots([{ id: 'a', label: '1', emergency: false }, { id: 'a', label: '2', emergency: false }]), /V8_SLOTS_INVALID/);
  open('第一件');
  s.nextLaunches();
  assert.throws(() => s.setSlots([{ id: 'slot-2', label: '工位 02', model: null, emergency: false }]), /V8_SLOT_BUSY/);
});

test('refusals change nothing; the talk bar holds the boss-lead conversation, tickets hold their own history', t => {
  const { s, open, db, launch } = fixture(t);
  const id = open('导出按钮');
  const l = launch(id);
  const before = JSON.stringify(db.prepare('SELECT * FROM v8_messages').all()) + JSON.stringify(db.prepare('SELECT * FROM v8_assignments').all());
  assert.throws(() => s.reportReceived(l.assignmentId, { kind: 'done', summary: '好了', changed: [] }), /V8_DONE_NEEDS_VERIFICATION/);
  assert.throws(() => s.tellTicket(id, '   '), /V8_TEXT_INVALID/);
  assert.throws(() => s.tellTicket(999, '你好'), /V8_TICKET_NOT_FOUND/);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM v8_messages').all()) + JSON.stringify(db.prepare('SELECT * FROM v8_assignments').all()), before);
  s.leadSaid('已经派给工位 01 了', id);
  s.leadSaid('收到');
  s.tellTicket(id, '别动工具栏');
  assert.deepEqual(s.messages(null).map(m => [m.author, m.body]), [['boss', '导出按钮'], ['lead', '已经派给工位 01 了'], ['lead', '收到']]);
  assert.ok(s.messages(id).some(m => m.author === 'boss' && m.body === '别动工具栏'));
  assert.ok(s.messages(id).some(m => m.author === 'lead'));
});

test('the tables survive reopening the database file', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-sched-'));
  const file = path.join(dir, 'v8.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let db = new Database(file);
  let s = new Scheduler(db);
  const id = s.openTicket({ fromMessageId: s.bossSaid('导出按钮'), routingNote: '' });
  s.nextLaunches();
  db.close();
  db = new Database(file);
  s = new Scheduler(db);
  assert.equal(s.state(id), 'WORKING');
  s.recoverAfterRestart();
  assert.equal(s.state(id), 'QUEUED');
  db.close();
});
