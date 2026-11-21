'use strict';
// A1 (老板 2026-11-20): the slots and the spending cap apply while work goes on; a ticket that reaches the cap stops
// and waits for the boss, and "再试一次" lets it spend the same again. A stand-in agent reports what it spends; no
// model. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { V8Workbench, MAX_SLOTS } = load('src/main/v8/workbench.ts');

const AGENT = path.join(__dirname, '..', 'fixtures', 'fake-acp-tools-agent.cjs');
async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('timed out waiting for ' + what);
}

function bench(t, env, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-live-'));
  const log = path.join(dir, 'log'); fs.mkdirSync(log);
  const node = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const acpLaunch = async agent => ({ label: 'Fake ' + agent, command: process.execPath, args: [AGENT], env: { ELECTRON_RUN_AS_NODE: '1', FAKE_TOOLS_LOG: log, ...env }, node });
  const s = { shell: 'acp', review: false, slots: 1, emergencySlot: false, acp: { lead: { agent: 'lead-agent' }, worker: { agent: 'worker-agent' } }, ...settings };
  const b = new V8Workbench({ stateDir: path.join(dir, 'state'), settings: s, acpLaunch });
  t.after(async () => { await b.shutdown().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  return { b, s, read: n => { try { return fs.readFileSync(path.join(log, n), 'utf8'); } catch { return ''; } } };
}

test('more gremlins at once, applied while one is working, without stopping it', async t => {
  const { b, s, read } = bench(t, { FAKE_TOOLS_DELAY: '1500' }, {});
  await b.start();
  assert.equal(b.scheduler.slots().length, 1);
  b.say('加一个 a.txt');
  await until(() => /start ticket-1/.test(read('working.txt')), 'the first gremlin to start');
  await b.applyLive({ ...s, slots: 3, emergencySlot: true });
  assert.equal(b.scheduler.slots().length, 4, 'three slots and the emergency one');
  await until(() => b.scheduler.latestReport(b.scheduler.tickets()[0].id)?.kind === 'done', 'the first gremlin to finish undisturbed');
  assert.ok(MAX_SLOTS >= 8);
});

test('a ticket that reaches the spending cap stops; trying again lets it spend the same again', async t => {
  const { b, read } = bench(t, { FAKE_TOOLS_COST: '0.3', FAKE_TOOLS_DELAY: '2000' }, { maxCostUsd: 0.2 });
  await b.start();
  b.say('加一个 b.txt');
  await until(() => b.scheduler.tickets().length === 1, 'a ticket');
  const id = b.scheduler.tickets()[0].id;
  await until(() => b.board().feed.some(f => /花到上限/.test(f.text)), 'the cap to be reached', 20000);
  await until(() => b.scheduler.state(id) === 'BLOCKED', 'the ticket to stop as stuck');
  assert.equal(b.scheduler.state(id), 'BLOCKED', 'it waits for the boss as stuck');
  assert.match(b.scheduler.latestReport(id).where, /花到上限/);
  await b.retry(id, { fresh: true });
  await until(() => b.scheduler.latestReport(id)?.kind === 'done', 'the ticket to finish on its second allowance', 30000);
  assert.equal((read('working.txt').match(/start ticket-1/g) ?? []).length, 2);
});
