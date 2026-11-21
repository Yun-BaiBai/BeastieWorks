'use strict';
// Step 1 of the final plan: the agent roster and a plain chat with one agent, over the real ACP library.
// No model, no account: a stand-in agent that speaks the protocol. Runs under the pinned Electron with
// ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { AgentChats } = load('src/main/v8/agentChat.ts');
const { readRoster } = load('src/main/v8/agentRoster.ts');
const { findCodex, QUIRKS } = load('src/main/v8/acpQuirks.ts');
const { codexSignIn, claudeSignIn, dshSignIn } = load('src/main/v8/agentSignIn.ts');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-acp-agent.cjs');
const node = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
const fake = env => ({ label: 'Fake Agent', command: node.command, args: [FAKE], env: { ...node.env, ...(env ?? {}) } });
// One clean-up per test, in the right order: sessions are closed before their folders are removed.
function scope(t) {
  const undo = [];
  t.after(async () => { for (const fn of undo.reverse()) { try { await fn(); } catch { /* keep cleaning */ } } });
  return {
    tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-agents-')); undo.push(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })); return d; },
    chats(deps) { const c = new AgentChats(deps); undo.push(() => c.close()); return c; },
  };
}
const tmp = t => scope(t).tmp();

test('a sentence goes out and the agent\'s own words come back; the session remembers the turn before', async t => {
  const s = scope(t), chats = s.chats({ scratchRoot: s.tmp(), launch: async () => fake() });
  assert.deepEqual(await chats.say('fake', 'ping'), { reply: 'pong', refused: [], error: null });
  assert.equal((await chats.say('fake', 'who')).reply, 'turn 2');
});

test('the chat runs in an empty folder of its own and refuses every request to write', async t => {
  const s = scope(t), root = s.tmp(), chats = s.chats({ scratchRoot: root, launch: async () => fake() });
  const turn = await chats.say('fake', 'write a file');
  assert.equal(turn.reply, 'not allowed');
  assert.deepEqual(turn.refused, ['Write notes.txt']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'fake')), []);
});

test('an agent that is not signed in says so in plain words instead of hanging', async t => {
  const s = scope(t), chats = s.chats({ scratchRoot: s.tmp(), launch: async () => fake({ FAKE_ACP_SIGNED_OUT: '1' }) });
  const turn = await chats.say('fake', 'ping');
  assert.equal(turn.reply, '');
  assert.match(turn.error, /还没登录/);
});

test('an agent that cannot be started is an answer, not a crash', async t => {
  const chats = new AgentChats({ scratchRoot: tmp(t), launch: async () => null });
  assert.match((await chats.say('gone', 'ping')).error, /启动不了/);
});

test('the roster lists what is installed first and never needs the network', async t => {
  const dir = tmp(t), installRoot = path.join(dir, 'agents');
  // One agent installed the way the app installs a package, one not installed, one this computer cannot run.
  const pkg = path.join(installRoot, 'here', '1.0.0', 'npm', 'node_modules', 'here-acp');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'here-acp', bin: 'index.js' }));
  fs.writeFileSync(path.join(pkg, 'index.js'), '');
  const bundledFile = path.join(dir, 'registry.json');
  fs.writeFileSync(bundledFile, JSON.stringify({ version: '1', agents: [
    { id: 'absent', name: 'Absent', version: '1.0.0', distribution: { npx: { package: 'absent-acp@1.0.0' } } },
    { id: 'python', name: 'Python Only', version: '1.0.0', distribution: { uvx: { package: 'py-acp' } } },
    { id: 'here', name: 'Here', version: '1.0.0', distribution: { npx: { package: 'here-acp@1.0.0' } } },
  ] }));
  const offline = async () => { throw new Error('offline'); };
  const r = await readRoster({ registry: { cacheFile: path.join(dir, 'cache.json'), bundledFile, installRoot, node }, env: { PATH: '' }, fetchImpl: offline });
  assert.equal(r.source, 'bundled');
  const listed = r.rows.filter(x => ['here', 'absent', 'python'].includes(x.id)).map(x => [x.id, x.state]);
  assert.deepEqual(listed, [['here', 'ready'], ['absent', 'not_installed'], ['python', 'unsupported']]);
  // Agents outside the list (DeepSeek Harness) are looked for on the real computer, so only the listed ones are checked.
  assert.ok(r.launches.has('here') && !r.launches.has('absent') && !r.launches.has('python'));
  assert.equal(r.launches.get('here').args[0], path.join(pkg, 'index.js'));
});

