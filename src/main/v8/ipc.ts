import { homedir } from 'node:os';
import { BrowserWindow, dialog, type IpcMain } from 'electron';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { V8Settings } from '../../shared/v8/settings';
import { WorkbenchHost } from './host';
import { listProjects, projectKey } from './projects';
import { AgentChats } from './agentChat';
import { bundledAdapter, readRoster, type Roster } from './agentRoster';
import { downloadSize, installAgent, loadRegistry, uninstallAgent } from './acpRegistry';
import { QUIRKS } from './acpQuirks';
import { ClaudeLogin } from './claudeLogin';
import { CodexLogin } from './codexLogin';
import { AntigravityLogin } from './antigravityLogin';
import { PriceList } from './priceList';
import type { AcpShellOptions } from './acpShell';
import { claudeHomeOf, codexCli, findClaude } from './acpQuirks';
import { ensureClaudeHome } from './claudeHome';
import type { RosterView } from '../../shared/v8/agents';
import { QuotaBook } from './quotaRead';
import { MagpieService, magpieExe } from './magpieService';
import { outsideAsar } from './hostToolBridge';
import { dirname } from 'node:path';
import { retellPrompt, SkillLibrary } from './skillLibrary';

/**
 * The renderer's way into the v8 workbench. Nothing starts until the window actually calls in. Each project has its own workbench folder; changing the
 * project (or any v8 setting) switches workbenches on the next call. Changes are pushed as 'v8:changed'.
 */

let host: WorkbenchHost | null = null;
let timer: NodeJS.Timeout | null = null;
let chats: AgentChats | null = null;
let claudeLogin: ClaudeLogin | null = null;
let codexLogin: CodexLogin | null = null;
let antigravityLogin: AntigravityLogin | null = null;
let magpie: MagpieService | null = null;

function push(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('v8:changed');
  }, 120);
}

