'use strict';
// A7 (老板 2026-11-20): the way of working holds for any project, not only code. A gremlin verifies by the kind of
// work (tests and builds for code; word counts and checking against the request for writing; length and format for
// pictures, sound and video), and the review gremlin asks for a real result, not necessarily a command.
// Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { directoryPolicy } = load('src/main/v8/approval.ts');
const { WORKER_SYSTEM, REPORT_TOOL, REVIEW_SYSTEM, REVIEW_TOOL, reviewBrief } = load('src/main/v8/prompts.ts');
const { validateReport } = load('src/main/v8/reports.ts');
const { WORK_STEPS } = load('src/shared/v8/board.ts');

test('a gremlin may look at a picture, sound or video file in its folder, and nowhere else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-any-'));
  const ok = directoryPolicy({ workdir: () => dir });
  const ask = command => ok({ ticketId: 1, tool: 'bash', detail: `Allow tool: bash\nCommand: ${command}` });
  assert.equal(ask('ffprobe -v error -show_entries format=duration clip.mp4'), true);
  assert.equal(ask('mediainfo cover.png'), true);
  assert.equal(ask('wc -m chapter1.md'), true, 'counting words was already allowed');
  assert.equal(ask('ffprobe C:/Users/someone/Videos/private.mp4'), false, 'not outside the folder');
  assert.equal(ask('ffprobe https://example.com/a.mp4'), false, 'not over the network');
  assert.equal(ask('ffmpeg -i clip.mp4 out.mp4'), false, 'looking only: ffmpeg is not on the list');
});

test('the rules speak of any kind of work: verification by kind, a real result, not necessarily a command', () => {
  assert.match(WORKER_SYSTEM, /字数/);
  assert.match(WORKER_SYSTEM, /时长/);
  assert.doesNotMatch(WORKER_SYSTEM, /测试、构建或能证明结果的命令/);
  assert.match(REPORT_TOOL.parameters.properties.verification.description, /只写“没问题”不算/);
  assert.match(REVIEW_SYSTEM, /不一定是命令/);
  assert.match(REVIEW_TOOL.description, /有验证结果吗/);
  assert.doesNotMatch(REVIEW_SYSTEM + REVIEW_TOOL.description, /验证输出/);
  assert.match(reviewBrief({ originalRequest: '写一篇 800 字的开场白', bossLater: [], summary: '写好了', diff: '+…', verification: { command: '数了字数，对照要求逐条核对', output: '812 字；三点要求都写到了' } }), /怎么验证的：数了字数/);
  assert.deepEqual([...WORK_STEPS], ['摸底', '想做法', '动手', '验证', '交报告']);
});

test('a "done" for writing carries its check like any other; a bare "done" is still refused', () => {
  const r = validateReport({ kind: 'done', summary: '写好开场白', changed: ['opening.md'], verification: { command: '数字数（wc -m opening.md），对照老板的三点要求', output: '812 opening.md；三点都写到了' } });
  assert.equal(r.kind, 'done');
  assert.throws(() => validateReport({ kind: 'done', summary: '写好了', changed: ['opening.md'] }), /V8_DONE_NEEDS_VERIFICATION/);
});
