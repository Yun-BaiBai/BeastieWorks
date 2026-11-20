import { useEffect, useState } from 'react';
import type { InstallSize, RosterRow, RosterView } from '@shared/v8/agents';

const why = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
const mb = (b: number) => b >= 1024 * 1024 ? (b / 1024 / 1024).toFixed(b >= 10 * 1024 * 1024 ? 0 : 1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
export function sizeText(s: InstallSize): string {
  const base = s.bytes === null ? `要从 ${s.from} 下载，大小对方没说`
    : s.kind === 'archive' ? `要从 ${s.from} 下载约 ${mb(s.bytes)}` : `要从 ${s.from} 下载，主包约 ${mb(s.bytes)}，加上它用到的其他包会更大`;
  return s.note ? `${base}；${s.note}` : base;
}

/**
 * 第 7 步: install, update or remove one agent from the official list. The download size is shown before anything is
 * downloaded, and the person clicks once more to go ahead. Installs go into the app's own folder.
 */
export function InstallBox({ row, onDone }: { row: RosterRow; onDone(view: RosterView): void }) {
  const [size, setSize] = useState<InstallSize | string | null>(null);
  const [busy, setBusy] = useState<'install' | 'remove' | null>(null);
  const [sure, setSure] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // missing_program with an install of ours: the agent's own program is missing (Codex on a computer without Codex).
  const repair = row.state === 'missing_program' && !!row.installed;
  const wantsDownload = (row.state === 'not_installed' && row.canInstall) || !!row.installed?.update || repair;
  useEffect(() => {
    setSize(null); setSure(false); setProblem(null);
    if (!wantsDownload) return;
    window.cth.v8.agentSize(row.id).then(setSize, e => setSize(why(e)));
  }, [row.id, wantsDownload]);

  const install = () => {
    setBusy('install'); setProblem(null);
    window.cth.v8.agentInstall(row.id).then(onDone, e => setProblem('没装成：' + why(e))).finally(() => setBusy(null));
  };
  const remove = () => {
    if (!sure) { setSure(true); return; }
    setBusy('remove'); setProblem(null);
    window.cth.v8.agentUninstall(row.id).then(onDone, e => setProblem('没卸成：' + why(e))).finally(() => { setBusy(null); setSure(false); });
  };
  const sizeLine = size === null ? '正在问要下载多大…（不下载）' : typeof size === 'string' ? '大小没问到：' + size : sizeText(size) + '。';

  if (row.state === 'not_installed' && row.canInstall) {
    return <div className="v8a-signin">
      <p>{row.name} 还没装。{sizeLine}装在小怪工坊自己的文件夹里，不动电脑上别的东西。</p>
      <button type="button" className="v8-send" disabled={busy !== null || size === null} onClick={install}>{busy === 'install' ? '正在下载和安装…' : '下载并装上'}</button>
      {problem && <small className="v8a-problem">{problem}</small>}
    </div>;
  }
  if (repair) {
    return <div className="v8a-signin">
      <p>{row.note} {sizeLine}</p>
      <button type="button" className="v8-send" disabled={busy !== null || size === null} onClick={install}>{busy === 'install' ? '正在下载和安装…' : '重新装'}</button>
      {problem && <small className="v8a-problem">{problem}</small>}
    </div>;
  }
  if (!row.installed) return null;
  return <div className="v8a-install">
    <span className="v8-cap">版本 {row.installed.version}{row.installed.update ? ` · 有新版 ${row.installed.update}` : ' · 是最新的'}</span>
    {row.installed.update && <p className="v8m-sub">{sizeLine}</p>}
    <div className="v8p-acts">
      {row.installed.update && <button type="button" className="v8p-act is-go" disabled={busy !== null || size === null} onClick={install}>{busy === 'install' ? '正在更新…' : `更新到 ${row.installed.update}`}</button>}
      <button type="button" className="v8p-act" disabled={busy !== null} onClick={remove}>{busy === 'remove' ? '正在卸载…' : sure ? '确定卸载？再点一次' : '卸载'}</button>
      {sure && busy === null && <button type="button" className="v8-quiet-btn" onClick={() => setSure(false)}>不卸了</button>}
    </div>
    {problem && <small className="v8a-problem">{problem}</small>}
  </div>;
}