test('Codex: the person\'s own program is used, and without one the roster says what is missing', t => {
  const home = tmp(t), exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const launch = { label: 'Codex', command: 'node', args: ['adapter.js'] };
  assert.equal(findCodex({ PATH: '', USERPROFILE: home, HOME: home }), null);
  assert.match(QUIRKS['codex-acp'].prepare(launch, { PATH: '', USERPROFILE: home, HOME: home }).missing, /没有 Codex 程序.*重新装/);
  // The desktop app keeps its program under ~/.codex/plugins.
  const desktop = path.join(home, '.codex', 'plugins', '.plugin-appserver');
  fs.mkdirSync(desktop, { recursive: true });
  fs.writeFileSync(path.join(desktop, exe), '');
  const ready = QUIRKS['codex-acp'].prepare(launch, { PATH: '', USERPROFILE: home, HOME: home });
  assert.equal(ready.launch.env.CODEX_PATH, path.join(desktop, exe));
  assert.deepEqual(QUIRKS['codex-acp'].installArgs({ PATH: '', USERPROFILE: home, HOME: home }), ['--omit=optional'], 'with the person\'s Codex nothing extra is downloaded');
});


test('sign-in is read from what the agent program itself says; anything unclear is "unknown", never "no"', async t => {
  const dir = tmp(t);
  // A stand-in CLI: the runtime preloads this file, which prints what the test tells it to and exits.
  const cli = path.join(dir, 'cli.cjs');
  fs.writeFileSync(cli, 'process.stdout.write(process.env.SAY ?? ""); process.exit(Number(process.env.CODE ?? 0));');
  const as = (say, code = 0) => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require ' + JSON.stringify(cli), SAY: say, CODE: String(code) });
  assert.equal(await codexSignIn(process.execPath, as('Logged in using ChatGPT')), 'yes');
  assert.equal(await codexSignIn(process.execPath, as('API key configured - sk-...')), 'yes');
  assert.equal(await codexSignIn(process.execPath, as('Not logged in', 1)), 'no');
  assert.equal(await codexSignIn(process.execPath, as('something else', 1)), 'unknown');
  assert.equal(await claudeSignIn(process.execPath, as('{"loggedIn": true}')), 'yes');
  assert.equal(await claudeSignIn(process.execPath, as('{"loggedIn": false, "authMethod": "none"}')), 'no');
  assert.equal(await claudeSignIn(process.execPath, as('not json')), 'unknown');
  // DeepSeek Harness: a key in the environment or in its own file is "yes"; no key is "unknown" (account sign-in leaves none).
  assert.equal(dshSignIn({ DEEPSEEK_API_KEY: 'k' }), 'yes');
  assert.equal(dshSignIn({ DSH_HOME: dir }), 'unknown');
  fs.writeFileSync(path.join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: "abc"\n');
  assert.equal(dshSignIn({ DSH_HOME: dir }), 'yes');
  fs.writeFileSync(path.join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: ""\n');
  assert.equal(dshSignIn({ DSH_HOME: dir }), 'unknown');
});

test('models and efforts come from the agent itself, and a switch takes effect on the next sentence', async t => {
  const s = scope(t), chats = s.chats({ scratchRoot: s.tmp(), launch: async () => fake() });
  const offered = await chats.choices('fake');
  assert.equal(offered.model.current, 'a/fast');
  assert.deepEqual(offered.model.choices, [
    { id: 'a/fast', label: 'Fast', group: 'Route A' }, { id: 'a/deep', label: 'Deep', group: 'Route A' }, { id: 'b/fast', label: 'Fast', group: 'Route B' },
  ]);
  assert.deepEqual(offered.effort.choices.map(c => c.id), ['low', 'high']);
  assert.equal((await chats.choose('fake', 'model', 'b/fast')).model.current, 'b/fast');
  assert.equal((await chats.choose('fake', 'effort', 'high')).effort.current, 'high');
  assert.equal((await chats.say('fake', 'which model')).reply, 'b/fast high');
  // A value the agent does not offer is refused by the agent, and the session keeps what it had.
  await assert.rejects(chats.choose('fake', 'model', 'made/up'));
  assert.equal((await chats.choices('fake')).model.current, 'b/fast');
});

test('an agent that offers no choices says so by offering none', async t => {
  const s = scope(t), chats = s.chats({ scratchRoot: s.tmp(), launch: async () => fake({ FAKE_ACP_NO_OPTIONS: '1' }) });
  assert.deepEqual(await chats.choices('fake'), { model: null, effort: null });
  await assert.rejects(chats.choose('fake', 'model', 'x'), /offers no model choice/);
});

// ---------- Claude Code sign-in from the roster (ported from OpenMausBot claude-login-auth.ts) ----------

const { ClaudeLogin, claudeLoginPrompt, claudeLoginCode } = load('src/main/v8/claudeLogin.ts');
const FAKE_CLAUDE = path.join(__dirname, '..', 'fixtures', 'fake-claude-cli.cjs');
function claudeLogin(t, extra = {}) {
  const s = scope(t), dir = s.tmp();
  let signedIn = 0;
  const login = new ClaudeLogin({ cli: () => ({ command: process.execPath, args: [FAKE_CLAUDE] }), env: () => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1', FAKE_CLAUDE_DIR: dir, ...extra }), onSignedIn: () => { signedIn++; } });
  t.after(() => login.cancel());
  return { login, dir, signedIn: () => signedIn };
}
async function settled(login, flowId) {
  for (let i = 0; i < 100; i++) { const f = login.current(flowId); if (f && f.phase !== 'waiting') return f; await new Promise(r => setTimeout(r, 50)); }
  return login.current(flowId);
}

test('sign-in: only Anthropic\'s own link is shown, and a pasted code finishes it', async t => {
  const { login, signedIn } = claudeLogin(t, { FAKE_CLAUDE_EVIL: '1' });
  const flow = await login.start();
  assert.equal(flow.phase, 'waiting');
  assert.equal(flow.url, 'https://claude.ai/oauth/authorize?code=true&state=abc');
  assert.equal((await login.start()).flowId, flow.flowId, 'a second click shows the same sign-in');
  assert.throws(() => login.complete(flow.flowId, 'x'), /整串代码/);
  login.complete(flow.flowId, '  good-code-123#state ');
  assert.equal((await settled(login, flow.flowId)).phase, 'succeeded');
  assert.equal(signedIn(), 1);
  // Already signed in: a new click does not start another sign-in.
  assert.equal((await login.start()).phase, 'succeeded');
});

test('sign-in: finishing in the browser alone is noticed without any code', async t => {
  const { login } = claudeLogin(t, { FAKE_CLAUDE_AUTO: '1' });
  const flow = await login.start();
  assert.equal((await settled(login, flow.flowId)).phase, 'succeeded');
});

test('sign-in: a wrong code and a cancel both end it in plain words', async t => {
  const { login } = claudeLogin(t);
  const flow = await login.start();
  login.complete(flow.flowId, 'wrong-code-456');
  const failed = await settled(login, flow.flowId);
  assert.equal(failed.phase, 'failed');
  assert.match(failed.message, /没接受这串代码/);
  const again = await login.start();
  assert.notEqual(again.flowId, flow.flowId);
  login.cancel();
  assert.equal(login.current(again.flowId).phase, 'cancelled');
  assert.throws(() => login.complete(again.flowId, 'good-code-123#state'), /已经结束/);
});

test('sign-in: the link and code checks', () => {
  assert.equal(claudeLoginPrompt('visit https://claude.ai/x.\nmore'), 'https://claude.ai/x');
  assert.equal(claudeLoginPrompt('visit https://claude.ai.evil.example/x\n'), null);
  assert.equal(claudeLoginPrompt('visit http://claude.ai/x\n'), null);
  assert.equal(claudeLoginPrompt('half a line https://claude.ai/x'), null, 'a line still being written is not read yet');
  assert.equal(claudeLoginCode('abc'), null);
  assert.equal(claudeLoginCode('ab cd ef gh'), null);
});

// ---------- what a turn cost (price list ported from T3 Code usagePricing.ts) ----------

const { moneyText, sureOf } = load('src/shared/v8/board.ts');
const { AcpShell } = load('src/main/v8/acpShell.ts');

test('prices: the table shipped with the app (from CodeBurn) prices the models our agents run; an unknown model is not priced', () => {
  const { priceTurn, priceRow } = load('src/main/v8/priceList.ts');
  // gpt-5.6-luna in the shipped table: input 2e-7, output 1.2e-6, cache read 2e-8 per token.
  const t = { input: 1000, cachedRead: 2000, cacheWrite: 0, output: 100 };
  assert.ok(Math.abs(priceTurn('gpt-5.6-luna', t) - (1000 * 2e-7 + 2000 * 2e-8 + 100 * 1.2e-6)) < 1e-15);
  // Names as agents write them: any case, a maker prefix, a [1m] suffix.
  assert.deepEqual(priceRow('OpenAI/GPT-5.6-Luna'), priceRow('gpt-5.6-luna'));
  assert.ok(priceRow('claude-opus-5-5[1m]'));
  assert.ok(priceRow('deepseek-v4-flash'));
  // Past the long-context threshold the whole turn is billed at the higher tier.
  const big = { input: 300000, cachedRead: 0, cacheWrite: 0, output: 0 };
  assert.ok(Math.abs(priceTurn('gpt-5.6-luna', big) - 300000 * 4e-7) < 1e-12);
  assert.equal(priceTurn('made-up-model-9', t), null);
});

async function costsOf(t, cost, price) {
  const s = scope(t), dir = s.tmp();
  const session = await new AcpShell({ ...fake({ FAKE_ACP_COST: cost }), ...(price ? { price } : {}) }).open({ role: 'worker', cwd: dir, model: null, sessionRef: null, systemPrompt: '', hostTools: [], builtinTools: true });
  t.after(() => session.close());
  const seen = [];
  session.onEvent(e => { if (e.type === 'cost') seen.push([e.usd, e.basis]); });
  for (let i = 0; i < 2; i++) {
    await new Promise(resolve => { const off = session.onEvent(e => { if (e.type === 'settled') { off(); resolve(); } }); session.prompt('ping'); });
  }
  return seen;
}

test('cost: dollars the agent reports are used as they are (its running total becomes per-turn amounts)', async t => {
  assert.deepEqual(await costsOf(t, 'reported'), [[0.25, 'reported'], [0.25, 'reported']]);
});

test('cost: an agent that reports only tokens is priced at list prices, on the model it is running', async t => {
  const asked = [];
  const seen = await costsOf(t, 'tokens', (model, tokens) => { asked.push([model, tokens]); return 0.0016; });
  assert.deepEqual(seen, [[0.0016, 'estimated'], [0.0016, 'estimated']]);
  assert.deepEqual(asked[0], ['a/fast', { input: 1000, cachedRead: 2000, cacheWrite: 0, output: 100 }]);
});

test('cost: no dollars, no tokens, or no price means "unknown", never a guess', async t => {
  assert.deepEqual(await costsOf(t, 'none', () => 1), [[0, 'unknown'], [0, 'unknown']]);
  assert.deepEqual(await costsOf(t, 'tokens', () => null), [[0, 'unknown'], [0, 'unknown']]);
});

test('cost: how sure a figure is, in plain words', () => {
  assert.equal(sureOf(['reported', 'reported']), 'exact');
  assert.equal(sureOf(['reported', 'estimated']), 'estimated');
  assert.equal(sureOf(['estimated', 'unknown']), 'partial');
  assert.equal(moneyText(0.1234, 'exact'), '$0.12');
  assert.equal(moneyText(0.0016, 'estimated'), '约 $0.002');
  assert.equal(moneyText(0.5, 'partial'), '至少 $0.50');
  assert.equal(moneyText(0, 'partial'), '未知');
});

// ---------- the app's Claude folder, apart from the person's (claudeHome.ts) ----------

test('Claude: the app\'s own folder carries the person\'s setup but never their sign-in or chats', t => {
  const { ensureClaudeHome } = load('src/main/v8/claudeHome.ts');
  const s = scope(t), dir = s.tmp();
  const person = path.join(dir, 'person'), home = path.join(dir, 'app', 'claude-home');
  fs.mkdirSync(path.join(person, 'skills', 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(person, 'skills', 'my-skill', 'SKILL.md'), 'skill');
  fs.mkdirSync(path.join(person, 'projects', 'old-chat'), { recursive: true });
  fs.writeFileSync(path.join(person, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(path.join(person, 'CLAUDE.md'), '用简体中文');
  fs.writeFileSync(path.join(person, '.credentials.json'), '{"secret":true}');
  fs.writeFileSync(path.join(person, '.claude.json'), JSON.stringify({ mcpServers: { notion: { url: 'x' } }, oauthAccount: { emailAddress: 'p@x' } }));
  const env = { CLAUDE_CONFIG_DIR: person };
  assert.equal(ensureClaudeHome(home, env), home);
  assert.equal(fs.readFileSync(path.join(home, 'skills', 'my-skill', 'SKILL.md'), 'utf8'), 'skill', 'skills are the person\'s own folder');
  assert.equal(fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8'), '用简体中文');
  assert.equal(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'), '{"theme":"dark"}');
  assert.equal(fs.existsSync(path.join(home, '.credentials.json')), false, 'never the sign-in');
  assert.equal(fs.existsSync(path.join(home, 'projects')), false, 'never the chats');
  const mine = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepEqual(mine, { mcpServers: { notion: { url: 'x' } } }, 'connectors only, not the account');
  // Refreshed on the next start; what the app's Claude wrote itself is kept.
  fs.writeFileSync(path.join(person, 'CLAUDE.md'), '改过了');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ ...mine, numStartups: 3 }));
  ensureClaudeHome(home, env);
  assert.equal(fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8'), '改过了');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).numStartups, 3);
  // Nothing in the person's folder changed.
  assert.deepEqual(fs.readdirSync(person).sort(), ['.claude.json', '.credentials.json', 'CLAUDE.md', 'projects', 'settings.json', 'skills']);
});

test('Claude: the roster starts Claude in the app\'s folder', () => {
  const { QUIRKS } = load('src/main/v8/acpQuirks.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-claude-roster-'));
  try {
    const r = QUIRKS['claude-acp'].prepare({ label: 'Claude', command: 'node', args: ['a.js'] }, { CLAUDE_CONFIG_DIR: path.join(dir, 'person') }, { dataDir: dir });
    assert.equal(r.launch.env.CLAUDE_CONFIG_DIR, path.join(dir, 'claude-home'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a resumed session gets the chosen model again (the rework of 2026-11-19 ran on the agent default)', async t => {
  const s = scope(t), dir = s.tmp();
  const shell = new AcpShell({ ...fake(), model: 'b/fast', effort: 'high' });
  const spec = { role: 'worker', cwd: dir, model: null, sessionRef: null, systemPrompt: '', hostTools: [], builtinTools: true };
  const first = await shell.open(spec);
  assert.equal(first.choices().model.current, 'b/fast');
  await first.close();
  const again = await shell.open({ ...spec, sessionRef: first.ref });
  t.after(() => again.close());
  assert.equal(again.choices().model.current, 'b/fast');
  assert.equal(again.choices().effort.current, 'high');
});

test('what a roster chat costs is handed on, so it reaches the ledger (C1: S5.3)', async t => {
  const s = scope(t), spent = [];
  const chats = s.chats({ scratchRoot: s.tmp(), launch: async () => fake({ FAKE_ACP_COST: 'reported' }), onCost: (usd, basis) => spent.push([usd, basis]) });
  assert.equal((await chats.say('fake', 'ping')).error, null);
  await chats.say('fake', 'again');
  assert.deepEqual(spent, [[0.25, 'reported'], [0.25, 'reported']], 'the running total becomes one charge per turn');
});
