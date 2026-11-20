import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentQuirk } from './acpQuirks';
import type { SignIn } from './agentSignIn';

/**
 * More agents from the official list (requirement 13: the common agents should work, not only the boss's), each with
 * the name people use, how to tell whether the person is signed in, and where they sign in.
 *
 * Ported from OpenMausBot (Apache-2.0, server/drivers/acp/<agent>.ts): where each agent keeps its sign-in, which key
 * signs it in instead, and its own sign-in command. Only files and keys are looked at; nothing is read out of them
 * except whether a sign-in is there. Agents not listed here still install and run; the roster then says
 * "登录没登录要说一句话才知道".
 */

type Env = NodeJS.ProcessEnv;
const home = (env: Env) => env.USERPROFILE || env.HOME || homedir();
const filled = (v: string | undefined) => Boolean(v && v.trim());
const yesNo = (ok: boolean): SignIn => ok ? 'yes' : 'no';
function readJson(file: string): Record<string, unknown> | null {
  try { const v = JSON.parse(readFileSync(file, 'utf8')) as unknown; return v && typeof v === 'object' ? v as Record<string, unknown> : null; } catch { return null; }
}

/** gemini.ts: GEMINI_API_KEY / GOOGLE_API_KEY, or ~/.gemini/oauth_creds.json with a token in it. */
export function geminiSignedIn(env: Env): SignIn {
  if (filled(env.GEMINI_API_KEY) || filled(env.GOOGLE_API_KEY)) return 'yes';
  const c = readJson(path.join(home(env), '.gemini', 'oauth_creds.json'));
  return yesNo(!!c && (typeof c.refresh_token === 'string' && !!c.refresh_token || typeof c.access_token === 'string' && !!c.access_token));
}

/** kimi.ts: credentials/kimi-code.json (or kimi-code-env-<hash>.json) under KIMI_CODE_HOME or ~/.kimi-code; a file with
 *  both tokens empty is a sign-in the provider refused. */
export function kimiSignedIn(env: Env): SignIn {
  const dir = path.join(env.KIMI_CODE_HOME || path.join(home(env), '.kimi-code'), 'credentials');
  let names: string[];
  try { names = readdirSync(dir); } catch { return 'no'; }
  return yesNo(names.some(n => /^kimi-code(?:-env-[0-9a-f]+)?\.json$/.test(n) && (() => {
    const t = readJson(path.join(dir, n));
    return !!t && !(t.access_token === '' && t.refresh_token === '');
  })()));
}

/** kiro.ts: KIRO_API_KEY, or a token in kiro-cli's data.sqlite3 (%LOCALAPPDATA%\kiro-cli on Windows). The database is
 *  only checked for being there, not opened. */
export function kiroSignedIn(env: Env): SignIn {
  if (filled(env.KIRO_API_KEY)) return 'yes';
  const dir = process.platform === 'win32' ? path.join(env.LOCALAPPDATA || path.join(home(env), 'AppData', 'Local'), 'kiro-cli')
    : process.platform === 'darwin' ? path.join(home(env), 'Library', 'Application Support', 'kiro-cli')
      : path.join(env.XDG_DATA_HOME || path.join(home(env), '.local', 'share'), 'kiro-cli');
  return existsSync(path.join(dir, 'data.sqlite3')) ? 'unknown' : 'no';
}

/** devin.ts: WINDSURF_API_KEY, or credentials.toml that `devin auth login` writes (%APPDATA%\devin on Windows). */
export function devinSignedIn(env: Env): SignIn {
  if (filled(env.WINDSURF_API_KEY)) return 'yes';
  const dir = process.platform === 'win32' ? path.join(env.APPDATA || path.join(home(env), 'AppData', 'Roaming'), 'devin')
    : path.join(env.XDG_CONFIG_HOME || path.join(home(env), '.config'), 'devin');
  return yesNo(existsSync(path.join(dir, 'credentials.toml')));
}

