'use strict';
// A10 项目笔记 (老板 2026-11-20). After the boss accepts a ticket, the lead's agent writes a few lines resting on his own
// words; the next gremlin gets them under his words. Stand-in ACP agents (test/fixtures/fake-acp-tools-agent.cjs).
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { V8Workbench } = load('src/main/v8/workbench.ts');
const { ProjectNotes, acceptNotes } = load('src/main/v8/notes.ts');

const AGENT = path.join(__dirname, '..', 'fixtures', 'fake-acp-tools-agent.cjs');
async function until(check, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail('timed out waiting for ' + what);
}

function bench(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-notes-'));
  const log = path.join(dir, 'log'); fs.mkdirSync(log);
  const node = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const acpLaunch = async agent => ({ label: 'Fake ' + agent, command: process.execPath, args: [AGENT], env: { ELECTRON_RUN_AS_NODE: '1', FAKE_TOOLS_LOG: log, FAKE_TOOLS_NAME: agent }, node });
  const settings = { shell: 'acp', review: false, slots: 1, emergencySlot: false, acp: { lead: { agent: 'lead-agent' }, worker: { agent: 'worker-agent' } } };
  const b = new V8Workbench({ stateDir: path.join(dir, 'state'), settings, acpLaunch, ...extra });
  t.after(async () => { await b.shutdown().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  return { b, read: n => { try { return fs.readFileSync(path.join(log, n), 'utf8'); } catch { return ''; } } };
}

async function doneTicket(b, words) {
  const before = b.scheduler.tickets().length;
  b.say(words);
  await until(() => b.scheduler.tickets().length > before, 'a ticket for: ' + words);
  const id = b.scheduler.tickets().map(t => t.id).sort((x, y) => y - x)[0];
  await until(() => b.scheduler.latestReport(id)?.kind === 'done', 'the work on #' + id);
  return id;
}

test('accepting a ticket writes the lines that rest on the boss\'s words; the next gremlin gets them under his own words', async t => {
  const { b, read } = bench(t);
  await b.start();
  const id = await doneTicket(b, '以后文件标题都用中文，别用英文');
  b.accept(id);
  await until(() => b.notesView().notes.length > 0, 'a note');
  const notes = b.notesView().notes;
  assert.equal(notes.length, 1, 'the made-up line and the secret are dropped: ' + notes.map(n => n.text).join(' | '));
  assert.match(notes[0].text, /以后文件标题都用中文/);
  assert.equal(notes[0].ticketId, id);
  assert.equal(notes[0].evidence, '以后文件标题都用中文，别用英文');
  assert.match(read('notes.txt'), /以后文件标题都用中文/, 'the notes step read the boss\'s words');
  assert.ok(b.board().feed.some(l => /记了 1 条/.test(l.text)), 'the feed says a note was written');
  // The next ticket: the boss's words first and whole, then the notebook.
  await doneTicket(b, '把 README 第一行改短');
  const brief = read('briefs.txt').trim().split('\n').at(-1);
  assert.ok(brief.indexOf('把 README 第一行改短') < brief.indexOf('项目笔记'), 'the boss\'s words come first: ' + brief);
  assert.match(brief, /项目笔记.*以后文件标题都用中文/);
});

test('with notes turned off nothing is written, and the boss can write, change and delete lines himself', async t => {
  let on = false;
  const { b, read } = bench(t, { notesOn: () => on });
  await b.start();
  const id = await doneTicket(b, '以后都用短句');
  b.accept(id);
  assert.deepEqual(await b.captureNotes(id), [], 'off: nothing');
  assert.equal(read('notes.txt'), '', 'and no agent was asked');
  assert.equal(b.notesView().capture, false);
  let v = b.noteAdd('人物名字一律用全名');
  assert.equal(v.notes[0].evidence, null);
  v = b.noteEdit(v.notes[0].id, '人物名字一律用全名，不用昵称');
  assert.equal(v.notes[0].text, '人物名字一律用全名，不用昵称');
  v = b.noteRemove(v.notes[0].id);
  assert.equal(v.notes.length, 0);
  on = true;
  assert.equal(b.notesView().capture, true, 'read live: no restart');
});

test('the check on what is handed in: evidence from the boss\'s words, lessons from the report, no repeats, no secrets', () => {
  const o = { bossWords: '标题用中文。图片放 assets 文件夹', report: 'npm run build 先跑才能测', notebook: ['标题用中文'] };
  const got = acceptNotes({ items: [
    { text: '标题用中文', kind: 'preference', evidence: '标题用中文' },
    { text: '图片都放在 assets 文件夹', kind: 'fact', evidence: '图片放 assets 文件夹' },
    { text: '测试前要先 build', kind: 'lesson', evidence: 'npm run build 先跑才能测' },
    { text: '老板住在北京', kind: 'fact', evidence: '我住北京' },
    { text: 'api_key: sk-1234567890abcdefghij', kind: 'fact', evidence: '标题用中文' },
  ] }, o);
  assert.deepEqual(got.map(n => n.text), ['图片都放在 assets 文件夹', '测试前要先 build']);
  assert.throws(() => acceptNotes({ items: 'x' }, o), /列表/);
});

test('the notebook keeps the newest lines that fit in a brief, under a heading that says the boss\'s words win', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-nb-'));
  try {
    const nb = new ProjectNotes(path.join(dir, 'notes.json'));
    assert.deepEqual(nb.briefLines(), []);
    for (let i = 0; i < 60; i++) nb.add('第 ' + i + ' 条：' + 'x'.repeat(100));
    const lines = nb.briefLines();
    assert.match(lines[1], /以原话为准/);
    assert.match(lines.at(-1), /第 59 条/, 'the newest is kept');
    assert.ok(lines.join('\n').length < 4500, 'it stays short');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('closing right after an accept cuts the notes step off and waits for it: nothing is left running in the folder', async t => {
  const { b } = bench(t);
  await b.start();
  const id = await doneTicket(b, '以后都用短句');
  b.accept(id);
  await b.shutdown();
  const room = path.join(b.notes['file'] ? path.dirname(b.notes['file']) : '', 'lead-room');
  fs.rmSync(room, { recursive: true, force: true });   // EBUSY here if a notes session were still running in it
  assert.equal(fs.existsSync(room), false);
});
