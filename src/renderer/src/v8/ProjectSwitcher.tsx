import { useEffect, useRef, useState } from 'react';

type Project = { key: string; root: string | null; name: string; createdAt: number; current: boolean; missing: boolean };

/**
 * The project name in the top bar is the way to another project. Each project keeps its own tickets; leaving one
 * pauses its gremlins, which pick up again when you come back, so the boss is asked first when any are working.
 */
export function ProjectSwitcher({ name, working, onSwitched }: { name: string; working: number; onSwitched(): void }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [confirm, setConfirm] = useState<{ root: string | null; name: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setProblem(null); setConfirm(null);
    void window.cth.v8.projects().then(setProjects, () => setProjects([]));
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc, true); };
  }, [open]);

  const go = async (root: string | null) => {
    setBusy(true);
    try {
      const c = await window.cth.getConfig();
      await window.cth.updateConfig({ v8: { ...(c.v8 ?? {}), projectRoot: root ?? undefined } });
      setOpen(false); setConfirm(null);
      onSwitched();
    } catch { setProblem('没切过去，再试一次。'); }
    finally { setBusy(false); }
  };
  const pick = (root: string | null, label: string) => { if (working > 0) setConfirm({ root, name: label }); else void go(root); };
  const choose = async () => {
    const f = await window.cth.v8.chooseFolder();
    if (!f) return;
    pick(f.path, f.name);
  };

  return <div className="v8-proj" ref={box}>
    <button type="button" className="v8-crumb v8-proj-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      小怪工坊<span>/</span>{name}<i aria-hidden="true">▾</i>
    </button>
    {open && <div className="v8-proj-menu v8-sticker" role="dialog" aria-label="切换项目">
      {confirm ? <div className="v8-proj-confirm">
        <p>工位上还有 {working} 张在干活。切到「{confirm.name}」后它们会先停下，回到这个项目时接着做。</p>
        <div className="v8-proj-acts">
          <button type="button" className="v8-btn" disabled={busy} onClick={() => { void go(confirm.root); }}>切过去</button>
          <button type="button" className="v8-proj-cancel" onClick={() => setConfirm(null)}>留在这里</button>
        </div>
      </div> : <>
        <span className="v8-cap">项目</span>
        <ul>{projects.map(p => <li key={p.key}>
          <button type="button" disabled={p.current || p.missing || busy} aria-current={p.current ? 'true' : undefined} onClick={() => pick(p.root, p.name)}>
            <b>{p.name}</b>
            <small>{p.missing ? '文件夹找不到了' : p.root ?? '不改任何文件的演示'}</small>
            {p.current && <em>当前</em>}
          </button>
        </li>)}</ul>
        <button type="button" className="v8-proj-open" disabled={busy} onClick={() => { void choose(); }}>＋ 打开别的文件夹…</button>
        {problem && <p className="v8-proj-problem" role="alert">{problem}</p>}
      </>}
    </div>}
  </div>;
}
