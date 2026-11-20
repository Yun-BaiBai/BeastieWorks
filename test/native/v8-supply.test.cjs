'use strict';
// v8 S1: the supply layer. Magpie between the harness and the providers, run privately per project; every session
// carries a supply mark so a ticket sticks to one account and its usage is billed to it.
// Unit parts always run. Parts needing the real Magpie program run when AGENTCORP_TEST_MAGPIE_EXE points at it;
// the real-omp part also needs AGENTCORP_TEST_OMP_EXE. Upstream is always a local fake: no account, no model, no cost.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const load = require('../load-ts.cjs');
const { V8Supply, supplySession, ompGatewayAgentDir, MAGPIE_KEY_ENV, MAGPIE_LOCAL_KEY } = load('src/main/v8/supply.ts');
const { OmpShell } = load('src/main/v8/ompShell.ts');
const { isAlive } = load('src/main/procKill.ts');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-omp-rpc.cjs');
const magpie = process.env.AGENTCORP_TEST_MAGPIE_EXE;
const omp = process.env.AGENTCORP_TEST_OMP_EXE;
const TEXT = 'MAGPIE_FIXTURE_OK';

/** Cleanup in reverse order of setup (processes stop before their folders go), and one failure never skips the rest. */
function scope(t) {
  const undo = [];
  t.after(async () => { for (const fn of undo.reverse()) { try { await fn(); } catch { /* keep cleaning */ } } });
  return {
    defer: fn => undo.push(fn),
    tmp: name => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), name)); undo.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })); return dir; },
  };
}

