import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type { AgentShell, HostToolResult, SessionSpec, ShellEvent, ShellSession } from './shell';
import { hardKillTree } from '../procKill';
import { openToolSeat, type ToolSeat } from './hostToolBridge';
import type { TurnTokens } from './priceList';
import { viaMagpie } from './magpieService';
import type { Choice, ChoiceList, SessionChoices } from '../../shared/v8/agents';

/**
 * AgentShell on the Agent Client Protocol (ACP): one shell for every agent that speaks it.
 *
 * The protocol itself is the official library (`@agentclientprotocol/sdk`); this file only joins it to the app's
 * AgentShell socket. Which program to start for which agent is in `acpAgents.ts`.
 *
 * - The agent runs as a hidden child process with the person's own environment, so it uses the sign-in and setup it
 *   already has on this computer.
 * - Every permission request comes to the app (`approval`); nothing is allowed automatically.
 * - ACP has no system-prompt field: the session's system prompt goes in front of its first message.
 * - The app's own tools (`hostTools`) reach the agent as a small MCP server it starts itself (host-tool-relay.cjs),
 *   the way OpenMausBot, T3 Code and LobeHub do it. A call arrives here as a `host_tool` event.
 * - A permission request is passed on in the shape the approval rule reads (`approval.ts`): an edit names its file
 *   (`Path: …`), a command its command line (`Command: …`).
 */

export interface AcpShellOptions {
  /** What the person calls this agent, for error text. */
  label: string;
  command: string;
  args: string[];
  /** Extra environment for the child. Never logged. */
  env?: Record<string, string>;
  /** How long to wait for the agent to answer the first handshake. */
  readyTimeoutMs?: number;
  /** Runs the tool relay script: Electron as Node in the app. Needed only for sessions with host tools. */
  node?: { command: string; env?: Record<string, string> };
  /** The agent's own session mode to pick per role, e.g. Codex 'read-only' for the lead (see acpQuirks.ts). */
  modes?: Partial<Record<SessionSpec['role'], string>>;
  /**
   * How to start this agent lighter for the lead and the reviewer, who only dispatch and judge: the person's skills,
   * memory and plugins are not loaded for them (the gremlins keep the full setup, requirement 2). The way
   * OpenMausBot, Orca and T3 Code run their helper jobs. `env` for the process, `sessionMeta` as the session's `_meta`.
   */
  light?: { env?: Record<string, string>; sessionMeta?: Record<string, unknown> };
  /**
   * Working on a model of another maker through the Magpie that ships with the app (requirement 8): a session whose
   * model is `magpie:<id>` starts with the environment `wire` gives for this agent (acpQuirks.ts), pointed at Magpie.
   */
  magpie?: { origin(): Promise<string>; wire(origin: string, model: string, env: Record<string, string>, effort?: string): Promise<Record<string, string>> | Record<string, string> };
  /** Model and reasoning effort to pick when a session opens; a session's own `model` wins over this one. */
  model?: string;
  effort?: string;
  /** List-price cost of a turn from its tokens, when the agent does not report dollars (priceList.ts). */
  price?: (model: string | null, tokens: TurnTokens) => number | null;
}

type Json = Record<string, unknown>;
interface AcpAgentContext {
  request(method: string, params?: unknown): Promise<Json>;
  notify(method: string, params?: unknown): Promise<void>;
}
interface AcpConnection { agent: AcpAgentContext; closed: Promise<void>; close(error?: unknown): void }
/** The library hands each handler a context object; the message itself is its `params`. */
interface AcpClientApp {
  onRequest(method: string, handler: (context: never) => unknown): AcpClientApp;
  onNotification(method: string, handler: (context: never) => unknown): AcpClientApp;
  connect(stream: unknown): AcpConnection;
}
interface AcpSdk {
  client(): AcpClientApp;
  ndJsonStream(output: unknown, input: unknown): unknown;
}

/**
 * The SDK is an ES module and the main process is CommonJS, so it is loaded when first needed. The import is made by
 * the runtime itself, from the file the package resolves to: a bundler or a test loader would otherwise turn it into
 * a `require`, which cannot load an ES module, and a bare name would be looked up from wherever the app was started.
 */
