import type { AgentShell, HostToolResult, SessionSpec, ShellEvent, ShellSession } from './shell';

/**
 * A shell that calls no model. Each session runs a script: the script reacts to prompt/steer/abort and emits
 * events, calls host tools and asks for approvals the way a real gremlin would. Used for tests and for building
 * the UI before anything real is wired in.
 */

export interface FakeControl {
  readonly spec: SessionSpec;
  readonly ref: string;
  /** Everything said to this session so far: prompts and steers, in order. */
  readonly heard: Array<{ kind: 'prompt' | 'steer'; text: string }>;
  readonly aborted: boolean;
  emit(event: ShellEvent): void;
  /** Call one of the app's tools and wait for its answer. */
  hostTool(name: string, args: unknown): Promise<HostToolResult>;
  /** Ask the app to approve a shell tool call and wait for the answer. */
  approval(tool: string, detail: string): Promise<boolean>;
  /** Pretend to run one shell tool. */
  tool(name: string, args: unknown, summary?: string): void;
  settle(status?: 'completed' | 'aborted' | 'error', detail?: string): void;
  exit(detail: string): void;
}

export interface FakeScript {
  onPrompt?(c: FakeControl, text: string): void | Promise<void>;
  onSteer?(c: FakeControl, text: string): void | Promise<void>;
}

export type FakeScripts = (spec: SessionSpec) => FakeScript;

let seq = 0;

class FakeSession implements ShellSession, FakeControl {
  readonly heard: Array<{ kind: 'prompt' | 'steer'; text: string }> = [];
  aborted = false;
  closed = false;
  private listeners = new Set<(e: ShellEvent) => void>();
  private waiting = new Map<string, (v: unknown) => void>();
  private calls = 0;

  constructor(readonly spec: SessionSpec, readonly ref: string, private script: FakeScript, private log: FakeShell['log']) {}

  // --- ShellSession ---
  prompt(text: string): void { this.heard.push({ kind: 'prompt', text }); this.aborted = false; this.later(() => this.script.onPrompt?.(this, text)); }
  steer(text: string): void { this.heard.push({ kind: 'steer', text }); this.later(() => this.script.onSteer?.(this, text)); }
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const resolve of this.waiting.values()) resolve(undefined);
    this.waiting.clear();
    this.later(() => this.raw({ type: 'settled', status: 'aborted' }));
  }
  respondApproval(id: string, allow: boolean): void { this.log.push({ ref: this.ref, kind: 'approval', id, value: allow }); this.resolve(id, allow); }
  respondHostTool(id: string, result: HostToolResult): void { this.log.push({ ref: this.ref, kind: 'host_tool', id, value: result }); this.resolve(id, result); }
  onEvent(listener: (e: ShellEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** The process is gone: the script stops too (it sees `aborted`), and nothing it emits arrives anywhere. */
  async close(): Promise<void> { this.closed = true; this.aborted = true; this.listeners.clear(); for (const r of this.waiting.values()) r(undefined); this.waiting.clear(); }

  // --- FakeControl ---
  emit(event: ShellEvent): void { if (!this.aborted) this.raw(event); }
  hostTool(name: string, args: unknown): Promise<HostToolResult> {
    const id = this.ref + ':h' + ++this.calls;
    const p = new Promise<HostToolResult>(r => this.waiting.set(id, r as (v: unknown) => void));
    this.emit({ type: 'host_tool', id, name, args });
    return p;
  }
  approval(tool: string, detail: string): Promise<boolean> {
    const id = this.ref + ':a' + ++this.calls;
    const p = new Promise<boolean>(r => this.waiting.set(id, r as (v: unknown) => void));
    this.emit({ type: 'approval', id, tool, detail });
    return p;
  }
  tool(name: string, args: unknown, summary = 'ok'): void {
    const callId = this.ref + ':t' + ++this.calls;
    this.emit({ type: 'tool_start', callId, name, args });
    this.emit({ type: 'tool_end', callId, name, ok: true, summary });
  }
  settle(status: 'completed' | 'aborted' | 'error' = 'completed', detail?: string): void { this.emit({ type: 'settled', status, ...(detail ? { detail } : {}) }); }
  exit(detail: string): void { this.raw({ type: 'exited', detail }); }

  private raw(e: ShellEvent): void { if (!this.closed) for (const l of [...this.listeners]) l(e); }
  private resolve(id: string, value: unknown): void { const r = this.waiting.get(id); if (r) { this.waiting.delete(id); r(value); } }
  /** Scripts run on a later tick, the way a real shell answers asynchronously. */
  private later(fn: () => unknown): void { setImmediate(() => { void Promise.resolve().then(fn).catch(err => this.raw({ type: 'settled', status: 'error', detail: String(err) })); }); }
}

export class FakeShell implements AgentShell {
  readonly sessions: FakeSession[] = [];
  /** Every answer the app gave, for assertions. */
  readonly log: Array<{ ref: string; kind: 'approval' | 'host_tool'; id: string; value: unknown }> = [];

  constructor(private scripts: FakeScripts) {}

  async open(spec: SessionSpec): Promise<ShellSession> {
    const ref = spec.sessionRef ?? 'fake-' + spec.role + '-' + ++seq;
    const s = new FakeSession(spec, ref, this.scripts(spec), this.log);
    this.sessions.push(s);
    return s;
  }

  /** All sessions ever opened under one ref (a resumed session shows up again under the same ref). */
  byRef(ref: string): FakeSession[] { return this.sessions.filter(s => s.ref === ref); }
}
