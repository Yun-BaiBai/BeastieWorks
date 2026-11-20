'use strict';
// Requirement 13: the common agents of the official list carry the names people use and a sign-in check ported from
// OpenMausBot. Each check is tried against a made-up home folder, signed out and signed in; nothing real is read.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { QUIRKS, agentName } = load('src/main/v8/acpQuirks.ts');

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-ma-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { USERPROFILE: dir, HOME: dir, APPDATA: path.join(dir, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(dir, 'AppData', 'Local') };
  const put = (rel, body = '{}') => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  return { env, put };
}
const signIn = (id, env) => QUIRKS[id].signIn({ label: id, command: 'x', args: [] }, env);

test('the common agents are called what people call them', () => {
  const names = { gemini: 'Gemini', 'github-copilot-cli': 'GitHub Copilot', cursor: 'Cursor', 'kimi-code': 'Kimi', kiro: 'Kiro', cline: 'Cline',
    'factory-droid': 'Droid', devin: 'Devin', 'qwen-code': 'Qwen', 'grok-build': 'Grok', opencode: 'OpenCode' };
  for (const [id, name] of Object.entries(names)) {
    assert.equal(agentName(id), name, id);
    assert.match(QUIRKS[id].signInHelp, /登录|设置|配/, id + ' says where to sign in');
  }
});

test('signed out in a fresh home, signed in once the agent has written its sign-in', t => {
  const cases = [
    ['gemini', '.gemini/oauth_creds.json', JSON.stringify({ refresh_token: 'r' })],
    ['kimi-code', '.kimi-code/credentials/kimi-code.json', JSON.stringify({ access_token: 'a', refresh_token: 'r' })],
    ['devin', 'AppData/Roaming/devin/credentials.toml', 'x'],
    ['grok-build', '.grok/auth.json', '{}'],
    ['factory-droid', '.factory/auth.v2.file', 'x'],
  ];
  for (const [id, file, body] of cases) {
    const h = home(t);
    assert.equal(signIn(id, h.env), 'no', id + ' signed out');
    h.put(file, body);
    assert.equal(signIn(id, h.env), 'yes', id + ' signed in');
  }
});

test('a key in the environment counts as signed in; a refused Kimi sign-in does not', t => {
  const h = home(t);
  assert.equal(signIn('gemini', { ...h.env, GEMINI_API_KEY: 'k' }), 'yes');
  assert.equal(signIn('devin', { ...h.env, WINDSURF_API_KEY: 'k' }), 'yes');
  assert.equal(signIn('factory-droid', { ...h.env, FACTORY_API_KEY: 'k' }), 'yes');
  assert.equal(signIn('kiro', { ...h.env, KIRO_API_KEY: 'k' }), 'yes');
  assert.equal(signIn('github-copilot-cli', { ...h.env, GH_TOKEN: 'k' }), 'yes');
  assert.equal(signIn('github-copilot-cli', h.env), 'unknown', 'Copilot\'s stored sign-in is only known by asking it');
  h.put('.kimi-code/credentials/kimi-code.json', JSON.stringify({ access_token: '', refresh_token: '' }));
  assert.equal(signIn('kimi-code', h.env), 'no');
});
