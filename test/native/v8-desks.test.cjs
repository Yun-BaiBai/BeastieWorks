'use strict';
// Desks set up one by one (老板 2026-11-21, requirements 61–66): each desk its own agent, skills and quota plan; a ticket
// may name its desk and then waits for it. No model. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3'), load = require('../load-ts.cjs');
const { Scheduler } = load('src/main/v8/scheduler.ts');
const { Dispatcher } = load('src/main/v8/dispatcher.ts');
const { FakeShell } = load('src/main/v8/fakeShell.ts');
const { V8Workbench } = load('src/main/v8/workbench.ts');
const { desksOf, planOf, newDeskId } = load('src/shared/v8/desks.ts');

async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 15)); }
  assert.fail('timed out waiting for ' + what);
}
const report = { kind: 'done', summary: '好了', changed: [], verification: { command: 'x', output: 'ok' } };

test('before the boss sets desks, the old settings become every desk\'s, so nothing is lost', () => {
  const old = { shell: 'acp', slots: 3, acp: { lead: { agent: 'claude-acp' }, worker: { agent: 'codex-acp', model: 'gpt-5.6-luna', effort: 'low' } }, onQuota: { do: 'switch', model: 'haiku' } };
  const d = desksOf(old);
  assert.deepEqual(d.map(x => x.id), ['slot-1', 'slot-2', 'slot-3']);
  assert.deepEqual(d[1], { id: 'slot-2', agent: 'codex-acp', model: 'gpt-5.6-luna', effort: 'low', onQuota: { do: 'switch', backups: [{ model: 'haiku' }] } });
  assert.deepEqual(planOf({ do: 'wait' }), { do: 'wait' });
  // Set desks win; never more than 8; ids stay stable and a new one takes the first free number.
  const set = Array.from({ length: 10 }, (_, i) => ({ id: 'slot-' + (i + 2), agent: 'a' }));
  assert.equal(desksOf({ ...old, desks: set }).length, 8);
  assert.equal(newDeskId([{ id: 'slot-2', agent: 'a' }, { id: 'slot-3', agent: 'a' }]), 'slot-1');
});

test('a ticket that names its desk runs there only, waits while it is busy, and is freed when the desk goes', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const s = new Scheduler(db, {});
  s.setSlots([{ id: 'slot-1', label: '工位 01', model: null, emergency: false }, { id: 'slot-2', label: '小黑', model: null, emergency: false }, { id: 'slot-emergency', label: '应急', model: null, emergency: true }]);
  const open = (text, slotId) => s.openTicket({ fromMessageId: s.bossSaid(text), routingNote: '', ...(slotId ? { slotId } : {}) });
  assert.throws(() => open('去应急', 'slot-emergency'), /V8_NO_SUCH_DESK/);
  assert.throws(() => open('去不存在的', 'slot-9'), /V8_NO_SUCH_DESK/);
  const a = open('第一件，给小黑', 'slot-2');
  assert.equal(s.ticket(a).targetSlot, 'slot-2');
  const first = s.nextLaunches();
  assert.deepEqual(first.map(l => [l.ticketId, l.slotId]), [[a, 'slot-2']], 'the named desk, though slot-1 was free first');
  const b = open('第二件，也给小黑', 'slot-2');
  const c = open('第三件，谁都行');
  assert.deepEqual(s.nextLaunches().map(l => [l.ticketId, l.slotId]), [[c, 'slot-1']], 'b waits for its desk; c takes the free one');
  assert.equal(s.state(b), 'QUEUED');
  s.reportReceived(first[0].assignmentId, report);
  assert.deepEqual(s.nextLaunches().map(l => [l.ticketId, l.slotId]), [[b, 'slot-2']], 'b goes once its desk is free');
  // A desk the boss removes no longer holds a ticket back.
  const d = open('第四件，给小黑', 'slot-2');
  s.setSlots([{ id: 'slot-1', label: '工位 01', model: null, emergency: false }, { id: 'slot-2', label: '小黑', model: null, emergency: false }]);
  assert.equal(s.ticket(d).targetSlot, 'slot-2');
  assert.throws(() => s.setSlots([{ id: 'slot-1', label: '工位 01', model: null, emergency: false }]), /V8_SLOT_BUSY/, 'b still works at slot-2');
});

test('each desk\'s gremlin is opened on that desk\'s own agent', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const s = new Scheduler(db, {});
  s.setSlots([{ id: 'slot-1', label: '工位 01', model: 'm1', emergency: false }, { id: 'slot-2', label: '工位 02', model: 'm2', emergency: false }]);
  const script = () => ({ async onPrompt(c) { await c.hostTool('submit_report', report); c.settle(); } });
  const plain = new FakeShell(script), other = new FakeShell(script);
  const d = new Dispatcher(s, plain, { workdir: id => 'D:/work/' + id, shellFor: id => id === 'slot-2' ? other : null });
  t.after(() => d.shutdown());
  const x = s.openTicket({ fromMessageId: s.bossSaid('一'), routingNote: '', slotId: 'slot-1' });
  const y = s.openTicket({ fromMessageId: s.bossSaid('二'), routingNote: '', slotId: 'slot-2' });
  await d.pump();
  await until(() => s.state(x) !== 'QUEUED' && s.state(y) !== 'QUEUED' && plain.sessions.length + other.sessions.length === 2, 'both started');
  assert.deepEqual(plain.sessions.map(z => z.spec.model), ['m1']);
  assert.deepEqual(other.sessions.map(z => z.spec.model), ['m2'], 'slot-2 on its own agent, with its own model');
});

