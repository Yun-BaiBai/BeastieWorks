'use strict';
// v8 B2: the shell interface, the fake shell, and the whole line on top of it:
// boss → lead → ticket → gremlin → report → state, with steering, stopping, refusals and restart.
// No model is called. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const Database = require('better-sqlite3'), load = require('../load-ts.cjs');
const { Scheduler } = load('src/main/v8/scheduler.ts');
const { Dispatcher } = load('src/main/v8/dispatcher.ts');
const { Lead } = load('src/main/v8/lead.ts');
const { FakeShell } = load('src/main/v8/fakeShell.ts');
const { LEAD_TOOLS, REPORT_NUDGE } = load('src/main/v8/prompts.ts');

const done = extra => ({ kind: 'done', summary: '把减号改成了加号' + (extra ?? ''), changed: ['calc.py'], verification: { command: 'python test_calc.py', output: 'ok' } });

/** Gremlin behaviour is picked by a word in the boss's request, so each test reads like a story. */
const worker = () => ({
  async onPrompt(c, text) {
    if (text === REPORT_NUDGE) { c.settle(); return; }                                   // still lazy
    if (/偷懒/.test(text)) { c.tool('read', { path: 'calc.py' }); c.settle(); return; }   // stops without a report
    if (/崩溃/.test(text)) { c.exit('exit code 3'); return; }
    if (/问/.test(text) && !/老板说/.test(text)) {
      await c.hostTool('submit_report', { kind: 'question', question: '文件名要带日期吗？', options: [{ id: 'yes', label: '带' }, { id: 'no', label: '不带' }], recommended: 'yes' });
      c.settle(); return;
    }
    if (/卡/.test(text)) { await c.hostTool('submit_report', { kind: 'blocked', where: '装不了依赖', tried: '换了源' }); c.settle(); return; }
    if (/假完成/.test(text)) {
      const r = await c.hostTool('submit_report', { kind: 'done', summary: '好了', changed: [], verification: { command: 'python t.py', output: '' } });
      await c.hostTool('submit_report', { kind: 'blocked', where: '跑不了测试', tried: r.ok ? '' : r.error });
      c.settle(); return;
    }
    if (/要命令/.test(text)) {
      const allowed = await c.approval('bash', 'python test_calc.py');
      await c.hostTool('submit_report', allowed ? done('，测试已跑') : { kind: 'blocked', where: '不让跑测试', tried: '申请过' });
      c.settle(); return;
    }
    if (/慢/.test(text)) {                       // works until steered or stopped
      c.tool('read', { path: 'calc.py' });
      c.slow = new Promise(r => { c.release = r; });
      const steer = await c.slow;
      if (c.aborted) return;
      await c.hostTool('submit_report', done('；按你说的：' + steer));
      c.settle(); return;
    }
    c.tool('read', { path: 'calc.py' }); c.tool('edit', { path: 'calc.py' }); c.tool('bash', { command: 'python test_calc.py' });
    if (!(await c.approval('submit_report', 'Allow tool: submit_report'))) { c.settle(); return; }
    await c.hostTool('submit_report', done());
    c.settle();
  },
  onSteer(c, text) { c.release?.(text); },
});

