import { tr } from '../../shared/i18n';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { probeAcpAgent, type AcpHandshake, type AcpShellOptions } from './acpShell';

/**
 * A14: Antigravity with the sign-in already on this computer.
 *
 * Ported from Orca (src/main/antigravity/antigravity-host-acp.ts and antigravity-acp-launch-spec.ts): when the
 * computer has Google's Antigravity CLI (`agy`, 1.5.2 or newer) and it is signed in, Orca starts `agy acp` instead of
 * its own ACP server, so the person's own sign-in is used and nothing is signed in again.
 *
 * Found 2026-11-21 on the boss's computer: the Antigravity editor keeps its Google sign-in where `agy` reads it
 * (Windows Credential Manager, "gemini:antigravity"), so `agy` on the same computer uses the editor's sign-in. The
 * editor alone has no `agy` and no ACP of its own (its `agentapi` only starts conversations inside the editor), so
 * without `agy` the app keeps the separate ACP server and its own sign-in (antigravityLogin.ts).
 *
 * Only the name of the credential is looked at, never what is in it.
 */

export const AGY_MIN_VERSION = '1.5.2';
const RECHECK_MS = 5 * 60_000;
type Env = NodeJS.ProcessEnv;
const home = (env: Env) => env.USERPROFILE || env.HOME || homedir();

/** `agy` on PATH, or where Google's installer puts it (~/.local/bin). */
export function findAgy(env: Env): string | null {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  const names = process.platform === 'win32' ? ['agy.exe'] : ['agy'];
  for (const dir of [...(env[key] ?? '').split(path.delimiter).filter(Boolean), path.join(home(env), '.local', 'bin')]) {
    for (const n of names) { const f = path.join(dir, n); try { if (statSync(f).isFile()) return f; } catch { /* not here */ } }
  }
  return null;
}

function newer(version: string, min: string): boolean {
  const a = version.split(/[.+-]/).slice(0, 3).map(Number), b = min.split('.').map(Number);
  if (a.length < 3 || a.some(n => !Number.isFinite(n))) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

/** Orca's isCompatibleAntigravityHostAcp. */
export function agyCompatible(h: AcpHandshake): boolean {
  return h.infoName === 'Antigravity ACP Server' && !!h.agentVersion && newer(h.agentVersion, AGY_MIN_VERSION)
    && h.protocolVersion === 1 && h.canLoadSession && h.canResume === true && h.canList === true;
}

/** agy's settings choose an API-key model provider: then it is not the person's account sign-in. */
export function agyUsesApiKey(env: Env): boolean {
  let text: string;
  try { text = readFileSync(path.join(home(env), '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'); } catch { return false; }
  try { const s = JSON.parse(text) as { modelProvider?: unknown }; return Boolean(s && typeof s === 'object' && s.modelProvider); } catch { return true; }
}

/** Whether the computer holds an Antigravity sign-in (the editor's or agy's): agy's token file, or the credential's name. */
export function antigravitySignInHeld(env: Env, listCredential: () => Promise<boolean> = windowsCredential): Promise<boolean> {
  if (existsSync(path.join(home(env), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))) return Promise.resolve(true);
  return process.platform === 'win32' ? listCredential() : Promise.resolve(false);
}

/** `cmdkey /list:gemini:antigravity` lists the entry's name when it is there; it never shows the secret. */
function windowsCredential(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('cmdkey', ['/list:gemini:antigravity'], { timeout: 5000, windowsHide: true, encoding: 'buffer' }, (_e, out) => {
      // The first line repeats what was asked (in the system's language); an entry is listed below it.
      const text = Buffer.isBuffer(out) ? out.toString('latin1') : String(out ?? '');
      resolve(/gemini:antigravity\b/i.test(text.split(/\r?\n/).slice(1).join('\n')));
    });
  });
}

type Check = { identity: string; answer: Promise<boolean>; retryAt: number | null };
const checks = new Map<string, Check>();

/** Whether `agy acp` answers as a compatible server (a handshake only: no message, no quota). Kept per program file. */
export function agyReady(agy: string, env: Env, probe: typeof probeAcpAgent = probeAcpAgent, now = Date.now): Promise<boolean> {
  let st; try { st = statSync(agy); } catch { return Promise.resolve(false); }
  const identity = `${st.size}:${st.mtimeMs}`;
  const had = checks.get(agy);
  if (had && had.identity === identity && (had.retryAt === null || now() < had.retryAt)) return had.answer;
  const check: Check = { identity, retryAt: now() + RECHECK_MS, answer: Promise.resolve(false) };
  check.answer = probe({ label: 'Antigravity', command: agy, args: ['acp'], env: { ...NO_KEYS }, readyTimeoutMs: 5000 }, tmpdir())
    .then(h => { if (!agyCompatible(h)) check.retryAt = null; return agyCompatible(h); }, () => false);
  checks.set(agy, check);
  return check.answer;
}

/** An inherited Gemini key switches agy to key sign-in, which its models refuse (Orca's scrubAgyHostApiKeys). */
const NO_KEYS: Record<string, string> = { GEMINI_API_KEY: '', GOOGLE_API_KEY: '' };

/**
 * The launch to use instead of the separate server: `agy acp`, when agy is here, new enough, signed in with an account
 * (not an API key). Null otherwise.
 */
export async function hostAgy(env: Env, o: { probe?: typeof probeAcpAgent; listCredential?: () => Promise<boolean> } = {}): Promise<{ launch: AcpShellOptions; note: string } | null> {
  const agy = findAgy(env);
  if (!agy || agyUsesApiKey(env)) return null;
  if (!await antigravitySignInHeld(env, o.listCredential)) return null;
  if (!await agyReady(agy, env, o.probe)) return null;
  return { launch: { label: 'Antigravity', command: agy, args: ['acp'], env: { ...NO_KEYS } }, note: tr('用的是这台电脑上 Antigravity 的登录（和编辑器同一个），不用另登。') };
}