const nativeImport = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>;
let sdk: Promise<AcpSdk> | null = null;
function loadSdk(): Promise<AcpSdk> {
  sdk ??= nativeImport(pathToFileURL(createRequire(__filename).resolve('@agentclientprotocol/sdk')).href) as Promise<AcpSdk>;
  return sdk;
}

interface PermissionOption { optionId: string; kind?: string; name?: string }

export interface AcpHandshake {
  protocolVersion: unknown;
  agentName: string | null;
  agentVersion: string | null;
  canLoadSession: boolean;
  authMethods: string[];
}

function handshakeOf(init: Json): AcpHandshake {
  const info = (init.agentInfo ?? {}) as { name?: unknown; title?: unknown; version?: unknown };
  const caps = (init.agentCapabilities ?? {}) as { loadSession?: unknown };
  const auth = Array.isArray(init.authMethods) ? init.authMethods as Array<{ id?: unknown; name?: unknown }> : [];
  return {
    protocolVersion: init.protocolVersion ?? null,
    agentName: typeof info.title === 'string' ? info.title : typeof info.name === 'string' ? info.name : null,
    agentVersion: typeof info.version === 'string' ? info.version : null,
    canLoadSession: caps.loadSession === true,
    authMethods: auth.map(m => String(m.name ?? m.id ?? '')).filter(Boolean),
  };
}

const INITIALIZE = {
  protocolVersion: 1,
  clientInfo: { name: 'beastie-works', title: 'Beastie Works', version: '0' },
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
};

