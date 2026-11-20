'use strict';
// Requirement 8: a gremlin can switch to another maker's model through the Magpie that ships with the app. Each agent
// is pointed at Magpie the way Magpie itself wires it; a session on `magpie:<id>` starts with that wiring.
// No Magpie and no model here: the wiring is checked as data, and the stand-in agent reports what it was started with.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { QUIRKS } = load('src/main/v8/acpQuirks.ts');
const { viaMagpie, magpieExe, MAGPIE_KEY } = load('src/main/v8/magpieService.ts');
const { V8Workbench } = load('src/main/v8/workbench.ts');

const AGENT = path.join(__dirname, '..', 'fixtures', 'fake-acp-tools-agent.cjs');

async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('timed out waiting for ' + what);
}

test('a Magpie model is written magpie:<provider/model>; the program is found shipped or named', t => {
  assert.equal(viaMagpie('magpie:claude/claude-haiku-5-5'), 'claude/claude-haiku-5-5');
  assert.equal(viaMagpie('gpt-5.6-luna'), null);
  assert.equal(viaMagpie(null), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-mp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(magpieExe(dir, {}), null);
  fs.mkdirSync(path.join(dir, 'magpie'));
  fs.writeFileSync(path.join(dir, 'magpie', 'magpie-v0.1.1336.exe'), '');
  assert.equal(magpieExe(dir, {}), path.join(dir, 'magpie', 'magpie-v0.1.1336.exe'));
});

test('Claude on Magpie: its address, the app\'s key, and the same model for every tier (Magpie\'s claude.go)', () => {
  const env = QUIRKS['claude-acp'].magpie('http://127.0.0.1:5000', 'codex/gpt-5.6-luna', {}, process.env);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:5000');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, MAGPIE_KEY);
  for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(env[k], 'codex/gpt-5.6-luna', k);
});

test('Codex on Magpie, not signed in to ChatGPT: Magpie becomes its provider (Magpie\'s codex.go); earlier settings kept', async () => {
  // (Signed in, only openai_base_url moves; that branch needs the real Codex and is checked in the real run.)
  const person = { ...process.env, CODEX_PATH: '', PATH: '', Path: '', USERPROFILE: os.tmpdir(), HOME: os.tmpdir() };
  const before = JSON.stringify({ 'features.memories': false });
  const out = await QUIRKS['codex-acp'].magpie('http://127.0.0.1:5000', 'claude/claude-haiku-5-5', { CODEX_CONFIG: before }, person, 'low');
  const c = JSON.parse(out.CODEX_CONFIG);
  assert.equal(c['features.memories'], false, 'earlier settings kept');
  assert.equal(c.model, 'claude/claude-haiku-5-5');
  assert.equal(c.model_provider, 'magpie');
  assert.equal(c['model_providers.magpie'].base_url, 'http://127.0.0.1:5000/v1');
  assert.equal(c['model_providers.magpie'].wire_api, 'responses');
  assert.equal(c['model_providers.magpie'].experimental_bearer_token, MAGPIE_KEY);
  assert.equal(c.model_reasoning_effort, 'low', 'the effort goes with the model: Codex offers none for a model it does not know');
});

test('switching a working gremlin to another maker\'s model: the next session starts wired to Magpie, the agent\'s own list untouched', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-mpw-'));
  const log = path.join(dir, 'log'); fs.mkdirSync(log);
  const node = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const wired = [];
  const acpLaunch = async agent => ({
    label: 'Fake ' + agent, command: process.execPath, args: [AGENT], env: { ELECTRON_RUN_AS_NODE: '1', FAKE_TOOLS_LOG: log, FAKE_TOOLS_DELAY: '3000' }, node,
    magpie: { origin: async () => 'http://127.0.0.1:5999', wire: (origin, model, _env, effort) => { wired.push([origin, model, effort]); return { LIGHT_MARK: 'magpie:' + model }; } },
  });
  const settings = { shell: 'acp', review: false, slots: 1, emergencySlot: false, acp: { lead: { agent: 'lead-agent' }, worker: { agent: 'worker-agent', model: 'm1', effort: 'high' } } };
  const b = new V8Workbench({ stateDir: path.join(dir, 'state'), settings, acpLaunch });
  t.after(async () => { await b.shutdown().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  await b.start();
  const read = n => { try { return fs.readFileSync(path.join(log, n), 'utf8'); } catch { return ''; } };
  b.say('加一个 hello.txt');
  await until(() => b.scheduler.tickets().length === 1, 'a ticket');
  const id = b.scheduler.tickets()[0].id;
  await until(() => /start ticket-1/.test(read('working.txt')), 'the gremlin to start');
  await b.switchModel(id, 'magpie:claude/claude-haiku-5-5');
  await until(() => b.scheduler.latestReport(id)?.kind === 'done', 'the gremlin to finish on the Magpie model', 40000);
  // The role's effort goes with the wiring (Codex offers no effort choice for a model it does not know).
  assert.deepEqual(wired, [['http://127.0.0.1:5999', 'claude/claude-haiku-5-5', 'high']]);
  assert.match(read('light.txt'), /ticket-1 env=magpie:claude\/claude-haiku-5-5/);
  assert.doesNotMatch(read('modes.txt'), /model=magpie:/, 'a Magpie model is not picked from the agent\'s own list');
});
