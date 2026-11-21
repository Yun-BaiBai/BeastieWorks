import { dateLocale, tr } from '@shared/i18n';
import './agents.css';
import { useEffect, useMemo, useState } from 'react';
import type { LibrarySkill, SkillLibraryView, SkillToolView } from '@shared/v8/skills';
import type { InstallSize } from '@shared/v8/agents';
import { sizeText } from '../InstallBox';
import type { V8Settings } from '@shared/v8/settings';
import { art } from '../gremlins';
import type { Hero } from './Pages';

const why = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
const day = (at: number) => new Date(at).toLocaleDateString(dateLocale(), { month: 'numeric', day: 'numeric' });

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
  const groups = useMemo(() => [...new Set(shown.map(s => s.category ?? tr('其他')))], [shown]);
  const on = skills.filter(s => s.enabled).length;
  const toolOf = (s: LibrarySkill) => view?.tools?.find(t => t.skill === s.id) ?? null;

  const toggle = (ids: string[], value: boolean) => { window.cth.v8.skillsEnable(ids, value).then(setView, e => setProblem(why(e))); };
  // Requirement 41: bring skills in from GitHub (OpenMausBot's skill-fetch), and drop the ones nobody uses.
  const importLink = () => {
    if (!link.trim() || importing) return;
    setImporting(true); setProblem(null); setNote(null);
    window.cth.v8.skillImport(link.trim()).then(r => {
      setView(r.view);
      if ('error' in r) setProblem(tr('没导进来：') + r.error);
      else { setLink(''); setNote(tr('导进来 {0} 个：{1}。默认关着，用得上再打开。{2}', [r.added.length, r.added.join(tr('、')), r.skipped.length ? tr('有 {0} 个文件没带（隐藏文件、链接、太大的文件）。', [r.skipped.length]) : ''])); }
    }, e => setProblem(tr('没导进来：') + why(e))).finally(() => setImporting(false));
  };
  const remove = (s: LibrarySkill) => {
    setConfirm(null); setProblem(null);
    window.cth.v8.skillRemove(s.id).then(r => {
      setView(r.view);
      setNote(r.how === 'deleted' ? tr('「{0}」删掉了。', [s.name]) : tr('「{0}」移出了小怪工坊（共享技能库里的文件还在，别的程序照常用）。', [s.name]));
    }, e => setProblem(why(e)));
  };
  const restore = () => { window.cth.v8.skillsRestore().then(v => { setView(v); setNote(tr('移出过的技能都放回来了。')); }, e => setProblem(why(e))); };
  const retell = (s: LibrarySkill) => {
    if (!agent) return;
    setRetelling(s.id); setProblem(null);
    window.cth.v8.skillRetell(s.id, agent).then(setView, e => setProblem('没复述成：' + why(e))).finally(() => setRetelling(null));
  };

  return <section className="v8p v8a v8s" aria-label={tr('技能库')}>
    <div className="v8a-head">
      <img className="v8-g v8p-hero" style={hero} src={art('tri', 'reading')} alt="" />
      <div><span className="v8-cap">{tr('技能库 · ')}{view?.roots.join(tr('、')) || tr('还没有技能文件夹')}</span><h1>{tr('小怪能用的本事')}</h1>
        <p className="v8m-sub">{view ? tr('一共 {0} 个，开着 {1} 个。自带的默认开着，新导进来的默认关着，开着的小怪才用得上；小怪开工只看到名字，用到才取全文。', [skills.length, on]) : failed ? tr('技能库没读出来：') + failed : tr('正在读技能文件夹…')}</p></div>
    </div>

    <div className="v8s-bar">
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('找技能：名字或说明里的字')} aria-label={tr('找技能')} />
      {(['all', 'on', 'unused'] as const).map(k => <button key={k} type="button" className={'v8-chip' + (only === k ? ' is-on' : '')} onClick={() => setOnly(k)}>
        {k === 'all' ? tr('全部') : k === 'on' ? tr('开着的') : tr('开着但没用过')}</button>)}
      {problem && <small className="v8a-problem">{problem}</small>}
    </div>

    <div className="v8s-bar" aria-label={tr('从 GitHub 导入技能')}>
      <input value={link} onChange={e => setLink(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') importLink(); }}
        placeholder={tr('从 GitHub 导入：贴仓库、技能文件夹或 SKILL.md 的链接（也认 skills.sh）')} aria-label={tr('技能链接')} />
      <button type="button" className="v8-send" disabled={!link.trim() || importing} onClick={importLink}>{importing ? tr('正在导入…') : tr('导入')}</button>
      <button type="button" className="v8-quiet-btn" onClick={restore}>{tr('放回移出过的')}</button>
      {note && <small className="v8m-sub">{note}</small>}
    </div>

    <div className="v8s-list">
      {groups.map(g => {
        const inGroup = shown.filter(s => (s.category ?? tr('其他')) === g);
        const allOn = inGroup.every(s => s.enabled);
        return <div key={g} className="v8s-group">
          <div className="v8s-ghead"><b>{g}</b><small>{inGroup.length} {tr(' 个')}</small>
            <button type="button" className="v8-quiet-btn" onClick={() => toggle(inGroup.map(s => s.id), !allOn)}>{allOn ? tr('这一类全关') : tr('这一类全开')}</button></div>
          {inGroup.map(s => <div key={s.id} className={'v8s-row' + (s.enabled ? ' is-on' : '')}>
            <label className="v8s-switch"><input type="checkbox" checked={s.enabled} onChange={e => toggle([s.id], e.target.checked)} aria-label={(s.enabled ? tr('关掉 ') : tr('打开 ')) + s.name} /></label>
            <button type="button" className="v8s-name" onClick={() => setOpen(o => o === s.id ? null : s.id)} aria-expanded={open === s.id}>
              <b>{s.name}</b><small>{s.description || tr('没写说明')}</small></button>
            <span className="v8s-uses">{toolOf(s) && needsInstall(toolOf(s)!) ? tr('工具没装 · ') : ''}{s.uses ? tr('用过 {0} 次 · {1}', [s.uses, day(s.lastUsed!)]) : tr('没用过')}</span>
            {open === s.id && <div className="v8s-more">
              {s.retold ? <p><span className="v8-cap">{s.retold.agent} {tr(' 在 ')}{day(s.retold.at)} {tr(' 复述它现在做什么')}</span>{s.retold.text}</p>
                : <p className="v8m-sub">{tr('还没让 agent 复述过。复述是发一条真消息，会用掉一点额度。')}</p>}
              {s.source && <p className="v8m-sub">{tr('从 ')}{s.source} {tr(' 导入')}</p>}
              {toolOf(s) && <ToolBox tool={toolOf(s)!} onView={setView} />}
              {confirm === s.id
                ? <p className="v8m-sub">{s.imported ? tr('删掉这个技能和它的文件？') : tr('从小怪工坊移出这个技能？共享技能库里的文件不动。')}
                  <button type="button" className="v8-quiet-btn" onClick={() => remove(s)}>{s.imported ? tr('删掉') : tr('移出')}</button>
                  <button type="button" className="v8-quiet-btn" onClick={() => setConfirm(null)}>{tr('算了')}</button></p>
                : <button type="button" className="v8-quiet-btn" onClick={() => setConfirm(s.id)}>{s.imported ? tr('删掉这个技能') : tr('移出小怪工坊')}</button>}
              <button type="button" className="v8-send" disabled={!agent || retelling !== null} onClick={() => retell(s)}>
                {retelling === s.id ? tr('正在复述…') : agent ? tr('让 {0} 复述一遍', [agent === 'codex-acp' ? 'Codex' : agent === 'claude-acp' ? 'Claude' : agent]) : tr('先在设置里选好干活的 agent')}</button>
            </div>}
          </div>)}
        </div>;
      })}
      {view && !shown.length && <p className="v8m-sub">{skills.length ? tr('没有对得上的技能。') : tr('技能文件夹里没有技能（每个技能是一个带 SKILL.md 的文件夹）。')}</p>}
    </div>
  </section>;
}

const needsInstall = (t: SkillToolView) => t.state === 'not_installed' || t.state === 'needs_uv' || t.state === 'missing_basics';

/**
 * A5: the command-line tool behind a skill that ships with the app. The size is asked first (nothing downloaded), and
 * the boss presses once more to install it into the app's own folder.
 */
function ToolBox({ tool, onView }: { tool: SkillToolView; onView(v: SkillLibraryView): void }) {
  const [size, setSize] = useState<InstallSize | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setSize(null); setProblem(null);
    if (tool.state === 'not_installed') window.cth.v8.skillToolSize(tool.skill).then(setSize, e => setSize(why(e)));
  }, [tool.skill, tool.state]);
  const install = () => {
    setBusy(true); setProblem(null);
    window.cth.v8.skillToolInstall(tool.skill).then(onView, e => setProblem(tr('没装成：') + why(e))).finally(() => setBusy(false));
  };
  const remove = () => {
    if (!sure) { setSure(true); return; }
    setBusy(true); setProblem(null);
    window.cth.v8.skillToolRemove(tool.skill).then(onView, e => setProblem(tr('没卸成：') + why(e))).finally(() => { setBusy(false); setSure(false); });
  };
  const c = tool.command;
  return <div className="v8s-tool">
    <span className="v8-cap">{tr('配套工具 · ')}{c}</span>
    {tool.state === 'installed' && <p className="v8m-sub">{tr('装好了（版本 ')}{tool.version}{tr('），在小怪工坊自己的文件夹里，小怪都能用。')}<button type="button" className="v8-quiet-btn" disabled={busy} onClick={remove}>{busy ? tr('正在卸载…') : sure ? tr('确定卸载？再点一次') : tr('卸载')}</button>
      {sure && !busy && <button type="button" className="v8-quiet-btn" onClick={() => setSure(false)}>{tr('不卸了')}</button>}</p>}
    {tool.state === 'on_computer' && <p className="v8m-sub">{tr('电脑上已经装了 ')}{c}{tr('，直接用它。')}</p>}
    {tool.state === 'ready' && <p className="v8m-sub">{tr('不用装：它用 npx 现取（电脑上没有 npx 时用小怪工坊自带的）。')}</p>}
    {tool.state === 'missing_basics' && <p className="v8m-sub">{tr('这台电脑上没有 npx，小怪工坊这一版也没带 npm，暂时用不了。')}</p>}
    {tool.state === 'needs_uv' && <p className="v8m-sub">{c} {tr(' 按它自己的说明用 uv 装，这台电脑还没有 uv。先装好 uv（docs.astral.sh/uv），这里就会出现安装按钮。')}</p>}
    {tool.state === 'not_installed' && <>
      <p className="v8m-sub">{c} {tr(' 还没装。')}{size === null ? tr('正在问要下载多大…（不下载）') : typeof size === 'string' ? tr('大小没问到：') + size : sizeText(size) + tr('。')}{tr('装在小怪工坊自己的文件夹里，不动电脑上别的东西。')}</p>
      <button type="button" className="v8-send" disabled={busy || size === null} onClick={install}>{busy ? tr('正在下载和安装…') : tr('下载并装上')}</button>
    </>}
    {problem && <small className="v8a-problem">{problem}</small>}
  </div>;
}
