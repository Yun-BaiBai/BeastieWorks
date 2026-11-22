'use strict';
// The findings of the 1.0 review (work/r10-review/report.md) that were fixed, each held to its fix. No model.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3'), load = require('../load-ts.cjs');
const { Scheduler } = load('src/main/v8/scheduler.ts');
const { Dispatcher } = load('src/main/v8/dispatcher.ts');
const { FakeShell } = load('src/main/v8/fakeShell.ts');
const { TicketWorkspaces } = load('src/main/v8/workspace.ts');
const { makerOf } = load('src/main/v8/maker.ts');

async function until(check, what, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 15)); }
  assert.fail('timed out waiting for ' + what);
}
const done = { kind: 'done', summary: '好了', changed: [], verification: { command: 'x', output: 'ok' } };
function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-r10-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'a.txt'), 'a1\n');
  fs.writeFileSync(path.join(project, 'b.txt'), 'b1\n');
  return { root, project, spaces: () => new TicketWorkspaces(project, path.join(root, 'state', 'work')) };
}

test('finding 4: an accept cut short by a crash is undone at the next start', t => {
  const f = folder(t);
  const spaces = f.spaces();
  spaces.ensure(1);
  // What a crash between the two renames leaves: a.txt moved aside, its new version not yet in place.
  const target = path.join(f.project, 'a.txt'), old = target + '.beastie-1-x.old', fresh = target + '.beastie-1-x.new';
  fs.renameSync(target, old);
  fs.writeFileSync(fresh, 'a2\n');
  fs.writeFileSync(path.join(f.root, 'state', 'accept-journal.json'), JSON.stringify([{ target, old, fresh }]));
  f.spaces();   // the next start
  assert.equal(fs.readFileSync(target, 'utf8'), 'a1\n', 'the project file is back');
  assert.equal(fs.existsSync(old) || fs.existsSync(fresh), false, 'no leftovers');
  assert.equal(fs.existsSync(path.join(f.root, 'state', 'accept-journal.json')), false);
});

test('finding 13: after a conflict the copy catches up; the boss\'s other changes come in, the gremlin\'s stay', t => {
  const f = folder(t);
  const spaces = f.spaces();
  const dir = spaces.ensure(1);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'gremlin\n');
  fs.writeFileSync(path.join(f.project, 'a.txt'), 'boss\n');
  fs.writeFileSync(path.join(f.project, 'b.txt'), 'b2 by the boss\n');
  assert.deepEqual(spaces.apply(1).conflicts, ['a.txt']);
  const c = spaces.catchUp(1);
  assert.deepEqual(c, { taken: ['b.txt'], both: ['a.txt'] });
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b2 by the boss\n');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'gremlin\n');
  assert.equal(fs.readFileSync(path.join(dir, '.beastie-merge', 'a.txt'), 'utf8'), 'boss\n');
  // The gremlin merges; the next accept puts in only a.txt, never the merge folder, and keeps the boss's b.txt.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'boss + gremlin\n');
  assert.deepEqual(spaces.apply(1), { applied: ['a.txt'], conflicts: [] });
  assert.equal(fs.readFileSync(path.join(f.project, 'b.txt'), 'utf8'), 'b2 by the boss\n');
  assert.equal(fs.existsSync(path.join(f.project, '.beastie-merge')), false);
});

test('findings 5 and 6: a ticket keeps its first desk; a new session gets everything since the first words', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const s = new Scheduler(db, {});
  s.setSlots([{ id: 'slot-1', label: '工位 01', model: null, emergency: false }, { id: 'slot-2', label: '工位 02', model: null, emergency: false }]);
  let round = 0;
  // A shell that never carries on a session: every open is a new one (another ref), as when the agent changed.
  const inner = new FakeShell(() => ({ async onPrompt(c) { round++; await c.hostTool('submit_report', round === 1 ? { kind: 'question', question: '用方案 A 还是 B？', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } : done); c.settle(); } }));
  const shell = { open: spec => inner.open({ ...spec, sessionRef: null }) };
  const d = new Dispatcher(s, shell, { workdir: id => 'D:/work/' + id });
  t.after(() => d.shutdown());
  const id = s.openTicket({ fromMessageId: s.bossSaid('改首页'), routingNote: '' });
  await d.pump();
  await until(() => s.state(id) === 'ANSWER', 'its question');
  const first = s.ticket(id).targetSlot;
  assert.ok(first, 'it now belongs to the desk it ran at');
  await d.tell(id, '用方案 B，保留原来的配色');
  await until(() => inner.sessions.length === 2, 'the second session');
  const brief = inner.sessions[1].heard[0].text;
  assert.match(brief, /这张工单到现在的经过/);
  assert.match(brief, /问老板：用方案 A 还是 B？/);
  assert.match(brief, /老板：用方案 B，保留原来的配色/);
  assert.equal(s.ticket(id).targetSlot, first, 'back at the same desk');
  assert.equal(db.prepare('SELECT session_ref FROM v8_tickets WHERE id=?').pluck().get(id), inner.sessions[1].ref, 'the session that ran is kept');
});