/** A fake model provider speaking OpenAI Responses (streamed and not) and Chat, recording every call it gets. */
async function upstream(t) {
  const calls = [];
  const body = () => ({
    id: 'resp_fixture', object: 'response', created_at: 1000, status: 'completed', model: 'fixture-model',
    output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: TEXT, annotations: [] }] }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  });
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; });
    req.on('end', () => {
      const b = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url, model: b.model ?? null });
      if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model', owned_by: 'fixture' }] })); return; }
      if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end('{}'); return; }
      if (!b.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body())); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const done = body(), msg = done.output[0]; let seq = 0;
      const emit = (type, p) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...p })}\n\n`);
      emit('response.created', { response: { ...done, status: 'in_progress', output: [] } });
      emit('response.output_item.added', { output_index: 0, item: { ...msg, status: 'in_progress', content: [] } });
      emit('response.content_part.added', { item_id: msg.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      emit('response.output_text.delta', { item_id: msg.id, output_index: 0, content_index: 0, delta: TEXT });
      emit('response.output_text.done', { item_id: msg.id, output_index: 0, content_index: 0, text: TEXT });
      emit('response.content_part.done', { item_id: msg.id, output_index: 0, content_index: 0, part: msg.content[0] });
      emit('response.output_item.done', { output_index: 0, item: msg });
      emit('response.completed', { response: done }); res.end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: 'http://127.0.0.1:' + server.address().port, calls };
}

async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
  assert.fail('timed out waiting for ' + what);
}

test('supply marks: one per lead, per review and per assignment; safe and short', () => {
  assert.equal(supplySession('demo', 'lead'), 'demo-lead');
  assert.equal(supplySession('demo', 'worker', 7, 12), 'demo-work-t7-a12');
  assert.equal(supplySession('demo', 'reviewer', 7), 'demo-review-t7');
  assert.equal(supplySession('a b/c:d', 'lead'), 'abcd-lead');
  assert.ok(supplySession('x'.repeat(300), 'worker', 1, 2).length <= 128);
});

test('omp via the gateway: a private agent folder whose only provider is Magpie, carrying the session mark', t => {
  const base = scope(t).tmp('v8-supply-omp-');
  const own = ompGatewayAgentDir(base, 'demo-work-t3-a5', 'http://127.0.0.1:4567/', 'openai/gpt-5.4-mini');
  assert.equal(own.model, 'magpie/openai/gpt-5.4-mini');
  assert.equal(own.dir, path.join(base, 'demo-work-t3-a5'));
  const cfg = JSON.parse(fs.readFileSync(path.join(own.dir, 'models.yml'), 'utf8'));   // YAML reads JSON as is
  assert.deepEqual(Object.keys(cfg.providers), ['magpie']);
  const p = cfg.providers.magpie;
  assert.equal(p.baseUrl, 'http://127.0.0.1:4567/v1');
  assert.equal(p.api, 'openai-responses');
  assert.equal(p.apiKey, MAGPIE_KEY_ENV, 'the key is named, the value comes from the environment');
  assert.deepEqual(p.headers, { 'X-Magpie-Session': 'demo-work-t3-a5' });
  assert.deepEqual(p.models.map(m => m.id), ['openai/gpt-5.4-mini']);
  assert.throws(() => ompGatewayAgentDir(base, 'x', 'http://127.0.0.1:1', '  '), /V8_SUPPLY_MODEL_REQUIRED/);
});

test('the omp shell uses the gateway only when it is up and the session has a mark; otherwise nothing changes', async t => {
  const sc = scope(t), home = sc.tmp('v8-supply-shell-');
  const log = path.join(home, 'omp.log');
  let origin = 'http://127.0.0.1:4567';
  const shell = new OmpShell({
    exe: process.execPath, prefixArgs: [FAKE], agentDir: path.join(home, 'own-agent'), sessionDir: path.join(home, 'sessions'),
    env: { FAKE_OMP_LOG: log, ELECTRON_RUN_AS_NODE: '1' }, gateway: { origin: () => origin, agentBase: path.join(home, 'via') },
  });
  const spec = { role: 'lead', cwd: home, model: 'openai/gpt-5.4-mini', sessionRef: null, systemPrompt: 'x', hostTools: [], builtinTools: false };
  const opened = [];
  sc.defer(async () => { for (const s of opened) await s.close(); });
  opened.push(await shell.open({ ...spec, supplySession: 'demo-lead' }));
  opened.push(await shell.open(spec));                                   // no mark: as before
  origin = null;
  opened.push(await shell.open({ ...spec, supplySession: 'demo-lead' })); // gateway down: as before
  const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.argv);   // the fake also logs every frame it gets
  assert.equal(runs.length, 3);
  const model = r => r.argv[r.argv.indexOf('--model') + 1];
  assert.equal(runs[0].env.agentDir, path.join(home, 'via', 'demo-lead').replace(/\\/g, '/'));
  assert.equal(model(runs[0]), 'magpie/openai/gpt-5.4-mini');
  assert.equal(runs[0].env.magpieKey, MAGPIE_LOCAL_KEY);
  for (const r of runs.slice(1)) {
    assert.equal(r.env.agentDir, path.join(home, 'own-agent').replace(/\\/g, '/'));
    assert.equal(model(r), 'openai/gpt-5.4-mini');
    assert.equal(r.env.magpieKey, null);
  }
});

test('Magpie runs privately under the project and passes a marked request to the provider', { skip: !magpie }, async t => {
  const up = await upstream(t);
  const sc = scope(t), root = sc.tmp('v8-supply-gw-');
  const supply = new V8Supply({ root, settings: { magpieExe: magpie }, fixtureUpstream: up.origin, home: root, config: root });
  sc.defer(() => supply.stop());
  const s = await supply.start();
  let pid = null;
  assert.equal(s.running, true);
  assert.match(s.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(s.signIns.every(x => !x.present && !x.given), 'no sign-ins in a clean home, none given');
  const gwDir = fs.readdirSync(path.join(fs.realpathSync(root), '.agentcorp', 'gateways', 'magpie'));
  assert.equal(gwDir.length, 1, 'its private folder is under the project state');
  const res = await fetch(s.origin + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + MAGPIE_LOCAL_KEY, 'X-Magpie-Session': 'demo-work-t1-a1' },
    body: JSON.stringify({ model: 'fixture-model', input: 'hi' }),
  });
  assert.equal(res.status, 200);
  assert.ok(JSON.stringify(await res.json()).includes(TEXT));
  assert.ok(up.calls.some(c => c.path.endsWith('/responses') && c.model === 'fixture-model'), 'the provider got it');
  const route = await supply.route('demo-work-t1-a1');
  assert.equal(route.available, true, 'Magpie knows the marked session');
  pid = supply['gateway'].status().pid;
  await supply.stop();
  assert.equal(supply.origin(), null);
  if (pid) await until(() => !isAlive(pid), 'Magpie to exit', 10000);
});

test('a real omp session goes through Magpie to the provider and gets the answer back', { skip: !(magpie && omp) }, async t => {
  const up = await upstream(t);
  const sc = scope(t), root = sc.tmp('v8-supply-omp-real-');
  const supply = new V8Supply({ root, settings: { magpieExe: magpie }, fixtureUpstream: up.origin, home: root, config: root });
  sc.defer(() => supply.stop());
  await supply.start();
  const shell = new OmpShell({
    exe: omp, agentDir: path.join(root, 'own-agent'), sessionDir: path.join(root, 'sessions'), readyTimeoutMs: 60000,
    gateway: { origin: () => supply.origin(), agentBase: path.join(root, 'via') },
  });
  const session = await shell.open({ role: 'lead', cwd: root, model: 'fixture-model', sessionRef: null, systemPrompt: 'Answer briefly.', hostTools: [], builtinTools: false, supplySession: 'demo-lead' });
  sc.defer(() => session.close());
  const events = [];
  session.onEvent(e => events.push(e));
  session.prompt('hi');
  await until(() => events.some(e => e.type === 'settled'), 'the turn to end', 60000);
  assert.ok(events.some(e => e.type === 'message' && e.text.includes(TEXT)), JSON.stringify(events).slice(0, 800));
  assert.ok(up.calls.some(c => c.path.endsWith('/responses')), 'the request reached the provider through Magpie');
  assert.equal((await supply.route('demo-lead')).available, true, 'and Magpie filed it under the lead');
});

// ---------- S1.8: the lead and the reviewer straight to the model ----------

const { ModelShell } = load('src/main/v8/modelShell.ts');
const { V8Workbench } = load('src/main/v8/workbench.ts');

/** A fake model: to a fresh user message it answers with a call to reply_to_boss; once it sees the call's output it
 *  answers in text. `status` forces an error code instead. Records headers and inputs. */
async function scripted(t, status = 200) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; });
    req.on('end', () => {
      const b = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url, headers: req.headers, body: b });
      if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model', owned_by: 'fixture' }] })); return; }
      if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end('{}'); return; }
      if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":{"message":"quota exhausted"}}'); return; }
      const input = Array.isArray(b.input) ? b.input : [{ role: 'user', content: String(b.input) }];
      const last = input[input.length - 1] ?? {};
      const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
      const output = last.type === 'function_call_output'
        ? [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK done', annotations: [] }] }]
        : [{ type: 'function_call', id: 'fc_1', call_id: 'call_' + calls.length, name: 'reply_to_boss', arguments: JSON.stringify({ text: '收到' }), status: 'completed' }];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'resp_' + calls.length, object: 'response', created_at: 1000, status: 'completed', model: 'fixture-model', output, usage }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: 'http://127.0.0.1:' + server.address().port, calls };
}

const REPLY_TOOL = { name: 'reply_to_boss', description: '回老板一两句话。', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } };
const leadSpec = (cwd, extra = {}) => ({ role: 'lead', cwd, model: 'fixture-model', sessionRef: null, systemPrompt: '你是总管。', hostTools: [REPLY_TOOL], builtinTools: false, supplySession: 'demo-lead', ...extra });

test('model shell: a tool call goes to the app, its result goes back, the reply ends the turn; marked and resumable', async t => {
  const up = await scripted(t);
  const home = scope(t).tmp('v8-model-');
  const shell = new ModelShell({ origin: () => up.origin, historyDir: path.join(home, 'conversations') });
  const s = await shell.open(leadSpec(home));
  const events = [];
  s.onEvent(e => { events.push(e); if (e.type === 'host_tool') s.respondHostTool(e.id, { ok: true, text: '已发给老板。' }); });
  s.prompt('老板（消息 #1）：你好');
  await until(() => events.some(e => e.type === 'settled'), 'the turn to end', 10000);
  assert.deepEqual(events.map(e => e.type), ['host_tool', 'message', 'settled']);
  assert.deepEqual(events[0].args, { text: '收到' });
  assert.equal(events[1].text, 'OK done');
  assert.equal(events[2].status, 'completed');
  const sent = up.calls.filter(c => c.path.endsWith('/responses'));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].headers['x-magpie-session'], 'demo-lead');
  assert.equal(sent[0].headers.authorization, 'Bearer ' + MAGPIE_LOCAL_KEY);
  assert.deepEqual(sent[0].body.tools.map(x => x.name), ['reply_to_boss'], 'only the app\'s tools');
  assert.equal(sent[0].body.instructions, '你是总管。');
  assert.equal(sent[1].body.input.at(-1).type, 'function_call_output');
  // The conversation is the app's: reopening by ref carries it on.
  const again = await shell.open(leadSpec(home, { sessionRef: s.ref }));
  assert.equal(again.ref, s.ref);
  const saved = JSON.parse(fs.readFileSync(s.ref, 'utf8'));
  assert.equal(saved.input.length, 4, 'user, call, call output, reply');
  await s.close(); await again.close();
});

test('model shell: a refusal from the gateway ends the turn with its status; it will not open without a gateway or with tools', async t => {
  const up = await scripted(t, 429);
  const home = scope(t).tmp('v8-model-err-');
  const shell = new ModelShell({ origin: () => up.origin, historyDir: path.join(home, 'c') });
  const s = await shell.open(leadSpec(home));
  const events = [];
  s.onEvent(e => events.push(e));
  s.prompt('你好');
  await until(() => events.some(e => e.type === 'settled'), 'the turn to end', 10000);
  assert.equal(events.at(-1).status, 'error');
  assert.match(events.at(-1).detail, /^HTTP 429/);
  await assert.rejects(new ModelShell({ origin: () => null, historyDir: home }).open(leadSpec(home)), /V8_SUPPLY_NOT_RUNNING/);
  await assert.rejects(shell.open(leadSpec(home, { builtinTools: true })), /V8_MODEL_SHELL_HAS_NO_BUILTIN_TOOLS/);
  await s.close();
});

test('the workbench with a gateway: the lead talks to the model through Magpie and answers the boss', { skip: !magpie }, async t => {
  const up = await scripted(t);
  const sc = scope(t), dir = sc.tmp('v8-model-bench-');
  const b = new V8Workbench({ stateDir: dir, settings: { shell: 'omp', model: 'fixture-model', review: false, supply: { magpieExe: magpie }, omp: { exe: 'omp-not-used' } }, supplyFixture: up.origin });
  sc.defer(() => b.shutdown());
  await b.start();
  assert.equal(b.supplyStatus().running, true);
  b.say('你好');
  await until(() => b.board().talk.some(l => l.author === 'lead' && l.text === '收到'), 'the lead to answer through Magpie', 30000);
  const sent = up.calls.filter(c => c.path.endsWith('/responses'));
  assert.ok(sent.length >= 2, 'the call and the follow-up went through Magpie to the provider');
  assert.match(b.board().harness.label, /经 Magpie/);
});
