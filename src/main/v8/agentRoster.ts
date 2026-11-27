import { tr } from '../../shared/i18n';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AcpShellOptions } from './acpShell';
import { extraAgents } from './acpAgents';
import { agentsOnComputer, type OnComputer } from './hostAgents';
import { availability, loadRegistry, type RegistryAgent, type RegistryPaths } from './acpRegistry';
import { QUIRKS } from './acpQuirks';
import type { RosterRow } from '../../shared/v8/agents';

/**
 * The agent roster: every agent the app knows, whether it is on this computer, and whether the person is signed in.
 * Reading the roster starts no session and sends no message.
 */

export interface RosterDeps {
  registry: RegistryPaths;
  /** The adapter script of an agent that ships inside the app itself, by registry id. */
  bundled?(id: string): string | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** The app's data folder, for agent folders kept apart from the person's (Claude's). */
  dataDir?: string;
  /** The Magpie that ships with the app: its address, started on first use (magpieService.ts). */
  magpieOrigin?: () => Promise<string>;
  /** The agents the person already has on this computer, not yet connected (hostAgents.ts). */
  onComputer?(env: NodeJS.ProcessEnv): Map<string, OnComputer>;
}

export interface Roster { rows: RosterRow[]; launches: Map<string, AcpShellOptions>; source: string }

type Resolved = { launch: AcpShellOptions; installed?: { version: string; update: string | null } } | { state: 'not_installed' | 'unsupported'; note: string; canInstall?: boolean };

function resolveLaunch(deps: RosterDeps, agent: RegistryAgent): Resolved {
  const a = availability(deps.registry, agent);
  if (a.state === 'ready') return { launch: a.launch, installed: { version: a.version, update: a.update } };
  const script = deps.bundled?.(agent.id);
  if (script && existsSync(script)) {
    return { launch: { label: agent.name, command: deps.registry.node.command, args: [script, ...(agent.distribution.npx?.args ?? [])], env: { ...(deps.registry.node.env ?? {}), ...(agent.distribution.npx?.env ?? {}) } } };
  }
  return a.state === 'unsupported' ? { state: 'unsupported', note: tr('这台电脑装不了：') + (a.reason.startsWith('needs Python') ? tr('要先装 Python（uv），小怪工坊不替你装') : tr('官方没给这台电脑能用的版本')) } : { state: 'not_installed', note: tr('还没装，点开可以一键装上。'), canInstall: true };
}

export async function readRoster(deps: RosterDeps): Promise<Roster> {
  const env = deps.env ?? process.env;
  const { registry, source } = await loadRegistry(deps.registry, deps.fetchImpl);
  const launches = new Map<string, AcpShellOptions>();
  const rows: RosterRow[] = [];
  const here = (deps.onComputer ?? agentsOnComputer)(env);

  const add = async (id: string, listedName: string, website: string | null, found: Resolved) => {
    const name = QUIRKS[id]?.displayName ?? listedName;
    const installed = 'launch' in found ? found.installed ?? null : null;
    // A14: the computer's own program, when the agent says it has one that is ready (Antigravity's agy).
    const adopted = QUIRKS[id]?.adopt ? await QUIRKS[id]!.adopt!(env).catch(() => null) : null;
    if (adopted) found = { launch: adopted.launch };
    if ('launch' in found) found = { launch: { ...found.launch, label: name } };
    if (!('launch' in found)) {
      const mine = found.state === 'not_installed' && found.canInstall ? here.get(id) : undefined;
      const note = mine ? tr('你电脑上有 {0}{1}。点开装上接入程序，就能用你平时的设置和技能。', [name, mine.signedIn ? tr('，已登录') : '']) : found.note;
      rows.push({ id, name, website, state: found.state, signIn: 'unknown', canSignIn: false, note, canInstall: found.canInstall === true, installed: null, ...(mine ? { onComputer: true } : {}) });
      return;
    }
    const quirk = QUIRKS[id];
    const ready = quirk?.prepare && !adopted ? quirk.prepare(found.launch, env, { dataDir: deps.dataDir ?? null }) : { launch: found.launch };
    if ('missing' in ready) { rows.push({ id, name, website, state: 'missing_program', signIn: 'unknown', canSignIn: false, note: ready.missing, installed }); return; }
    let signIn: RosterRow['signIn'] = 'unknown';
    try { if (adopted) signIn = 'yes'; else if (quirk?.signIn) signIn = await quirk.signIn(ready.launch, { ...env, ...(ready.launch.env ?? {}) }); } catch { /* stays unknown */ }
    launches.set(id, { ...ready.launch, node: deps.registry.node, ...(quirk?.modes ? { modes: quirk.modes } : {}), ...(quirk?.light ? { light: quirk.light(env) } : {}),
      ...(quirk?.magpie && deps.magpieOrigin ? { magpie: { origin: deps.magpieOrigin, wire: (origin: string, model: string, e: Record<string, string>, effort?: string) => quirk.magpie!(origin, model, e, env, effort) } } : {}) });
    rows.push({ id, name, website, state: 'ready', signIn, canSignIn: quirk?.signInFlow === true && !adopted, installed, note: adopted ? adopted.note : signIn === 'no' ? (quirk?.signInHelp ?? tr('还没登录，要在这个 agent 里登录。')) : signIn === 'unknown' ? tr('装好了；登录没登录要说一句话才知道。') : tr('装好了，已登录。') });
  };

  // Sign-in checks start a small program each; run them side by side so the page does not wait on the slowest.
  await Promise.all([
    ...registry.agents.map(agent => add(agent.id, agent.name, agent.website ?? null, resolveLaunch(deps, agent))),
    ...extraAgents({}, env).map(extra => add(extra.id, extra.name, extra.website, extra.launch ? { launch: extra.launch } : { state: 'not_installed', note: tr('这台电脑上没找到') })),
  ]);
  const rank = (r: RosterRow) => r.state === 'ready' ? (r.signIn === 'yes' ? 0 : r.signIn === 'unknown' ? 1 : 2) : r.state === 'missing_program' || r.onComputer ? 3 : r.state === 'not_installed' ? 4 : 5;
  rows.sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name));
  return { rows, launches, source };
}

/** Where the adapters that ship with the app live, for `bundled`. */
export function bundledAdapter(appRoot: string): (id: string) => string | null {
  const known: Record<string, string> = { 'claude-acp': path.join('node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js') };
  return id => known[id] ? path.join(appRoot, known[id]) : null;
}
