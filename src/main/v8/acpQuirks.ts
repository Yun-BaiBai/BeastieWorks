import { tr } from '../../shared/i18n';
import { MAGPIE_KEY } from './magpieService';
import { antigravityAcpDir, antigravitySignedIn } from './antigravityLogin';
import { hostAgy } from './antigravityHost';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AcpShellOptions } from './acpShell';
import { claudeSignIn, codexSignIn, dshSignIn, type SignIn } from './agentSignIn';
import { ensureClaudeHome } from './claudeHome';
import { MORE_QUIRKS } from './moreAgents';

/**
 * What differs from one ACP agent to the next. The protocol part is the same for all of them (`acpShell.ts`); each
 * agent's own habits are one small entry here. The shape follows OpenMausBot's `server/drivers/acp/` (one support file
 * per harness over a shared core) and Orca's `acp-dialects/`; the facts in each entry come from those files and from
 * checks on a real computer, noted per entry.
 */
/** What a quirk may need from the app: its own data folder, for agent folders kept apart from the person's. */
export interface QuirkContext { dataDir: string | null }

export interface AgentQuirk {
  /** The name people use for it, when the official list calls it something else. */
  displayName?: string;
  /** Extra arguments for `npm install` of this agent's package. */
  installArgs?: string[] | ((env: NodeJS.ProcessEnv) => string[]);
  /** Plain words for anything the install downloads besides the package itself, when that applies here. */
  installNote?(env: NodeJS.ProcessEnv): string | null;
  /**
   * Last step before starting: add what the agent needs from this computer. `missing` is said to the person in the
   * roster when the agent cannot start as things are.
   */
  prepare?(launch: AcpShellOptions, env: NodeJS.ProcessEnv, ctx: QuirkContext): { launch: AcpShellOptions } | { missing: string };
  /** Is the person signed in to this agent? Never reads a credential; asks the agent's own program where it can. */
  signIn?(launch: AcpShellOptions, env: NodeJS.ProcessEnv): Promise<SignIn> | SignIn;
  /** The agent's own session mode per role. The lead and the reviewer get the most closed one the agent has, so
   *  even its own tools ask first (and are refused); a gremlin gets the one that works inside its folder. */
  modes?: AcpShellOptions['modes'];
  /** How this agent reaches a model through Magpie (AcpShellOptions.magpie): environment to start it with. */
  magpie?(origin: string, model: string, env: Record<string, string>, person: NodeJS.ProcessEnv, effort?: string): Promise<Record<string, string>> | Record<string, string>;
  /** The light start for the lead and the reviewer (AcpShellOptions.light). */
  light?(env: NodeJS.ProcessEnv): AcpShellOptions['light'];
  /**
   * The computer's own program to use instead of the one from the official list, even when that one is not installed
   * (A14: Antigravity's `agy acp` with the editor's sign-in). Null: use the official one.
   */
  adopt?(env: NodeJS.ProcessEnv): Promise<{ launch: AcpShellOptions; note: string } | null>;
  /** The roster can start this agent's own sign-in (see claudeLogin.ts). */
  signInFlow?: boolean;
  /** One plain sentence for "not signed in": where the person signs in. */
  signInHelp: string;
}

const win = process.platform === 'win32';

function onPath(names: string[], env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) { const file = path.join(dir, name); if (existsSync(file)) return file; }
  }
  return null;
}
const home = (env: NodeJS.ProcessEnv) => env.USERPROFILE || env.HOME || homedir();

/**
 * The person's own Codex. OpenMausBot, T3 Code and Orca all drive the Codex already on the computer rather than a
 * second copy, so the models and sign-in are the person's. The desktop app keeps its program under `~/.codex/plugins`.
 */
export function findCodex(env: NodeJS.ProcessEnv): string | null {
  if (env.CODEX_PATH && existsSync(env.CODEX_PATH)) return env.CODEX_PATH;
  return onPath(win ? ['codex.exe'] : ['codex'], env)
    ?? [path.join(home(env), '.codex', 'plugins', '.plugin-appserver', win ? 'codex.exe' : 'codex')].find(existsSync)
    ?? null;
}

