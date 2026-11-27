import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Which agents the person already uses on this computer, though the app has not connected them yet (老板 2026-11-27:
 * a fresh install listed only DeepSeek, while Codex, Claude and Antigravity were all on the computer; requirement 2:
 * the agents are the person's own). Like Orca's launch specs, an agent counts as here when its own program is on PATH
 * or its own folder in the home folder exists. Nothing is started and no credential is read: only whether files exist.
 */
export interface OnComputer {
  /** True when the agent's own sign-in file is there; null when this cannot be told from files alone. */
  signedIn: boolean | null;
}

type Env = NodeJS.ProcessEnv;
const win = process.platform === 'win32';
const home = (env: Env) => env.USERPROFILE || env.HOME || os.homedir();
const appData = (env: Env) => env.APPDATA || path.join(home(env), 'AppData', 'Roaming');

function onPath(names: string[], env: Env): boolean {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  const exts = win ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env[key] ?? '').split(path.delimiter).filter(Boolean)) {
    for (const n of names) for (const x of exts) { try { if (statSync(path.join(dir, n + x)).isFile()) return true; } catch { /* not here */ } }
  }
  return false;
}

interface Probe { programs: string[]; folders(env: Env): string[]; signIn?(env: Env): string }

/** By official-list id. Folders are the agent's own (where it keeps its settings), never a shared one. */
const PROBES: Record<string, Probe> = {
  'codex-acp': { programs: ['codex'], folders: env => [path.join(home(env), '.codex')], signIn: env => path.join(home(env), '.codex', 'auth.json') },
  // Claude Code on PATH, or the one the Claude desktop app keeps for itself.
  'claude-acp': { programs: ['claude'], folders: env => [path.join(home(env), '.claude'), path.join(appData(env), 'Claude', 'claude-code')] },
  'antigravity-acp': { programs: ['agy'], folders: env => [path.join(appData(env), 'Antigravity'), path.join(home(env), '.gemini', 'antigravity')] },
  gemini: { programs: ['gemini'], folders: env => [path.join(home(env), '.gemini', 'oauth_creds.json')] },
  'github-copilot-cli': { programs: ['copilot'], folders: env => [path.join(home(env), '.copilot')] },
  'grok-build': { programs: ['grok'], folders: env => [path.join(home(env), '.grok')] },
  'kimi-code': { programs: ['kimi'], folders: env => [path.join(home(env), '.kimi')] },
  'qwen-code': { programs: ['qwen'], folders: env => [path.join(home(env), '.qwen')] },
  opencode: { programs: ['opencode'], folders: env => [path.join(home(env), '.local', 'share', 'opencode')] },
  cursor: { programs: ['cursor-agent'], folders: () => [] },
  amp: { programs: ['amp'], folders: () => [] },
  auggie: { programs: ['auggie'], folders: env => [path.join(home(env), '.augment')] },
  goose: { programs: ['goose'], folders: () => [] },
  kiro: { programs: ['kiro-cli'], folders: () => [] },
  'factory-droid': { programs: ['droid'], folders: env => [path.join(home(env), '.factory')] },
  cline: { programs: ['cline'], folders: () => [] },
  qoder: { programs: ['qodercli'], folders: () => [] },
};

export function agentsOnComputer(env: Env = process.env): Map<string, OnComputer> {
  const found = new Map<string, OnComputer>();
  for (const [id, p] of Object.entries(PROBES)) {
    if (!onPath(p.programs, env) && !p.folders(env).some(f => existsSync(f))) continue;
    found.set(id, { signedIn: p.signIn ? existsSync(p.signIn(env)) : null });
  }
  return found;
}
