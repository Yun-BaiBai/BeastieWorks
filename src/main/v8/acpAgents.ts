import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AcpShellOptions } from './acpShell';

/**
 * Agents that speak ACP but are not in the official registry (`acpRegistry.ts` covers the ones that are).
 * Each is looked for where its own installer puts it, on any computer; nothing here names one person's folders.
 */

export interface ExtraAgent {
  id: string;
  name: string;
  website: string;
  /** Null when the agent's program was not found on this computer. */
  launch: AcpShellOptions | null;
}

function firstExisting(candidates: Array<string | undefined>): string | null {
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

/** Folders a Windows installer may have used: the usual ones, and the same names on other drives. */
function installRoots(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return ['/Applications', '/opt', '/usr/local'];
  const roots = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']];
  for (const letter of 'CDEFG') roots.push(`${letter}:\\`, `${letter}:\\Program Files`);
  return roots.filter((r): r is string => Boolean(r));
}

/** A command on PATH, as an absolute file. */
function onPath(names: string[], env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) for (const name of names) { const file = path.join(dir, name); if (existsSync(file)) return file; }
  return null;
}

export function extraAgents(overrides: Record<string, string | undefined> = {}, env: NodeJS.ProcessEnv = process.env): ExtraAgent[] {
  const win = process.platform === 'win32';
  // DeepSeek Harness: the desktop app carries its CLI, which has an ACP profile.
  const dshCli = path.join('resources', 'runtime', 'cli', 'bin', win ? 'dsh.cmd' : 'dsh');
  const dsh = firstExisting([overrides.dsh, ...installRoots(env).flatMap(root => [path.join(root, 'DSH', dshCli), path.join(root, 'DeepSeek Harness', dshCli)])])
    ?? onPath(win ? ['dsh.cmd', 'dsh.exe'] : ['dsh'], env);
  // oh-my-pi
  const omp = firstExisting([overrides.omp, env.V8_OMP_EXE]) ?? onPath(win ? ['omp.exe', 'omp.cmd'] : ['omp'], env);
  return [
    { id: 'dsh', name: 'DeepSeek Harness', website: 'https://github.com/deepseek-ai/deepseek-harness', launch: dsh ? { label: 'DeepSeek Harness', command: dsh, args: ['--profile', 'acp'] } : null },
    { id: 'omp', name: 'oh-my-pi', website: 'https://github.com/can1357/oh-my-pi', launch: omp ? { label: 'oh-my-pi', command: omp, args: ['acp'] } : null },
  ];
}