/** The Claude Code program that ships inside the adapter's own packages (its sign-in is the one the adapter uses). */
export function findClaude(adapterScript: string, env: NodeJS.ProcessEnv): string | null {
  const exe = win ? 'claude.exe' : 'claude', pkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
  for (let dir = path.dirname(adapterScript), i = 0; i < 8; i++, dir = path.dirname(dir)) {
    const file = path.join(dir, 'node_modules', '@anthropic-ai', pkg, exe);
    if (existsSync(file)) return file;
  }
  return onPath(win ? ['claude.exe', 'claude.cmd'] : ['claude'], env);
}

/**
 * Codex for every role (老板 2026-11-20, OpenMausBot's codex-tool-surface.ts): what the person's ChatGPT account brings
 * to every Codex (its plugins and connected apps: Notion, Gmail, Drive…) and the browser and computer control are off.
 * A gremlin works in its project folder and needs none of them; with them it could send mail or change Notion. The
 * person's own MCP servers and skills stay. Measured 2026-11-20: on a model Codex does not know (one through Magpie)
 * it sends every tool in full, ~390,000 characters of them, most from the connected apps.
 */
// Checked 2026-11-20 against a stand-in endpoint on this computer (no model): on a model Codex does not know, the
// first request fell from ~557,000 characters (29 tools, ~465,000 of them the connected apps) to ~82,000 (13 tools);
// the person's own node_repl stayed. These switches alone do it; OpenMausBot's extra `plugins` table is not needed.
export const CODEX_SURFACE_OFF: Record<string, unknown> = Object.fromEntries(
  ['plugins', 'remote_plugin', 'apps', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use'].map(f => [`features.${f}`, false]));

/** CODEX_CONFIG with the account's plugins and apps off (CODEX_SURFACE_OFF), over whatever it held. */
export function codexSurface(launchEnv: Record<string, string> | undefined): Record<string, string> {
  let before: Record<string, unknown> = {};
  try { before = launchEnv?.CODEX_CONFIG ? JSON.parse(launchEnv.CODEX_CONFIG) as Record<string, unknown> : {}; } catch { /* none */ }
  return { ...(launchEnv ?? {}), CODEX_CONFIG: JSON.stringify({ ...before, ...CODEX_SURFACE_OFF }) };
}

/**
 * Codex for the lead and the reviewer: the features they never use switched off (the list OpenMausBot's
 * codex-background-text.ts turns off for its background jobs), and every skill switched off by its SKILL.md path
 * (OpenMausBot's codex-guest.ts: `skills.config=[{path=…,enabled=false}]`). Measured 2026-11-19: of the ~27,000
 * tokens Codex sends at the top of every request, the skill list was ~21,000 characters and the memory guide
 * ~11,000. Passed as the adapter's CODEX_CONFIG (merged into the session's config).
 */
export function codexLight(env: NodeJS.ProcessEnv): NonNullable<AcpShellOptions['light']> {
  const off = ['memories', 'plugins', 'remote_plugin', 'apps', 'hooks', 'multi_agent', 'goals', 'image_generation', 'browser_use', 'in_app_browser', 'computer_use', 'plugin_discovery_prefetch'];
  const config: Record<string, unknown> = Object.fromEntries(off.map(f => [`features.${f}`, false]));
  const skills = skillFiles([path.join(env.CODEX_HOME || path.join(home(env), '.codex'), 'skills'), path.join(home(env), '.agents', 'skills')]);
  if (skills.length) config['skills.config'] = skills.map(file => ({ path: file, enabled: false }));
  return { env: { CODEX_CONFIG: JSON.stringify({ ...CODEX_SURFACE_OFF, ...config }) } };
}

/** Every SKILL.md up to three folders down (skill folders may be links), each once. */
function skillFiles(roots: string[]): string[] {
  const found = new Set<string>();
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    if (names.includes('SKILL.md')) { found.add(path.join(dir, 'SKILL.md')); return; }
    if (depth >= 3) return;
    for (const n of names) if (!n.startsWith('.') || n === '.system') { const p = path.join(dir, n); try { if (statSync(p).isDirectory()) walk(p, depth + 1); } catch { /* skip */ } }
  };
  for (const r of roots) walk(r, 0);
  return [...found];
}

/** The Codex program that came with the adapter (@openai/codex/bin/codex.js next to it), if its Windows part is there. */
export function bundledCodex(adapterScript: string): string | null {
  if (!adapterScript) return null;
  try {
    const req = createRequire(adapterScript);
    const js = req.resolve('@openai/codex/bin/codex.js');
    const platform = `@openai/codex-${process.platform}-${process.arch}`;
    try { createRequire(js).resolve(platform + '/package.json'); } catch { return null; }
    return js;
  } catch { return null; }
}

/** How to run the Codex program for sign-in: the person's own, or the one that came with the adapter. */
export function codexCli(launch: AcpShellOptions, env: NodeJS.ProcessEnv): { command: string; args: string[]; env?: Record<string, string> } | null {
  const own = findCodex(env);
  if (own) return { command: own, args: [] };
  const js = bundledCodex(launch.args[0] ?? '');
  return js ? { command: launch.command, args: [js], env: launch.env ?? {} } : null;
}

/** Where the app's own Claude folder is, under the app's data folder. */
export function claudeHomeOf(dataDir: string): string { return path.join(dataDir, 'claude-home'); }

/** What people call an agent: its own display name here, else its id without the "-acp" ending. */
export function agentName(id: string): string {
  return QUIRKS[id]?.displayName ?? (id === 'codex-acp' ? 'Codex' : id === 'antigravity-acp' ? 'Antigravity' : id === 'dsh' ? 'DeepSeek Harness' : id.replace(/-acp$/, ''));
}

export const QUIRKS: Record<string, AgentQuirk> = {
  // Checked 2026-11-17: `claude auth status --json` answers loggedIn false on a computer where only the Claude
  // desktop app is signed in; the desktop app's sign-in is not shared with the command-line program.
  'claude-acp': {
    // The official list says "Claude Agent"; people say Claude (Claude Code is only its command-line program).
    displayName: 'Claude',
    // 'default' asks before every edit and command, so each one goes through the app's approval rule.
    modes: { lead: 'default', reviewer: 'default', worker: 'default' },
    // No user settings, CLAUDE.md, skills or plugins for the lead and the reviewer: the adapter passes these options
    // to the Claude Agent SDK (claude-agent-acp 0.107 spreads _meta.claudeCode.options over its own).
    light: () => ({ sessionMeta: { claudeCode: { options: { settingSources: [] } } } }),
    // The app's Claude gets a folder of its own (claudeHome.ts): its sign-in never shares a file with the Claude
    // desktop app's. The person's settings, skills, plugins and connectors are carried over.
    prepare: (launch, env, ctx) => ctx.dataDir
      ? { launch: { ...launch, env: { ...(launch.env ?? {}), CLAUDE_CONFIG_DIR: ensureClaudeHome(claudeHomeOf(ctx.dataDir), env) } } }
      : { launch },
    signIn: (launch, env) => { const cli = findClaude(launch.args[0] ?? '', env); return cli ? claudeSignIn(cli, env) : 'unknown'; },
    signInFlow: true,
    signInHelp: tr('要登录一次 Claude（桌面版的登录不通用）。点右边的"去登录"。'),
    // Magpie's own way to put Claude Code on its gateway (magpie internal/agent/claude.go): the base URL, the key
    // naming the app, and the model for every tier, so nothing goes to another model behind the person's back.
    magpie: (origin, model) => ({
      ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: MAGPIE_KEY, ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_DEFAULT_FABLE_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
    }),
  },
  // Checked 2026-11-17 with adapter 2.6.0 and the desktop app's codex 0.167: CODEX_PATH makes the adapter use the
  // person's Codex, and the model list then comes from it. Without --omit=optional npm also downloads a second Codex.
  // A computer without Codex (a friend's) gets the Codex program that comes with the adapter (@openai/codex, about
  // 500 MB unpacked for Windows x64 in 0.166.0), so it works without installing Codex first.
  'codex-acp': {
    installArgs: env => findCodex(env) ? ['--omit=optional'] : [],
    installNote: env => findCodex(env) ? null : tr('这台电脑上没有 Codex，会连 Codex 程序一起装，另外约 500 MB'),
    // Adapter 2.6.0 offers read-only | workspace-write | agent | agent-full-access.
    modes: { lead: 'read-only', reviewer: 'read-only', worker: 'agent' },
    light: env => codexLight(env),
    prepare: (launch, env) => {
      const codex = findCodex(env);
      if (codex) return { launch: { ...launch, env: { ...codexSurface(launch.env), CODEX_PATH: codex } } };
      // No Codex of the person's: the adapter runs the Codex that came with it (it does so when CODEX_PATH is unset).
      return bundledCodex(launch.args[0] ?? '') ? { launch: { ...launch, env: codexSurface(launch.env) } } : { missing: tr('这台电脑上没有 Codex 程序。在下面点"重新装"，会连 Codex 程序一起装上（约 500 MB）。') };
    },
    signIn: async (launch, env) => { const cli = codexCli(launch, env); return cli ? codexSignIn(cli, { ...env, ...(cli.env ?? {}) }) : 'unknown'; },
    signInFlow: true,
    signInHelp: tr('要登录一次 Codex（用你自己的 ChatGPT 账号）。点右边的"去登录"。'),
    // Magpie's own way (magpie internal/agent/codex.go): signed in to ChatGPT, Codex keeps its built-in provider and only
    // its OpenAI address moves to Magpie, which passes OpenAI's models through and answers the rest, so a conversation
    // started before the switch goes on. Not signed in, Magpie is a provider of its own.
    magpie: async (origin, model, env, person, effort) => {
      const cli = codexCli({ label: 'Codex', command: process.execPath, args: [], env }, person);
      const signed = cli ? await codexSignIn(cli, { ...person, ...(cli.env ?? {}) }) === 'yes' : false;
      const own: Record<string, unknown> = signed
        ? { openai_base_url: origin + '/v1', model }
        : { model_provider: 'magpie', model, 'model_providers.magpie': { name: 'magpie', base_url: origin + '/v1', wire_api: 'responses', experimental_bearer_token: MAGPIE_KEY, http_headers: { 'x-openai-actor-authorization': 'magpie' } } };
      let before: Record<string, unknown> = {};
      try { before = env.CODEX_CONFIG ? JSON.parse(env.CODEX_CONFIG) as Record<string, unknown> : {}; } catch { /* none */ }
      // The effort goes with the model: Codex offers no effort choice for a model it does not know.
      if (effort) own.model_reasoning_effort = effort;
      return { CODEX_CONFIG: JSON.stringify({ ...before, ...own }) };
    },
  },
  // Orca prefers the computer's own `agy acp` (the person's sign-in); without `agy` this server keeps a sign-in of
  // its own under ~/.gemini/antigravity-acp. Checked 2026-11-17: with no settings file, session/new answers
  // "Authentication required".
  'antigravity-acp': {
    // A14 (Orca's way): the computer's own `agy acp`, signed in with the same sign-in as the Antigravity editor.
    adopt: env => hostAgy(env),
    // Its sign-in is kept as a file in its own folder (T3 Code forces this too), so the roster can see it and every
    // session finds the same one (antigravityLogin.ts).
    // Orca (antigravity-acp-environment.ts, antigravity-acp-runtime-probe.ts) also turns off the server's output
    // buffering and gives it 90 s to answer the handshake; at our 30 s its first session in a real project folder
    // timed out (2026-11-21, first real ticket).
    prepare: launch => ({ launch: { ...launch, readyTimeoutMs: Math.max(launch.readyTimeoutMs ?? 0, 90_000), env: { ...(launch.env ?? {}), AGY_ACP_FORCE_FILE_STORAGE: '1', PYTHONUNBUFFERED: '1' } } }),
    signIn: (_launch, env) => {
      if (antigravitySignedIn(env)) return 'yes';
      try {
        const s = JSON.parse(readFileSync(path.join(antigravityAcpDir(env), 'settings.json'), 'utf8')) as { auth?: { type?: unknown } };
        return typeof s.auth?.type === 'string' && s.auth.type && s.auth.type !== 'oauth-personal' ? 'unknown' : 'no';
      } catch { return 'no'; }
    },
    signInFlow: true,
    signInHelp: tr('这个接入程序有自己单独的登录，要用你的 Google 账号另登一次，点右边的"去登录"。（电脑上装了 Antigravity 命令行 agy 的话，会直接用编辑器的登录，不用另登。）'),
  },
  // OpenMausBot acp/deepseek.ts: no sign-in step; the key comes from the environment or dsh's own files.
  dsh: {
    signIn: (_launch, env) => dshSignIn(env),
    signInHelp: tr('在 DSH 里登录账号或填好密钥。'),
  },
  // Gemini, Copilot, Cursor, Kimi, Kiro, Cline, Droid, Devin, Qwen, Grok, OpenCode (moreAgents.ts, from OpenMausBot).
  ...MORE_QUIRKS,
};
