import { tr } from '../shared/i18n';
import { spawn } from 'node:child_process';

/**
 * A4 语音输入: Windows' own voice typing (Win+H). Free, no key, works in any text box of the app (tried 2026-11-21:
 * the "正在聆听…" bar opens over the talk bar). The mic button focuses the text box and presses Win+H for the boss;
 * what he says is typed into the box, and he sends it himself.
 *
 * Electron cannot press the Windows key, so a short PowerShell does it with user32's keybd_event.
 */
const SCRIPT = `Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);'
[W.K]::keybd_event(0x5B,0,0,[UIntPtr]::Zero); [W.K]::keybd_event(0x48,0,0,[UIntPtr]::Zero); [W.K]::keybd_event(0x48,0,2,[UIntPtr]::Zero); [W.K]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)`;

export function dictate(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: tr('语音输入现在只接了 Windows 自带的（Win+H）。') });
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, error: tr('打开语音输入超时了，可以直接按 Win+H。') }); }, 10_000);
    child.once('error', e => { clearTimeout(timer); resolve({ ok: false, error: tr('打不开语音输入：') + e.message + tr('。可以直接按 Win+H。') }); });
    child.once('exit', code => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, error: tr('打不开语音输入，可以直接按 Win+H。') }); });
  });
}