/** The lead reads "老板（消息 #N）：…" or a report line, and uses only its tools. */
const lead = () => ({
  async onPrompt(c, text) {
    // Like real omp with first-class host tools: ask before the first tool call of a turn, and try something it lacks.
    c.leadAsked = [await c.approval('open_ticket', 'Allow tool: open_ticket'), await c.approval('bash', 'Allow tool: bash\nCommand: dir')];
    const said = [...text.matchAll(/老板（消息 #(\d+)）：(.*)/g)];
    for (const [, id, words] of said) {
      const ticket = words.match(/#(\d+)/);
      if (/停/.test(words) && ticket) await c.hostTool('stop_ticket', { ticket_id: Number(ticket[1]), message_id: Number(id) });
      else if (/补充/.test(words) && ticket) await c.hostTool('forward_to_ticket', { message_id: Number(id), ticket_id: Number(ticket[1]) });
      else if (/自己编/.test(words)) c.lastOpen = await c.hostTool('open_ticket', { message_id: Number(id) - 1, routing_note: '' });
      else { await c.hostTool('open_ticket', { message_id: Number(id), routing_note: '去工位' }); await c.hostTool('reply_to_boss', { text: '派出去了' }); }
    }
    const report = text.match(/工单 #(\d+)「.*」交了报告：(.*)/);
    if (report) {
      if (/有问题要问老板/.test(report[2])) await c.hostTool('ask_boss', { ticket_id: Number(report[1]) });
      else c.emit({ type: 'message', text: '工单 #' + report[1] + '：' + report[2].slice(0, 20) });   // plain text, no tool
    }
    c.settle();
  },
});

async function until(check, what) {
  for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setImmediate(r)); }
  assert.fail('timed out waiting for ' + what);
}

async function fixture(t, o = {}) {
  const db = o.db ?? new Database(':memory:');
  db.pragma('foreign_keys=ON');
  const s = new Scheduler(db);
  if (o.slots) s.setSlots(o.slots);
  const shell = new FakeShell(spec => (spec.role === 'lead' ? lead() : worker()));
  const activity = [];
  const d = new Dispatcher(s, o.shell ?? shell, { workdir: id => 'D:/work/ticket-' + id, ...(o.approve ? { approve: o.approve } : {}) });
  d.onActivity(a => activity.push(a));
  const l = new Lead(s, d, shell, { cwd: 'D:/work', model: null });
  await l.start();
  if (o.start !== false) await d.start();
  t.after(async () => { await d.shutdown(); await l.stop(); if (!o.keepDb) db.close(); });
  const talk = () => s.messages(null).map(m => m.author + ': ' + m.body);
  const workers = () => shell.sessions.filter(x => x.spec.role === 'worker');
  return { db, s, d, l, shell, activity, talk, workers };
}

test('the whole line: the boss says it, the lead opens a ticket, a gremlin does it, the boss hears back', async t => {
  const f = await fixture(t);
  f.l.bossSays('calc.py 的 add 算错了，修一下');
  await until(() => f.s.tickets()[0]?.state === 'REVIEW', 'the report');
  const [ticket] = f.s.tickets();
  assert.equal(ticket.originalRequest, 'calc.py 的 add 算错了，修一下');
  const [g] = f.workers();
  assert.equal(g.spec.cwd, 'D:/work/ticket-' + ticket.id);
  assert.equal(g.spec.builtinTools, true);
  assert.deepEqual(g.spec.hostTools.map(h => h.name), ['submit_report']);
  assert.match(g.heard[0].text, /老板的原话：\ncalc.py 的 add 算错了，修一下/);
  assert.ok(g.closed, 'the session closes after the report');
  const leadSpec = f.shell.sessions.find(x => x.spec.role === 'lead').spec;
  assert.equal(leadSpec.builtinTools, false);
  assert.deepEqual(leadSpec.hostTools.map(h => h.name), LEAD_TOOLS.map(h => h.name));
  await until(() => f.talk().length === 3, 'the lead to pass the result on');
  assert.deepEqual(f.talk(), ['boss: calc.py 的 add 算错了，修一下', 'lead: 派出去了', 'lead: 工单 #1：做完了。把减号改成了加号（验证：pyth']);
  assert.deepEqual(f.activity.filter(a => a.type === 'tool' && a.phase === 'start').map(a => a.name), ['read', 'edit', 'bash']);
  f.s.confirmTicket(ticket.id);
  assert.equal(f.s.state(ticket.id), 'DONE');
});

test('a question reaches the boss word for word; his answer resumes the same session', async t => {
  const f = await fixture(t);
  f.l.bossSays('导出前先问一下文件名');
  await until(() => f.talk().some(x => /小怪问你/.test(x)), 'the question in the talk bar');
  const id = f.s.tickets()[0].id;
  assert.equal(f.s.state(id), 'ANSWER');
  assert.ok(f.talk().includes(`lead: 工单 #${id}「导出前先问一下文件名」的小怪问你：文件名要带日期吗？\n选项：带（它推荐） / 不带`));
  await f.d.tell(id, '带日期');
  await until(() => f.s.state(id) === 'REVIEW', 'the second report');
  const [first, second] = f.workers();
  assert.equal(first.ref, second.ref, 'resumed, not a new session');
  assert.equal(second.heard[0].text, '老板说：\n- 带日期\n做完后照常调用 submit_report。');
});

test('steering: the boss speaks to a gremlin mid-turn and it hears him in the same turn', async t => {
  const f = await fixture(t);
  f.l.bossSays('首页太慢了');
  await until(() => f.workers()[0]?.release, 'the gremlin to start');
  const id = f.s.tickets()[0].id;
  assert.equal(f.s.state(id), 'WORKING');
  assert.deepEqual(await f.d.tell(id, '别动图片尺寸'), { kind: 'steer', assignmentId: 1 });
  await until(() => f.s.state(id) === 'REVIEW', 'the report');
  assert.deepEqual(f.workers()[0].heard.map(h => h.kind), ['prompt', 'steer']);
  assert.match(f.s.latestReport(id).summary, /按你说的：老板说：别动图片尺寸/);
  assert.equal(f.workers().length, 1);
});

test('stop: the lead stops a ticket only on a boss message; the session is aborted and the next ticket gets the slot', async t => {
  const f = await fixture(t);
  f.l.bossSays('首页太慢了');
  await until(() => f.workers()[0]?.release, 'the first gremlin');
  f.l.bossSays('注册邮件发两遍');
  await until(() => f.s.tickets().length === 2, 'the second ticket');
  assert.equal(f.s.tickets()[1].state, 'QUEUED');
  f.l.bossSays('把 #1 停掉');
  await until(() => f.s.state(1) === 'STOPPED' && f.s.state(2) === 'REVIEW', 'the stop and the next ticket');
  assert.ok(f.workers()[0].aborted);
  assert.ok(f.activity.some(a => a.type === 'ended' && a.ticketId === 1 && a.why === 'stopped'));
  assert.equal(f.s.latestReport(1), null, 'a stopped gremlin hands in nothing');
});

test('the lead cannot open work from its own words, and has no tool to read or run anything', async t => {
  const f = await fixture(t);
  f.s.leadSaid('我觉得应该重构');
  f.l.bossSays('自己编');
  await until(() => f.shell.log.some(x => x.kind === 'host_tool' && !x.value.ok), 'the refusal');
  assert.deepEqual(f.shell.log.find(x => x.kind === 'host_tool' && !x.value.ok).value, { ok: false, error: 'V8_NEEDS_BOSS_MESSAGE' });
  assert.equal(f.s.tickets().length, 0);
});

test('"done" without verification output is sent back to the gremlin, which then reports honestly', async t => {
  const f = await fixture(t);
  f.l.bossSays('假完成一下');
  await until(() => f.s.tickets()[0]?.state === 'BLOCKED', 'the honest report');
  assert.ok(f.activity.some(a => a.type === 'refused' && a.code === 'V8_DONE_NEEDS_VERIFICATION'));
  assert.match(f.s.latestReport(1).tried, /必须附真实的验证：怎么验证的，和验证结果原样/);
  assert.equal(f.s.messages(1).filter(m => m.kind === 'report').length, 1, 'the refused report was never recorded');
});

test('a gremlin that stops without reporting is nudged once, then shows up as a failure', async t => {
  const f = await fixture(t);
  f.l.bossSays('偷懒一下');
  await until(() => f.s.tickets()[0]?.state === 'FAILED', 'the failure');
  assert.deepEqual(f.workers()[0].heard.map(h => h.text === REPORT_NUDGE), [false, true]);
  assert.match(f.s.latestReport(1).reason, /两次停下都没交报告/);
});

test('a crashed session is a failure; retry resumes the same session', async t => {
  const f = await fixture(t);
  f.l.bossSays('崩溃一下');
  await until(() => f.s.tickets()[0]?.state === 'FAILED', 'the failure');
  assert.match(f.s.latestReport(1).reason, /exit code 3/);
  f.s.retryTicket(1);
  await f.d.pump();
  await until(() => f.workers().length === 2, 'the retry');
  assert.equal(f.workers()[1].ref, f.workers()[0].ref);
  assert.match(f.workers()[1].heard[0].text, /老板让你再试一次/);
});

test('approvals: refused by default, decided by the policy when there is one', async t => {
  const f = await fixture(t);
  f.l.bossSays('要命令跑测试');
  await until(() => f.s.tickets()[0]?.state === 'BLOCKED', 'the refusal');
  assert.ok(f.activity.some(a => a.type === 'approval' && a.allowed === false && a.ticketId === 1));

  const asked = [];
  const g = await fixture(t, { approve: r => { asked.push(r); return r.detail === 'python test_calc.py'; } });
  g.l.bossSays('要命令跑测试');
  await until(() => g.s.tickets()[0]?.state === 'REVIEW', 'the allowed run');
  assert.deepEqual(asked, [{ ticketId: 1, tool: 'bash', detail: 'python test_calc.py' }]);
});

test('a shell that cannot open a session fails the ticket instead of hanging it', async t => {
  const broken = { open: async () => { throw new Error('omp.exe not found'); } };
  const f = await fixture(t, { shell: broken });
  f.l.bossSays('修一下');
  await until(() => f.s.tickets()[0]?.state === 'FAILED', 'the failure');
  assert.match(f.s.latestReport(1).reason, /开不了会话：omp.exe not found/);
});

test('restart: work that was running is resumed in the same session with a recovery note', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const a = await fixture(t, { db, keepDb: true });
  a.l.bossSays('首页太慢了');
  await until(() => a.workers()[0]?.release, 'the gremlin to start');
  const ref = a.workers()[0].ref;
  await a.d.shutdown();                         // the app quits mid-turn
  const b = await fixture(t, { db, keepDb: true }); // and starts again on the same database
  await until(() => b.workers()[0], 'the recovery launch');
  assert.equal(b.workers()[0].ref, ref);
  assert.match(b.workers()[0].heard[0].text, /应用重启过/);
  // The recovery prompt carries no word of the old request, so the scripted gremlin simply finishes.
  await until(() => b.s.state(1) === 'REVIEW', 'the recovered report');
});

test('two slots run two tickets at once; a third waits its turn', async t => {
  const f = await fixture(t, { slots: [{ id: 'slot-1', label: '工位 01', model: 'm1', emergency: false }, { id: 'slot-2', label: '工位 02', model: 'm2', emergency: false }] });
  f.l.bossSays('首页太慢了');
  f.l.bossSays('列表也慢');
  f.l.bossSays('修一下 calc');
  await until(() => f.s.tickets().length === 3 && f.workers().length === 2, 'two running');
  assert.deepEqual(f.workers().map(w => w.spec.model).sort(), ['m1', 'm2']);
  assert.equal(f.s.tickets()[2].state, 'QUEUED');
  f.workers()[0].release('好');
  await until(() => f.s.tickets()[2].state === 'REVIEW', 'the third ticket');
  assert.equal(f.s.tickets()[1].state, 'WORKING');
});

// Real omp asks before a first-class host tool; the scripted gremlin does the same before reporting.
test("the app's own report tool is always approved, even when the policy refuses everything else", async t => {
  const f = await fixture(t, { approve: () => false });
  f.l.bossSays('修一下 calc');
  await until(() => f.s.tickets()[0]?.state === 'REVIEW', 'the report');
  assert.ok(f.activity.some(a => a.type === 'approval' && a.tool === 'submit_report' && a.allowed === true));
});

test('the lead may use its own tools when omp asks, and nothing else', async t => {
  const f = await fixture(t);
  f.l.bossSays('修一下 calc');
  await until(() => f.s.tickets()[0]?.state === 'REVIEW', 'the report');
  const leadSession = f.shell.sessions.find(x => x.spec.role === 'lead');
  assert.deepEqual(leadSession.leadAsked, [true, false]);
});

test('the policy may wait for the boss: the gremlin waits, then gets the answer (a connector tool)', async t => {
  let answer;
  const g = await fixture(t, { approve: r => r.detail === 'python test_calc.py' ? new Promise(res => { answer = res; }) : false });
  g.l.bossSays('要命令跑测试');
  await until(() => typeof answer === 'function', 'the question to the boss');
  assert.equal(g.s.tickets()[0].state, 'WORKING', 'the gremlin waits meanwhile');
  answer(true);
  await until(() => g.s.tickets()[0]?.state === 'REVIEW', 'the allowed run');
  assert.ok(g.activity.some(a => a.type === 'approval' && a.allowed === true && a.detail === 'python test_calc.py'));
});

test('a connector tool is named in the permission detail and recognised; the rule alone never allows it', () => {
  const { describePermission } = load('src/main/v8/acpShell.ts');
  const { connectorOf, directoryPolicy } = load('src/main/v8/approval.ts');
  const d = describePermission({ title: 'notion-fetch', kind: 'other', rawInput: { id: 'x' }, _meta: { claudeCode: { toolName: 'mcp__claude_ai_Notion__notion-fetch' } } });
  assert.match(d.detail, /^Connector: mcp__claude_ai_Notion__notion-fetch$/m);
  assert.deepEqual(connectorOf(d.detail), { full: 'mcp__claude_ai_Notion__notion-fetch', server: 'Notion', tool: 'notion-fetch', writes: false });
  assert.equal(connectorOf(describePermission({ title: 'x', _meta: { claudeCode: { toolName: 'mcp__claude_ai_Notion__notion-update-page' } } }).detail).writes, true);
  assert.equal(connectorOf(describePermission({ title: 'Read a.txt', kind: 'read' }).detail), null);
  assert.equal(directoryPolicy({ workdir: () => 'D:/w' })({ ticketId: 1, tool: d.tool, detail: d.detail }), false);
});
