import './agents.css';
import { useEffect, useState } from 'react';
import type { RosterRow, SessionChoices } from '@shared/v8/agents';
import type { V8AcpRole, V8Settings } from '@shared/v8/settings';
import { art } from '../gremlins';
import type { Hero } from './Pages';

const why = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
type RoleKey = 'lead' | 'worker' | 'reviewer';
const ROLE: Record<RoleKey, { title: string; hint: string }> = {
  lead: { title: '主理 bot', hint: '跟你说话、派活。它不动手干活，用便宜的模型就够。' },
  worker: { title: '干活的小怪', hint: '每件活开一只，真正改文件、跑命令。用你平时干活最顺手的那个。' },
  reviewer: { title: '审查', hint: '每件活做完审一次。最好换一家公司的 agent 来审，看得出别家看不出的问题。' },
};

/**
 * 第一次打开 (requirement 26): the boss (or a friend) picks the project folder, the lead's name, and which agent on this
 * computer plays each role, with its model and reasoning effort. Changeable later from the top bar. The model lists
 * are the agents' own (read by starting each one, no message sent).
 */
export function SetupPage({ hero, first, onDone }: { hero: Hero; first: boolean; onDone(): void }) {
  const [rows, setRows] = useState<RosterRow[] | null>(null);
  const [v8, setV8] = useState<V8Settings | null>(null);
  const [roles, setRoles] = useState<Record<RoleKey, V8AcpRole | null>>({ lead: null, worker: null, reviewer: null });
  const [review, setReview] = useState(true);
  const [name, setName] = useState('小怪A');
  const [folder, setFolder] = useState<string | null>(null);
  const [offered, setOffered] = useState<Record<string, SessionChoices | string>>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([window.cth.getConfig(), window.cth.v8.agents()]).then(([c, view]) => {
      const s = (c.v8 ?? {}) as V8Settings;
      const ready = view.rows.filter(r => r.state === 'ready');
      const signed = ready.filter(r => r.signIn !== 'no');
      const pick = (not?: string) => (signed.find(r => r.id !== not) ?? signed[0] ?? ready[0])?.id;
      setV8(s); setRows(view.rows);
      setName(s.leadName ?? '小怪A');
      setFolder(s.projectRoot ?? null);
      setReview(s.review !== false);
      const lead = s.acp?.lead ?? (pick() ? { agent: pick()! } : null);
      const worker = s.acp?.worker ?? (pick() ? { agent: pick()! } : null);
      const reviewer = s.acp?.reviewer ?? (pick(worker?.agent) ? { agent: pick(worker?.agent)! } : null);
      setRoles({ lead, worker, reviewer });
    }, e => setProblem('读不到本机的 agent：' + why(e)));
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
  const save = async () => {
    if (!roles.lead || !roles.worker || !folder) return;
    setSaving(true); setProblem(null);
    try {
      const c = await window.cth.getConfig();
      const acp = { lead: roles.lead, worker: roles.worker, ...(review && roles.reviewer ? { reviewer: roles.reviewer } : {}) };
      await window.cth.updateConfig({ v8: { ...((c.v8 ?? {}) as V8Settings), shell: 'acp', projectRoot: folder, leadName: name.trim() || '小怪A', review, acp } });
      onDone();
    } catch (e) { setProblem('没存上：' + why(e)); } finally { setSaving(false); }
  };

  const roleRow = (k: RoleKey) => {
    const r = roles[k];
    const o = r ? offered[r.agent] : undefined;
    const choices = typeof o === 'object' ? o : null;
    return <div key={k} className="v8u-role">
      <div><b>{k === 'lead' ? `${ROLE.lead.title}（${name.trim() || '小怪A'}）` : ROLE[k].title}</b><small>{ROLE[k].hint}</small></div>
      <label className="v8a-select"><span className="v8-cap">用哪个 agent</span>
        <select value={r?.agent ?? ''} onChange={e => set(k, e.target.value ? { agent: e.target.value } : null)}>
          <option value="" disabled>选一个</option>
          {ready.map(a => <option key={a.id} value={a.id}>{a.name}{a.signIn === 'no' ? '（还没登录）' : ''}</option>)}
        </select></label>
      {choices?.model && <label className="v8a-select"><span className="v8-cap">模型</span>
        <select value={r?.model ?? ''} onChange={e => set(k, { ...r!, model: e.target.value || undefined })}>
          <option value="">它自己默认的</option>
          {choices.model.choices.map(c => <option key={c.id} value={c.id}>{c.group ? c.group + ' · ' : ''}{c.label}</option>)}
        </select></label>}
      {choices?.effort && <label className="v8a-select"><span className="v8-cap">推理档位</span>
        <select value={r?.effort ?? ''} onChange={e => set(k, { ...r!, effort: e.target.value || undefined })}>
          <option value="">它自己默认的</option>
          {choices.effort.choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select></label>}
      {r && o === '' && <small className="v8m-sub">正在问它有哪些模型（不花额度）…</small>}
      {typeof o === 'string' && o && <small className="v8a-problem">没读到它的模型：{o}</small>}
    </div>;
  };

  return <section className="v8p v8a v8u" aria-label="设置">
    <div className="v8a-head">
      <img className="v8-g v8p-hero" style={hero} src={art('boss', 'pointing')} alt="" />
      <div><span className="v8-cap">{first ? '第一次打开' : '设置'}</span><h1>{first ? '先定好谁来干活' : '谁来干活'}</h1>
        <p className="v8m-sub">选一个项目文件夹，再给三个角色各挑一个这台电脑上装好的 agent。以后随时能在顶栏"设置"里改。</p></div>
    </div>
    <div className="v8u-body">
      {rows && !ready.length && <div className="v8a-signin"><p>这台电脑上还没有装好的 agent。先去"agent 名单"装一个、登录好，再回来。</p></div>}
      <div className="v8u-line"><span className="v8-cap">项目文件夹</span><code>{folder ?? '还没选'}</code>
        <button type="button" className="v8-quiet-btn" onClick={() => { void choose(); }}>{folder ? '换一个' : '选文件夹'}</button></div>
      <label className="v8u-line"><span className="v8-cap">主理 bot 叫什么</span>
        <input value={name} maxLength={20} onChange={e => setName(e.target.value)} aria-label="主理 bot 的名字" /></label>
      {roleRow('lead')}
      {roleRow('worker')}
      <label className="v8a-radio"><input type="checkbox" checked={review} onChange={e => setReview(e.target.checked)} /><span>每件活做完审查一次</span></label>
      {review && roleRow('reviewer')}
      {review && roles.reviewer && roles.worker && roles.reviewer.agent === roles.worker.agent && <p className="v8m-sub">审查和干活用的是同一家，最好换一家来审。</p>}
      <div className="v8p-acts">
        <button type="button" className="v8-send" disabled={saving || !folder || !roles.lead || !roles.worker || (review && !roles.reviewer) || !v8} onClick={() => { void save(); }}>{saving ? '正在存…' : first ? '好了，开工' : '存好'}</button>
        {problem && <small className="v8a-problem">{problem}</small>}
      </div>
    </div>
  </section>;
}
