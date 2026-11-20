'use strict';
// Requirement 26: the lead's name is the boss's to set (小怪A until then), and the board says which agents play the roles,
// so the window knows when nothing is set up yet (first run). Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { V8Workbench } = load('src/main/v8/workbench.ts');

async function bench(t, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-setup-'));
  const b = new V8Workbench({ stateDir: path.join(dir, 'state'), settings, demoPace: 1000 });
  t.after(async () => { await b.shutdown().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  await b.start();
  return b;
}

test('the lead is called 小怪A until the boss names it; the name reaches the board', async t => {
  assert.equal((await bench(t, { slots: 1 })).board().leadName, '小怪A');
  assert.equal((await bench(t, { slots: 1, leadName: '  阿福 ' })).board().leadName, '阿福');
  assert.equal((await bench(t, { slots: 1, leadName: '   ' })).board().leadName, '小怪A');
});

test('nothing set up yet: the board says it is not on local agents, so the window opens the first-run page', async t => {
  assert.notEqual((await bench(t, { slots: 1 })).board().harness.kind, 'acp');
});
