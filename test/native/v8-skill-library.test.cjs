'use strict';
// Step 6 of the final plan: the app's skill library. Skills are read from a folder (such as ~/.agents/skills),
// start switched off, a gremlin sees the names of the ones that fit its ticket and fetches the full text with a tool,
// each fetch counts as a use, and a retold summary can be kept. No model: the stand-in agent.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { SkillLibrary, indexCategories, retellPrompt } = load('src/main/v8/skillLibrary.ts');
const { V8Workbench } = load('src/main/v8/workbench.ts');

const AGENT = path.join(__dirname, '..', 'fixtures', 'fake-acp-tools-agent.cjs');

async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('timed out waiting for ' + what);
}

/** A shared skill folder: skills, an INDEX.md one level up. */
function library(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-skills-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const root = path.join(dir, 'skills');
  const skill = (id, name, description, extra = {}) => {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n照这个做：${name} 的步骤。\n`);
    for (const [f, body] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(root, id, f)), { recursive: true }); fs.writeFileSync(path.join(root, id, f), body); }
  };
  skill('pdf', 'pdf', 'Read, fill and merge PDF files and forms.', { 'references/forms.md': '表单怎么填' });
  skill('gsap-core', 'gsap-core', 'GSAP animation core: tweens, easing, timelines for web pages.');
  skill('greeting', 'greeting', 'Write a short friendly greeting line into a text file.');
  fs.mkdirSync(path.join(root, 'not-a-skill'));
  fs.writeFileSync(path.join(dir, 'INDEX.md'), '# 索引\n\n## 设计\n- **gsap-core** — greensock\n\n## 文档\n- **pdf** — anthropics\n');
  const lib = new SkillLibrary({ roots: () => [root], stateFile: path.join(dir, 'state', 'skill-library.json') });
  return { lib, root, dir };
}

test('the library reads every folder with a SKILL.md, with its category from INDEX.md; all start switched off', t => {
  const { lib } = library(t);
  const v = lib.view();
  assert.deepEqual(v.skills.map(s => [s.id, s.category, s.enabled, s.uses]), [['greeting', null, false, 0], ['gsap-core', '设计', false, 0], ['pdf', '文档', false, 0]]);
  assert.equal(v.skills.find(s => s.id === 'pdf').description, 'Read, fill and merge PDF files and forms.');
  assert.deepEqual([...indexCategories('## 视频\n- **remotion** — x\n').entries()], [['remotion', '视频']]);
});

test('a gremlin only sees switched-on skills: names in its brief, full text on use_skill, each use counted', t => {
  const { lib } = library(t);
  assert.deepEqual(lib.briefLines('fill a pdf form'), [], 'nothing on, nothing offered');
  assert.equal(lib.call('use_skill', { name: 'pdf' }).ok, false);
  lib.setEnabled(['pdf', 'gsap-core'], true);
  const brief = lib.briefLines('帮我 fill 这个 pdf form').join('\n');
  assert.match(brief, /- pdf：/);
  assert.doesNotMatch(brief, /gsap/, 'only the ones that fit the work');
  // A Chinese request that shares no word with the English descriptions still hears that the library is there.
  assert.match(lib.briefLines('给页面加个动画').join('\n'), /技能库里开着 2 个技能（比如 gsap-core、pdf）/);
  assert.match(lib.call('list_skills', {}).text, /gsap-core/);
  const used = lib.call('use_skill', { name: 'pdf' });
  assert.equal(used.ok, true);
  assert.match(used.text, /照这个做：pdf/);
  assert.match(used.text, /references\/forms\.md/, 'it is told what else is in the folder');
  assert.equal(lib.call('use_skill', { name: 'pdf', file: 'references/forms.md' }).text, '表单怎么填');
  assert.equal(lib.call('use_skill', { name: 'pdf', file: '../../secret.txt' }).ok, false, 'nothing outside the skill folder');
  const pdf = lib.view().skills.find(s => s.id === 'pdf');
  assert.equal(pdf.uses, 2);
  assert.ok(pdf.lastUsed > 0);
  lib.setEnabled(['pdf'], false);
  assert.equal(lib.call('use_skill', { name: 'pdf' }).ok, false, 'switched off again: gone for gremlins');
});

test('a retold summary is kept with who said it; the retell prompt carries the whole skill', t => {
  const { lib } = library(t);
  lib.saveRetold('pdf', 'codex-acp', '  它用来读写 PDF。  ');
  assert.deepEqual({ ...lib.view().skills.find(s => s.id === 'pdf').retold, at: 0 }, { text: '它用来读写 PDF。', agent: 'codex-acp', at: 0 });
  assert.match(retellPrompt(lib.text('pdf')), /三到五句[\s\S]*照这个做：pdf/);
});

test('a real gremlin (stand-in agent) gets the skill names in its brief and fetches one with use_skill', async t => {
  const { lib } = library(t);
  lib.setEnabled(['greeting', 'pdf'], true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-skill-bench-'));
  const log = path.join(dir, 'log'); fs.mkdirSync(log);
  const node = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const acpLaunch = async agent => ({ label: 'Fake ' + agent, command: process.execPath, args: [AGENT], env: { ELECTRON_RUN_AS_NODE: '1', FAKE_TOOLS_LOG: log, FAKE_TOOLS_SKILL: 'greeting' }, node });
  const settings = { shell: 'acp', review: false, slots: 1, emergencySlot: false, acp: { lead: { agent: 'lead-agent' }, worker: { agent: 'worker-agent' } } };
  const b = new V8Workbench({ stateDir: path.join(dir, 'state'), settings, acpLaunch, skills: lib });
  t.after(async () => { await b.shutdown().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  await b.start();
  b.say('写一句 friendly greeting 到 hello.txt');
  await until(() => b.scheduler.tickets().length === 1, 'a ticket');
  const id = b.scheduler.tickets()[0].id;
  await until(() => b.scheduler.latestReport(id)?.kind === 'done', 'the gremlin to finish', 40000);
  const read = n => fs.readFileSync(path.join(log, n), 'utf8');
  assert.match(read('tools.txt'), /ticket-1: submit_report,list_skills,use_skill/);
  assert.match(read('prompts.txt'), /- greeting：/, 'the brief named the fitting skill');
  assert.match(read('skill.txt'), /照这个做：greeting/, 'the full text came back through the tool');
  assert.equal(lib.view().skills.find(s => s.id === 'greeting').uses, 1);
  assert.match(fs.readFileSync(path.join(log, 'tools.txt'), 'utf8'), /lead-room: list_tickets/);
  assert.doesNotMatch(read('tools.txt').split('\n').find(l => l.startsWith('lead-room')), /use_skill/, 'the lead gets no skills');
});
