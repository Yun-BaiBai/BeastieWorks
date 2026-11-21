import { tr, dateLocale } from '@shared/i18n';
import './agents.css';
import { useEffect, useState } from 'react';
import type { NotesView, ProjectNote } from '@shared/v8/notes';
import type { V8Settings } from '@shared/v8/settings';
import { art } from '../gremlins';
import type { Hero } from './Pages';

const why = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
const day = (at: number) => new Date(at).toLocaleDateString(dateLocale(), { month: 'numeric', day: 'numeric' });
const kindWord = (k: ProjectNote['kind']) => k === 'preference' ? tr('偏好') : k === 'decision' ? tr('定下的事') : k === 'lesson' ? tr('踩过的坑') : tr('设定');

/**
 * 项目笔记 (A10): what this project's notebook holds, which gremlins get with every new job, under the boss's own words.
 * The boss sees every line and where it came from, and can change it, delete it, write his own, or turn the writing off.
 */
export function NotesPage({ hero, project }: { hero: Hero; project: string }) {
  const [view, setView] = useState<NotesView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [sure, setSure] = useState<number | null>(null);

  useEffect(() => { window.cth.v8.notes().then(setView, e => setProblem(why(e))); }, []);
  const done = (p: Promise<NotesView>) => { setProblem(null); p.then(v => { setView(v); setEditing(null); setSure(null); }, e => setProblem(why(e))); };
  const setCapture = (on: boolean) => {
    void window.cth.getConfig().then(c => window.cth.updateConfig({ ...c, v8: { ...((c.v8 ?? {}) as V8Settings), notes: on } }))
      .then(() => window.cth.v8.notes()).then(setView, e => setProblem(why(e)));
  };
  const add = () => { if (draft.trim()) { done(window.cth.v8.noteAdd(draft.trim())); setDraft(''); } };
  const notes = view?.notes ?? [];

  return <section className="v8p v8a v8s" aria-label={tr('项目笔记')}>
    <div className="v8a-head">
      <img className="v8-g v8p-hero" style={hero} src={art('boss', 'checking')} alt="" />
      <div><span className="v8-cap">{tr('项目笔记 · {0}', [project])}</span><h1>{tr('小怪要记住的事')}</h1>
        <p className="v8m-sub">{tr('这个项目以前的活里记下的偏好、设定、定下的事和踩过的坑。小怪开工时会带上，但你的原话照样原样交给它，冲突时以原话为准。')}</p></div>
    </div>

    <div className="v8s-bar">
      <label className="v8a-radio v8n-capture"><input type="checkbox" checked={!!view?.capture} disabled={!view?.canCapture} onChange={e => setCapture(e.target.checked)} />
        <span>{view && !view.canCapture ? tr('主理小怪用本机 agent 时才能自动记') : tr('每收下一张工单，让主理小怪记一笔（会用掉它一点额度）')}</span></label>
      {problem && <small className="v8a-problem">{problem}</small>}
    </div>

    <div className="v8s-bar" aria-label={tr('自己写一条')}>
      <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) add(); }}
        placeholder={tr('自己写一条，比如：人物名字一律用全名')} aria-label={tr('自己写一条')} />
      <button type="button" className="v8-send" disabled={!draft.trim()} onClick={add}>{tr('记下')}</button>
    </div>

    <div className="v8s-list">
      {!view ? <p className="v8m-sub">{problem ? '' : tr('正在读笔记…')}</p>
        : !notes.length ? <p className="v8m-sub">{tr('还没有笔记。收下工单后会自动记，也可以自己写。')}</p>
        : [...notes].reverse().map(n => <div key={n.id} className="v8s-row is-on">
          <span className="v8-chip">{kindWord(n.kind)}</span>
          {editing?.id === n.id
            ? <input className="v8n-edit" value={editing.text} autoFocus onChange={e => setEditing({ id: n.id, text: e.target.value })} aria-label={tr('改这条笔记')}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) done(window.cth.v8.noteEdit(n.id, editing.text)); if (e.key === 'Escape') setEditing(null); }} />
            : <div className="v8s-name"><b>{n.text}</b>
              <small>{n.ticketId ? tr('从工单 #{0} 记的 · {1}', [n.ticketId, day(n.at)]) : tr('你自己写的 · {0}', [day(n.at)])}{n.evidence ? tr(' · 依据：「{0}」', [n.evidence]) : ''}</small></div>}
          <span className="v8s-uses">
            {editing?.id === n.id
              ? <><button type="button" className="v8-quiet-btn" onClick={() => done(window.cth.v8.noteEdit(n.id, editing.text))}>{tr('存好')}</button>
                <button type="button" className="v8-quiet-btn" onClick={() => setEditing(null)}>{tr('算了')}</button></>
              : sure === n.id
                ? <><button type="button" className="v8-quiet-btn" onClick={() => done(window.cth.v8.noteRemove(n.id))}>{tr('确定删掉')}</button>
                  <button type="button" className="v8-quiet-btn" onClick={() => setSure(null)}>{tr('算了')}</button></>
                : <><button type="button" className="v8-quiet-btn" onClick={() => setEditing({ id: n.id, text: n.text })}>{tr('改')}</button>
                  <button type="button" className="v8-quiet-btn" onClick={() => setSure(n.id)}>{tr('删掉')}</button></>}
          </span>
        </div>)}
    </div>
  </section>;
}
