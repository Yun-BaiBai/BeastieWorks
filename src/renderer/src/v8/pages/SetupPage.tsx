import { tr } from '@shared/i18n';
import './agents.css';
import { useEffect, useState } from 'react';
import type { RosterRow, SessionChoices } from '@shared/v8/agents';
import type { V8AcpRole, V8Settings } from '@shared/v8/settings';
import { art } from '../gremlins';
import { ConnectAll } from '../InstallBox';
import { setThemeChoice, useThemeChoice, type ThemeChoice } from '../../design/theme';
import type { Hero } from './Pages';

const why = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
type RoleKey = 'lead' | 'worker' | 'reviewer';
const ROLE: Record<RoleKey, { title: string; hint: string }> = {
  lead: { title: tr('主理 bot'), hint: tr('跟你说话、派活。它不动手干活，用便宜的模型就够。') },
  worker: { title: tr('干活的小怪'), hint: tr('新加的工位默认用这个。每个工位都能在调度台上点开，单独换 agent、技能和额度规矩。') },
  reviewer: { title: tr('审查'), hint: tr('每件活做完审一次。最好换一家公司的 agent 来审，看得出别家看不出的问题。') },
};

/**
 * 第一次打开 (requirement 26): the boss (or a friend) picks the project folder, the lead's name, and which agent on this
 * computer plays each role, with its model and reasoning effort. Changeable later from the top bar. The model lists
 * are the agents' own (read by starting each one, no message sent).
 */
/** The agents that have done real work (README, supported agents), in the order they are picked for a role. */
const TRIED = ['codex-acp', 'claude-acp', 'antigravity-acp', 'dsh'];

/**
 * The agent a role gets before the person chooses: signed in first, then one that has done real work (老板 2026-11-28:
 * review was given Gemini, which Google no longer serves to personal accounts). `not`: the worker, so review differs.
 */
export function pickAgent(rows: RosterRow[], not?: string): string | undefined {
  const score = (r: RosterRow) => (r.signIn === 'yes' ? 0 : r.signIn === 'unknown' ? 10 : 20) + (TRIED.includes(r.id) ? TRIED.indexOf(r.id) : 5);
  const ready = rows.filter(r => r.state === 'ready').sort((a, b) => score(a) - score(b));
  return (ready.find(r => r.id !== not && r.signIn !== 'no') ?? ready[0])?.id;
}

