import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentShell, HostToolResult, SessionSpec, ShellEvent, ShellSession } from './shell';
import { MAGPIE_KEY_ENV, MAGPIE_LOCAL_KEY, ompGatewayAgentDir } from './supply';
import { captureOwnedTreeAsync, processInventory, type ProcessIdentity } from '../ownedProcessTree';
import { hardKillTree } from '../procKill';

/** Kill whatever of a recorded tree outlived its root: same pid and same start time, so a reused pid is spared. */
function sweep(tree: ProcessIdentity[]): void {
  if (tree.length < 2) return;
  let now: Map<number, string>;
  try { now = new Map(processInventory().map(r => [r.pid, r.started])); } catch { return; }
  for (const p of tree.slice(1)) if (now.get(p.pid) === p.started) hardKillTree(p.pid);
}

/**
 * AgentShell on oh-my-pi's RPC mode (`omp --mode rpc`): newline-delimited JSON over stdio.
 *
 * - The lead runs with every built-in tool off (`--no-tools`) and only the app's host tools.
 * - A gremlin runs with omp's own tools plus the app's report tool, in its ticket's directory.
 * - Approvals are never automatic (`--approval-mode always-ask`); every request comes to the app.
 * - A session is resumed by its session file (`switch_session`), which is the ref the app keeps.
 * - The child gets a minimal environment: system basics, the agent dir, and what the caller passes (the model key).
 */

export interface OmpShellOptions {
  /** omp.exe, or (in tests) node plus a script in `prefixArgs`. */
  exe: string;
  prefixArgs?: string[];
  /** PI_CODING_AGENT_DIR: omp's own settings, auth and caches. */
  agentDir: string;
  /** Where session files are written. */
  sessionDir: string;
  /** Extra environment for the child, e.g. the model API key. Never logged. */
  env?: Record<string, string>;
  /** Directories put in front of PATH, e.g. the Python the project's tests need. */
  extraPath?: string[];
  /** Hard spending cap per session in USD; omp stops sending model requests past it. */
  maxCostUsd?: number;
  /** How long to wait for the child to say it is ready. */
  readyTimeoutMs?: number;
  /**
   * The supply layer (v8 计划书 S1.5). When the gateway is up and the session has a supply mark, the session gets its
   * own agent folder under `agentBase` whose only provider is Magpie, carrying that mark; omp then needs no sign-in.
   */
  gateway?: { origin(): string | null; agentBase: string };
}

const BASE_ENV = ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'TZ'];

function childEnv(o: OmpShellOptions, agentDir = o.agentDir, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of BASE_ENV) { const v = process.env[k]; if (v !== undefined) env[k] = v; }
  const sep = process.platform === 'win32' ? ';' : ':';
  env.PATH = [...(o.extraPath ?? []), process.env.PATH ?? process.env.Path ?? ''].filter(Boolean).join(sep);
  env.PI_CODING_AGENT_DIR = agentDir.replace(/\\/g, '/');   // omp needs forward slashes here
  return { ...env, ...(o.env ?? {}), ...extra };
}

export function ompArgs(spec: SessionSpec, o: Pick<OmpShellOptions, 'sessionDir' | 'maxCostUsd'>): string[] {
  const args = ['--mode', 'rpc', '--cwd', spec.cwd, '--approval-mode', 'always-ask', '--no-title', '--no-extensions', '--session-dir', o.sessionDir];
  if (spec.model) args.push('--model', spec.model);
  if (o.maxCostUsd !== undefined) {
    if (!(o.maxCostUsd > 0 && o.maxCostUsd <= 100)) throw new Error('V8_MAX_COST_INVALID');
    args.push('--max-cost', String(o.maxCostUsd));
  }
  if (spec.builtinTools) args.push('--no-pty', '--append-system-prompt', spec.systemPrompt);
  else args.push('--no-tools', '--no-lsp', '--no-skills', '--no-context-files', '--system-prompt', spec.systemPrompt);
  return args;
}

type Frame = Record<string, unknown> & { type?: string; id?: string };