export function registerV8Ipc(ipcMain: IpcMain, deps: { userData: string; settings(): V8Settings | undefined; enabled(): boolean }): void {
  const base = join(deps.userData, 'v8');
  // List prices for agents that do not report dollars: the table shipped with the app (priceList.ts).
  const prices = new PriceList();
  const priced = (launch: AcpShellOptions | undefined): AcpShellOptions | null => {
    if (!launch) return null;
    void prices.load();
    return { ...launch, price: (model, tokens) => prices.price(model, tokens) };
  };
  // The Magpie that ships with the app (requirement 8): started the first time a model of another maker is asked for.
  magpie = new MagpieService({
    exe: () => magpieExe(process.resourcesPath, process.env),
    root: join(base, 'magpie'),
    claude: () => {
      // The Claude the roster found: the person's install from the official list (the app no longer ships Claude
      // Code, 老板 2026-11-20), or one next to the app while developing.
      const script = lastRoster?.launches.get('claude-acp')?.args[0] ?? bundledAdapter(join(__dirname, '..', '..'))('claude-acp');
      const program = script ? findClaude(script, process.env) : null;
      return { configDir: ensureClaudeHome(claudeHomeOf(base), process.env), programDir: program ? dirname(program) : null };
    },
  });
  // Each agent's quota, read from its maker without a message (quotaRead.ts).
  const quotas = new QuotaBook({
    claudeHome: () => claudeHomeOf(base),
    codex: async () => {
      const l = (await (roster ?? readNow())).launches.get('codex-acp');
      const command = l?.env?.CODEX_PATH;
      return command ? { command, env: { ...process.env, ...(l?.env ?? {}) } } : null;
    },
    // Every other agent: what the app's Magpie reads from the sign-ins on this computer (no message is sent).
    magpieQuotas: () => magpie!.quotas(),
  });
  // The app's skill library (第 6 步): the boss's shared skill folder unless the settings name others.
  const skills = new SkillLibrary({
    // Unset: the skill folders agents already share on this computer (~/.agents/skills, which several agents read, and
    // Claude's ~/.claude/skills), the ones that exist.
    roots: () => deps.settings()?.skillRoots ?? [join(homedir(), '.agents', 'skills'), join(homedir(), '.claude', 'skills')].filter(existsSync),
    stateFile: join(base, 'skill-library.json'),
    importRoot: join(base, 'skills-imported'),
  });
  host = new WorkbenchHost({ base, settings: deps.settings, enabled: deps.enabled, onChange: push, quotaOf: id => quotas.read(id), skills,
    // The roster is read again for each session, so a sign-in or install since the last look is seen.
    acpLaunch: async agent => priced((await readNow()).launches.get(agent)) });
  const get = () => host!.get();
  const num = (v: unknown) => { if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Error('V8_ARGUMENT'); return v; };
  const str = (v: unknown) => { if (typeof v !== 'string') throw new Error('V8_ARGUMENT'); return v; };

  ipcMain.handle('v8:board', async () => (await get()).board());
  ipcMain.handle('v8:ticket', async (_e, id: unknown) => (await get()).ticket(num(id)));
  ipcMain.handle('v8:slot', async (_e, slotId: unknown) => (await get()).slotDetail(str(slotId)));
  ipcMain.handle('v8:delivery', async (_e, id: unknown) => (await get()).delivery(num(id)));
  ipcMain.handle('v8:review', async () => (await get()).reviewDetail());
  ipcMain.handle('v8:ledger', async () => (await get()).ledger());
  ipcMain.handle('v8:archive', async () => (await get()).archive());
  ipcMain.handle('v8:timeline', async (_e, id: unknown) => (await get()).timeline(num(id)));
  ipcMain.handle('v8:say', async (_e, text: unknown) => (await get()).say(str(text)));
  ipcMain.handle('v8:tell', async (_e, id: unknown, text: unknown) => (await get()).tell(num(id), str(text)));
  ipcMain.handle('v8:stop', async (_e, id: unknown) => (await get()).stop(num(id)));
  ipcMain.handle('v8:reviewAgain', async (_e, id: unknown) => (await get()).reviewAgain(num(id)));
  ipcMain.handle('v8:accept', async (_e, id: unknown) => (await get()).accept(num(id)));
  ipcMain.handle('v8:reject', async (_e, id: unknown, why: unknown) => (await get()).reject(num(id), str(why)));
  ipcMain.handle('v8:retry', async (_e, id: unknown, o: unknown) => {
    const opt = (o && typeof o === 'object' ? o : {}) as { model?: unknown; fresh?: unknown };
    return (await get()).retry(num(id), { ...(typeof opt.model === 'string' ? { model: opt.model } : {}), fresh: opt.fresh === true });
  });
  ipcMain.handle('v8:resumeNow', async (_e, id: unknown) => (await get()).resumeNow(num(id)));
  ipcMain.handle('v8:switchAccount', async (_e, id: unknown, account: unknown) => (await get()).switchAccount(num(id), typeof account === 'string' ? account : null));
  ipcMain.handle('v8:switchModel', async (_e, id: unknown, model: unknown) => (await get()).switchModel(num(id), typeof model === 'string' ? model : null));
  ipcMain.handle('v8:switchEffort', async (_e, id: unknown, effort: unknown) => (await get()).switchEffort(num(id), typeof effort === 'string' ? effort : null));
  ipcMain.handle('v8:waitForQuota', async (_e, id: unknown) => (await get()).waitForQuota(num(id)));
  ipcMain.handle('v8:agentQuota', (_e, id: unknown, fresh: unknown) => quotas.read(str(id), fresh === true));
  ipcMain.handle('v8:front', async (_e, id: unknown) => (await get()).front(num(id)));
  ipcMain.handle('v8:supply', async () => (await get()).supplyStatus());
  // The agent roster and a plain chat with one agent. Reading the roster sends nothing; a chat message is a real message.
  const appRoot = join(__dirname, '..', '..');
  const rosterDeps = {
    registry: {
      cacheFile: join(base, 'acp-registry-cache.json'), bundledFile: join(__dirname, 'acp-registry.json'),
      installRoot: process.env.BEASTIE_ACP_AGENTS || join(base, 'acp-agents'),
      node: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
      // npm ships inside the app (老板 2026-11-17, 问题 4), so agents install on a computer without Node.js.
      ...(existsSync(join(appRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')) ? { npmCli: outsideAsar(join(appRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')) } : {}),
    },
    bundled: bundledAdapter(appRoot),
    dataDir: base,
    magpieOrigin: () => magpie!.origin(),
  };
  let roster: Promise<Roster> | null = null;
  /** The last roster that finished reading, for things that must answer at once. */
  let lastRoster: Roster | null = null;
  const readNow = () => { roster = readRoster(rosterDeps); void roster.then(r => { lastRoster = r; }, () => undefined); return roster; };
  chats = new AgentChats({ scratchRoot: join(base, 'agent-chat'), launch: async id => priced((await (roster ?? readNow())).launches.get(id)) });
  ipcMain.handle('v8:agents', async (): Promise<RosterView> => {
    const r = await readNow();
    return { rows: r.rows, source: r.source as RosterView['source'] };
  });
  ipcMain.handle('v8:agentSay', async (_e, id: unknown, text: unknown) => chats!.say(str(id), str(text)));
  ipcMain.handle('v8:agentChoices', async (_e, id: unknown) => chats!.choices(str(id)));
  ipcMain.handle('v8:agentChoose', async (_e, id: unknown, kind: unknown, value: unknown) => {
    if (kind !== 'model' && kind !== 'effort') throw new Error('V8_ARGUMENT');
    return chats!.choose(str(id), kind, str(value));
  });
  // Signing in to Claude Code: its own program shows Anthropic's page; the app passes the link and, if asked, a code.
  claudeLogin = new ClaudeLogin({
    cli: () => {
      const launch = lastRoster?.launches.get('claude-acp');
      const exe = launch ? findClaude(launch.args[0] ?? '', process.env) : null;
      return exe ? { command: exe, args: [] } : null;
    },
    // The sign-in goes into the app's own Claude folder, the one its Claude sessions use.
    env: () => ({ ...process.env, CLAUDE_CONFIG_DIR: ensureClaudeHome(claudeHomeOf(base), process.env) }),
    // The open chat was started signed out; the next sentence starts a new one with the sign-in.
    onSignedIn: () => { void chats?.close('claude-acp'); },
  });
  // Signing in to Codex: its own device-code sign-in (codexLogin.ts), with the person's Codex or the one the adapter brought.
  codexLogin = new CodexLogin({
    cli: () => { const launch = lastRoster?.launches.get('codex-acp'); return launch ? codexCli(launch, process.env) : null; },
    env: () => process.env,
    onSignedIn: () => { void chats?.close('codex-acp'); },
  });
  // Signing in to Antigravity's ACP server with the person's Google account (antigravityLogin.ts, T3 Code's way).
  antigravityLogin = new AntigravityLogin({
    launch: () => lastRoster?.launches.get('antigravity-acp') ?? null,
    env: () => process.env,
    onSignedIn: () => { void chats?.close('antigravity-acp'); },
  });
  const signInFor = (id: string): { start(): Promise<import('../../shared/v8/agents').SignInFlow>; complete(flowId: string, code: string): import('../../shared/v8/agents').SignInFlow; current(flowId: string): import('../../shared/v8/agents').SignInFlow | null; cancel(): void } => {
    if (id === 'claude-acp') return claudeLogin!;
    if (id === 'codex-acp') return codexLogin!;
    if (id === 'antigravity-acp') return antigravityLogin!;
    throw new Error('这个 agent 还不能在这里登录。');
  };
  ipcMain.handle('v8:agentSignInStart', async (_e, id: unknown) => {
    if (!lastRoster) await readNow();
    return signInFor(str(id)).start();
  });
  ipcMain.handle('v8:agentSignInCode', (_e, id: unknown, flowId: unknown, code: unknown) => signInFor(str(id)).complete(str(flowId), str(code)));
  ipcMain.handle('v8:agentSignInStatus', (_e, id: unknown, flowId: unknown) => signInFor(str(id)).current(str(flowId)));
  ipcMain.handle('v8:agentSignInCancel', (_e, id: unknown) => signInFor(str(id)).cancel());
  // 第 7 步: install, update and remove agents from the official list, into the app's own folder.
  const listed = async (id: string) => {
    const agent = (await loadRegistry(rosterDeps.registry)).registry.agents.find(a => a.id === id);
    if (!agent) throw new Error('官方名单上没有这个 agent。');
    return agent;
  };
  const installing = new Set<string>();
  ipcMain.handle('v8:agentSize', async (_e, id: unknown) => {
    const size = await downloadSize(await listed(str(id)));
    const note = QUIRKS[str(id)]?.installNote?.(process.env) ?? null;
    return note ? { ...size, note } : size;
  });
  ipcMain.handle('v8:agentInstall', async (_e, id: unknown) => {
    const agent = await listed(str(id));
    if (installing.has(agent.id)) throw new Error('正在装，等一下。');
    installing.add(agent.id);
    try {
      await chats!.close(agent.id);
      const args = QUIRKS[agent.id]?.installArgs;
      await installAgent(rosterDeps.registry, agent, fetch, undefined, typeof args === 'function' ? args(process.env) : args ?? []);
    } finally { installing.delete(agent.id); }
    const r = await readNow();
    return { rows: r.rows, source: r.source as RosterView['source'] };
  });
  ipcMain.handle('v8:agentUninstall', async (_e, id: unknown) => {
    const agentId = str(id);
    const s = deps.settings();
    const roles = s?.shell === 'acp' && s.acp ? [['小怪A', s.acp.lead], ['干活的小怪', s.acp.worker], ['审查', s.acp.reviewer ?? s.acp.lead]] as const : [];
    const user = roles.find(([, r]) => r?.agent === agentId);
    if (user) throw new Error(`${user[0]}正在用它，先换成别的 agent 再卸载。`);
    await chats!.close(agentId);
    uninstallAgent(rosterDeps.registry, agentId);
    const r = await readNow();
    return { rows: r.rows, source: r.source as RosterView['source'] };
  });
  ipcMain.handle('v8:magpieModels', async (_e, fresh: unknown) => {
    try { return await magpie!.models(fresh === true); }
    catch (e) { throw new Error(e instanceof Error && e.message === 'V8_MAGPIE_MISSING' ? '这个程序里没有 Magpie。' : '开不了 Magpie：' + (e instanceof Error ? e.message : String(e))); }
  });
  ipcMain.handle('v8:skills', () => skills.view());
  // Requirement 41: drop a skill (an imported one is deleted; a shared one only taken out of this library), or bring
  // some in from a GitHub link. Importing downloads from GitHub; it starts only when the boss presses the button.
  ipcMain.handle('v8:skillRemove', (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('V8_BAD_SKILL');
    return { how: skills.remove(id), view: skills.view() };
  });
  ipcMain.handle('v8:skillsRestore', () => { skills.restoreRemoved(); return skills.view(); });
  ipcMain.handle('v8:skillImport', async (_e, link: unknown) => {
    if (typeof link !== 'string') throw new Error('V8_BAD_LINK');
    const r = await skills.importFrom(link);
    return { ...r, view: skills.view() };
  });
  ipcMain.handle('v8:skillsEnable', (_e, ids: unknown, on: unknown) => {
    if (!Array.isArray(ids) || !ids.every(i => typeof i === 'string')) throw new Error('V8_ARGUMENT');
    skills.setEnabled(ids as string[], on === true);
    return skills.view();
  });
  // 让 agent 复述 (requirement 50): a real message to the chosen agent, in a fresh chat that is closed afterwards.
  ipcMain.handle('v8:skillRetell', async (_e, id: unknown, agent: unknown) => {
    const text = skills.text(str(id));
    await chats!.close(str(agent));
    // On the model and effort the boss set for that agent's gremlins, not the agent's own (often dearer) default.
    const role = deps.settings()?.acp?.worker;
    if (role && role.agent === str(agent)) {
      if (role.model) await chats!.choose(str(agent), 'model', role.model).catch(() => undefined);
      if (role.effort) await chats!.choose(str(agent), 'effort', role.effort).catch(() => undefined);
    }
    const turn = await chats!.say(str(agent), retellPrompt(text));
    await chats!.close(str(agent));
    if (turn.error || !turn.reply.trim()) throw new Error(turn.error ?? '它没有回话。');
    skills.saveRetold(str(id), str(agent), turn.reply);
    return skills.view();
  });
  ipcMain.handle('v8:agentChatClose', async (_e, id: unknown) => chats!.close(str(id)));
  /** Every project that has a workbench folder (for project switching). Reads only; opens nothing. */
  ipcMain.handle('v8:projects', () => {
    const current = projectKey(deps.settings()?.projectRoot ?? null);
    return listProjects(base).map(p => ({
      key: p.key, root: p.root, name: p.name, createdAt: p.createdAt,
      current: p.key === current,
      /** The folder was moved or deleted since; it cannot be opened until it is back. */
      missing: p.root !== null && !existsSync(p.root),
    }));
  });
  /** The boss picks a project folder: any folder (a git repository, or a plain one the app keeps a private snapshot of). */
  ipcMain.handle('v8:chooseFolder', async evt => {
    const win = BrowserWindow.fromWebContents(evt.sender) ?? undefined;
    const r = win ? await dialog.showOpenDialog(win, { title: '选择项目文件夹', properties: ['openDirectory'] }) : await dialog.showOpenDialog({ title: '选择项目文件夹', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const path = r.filePaths[0];
    return { path, name: basename(path), git: existsSync(join(path, '.git')) };
  });
}

/** On quit: close the sessions. Running work is recovered on the next start. */
export async function shutdownV8(): Promise<void> {
  claudeLogin?.cancel();
  codexLogin?.cancel();
  antigravityLogin?.cancel();
  await magpie?.stop().catch(() => undefined);
  await chats?.close();
  await host?.shutdown();
}
