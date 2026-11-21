import { tr } from '@shared/i18n';
import { useState, type RefObject } from 'react';

/**
 * A4 语音输入: puts the cursor in the text box and opens Windows' own voice typing (Win+H) over it. What the boss says
 * is typed into the box; he reads it and sends it himself. Free and needs no key.
 */
export function MicButton({ input }: { input: RefObject<HTMLInputElement | null> }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = () => {
    if (busy) return;
    input.current?.focus();
    setBusy(true); setProblem(null);
    window.cth.dictate().then(r => { if (!r.ok) setProblem(r.error); }, () => setProblem(tr('打不开语音输入，可以直接按 Win+H。')))
      .finally(() => { setBusy(false); input.current?.focus(); });
  };
  return <button type="button" className={'v8-mic' + (busy ? ' is-busy' : '')} onClick={go} onMouseDown={e => e.preventDefault()}
    title={problem ?? tr('说话输入（Windows 自带的语音输入，也可以按 Win+H）。说完看一眼，再点发送。')} aria-label={tr('说话输入')}>
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" /></svg>
    {problem && <span className="v8-mic-why">{problem}</span>}
  </button>;
}