class OmpSession implements ShellSession {
  ref = '';
  private listeners = new Set<(e: ShellEvent) => void>();
  private waiting = new Map<string, (f: Frame) => void>();
  private buffer = '';
  private seq = 0;
  private prompts = new Set<string>();
  private lastCost = 0;
  private exited = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.read(chunk));
    child.on('exit', (code, signal) => { this.exited = true; this.emit({ type: 'exited', detail: `omp exited (${code ?? signal ?? 'unknown'})` }); });
    child.on('error', err => { this.exited = true; this.emit({ type: 'exited', detail: 'omp failed: ' + err.message }); });
  }

  // --- startup ---

  async start(spec: SessionSpec, timeoutMs: number): Promise<void> {
    await this.nextFrame('ready', timeoutMs);
    if (spec.hostTools.length) {
      await this.request({ type: 'set_host_tools', tools: spec.hostTools.map(t => ({ name: t.name, label: t.name, description: t.description, parameters: t.parameters, loadMode: 'essential' })) });
    }
    if (spec.sessionRef) await this.request({ type: 'switch_session', sessionPath: spec.sessionRef });
    const state = await this.request({ type: 'get_state' });
    const data = (state.data ?? {}) as { sessionFile?: string; sessionId?: string };
    this.ref = data.sessionFile || data.sessionId || '';
    if (!this.ref) throw new Error('omp did not report a session');
  }

  // --- ShellSession ---

  prompt(text: string): void {
    const id = 'p' + ++this.seq;
    this.prompts.add(id);
    this.send({ id, type: 'prompt', message: text });
  }
  steer(text: string): void { this.send({ type: 'steer', message: text }); }
  abort(): void { this.send({ type: 'abort' }); }
  respondApproval(id: string, allow: boolean): void { this.send({ type: 'extension_ui_response', id, value: allow ? 'Approve' : 'Deny' }); }
  respondHostTool(id: string, r: HostToolResult): void {
    this.send(r.ok
      ? { type: 'host_tool_result', id, result: { content: [{ type: 'text', text: r.text }] } }
      : { type: 'host_tool_result', id, isError: true, result: { content: [{ type: 'text', text: r.error }] } });
  }
  onEvent(listener: (e: ShellEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /**
   * End omp and everything it started (v8 计划书 S2.4). omp's own commands (tests, servers) can outlive it, so the tree
   * is recorded first (identity only: pid, parent, start time) and any of it still alive afterwards is killed.
   */
  async close(): Promise<void> {
    this.listeners.clear();
    if (this.exited) return;
    const pid = this.child.pid;
    let tree: ProcessIdentity[] = [];
    if (pid) { try { tree = await captureOwnedTreeAsync(pid); } catch { /* cannot see the tree: still close omp */ } }
    if (this.exited) return sweep(tree);
    const done = new Promise<void>(r => this.child.once('exit', () => r()));
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const t = setTimeout(() => { if (pid) hardKillTree(pid); else try { this.child.kill(); } catch { /* gone */ } }, 3000);
    await done;
    clearTimeout(t);
    sweep(tree);
  }

  // --- wire ---

  private send(f: Frame): void { if (!this.exited) this.child.stdin.write(JSON.stringify(f) + '\n'); }

  private request(f: Frame, timeoutMs = 15000): Promise<Frame> {
    const id = 'r' + ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(id); reject(new Error('omp did not answer ' + f.type)); }, timeoutMs);
      this.waiting.set(id, frame => { clearTimeout(t); frame.success === false ? reject(new Error(String(frame.error ?? f.type + ' failed'))) : resolve(frame); });
      this.send({ ...f, id });
    });
  }

  private nextFrame(type: string, timeoutMs: number): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const key = '@' + type;
      const t = setTimeout(() => { this.waiting.delete(key); reject(new Error('omp did not start (no ' + type + ')')); }, timeoutMs);
      this.waiting.set(key, f => { clearTimeout(t); resolve(f); });
    });
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let f: Frame;
      try { f = JSON.parse(line) as Frame; } catch { continue; }
      this.handle(f);
    }
  }

  private handle(f: Frame): void {
    const byType = this.waiting.get('@' + f.type);
    if (byType) { this.waiting.delete('@' + f.type); byType(f); return; }
    if (f.type === 'response' && typeof f.id === 'string' && this.waiting.has(f.id)) { const w = this.waiting.get(f.id)!; this.waiting.delete(f.id); w(f); return; }
    switch (f.type) {
      case 'tool_execution_start':
        this.emit({ type: 'tool_start', callId: String(f.toolCallId ?? f.id ?? ''), name: String(f.toolName ?? f.name ?? 'tool'), args: f.args ?? f.input ?? null });
        return;
      case 'tool_execution_end':
        this.emit({ type: 'tool_end', callId: String(f.toolCallId ?? f.id ?? ''), name: String(f.toolName ?? f.name ?? 'tool'), ok: !f.isError, summary: textOf(f.result).slice(0, 300) });
        return;
      case 'message_end': {
        const m = (f.message ?? {}) as { role?: string; content?: unknown };
        if (m.role === 'assistant') { const text = textOf(m.content).trim(); if (text) this.emit({ type: 'message', text }); }
        return;
      }
      case 'extension_ui_request': {
        const method = f.method, id = String(f.id ?? '');
        if (method === 'select') {
          const title = String(f.title ?? '');
          const tool = /^Allow tool:\s*(\S+)/.exec(title)?.[1] ?? 'unknown';
          this.emit({ type: 'approval', id, tool, detail: title });
        } else if (method === 'confirm') this.send({ type: 'extension_ui_response', id, confirmed: false });
        else if (method === 'input' || method === 'editor') this.send({ type: 'extension_ui_response', id, cancelled: true });
        return;   // widgets, status lines and notices need no answer
      }
      case 'host_tool_call':
        this.emit({ type: 'host_tool', id: String(f.id ?? ''), name: String(f.toolName ?? ''), args: f.arguments ?? {} });
        return;
      case 'prompt_result': {
        if (typeof f.id !== 'string' || !this.prompts.delete(f.id)) return;
        const status = f.status === 'aborted' ? 'aborted' : f.status === 'error' ? 'error' : 'completed';
        void this.reportCost().finally(() => this.emit({ type: 'settled', status, ...(f.error ? { detail: String(f.error) } : {}) }));
        return;
      }
    }
  }

  /** The cost of the turn that just ended, from the session's running total. */
  private async reportCost(): Promise<void> {
    try {
      const stats = await this.request({ type: 'get_session_stats' }, 5000);
      const total = findCost(stats.data);
      if (total !== null && total > this.lastCost) { this.emit({ type: 'cost', usd: total - this.lastCost }); this.lastCost = total; }
    } catch { /* cost is informative only */ }
  }

  private emit(e: ShellEvent): void { for (const l of [...this.listeners]) l(e); }
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).join(' ');
  if (v && typeof v === 'object') {
    const o = v as { type?: string; text?: unknown; content?: unknown };
    if (o.type === 'thinking') return '';
    if (typeof o.text === 'string') return o.text;
    if (o.content !== undefined) return textOf(o.content);
  }
  return '';
}