/** grok.ts: auth.json in GROK_HOME or ~/.grok. */
export function grokSignedIn(env: Env): SignIn {
  return yesNo(existsSync(path.join(env.GROK_HOME || path.join(home(env), '.grok'), 'auth.json')));
}

/** droid.ts: FACTORY_API_KEY, or one of Factory's auth files in ~/.factory. */
export function droidSignedIn(env: Env): SignIn {
  if (filled(env.FACTORY_API_KEY)) return 'yes';
  const dir = path.join(env.FACTORY_HOME_OVERRIDE || home(env), '.factory');
  return yesNo(['auth.v2.file', 'auth.v2.loginkeychain', 'auth.v2.keyring'].some(n => existsSync(path.join(dir, n))));
}

/** copilot.ts: a token in COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN signs it in; the stored login can only be told
 *  by asking Copilot itself, so without a token it is unknown until it is used. */
export function copilotSignedIn(env: Env): SignIn {
  return ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].some(k => filled(env[k])) ? 'yes' : 'unknown';
}

/** cline.ts: CLINE_API_KEY, or a provider saved by `cline auth`; the saved file's place varies, so without the key it
 *  is unknown until it is used. */
export function clineSignedIn(env: Env): SignIn {
  return filled(env.CLINE_API_KEY) ? 'yes' : 'unknown';
}

export const MORE_QUIRKS: Record<string, AgentQuirk> = {
  gemini: {
    displayName: 'Gemini',
    signIn: (_l, env) => geminiSignedIn(env),
    signInHelp: '要先登录一次 Gemini：在终端里运行 gemini，按提示用 Google 账号登录；或者设好 GEMINI_API_KEY。',
  },
  'github-copilot-cli': {
    displayName: 'GitHub Copilot',
    signIn: (_l, env) => copilotSignedIn(env),
    signInHelp: '要先登录一次 GitHub Copilot：在终端里运行 copilot login。',
  },
  cursor: {
    displayName: 'Cursor',
    signInHelp: '要先登录一次 Cursor：在终端里运行 cursor-agent login；或者设好 CURSOR_API_KEY。',
  },
  'kimi-code': {
    displayName: 'Kimi',
    signIn: (_l, env) => kimiSignedIn(env),
    signInHelp: '要先登录一次 Kimi：在终端里运行 kimi，按提示用 Kimi 账号登录。',
  },
  kiro: {
    displayName: 'Kiro',
    signIn: (_l, env) => kiroSignedIn(env),
    signInHelp: '要先登录一次 Kiro：在终端里运行 kiro-cli login；或者设好 KIRO_API_KEY。',
  },
  cline: {
    displayName: 'Cline',
    signIn: (_l, env) => clineSignedIn(env),
    signInHelp: '要先设置一次 Cline：在终端里运行 cline auth；或者设好 CLINE_API_KEY。',
  },
  'factory-droid': {
    displayName: 'Droid',
    signIn: (_l, env) => droidSignedIn(env),
    signInHelp: '要先登录一次 Droid：在终端里运行 droid 并登录；或者设好 FACTORY_API_KEY。',
  },
  devin: {
    displayName: 'Devin',
    signIn: (_l, env) => devinSignedIn(env),
    signInHelp: '要先登录一次 Devin：在终端里运行 devin auth login；或者设好 WINDSURF_API_KEY。',
  },
  'qwen-code': {
    displayName: 'Qwen',
    signInHelp: '要先设置一次 Qwen：在终端里运行 qwen，按提示登录或填好模型来源。',
  },
  'grok-build': {
    displayName: 'Grok',
    signIn: (_l, env) => grokSignedIn(env),
    signInHelp: '要先登录一次 Grok：在终端里运行 grok login。',
  },
  opencode: {
    displayName: 'OpenCode',
    signInHelp: '要先给 OpenCode 配一个模型来源：在终端里运行 opencode auth login。',
  },
};