function startChild(o: AcpShellOptions, cwd: string): ChildProcessWithoutNullStreams {
  // .cmd and .bat launchers (dsh.cmd) only run through the shell on Windows.
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(o.command);
  const child = spawn(viaShell ? `"${o.command}"` : o.command, o.args, {
    cwd, env: { ...process.env, ...(o.env ?? {}) }, windowsHide: true, shell: viaShell, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();   // drained, not kept: it may echo configuration
  return child;
}

async function connect(o: AcpShellOptions, child: ChildProcessWithoutNullStreams, app: AcpClientApp, lib: AcpSdk): Promise<{ conn: AcpConnection; init: Json }> {
  const conn = app.connect(lib.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const timeoutMs = o.readyTimeoutMs ?? 30000;
  let timer: NodeJS.Timeout | undefined;
  const gone = new Promise<never>((_, reject) => {
    child.once('error', err => reject(new Error(`${o.label} could not start: ${err.message}`)));
    child.once('exit', code => reject(new Error(`${o.label} stopped before it answered (exit ${code ?? 'unknown'})`)));
    timer = setTimeout(() => reject(new Error(`${o.label} did not answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  });
  try {
    const init = await Promise.race([conn.agent.request('initialize', INITIALIZE), gone]);
    return { conn, init };
  } finally {
    clearTimeout(timer);
  }
}

/** Start the agent, exchange the first handshake and stop it again. Sends no message, so it uses no model quota. */
export async function probeAcpAgent(o: AcpShellOptions, cwd: string): Promise<AcpHandshake> {
  const lib = await loadSdk();
  const child = startChild(o, cwd);
  try {
    const { conn, init } = await connect(o, child, lib.client(), lib);
    conn.close();
    return handshakeOf(init);
  } finally {
    if (child.pid) hardKillTree(child.pid); else try { child.kill(); } catch { /* gone */ }
  }
}

export class AcpSession implements ShellSession {
  ref = '';
  private listeners = new Set<(e: ShellEvent) => void>();
  private approvals = new Map<string, { options: PermissionOption[]; settle: (outcome: Json) => void }>();
  private tools = new Map<string, string>();
  private text = '';
  private seq = 0;
  private first: string | null;
  private exited = false;
  private conn: AcpConnection | null = null;
  /** The agent's latest word on this session's options (from session/new, then from each change). */
  private state: Json = {};
  private seat: ToolSeat | null = null;
  private hostTools = new Set<string>();
  private hostCalls = new Map<string, (r: HostToolResult) => void>();
  private calls = new Map<string, Json>();
  /** Dollars the agent reported for this session so far (ACP usage_update.cost is a running total). */
  private reportedUsd = 0;
  private reportedThisTurn = false;
  /** The model this session was opened on (a Magpie id is priced by its model part). */
  private readonly asked: string | null;

  constructor(private readonly o: AcpShellOptions, private readonly child: ChildProcessWithoutNullStreams, spec: SessionSpec) {
    this.first = spec.systemPrompt.trim() ? spec.systemPrompt.trim() : null;
    this.asked = spec.model ?? o.model ?? null;
    child.on('exit', (code, signal) => { this.exited = true; this.cancelApprovals(); this.dropTools(); this.emit({ type: 'exited', detail: `${o.label} exited (${code ?? signal ?? 'unknown'})` }); });
    child.on('error', err => { this.exited = true; this.emit({ type: 'exited', detail: `${o.label} failed: ${err.message}` }); });
  }

  async start(spec: SessionSpec, lib: AcpSdk): Promise<void> {
    const app = lib.client()
      .onNotification('session/update', ((ctx: { params: Json }) => this.update(ctx.params)) as never)
      .onRequest('session/request_permission', ((ctx: { params: Json }) => this.permission(ctx.params)) as never);
    const { conn, init } = await connect(this.o, this.child, app, lib);
    this.conn = conn;
    const shake = handshakeOf(init);
    const mcpServers: unknown[] = [];
    if (spec.hostTools.length) {
      if (!this.o.node) throw new Error('V8_ACP_HOST_TOOLS_NEED_NODE');
      for (const t of spec.hostTools) this.hostTools.add(t.name);
      this.seat = await openToolSeat(spec.hostTools, (name, args) => this.hostCall(name, args), this.o.node);
      mcpServers.push(this.seat.server);
    }
    if (spec.sessionRef && shake.canLoadSession) {
      const loaded = await conn.agent.request('session/load', { sessionId: spec.sessionRef, cwd: spec.cwd, mcpServers, ...this.meta(spec) });
      this.ref = spec.sessionRef;
      this.first = null;   // a loaded session already carries its instructions
      this.text = '';      // loading replays the old conversation; none of it is new
      // A loaded session starts on the agent's own defaults again: Codex resumed a rework on its default model
      // (gpt-6.1-sol, medium) on 2026-11-19 because only new sessions were set up. Set it up the same way.
      this.state = loaded && typeof loaded === 'object' ? loaded : {};
      await this.setUp(spec);
      return;
    }
    const made = await conn.agent.request('session/new', { cwd: spec.cwd, mcpServers, ...this.meta(spec) });
    this.ref = typeof made.sessionId === 'string' ? made.sessionId : '';
    if (!this.ref) throw new Error(`${this.o.label} did not report a session`);
    this.state = made;
    await this.setUp(spec);
  }

  /** The light start's `_meta` for the lead and the reviewer (see AcpShellOptions.light). */
  private meta(spec: SessionSpec): { _meta?: Record<string, unknown> } {
    const m = spec.role !== 'worker' ? this.o.light?.sessionMeta : undefined;
    return m ? { _meta: m } : {};
  }

  /** The role's mode, then the model and effort. A mode the agent does not offer is left as the agent has it; a
   *  model or effort it does not offer is an error, so nobody works on a model they did not choose. */
  private async setUp(spec: SessionSpec): Promise<void> {
    const mode = this.o.modes?.[spec.role];
    if (mode) {
      const option = (Array.isArray(this.state.configOptions) ? this.state.configOptions as RawOption[] : []).find(o => o?.category === 'mode');
      const modes = this.state.modes as { availableModes?: Array<{ id?: unknown }> } | undefined;
      if (option && valuesOf(option).some(c => c.id === mode)) {
        const answer = await this.conn!.agent.request('session/set_config_option', { sessionId: this.ref, configId: option.id, value: mode });
        if (Array.isArray(answer.configOptions)) this.state = { ...this.state, configOptions: answer.configOptions };
      } else if (modes?.availableModes?.some(m => m.id === mode)) {
        await this.conn!.agent.request('session/set_mode', { sessionId: this.ref, modeId: mode });
      }
    }
    const model = spec.model ?? this.o.model;
    // A Magpie model is set where the session starts (AcpShellOptions.magpie), not from the agent's own list.
    const onMagpie = !!model && !!viaMagpie(model);
    if (model && !onMagpie && this.choices().model?.current !== model) await this.choose('model', model);
    const effort = spec.effort ?? this.o.effort;
    // On a Magpie model the agent may not know the model and offer no effort to pick (Codex does not): the effort was
    // given where the session starts (the wiring), so it is picked here only when the agent offers it.
    const offered = this.choices().effort;
    if (effort && offered?.current !== effort && (!onMagpie || offered?.choices.some(c => c.id === effort))) await this.choose('effort', effort);
  }

  // --- model and effort, as the agent itself offers them ---

  /** What this session can be switched to. Read from the agent's own answer, never from a list kept in the app. */
  choices(): SessionChoices { return readChoices(this.state); }

  /** Switch the model or the reasoning effort of this session. The agent's answer is the new truth. */
  async choose(kind: 'model' | 'effort', value: string): Promise<SessionChoices> {
    const conn = this.conn;
    if (!conn || this.exited) throw new Error(`${this.o.label} is not running`);
    const option = findOption(this.state, kind);
    if (option) {
      const answer = await conn.agent.request('session/set_config_option', { sessionId: this.ref, configId: option.id, value });
      if (Array.isArray(answer.configOptions)) this.state = { ...this.state, configOptions: answer.configOptions };
    } else if (kind === 'model' && this.state.models) {
      // Older agents: a plain model list and session/set_model.
      await conn.agent.request('session/set_model', { sessionId: this.ref, modelId: value });
      this.state = { ...this.state, models: { ...(this.state.models as Json), currentModelId: value } };
    } else {
      throw new Error(`${this.o.label} offers no ${kind} choice`);
    }
    return this.choices();
  }

  // --- ShellSession ---

  prompt(text: string): void {
    const conn = this.conn;
    if (!conn || this.exited) return;
    const body = this.first ? `${this.first}\n\n${text}` : text;
    this.first = null;
    this.reportedThisTurn = false;
    conn.agent.request('session/prompt', { sessionId: this.ref, prompt: [{ type: 'text', text: body }] }).then(
      done => { this.flush(); this.costOf(done); this.emit({ type: 'settled', status: done.stopReason === 'cancelled' ? 'aborted' : 'completed', ...(done.stopReason && done.stopReason !== 'end_turn' && done.stopReason !== 'cancelled' ? { detail: String(done.stopReason) } : {}) }); },
      err => { this.flush(); if (!this.exited) this.emit({ type: 'settled', status: 'error', detail: err instanceof Error ? err.message : String(err) }); },
    );
  }
  /** ACP has no way to add to a running turn, so this arrives as the next message. */
  steer(text: string): void { this.prompt(text); }
  abort(): void {
    this.cancelApprovals();
    void this.conn?.agent.notify('session/cancel', { sessionId: this.ref }).catch(() => { /* closing */ });
  }
  respondApproval(id: string, allow: boolean): void {
    const waiting = this.approvals.get(id);
    if (!waiting) return;
    this.approvals.delete(id);
    waiting.settle(pickOption(waiting.options, allow));
  }
  respondHostTool(id: string, result: HostToolResult): void {
    const settle = this.hostCalls.get(id);
    if (!settle) return;
    this.hostCalls.delete(id);
    settle(result);
  }
  onEvent(listener: (e: ShellEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> {
    this.listeners.clear();
    this.cancelApprovals();
    this.dropTools();
    if (this.exited) return;
    const pid = this.child.pid;
    const done = new Promise<void>(r => this.child.once('exit', () => r()));
    try { this.conn?.close(); } catch { /* already closed */ }
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const t = setTimeout(() => { if (pid) hardKillTree(pid); else try { this.child.kill(); } catch { /* gone */ } }, 3000);
    await done;
    clearTimeout(t);
  }

  // --- from the agent ---

  private update(p: Json): void {
    if (p.sessionId !== this.ref && this.ref) return;
    const u = (p.update ?? {}) as Json;
    switch (u.sessionUpdate) {
      case 'usage_update': {
        const cost = u.cost as { amount?: unknown; currency?: unknown } | null | undefined;
        if (cost && cost.currency === 'USD' && typeof cost.amount === 'number' && Number.isFinite(cost.amount)) {
          const delta = cost.amount - this.reportedUsd;
          this.reportedUsd = cost.amount;
          this.reportedThisTurn = true;
          if (delta > 0) this.emit({ type: 'cost', usd: delta, basis: 'reported' });
        }
        return;
      }
      case 'config_option_update':
        if (Array.isArray(u.configOptions)) this.state = { ...this.state, configOptions: u.configOptions };
        return;
      case 'agent_message_chunk':
        this.text += textOf(u.content);
        return;
      case 'tool_call': {
        this.flush();
        const callId = String(u.toolCallId ?? ''), name = String(u.title ?? u.kind ?? 'tool');
        this.tools.set(callId, name);
        this.remember(callId, u);
        this.emit({ type: 'tool_start', callId, name, args: u.rawInput ?? null });
        if (u.status === 'completed' || u.status === 'failed') this.endTool(callId, u);
        return;
      }
      case 'tool_call_update':
        this.remember(String(u.toolCallId ?? ''), u);
        if (u.status === 'completed' || u.status === 'failed') this.endTool(String(u.toolCallId ?? ''), u);
        return;
    }
  }

  private endTool(callId: string, u: Json): void {
    const name = this.tools.get(callId);
    if (name === undefined) return;
    this.tools.delete(callId);
    this.emit({ type: 'tool_end', callId, name, ok: u.status === 'completed', summary: textOf(u.content).slice(0, 300) });
  }

  /** What the agent said about a tool call so far. A later permission request may name the call by its id only
   *  (Codex asks about an MCP tool call that way), so the request is read together with what came before. */
  private remember(callId: string, u: Json): void {
    if (!callId) return;
    const before = this.calls.get(callId) ?? {};
    const next: Json = { ...before };
    for (const k of ['title', 'kind', 'rawInput', 'locations', '_meta']) if (u[k] !== undefined && u[k] !== null) next[k] = u[k];
    this.calls.set(callId, next);
    if (this.calls.size > 200) this.calls.delete(this.calls.keys().next().value as string);
  }

  private permission(p: Json): Promise<Json> {
    const asked = (p.toolCall ?? {}) as Json;
    const call: Json = { ...(this.calls.get(String(asked.toolCallId ?? '')) ?? {}), ...Object.fromEntries(Object.entries(asked).filter(([, v]) => v !== undefined && v !== null)) };
    const options = Array.isArray(p.options) ? p.options as PermissionOption[] : [];
    // Calling one of the app's own tools is not a risk to judge: the app decides what the call does when it arrives.
    if (ownTool(call, this.hostTools)) return Promise.resolve(pickOption(options, true));
    const ask = describePermission(call);
    const id = 'a' + ++this.seq;
    this.flush();
    return new Promise(resolve => {
      this.approvals.set(id, { options, settle: resolve });
      this.emit({ type: 'approval', id, tool: ask.tool, detail: ask.detail });
    });
  }

  /**
   * A turn whose dollars the agent did not report: price its tokens at list prices, or say the cost is unknown.
   * Never a guess: a model missing from the price list stays unknown.
   */
  private costOf(done: Json): void {
    if (this.reportedThisTurn) return;
    const u = (done.usage ?? null) as Record<string, unknown> | null;
    const n = (k: string) => (typeof u?.[k] === 'number' && Number.isFinite(u[k]) ? u[k] as number : 0);
    // Magpie's ids are provider/model: the price list knows the model part.
    const asked = this.asked;
    const model = (viaMagpie(asked)?.split('/').pop()) ?? this.choices().model?.current ?? asked;
    const usd = u && this.o.price ? this.o.price(model, { input: n('inputTokens'), cachedRead: n('cachedReadTokens'), cacheWrite: n('cachedWriteTokens'), output: n('outputTokens') }) : null;
    this.emit(usd === null ? { type: 'cost', usd: 0, basis: 'unknown' } : { type: 'cost', usd, basis: 'estimated' });
  }

  /** One of the app's tools was called through the relay: becomes a host_tool event, answered by respondHostTool. */
  private hostCall(name: string, args: unknown): Promise<HostToolResult> {
    if (this.exited) return Promise.resolve({ ok: false, error: 'session closed' });
    const id = 'h' + ++this.seq;
    this.flush();
    return new Promise(resolve => {
      this.hostCalls.set(id, resolve);
      this.emit({ type: 'host_tool', id, name, args });
    });
  }

  private dropTools(): void {
    this.seat?.close();
    this.seat = null;
    for (const settle of this.hostCalls.values()) settle({ ok: false, error: 'session closed' });
    this.hostCalls.clear();
  }

  private cancelApprovals(): void {
    for (const waiting of this.approvals.values()) waiting.settle({ outcome: { outcome: 'cancelled' } });
    this.approvals.clear();
  }

  /** What the agent has said since the last event, as one message. */
  private flush(): void {
    const text = this.text.trim();
    this.text = '';
    if (text) this.emit({ type: 'message', text });
  }

  private emit(e: ShellEvent): void { for (const l of [...this.listeners]) l(e); }
}

/** Answer a permission request: allow once, or reject once (never "always"). */
function pickOption(options: PermissionOption[], allow: boolean): Json {
  const want = allow ? 'allow_once' : 'reject_once';
  const pick = options.find(opt => opt.kind === want) ?? options.find(opt => String(opt.kind ?? '').startsWith(allow ? 'allow' : 'reject'));
  return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
}

/**
 * Which of the app's own tools a permission request is for, if any. Agents name an MCP tool in their own way
 * ("beastie.open_ticket", "mcp__beastie__open_ticket", "Allow beastie to run open_ticket?"), so it counts when the
 * request names one of our tools and touches no file and runs no command.
 */
export function ownTool(call: Json, names: Set<string>): string | null {
  if (!names.size) return null;
  const ask = describePermission(call);
  if (/^(Command|Path): /m.test(ask.detail)) return null;
  const said = String(call.title ?? '') + ' ' + JSON.stringify(call.rawInput ?? null) + ' ' + JSON.stringify(call._meta ?? null);
  for (const n of names) if (new RegExp('(^|[^A-Za-z0-9_]|__)' + n + '($|[^A-Za-z0-9_])').test(said)) return n;
  return null;
}

/** Codex wraps a command line in its shell: ["powershell.exe", "-Command", "…"] or ["bash", "-lc", "…"]. */
const SHELL_WRAP = /^\S*?(?:bash|sh|zsh|powershell|pwsh|cmd)(?:\.exe)?\s+(?:-lc|-c|-Command|\/c)\s+([\s\S]+)$/i;

/**
 * A permission request in the shape `approval.ts` judges: the tool kind as it knows them, and the file or command
 * on its own line. ACP says what a call touches in `locations` and, per agent, in `rawInput`.
 */
export function describePermission(call: Json): { tool: string; detail: string } {
  const kind = String(call.kind ?? 'other');
  const raw = (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}) as Record<string, unknown>;
  const lines = [String(call.title ?? '')];
  const paths = new Set<string>();
  for (const l of Array.isArray(call.locations) ? call.locations as Array<{ path?: unknown }> : []) if (typeof l?.path === 'string') paths.add(l.path);
  for (const k of ['file_path', 'path', 'filePath', 'notebook_path']) if (typeof raw[k] === 'string') paths.add(raw[k] as string);
  const changes = raw.changes;
  if (changes && typeof changes === 'object' && !Array.isArray(changes)) for (const p of Object.keys(changes)) paths.add(p);
  let command: string | null = null;
  if (typeof raw.command === 'string') command = raw.command;
  else if (Array.isArray(raw.command)) command = (raw.command as unknown[]).map(String).join(' ');
  if (command) {
    const m = SHELL_WRAP.exec(command);
    if (m) command = m[1].replace(/^["']|["']$/g, '');
    lines.push('Command: ' + command);
  }
  for (const p of paths) lines.push('Path: ' + p);
  const tool = kind === 'edit' ? 'edit' : kind === 'execute' || command ? 'bash' : kind;
  return { tool, detail: lines.join('\n') };
}

interface RawOption { id: string; category?: string; currentValue?: unknown; options?: unknown }

/** The session option that carries the model or the reasoning effort. The way of reading these follows OpenMausBot's
 *  `drivers/acp/config-options.ts`: the option is found by its category, and its values may sit inside named groups. */
function findOption(state: Json, kind: 'model' | 'effort'): RawOption | null {
  const all = Array.isArray(state.configOptions) ? state.configOptions as RawOption[] : [];
  const category = kind === 'model' ? 'model' : 'thought_level';
  return all.find(o => o && typeof o.id === 'string' && o.category === category) ?? (kind === 'model' ? all.find(o => o?.id === 'model') ?? null : null);
}

function valuesOf(option: RawOption | null): Choice[] {
  const out: Choice[] = [];
  const collect = (entries: unknown, group: string | null, depth: number) => {
    if (!Array.isArray(entries) || depth > 8) return;
    for (const raw of entries as Array<{ value?: unknown; name?: unknown; group?: unknown; options?: unknown }>) {
      if (!raw || typeof raw !== 'object') continue;
      if (typeof raw.value === 'string' && raw.value) {
        if (!out.some(c => c.id === raw.value)) out.push({ id: raw.value, label: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : raw.value, group });
      } else {
        collect(raw.options, typeof raw.name === 'string' ? raw.name : typeof raw.group === 'string' ? raw.group : group, depth + 1);
      }
    }
  };
  collect(option?.options, null, 0);
  return out;
}

function readChoices(state: Json): SessionChoices {
  const one = (kind: 'model' | 'effort'): ChoiceList | null => {
    const option = findOption(state, kind);
    const choices = valuesOf(option);
    return option && choices.length ? { current: typeof option.currentValue === 'string' ? option.currentValue : null, choices } : null;
  };
  let model = one('model');
  const legacy = state.models as { currentModelId?: unknown; availableModels?: Array<{ modelId?: unknown; name?: unknown }> } | undefined;
  if (!model && Array.isArray(legacy?.availableModels)) {
    const choices = legacy.availableModels.filter(m => typeof m?.modelId === 'string').map(m => ({ id: m.modelId as string, label: typeof m.name === 'string' ? m.name : m.modelId as string, group: null }));
    if (choices.length) model = { current: typeof legacy.currentModelId === 'string' ? legacy.currentModelId : null, choices };
  }
  return { model, effort: one('effort') };
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).join(' ');
  if (v && typeof v === 'object') {
    const o = v as { text?: unknown; content?: unknown };
    if (typeof o.text === 'string') return o.text;
    if (o.content !== undefined) return textOf(o.content);
  }
  return '';
}

export class AcpShell implements AgentShell {
  constructor(private readonly options: AcpShellOptions) {}

  async open(spec: SessionSpec): Promise<AcpSession> {
    const lib = await loadSdk();
    const light = spec.role !== 'worker' ? this.options.light : undefined;
    let env: Record<string, string> = { ...(this.options.env ?? {}), ...(light?.env ?? {}) };
    const magpie = viaMagpie(spec.model ?? this.options.model);
    if (magpie) {
      if (!this.options.magpie) throw new Error(`${this.options.label} 不能经 Magpie 换别家的模型`);
      env = { ...env, ...await this.options.magpie.wire(await this.options.magpie.origin(), magpie, env, spec.effort ?? this.options.effort) };
    }
    const child = startChild({ ...this.options, env }, spec.cwd);
    const session = new AcpSession(this.options, child, spec);
    try {
      await session.start(spec, lib);
    } catch (err) {
      if (child.pid) hardKillTree(child.pid); else try { child.kill(); } catch { /* gone */ }
      throw err;
    }
    return session;
  }
}
