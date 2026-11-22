import { tr } from '@shared/i18n';
import { useEffect, useRef, useState, type RefObject } from 'react';

const MB = (bytes: number) => Math.round(bytes / 1_000_000);
const MAX_MS = 5 * 60_000;

/**
 * 语音输入 (requirement 67, 老板 2026-11-21): speech recognised on this computer, as Orca and T3 Code do it. Click to
 * start listening, click again when done; the words go into the text box, and the boss reads them and sends himself.
 * The first time, the speech model has to be downloaded: the button says how big it is and downloads only on his
 * click. The microphone is read the way OpenMausBot's fish-speech.ts does: 16 kHz mono, nothing kept afterwards.
 */
export function MicButton({ input, onText }: { input: RefObject<HTMLInputElement | null>; onText(text: string): void }) {
  const [phase, setPhase] = useState<'idle' | 'ask' | 'downloading' | 'starting' | 'listening' | 'working'>('idle');
  const [size, setSize] = useState(0);
  const [got, setGot] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const rec = useRef<{ stop(): Float32Array } | null>(null);
  const limit = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Each start has its own number: one that finishes after the page is gone, or after another start, lets the
  // microphone go at once (1.0 review, finding 15).
  const gen = useRef(0);
  useEffect(() => () => { gen.current++; rec.current?.stop(); rec.current = null; if (limit.current) clearTimeout(limit.current); }, []);

  const listen = async () => {
    setProblem(null);
    const mine = ++gen.current;
    setPhase('starting');
    try {
      const r = await record();
      if (mine !== gen.current) { r.stop(); return; }
      rec.current = r;
      setPhase('listening');
      limit.current = setTimeout(() => { void finish(); }, MAX_MS);
    } catch (e) {
      setPhase('idle');
      setProblem(tr('用不了麦克风：') + (e instanceof Error ? e.message : String(e)) + tr('。看看 Windows 设置 → 隐私 → 麦克风，是否允许桌面应用使用麦克风。'));
    }
  };
  const finish = async () => {
    if (limit.current) { clearTimeout(limit.current); limit.current = null; }
    const pcm = rec.current?.stop(); rec.current = null;
    if (!pcm) { setPhase('idle'); return; }
    setPhase('working');
    try {
      const text = (await window.cth.v8.speechTranscribe(pcm)).trim();
      // Silence comes back as a lone full stop: only words count.
      if (/[\p{L}\p{N}]/u.test(text)) onText(text); else setProblem(tr('没听到说话。'));
    } catch (e) { setProblem(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)); }
    setPhase('idle');
    input.current?.focus();
  };
  const click = async () => {
    if (phase === 'listening') { void finish(); return; }
    // One start at a time.
    if (phase !== 'idle') return;
    const s = await window.cth.v8.speechStatus();
    if (s.ready) { void listen(); return; }
    setSize(s.size); setProblem(null); setPhase('ask');
  };
  const fetchModel = async () => {
    setPhase('downloading'); setGot(0);
    try { await window.cth.v8.speechDownload(setGot); setPhase('idle'); void listen(); }
    catch (e) { setPhase('idle'); setProblem(tr('模型没下载成功：') + (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))); }
  };

  const title = phase === 'listening' ? tr('在听…说完再点一下') : phase === 'working' ? tr('正在把话变成字…')
    : tr('说话输入：点一下开始说，说完再点一下，字会填进输入框。在这台电脑上识别，不联网、不花钱。');
  return <span className="v8-micwrap">
    <button type="button" className={'v8-mic' + (phase === 'listening' ? ' is-on' : phase === 'working' || phase === 'downloading' || phase === 'starting' ? ' is-busy' : '')}
      onClick={() => { void click(); }} onMouseDown={e => e.preventDefault()} title={problem ?? title} aria-label={title} aria-pressed={phase === 'listening'}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" /></svg>
    </button>
    {phase === 'ask' && <span className="v8-mic-pop" role="dialog" aria-label={tr('下载语音识别模型')}>
      {tr('第一次用要先下载语音识别模型 SenseVoice（约 {0} MB，来自 HuggingFace，认中文、英文、日文、韩文、粤语）。下载后在这台电脑上识别，不联网、不花钱。', [MB(size)])}
      <span className="v8-mic-acts"><button type="button" className="v8-send" onClick={() => { void fetchModel(); }}>{tr('下载')}</button>
        <button type="button" className="v8-quiet-btn" onClick={() => setPhase('idle')}>{tr('算了')}</button></span></span>}
    {phase === 'downloading' && <span className="v8-mic-pop">{tr('正在下载语音识别模型：{0} / {1} MB', [MB(got), MB(size)])}</span>}
    {phase === 'listening' && <span className="v8-mic-pop is-live">{tr('在听…说完再点一下麦克风')}</span>}
    {phase === 'working' && <span className="v8-mic-pop">{tr('正在把话变成字…')}</span>}
    {problem && phase === 'idle' && <span className="v8-mic-pop is-bad" onClick={() => setProblem(null)}>{problem}</span>}
  </span>;
}

/** The microphone at 16 kHz mono until stop(), which hands back what was said and lets the microphone go. */
async function record(): Promise<{ stop(): Float32Array }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  let ctx: AudioContext;
  try { ctx = new AudioContext({ sampleRate: 16_000 }); await ctx.resume(); }
  catch (e) { for (const t of stream.getTracks()) t.stop(); throw e; }
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const parts: Float32Array[] = [];
  node.onaudioprocess = e => { parts.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  source.connect(node);
  node.connect(ctx.destination);
  return {
    stop() {
      node.onaudioprocess = null;
      try { source.disconnect(); node.disconnect(); } catch { /* already */ }
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
      const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) { out.set(p, at); at += p.length; }
      return out;
    },
  };
}
