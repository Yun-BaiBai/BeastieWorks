'use strict';
// 老板 2026-11-20: every gremlin's Codex starts without what the person's ChatGPT account brings (its plugins and
// connected apps: Notion, Gmail…) and without the browser and computer control, as OpenMausBot does; the person's own
// MCP servers and skills stay. Checked as the settings Codex is started with; no Codex and no model here.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { QUIRKS, CODEX_SURFACE_OFF, codexLight } = load('src/main/v8/acpQuirks.ts');

const OFF = ['plugins', 'remote_plugin', 'apps', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use'];
const offIn = (config, what) => { for (const f of OFF) assert.equal(config['features.' + f], false, what + ': features.' + f); };

test('the worker\'s Codex starts with the account\'s plugins and apps, the browser and computer control off; its own settings kept', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-cs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const codex = path.join(dir, 'codex.exe'); fs.writeFileSync(codex, '');
  const person = { ...process.env, CODEX_PATH: codex, USERPROFILE: dir, HOME: dir };
  const launch = { label: 'Codex', command: process.execPath, args: ['adapter.js'], env: { CODEX_CONFIG: JSON.stringify({ 'features.memories': false }) } };
  const ready = await QUIRKS['codex-acp'].prepare(launch, person);
  const config = JSON.parse(ready.launch.env.CODEX_CONFIG);
  offIn(config, 'worker');
  assert.equal(config['features.memories'], false, 'what was there before stays');
  assert.equal(ready.launch.env.CODEX_PATH, codex);
  assert.ok(!Object.keys(config).some(k => k.startsWith('mcp_servers')), 'the person\'s own MCP servers are left as they set them');

  // The lead and the reviewer start lighter still, with the same things off.
  offIn(JSON.parse(codexLight(person).env.CODEX_CONFIG), 'lead and reviewer');

  // Wired to Magpie, the switches stay.
  const wired = await QUIRKS['codex-acp'].magpie('http://127.0.0.1:5000', 'claude/claude-haiku-5-5', ready.launch.env, { ...person, CODEX_PATH: '', PATH: '', Path: '' }, 'low');
  offIn(JSON.parse(wired.CODEX_CONFIG), 'on Magpie');
  assert.equal(Object.keys(CODEX_SURFACE_OFF).length, OFF.length);
});
