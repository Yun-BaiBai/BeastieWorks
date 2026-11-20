import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * The Claude Code folder the app's own Claude sessions use, kept apart from the person's.
 *
 * Why: on 2026-11-19 the person's Claude sign-in (in the same folder the Claude desktop app uses) was emptied the
 * moment the app's reviewer started, and both reviews failed with "Authentication required". Sharing one sign-in
 * file between the desktop app and the app's sessions lets them step on each other. T3 Code (`ClaudeHome.ts`,
 * `homePath` → CLAUDE_CONFIG_DIR) and OpenMausBot (`claude-login-auth.ts`, one sign-in per credential home) both
 * give their Claude a folder of its own; so does this.
 *
 * What is shared (boss's answer 8: keep the person's setup): the person's settings, CLAUDE.md, skills, plugins,
 * agents, commands and hooks, and the MCP connectors listed in their `.claude.json`. Folders are linked (a Windows
 * junction needs no special rights), files are copied fresh each time a session starts. What is not shared: the
 * sign-in, chats, history, caches. The sign-in is made once, in the app, with the roster's "去登录".
 */

const SHARED_FOLDERS = ['skills', 'plugins', 'agents', 'commands', 'hooks', 'output-styles'];
const SHARED_FILES = ['settings.json', 'CLAUDE.md', 'keybindings.json'];

/** The person's own Claude Code folder: CLAUDE_CONFIG_DIR as they set it, else ~/.claude. */
export function personClaudeDir(env: NodeJS.ProcessEnv): string {
  const set = env.CLAUDE_CONFIG_DIR?.trim();
  return set && path.isAbsolute(set) ? path.resolve(set) : path.join(env.USERPROFILE || env.HOME || homedir(), '.claude');
}

function linkFolder(target: string, link: string): void {
  let stats;
  try { stats = lstatSync(link); } catch { stats = null; }
  if (stats) {
    if (stats.isSymbolicLink()) {
      try { if (realpathSync(link) === realpathSync(target)) return; } catch { /* broken link: replace */ }
      rmSync(link, { force: true, recursive: false });
    } else {
      return;   // a real folder the app's Claude made itself: keep it, never delete its contents
    }
  }
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Copy the person's MCP connectors into the app's `.claude.json`, keeping everything else the app's Claude wrote. */
function shareConnectors(personDir: string, home: string): void {
  const read = (f: string): Record<string, unknown> | null => { try { return JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>; } catch { return null; } };
  const person = read(path.join(personDir, '.claude.json'));
  if (!person || !person.mcpServers) return;
  const mine = read(path.join(home, '.claude.json')) ?? {};
  if (JSON.stringify(mine.mcpServers) === JSON.stringify(person.mcpServers)) return;
  writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ ...mine, mcpServers: person.mcpServers }, null, 2));
}

/**
 * Make (or refresh) the app's Claude folder and return it. Never touches the person's folder. A part that cannot
 * be shared (a link Windows refuses) is skipped: the session still runs, with less of the person's setup.
 */
export function ensureClaudeHome(home: string, env: NodeJS.ProcessEnv): string {
  const personDir = personClaudeDir(env);
  mkdirSync(home, { recursive: true });
  if (path.resolve(home).toLowerCase() === personDir.toLowerCase()) return home;
  for (const name of SHARED_FOLDERS) {
    const from = path.join(personDir, name);
    try { if (statSync(from).isDirectory()) linkFolder(from, path.join(home, name)); } catch { /* not there, or not linkable */ }
  }
  for (const name of SHARED_FILES) {
    const from = path.join(personDir, name);
    try { if (existsSync(from)) copyFileSync(from, path.join(home, name)); } catch { /* skip */ }
  }
  try { shareConnectors(personDir, home); } catch { /* skip */ }
  return home;
}
