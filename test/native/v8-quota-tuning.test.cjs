'use strict';
// Step 4 of the final plan: each agent's quota can be seen (read from its maker, no message), and the boss can make a
// working gremlin wait (等一等), or switch its model or reasoning effort; it then goes on in the same conversation.
// No model: the stand-in agent from the ACP workbench tests. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { V8Workbench } = load('src/main/v8/workbench.ts');
const { claudeWindows, codexWindows, readClaudeQuota, resetTime, soonestBack, QuotaBook } = load('src/main/v8/quotaRead.ts');

const AGENT = path.join(__dirname, '..', 'fixtures', 'fake-acp-tools-agent.cjs');

async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('timed out waiting for ' + what);
}

async function bench(t, quotaOf, extraEnv = {}, more = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-quota-'));
  const log = path.join(dir, 'log'); fs.mkdirSync(log);
  const node = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const acpLaunch = async agent => ({ label: 'Fake ' + agent, command: process.execPath, args: [AGENT], env: { ELECTRON_RUN_AS_NODE: '1', FAKE_TOOLS_LOG: log, FAKE_TOOLS_DELAY: '3000', ...extraEnv }, node });
  const settings = { shell: 'acp', review: false, slots: 1, emergencySlot: false, acp: { lead: { agent: 'lead-agent' }, worker: { agent: 'worker-agent', model: 'm1' } }, ...more };
  const b = new V8Workbench({ stateDir: path.join(dir, 'state'), settings, acpLaunch, ...(quotaOf ? { quotaOf } : {}) });
  t.after(async () => { await b.shutdown().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  await b.start();
  const read = name => { try { return fs.readFileSync(path.join(log, name), 'utf8'); } catch { return ''; } };
  return { b, log, read };
}

/** Ask for one small thing and wait until the gremlin is working on it. */
async function working(b, read) {
  b.say('加一个 hello.txt');
  await until(() => b.scheduler.tickets().length === 1, 'the lead to open a ticket');
  const id = b.scheduler.tickets()[0].id;
  await until(() => /start ticket-1/.test(read('working.txt')), 'the gremlin to start');
  return id;
}

test('Claude usage page answer becomes quota windows; reset times in seconds, milliseconds or text', () => {
  const w = claudeWindows({ five_hour: { utilization: 6, resets_at: '2026-11-19T07:09:59Z' }, seven_day: { utilization: 1.5, resets_at: '2026-11-25T20:59:59Z' }, seven_day_opus: null,
    limits: [{ kind: 'weekly_scoped', percent: 40, resets_at: 1795267864, scope: { model: { display_name: 'Fable' } } }] });
  assert.deepEqual(w.map(x => [x.label, x.usedPercent]), [['5 小时', 6], ['本周', 1.5], ['本周 · Fable', 40]]);
  assert.equal(w[0].resetsAt, Date.parse('2026-11-19T07:09:59Z'));
  assert.equal(resetTime(1795267864), 1795267864000);
  assert.equal(resetTime(1795267864000), 1795267864000);
  assert.equal(resetTime(''), null);
});

test('Codex rate limits become quota windows, told apart by window length', () => {
  // As Codex 0.167 answers for a Plus account: one weekly window only, in the "primary" place.
  assert.deepEqual(codexWindows({ primary: { usedPercent: 16, windowDurationMins: 10080, resetsAt: 1795267864 }, secondary: null }),
    [{ label: '本周', usedPercent: 16, resetsAt: 1795267864000 }]);
  assert.deepEqual(codexWindows({ primary: { usedPercent: 120, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 3, windowDurationMins: 10079 } }).map(x => [x.label, x.usedPercent]),
    [['5 小时', 100], ['本周', 3]]);
  assert.deepEqual(codexWindows(null), []);
});

test('reading Claude quota: signed in, expired sign-in (not renewed here), not signed in', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-claude-q-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const none = await readClaudeQuota(dir, async () => assert.fail('no request without a sign-in'));
  assert.equal(none.state, 'error'); assert.match(none.note, /还没登录/);
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok', refreshToken: 'r', subscriptionType: 'max' } }));
  let headers = null;
  const ok = await readClaudeQuota(dir, async (url, init) => { headers = init.headers; return new Response(JSON.stringify({ five_hour: { utilization: 30, resets_at: '2026-11-19T07:00:00Z' } }), { status: 200 }); });
  assert.equal(ok.state, 'ok'); assert.equal(ok.plan, 'max'); assert.equal(ok.windows[0].usedPercent, 30);
  assert.equal(headers.Authorization, 'Bearer tok');
  const expired = await readClaudeQuota(dir, async () => new Response('{}', { status: 401 }));
  assert.equal(expired.state, 'error'); assert.match(expired.note, /下次干活时会自己续上/);
  // Nothing was written: the sign-in file is as it was.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken, 'tok');
});

test('the quota book keeps an answer for a while and reads again when asked', async () => {
  let reads = 0;
  const book = new QuotaBook({ claudeHome: () => 'x', codex: async () => null });
  book.readNow = async id => { reads++; return { agentId: id, state: 'none', windows: [], plan: null, note: null, checkedAt: 0 }; };
  await book.read('a'); await book.read('a');
  assert.equal(reads, 1);
  await book.read('a', true);
  assert.equal(reads, 2);
  assert.equal((await new QuotaBook({ claudeHome: () => 'x', codex: async () => null }).read('dsh')).state, 'none');
  // 等一等 goes on when the most-used window starts over.
  assert.equal(soonestBack({ state: 'ok', windows: [{ usedPercent: 20, resetsAt: 5 }, { usedPercent: 90, resetsAt: 9 }] }), 9);
  assert.equal(soonestBack({ state: 'error', windows: [] }), null);
});

test('等一等: the working gremlin stops and waits until its quota starts over; 接着干 brings it back in the same conversation', async t => {
  const back = Date.now() + 3_600_000;
  const asked = [];
  const { b, read } = await bench(t, async agent => { asked.push(agent); return { agentId: agent, state: 'ok', windows: [{ label: '5 小时', usedPercent: 95, resetsAt: back }], plan: null, note: null, checkedAt: Date.now() }; });
  const id = await working(b, read);
  const r = await b.waitForQuota(id);
  assert.equal(r.resetsAt, back);
  assert.deepEqual(asked, ['worker-agent']);
  const t1 = b.scheduler.ticket(id);
  assert.equal(t1.state, 'WAITING_QUOTA');
  assert.equal(t1.quotaWait.resetsAt, back);
  assert.ok(b.board().resting.some(x => x.id === id), 'the board shows it waiting for quota');
  assert.ok(b.scheduler.messages(id).some(m => m.author === 'system' && /老板让它先停下等额度/.test(m.body)));
  // Not working any more: 等一等 again says so.
  await assert.rejects(b.waitForQuota(id), /V8_NOT_WORKING/);
  await b.resumeNow(id);
  await until(() => b.scheduler.latestReport(id)?.kind === 'done', 'the gremlin to finish after going on', 40000);
});

test('换个模型 while it works: it stops for a moment and goes on with the new model, told to continue, not start over', async t => {
  const { b, read } = await bench(t);
  const id = await working(b, read);
  assert.equal(b.slotDetail(b.board().slots[0].slot.id).tuning.model, 'm1');
  await b.switchModel(id, 'm2');
  await until(() => b.scheduler.latestReport(id)?.kind === 'done', 'the gremlin to finish on the new model', 40000);
  // The second session was switched to m2 when it opened.
  assert.match(read('modes.txt'), /ticket-1 model=m2/);
  assert.match(read('prompts.txt'), /现在接着干/);
  assert.deepEqual(b.scheduler.ticketSupply(id), { model: 'm2', account: null, effort: null });
  // Exactly one report: the first session ended without one, and that is not counted as a failure.
  assert.equal(b.scheduler.messages(id).filter(m => m.kind === 'report').length, 1);
});

test('换推理档位 on a ticket that is not working applies to its next session', async t => {
  const { b, read } = await bench(t);
  const id = await working(b, read);
  await until(() => b.scheduler.latestReport(id)?.kind === 'done', 'the first report', 40000);
  await b.switchEffort(id, 'high');
  assert.equal(b.scheduler.ticketSupply(id).effort, 'high');
  assert.ok(!/effort=high/.test(read('modes.txt')), 'nothing was running, so nothing was switched yet');
  b.tell(id, '再加一行');
  await until(() => /effort=high/.test(read('modes.txt')), 'the next session to open on the high effort', 40000);
  await until(() => b.scheduler.messages(id).filter(m => m.kind === 'report').length === 2, 'the second report', 40000);
});

// Found in the real run of 2026-11-19: the board says "working" while the agent is still opening its session (Codex
// takes ~10 s). A switch in that window must not be lost, and 等一等 must not be refused.
async function opening(b) {
  b.say('加一个 hello.txt');
  await until(() => b.scheduler.tickets().length === 1, 'the lead to open a ticket');
  const id = b.scheduler.tickets()[0].id;
  await until(() => b.dispatcher.isOpening(id), 'the gremlin session to be opening');
  return id;
}

test('换个模型 while its session is still opening: it starts on the new model, with the brief, in one session', async t => {
  const { b, read } = await bench(t, undefined, { FAKE_TOOLS_NEW_DELAY: '2500' });
  const id = await opening(b);
  await b.switchModel(id, 'm2');
  await until(() => b.scheduler.latestReport(id)?.kind === 'done', 'the gremlin to finish', 40000);
  assert.match(read('modes.txt'), /ticket-1 model=m2/);
  const prompts = read('prompts.txt').split('\n').filter(l => l.startsWith('ticket-1'));
  assert.equal(prompts.length, 1, 'one prompt: the brief, no restart');
  assert.doesNotMatch(prompts[0], /现在接着干/);
});

test('等一等 while its session is still opening: it stops right after getting the brief, and goes on later from there', async t => {
  const { b, read } = await bench(t, async agent => ({ agentId: agent, state: 'ok', windows: [], plan: null, note: null, checkedAt: 0 }), { FAKE_TOOLS_NEW_DELAY: '2500' });
  const id = await opening(b);
  await b.waitForQuota(id);
  await until(() => b.scheduler.ticket(id).state === 'WAITING_QUOTA', 'the ticket to wait for quota');
  await b.resumeNow(id);
  await until(() => b.scheduler.latestReport(id)?.kind === 'done', 'the gremlin to finish after going on', 40000);
  assert.match(read('prompts.txt'), /现在接着干/);
});

// ---------- 第 5 步: the boss's rule for running out of quota, applied by itself (fake refusals, no quota used) ----------

const feedHas = (b, re) => b.board().feed.some(f => re.test(f.text));

test('rule "switch": out of quota on m1, it goes on at once on the backup model and effort, and the board says so', async t => {
  const { b, read } = await bench(t, undefined, { FAKE_TOOLS_QUOTA_MODEL: 'm1' }, { onQuota: { do: 'switch', model: 'm2', effort: 'high' } });
  b.say('加一个 hello.txt');
  await until(() => b.scheduler.tickets().length === 1, 'a ticket');
  const id = b.scheduler.tickets()[0].id;
  await until(() => b.scheduler.latestReport(id)?.kind === 'done', 'the gremlin to finish on the backup model', 40000);
  assert.match(read('quota.txt'), /refused on m1/);
  assert.match(read('modes.txt'), /ticket-1 model=m2/);
  assert.match(read('modes.txt'), /ticket-1 effort=high/);
  assert.deepEqual(b.scheduler.ticketSupply(id), { model: 'm2', account: null, effort: 'high' });
  assert.ok(feedHas(b, /按你定的规矩换成 m2（high 档）接着干/), 'the board says what it did');
});

test('rule "wait": out of quota with no time given, it waits until the maker\'s quota page says the window starts over', async t => {
  const back = Date.now() + 2 * 3_600_000;
  const { b } = await bench(t, async agent => ({ agentId: agent, state: 'ok', windows: [{ label: '本周', usedPercent: 100, resetsAt: back }], plan: null, note: null, checkedAt: 0 }),
    { FAKE_TOOLS_QUOTA_MODEL: 'm1' }, { onQuota: { do: 'wait' } });
  b.say('加一个 hello.txt');
  await until(() => b.scheduler.tickets().length === 1, 'a ticket');
  const id = b.scheduler.tickets()[0].id;
  await until(() => b.scheduler.ticket(id).quotaWait?.resetsAt === back, 'the wait to learn the reset time', 40000);
  assert.equal(b.scheduler.ticket(id).state, 'WAITING_QUOTA');
  assert.ok(feedHas(b, /按你定的规矩等额度/));
});

test('rule "switch" when it is already on the backup model: it waits instead of switching in circles', async t => {
  const { b } = await bench(t, undefined, { FAKE_TOOLS_QUOTA_MODEL: 'm1' }, { onQuota: { do: 'switch', model: 'm1' } });
  b.say('加一个 hello.txt');
  await until(() => b.scheduler.tickets().length === 1, 'a ticket');
  const id = b.scheduler.tickets()[0].id;
  await until(() => feedHas(b, /备用的也用完了（最后在用 m1），等额度/), 'the board to say it waits', 40000);
  assert.equal(b.scheduler.ticket(id).state, 'WAITING_QUOTA');
});

test('changing the quota rule does not restart the workbench (work in progress goes on)', async t => {
  const { WorkbenchHost } = load('src/main/v8/host.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-rule-host-'));
  let settings = { slots: 1 };
  const host = new WorkbenchHost({ base: dir, settings: () => settings, enabled: () => true, onChange: () => undefined, demoPace: 1000 });
  t.after(async () => { await host.shutdown(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const first = await host.get();
  settings = { slots: 1, onQuota: { do: 'switch', model: 'x' } };
  assert.equal(await host.get(), first);
  settings = { slots: 2, onQuota: { do: 'switch', model: 'x' } };
  assert.equal(await host.get(), first, 'the slots apply live too (A1)');
  settings = { slots: 2, review: false, onQuota: { do: 'switch', model: 'x' } };
  assert.notEqual(await host.get(), first, 'other settings still switch workbenches');
});
