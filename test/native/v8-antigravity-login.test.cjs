'use strict';
// Antigravity's ACP server signs in with the person's Google account from the roster (T3 Code's way). Stand-in server.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { AntigravityLogin, antigravityAuthUrl, antigravitySignedIn } = load('src/main/v8/antigravityLogin.ts');
const { QUIRKS } = load('src/main/v8/acpQuirks.ts');
const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-agy-acp.cjs');

test('only a Google page with a local callback is taken for the sign-in link', () => {
  const p = 'Open the following link to authenticate the ACP server: ';
  assert.match(antigravityAuthUrl(p + 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F'), /^https:\/\/accounts\.google\.com\//);
  assert.equal(antigravityAuthUrl(p + 'https://evil.example/auth'), null);
  assert.equal(antigravityAuthUrl(p + 'https://accounts.google.com/auth?redirect_uri=https%3A%2F%2Fevil.example%2F'), null);
  assert.equal(antigravityAuthUrl('something else https://accounts.google.com/'), null);
});

test('sign in: settings name the Google sign-in, the link is shown, and it ends signed in with the token in its own folder', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, GEMINI_HOME: home, ELECTRON_RUN_AS_NODE: '1' };
  assert.equal(await QUIRKS['antigravity-acp'].signIn({}, env), 'no');
  let done = 0;
  const login = new AntigravityLogin({ launch: () => ({ command: process.execPath, args: [FAKE] }), env: () => env, onSignedIn: () => done++ });
  const flow = await login.start();
  assert.equal(flow.phase, 'waiting');
  assert.match(flow.url, /^https:\/\/accounts\.google\.com\//);
  for (let i = 0; i < 100 && login.current(flow.flowId)?.phase === 'waiting'; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(login.current(flow.flowId).phase, 'succeeded');
  assert.equal(done, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'antigravity-acp', 'seen.json'), 'utf8')), { method: 'oauth-personal', auth: { type: 'oauth-personal' }, fileStorage: '1' });
  assert.ok(antigravitySignedIn(env));
  assert.equal(await QUIRKS['antigravity-acp'].signIn({}, env), 'yes');
  assert.equal(QUIRKS['antigravity-acp'].prepare({ command: 'x', args: [], env: {} }, env, { dataDir: null }).launch.env.AGY_ACP_FORCE_FILE_STORAGE, '1', 'sessions use the same sign-in store');
  assert.equal((await login.start()).phase, 'succeeded', 'already signed in: not redone');
});
