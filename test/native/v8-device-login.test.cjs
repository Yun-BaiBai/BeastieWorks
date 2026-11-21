'use strict';
// A9 (老板 2026-11-21): Grok, Kimi and Cursor sign in from the roster with their own programs (OpenMausBot's way).
// Stand-in sign-in programs print what the real ones print; nothing reaches xAI, Moonshot or Cursor.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { devicePrompt, DEVICE_SPECS, DeviceLogin, deviceCli } = load('src/main/v8/deviceLogin.ts');
const { cursorStatus } = load('src/main/v8/cursorStatus.ts');
const { QUIRKS } = load('src/main/v8/acpQuirks.ts');

test('the page and code are read only from the maker\'s own hosts, and only once whole', () => {
  assert.deepEqual(devicePrompt('grok', 'Open this page:\nhttps://accounts.x.ai/device\nand enter\nABCD-1234\n'), { url: 'https://accounts.x.ai/device', code: 'ABCD-1234' });
  assert.equal(devicePrompt('grok', 'https://accounts.x.ai/device\nABCD-12'), null, 'an unfinished last line is never read');
  assert.equal(devicePrompt('grok', 'https://evil.example/device\nABCD-1234\n'), null);
  assert.equal(devicePrompt('grok', 'https://accounts.x.ai/device?token=abc\nABCD-1234\n'), null, 'nothing else rides in the link');
  assert.deepEqual(devicePrompt('kimi', 'Please visit device login: https://www.kimi.com/code/authorize?user_code=WXYZ-9876&x=1\nThen enter code: WXYZ-9876\n'),
    { url: 'https://www.kimi.com/code/authorize?user_code=WXYZ-9876', code: 'WXYZ-9876' });
  const link = 'https://cursor.com/loginDeepControl?challenge=abcdefghijklmnop1234&uuid=1234abcd-5678&mode=login';
  assert.deepEqual(devicePrompt('cursor', `Open a browser and navigate to this link: ${link}\n`), { url: link, code: null });
  assert.equal(devicePrompt('cursor', 'link: https://cursor.com/loginDeepControl?challenge=abcdefghijklmnop1234&uuid=1234abcd-5678&token=x\n'), null);
});

test('the sign-in program is the agent\'s own launch without its ACP arguments', () => {
  assert.deepEqual(deviceCli({ command: 'node', args: ['grok.js', 'agent', 'stdio'] }, DEVICE_SPECS['grok-build']), { command: 'node', args: ['grok.js'] });
  assert.deepEqual(deviceCli({ command: 'cursor-agent.exe', args: ['acp'] }, DEVICE_SPECS.cursor), { command: 'cursor-agent.exe', args: [] });
  assert.equal(deviceCli({ command: 'x', args: ['other'] }, DEVICE_SPECS.cursor), null);
  for (const id of ['grok-build', 'kimi-code', 'cursor']) assert.equal(QUIRKS[id].signInFlow, true, id + ' can sign in from the roster');
  assert.equal(cursorStatus(0, 'banner\n{"isAuthenticated":true}'), 'yes');
  assert.equal(cursorStatus(0, '{"status":"unauthenticated"}'), 'no');
  assert.equal(cursorStatus(1, '{"isAuthenticated":true}'), 'unknown');
});

/** A stand-in program: prints `lines`, waits until `go` exists, then runs `after` and exits with `code`. */
function program(t, lines, after = '', code = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-dev-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const go = path.join(dir, 'go'), file = path.join(dir, 'login.cjs');
  fs.writeFileSync(file, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(dir, 'args'))},process.argv.slice(2).join(' ')+' NO_OPEN_BROWSER='+(process.env.NO_OPEN_BROWSER||''));
process.stdout.write(${JSON.stringify(lines)});
const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})){clearInterval(t);${after};process.exit(${code});}},50);`);
  return { dir, go, cli: { command: process.execPath, args: [file], env: { ELECTRON_RUN_AS_NODE: '1' } }, args: () => fs.readFileSync(path.join(dir, 'args'), 'utf8') };
}
async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('timed out waiting for ' + what);
}

test('Grok: the page and code are shown; when the program finishes and auth.json is there, it is signed in', async t => {
  const p = program(t, 'Visit:\nhttps://accounts.x.ai/device\nCode:\nQWER-5678\n', '');
  const grokHome = path.join(p.dir, 'grok-home');
  fs.writeFileSync(path.join(p.dir, 'login.cjs'), fs.readFileSync(path.join(p.dir, 'login.cjs'), 'utf8').replace(';process.exit(0)', `;fs.mkdirSync(${JSON.stringify(grokHome)},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(grokHome, 'auth.json'))},'{}');process.exit(0)`));
  let signed = 0;
  const l = new DeviceLogin({ spec: DEVICE_SPECS['grok-build'], cli: () => p.cli, env: () => ({ ...process.env, GROK_HOME: grokHome }), onSignedIn: () => { signed++; } });
  const f = await l.start();
  assert.equal(f.phase, 'waiting');
  assert.equal(f.url, 'https://accounts.x.ai/device');
  assert.equal(f.code, 'QWER-5678');
  assert.equal(f.paste, false, 'nothing is pasted back in the app');
  assert.match(p.args(), /^login --device-auth/);
  fs.writeFileSync(p.go, '');
  await until(() => l.current(f.flowId)?.phase === 'succeeded', 'signed in');
  assert.equal(signed, 1);
  assert.equal((await l.start()).phase, 'succeeded', 'a working sign-in is never replaced');
});

test('Cursor: no code; the app opens the link itself, and the program is told not to open a browser', async t => {
  const link = 'https://cursor.com/loginDeepControl?challenge=abcdefghijklmnop1234&uuid=1234abcd-5678';
  const p = program(t, `Open a browser and navigate to this link: ${link}\n`, '', 1);
  const opened = [];
  const l = new DeviceLogin({ spec: { ...DEVICE_SPECS.cursor, signedIn: () => 'no' }, cli: () => p.cli, env: () => process.env, open: u => opened.push(u) });
  const f = await l.start();
  assert.equal(f.url, link);
  assert.equal(f.code, null);
  assert.deepEqual(opened, [link]);
  assert.match(p.args(), /^login NO_OPEN_BROWSER=1$/);
  fs.writeFileSync(p.go, '');
  await until(() => l.current(f.flowId)?.phase === 'failed', 'the failed sign-in');
  assert.match(l.current(f.flowId).message, /没登录上/, 'plain words, never the program\'s own');
});

test('cancel stops the sign-in program', async t => {
  const p = program(t, 'Visit:\nhttps://accounts.x.ai/device\nQWER-5678\n');
  const l = new DeviceLogin({ spec: { ...DEVICE_SPECS['grok-build'], signedIn: () => 'no' }, cli: () => p.cli, env: () => process.env });
  const f = await l.start();
  l.cancel();
  assert.equal(l.current(f.flowId).phase, 'cancelled');
  await assert.rejects(() => new DeviceLogin({ spec: DEVICE_SPECS.cursor, cli: () => null, env: () => process.env }).start(), /没找到 Cursor 的程序/);
});
