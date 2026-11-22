import { tr } from '@shared/i18n';
import './agents.css';
import { useEffect, useMemo, useState } from 'react';
import type { RosterRow } from '@shared/v8/agents';
import type { BoardData } from '@shared/v8/board';
import type { LibrarySkill } from '@shared/v8/skills';
import type { V8Desk, V8Settings } from '@shared/v8/settings';
import { MAX_DESKS, deskLabel, desksOf, newDeskId } from '@shared/v8/desks';
import { CREW, WORKERS, art, slotCast } from '../gremlins';
import type { Hero } from './Pages';
import { QuotaPlanEditor, RoleFields, cleanPlan } from './RoleEditor';

const why = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
/** The gremlins' names, as on the badge wall. */
const LOOK_NAME: Record<string, string> = Object.fromEntries(CREW.filter(c => c.role === 'worker').map(c => [c.cast, c.name]));

/**
 * 工位设置 (requirement 61, 老板 2026-11-21): every desk set up on its own, the way OpenMausBot gives each bot a page of
 * its own (bot-settings: identity, model, skills, backups). Which gremlin sits there and its name, the agent with its
 * model and effort, the skills it may use, and what it does when quota runs out (requirement 63). Desks can be added
 * (up to 8) and removed (not one that is at work). Saved in the app's settings; a change counts from the desk's next
 * ticket and never stops work in progress.
 */
