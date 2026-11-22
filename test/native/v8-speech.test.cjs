'use strict';
// 语音输入 on this computer (requirement 67): the model is only taken when it is exactly the pinned file; without it
// nothing is recognised. No download, no model. Runs under the pinned Electron with ELECTRON_RUN_AS_NODE=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const load = require('../load-ts.cjs');
const { Speech, SPEECH_MODEL } = load('src/main/v8/speech.ts');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-speech-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('without the model nothing is recognised, and the boss is told it has to be downloaded first', async t => {
  const s = new Speech({ dataDir: tmp(t), appRoot: path.join(__dirname, '..', '..') });
  assert.deepEqual(s.status(), { ready: false, size: SPEECH_MODEL.size, downloading: null });
  await assert.rejects(s.transcribe(new Float32Array(16000)), /还没下载识别模型/);
});

test('a download that is not the pinned file is thrown away, never used', async t => {
  const dir = tmp(t);
  const progress = [];
  const wrongSize = new Speech({ dataDir: dir, appRoot: '.', fetch: async (url, to, p) => { assert.match(url, /^https:\/\/huggingface\.co\/handy-computer\/SenseVoiceSmall-gguf\/resolve\/4a08b8e9/); fs.writeFileSync(to, 'not a model'); p(11); } });
  await assert.rejects(wrongSize.download(g => progress.push(g)), /大小不对/);
  assert.deepEqual(progress, [11]);
  assert.equal(fs.existsSync(path.join(dir, 'speech', SPEECH_MODEL.file)), false);
  assert.equal(fs.existsSync(path.join(dir, 'speech', SPEECH_MODEL.file + '.part')), false, 'the half file goes too');
  // Right size, wrong content: the fingerprint catches it.
  const wrongHash = new Speech({ dataDir: dir, appRoot: '.', fetch: async (url, to) => { const fd = fs.openSync(to, 'w'); fs.ftruncateSync(fd, SPEECH_MODEL.size); fs.closeSync(fd); } });
  await assert.rejects(wrongHash.download(() => undefined), /指纹/);
  assert.equal(wrongHash.status().ready, false);
});
