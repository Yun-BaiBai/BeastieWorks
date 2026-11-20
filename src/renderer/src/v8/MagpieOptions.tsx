import { useEffect, useState } from 'react';
import type { MagpieModelView } from '@shared/v8/agents';

/** Magpie's models are written `magpie:<id>` wherever a model is kept (main/v8/magpieService.ts). */
export const MAGPIE_PREFIX = 'magpie:';
const MAKER: Record<string, string> = { claude: 'Claude', codex: 'Codex（ChatGPT）', gemini: 'Gemini', copilot: 'Copilot', grok: 'Grok' };

/** Magpie's models, asked for once when a picker first shows (it starts Magpie; no message is sent). */
export function useMagpieModels(on: boolean): MagpieModelView[] | string | null {
  const [models, setModels] = useState<MagpieModelView[] | string | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    window.cth.v8.magpieModels().then(m => { if (live) setModels(m); }, e => { if (live) setModels(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)); });
    return () => { live = false; };
  }, [on]);
  return models;
}

/** <optgroup>s of other makers' models through Magpie, one per maker; `skip` is the maker the agent itself is. */
export function MagpieGroups({ models, skip }: { models: MagpieModelView[] | string | null; skip?: string }) {
  if (models === null) return <optgroup label="别家的模型（经 Magpie）：正在读…" />;
  if (typeof models === 'string') return <optgroup label={'别家的模型读不到：' + models.slice(0, 60)} />;
  const makers = [...new Set(models.map(m => m.provider))].filter(p => p !== skip);
  return <>{makers.map(p => <optgroup key={p} label={`经 Magpie · ${MAKER[p] ?? p}`}>
    {models.filter(m => m.provider === p).map(m => <option key={m.id} value={MAGPIE_PREFIX + m.id}>{m.label}</option>)}
  </optgroup>)}</>;
}

/** The maker an agent's own models come from, so the picker does not list them twice. */
export const ownMaker = (agent: string | null | undefined): string | undefined => agent === 'codex-acp' ? 'codex' : agent === 'claude-acp' ? 'claude' : undefined;

export const MAGPIE_NOTE = '经 Magpie 用的是你自己电脑上登录的账号。只用自己名下的账号，不多人共用。';
