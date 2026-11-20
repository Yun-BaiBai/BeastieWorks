import { useEffect, useState } from 'react';
import type { SessionChoices } from '@shared/v8/agents';
import type { V8QuotaRule, V8Settings } from '@shared/v8/settings';
import { MAGPIE_NOTE, MAGPIE_PREFIX, MagpieGroups, ownMaker, useMagpieModels } from './MagpieOptions';

/**
 * 第 5 步: the boss sets beforehand what a gremlin does when its account runs out of quota: wait until it starts over,
 * or go on at once on another model (and effort) of the same agent. Saved in the app's settings; changing it never
 * stops work in progress. The models are the agent's own list (read by starting it, no message sent).
 */
export function QuotaRuleBox() {
  const [v8, setV8] = useState<V8Settings | null>(null);
  const [offered, setOffered] = useState<SessionChoices | string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { void window.cth.getConfig().then(c => setV8((c.v8 ?? {}) as V8Settings)); }, []);
  const agent = v8?.shell === 'acp' ? v8.acp?.worker.agent ?? null : null;
  useEffect(() => {
    if (!agent) return;
    window.cth.v8.agentChoices(agent).then(setOffered, e => setOffered(e instanceof Error ? e.message : String(e)));
  }, [agent]);
  // Hooks before any early return (React's rule).
  const magpie = useMagpieModels(v8?.onQuota?.do === 'switch');
  if (!v8) return null;
  if (!agent) return <div className="v8a-rule"><span className="v8-cap">额度到上限时</span><p className="v8m-sub">干活的小怪用本机 agent 时才能设。</p></div>;

  const rule: V8QuotaRule = v8.onQuota ?? { do: 'wait' };
  const save = async (next: V8QuotaRule) => {
    const c = await window.cth.getConfig();
    const merged = { ...((c.v8 ?? {}) as V8Settings), onQuota: next };
    await window.cth.updateConfig({ v8: merged });
    setV8(merged); setSaved(true); window.setTimeout(() => setSaved(false), 2000);
  };
  const models = typeof offered === 'object' && offered ? offered.model : null;
  const efforts = typeof offered === 'object' && offered ? offered.effort : null;
  const current = v8.acp?.worker.model ?? models?.current ?? null;

  return <div className="v8a-rule" aria-label="额度到上限时怎么办">
    <span className="v8-cap">干活的小怪额度到上限时{saved ? ' · 记下了' : ''}</span>
    <label className="v8a-radio"><input type="radio" name="onQuota" checked={rule.do === 'wait'} onChange={() => void save({ do: 'wait' })} />
      <span><b>等</b> 等额度重置，到点自己接着干</span></label>
    <label className="v8a-radio"><input type="radio" name="onQuota" checked={rule.do === 'switch'} onChange={() => void save({ do: 'switch', ...(rule.model ? { model: rule.model } : {}), ...(rule.effort ? { effort: rule.effort } : {}) })} />
      <span><b>换</b> 马上换个模型接着干{current ? `（现在用 ${current}）` : ''}</span></label>
    {rule.do === 'switch' && <div className="v8a-pick">
      {models && <label className="v8a-select"><span className="v8-cap">换成哪个模型</span>
        <select value={rule.model ?? ''} onChange={e => void save({ ...rule, model: e.target.value })}>
          <option value="" disabled>选一个</option>
          <optgroup label="它自己的模型">{models.choices.map(c => <option key={c.id} value={c.id}>{c.group ? c.group + ' · ' : ''}{c.label}</option>)}</optgroup>
          <MagpieGroups models={magpie} skip={ownMaker(agent)} />
        </select></label>}
      {rule.model?.startsWith(MAGPIE_PREFIX) && <p className="v8m-sub">{MAGPIE_NOTE}</p>}
      {efforts && <label className="v8a-select"><span className="v8-cap">推理档位</span>
        <select value={rule.effort ?? ''} onChange={e => void save(e.target.value ? { ...rule, effort: e.target.value } : { do: rule.do, ...(rule.model ? { model: rule.model } : {}) })}>
          <option value="">不变</option>
          {efforts.choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select></label>}
      {offered === null && <p className="v8m-sub">正在问它有哪些模型（不花额度）…</p>}
      {typeof offered === 'string' && <p className="v8m-sub">没读到它有哪些模型：{offered}</p>}
      {!rule.model && models && <p className="v8m-sub">还没选模型：选好之前，到上限还是先等。</p>}
      <p className="v8m-sub">换过去的模型也用完了，就等额度。</p>
    </div>}
  </div>;
}
