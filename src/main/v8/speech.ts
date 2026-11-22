import { tr } from '../../shared/i18n';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 语音输入 on this computer (requirement 67, 老板 2026-11-21: Win+H typed nothing here). The way Orca and T3 Code do
 * it: the transcribe-cpp engine (MIT, ships with the app) runs a speech model offline. Here one model: SenseVoice
 * Small, Chinese, English, Japanese, Korean and Cantonese, the one Orca names for Chinese (model-catalog.ts), from the
 * same pinned download (speech-model-gguf-downloads.ts: repository, revision, size, sha256). It is downloaded only when
 * the boss agrees, after being told its size. Recognition runs in a child process, as T3 Code's native.ts does, so
 * the window never stalls; the engine there loads the model once and keeps it.
 */
export const SPEECH_MODEL = {
  name: 'SenseVoice Small',
  repository: 'handy-computer/SenseVoiceSmall-gguf',
  revision: '4a08b8e900b38a977e32eb08d5d0697d6e72ba04',
  file: 'SenseVoiceSmall-Q8_0.gguf',
  size: 252_684_608,
  sha256: '6c759ee4c9748c9b3f7a5a60ca74f0f7e685fb9d45d1378fce7cfd62f59adf29',
};
const SAMPLE_RATE = 16_000;
/** A clip is cut into pieces this long; a piece the model refuses as too long is halved (T3 Code's native.ts). */
const PIECE = 25 * SAMPLE_RATE;
/** At most this much speech per press (5 minutes, as OpenMausBot's manual dictation). */
export const MAX_SAMPLES = 5 * 60 * SAMPLE_RATE;

export interface SpeechStatus { ready: boolean; size: number; downloading: { got: number } | null }

// The child's code, kept inline so nothing else has to be packaged (T3 Code's native.ts does the same).
const ENTRY = `
let speech, model;
process.on('message', async (m) => {
  try {
    if (!speech) speech = await import(m.moduleUrl);
    if (!model) model = await speech.TranscribeModel.load(m.modelPath, { backend: 'cpu' });
    const texts = [];
    const run = async (pcm) => {
      try { const r = await model.transcribe(pcm); texts.push(r.text); }
      catch (e) {
        const n = e && e.constructor && e.constructor.name;
        if ((n !== 'OutputTruncated' && n !== 'InputTooLong') || pcm.length <= 4000) throw e;
        const mid = Math.floor(pcm.length / 2);
        await run(pcm.subarray(0, mid)); await run(pcm.subarray(mid));
      }
    };
    for (let i = 0; i < m.pcm.length; i += m.piece) await run(m.pcm.subarray(i, Math.min(m.pcm.length, i + m.piece)));
    process.send({ ok: true, text: texts.join('').trim() });
  } catch (e) { process.send({ ok: false, error: String((e && e.message) || e) }); }
});
process.on('disconnect', () => process.kill(process.pid, 'SIGKILL'));
`;

export class Speech {
  private child: ChildProcess | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private got: number | null = null;

  constructor(private readonly o: { dataDir: string; appRoot: string; execPath?: string; fetch?: typeof download }) {}

  private get dir(): string { return path.join(this.o.dataDir, 'speech'); }
  get modelPath(): string { return path.join(this.dir, SPEECH_MODEL.file); }

  status(): SpeechStatus {
    const ready = existsSync(this.modelPath) && statSync(this.modelPath).size === SPEECH_MODEL.size;
    return { ready, size: SPEECH_MODEL.size, downloading: this.got === null ? null : { got: this.got } };
  }

  /** Downloads the model (only on the boss's word), checks its size and fingerprint, then puts it in place. */
  async download(progress: (got: number) => void): Promise<SpeechStatus> {
    if (this.status().ready) return this.status();
    if (this.got !== null) throw new Error(tr('已经在下载了。'));
    mkdirSync(this.dir, { recursive: true });
    const part = this.modelPath + '.part';
    this.got = 0;
    try {
      const url = `https://huggingface.co/${SPEECH_MODEL.repository}/resolve/${SPEECH_MODEL.revision}/${SPEECH_MODEL.file}`;
      await (this.o.fetch ?? download)(url, part, got => { this.got = got; progress(got); });
      if (statSync(part).size !== SPEECH_MODEL.size) throw new Error(tr('下载的文件大小不对。'));
      if (await sha256(part) !== SPEECH_MODEL.sha256) throw new Error(tr('下载的文件对不上官方的指纹，没用它。'));
      renameSync(part, this.modelPath);
      this.got = null;
      return this.status();
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    } finally { this.got = null; }
  }

  /** Speech (16 kHz mono, -1..1) to text. One at a time. */
  transcribe(pcm: Float32Array): Promise<string> {
    const job = this.queue.then(() => this.run(pcm));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private run(pcm: Float32Array): Promise<string> {
    if (!this.status().ready) return Promise.reject(new Error(tr('还没下载识别模型。')));
    if (!pcm.length) return Promise.resolve('');
    const child = this.worker();
    return new Promise((resolve, reject) => {
      // A recognition that never answers is stopped, so it cannot hold up every one after it; the next one starts a
      // fresh child (1.0 review, finding 15). A minute plus the length of the speech is far more than it needs.
      const limit = setTimeout(() => { child.off('message', done); child.off('exit', gone); try { child.kill(); } catch { /* gone */ } if (this.child === child) this.child = null; reject(new Error(tr('识别太久没有结果，已经停下，再试一次。'))); }, 60_000 + Math.round(pcm.length / SAMPLE_RATE) * 1000);
      limit.unref?.();
      const done = (r: { ok: boolean; text?: string; error?: string }) => { clearTimeout(limit); child.off('exit', gone); r.ok ? resolve(r.text ?? '') : reject(new Error(tr('没听出来：') + (r.error ?? ''))); };
      const gone = () => { clearTimeout(limit); child.off('message', done); this.child = null; reject(new Error(tr('识别程序意外停了。'))); };
      child.once('message', done);
      child.once('exit', gone);
      child.send({ moduleUrl: this.moduleUrl(), modelPath: this.modelPath, pcm: pcm.subarray(0, MAX_SAMPLES), piece: PIECE });
    });
  }

  /** The engine's entry, unpacked beside the app's archive in a packaged app (native code cannot load from inside it). */
  private moduleUrl(): string {
    const root = this.o.appRoot.replace(/app\.asar$/, 'app.asar.unpacked');
    return pathToFileURL(path.join(root, 'node_modules', 'transcribe-cpp', 'dist', 'index.js')).href;
  }

  private worker(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child;
    const child = spawn(this.o.execPath ?? process.execPath, ['-e', ENTRY], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', windowsHide: true,
    });
    child.on('exit', () => { if (this.child === child) this.child = null; });
    this.child = child;
    return child;
  }

  close(): void { if (this.child) { try { this.child.kill(); } catch { /* gone */ } this.child = null; } }
}

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** GET with redirects (HuggingFace sends the file from its CDN), into `to`, reporting bytes so far. */
export function download(url: string, to: string, progress: (got: number) => void, hops = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'beastie-works' } }, res => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location && hops < 6) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).href, to, progress, hops + 1));
        return;
      }
      if (code !== 200) { res.resume(); reject(new Error(tr('下载失败（{0}）。', [code]))); return; }
      const out = createWriteStream(to);
      let got = 0, last = 0;
      res.on('data', (c: Buffer) => { got += c.length; if (got - last > 1 << 20) { last = got; progress(got); } });
      res.pipe(out);
      out.on('finish', () => { progress(got); resolve(); });
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error(tr('下载超时了。'))));
  });
}