test('finding 8: the lead whose backup cannot be opened waits, then opens again instead of prompting a closed session', async t => {
  const { Lead } = load('src/main/v8/lead.ts');
  const db = new Database(':memory:');
  t.after(() => db.close());
  const s = new Scheduler(db, {});
  const d = new Dispatcher(s, new FakeShell(() => ({})), { workdir: id => 'D:/work/' + id });
  t.after(() => d.shutdown());
  let refused = false;   // the account runs out once
  const inner = new FakeShell(spec => ({ async onPrompt(c) { if (spec.model === 'main' && !refused) { refused = true; c.settle('error', 'usage limit reached'); return; } await c.hostTool('reply_to_boss', { text: '在' }); c.settle(); } }));
  let opens = 0;
  const shell = { open: async spec => { opens++; if (spec.model === 'b1') throw new Error('backup unavailable'); return inner.open(spec); } };
  const notes = [];
  const lead = new Lead(s, d, shell, { cwd: 'D:/lead', model: 'main', plan: () => ({ do: 'switch', backups: [{ model: 'b1' }] }), onNote: x => notes.push(x), quotaWaitMs: 100 });
  await lead.start();
  t.after(() => lead.stop());
  lead.bossSays('在吗');
  await until(() => notes.length === 2, 'switch, then wait');
  assert.match(notes[1], /等额度/);
  lead.bossSays('还在吗');   // queued meanwhile, not thrown
  await until(() => opens >= 3, 'opened again after the wait', 20000);
  await until(() => s.messages(null).filter(m => m.author === 'lead').length >= 1, 'the answer on its own model again');
});

test('finding 12: review counts as another company by the models\' makers, Magpie included', () => {
  assert.equal(makerOf('codex-acp', 'gpt-5.6-luna'), 'openai');
  assert.equal(makerOf('codex-acp', 'magpie:claude/claude-haiku-5-5'), 'anthropic', 'a Codex desk on a Claude model is Anthropic\'s work');
  assert.equal(makerOf('claude-acp', null), 'anthropic');
  assert.equal(makerOf('some-new-agent', null), null, 'unknown: the agents are compared instead');
});

test('finding 1: the holes the review named are closed', () => {
  const { directoryPolicy } = load('src/main/v8/approval.ts');
  const dir = os.tmpdir();
  const ask = c => directoryPolicy({ workdir: () => dir })({ ticketId: 1, tool: 'bash', detail: 'Run\nCommand: ' + c });
  assert.equal(ask('npm test'), true, 'the ordinary case still passes');
  assert.equal(ask('echo ok & whoami'), false, 'a single & chains a second command');
  assert.equal(ask('echo x > %TEMP%\out.txt'), false, 'a path through an environment variable');
  assert.equal(ask('echo x > $env:TEMP\out.txt'), false);
  assert.equal(ask('git show --output=x.txt HEAD'), false, 'git writing a file of its choosing');
});

test('finding 2: a big file two tickets share stays read-only until the last one ends, and again when one reopens', t => {
  const { BIG_FILE } = load('src/main/v8/workspace.ts');
  const f = folder(t);
  fs.writeFileSync(path.join(f.project, 'take.mp4'), Buffer.alloc(BIG_FILE + 1024, 7));
  const spaces = f.spaces();
  const one = spaces.ensure(1), two = spaces.ensure(2);
  if (!spaces.big(1).some(b => b.linked)) return;   // a disk without hard links copies instead: nothing to hold
  const writable = p => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };
  assert.equal(writable(path.join(one, 'take.mp4')), false);
  spaces.release(1);
  assert.equal(writable(path.join(two, 'take.mp4')), false, 'ticket 2 still holds it');
  spaces.ensure(1);
  spaces.release(2);
  assert.equal(writable(path.join(one, 'take.mp4')), false, 'ticket 1 reopened and holds it again');
  spaces.release(1);
  assert.equal(writable(path.join(f.project, 'take.mp4')), true, 'the last one ended: the project\'s file is writable');
});
