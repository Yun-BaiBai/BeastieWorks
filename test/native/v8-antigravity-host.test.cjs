'use strict';
// A14 (老板 2026-11-21): Antigravity uses the computer's own `agy acp` (Orca's way) when agy is there, new enough and
// signed in (the editor's sign-in is the same one); otherwise the separate ACP server with its own sign-in stays.
// The handshake and the credential lookup are stood in for: nothing starts, nothing is read from the credential.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { hostAgy, agyCompatible, findAgy } = load('src/main/v8/antigravityHost.ts');
const { QUIRKS } = load('src/main/v8/acpQuirks.ts');

const GOOD = { protocolVersion: 1, agentName: 'Antigravity', agentVersion: '1.5.3', canLoadSession: true, authMethods: [], infoName: 'Antigravity ACP Server', canResume: true, canList: true };

function computer(t, { agy = true, settings = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const bin = path.join(dir, 'home', '.local', 'bin'); fs.mkdirSync(bin, { recursive: true });
  if (agy) fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'agy.exe' : 'agy'), 'x');
  if (settings) { const d = path.join(dir, 'home', '.gemini', 'antigravity-cli'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify(settings)); }
  return { USERPROFILE: path.join(dir, 'home'), HOME: path.join(dir, 'home'), PATH: path.join(dir, 'nothing') };
}

test('agy acp is used when agy is here, answers as a new enough Antigravity server, and holds a sign-in', async t => {
  const env = computer(t);
  const asked = [];
  const r = await hostAgy(env, { probe: async o => { asked.push(o); return GOOD; }, listCredential: async () => true });
  assert.ok(r, 'adopted');
  assert.deepEqual(r.launch.args, ['acp']);
  assert.equal(r.launch.command, findAgy(env));
  assert.equal(r.launch.env.GEMINI_API_KEY, '', 'an inherited Gemini key would switch it to key sign-in');
  assert.match(r.note, /和编辑器同一个/);
  assert.deepEqual(asked[0].args, ['acp'], 'only a handshake: no session, no message');
});

test('the separate server stays: no agy, no sign-in, too old, not Antigravity, or an API key', async t => {
  const yes = { probe: async () => GOOD, listCredential: async () => true };
  assert.equal(await hostAgy(computer(t, { agy: false }), yes), null, 'no agy (only the editor)');
  assert.equal(await hostAgy(computer(t), { ...yes, listCredential: async () => false }), null, 'not signed in');
  assert.equal(await hostAgy(computer(t), { ...yes, probe: async () => ({ ...GOOD, agentVersion: '1.5.1' }) }), null, 'older than 1.5.2');
  assert.equal(await hostAgy(computer(t), { ...yes, probe: async () => { throw new Error('exit 1'); } }), null, 'did not answer');
  assert.equal(await hostAgy(computer(t, { settings: { modelProvider: 'gemini-api-key' } }), yes), null, 'an API-key setup');
  assert.equal(agyCompatible({ ...GOOD, infoName: 'Something Else' }), false);
  assert.equal(agyCompatible({ ...GOOD, canList: false }), false);
});

test('the roster asks Antigravity for the computer\'s own agy; the separate server keeps its own sign-in', () => {
  assert.equal(typeof QUIRKS['antigravity-acp'].adopt, 'function');
  assert.equal(QUIRKS['antigravity-acp'].signInFlow, true);
  assert.match(QUIRKS['antigravity-acp'].signInHelp, /agy/);
});