function bench(t, settings, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-desks-'));
  const closers = [];
  t.after(async () => { for (const c of closers) await c(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const b = new V8Workbench({ stateDir: dir, settings, demoPace: 0.02, ...extra });
  closers.push(() => b.shutdown());
  return b;
}

test('a desk that runs out of quota goes through its own backups in order, then waits', async t => {
  // A gremlin that never finishes, so the ticket is still at work when its quota runs out.
  const shell = new FakeShell(spec => spec.role === 'worker' ? { async onPrompt() { /* works on */ } } : { async onPrompt(c) { c.settle(); } });
  const b = bench(t, { review: false, desks: [{ id: 'slot-1', agent: 'demo', onQuota: { do: 'switch', backups: [{ model: 'b1' }, { model: 'b2', effort: 'high' }] } }, { id: 'slot-2', agent: 'demo', onQuota: { do: 'wait' } }] }, { shell });
  await b.start();
  const runOut = async id => {
    await until(() => b.scheduler.state(id) === 'WORKING', 'at work');
    await b.dispatcher.pause(id, a => { b.scheduler.assignmentOutOfQuota(a, { resetsAt: null, detail: 'limit' }); });
    await b.applyQuotaRule(id, null);
  };
  const one = b.scheduler.openTicket({ fromMessageId: b.scheduler.bossSaid('一号的活'), routingNote: '', slotId: 'slot-1' });
  await b.dispatcher.pump();
  await runOut(one);
  assert.equal(b.scheduler.ticketSupply(one).model, 'b1', 'first backup');
  await runOut(one);
  assert.deepEqual([b.scheduler.ticketSupply(one).model, b.scheduler.ticketSupply(one).effort], ['b2', 'high'], 'then the second');
  await runOut(one);
  assert.equal(b.scheduler.ticketSupply(one).model, 'b2', 'no more backups');
  assert.equal(b.scheduler.state(one), 'WAITING_QUOTA', 'so it waits');
  // The other desk was set to wait: its ticket waits at once.
  const two = b.scheduler.openTicket({ fromMessageId: b.scheduler.bossSaid('二号的活'), routingNote: '', slotId: 'slot-2' });
  await b.dispatcher.pump();
  await runOut(two);
  assert.equal(b.scheduler.ticketSupply(two).model, null);
  assert.equal(b.scheduler.state(two), 'WAITING_QUOTA');
});

test('a desk\'s gremlin is offered only the skills that desk allows', async t => {
  const asked = [];
  const skills = {
    briefLines: (about, off) => { asked.push(['brief', off]); return []; },
    call: (n, a, off) => { asked.push(['call', off]); return { ok: true, text: 'x' }; },
  };
  const shell = new FakeShell(spec => spec.role === 'worker'
    ? { async onPrompt(c) { await c.hostTool('list_skills', {}); await c.hostTool('submit_report', report); c.settle(); } }
    : { async onPrompt(c) { c.settle(); } });
  const b = bench(t, { review: false, desks: [{ id: 'slot-1', agent: 'demo', skillsOff: ['agent-browser'] }] }, { shell, skills });
  await b.start();
  const id = b.scheduler.openTicket({ fromMessageId: b.scheduler.bossSaid('查个网页'), routingNote: '' });
  await b.dispatcher.pump();
  await until(() => b.scheduler.state(id) === 'REVIEW', 'done');
  assert.deepEqual(asked, [['brief', ['agent-browser']], ['call', ['agent-browser']]]);
});

test('the boss names a desk by number, name or agent; the lead sees the desks and the ticket goes there', async t => {
  const { Lead, pickDesk } = load('src/main/v8/lead.ts');
  const desks = [{ id: 'slot-1', label: '工位 01', agent: 'Codex' }, { id: 'slot-2', label: '小黑', agent: 'Claude' }, { id: 'slot-3', label: '工位 03', agent: 'Codex' }];
  assert.equal(pickDesk(desks, '2')?.id, 'slot-2');
  assert.equal(pickDesk(desks, '2 号')?.id, 'slot-2');
  assert.equal(pickDesk(desks, '工位 03')?.id, 'slot-3');
  assert.equal(pickDesk(desks, '小黑')?.id, 'slot-2');
  assert.equal(pickDesk(desks, 'claude')?.id, 'slot-2', 'the only Claude desk');
  assert.equal(pickDesk(desks, 'codex'), null, 'two Codex desks: not a name');
  assert.equal(pickDesk(desks, '9'), null);

  const db = new Database(':memory:');
  t.after(() => db.close());
  const s = new Scheduler(db, {});
  s.setSlots([{ id: 'slot-1', label: '工位 01', model: null, emergency: false }, { id: 'slot-2', label: '小黑', model: null, emergency: false }]);
  const worker = new FakeShell(() => ({ async onPrompt() { /* works on */ } }));
  const d = new Dispatcher(s, worker, { workdir: id => 'D:/work/' + id });
  t.after(() => d.shutdown());
  const heard = [];
  const leadShell = new FakeShell(() => ({ async onPrompt(c, text) {
    const id = Number(/消息 #(\d+)/.exec(text)[1]);
    heard.push((await c.hostTool('list_desks', {})).text);
    heard.push(await c.hostTool('open_ticket', { message_id: id, routing_note: '', desk: '小黑' }));
    c.settle();
  } }));
  const lead = new Lead(s, d, leadShell, { cwd: 'D:/lead', model: null, desks: () => s.slots().map(x => ({ id: x.id, label: x.label, agent: 'Codex', model: null, busyWith: null, waiting: 0 })) });
  await lead.start();
  t.after(() => lead.stop());
  lead.bossSays('让小黑做首页');
  await until(() => heard.length === 2, 'the lead\'s two calls');
  assert.match(heard[0], /2\. 小黑 · Codex · 空着/);
  assert.equal(heard[1].ok, true);
  const ticket = s.tickets()[0];
  assert.equal(ticket.targetSlot, 'slot-2');
  await until(() => s.ticket(ticket.id).slotId === 'slot-2', 'at its desk');
});

test('the lead out of quota goes on with its own backup, on the same conversation, and does the turn again', async t => {
  const { Lead } = load('src/main/v8/lead.ts');
  const db = new Database(':memory:');
  t.after(() => db.close());
  const s = new Scheduler(db, {});
  const d = new Dispatcher(s, new FakeShell(() => ({})), { workdir: id => 'D:/work/' + id });
  t.after(() => d.shutdown());
  const shell = new FakeShell(spec => ({ async onPrompt(c, text) {
    if (spec.model !== 'b1') { c.settle('error', 'You have hit your usage limit.'); return; }
    await c.hostTool('reply_to_boss', { text: '收到：' + /：(.*)$/.exec(text)[1] }); c.settle();
  } }));
  const notes = [];
  const lead = new Lead(s, d, shell, { cwd: 'D:/lead', model: 'main', plan: () => ({ do: 'switch', backups: [{ model: 'b1' }] }), onNote: (x, tone) => notes.push([x, tone]) });
  await lead.start();
  t.after(() => lead.stop());
  lead.bossSays('先别派活，说句话');
  await until(() => s.messages(null).some(m => m.author === 'lead'), 'the answer on the backup');
  assert.equal(String(s.messages(null).find(m => m.author === 'lead').body), '收到：先别派活，说句话');
  assert.deepEqual(shell.sessions.map(x => x.spec.model), ['main', 'b1']);
  assert.equal(shell.sessions[1].spec.sessionRef, shell.sessions[0].ref, 'the same conversation');
  assert.match(notes[0][0], /换成 b1/);
});

test('the reviewer out of quota reviews again on its backup; set to wait, the work keeps waiting for review', async t => {
  const { Reviewer } = load('src/main/v8/reviewer.ts');
  const run = async (plan) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    const s = new Scheduler(db, { review: true });
    const shell = new FakeShell(spec => spec.role === 'reviewer'
      ? { async onPrompt(c) { if (spec.model !== 'r1') { c.settle('error', '429 Too Many Requests'); return; } await c.hostTool('submit_review', { verdict: 'pass', reason: '好', checks: [{ label: 'a', ok: true, detail: 'x' }, { label: 'b', ok: true, detail: 'y' }, { label: 'c', ok: true, detail: 'z' }] }); c.settle(); } }
      : { async onPrompt(c) { await c.hostTool('submit_report', report); c.settle(); } });
    const d = new Dispatcher(s, shell, { workdir: id => 'D:/work/' + id });
    const notes = [];
    const r = new Reviewer(s, d, shell, { model: 'main', cwd: () => 'D:/work', diff: () => '+x', settleGraceMs: 50, plan: () => plan, onNote: (x, tone) => notes.push([x, tone]) });
    r.start();
    t.after(async () => { await r.stop(); await d.shutdown(); });
    const id = s.openTicket({ fromMessageId: s.bossSaid('修'), routingNote: '' });
    await d.pump();
    return { s, id, shell, notes };
  };
  const a = await run({ do: 'switch', backups: [{ model: 'r1' }] });
  await until(() => a.s.state(a.id) === 'REVIEW', 'reviewed on the backup');
  assert.equal(a.s.reviews({ ticketId: a.id })[0].verdict, 'passed');
  assert.deepEqual(a.shell.sessions.filter(x => x.spec.role === 'reviewer').map(x => x.spec.model), ['main', 'r1']);
  const b = await run({ do: 'wait' });
  await until(() => b.notes.length === 1, 'the waiting note');
  assert.equal(b.notes[0][1], 'question');
  assert.equal(b.s.state(b.id), 'WORKING', 'still waiting for review, not passed on unreviewed');
  assert.equal(b.s.pendingReviews().length, 1);
});