export function SetupPage({ hero, first, onDone }: { hero: Hero; first: boolean; onDone(): void }) {
  const [rows, setRows] = useState<RosterRow[] | null>(null);
  const [v8, setV8] = useState<V8Settings | null>(null);
  const [roles, setRoles] = useState<Record<RoleKey, V8AcpRole | null>>({ lead: null, worker: null, reviewer: null });
  const [review, setReview] = useState(true);
  const [name, setName] = useState(tr('主理小怪'));
  const [folder, setFolder] = useState<string | null>(null);
  const [offered, setOffered] = useState<Record<string, SessionChoices | string>>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // 平时的设置 (A1, 老板 2026-11-20): how many gremlins at once, the emergency slot, the spending cap per piece of work,
  // where skills are read from, and day / night / follow the system. Slots, cap and skill folders apply without
  // stopping work; the look applies at once.
  const [slots, setSlots] = useState(2);
  const [emergency, setEmergency] = useState(true);
  const [cap, setCap] = useState('');
  const [skillRoots, setSkillRoots] = useState<string[] | null>(null);
  const look = useThemeChoice();
  // A8: the interface language (Chinese, English, or the computer's own); changing it reloads the window.
  const [uiLang, setUiLang] = useState<'zh' | 'en' | 'system'>('system');
  const [langBusy, setLangBusy] = useState(false);

  useEffect(() => {
    void Promise.all([window.cth.getConfig(), window.cth.v8.agents()]).then(([c, view]) => {
      const s = (c.v8 ?? {}) as V8Settings;
      setUiLang(c.uiLanguage === 'zh' || c.uiLanguage === 'en' ? c.uiLanguage : 'system');
      const pick = (not?: string) => pickAgent(view.rows, not);
      setV8(s); setRows(view.rows);
      setName(s.leadName ?? tr('主理小怪'));
      setFolder(s.projectRoot ?? null);
      setReview(s.review !== false);
      setSlots(s.slots ?? 2);
      setEmergency(s.emergencySlot !== false);
      setCap(typeof s.maxCostUsd === 'number' ? String(s.maxCostUsd) : '');
      setSkillRoots(s.skillRoots ?? null);
      const lead = s.acp?.lead ?? (pick() ? { agent: pick()! } : null);
      const worker = s.acp?.worker ?? (pick() ? { agent: pick()! } : null);
      const reviewer = s.acp?.reviewer ?? (pick(worker?.agent) ? { agent: pick(worker?.agent)! } : null);
      setRoles({ lead, worker, reviewer });
    }, e => setProblem(tr('读不到本机的 agent：') + why(e)));
  }, []);

  // Each picked agent is asked once what models and efforts it has.
  const picked = [...new Set(Object.values(roles).filter((r): r is V8AcpRole => !!r).map(r => r.agent))];
  useEffect(() => {
    for (const id of picked) {
      if (offered[id] !== undefined) continue;
      setOffered(o => ({ ...o, [id]: '' }));
      window.cth.v8.agentChoices(id).then(c => setOffered(o => ({ ...o, [id]: c })), e => setOffered(o => ({ ...o, [id]: why(e) })));
    }
  }, [picked.join(',')]);   // eslint-disable-line react-hooks/exhaustive-deps

  const ready = (rows ?? []).filter(r => r.state === 'ready');
  const set = (k: RoleKey, r: V8AcpRole | null) => setRoles(old => ({ ...old, [k]: r }));
  const choose = async () => { const f = await window.cth.v8.chooseFolder(); if (f) setFolder(f.path); };
  const addSkillRoot = async () => { const f = await window.cth.v8.chooseFolder(); if (f) setSkillRoots(r => [...new Set([...(r ?? []), f.path])]); };
  const capUsd = cap.trim() === '' ? undefined : Number(cap);
  const capOk = capUsd === undefined || (Number.isFinite(capUsd) && capUsd > 0 && capUsd <= 1000);
  const save = async () => {
    if (!roles.lead || !roles.worker || !folder) return;
    setSaving(true); setProblem(null);
    try {
      const c = await window.cth.getConfig();
      const acp = { lead: roles.lead, worker: roles.worker, ...(review && roles.reviewer ? { reviewer: roles.reviewer } : {}) };
      const was = (c.v8 ?? {}) as V8Settings;
      const more = first ? {} : { ...(was.desks?.length ? {} : { slots }), emergencySlot: emergency, maxCostUsd: capUsd, skillRoots: skillRoots ?? undefined };
      await window.cth.updateConfig({ v8: { ...was, shell: 'acp', projectRoot: folder, leadName: name.trim() || tr('主理小怪'), review, acp, ...more } });
      onDone();
    } catch (e) { setProblem(tr('没存上：') + why(e)); } finally { setSaving(false); }
  };

  const roleRow = (k: RoleKey) => {
    const r = roles[k];
    const o = r ? offered[r.agent] : undefined;
    const choices = typeof o === 'object' ? o : null;
    return <div key={k} className="v8u-role">
      <div><b>{k === 'lead' ? tr('{0}（{1}）', [ROLE.lead.title, name.trim() || tr('主理小怪')]) : ROLE[k].title}</b><small>{ROLE[k].hint}</small></div>
      <label className="v8a-select"><span className="v8-cap">{tr('用哪个 agent')}</span>
        <select value={r?.agent ?? ''} onChange={e => set(k, e.target.value ? { agent: e.target.value } : null)}>
          <option value="" disabled>{tr('选一个')}</option>
          {ready.map(a => <option key={a.id} value={a.id}>{a.name}{a.signIn === 'no' ? tr('（还没登录）') : ''}</option>)}
        </select></label>
      {choices?.model && <label className="v8a-select"><span className="v8-cap">{tr('模型')}</span>
        <select value={r?.model ?? ''} onChange={e => set(k, { ...r!, model: e.target.value || undefined })}>
          <option value="">{tr('它自己默认的')}</option>
          {choices.model.choices.map(c => <option key={c.id} value={c.id}>{c.group ? c.group + ' · ' : ''}{c.label}</option>)}
        </select></label>}
      {choices?.effort && <label className="v8a-select"><span className="v8-cap">{tr('推理档位')}</span>
        <select value={r?.effort ?? ''} onChange={e => set(k, { ...r!, effort: e.target.value || undefined })}>
          <option value="">{tr('它自己默认的')}</option>
          {choices.effort.choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select></label>}
      {r && o === '' && <small className="v8m-sub">{tr('正在问它有哪些模型（不花额度）…')}</small>}
      {typeof o === 'string' && o && <small className="v8a-problem">{tr('没读到它的模型：')}{o}</small>}
    </div>;
  };

  return <section className="v8p v8a v8u" aria-label={tr('设置')}>
    <div className="v8a-head">
      <img className="v8-g v8p-hero" style={hero} src={art('boss', 'pointing')} alt="" />
      <div><span className="v8-cap">{first ? tr('第一次打开') : tr('设置')}</span><h1>{first ? tr('先定好谁来干活') : tr('谁来干活')}</h1>
        <p className="v8m-sub">{tr('选一个项目文件夹，再给三个角色各挑一个这台电脑上装好的 agent。以后随时能在顶栏"设置"里改。')}</p></div>
    </div>
    <div className="v8u-body">
      {rows && <ConnectAll rows={rows} onDone={v => {
        setRows(v.rows);
        // On first run the roles are picked again (signed-in agents first), so the ones just connected are used; later,
        // only roles still empty take them.
        const pick = (not?: string) => pickAgent(v.rows, not);
        setRoles(old => {
          const keep = (r: V8AcpRole | null) => first ? null : r;
          const lead = keep(old.lead) ?? (pick() ? { agent: pick()! } : null), worker = keep(old.worker) ?? (pick() ? { agent: pick()! } : null);
          return { lead, worker, reviewer: keep(old.reviewer) ?? (pick(worker?.agent) ? { agent: pick(worker?.agent)! } : null) };
        });
      }} />}
      {rows && !ready.length && !rows.some(r => r.onComputer) && <div className="v8a-signin"><p>{tr('这台电脑上还没有装好的 agent。先去"agent 名单"装一个、登录好，再回来。')}</p></div>}
      <div className="v8u-line"><span className="v8-cap">{tr('项目文件夹')}</span><code>{folder ?? tr('还没选')}</code>
        <button type="button" className="v8-quiet-btn" onClick={() => { void choose(); }}>{folder ? tr('换一个') : tr('选文件夹')}</button></div>
      <label className="v8u-line"><span className="v8-cap">{tr('主理 bot 叫什么')}</span>
        <input value={name} maxLength={20} onChange={e => setName(e.target.value)} aria-label={tr('主理 bot 的名字')} /></label>
      {roleRow('lead')}
      {roleRow('worker')}
      <label className="v8a-radio"><input type="checkbox" checked={review} onChange={e => setReview(e.target.checked)} /><span>{tr('每件活做完审查一次')}</span></label>
      {review && roleRow('reviewer')}
      {review && roles.reviewer && roles.worker && roles.reviewer.agent === roles.worker.agent && <p className="v8m-sub">{tr('审查和干活用的是同一家，最好换一家来审。')}</p>}
      {!first && <>
        <div className="v8u-role"><div><b>{tr('干活方式')}</b><small>{tr('改了不打断正在干的活。')}</small></div>
          {/* Once the desks are set up one by one (requirement 61), they are added and removed on the board. */}
          {v8?.desks?.length ? <p className="v8m-sub v8u-desks">{tr('现在 {0} 个工位。加、删、改工位：在调度台上点开工位。', [v8.desks.length])}</p>
            : <label className="v8a-select"><span className="v8-cap">{tr('同时几只小怪干活')}</span>
            <select value={slots} onChange={e => setSlots(Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n} {tr(' 只')}</option>)}
            </select></label>}
          <label className="v8a-radio"><input type="checkbox" checked={emergency} onChange={e => setEmergency(e.target.checked)} />
            <span>{tr('另留一个应急名额：你刚说的话不用排队')}</span></label>
          {/* The cap, its box and what it means stay together in one column (boss's screenshot 2026-11-21). */}
          <label className="v8u-cap"><span className="v8-cap">{tr('每件活最多花多少美元')}</span>
            <input value={cap} onChange={e => setCap(e.target.value)} placeholder={tr('不限')} inputMode="decimal" aria-label={tr('每件活的花费上限（美元）')} />
            <small className="v8m-sub">{capOk ? (capUsd ? tr('花到 {0} 小怪会停下等你决定；点"再试一次"让它再花这么多。', [capUsd]) : tr('不设上限。')) : tr('填一个 0 到 1000 之间的数，或者留空表示不限。')}</small></label>
        </div>
        <div className="v8u-role"><div><b>{tr('技能从哪里读')}</b><small>{skillRoots ? tr('你选的文件夹') : tr('默认：agent 们共用的 ~/.agents/skills 和 ~/.claude/skills')}</small></div>
          {(skillRoots ?? []).map(r => <div key={r} className="v8u-line"><code>{r}</code>
            <button type="button" className="v8-quiet-btn" onClick={() => setSkillRoots(l => { const n = (l ?? []).filter(x => x !== r); return n.length ? n : null; })}>{tr('不用了')}</button></div>)}
          <div className="v8u-line"><button type="button" className="v8-quiet-btn" onClick={() => { void addSkillRoot(); }}>{tr('加一个技能文件夹')}</button>
            {skillRoots && <button type="button" className="v8-quiet-btn" onClick={() => setSkillRoots(null)}>{tr('改回默认')}</button>}</div>
        </div>
        <div className="v8u-role"><div><b>{tr('外观')}</b><small>{tr('选了马上就变。')}</small></div>
          <div className="v8u-line">{([['light', tr('白天')], ['dark', tr('夜晚')], ['system', tr('跟 Windows 一样')]] as Array<[ThemeChoice, string]>).map(([k, label]) =>
            <label key={k} className="v8a-radio"><input type="radio" name="look" checked={look === k} onChange={() => setThemeChoice(k)} /><span>{label}</span></label>)}</div>
        </div>
        <div className="v8u-role"><div><b>{tr('界面语言')}</b><small>{tr('换了以后小怪工坊会重启，正在干的活重启后接着做。')}</small></div>
          <div className="v8u-line">{([['zh', '中文'], ['en', 'English'], ['system', tr('跟系统')]] as Array<['zh' | 'en' | 'system', string]>).map(([k, label]) =>
            <label key={k} className="v8a-radio"><input type="radio" name="uilang" checked={uiLang === k} disabled={langBusy}
              onChange={() => { setUiLang(k); setLangBusy(true); void window.cth.setUiLanguage(k).then(() => undefined, e => { setLangBusy(false); setProblem(String(e)); }); }} /><span>{label}</span></label>)}</div>
        </div>
      </>}
      <div className="v8p-acts">
        <button type="button" className="v8-send" disabled={saving || !folder || !roles.lead || !roles.worker || (review && !roles.reviewer) || !v8 || !capOk} onClick={() => { void save(); }}>{saving ? tr('正在存…') : first ? tr('好了，开工') : tr('存好')}</button>
        {problem && <small className="v8a-problem">{problem}</small>}
      </div>
    </div>
  </section>;
}