/** get_session_stats carries the running cost somewhere under a `cost` key (a number, or { total }). */
function findCost(v: unknown, depth = 0): number | null {
  if (!v || typeof v !== 'object' || depth > 4) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.cost === 'number') return o.cost;
  if (o.cost && typeof o.cost === 'object' && typeof (o.cost as { total?: unknown }).total === 'number') return (o.cost as { total: number }).total;
  for (const k of Object.keys(o)) { const c = findCost(o[k], depth + 1); if (c !== null) return c; }
  return null;
}

export class OmpShell implements AgentShell {
  constructor(private readonly options: OmpShellOptions) {}

  async open(spec: SessionSpec): Promise<ShellSession> {
    const via = this.viaGateway(spec);
    const child = spawn(this.options.exe, [...(this.options.prefixArgs ?? []), ...ompArgs(via.spec, this.options)], {
      cwd: spec.cwd, env: childEnv(this.options, via.agentDir, via.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.resume();   // drained, not kept: it may echo configuration
    const session = new OmpSession(child);
    try {
      await session.start(spec, this.options.readyTimeoutMs ?? 30000);
    } catch (err) {
      try { child.kill(); } catch { /* gone */ }
      throw err;
    }
    return session;
  }

  /** Route this session through Magpie when there is one; otherwise run as before with omp's own agent folder. */
  private viaGateway(spec: SessionSpec): { spec: SessionSpec; agentDir: string; env: Record<string, string> } {
    const g = this.options.gateway, origin = g?.origin() ?? null;
    if (!g || !origin || !spec.supplySession || !spec.model) return { spec, agentDir: this.options.agentDir, env: {} };
    const own = ompGatewayAgentDir(g.agentBase, spec.supplySession, origin, spec.model, spec.supplyAccount);
    return { spec: { ...spec, model: own.model }, agentDir: own.dir, env: { [MAGPIE_KEY_ENV]: MAGPIE_LOCAL_KEY } };
  }
}
