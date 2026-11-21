'use strict';
// The lead carries on its conversation after a restart (C3 review, finding 8, the lead's half; boss 2026-11-21: "主理小怪
// 重启接不上之前的对话，那这就是个问题啊"). Done OpenMausBot's way (server/drivers/acp/core.ts): the session is kept
// and loaded again; when the agent no longer has it, a new one starts and is given the recent talk word for word.
// No model. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3'), load = require('../load-ts.cjs');
const { Scheduler } = load('src/main/v8/scheduler.ts');
const { Dispatcher } = load('src/main/v8/dispatcher.ts');
const { Lead } = load('src/main/v8/lead.ts');
const { FakeShell } = load('src/main/v8/fakeShell.ts');
const { AcpShell } = load('src/main/v8/acpShell.ts');
const { V8Workbench } = load('src/main/v8/workbench.ts');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-acp-agent.cjs');
const fake = env => ({ label: 'Fake Agent', command: process.execPath, args: [FAKE], env: { ELECTRON_RUN_AS_NODE: '1', ...(env ?? {}) } });

async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 15)); }
  assert.fail('timed out waiting for ' + what);
}

function rig(t, openAs) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const s = new Scheduler(db, {});
  const inner = new FakeShell(() => ({ async onPrompt(c) { c.settle(); } }));
  // openAs: what the agent does with a kept session ('keeps' it, or it is 'gone' and a new one starts).
  const shell = { open: spec => inner.open(openAs === 'gone' ? { ...spec, sessionRef: null } : spec) };
  const d = new Dispatcher(s, inner, { workdir: id => 'D:/work/ticket-' + id });
  t.after(() => d.shutdown());
  return { s, d, inner, shell };
}

test('a lead whose session is carried on goes on as it was: no catching up', async t => {
  const r = rig(t, 'keeps');
  const saved = [];
  const lead = new Lead(r.s, r.d, r.shell, { cwd: 'D:/lead', model: null, sessionRef: 'lead-1', history: () => [{ author: 'boss', text: '旧话' }], onSession: ref => saved.push(ref) });
  await lead.start();
  t.after(() => lead.stop());
  assert.equal(lead.catchingUp, false);
  assert.deepEqual(saved, ['lead-1']);
  lead.bossSays('接着来');
  await until(() => r.inner.sessions[0].heard.length === 1, 'the prompt');
  assert.doesNotMatch(r.inner.sessions[0].heard[0].text, /重启前/);
});

test('a lead whose session is gone starts new and is given the recent talk, word for word, once', async t => {
  const r = rig(t, 'gone');
  const saved = [];
  const past = [{ author: 'boss', text: '把首页标题改成"小怪工坊"' }, { author: 'lead', text: '好，开了工单 #3' }];
  const lead = new Lead(r.s, r.d, r.shell, { cwd: 'D:/lead', model: null, sessionRef: 'lead-old', history: () => past, onSession: ref => saved.push(ref) });
  await lead.start();
  t.after(() => lead.stop());
  assert.equal(lead.catchingUp, true);
  assert.notEqual(saved[0], 'lead-old', 'the new session is what is kept from now on');
  lead.bossSays('标题改好了吗');
  const s = r.inner.sessions[0];
  await until(() => s.heard.length === 1, 'the first prompt');
  const first = s.heard[0].text;
  for (const part of ['重启前', '老板：把首页标题改成"小怪工坊"', '你：好，开了工单 #3', '标题改好了吗']) assert.ok(first.includes(part), part);
  assert.ok(first.indexOf('重启前') < first.indexOf('标题改好了吗'), 'the old talk comes first');
  assert.equal(lead.catchingUp, false, 'given once');
});

test('the ACP shell loads a kept session and drops what the agent replays; a session the agent lost becomes a new one', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-resume-'));
  const open = [];
  t.after(async () => { for (const s of open) await s.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const spec = ref => ({ role: 'lead', cwd: dir, model: null, sessionRef: ref, systemPrompt: '', hostTools: [], builtinTools: false });
  const talk = async (session, text) => new Promise(resolve => {
    const said = [];
    const off = session.onEvent(e => { if (e.type === 'message') said.push(e.text); if (e.type === 'settled') { off(); resolve(said.join('')); } });
    session.prompt(text);
  });

  const kept = await new AcpShell(fake()).open(spec('s-old'));
  open.push(kept);
  assert.equal(kept.ref, 's-old', 'carried on');
  assert.equal(await talk(kept, 'ping'), 'pong', 'the replayed old answer is not taken for a new one');

  const lost = await new AcpShell(fake({ FAKE_ACP_LOAD: 'gone' })).open(spec('s-old'));
  open.push(lost);
  assert.equal(lost.ref, 's1', 'a new session instead of a failure');
  assert.equal(await talk(lost, 'ping'), 'pong');
});

test('workbench: the lead\'s session is kept, and the next start carries it on', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-lead-resume-'));
  let again = null;
  t.after(async () => { await again?.shutdown(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const first = new V8Workbench({ stateDir: dir, settings: {}, demoPace: 0.02 });
  await first.start();
  const ref = first.lead.ref;
  assert.ok(ref);
  await first.shutdown();
  again = new V8Workbench({ stateDir: dir, settings: {}, demoPace: 0.02 });
  await again.start();
  assert.equal(again.lead.ref, ref, 'the same conversation');
  assert.equal(again.lead.catchingUp, false);
});
