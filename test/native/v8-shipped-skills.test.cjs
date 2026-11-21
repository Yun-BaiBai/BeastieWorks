'use strict';
// A5 (老板 2026-11-21): skills that ship with the app (find-skills, agent-browser, agent-desktop, agent-reach) and the
// ones ego lite brings start switched on; a copy in the boss's own folder wins; the tools behind them install into the
// app's own folder with a launcher on PATH. Nothing is downloaded: npm is stood in for by a tiny script.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const load = require('../load-ts.cjs');
const { SkillLibrary } = load('src/main/v8/skillLibrary.ts');
const { SkillTools, SHIPPED_TOOLS } = load('src/main/v8/skillTools.ts');
const { parseSkillFrontmatter } = load('src/main/v8/skillFrontmatter.ts');

const SHIPPED = path.join(__dirname, '..', '..', 'resources', 'skills');

function tmp(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}
const skill = (root, id, description) => {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'SKILL.md'), `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n`);
};

test('the four shipped skills are in resources/skills, each with its license', () => {
  for (const id of ['find-skills', 'agent-browser', 'agent-desktop', 'agent-reach']) {
    assert.ok(fs.existsSync(path.join(SHIPPED, id, 'SKILL.md')), id + ' SKILL.md');
    assert.match(fs.readFileSync(path.join(SHIPPED, id, 'LICENSE.txt'), 'utf8'), /MIT License|Apache License/, id + ' license');
    // Each one's name and description are read.
    const head = parseSkillFrontmatter(fs.readFileSync(path.join(SHIPPED, id, 'SKILL.md'), 'utf8'));
    assert.equal(head.name, id, id + ' name');
    assert.ok((head.description ?? '').length > 20, id + ' description');
  }
  // A SKILL.md saved with an invisible byte order mark (agent-desktop's was, 2026-11-21) is read all the same.
  assert.equal(parseSkillFrontmatter(String.fromCharCode(0xFEFF) + '---\nname: x\ndescription: y\n---\n').name, 'x');
  assert.deepEqual(SHIPPED_TOOLS.map(x => x.skill).sort(), ['agent-browser', 'agent-desktop', 'agent-reach', 'find-skills']);
});

test('shipped and ego skills start on and sit under 自带; the boss can switch them off; his own copy of one wins', t => {
  const dir = tmp(t, 'v8-shipped-');
  const own = path.join(dir, 'own'), ego = path.join(dir, 'ego');
  skill(own, 'pdf', 'PDF files.');
  skill(own, 'agent-browser', 'The boss\'s own copy.');
  skill(ego, 'ego-browser', 'The ego lite browser.');
  const lib = new SkillLibrary({ roots: () => [own], builtinRoots: () => [SHIPPED, ego], stateFile: path.join(dir, 'state.json') });
  const v = Object.fromEntries(lib.view().skills.map(s => [s.id, s]));
  assert.equal(v.pdf.enabled, false, 'the boss\'s own skills still start off');
  assert.equal(v['agent-browser'].builtin, false, 'his own copy wins');
  assert.equal(v['agent-browser'].description, 'The boss\'s own copy.');
  for (const id of ['find-skills', 'agent-desktop', 'agent-reach', 'ego-browser']) {
    assert.equal(v[id].enabled, true, id + ' starts on');
    assert.equal(v[id].builtin, true);
    assert.equal(v[id].category, '自带');
  }
  assert.match(lib.call('use_skill', { name: 'agent-reach' }).text, /agent-reach/, 'a gremlin can fetch a shipped skill');
  lib.setEnabled(['agent-desktop'], false);
  assert.equal(lib.view().skills.find(s => s.id === 'agent-desktop').enabled, false, 'switched off stays off');
  assert.equal(lib.call('use_skill', { name: 'agent-desktop' }).ok, false);
});

test('tools: a stand-in npm installs into the app\'s folder, a launcher runs it, and removing takes both away', async t => {
  const dir = tmp(t, 'v8-tools-');
  // A stand-in npm: `install --prefix <dir> ... <pkg>` lays out a package with a Node bin that prints its arguments.
  const npm = path.join(dir, 'fake-npm.cjs');
  fs.writeFileSync(npm, `const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const prefix=a[a.indexOf('--prefix')+1],pkg=a.at(-1);
const d=path.join(prefix,'node_modules',pkg);fs.mkdirSync(path.join(d,'bin'),{recursive:true});
fs.writeFileSync(path.join(d,'package.json'),JSON.stringify({name:pkg,version:'9.9.9',bin:{[pkg]:'bin/'+pkg}}));
fs.writeFileSync(path.join(d,'bin',pkg),"console.log('ran '+process.argv.slice(2).join(' '))");`);
  fs.writeFileSync(path.join(dir, 'npx-cli.js'), '');   // npm ships npx-cli.js beside npm-cli.js
  const env = { PATH: path.join(dir, 'nothing-here'), PATHEXT: '.EXE;.CMD' };
  const tools = new SkillTools({ dir: path.join(dir, 'tools'), node: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }, npmCli: npm, env,
    fetchImpl: async () => ({ ok: true, json: async () => ({ dist: { unpackedSize: 2_000_000 } }) }) });
  const before = Object.fromEntries(tools.view().map(x => [x.skill, x.state]));
  assert.deepEqual(before, { 'agent-browser': 'not_installed', 'agent-desktop': 'not_installed', 'agent-reach': 'needs_uv', 'find-skills': 'missing_basics' });
  assert.equal((await tools.size('agent-desktop')).bytes, 2_000_000, 'the size comes before any download');
  const after = Object.fromEntries((await tools.install('agent-desktop')).map(x => [x.skill, x]));
  assert.equal(after['agent-desktop'].state, 'installed');
  assert.equal(after['agent-desktop'].version, '9.9.9');
  assert.equal(after['find-skills'].state, 'ready', 'npx now comes from the app\'s own npm');
  const bin = tools.binDir;
  for (const name of ['node', 'npm', 'npx', 'agent-desktop']) assert.ok(fs.existsSync(path.join(bin, process.platform === 'win32' ? name + '.cmd' : name)), name + ' launcher');
  if (process.platform === 'win32') {
    const out = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', path.join(bin, 'agent-desktop.cmd'), 'snapshot', '-i'], { encoding: 'utf8' });
    assert.match(out, /ran snapshot -i/, 'the launcher runs the tool as Node');
  }
  assert.equal(tools.pathWithTools().value.split(path.delimiter)[0], bin, 'the tools\' folder goes first on PATH');
  assert.equal(tools.remove('agent-desktop').find(x => x.skill === 'agent-desktop').state, 'not_installed');
  assert.throws(() => tools.remove('agent-reach'), /不是小怪工坊装的/);
});

test('tools: one already on the computer is used as it is, and no node launcher shadows a real node', t => {
  const dir = tmp(t, 'v8-tools2-');
  const own = path.join(dir, 'own-bin'); fs.mkdirSync(own);
  for (const n of ['agent-browser', 'node', 'npx']) fs.writeFileSync(path.join(own, n + '.cmd'), '@echo off');
  if (process.platform !== 'win32') return;
  const tools = new SkillTools({ dir: path.join(dir, 'tools'), node: { command: process.execPath }, env: { PATH: own, PATHEXT: '.CMD' } });
  tools.ensureBasics();
  assert.equal(fs.existsSync(path.join(tools.binDir, 'node.cmd')), false);
  const v = Object.fromEntries(tools.view().map(x => [x.skill, x.state]));
  assert.equal(v['agent-browser'], 'on_computer');
  assert.equal(v['find-skills'], 'ready');
});