export function DeskPage({ slotId, data, hero, onPick, onOpenWork }: { slotId: string; data: BoardData; hero: Hero; onPick(slotId: string): void; onOpenWork(slotId: string): void }) {
  const [v8, setV8] = useState<V8Settings | null>(null);
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [skills, setSkills] = useState<LibrarySkill[]>([]);
  const [desks, setDesks] = useState<V8Desk[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void window.cth.getConfig().then(c => { const s = (c.v8 ?? {}) as V8Settings; setV8(s); setDesks(desksOf(s)); }, e => setNote(why(e)));
    void window.cth.v8.agents().then(v => setRows(v.rows), () => undefined);
    void window.cth.v8.skills().then(v => setSkills(v.skills.filter(x => x.enabled)), () => undefined);
  }, []);

  const busy = useMemo(() => new Map(data.slots.filter(s => s.ticket).map(s => [s.slot.id, s.ticket!.title])), [data.slots]);
  const i = Math.max(0, desks.findIndex(d => d.id === slotId));
  const desk = desks[i];
  const change = (d: Partial<V8Desk>) => { setDesks(all => all.map((x, j) => j === i ? { ...x, ...d } : x)); setDirty(true); setNote(null); };
  const acp = v8?.shell === 'acp';

  const save = async (next = desks) => {
    setSaving(true); setNote(null);
    try {
      const c = await window.cth.getConfig();
      const was = (c.v8 ?? {}) as V8Settings;
      const clean = next.map(d => ({ ...d, name: d.name?.trim() || undefined, onQuota: cleanPlan(d.onQuota) }));
      await window.cth.updateConfig({ v8: { ...was, desks: clean, slots: clean.length } });
      setV8({ ...was, desks: clean }); setDesks(clean); setDirty(false); setNote(tr('存好了，从这个工位的下一件活起生效。'));
    } catch (e) { setNote(tr('没存上：') + why(e)); } finally { setSaving(false); }
  };
  const add = () => {
    const base = desk ?? desks[0];
    const fresh: V8Desk = { id: newDeskId(desks), agent: v8?.acp?.worker.agent ?? base?.agent ?? 'demo', ...(v8?.acp?.worker.model ? { model: v8.acp.worker.model } : {}), ...(v8?.acp?.worker.effort ? { effort: v8.acp.worker.effort } : {}) };
    const next = [...desks, fresh];
    void save(next).then(() => onPick(fresh.id));
  };
  const remove = () => {
    if (!desk || desks.length <= 1 || busy.has(desk.id)) return;
    const next = desks.filter(d => d.id !== desk.id);
    void save(next).then(() => onPick(next[Math.max(0, i - 1)]!.id));
  };

  if (!v8 || !desk) return <section className="v8p v8a v8u" aria-label={tr('工位设置')}><p className="v8m-sub">{note ?? tr('正在读设置…')}</p></section>;
  const look = (WORKERS as string[]).includes(desk.look ?? '') ? desk.look! : slotCast(i);
  const allowed = (id: string) => !(desk.skillsOff ?? []).includes(id);

  return <section className="v8p v8a v8u v8d" aria-label={tr('工位设置')}>
    <div className="v8a-head">
      <img className="v8-g v8p-hero" style={hero} src={art(look as (typeof WORKERS)[number], 'long_wait')} alt="" />
      <div><span className="v8-cap">{tr('工位设置')}</span><h1>{deskLabel(desk, i, n => tr('工位 ') + n)}</h1>
        <p className="v8m-sub">{tr('每个工位一只小怪，各用各的 agent、技能和额度规矩。改了从它的下一件活起生效，不打断正在干的。')}</p></div>
    </div>
    <div className="v8d-body">
      <nav className="v8d-list" aria-label={tr('所有工位')}>
        {desks.map((d, j) => <button key={d.id} type="button" className={'v8d-desk' + (d.id === desk.id ? ' is-on' : '')} onClick={() => onPick(d.id)}>
          <img className="v8-g" src={art(((WORKERS as string[]).includes(d.look ?? '') ? d.look : slotCast(j)) as (typeof WORKERS)[number], 'long_wait')} alt="" />
          <span><b>{deskLabel(d, j, n => tr('工位 ') + n)}</b><small>{rows.find(r => r.id === d.agent)?.name ?? d.agent}{d.model ? ' · ' + d.model : ''}</small>
            {busy.has(d.id) && <small className="v8d-busy">{tr('在干：')}{busy.get(d.id)}</small>}</span>
        </button>)}
        {desks.length < MAX_DESKS && <button type="button" className="v8-quiet-btn" disabled={saving || dirty} onClick={add} title={dirty ? tr('先存好这个工位') : undefined}>{tr('加一个工位')}</button>}
      </nav>
      <div className="v8d-form">
        {busy.has(desk.id) && <div className="v8u-line"><span className="v8m-sub">{tr('它正在干：')}{busy.get(desk.id)}</span>
          <button type="button" className="v8-quiet-btn" onClick={() => onOpenWork(desk.id)}>{tr('看它在干什么')}</button></div>}
        <div className="v8u-role"><div><b>{tr('名字和样子')}</b><small>{tr('跟主理小怪说"让 {0} 做"，它就派给这个工位。', [deskLabel(desk, i, n => tr('工位 ') + n)])}</small></div>
          <label className="v8u-cap"><span className="v8-cap">{tr('名字')}</span>
            <input value={desk.name ?? ''} maxLength={12} placeholder={tr('工位 ') + String(i + 1).padStart(2, '0')} onChange={e => change({ name: e.target.value })} /></label>
          <div className="v8d-looks" role="radiogroup" aria-label={tr('哪只小怪')}>
            {WORKERS.map(w => <button key={w} type="button" role="radio" aria-checked={look === w} className={'v8d-look' + (look === w ? ' is-on' : '')} onClick={() => change({ look: w })} title={LOOK_NAME[w]}>
              <img className="v8-g" src={art(w, 'long_wait')} alt={LOOK_NAME[w] ?? w} /></button>)}
          </div>
        </div>
        <div className="v8u-role"><div><b>{tr('用哪个 agent')}</b><small>{acp ? tr('这只小怪用的 agent、模型和推理档位。') : tr('现在是演示模式，先在"设置"里选好本机的 agent。')}</small></div>
          {acp && <RoleFields rows={rows} value={{ agent: desk.agent, ...(desk.model ? { model: desk.model } : {}), ...(desk.effort ? { effort: desk.effort } : {}) }}
            onChange={r => change({ agent: r.agent, model: r.model, effort: r.effort, ...(r.agent !== desk.agent ? { onQuota: desk.onQuota?.do === 'switch' ? { do: 'switch' } : desk.onQuota } : {}) })} />}
        </div>
        <div className="v8u-role v8d-skills"><div><b>{tr('能用哪些技能')}</b><small>{tr('技能库里开着的技能，这只小怪默认都能用；不想让它用的取消勾。')}</small></div>
          {skills.length === 0 ? <p className="v8m-sub">{tr('技能库里还没开着的技能。')}</p>
            : <div className="v8d-skilllist">{skills.map(s => <label key={s.id} className="v8a-radio" title={s.description}>
              <input type="checkbox" checked={allowed(s.id)} onChange={e => change({ skillsOff: e.target.checked ? (desk.skillsOff ?? []).filter(x => x !== s.id) : [...(desk.skillsOff ?? []), s.id] })} /><span>{s.name}</span></label>)}</div>}
        </div>
        {acp && <div className="v8u-role"><div><b>{tr('额度到上限')}</b><small>{tr('这个工位自己的规矩，别的工位不受影响。')}</small></div>
          <QuotaPlanEditor name={'quota-' + desk.id} agent={desk.agent} plan={desk.onQuota} onChange={p => change({ onQuota: p })} />
        </div>}
        <div className="v8p-acts">
          <button type="button" className="v8-send" disabled={saving || !dirty} onClick={() => { void save(); }}>{saving ? tr('正在存…') : tr('存好')}</button>
          {desks.length > 1 && <button type="button" className="v8-quiet-btn" disabled={saving || busy.has(desk.id)} onClick={remove} title={busy.has(desk.id) ? tr('它正在干活，干完才能删') : undefined}>{tr('删掉这个工位')}</button>}
          {note && <small className={note.startsWith(tr('没存上：')) ? 'v8a-problem' : 'v8m-sub'}>{note}</small>}
        </div>
      </div>
    </div>
  </section>;
}
