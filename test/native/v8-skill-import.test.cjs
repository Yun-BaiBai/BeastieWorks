'use strict';
// Requirement 41: skills come in from a GitHub link (OpenMausBot's skill-fetch, ported) and can be dropped again.
// A stand-in GitHub answers here; nothing goes to the network. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const load = require('../load-ts.cjs');
const { parseSkillSource } = load('src/main/v8/skillFetch.ts');
const { SkillLibrary } = load('src/main/v8/skillLibrary.ts');

const blobSha = b => crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const COMMIT = 'a'.repeat(40);

/** A stand-in GitHub holding one repository with skills/hello/{SKILL.md, notes.md, .secret}. */
function fakeGitHub() {
  const files = {
    'skills/hello/SKILL.md': Buffer.from('---\nname: hello-world\ndescription: Say hello\n---\nSay hello.\n'),
    'skills/hello/notes.md': Buffer.from('more\n'),
    'skills/hello/.secret': Buffer.from('hidden\n'),
  };
  const calls = [];
  const json = v => new Response(JSON.stringify(v), { status: 200 });
  const fetcher = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/repos/me/kit/commits/HEAD')) return new Response(COMMIT, { status: 200 });
    if (url.includes('/repos/me/kit/contents/?ref=') || url.endsWith('/repos/me/kit/contents/?ref=' + COMMIT)) return json([{ type: 'dir', name: 'skills', path: 'skills', sha: 's1' }]);
    if (url.includes('/repos/me/kit/contents/skills?ref=')) return json([{ type: 'dir', name: 'hello', path: 'skills/hello', sha: 'tree-hello' }]);
    if (url.includes('/repos/me/kit/contents/skills/hello?ref=')) return json([{ type: 'file', name: 'SKILL.md', path: 'skills/hello/SKILL.md', download_url: `https://raw.githubusercontent.com/me/kit/${COMMIT}/skills/hello/SKILL.md` }]);
    if (url.includes('/repos/me/kit/git/trees/tree-hello')) return json({ tree: Object.entries(files).map(([p, b]) => ({ path: p.slice('skills/hello/'.length), mode: '100644', type: 'blob', sha: blobSha(b), size: b.length })) });
    const raw = url.match(/^https:\/\/raw\.githubusercontent\.com\/me\/kit\/[0-9a-f]{40}\/(.+)$/);
    if (raw && files[decodeURIComponent(raw[1])]) return new Response(files[decodeURIComponent(raw[1])], { status: 200 });
    return new Response('not found', { status: 404 });
  };
  return { fetcher, calls };
}

function library(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-si-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shared = path.join(dir, 'shared');
  fs.mkdirSync(path.join(shared, 'color'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'color', 'SKILL.md'), '---\nname: color\ndescription: Colors\n---\n');
  const lib = new SkillLibrary({ roots: () => [shared], stateFile: path.join(dir, 'state.json'), importRoot: path.join(dir, 'imported') });
  return { dir, shared, lib };
}

test('links people paste are understood; anything else is refused', () => {
  assert.deepEqual(parseSkillSource('me/kit'), { owner: 'me', repo: 'kit', path: '' });
  assert.equal(parseSkillSource('https://github.com/me/kit/tree/main/skills/hello').path, 'skills/hello');
  assert.equal(parseSkillSource('https://skills.sh/me/kit/hello').skill, 'hello');
  assert.ok('error' in parseSkillSource('http://raw.githubusercontent.com/me/kit/main/SKILL.md'), 'plain http refused');
  assert.ok('error' in parseSkillSource('https://example.com/x'));
  assert.ok('error' in parseSkillSource('https://github.com/me/kit/tree/main/../../x'));
});

test('a skill comes in from GitHub, checked against the commit, switched off, without its hidden file', async t => {
  const { lib, dir } = library(t);
  const gh = fakeGitHub();
  const r = await lib.importFrom('https://github.com/me/kit', gh.fetcher);
  assert.deepEqual(r.added, ['hello-world']);
  assert.ok(r.skipped.includes('.secret'), 'hidden file left out');
  const s = lib.view().skills.find(x => x.id === 'hello-world');
  assert.equal(s.imported, true);
  assert.equal(s.enabled, false, 'imported skills start off');
  assert.equal(s.source, 'github.com/me/kit/skills/hello');
  assert.ok(fs.existsSync(path.join(dir, 'imported', 'hello-world', 'notes.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'imported', 'hello-world', '.secret')));
  assert.ok(gh.calls.every(u => u.startsWith('https://api.github.com/') || u.startsWith('https://raw.githubusercontent.com/')));
});

test('a file that does not match the commit stops the import', async t => {
  const { lib } = library(t);
  const gh = fakeGitHub();
  const tampered = async (input, init) => {
    const r = await gh.fetcher(input, init);
    return String(input).endsWith('notes.md') ? new Response('changed\n', { status: 200 }) : r;
  };
  const r = await lib.importFrom('me/kit', tampered);
  assert.match(r.error, /对不上/);
  assert.ok(!lib.view().skills.some(x => x.imported));
});

test('an imported skill is deleted; a shared one is only taken out, and can be put back', async t => {
  const { lib, dir, shared } = library(t);
  await lib.importFrom('me/kit', fakeGitHub().fetcher);
  assert.equal(lib.remove('hello-world'), 'deleted');
  assert.ok(!fs.existsSync(path.join(dir, 'imported', 'hello-world')));
  assert.equal(lib.remove('color'), 'taken-out');
  assert.ok(fs.existsSync(path.join(shared, 'color', 'SKILL.md')), 'the shared file stays');
  assert.ok(!lib.view().skills.some(x => x.id === 'color'));
  assert.equal(lib.restoreRemoved(), 1);
  assert.ok(lib.view().skills.some(x => x.id === 'color'));
});
