import './agents.css';
import { useEffect, useMemo, useState } from 'react';
import type { LibrarySkill, SkillLibraryView } from '@shared/v8/skills';
import type { V8Settings } from '@shared/v8/settings';
import { art } from '../gremlins';
import type { Hero } from './Pages';

const why = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
const day = (at: number) => new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });

/**
 * 技能库 (第 6 步): the skills in the boss's shared folder, which ones gremlins may use (all start off), how often each
 * was used, and an agent's retelling of what one does now, for the boss to check (requirements 10, 41, 49, 50).
 */
export function SkillsPage({ hero }: { hero: Hero }) {
  const [view, setView] = useState<SkillLibraryView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'all' | 'on' | 'unused'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const [retelling, setRetelling] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [importing, setImporting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    window.cth.v8.skills().then(setView, e => setFailed(why(e)));
    void window.cth.getConfig().then(c => { const v8 = (c.v8 ?? {}) as V8Settings; setAgent(v8.shell === 'acp' ? v8.acp?.worker.agent ?? null : null); });
  }, []);

  const skills = view?.skills ?? [];
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase();
    return skills.filter(s => (only === 'on' ? s.enabled : only === 'unused' ? s.enabled && s.uses === 0 : true)
      && (!words || (s.name + ' ' + s.description + ' ' + (s.category ?? '')).toLowerCase().includes(words)));
  }, [skills, q, only]);
  const groups = useMemo(() => [...new Set(shown.map(s => s.category ?? '其他'))], [shown]);
  const on = skills.filter(s => s.enabled).length;

  const toggle = (ids: string[], value: boolean) => { window.cth.v8.skillsEnable(ids, value).then(setView, e => setProblem(why(e))); };
  // Requirement 41: bring skills in from GitHub (OpenMausBot's skill-fetch), and drop the ones nobody uses.
  const importLink = () => {
    if (!link.trim() || importing) return;
    setImporting(true); setProblem(null); setNote(null);
    window.cth.v8.skillImport(link.trim()).then(r => {
      setView(r.view);
      if ('error' in r) setProblem('没导进来：' + r.error);
      else { setLink(''); setNote(`导进来 ${r.added.length} 个：${r.added.join('、')}。默认关着，用得上再打开。${r.skipped.length ? `有 ${r.skipped.length} 个文件没带（隐藏文件、链接、太大的文件）。` : ''}`); }
    }, e => setProblem('没导进来：' + why(e))).finally(() => setImporting(false));
  };
  const remove = (s: LibrarySkill) => {
    setConfirm(null); setProblem(null);
    window.cth.v8.skillRemove(s.id).then(r => {
      setView(r.view);
      setNote(r.how === 'deleted' ? `「${s.name}」删掉了。` : `「${s.name}」移出了小怪工坊（共享技能库里的文件还在，别的程序照常用）。`);
    }, e => setProblem(why(e)));
  };
  const restore = () => { window.cth.v8.skillsRestore().then(v => { setView(v); setNote('移出过的技能都放回来了。'); }, e => setProblem(why(e))); };
  const retell = (s: LibrarySkill) => {
    if (!agent) return;
    setRetelling(s.id); setProblem(null);
    window.cth.v8.skillRetell(s.id, agent).then(setView, e => setProblem('没复述成：' + why(e))).finally(() => setRetelling(null));
  };

  return <section className="v8p v8a v8s" aria-label="技能库">
    <div className="v8a-head">
      <img className="v8-g v8p-hero" style={hero} src={art('tri', 'reading')} alt="" />
      <div><span className="v8-cap">技能库 · {view?.roots.join('、') || '还没有技能文件夹'}</span><h1>小怪能用的本事</h1>
        <p className="v8m-sub">{view ? `一共 ${skills.length} 个，开着 ${on} 个。新导进来的默认关着，你点开的小怪才用得上；小怪开工只看到名字，用到才取全文。` : failed ? '技能库没读出来：' + failed : '正在读技能文件夹…'}</p></div>
    </div>

    <div className="v8s-bar">
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="找技能：名字或说明里的字" aria-label="找技能" />
      {(['all', 'on', 'unused'] as const).map(k => <button key={k} type="button" className={'v8-chip' + (only === k ? ' is-on' : '')} onClick={() => setOnly(k)}>
        {k === 'all' ? '全部' : k === 'on' ? '开着的' : '开着但没用过'}</button>)}
      {problem && <small className="v8a-problem">{problem}</small>}
    </div>

    <div className="v8s-bar" aria-label="从 GitHub 导入技能">
      <input value={link} onChange={e => setLink(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') importLink(); }}
        placeholder="从 GitHub 导入：贴仓库、技能文件夹或 SKILL.md 的链接（也认 skills.sh）" aria-label="技能链接" />
      <button type="button" className="v8-send" disabled={!link.trim() || importing} onClick={importLink}>{importing ? '正在导入…' : '导入'}</button>
      <button type="button" className="v8-quiet-btn" onClick={restore}>放回移出过的</button>
      {note && <small className="v8m-sub">{note}</small>}
    </div>

    <div className="v8s-list">
      {groups.map(g => {
        const inGroup = shown.filter(s => (s.category ?? '其他') === g);
        const allOn = inGroup.every(s => s.enabled);
        return <div key={g} className="v8s-group">
          <div className="v8s-ghead"><b>{g}</b><small>{inGroup.length} 个</small>
            <button type="button" className="v8-quiet-btn" onClick={() => toggle(inGroup.map(s => s.id), !allOn)}>{allOn ? '这一类全关' : '这一类全开'}</button></div>
          {inGroup.map(s => <div key={s.id} className={'v8s-row' + (s.enabled ? ' is-on' : '')}>
            <label className="v8s-switch"><input type="checkbox" checked={s.enabled} onChange={e => toggle([s.id], e.target.checked)} aria-label={(s.enabled ? '关掉 ' : '打开 ') + s.name} /></label>
            <button type="button" className="v8s-name" onClick={() => setOpen(o => o === s.id ? null : s.id)} aria-expanded={open === s.id}>
              <b>{s.name}</b><small>{s.description || '没写说明'}</small></button>
            <span className="v8s-uses">{s.uses ? `用过 ${s.uses} 次 · ${day(s.lastUsed!)}` : '没用过'}</span>
            {open === s.id && <div className="v8s-more">
              {s.retold ? <p><span className="v8-cap">{s.retold.agent} 在 {day(s.retold.at)} 复述它现在做什么</span>{s.retold.text}</p>
                : <p className="v8m-sub">还没让 agent 复述过。复述是发一条真消息，会用掉一点额度。</p>}
              {s.source && <p className="v8m-sub">从 {s.source} 导入</p>}
              {confirm === s.id
                ? <p className="v8m-sub">{s.imported ? '删掉这个技能和它的文件？' : '从小怪工坊移出这个技能？共享技能库里的文件不动。'}
                  <button type="button" className="v8-quiet-btn" onClick={() => remove(s)}>{s.imported ? '删掉' : '移出'}</button>
                  <button type="button" className="v8-quiet-btn" onClick={() => setConfirm(null)}>算了</button></p>
                : <button type="button" className="v8-quiet-btn" onClick={() => setConfirm(s.id)}>{s.imported ? '删掉这个技能' : '移出小怪工坊'}</button>}
              <button type="button" className="v8-send" disabled={!agent || retelling !== null} onClick={() => retell(s)}>
                {retelling === s.id ? '正在复述…' : agent ? `让 ${agent === 'codex-acp' ? 'Codex' : agent === 'claude-acp' ? 'Claude' : agent} 复述一遍` : '先在设置里选好干活的 agent'}</button>
            </div>}
          </div>)}
        </div>;
      })}
      {view && !shown.length && <p className="v8m-sub">{skills.length ? '没有对得上的技能。' : '技能文件夹里没有技能（每个技能是一个带 SKILL.md 的文件夹）。'}</p>}
    </div>
  </section>;
}
