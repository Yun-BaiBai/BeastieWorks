'use strict';
// A12 拆解工单 (老板 2026-11-20). A gremlin on the worker's agent reads the project (never writes) and proposes pieces;
// nothing starts until the boss decides; split, every piece is a ticket with his own words whole and its own part
// named; whole, one ticket. Stand-in ACP agents (test/fixtures/fake-acp-tools-agent.cjs).
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { V8Workbench } = load('src/main/v8/workbench.ts');
const { acceptSplit } = load('src/main/v8/splits.ts');

const AGENT = path.join(__dirname, '..', 'fixtures', 'fake-acp-tools-agent.cjs');
async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('timed out waiting for ' + what);
}

function bench(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-split-'));
  const log = path.join(dir, 'log'); fs.mkdirSync(log);
  const node = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const acpLaunch = async agent => ({ label: 'Fake ' + agent, command: process.execPath, args: [AGENT], env: { ELECTRON_RUN_AS_NODE: '1', FAKE_TOOLS_LOG: log, FAKE_TOOLS_NAME: agent, ...env }, node });
  const settings = { shell: 'acp', review: false, slots: 2, emergencySlot: false, acp: { lead: { agent: 'lead-agent' }, worker: { agent: 'worker-agent' } } };
  const b = new V8Workbench({ stateDir: path.join(dir, 'state'), settings, acpLaunch, notesOn: () => false });
  t.after(async () => { await b.shutdown().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  return { b, read: n => { try { return fs.readFileSync(path.join(log, n), 'utf8'); } catch { return ''; } } };
}

const WORDS = '登录页和注册页的报错都改清楚，能拆就拆开一起做';

test('a split: the worker\'s agent proposes pieces, reading only; nothing starts until the boss approves; then each piece is a ticket', async t => {
  const { b, read } = bench(t);
  await b.start();
  b.say(WORDS);
  await until(() => b.board().splits[0]?.state === 'choosing', 'the pieces');
  const s = b.board().splits[0];
  assert.equal(s.canSplit, true);
  assert.deepEqual(s.pieces.map(p => p.title), ['登录页', '注册页']);
  assert.equal(s.by, 'worker-agent', 'worked out on the worker\'s agent');
  assert.match(read('split.txt'), /^worker-agent write=n .*登录页和注册页的报错都改清楚/, 'it saw the boss\'s words and could not write');
  assert.equal(b.scheduler.tickets().length, 0, 'nothing starts before the boss decides');
  await until(() => b.board().talk.some(l => /看看能不能拆开同时做/.test(l.text)), 'the boss hearing about it');
  const ids = await b.decideSplit(s.id, 'split');
  assert.equal(ids.length, 2);
  for (const [i, id] of ids.entries()) {
    assert.equal(b.scheduler.ticket(id).originalRequest, WORDS, 'every piece gets the boss\'s words, whole');
    const told = b.scheduler.messages(id).map(m => String(m.body)).join('\n');
    assert.match(told, new RegExp('你只做第 ' + (i + 1) + ' 件'));
    assert.match(told, i === 0 ? /不要碰它们的部分：注册页/ : /不要碰它们的部分：登录页/);
  }
  assert.equal(b.board().splits.length, 0, 'a decided split leaves the talk bar');
  await assert.rejects(() => b.decideSplit(s.id, 'whole'), /V8_NOTHING_TO_DECIDE/);
  await until(() => ids.every(id => b.scheduler.latestReport(id)?.kind === 'done'), 'both pieces done');
});

test('when it can\'t be split the boss is told why, and doing it whole opens one ordinary ticket', async t => {
  const { b } = bench(t, { FAKE_TOOLS_SPLIT: 'no' });
  await b.start();
  b.say(WORDS);
  await until(() => b.board().splits[0]?.state === 'choosing', 'the answer');
  const s = b.board().splits[0];
  assert.equal(s.canSplit, false);
  assert.match(s.why, /共用一个样式文件/);
  await assert.rejects(() => b.decideSplit(s.id, 'split'), /V8_CANNOT_SPLIT/);
  const ids = await b.decideSplit(s.id, 'whole');
  assert.equal(ids.length, 1);
  assert.equal(b.scheduler.ticket(ids[0]).originalRequest, WORDS);
});

test('the check on a split: pieces only when it comes apart, two to six of them', () => {
  assert.deepEqual(acceptSplit({ can_split: false, why: '有先后' }).pieces, []);
  assert.throws(() => acceptSplit({ can_split: true, why: 'x', pieces: [{ title: 'a', what: 'b' }] }), /2 到 6/);
  assert.throws(() => acceptSplit({ why: 'x' }), /can_split/);
  assert.equal(acceptSplit({ can_split: true, why: 'x', pieces: [{ title: 'a', what: 'b' }, { title: 'c', what: 'd' }] }).pieces.length, 2);
});
