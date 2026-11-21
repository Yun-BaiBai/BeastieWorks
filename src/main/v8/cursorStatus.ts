import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { hardKillTree } from '../procKill';
import type { SignIn } from './agentSignIn';

/** A9: Cursor's own `status --format json` (OpenMausBot acp/cursor.ts, Apache-2.0), and running a sign-in program. */

type Env = NodeJS.ProcessEnv;

export interface DeviceCli { command: string; args: string[]; env?: Record<string, string> }

/** cursor.ts decodeCursorAuthStatus: the first flag of these that says yes or no. */
export function cursorStatus(code: number | null, output: string): SignIn {
  if (code !== 0) return 'unknown';
  let v: unknown = null;
  const t = output.trim(), start = t.search(/[{[]/);
  try { v = JSON.parse(t); } catch {
    for (let end = t.length; start >= 0 && end > start + 1; end--) { try { v = JSON.parse(t.slice(start, end)); break; } catch { /* shorter */ } }
  }
  const rec = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  if (!rec) return 'unknown';
  const auth = rec.auth && typeof rec.auth === 'object' ? rec.auth as Record<string, unknown> : null;
  for (const c of [rec.isAuthenticated, rec.authenticated, rec.loggedIn, rec.logged_in, auth?.isAuthenticated, auth?.authenticated, rec.status, auth?.status]) {
    if (c === true) return 'yes';
    if (c === false) return 'no';
    if (typeof c === 'string') {
      const s = c.trim().toLowerCase();
      if (['true', 'authenticated', 'logged_in', 'logged-in', 'yes'].includes(s)) return 'yes';
      if (['false', 'unauthenticated', 'logged_out', 'logged-out', 'no'].includes(s)) return 'no';
    }
  }
  return 'unknown';
}

export const MAX_OUTPUT = 16_384;

export function exec(cli: DeviceCli, args: string[], env: Env, timeoutMs = 8000): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn(cli.command, [...cli.args, ...args], { env: { ...env, ...(cli.env ?? {}), NO_COLOR: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { resolve({ code: null, output: '' }); return; }
    child.stdin.end();
    let out = '';
    const take = (d: Buffer) => { if (out.length < MAX_OUTPUT) out += d.toString('utf8'); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const timer = setTimeout(() => { if (child.pid) hardKillTree(child.pid); resolve({ code: null, output: '' }); }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); resolve({ code: null, output: '' }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, output: stripVTControlCharacters(out) }); });
  });
}


/** The roster's question for Cursor: its launch is `cursor-agent acp`; the same program answers `status`. */
export async function cursorSignedIn(launch: DeviceCli, env: NodeJS.ProcessEnv): Promise<SignIn> {
  if (launch.args.at(-1) !== 'acp') return 'unknown';
  const r = await exec({ command: launch.command, args: launch.args.slice(0, -1), ...(launch.env ? { env: launch.env } : {}) }, ['status', '--format', 'json'], env);
  return cursorStatus(r.code, r.output);
}
