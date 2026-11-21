'use strict';
// A6 圆桌会议 and A11 巡查 (老板 2026-11-20). Stand-in ACP agents (test/fixtures/fake-acp-tools-agent.cjs), no model.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { V8Workbench } = load('src/main/v8/workbench.ts');
const { overload, overloadWords, PATROL_DEFAULTS } = load('src/main/v8/patrol.ts');
const { readOnlyPolicy } = load('src/main/v8/approval.ts');

const AGENT = path.join(__dirname, '..', 'fixtures', 'fake-acp-tools-agent.cjs');
async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('timed out waiting for ' + what);
}

function bench(t, env, settings, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-rt-'));
  const log = path.join(dir, 'log'); fs.mkdirSync(log);
  const node = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const acpLaunch = async agent => ({ label: 'Fake ' + agent, command: process.execPath, args: [AGENT], env: { ELECTRON_RUN_AS_NODE: '1', FAKE_TOOLS_LOG: log, FAKE_TOOLS_NAME: agent, ...env }, node });
  const s = { shell: 'acp', review: false, slots: 1, emergencySlot: false, acp: { lead: { agent: 'lead-agent' }, worker: { agent: 'worker-agent' }, reviewer: { agent: 'review-agent' } }, ...settings };
  const b = new V8Workbench({ stateDir: path.join(dir, 'state'), settings: s, acpLaunch, ...extra });
  t.after(async () => { await b.shutdown().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  return { b, read: n => { try { return fs.readFileSync(path.join(log, n), 'utf8'); } catch { return ''; } } };
}

test('roundtable: each agent proposes on its own, reading only; the lead sorts them into Plan A / B; the pick opens a ticket that does it', async t => {
  const { b, read } = bench(t, {}, {});
  await b.start();
  b.say('登录页老出错，帮我出方案，先别动手');
  await until(() => b.board().roundtables.length === 1, 'a roundtable');
  assert.equal(b.scheduler.tickets().length, 0, 'no ticket yet: proposing is not doing');
  await until(() => b.board().roundtables[0]?.state === 'choosing', 'Plan A / B for the boss');
  // Three different agents, each once, none seeing another's proposal.
  const proposals = read('proposals.txt').trim().split('\n');
  assert.deepEqual(proposals.map(l => l.split(' ')[0]).sort(), ['lead-agent', 'review-agent', 'worker-agent']);
  assert.ok(proposals.every(l => /write=n read=y/.test(l)), 'they may read, never write: ' + proposals.join(' | '));
  assert.ok(proposals.every(l => !/方案 by/.test(l)), 'a proposer never sees another proposal');
  assert.match(read('merge.txt'), /方案 by worker-agent.*方案 by review-agent|方案 by review-agent.*方案 by worker-agent/, 'the lead gets them all');
  const rt = b.board().roundtables[0];
  assert.equal(rt.plans.a.title, '小改');
  assert.equal(rt.plans.recommended, 'A');
  assert.ok(b.board().talk.some(l => /开了圆桌/.test(l.text)), 'the boss hears a roundtable was opened');
  // The boss picks B: a ticket from his own words, told which plan.
  const id = await b.pickPlan(rt.id, 'B');
  const ticket = b.scheduler.ticket(id);
  assert.equal(ticket.originalRequest, '登录页老出错，帮我出方案，先别动手');
  assert.ok(b.scheduler.messages(id).some(m => /Plan B：大改/.test(String(m.body))), 'the gremlin hears the plan the boss chose');
  assert.equal(b.board().roundtables.length, 0, 'a picked roundtable leaves the talk bar');
  await assert.rejects(() => b.pickPlan(rt.id, 'A'), /V8_NOTHING_TO_PICK/, 'one pick per roundtable');
});

test('roundtable needs two makers at least', async t => {
  const { b } = bench(t, {}, { acp: { lead: { agent: 'same' }, worker: { agent: 'same' } } });
  await b.start();
  const id = b.scheduler.bossSaid('出方案');
  assert.throws(() => b.roundtable.open(id), /V8_ROUNDTABLE_NEEDS_TWO_AGENTS/);
});

test('read-only rule for proposers: reading in the folder yes; writing, running, or looking outside no', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-ro-'));
  const ok = readOnlyPolicy(dir);
  assert.equal(ok('read', 'Read\nPath: src/a.ts'), true);
  assert.equal(ok('bash', 'x\nCommand: git log --oneline'), true);
  assert.equal(ok('bash', 'x\nCommand: grep -rn login src | head -20'), true);
  assert.equal(ok('edit', 'x\nPath: src/a.ts'), false);
  assert.equal(ok('bash', 'x\nCommand: npm test'), false, 'tests may write files');
  assert.equal(ok('bash', 'x\nCommand: echo hi > a.txt'), false);
  assert.equal(ok('read', 'Read\nPath: C:/Users/x/secret.txt'), false);
  assert.equal(ok('fetch', 'x'), false);
});

test('压垮: far more time or money than finished work usually takes, and only with enough to compare', () => {
  const done = [{ elapsedMs: 5 * 60_000, costUsd: 0.1 }, { elapsedMs: 6 * 60_000, costUsd: 0.12 }, { elapsedMs: 4 * 60_000, costUsd: 0.08 }];
  assert.equal(overload({ elapsedMs: 40 * 60_000, costUsd: 0.1 }, done.slice(0, 2)), null, 'two finished tickets are too few');
  const o = overload({ elapsedMs: 40 * 60_000, costUsd: 0.1 }, done);
  assert.equal(o.what, 'time');
  assert.match(overloadWords(o), /干了 40 分钟，同类的活一般 5 分钟/);
  assert.equal(overload({ elapsedMs: 8 * 60_000, costUsd: 0.1 }, done), null, 'a little over is not overloaded');
  assert.equal(overload({ elapsedMs: 6 * 60_000, costUsd: 0.5 }, done).what, 'money');
  assert.equal(overload({ elapsedMs: 6 * 60_000, costUsd: 0.04 }, [{ elapsedMs: 1, costUsd: 0.001 }, { elapsedMs: 1, costUsd: 0.001 }, { elapsedMs: 1, costUsd: 0.001 }], { ...PATROL_DEFAULTS, overloadMinMs: 1e9 }), null, 'not for pennies');
});

test('跑偏: the lead\'s agent glances at work that has run a while; drift is told to the boss once, and the work goes on', async t => {
  const { b, read } = bench(t, { FAKE_TOOLS_DELAY: '4000', FAKE_TOOLS_DRIFT: '1' }, {}, { patrol: { glanceAfterMs: 0, glanceEveryMs: 0, everyMs: 3_600_000 } });
  await b.start();
  b.say('把登录页的报错改清楚');
  await until(() => /start ticket-1/.test(read('working.txt')), 'the gremlin at work');
  const said = await b.patrol();
  assert.equal(said.length, 1);
  assert.match(said[0], /可能跑偏了——在改无关的配色文件/);
  assert.match(read('patrol.txt'), /把登录页的报错改清楚/, 'the glance sees the boss\'s words');
  assert.ok(b.board().talk.some(l => /巡查：.*跑偏/.test(l.text)), 'the boss hears it in the talk bar');
  assert.deepEqual(await b.patrol(), [], 'once per ticket');
  const id = b.scheduler.tickets()[0].id;
  assert.equal(b.scheduler.state(id), 'WORKING', 'nothing is stopped');
  await until(() => b.scheduler.latestReport(id)?.kind === 'done', 'the work to finish anyway');
});

test('跑偏: work on track says nothing; short work is not glanced at', async t => {
  const { b, read } = bench(t, { FAKE_TOOLS_DELAY: '3000' }, {}, { patrol: { glanceAfterMs: 0, glanceEveryMs: 0, everyMs: 3_600_000 } });
  await b.start();
  b.say('把登录页的报错改清楚');
  await until(() => /start ticket-1/.test(read('working.txt')), 'the gremlin at work');
  assert.deepEqual(await b.patrol(), []);
  assert.match(read('patrol.txt'), /登录页/);
});
