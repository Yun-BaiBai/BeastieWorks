import { tr } from '@shared/i18n';
import './agents.css';
import { useEffect, useState } from 'react';
import type { RosterRow } from '@shared/v8/agents';
import type { V8AcpRole, V8Settings } from '@shared/v8/settings';
import { art } from '../gremlins';
import { leadName } from '../leadName';
import type { Hero } from './Pages';
import { QuotaPlanEditor, RoleFields, cleanPlan } from './RoleEditor';

const why = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);

/**
 * The lead's or the reviewer's own settings, opened from its page (requirement 64, 老板 2026-11-21: "点哪里换？也没发现").
 * The same three pickers as the settings page, and its own rule for running out of quota (requirement 66). Saved into
 * the same settings as the settings page's "谁来干活". A new agent or model starts it again (the lead carries on its
 * conversation); the quota rule applies at once.
 */
export function RolePage({ role, hero }: { role: 'lead' | 'reviewer'; hero: Hero }) {
  const [v8, setV8] = useState<V8Settings | null>(null);
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [value, setValue] = useState<V8AcpRole | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void window.cth.getConfig().then(c => {
      const s = (c.v8 ?? {}) as V8Settings; setV8(s);
      setValue(role === 'lead' ? s.acp?.lead ?? null : s.acp?.reviewer ?? (s.acp ? { agent: s.acp.lead.agent } : null));
    }, e => setNote(why(e)));
    void window.cth.v8.agents().then(v => setRows(v.rows), () => undefined);
  }, [role]);

  const name = role === 'lead' ? leadName() : tr('审查');
  const change = (r: Partial<V8AcpRole>) => { setValue(v => ({ ...(v ?? { agent: '' }), ...r })); setDirty(true); setNote(null); };
  const save = async () => {
    if (!value?.agent) return;
    setSaving(true); setNote(null);
    try {
      const c = await window.cth.getConfig();
      const was = (c.v8 ?? {}) as V8Settings;
      if (!was.acp) throw new Error(tr('先在"设置"里选好本机的 agent。'));
      const before = role === 'lead' ? was.acp.lead : was.acp.reviewer;
      const next: V8AcpRole = { agent: value.agent, ...(value.model ? { model: value.model } : {}), ...(value.effort ? { effort: value.effort } : {}), ...(cleanPlan(value.onQuota) ? { onQuota: cleanPlan(value.onQuota) } : {}) };
      const acp = role === 'lead' ? { ...was.acp, lead: next } : { ...was.acp, reviewer: next };
      await window.cth.updateConfig({ v8: { ...was, acp } });
      const restarted = !before || before.agent !== next.agent || before.model !== next.model || before.effort !== next.effort;
      setDirty(false);
      setNote(restarted ? (role === 'lead' ? tr('存好了。主理小怪换了 agent 或模型，会重新上班，接着之前的对话。') : tr('存好了，从下一次审查起用新的。')) : tr('存好了，马上生效。'));
    } catch (e) { setNote(tr('没存上：') + why(e)); } finally { setSaving(false); }
  };

  const acp = v8?.shell === 'acp';
  return <section className="v8p v8a v8u v8d" aria-label={tr('{0}的设置', [name])}>
    <div className="v8a-head">
      <img className="v8-g v8p-hero" style={hero} src={art(role === 'lead' ? 'boss' : 'lanky', role === 'lead' ? 'pointing' : 'approve')} alt="" />
      <div><span className="v8-cap">{tr('设置')}</span><h1>{tr('{0}用什么', [name])}</h1>
        <p className="v8m-sub">{role === 'lead' ? tr('主理小怪跟你说话、派活，自己不动手，用便宜的模型就够。') : tr('每件活做完审一次。最好换一家公司的 agent 来审，看得出别家看不出的问题。')}</p></div>
    </div>
    <div className="v8u-body">
      {!v8 ? <p className="v8m-sub">{note ?? tr('正在读设置…')}</p> : !acp ? <p className="v8m-sub">{tr('现在是演示模式，先在"设置"里选好本机的 agent。')}</p> : <>
        <div className="v8u-role"><div><b>{tr('用哪个 agent')}</b><small>{tr('它用的 agent、模型和推理档位。')}</small></div>
          <RoleFields rows={rows} value={value} onChange={r => change({ agent: r.agent, model: r.model, effort: r.effort, ...(r.agent !== value?.agent ? { onQuota: value?.onQuota?.do === 'switch' ? { do: 'switch' } : value?.onQuota } : {}) })} />
        </div>
        <div className="v8u-role"><div><b>{tr('额度到上限')}</b><small>{role === 'lead' ? tr('主理小怪额度用完，所有活都会停下来等它，最好排一个备用。') : tr('审查额度用完时：换备用的接着审，或者等额度；活一直等着审，不会没审就交给你。')}</small></div>
          <QuotaPlanEditor name={'quota-' + role} agent={value?.agent ?? null} plan={value?.onQuota} onChange={p => change({ onQuota: p })} />
        </div>
        <div className="v8p-acts">
          <button type="button" className="v8-send" disabled={saving || !dirty || !value?.agent} onClick={() => { void save(); }}>{saving ? tr('正在存…') : tr('存好')}</button>
          {note && <small className={note.startsWith(tr('没存上：')) ? 'v8a-problem' : 'v8m-sub'}>{note}</small>}
        </div>
      </>}
    </div>
  </section>;
}
