import { tr } from '@shared/i18n';
import { useEffect, useState } from 'react';
import type { RosterRow, SessionChoices } from '@shared/v8/agents';
import type { V8AcpRole, V8QuotaPlan } from '@shared/v8/settings';
import { MAX_BACKUPS } from '@shared/v8/desks';
import { MAGPIE_NOTE, MAGPIE_PREFIX, MagpieGroups, ownMaker, useMagpieModels } from '../MagpieOptions';

const why = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);

/** What one agent offers (models, efforts), asked once per agent while the window is open. No message is sent. */
const asked = new Map<string, Promise<SessionChoices>>();
export function useChoices(agent: string | null): SessionChoices | string | null {
  const [got, setGot] = useState<SessionChoices | string | null>(null);
  useEffect(() => {
    setGot(null);
    if (!agent) return;
    let live = true;
    let p = asked.get(agent);
    if (!p) { p = window.cth.v8.agentChoices(agent); asked.set(agent, p); p.catch(() => asked.delete(agent)); }
    p.then(c => { if (live) setGot(c); }, e => { if (live) setGot(why(e)); });
    return () => { live = false; };
  }, [agent]);
  return got;
}

/** The agent, model and effort of one role or desk: the same three pickers as the settings page. */
export function RoleFields({ value, onChange, rows }: { value: V8AcpRole | null; onChange(v: V8AcpRole): void; rows: RosterRow[] }) {
  const ready = rows.filter(r => r.state === 'ready');
  const o = useChoices(value?.agent ?? null);
  const choices = typeof o === 'object' ? o : null;
  return <>
    <label className="v8a-select"><span className="v8-cap">{tr('用哪个 agent')}</span>
      <select value={value?.agent ?? ''} onChange={e => onChange({ agent: e.target.value })}>
        <option value="" disabled>{tr('选一个')}</option>
        {ready.map(a => <option key={a.id} value={a.id}>{a.name}{a.signIn === 'no' ? tr('（还没登录）') : ''}</option>)}
      </select></label>
    {choices?.model && <label className="v8a-select"><span className="v8-cap">{tr('模型')}</span>
      <select value={value?.model ?? ''} onChange={e => onChange({ ...value!, model: e.target.value || undefined })}>
        <option value="">{tr('它自己默认的')}</option>
        {choices.model.choices.map(c => <option key={c.id} value={c.id}>{c.group ? c.group + ' · ' : ''}{c.label}</option>)}
      </select></label>}
    {choices?.effort && <label className="v8a-select"><span className="v8-cap">{tr('推理档位')}</span>
      <select value={value?.effort ?? ''} onChange={e => onChange({ ...value!, effort: e.target.value || undefined })}>
        <option value="">{tr('它自己默认的')}</option>
        {choices.effort.choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select></label>}
    {value && o === null && <small className="v8m-sub">{tr('正在问它有哪些模型（不花额度）…')}</small>}
    {typeof o === 'string' && <small className="v8a-problem">{tr('没读到它的模型：')}{o}</small>}
  </>;
}

/**
 * Running out of quota (requirements 63, 66): wait, or go on with backups in order, at most five (OpenMausBot's
 * FallbackChain). The backups are models the same agent offers, its own or another maker's through Magpie.
 */
export function QuotaPlanEditor({ agent, plan, onChange, name }: { agent: string | null; plan: V8QuotaPlan | undefined; onChange(p: V8QuotaPlan): void; name: string }) {
  const p: V8QuotaPlan = plan ?? { do: 'wait' };
  const o = useChoices(agent);
  const choices = typeof o === 'object' ? o : null;
  const magpie = useMagpieModels(p.do === 'switch');
  const backups = p.backups ?? [];
  const put = (list: NonNullable<V8QuotaPlan['backups']>) => onChange({ do: 'switch', backups: list });
  const modelSelect = (value: string, set: (m: string) => void) => <select value={value} onChange={e => set(e.target.value)}>
    <option value="" disabled>{tr('选一个')}</option>
    {choices?.model && <optgroup label={tr('它自己的模型')}>{choices.model.choices.map(c => <option key={c.id} value={c.id}>{c.group ? c.group + ' · ' : ''}{c.label}</option>)}</optgroup>}
    {agent && <MagpieGroups models={magpie} skip={ownMaker(agent)} />}
  </select>;
  return <div className="v8a-rule v8d-plan" aria-label={tr('额度到上限时怎么办')}>
    <span className="v8-cap">{tr('额度到上限时')}</span>
    <label className="v8a-radio"><input type="radio" name={name} checked={p.do === 'wait'} onChange={() => onChange({ do: 'wait', ...(backups.length ? { backups } : {}) })} />
      <span><b>{tr('等')}</b> {tr(' 等额度重置，到点自己接着干')}</span></label>
    <label className="v8a-radio"><input type="radio" name={name} checked={p.do === 'switch'} onChange={() => put(backups)} />
      <span><b>{tr('换')}</b> {tr(' 按下面的备用清单，一个用完换下一个')}</span></label>
    {p.do === 'switch' && <div className="v8d-backups">
      {backups.length === 0 && <p className="v8m-sub">{tr('还没有备用：加一个之前，到上限还是先等。')}</p>}
      <ol>
        {backups.map((b, i) => <li key={i}>
          <span className="v8d-no">{i + 1}</span>
          {modelSelect(b.model, m => put(backups.map((x, j) => j === i ? { ...x, model: m } : x)))}
          {choices?.effort && <select value={b.effort ?? ''} aria-label={tr('推理档位')} onChange={e => put(backups.map((x, j) => j === i ? (e.target.value ? { ...x, effort: e.target.value } : { model: x.model }) : x))}>
            <option value="">{tr('档位不变')}</option>
            {choices.effort.choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>}
          <button type="button" className="v8-quiet-btn" disabled={i === 0} onClick={() => put(backups.map((x, j) => j === i - 1 ? backups[i]! : j === i ? backups[i - 1]! : x))}>{tr('往前')}</button>
          <button type="button" className="v8-quiet-btn" onClick={() => put(backups.filter((_, j) => j !== i))}>{tr('去掉')}</button>
        </li>)}
      </ol>
      {backups.length < MAX_BACKUPS && <button type="button" className="v8-quiet-btn" onClick={() => put([...backups, { model: '' }])}>{tr('加一个备用')}</button>}
      {backups.some(b => b.model.startsWith(MAGPIE_PREFIX)) && <p className="v8m-sub">{MAGPIE_NOTE}</p>}
      <p className="v8m-sub">{tr('清单里的都用完了，就等额度。')}</p>
    </div>}
  </div>;
}

/** A plan without half-filled rows, to be saved. */
export function cleanPlan(p: V8QuotaPlan | undefined): V8QuotaPlan | undefined {
  if (!p) return undefined;
  const backups = (p.backups ?? []).filter(b => b.model).slice(0, MAX_BACKUPS);
  return { do: p.do, ...(backups.length ? { backups } : {}) };
}
