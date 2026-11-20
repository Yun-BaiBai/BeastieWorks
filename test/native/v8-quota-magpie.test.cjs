'use strict';
// Quota for agents other than Claude and Codex: read through the app's Magpie, which reads every sign-in it finds on
// the computer. Checked as data here: Magpie's two shapes of an entry, the agent-to-account match, and the roster's
// quota book asking Magpie only for agents it maps. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const load = require('../load-ts.cjs');
const { readMagpieQuota } = load('src/main/v8/magpieService.ts');
const { QuotaBook, quotaFromMagpie, windowLabel } = load('src/main/v8/quotaRead.ts');

test('Magpie quota entries are read flat or nested under quota', () => {
  const flat = readMagpieQuota({ provider: 'gemini', plan: 'free', windows: [{ name: 'daily', used: 40, resetsAt: '2026-11-21T00:00:00Z' }] });
  assert.deepEqual(flat, { provider: 'gemini', plan: 'free', error: null, windows: [{ name: 'daily', usedPercent: 40, resetsAt: Date.parse('2026-11-21T00:00:00Z') }] });
  // The shape of Magpie's own cache (quotas.json), seen on this computer 2026-11-20.
  const nested = readMagpieQuota({ quota: { provider: 'claude', plan: 'pro', windows: [{ name: '5 hours', used: 6, resetsAt: '2026-11-20T08:30:00+09:00' }, { name: '7 days', used: 13 }] } });
  assert.equal(nested.provider, 'claude');
  assert.equal(nested.windows.length, 2);
  assert.equal(nested.windows[1].resetsAt, null);
  assert.equal(readMagpieQuota({ windows: [] }), null, 'no provider, no entry');
  assert.equal(windowLabel('5 hours'), '5 小时');
  assert.equal(windowLabel('7 days'), '本周');
  assert.equal(windowLabel('daily'), '今天');
});

test('an agent gets its own accounts\' windows; a broken account says so; an unmapped agent is still unknown', () => {
  const accounts = [
    { provider: 'gemini', plan: 'free', error: null, windows: [{ name: 'daily', usedPercent: 40, resetsAt: null }] },
    { provider: 'copilot', plan: null, error: 'signed out', windows: [] },
  ];
  const g = quotaFromMagpie('gemini', accounts);
  assert.equal(g.state, 'ok');
  assert.deepEqual(g.windows, [{ label: '今天', usedPercent: 40, resetsAt: null }]);
  assert.equal(quotaFromMagpie('github-copilot-cli', accounts).state, 'error');
  assert.equal(quotaFromMagpie('kiro', accounts).state, 'none');
});

test('the quota book asks Magpie only for agents it maps, and not for Claude or Codex', async () => {
  let asked = 0;
  const book = new QuotaBook({ claudeHome: () => 'x', codex: async () => null, magpieQuotas: async () => { asked++; return [{ provider: 'grok', plan: 'super', error: null, windows: [{ name: '7 days', usedPercent: 10, resetsAt: null }] }]; } });
  const grok = await book.read('grok-build');
  assert.equal(grok.state, 'ok');
  assert.equal(grok.plan, 'super');
  assert.equal((await book.read('some-unknown-agent')).state, 'none');
  assert.equal(asked, 1);
});
