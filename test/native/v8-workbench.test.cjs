'use strict';
// v8 B4: the workbench put together, checked against spec section 10 (the minimal version) on the fake shell:
// three tickets through the whole line, one interrupted by the boss and one stopped; state survives a restart;
// what the board shows comes from the record. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { V8Workbench } = load('src/main/v8/workbench.ts');

async function until(check, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 20)); }
  assert.fail('timed out waiting for ' + what);
}

// Workbenches on a folder close before the folder is removed (Windows keeps open database files locked).
const closers = new Map();
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-bench-'));
  closers.set(dir, []);
  t.after(async () => { for (const c of closers.get(dir)) await c(); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

async function bench(t, stateDir, settings = {}) {
  const b = new V8Workbench({ stateDir, settings, demoPace: 0.02 });
  await b.start();
  let open = true;
  closers.get(stateDir).push(async () => { if (open) { open = false; await b.shutdown(); } });
  return { b, close: async () => { open = false; await b.shutdown(); } };
}

const state = (b, title) => b.scheduler.tickets().find(t => t.originalRequest === title)?.state;

test('spec 10: three tickets through the whole line; one interrupted by the boss, one stopped', async t => {
  const { b } = await bench(t, home(t));
  let changes = 0;
  b.onChange(() => changes++);

  b.say('首页的标题改一下');
  await until(() => state(b, '首页的标题改一下') === 'REVIEW', 'ticket 1');

  b.say('列表页太慢');                       // works until spoken to
  await until(() => b.board().slots[0].ticket?.originalRequest === '列表页太慢' && b.board().slots[0].live?.startsWith('edit'), 'ticket 2 at work');
  const two = b.scheduler.tickets().find(x => x.originalRequest === '列表页太慢').id;
  await b.tell(two, '别动图片尺寸');
  await until(() => state(b, '列表页太慢') === 'REVIEW', 'ticket 2 after the interruption');
  assert.match(b.scheduler.latestReport(two).summary, /别动图片尺寸/);

  b.say('设置页也慢');
  await until(() => state(b, '设置页也慢') === 'WORKING', 'ticket 3 at work');
  const three = b.scheduler.tickets().find(x => x.originalRequest === '设置页也慢').id;
  b.say(`把 #${three} 停掉`);
  await until(() => state(b, '设置页也慢') === 'STOPPED', 'ticket 3 stopped');

  assert.equal(b.scheduler.tickets().length, 3, 'the stop request opened no ticket');
  const board = b.board();
  assert.deepEqual(board.waiting.map(w => w.originalRequest), ['首页的标题改一下', '列表页太慢']);
  assert.equal(board.queue.length, 0);
  assert.ok(board.talk.some(l => l.author === 'lead' && /停了/.test(l.text)));
  assert.ok(board.feed.length > 0);
  assert.ok(changes > 5, 'the screen hears about changes');
  // Every ticket worked in its own worktree on its own branch.
  for (const id of [1, 2, 3]) assert.ok(fs.existsSync(path.join(b.projectRoot, '..', 'work', 'ticket-' + id, '.git')), 'worktree ' + id);
});

test('a question reaches the talk bar with its options; the answer finishes the ticket; accept and reject work', async t => {
  const { b } = await bench(t, home(t));
  b.say('问一下要不要改文案');
  await until(() => b.board().talk.some(l => l.question), 'the question in the talk bar');
  const q = b.board().talk.find(l => l.question).question;
  assert.deepEqual(q.options.map(o => o.label), ['改', '不改']);
  assert.equal(q.recommended, 'no');
  await b.tell(q.ticketId, '不改');
  await until(() => b.scheduler.state(q.ticketId) === 'REVIEW', 'the answered ticket');
  assert.equal(b.board().talk.some(l => l.question), false, 'an answered question loses its buttons');
  const d = b.delivery(q.ticketId);
  assert.equal(d.verification.command, 'npm test');
  assert.equal(d.originalRequest, '问一下要不要改文案');
  b.accept(q.ticketId);
  assert.equal(b.scheduler.state(q.ticketId), 'DONE');

  b.say('再改一个按钮');
  await until(() => state(b, '再改一个按钮') === 'REVIEW', 'the second ticket');
  const id = b.scheduler.tickets().find(x => x.originalRequest === '再改一个按钮').id;
  await b.reject(id, '颜色不对');
  await until(() => b.scheduler.state(id) === 'REVIEW' && b.scheduler.messages(id).filter(m => m.kind === 'report').length === 2, 'the redo');
  assert.ok(b.scheduler.messages(id).some(m => m.author === 'boss' && m.body === '打回重做：颜色不对'));
});

test('spec 10: closing and reopening the app keeps every ticket; work that was running is picked up again', async t => {
  const dir = home(t);
  const first = await bench(t, dir);
  first.b.say('首页的标题改一下');
  await until(() => state(first.b, '首页的标题改一下') === 'REVIEW', 'ticket 1');
  first.b.say('列表页太慢');
  await until(() => state(first.b, '列表页太慢') === 'WORKING', 'ticket 2 at work');
  await first.close();                                   // quit mid-turn

  const again = await bench(t, dir);
  assert.equal(state(again.b, '首页的标题改一下'), 'REVIEW', 'finished work is still there');
  // The interrupted ticket is queued again as recovery and picked up; the fake gremlin then waits to be spoken to.
  await until(() => state(again.b, '列表页太慢') === 'WORKING', 'the recovered ticket');
  const two = again.b.scheduler.tickets().find(x => x.originalRequest === '列表页太慢').id;
  assert.ok(again.b.scheduler.messages(two).some(m => /重启/.test(String(m.body))));
  await again.b.tell(two, '继续');
  await until(() => state(again.b, '列表页太慢') === 'REVIEW', 'the recovered ticket finishing');
});

test('by default two slots and an emergency slot; the emergency slot can be turned off', async t => {
  const { b } = await bench(t, home(t));
  assert.deepEqual(b.scheduler.slots().map(s => [s.id, s.emergency]), [['slot-1', false], ['slot-2', false], ['slot-emergency', true]]);
  const board = b.board();
  assert.equal(board.slots.length, 2);
  assert.equal(board.emergency?.slot.id, 'slot-emergency');
  const { b: off } = await bench(t, home(t), { emergencySlot: false, slots: 1 });
  assert.deepEqual(off.scheduler.slots().map(s => s.id), ['slot-1']);
  assert.equal(off.board().emergency, null);
});

test('more slots in the settings apply on the next start even if work was left running', async t => {
  const dir = home(t);
  const first = await bench(t, dir, { slots: 1, emergencySlot: false });
  first.b.say('列表太慢');
  await until(() => first.b.board().slots[0].ticket?.state === 'WORKING', 'work running');
  await first.close();
  const { b } = await bench(t, dir, { slots: 2 });
  assert.deepEqual(b.scheduler.slots().map(s => s.id), ['slot-1', 'slot-2', 'slot-emergency']);
});

test('the boss moves a queued ticket to the front, from the queue page or by asking the lead', async t => {
  const { b } = await bench(t, home(t), { slots: 1, emergencySlot: false });
  for (const text of ['一号活', '二号活', '三号活']) b.say(text);
  await until(() => b.board().queue.length === 2, 'two in the queue');
  const third = b.board().queue[1];
  assert.equal(third.originalRequest, '三号活');
  assert.equal(b.front(third.id), 1);
  assert.deepEqual(b.board().queue.map(t => t.originalRequest), ['三号活', '二号活']);
  b.say('把排队 02 提到最前');
  await until(() => b.board().queue[0]?.originalRequest === '二号活', 'the lead moving queue position 2 to the front');
  await until(() => b.board().talk.some(l => l.author === 'lead' && /已提前/.test(l.text)), 'the lead saying so');
});

test('slots follow the settings; the board shows the live slot and the project', async t => {
  const { b } = await bench(t, home(t), { slots: 2, emergencySlot: false });
  // The demo gremlins call no model (the per-slot model comes from the worker's agent with shell 'acp').
  assert.deepEqual(b.scheduler.slots().map(s => [s.id, s.model]), [['slot-1', null], ['slot-2', null]]);
  b.say('改一');
  b.say('改二慢');
  await until(() => b.board().slots.filter(s => s.ticket).length === 2 || state(b, '改一') === 'REVIEW', 'two at work');
  const board = b.board();
  assert.equal(board.project, '演示项目');
  assert.equal(board.slots.length, 2);
  assert.ok(board.slots.some(s => s.ticket && s.startedAt && s.live !== undefined));
});
