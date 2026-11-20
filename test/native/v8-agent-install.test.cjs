'use strict';
// Step 7 of the final plan: install, update and remove agents from the official ACP list, into the app's own folder,
// with the download size known before downloading, and npm shipped inside the app. No network: fake downloads.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { availability, downloadSize, installAgent, installedVersions, uninstallAgent } = load('src/main/v8/acpRegistry.ts');

const KEY = 'windows-x86_64';
const NPM = path.join(__dirname, '..', 'fixtures', 'fake-npm-cli.cjs');

function place(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return { dir, paths: { cacheFile: path.join(dir, 'cache.json'), installRoot: path.join(dir, 'agents'), node: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }, npmCli: NPM } };
}
const binaryAgent = version => ({ id: 'tiny-acp', name: 'Tiny', version, distribution: { binary: { [KEY]: { archive: `https://example.test/tiny-${version}.exe`, cmd: './tiny.exe' } } } });
const fakeFetch = (log = []) => async (url, init = {}) => {
  log.push([init.method ?? 'GET', String(url)]);
  if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '2621440' } });
  if (String(url).startsWith('https://registry.npmjs.org/')) return new Response(JSON.stringify({ dist: { unpackedSize: 524288 } }), { status: 200 });
  return new Response(Buffer.from('MZ fake program ' + url), { status: 200 });
};

test('the size is asked before downloading: an archive from its server, an npm package from the npm registry', async () => {
  const log = [];
  assert.deepEqual(await downloadSize(binaryAgent('1.0.0'), fakeFetch(log), KEY), { bytes: 2621440, kind: 'archive', from: 'example.test' });
  assert.deepEqual(log, [['HEAD', 'https://example.test/tiny-1.0.0.exe']], 'only asked, nothing downloaded');
  const npmAgent = { id: 'pkg-acp', name: 'Pkg', version: '3.1.0', distribution: { npx: { package: '@acme/pkg-acp@3.1.0' } } };
  assert.deepEqual(await downloadSize(npmAgent, fakeFetch(log), KEY), { bytes: 524288, kind: 'package', from: 'registry.npmjs.org' });
  assert.equal(log[1][1], 'https://registry.npmjs.org/@acme%2Fpkg-acp/3.1.0');
  const quiet = async () => new Response(null, { status: 200 });
  assert.equal((await downloadSize(binaryAgent('1.0.0'), quiet, KEY)).bytes, null, 'unknown when the server does not say');
});

test('install, then the list moves on: the old version still runs and an update is offered; updating removes the old one', async t => {
  const { paths } = place(t);
  assert.deepEqual(availability(paths, binaryAgent('1.0.0'), KEY), { state: 'not_installed', how: 'binary' });
  await installAgent(paths, binaryAgent('1.0.0'), fakeFetch(), KEY);
  const v1 = availability(paths, binaryAgent('1.0.0'), KEY);
  assert.equal(v1.state, 'ready'); assert.equal(v1.version, '1.0.0'); assert.equal(v1.update, null);
  const later = availability(paths, binaryAgent('2.0.0'), KEY);
  assert.equal(later.state, 'ready', 'still usable while not updated');
  assert.equal(later.version, '1.0.0'); assert.equal(later.update, '2.0.0');
  await installAgent(paths, binaryAgent('2.0.0'), fakeFetch(), KEY);
  const v2 = availability(paths, binaryAgent('2.0.0'), KEY);
  assert.equal(v2.version, '2.0.0'); assert.equal(v2.update, null);
  assert.deepEqual(installedVersions(paths, 'tiny-acp'), ['2.0.0']);
});

test('remove takes the whole agent folder and nothing else', async t => {
  const { paths } = place(t);
  await installAgent(paths, binaryAgent('1.0.0'), fakeFetch(), KEY);
  fs.mkdirSync(path.join(paths.installRoot, 'other-acp', '1.0.0'), { recursive: true });
  uninstallAgent(paths, 'tiny-acp');
  assert.equal(availability(paths, binaryAgent('1.0.0'), KEY).state, 'not_installed');
  assert.ok(fs.existsSync(path.join(paths.installRoot, 'other-acp')), 'the other agent is untouched');
  assert.throws(() => uninstallAgent(paths, '..'), /V8_ARGUMENT/);
  assert.throws(() => uninstallAgent(paths, 'a/../../x'), /V8_ARGUMENT/);
});

test('an npm agent installs with the npm that ships inside the app (no npm needed on the computer)', async t => {
  const { paths } = place(t);
  const agent = { id: 'pkg-acp', name: 'Pkg', version: '3.1.0', distribution: { npx: { package: '@acme/pkg-acp@3.1.0', args: ['--acp'] } } };
  const launch = await installAgent(paths, agent, fakeFetch(), KEY, ['--omit=optional']);
  assert.equal(launch.command, process.execPath);
  assert.match(launch.args[0], /pkg-acp[\\/]dist[\\/]index\.js$/);
  assert.deepEqual(launch.args.slice(1), ['--acp']);
  const calls = fs.readFileSync(path.join(paths.installRoot, 'pkg-acp', '3.1.0', 'npm', 'npm-calls.txt'), 'utf8');
  assert.match(calls, /^install --prefix .* --no-audit --no-fund --no-save --omit=optional @acme\/pkg-acp@3\.1\.0/);
});
