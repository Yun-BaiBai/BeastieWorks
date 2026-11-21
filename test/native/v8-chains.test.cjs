'use strict';
// A15 工序链 (老板 2026-11-20). The lead opens a chain of stages; each stage is an ordinary ticket; the next one opens
// only when the boss presses "开下一道" after the stage before was accepted, and gets the boss's own words whole plus the
// files the previous stage put into the project. Stand-in ACP agents (test/fixtures/fake-acp-tools-agent.cjs).
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { V8Workbench } = load('src/main/v8/workbench.ts');

const AGENT = path.join(__dirname, '..', 'fixtures', 'fake-acp-tools-agent.cjs');
async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('timed out waiting for ' + what);
}

function bench(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-chain-'));
  const log = path.join(dir, 'log'); fs.mkdirSync(log);
  const node = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const acpLaunch = async agent => ({ label: 'Fake ' + agent, command: process.execPath, args: [AGENT], env: { ELECTRON_RUN_AS_NODE: '1', FAKE_TOOLS_LOG: log, FAKE_TOOLS_NAME: agent }, node });
  const settings = { shell: 'acp', review: false, slots: 1, emergencySlot: false, notes: false, acp: { lead: { agent: 'lead-agent' }, worker: { agent: 'worker-agent' } } };
  const b = new V8Workbench({ stateDir: path.join(dir, 'state'), settings, acpLaunch, notesOn: () => false });
  t.after(async () => { await b.shutdown().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  return { b, read: n => { try { return fs.readFileSync(path.join(log, n), 'utf8'); } catch { return ''; } } };
}

const WORDS = '做一个宣传片，分两道工序：先剪辑，再配音';

test('a chain: stage one starts at once; stage two waits for the boss, then gets his words and the files stage one delivered', async t => {
  const { b, read } = bench(t);
  await b.start();
  b.say(WORDS);
  await until(() => b.board().chains.length === 1, 'a chain');
  let c = b.board().chains[0];
  assert.deepEqual(c.stages.map(s => s.title), ['剪辑', '配音']);
  assert.ok(c.stages[0].ticketId && c.stages[1].ticketId === null, 'only the first stage has a ticket');
  assert.equal(b.scheduler.tickets().length, 1);
  await until(() => b.board().talk.some(l => /开了工序链，分 2 道：剪辑 → 配音/.test(l.text)), 'the boss hearing the chain was opened');
  const first = c.stages[0].ticketId;
  assert.equal(b.scheduler.ticket(first).originalRequest, WORDS, 'the boss\'s words, whole');
  assert.ok(b.scheduler.messages(first).some(m => /第 1\/2 道：剪辑。只做这一道：剪出粗剪版/.test(String(m.body))), 'the gremlin hears which stage');
  await until(() => b.scheduler.latestReport(first)?.kind === 'done', 'stage one done');
  assert.equal(b.board().chains[0].next, null, 'not before the boss accepts it');
  await assert.rejects(() => b.nextStage(c.id), /V8_CHAIN_NOT_READY/);
  const { applied } = b.accept(first);
  assert.ok(applied.length, 'stage one put files into the project');
  c = b.board().chains[0];
  assert.equal(c.next, 1, 'now the boss may start stage two');
  const second = await b.nextStage(c.id);
  assert.equal(b.scheduler.ticket(second).originalRequest, WORDS, 'stage two gets the boss\'s words, whole, not a summary');
  const told = b.scheduler.messages(second).map(m => String(m.body)).join('\n');
  assert.match(told, /第 2\/2 道：配音/);
  assert.match(told, new RegExp('上一道「剪辑」已经收下，它的成品在项目里：' + applied[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await until(() => b.scheduler.latestReport(second)?.kind === 'done', 'stage two done');
  b.accept(second);
  assert.equal(b.board().chains.length, 0, 'a finished chain leaves the talk bar');
  assert.match(read('chain.txt'), /工序链 #\d+ 开了/, 'the lead was told the chain is open');
});

test('the lead\'s open_chain checks what it is given', async t => {
  const { b } = bench(t);
  await b.start();
  const id = b.scheduler.bossSaid('分三道工序');
  await assert.rejects(() => b.chains.open({ message_id: id, stages: [{ title: '只有一道', what: 'x' }] }), /V8_CHAIN_STAGES/);
  await assert.rejects(() => b.chains.open({ message_id: 999, stages: [{ title: 'a', what: 'x' }, { title: 'b', what: 'y' }] }), /V8_NEEDS_BOSS_MESSAGE/);
  await b.chains.open({ message_id: id, stages: [{ title: 'a', what: 'x' }, { title: 'b', what: 'y' }] });
  await assert.rejects(() => b.chains.open({ message_id: id, stages: [{ title: 'a', what: 'x' }, { title: 'b', what: 'y' }] }), /V8_CHAIN_EXISTS/);
});
