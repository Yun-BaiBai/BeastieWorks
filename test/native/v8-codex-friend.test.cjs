'use strict';
// A friend's computer without Codex (requirements 19, 20): the Codex adapter brings its own Codex program, and the
// person signs in from the roster with Codex's device code. Stand-in programs only; no real sign-in is touched.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { CodexLogin, codexDevicePrompt, codexLoginFailure } = load('src/main/v8/codexLogin.ts');
const { QUIRKS, bundledCodex, codexCli } = load('src/main/v8/acpQuirks.ts');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-codex-cli.cjs');
const noCodex = dir => ({ ...process.env, CODEX_PATH: '', PATH: '', Path: '', USERPROFILE: dir, HOME: dir, CODEX_HOME: path.join(dir, '.codex') });

/** An installed adapter folder like the app makes, with or without the Codex program that comes with it. */
function adapter(t, withCodex) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const nm = path.join(dir, 'npm', 'node_modules');
  const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(nm, rel)), { recursive: true }); fs.writeFileSync(path.join(nm, rel), body); };
  put('@agentclientprotocol/codex-acp/package.json', '{"name":"@agentclientprotocol/codex-acp","version":"2.6.0"}');
  put('@agentclientprotocol/codex-acp/dist/index.js', '');
  put('@openai/codex/package.json', '{"name":"@openai/codex","version":"0.166.0"}');
  put('@openai/codex/bin/codex.js', '');
  if (withCodex) put(`@openai/codex-${process.platform}-${process.arch}/package.json`, '{}');
  return { dir, script: path.join(nm, '@agentclientprotocol', 'codex-acp', 'dist', 'index.js') };
}

test('the device page and code are read from Codex\'s own words, and nothing else is taken for a link', () => {
  const out = 'Welcome\n1. Open this link\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code\n   ABCD-12345\n\n';
  assert.deepEqual(codexDevicePrompt(out), { url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
  assert.equal(codexDevicePrompt('https://auth.openai.com/codex/device\nABCD-123'), null, 'a code cut off mid-line is not read');
  assert.equal(codexDevicePrompt('https://evil.example/codex/device\nABCD-12345\n'), null);
  assert.match(codexLoginFailure('device code login is not enabled'), /设备码登录/);
});

test('without the person\'s Codex: installs bring the Codex program, and the adapter is started without CODEX_PATH', t => {
  const env = noCodex(fs.mkdtempSync(path.join(os.tmpdir(), 'v8-home-')));
  const q = QUIRKS['codex-acp'];
  assert.deepEqual(q.installArgs(env), [], 'no --omit=optional: npm brings Codex\'s program');
  assert.match(q.installNote(env), /500 MB/);
  const missing = adapter(t, false);
  const launch = { label: 'Codex', command: process.execPath, args: [missing.script], env: {} };
  assert.match(q.prepare(launch, env, { dataDir: null }).missing, /重新装/);
  const ok = adapter(t, true);
  const ready = q.prepare({ ...launch, args: [ok.script] }, env, { dataDir: null });
  assert.ok(ready.launch && !('CODEX_PATH' in (ready.launch.env ?? {})));
  assert.match(bundledCodex(ok.script), /@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
  assert.deepEqual(codexCli({ ...launch, args: [ok.script] }, env).args, [bundledCodex(ok.script)]);
});

test('with the person\'s Codex: it is used as before, and nothing extra is downloaded', t => {
  const env = { ...process.env, CODEX_PATH: process.execPath };
  const q = QUIRKS['codex-acp'];
  assert.deepEqual(q.installArgs(env), ['--omit=optional']);
  assert.equal(q.installNote(env), null);
  assert.equal(q.prepare({ label: 'Codex', command: 'x', args: ['y'], env: {} }, env, { dataDir: null }).launch.env.CODEX_PATH, process.execPath);
});

test('signing in to Codex from the roster: page and code shown, signed in by itself; never redone when signed in', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-codex-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let signedIn = 0;
  const login = new CodexLogin({ cli: () => ({ command: process.execPath, args: [FAKE] }), env: () => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1', FAKE_CODEX_HOME: home }), onSignedIn: () => signedIn++ });
  const flow = await login.start();
  assert.equal(flow.phase, 'waiting');
  assert.equal(flow.url, 'https://auth.openai.com/codex/device');
  assert.equal(flow.code, 'ABCD-12345');
  assert.throws(() => login.complete(), /不用在这里贴代码/);
  for (let i = 0; i < 100 && login.current(flow.flowId)?.phase === 'waiting'; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(login.current(flow.flowId).phase, 'succeeded');
  assert.equal(signedIn, 1);
  assert.equal((await login.start()).phase, 'succeeded', 'already signed in: no new sign-in');
});

test('a refused device sign-in says why in plain words', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-codex-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const login = new CodexLogin({ cli: () => ({ command: process.execPath, args: [FAKE] }), env: () => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1', FAKE_CODEX_HOME: home, FAKE_CODEX_REFUSE: '1' }) });
  const flow = await login.start();
  assert.equal(flow.phase, 'failed');
  assert.match(flow.message, /设备码登录/);
});
