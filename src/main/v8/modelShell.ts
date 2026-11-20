import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentShell, HostTool, HostToolResult, SessionSpec, ShellEvent, ShellSession } from './shell';
import { MAGPIE_LOCAL_KEY } from './supply';

/**
 * The lead and the reviewer without a harness (v8 计划书 S1.8). They do no work, so they need no file or command tools:
 * only a model and the app's own tools. This talks the OpenAI Responses protocol straight to the supply gateway
 * (Magpie), which translates to any provider, keeps the session on one account and can use subscription quota.
 *
 * The six actions of the shell interface, over plain HTTP:
 *   prompt  — add the text, then loop: ask the model; each function call becomes a host_tool event; when every call is
 *             answered, ask again; a reply without calls ends the turn (settled).
 *   steer   — there is no injecting into a request in flight, so the request is cancelled and asked again with the
 *             new text added (the lead and reviewer only ever do this between turns anyway).
 *   abort   — cancel the request in flight; the turn settles as aborted.
 *   approvals never come: there are no built-in tools to ask about.
 * The conversation is kept by the app, one JSON file per session; that file is the session's ref, so a session can
 * be resumed after a restart.
 */

export interface ModelShellOptions {
  /** The gateway's address (Magpie), or null when it is not up. */
  origin(): string | null;
  /** Where conversation files go. */
  historyDir: string;
  /** Bearer token for the gateway. Default: the app's local label Magpie expects. */
  apiKey?: string;
  /** Per request. Default 120 s. */
  requestTimeoutMs?: number;
}

type Item = Record<string, unknown>;
interface Saved { model: string; instructions: string; input: Item[] }

class ModelSession implements ShellSession {
  private listeners = new Set<(e: ShellEvent) => void>();
  private pending = new Map<string, Item | null>();   // call_id → its output once answered
  private controller: AbortController | null = null;
  private running = false;
  private closed = false;
  private queued: string[] = [];

  constructor(readonly ref: string, private readonly saved: Saved, private readonly tools: HostTool[], private readonly session: string | undefined, private readonly o: ModelShellOptions, private readonly account?: string) {}

  onEvent(listener: (e: ShellEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(e: ShellEvent): void { for (const l of [...this.listeners]) l(e); }
  private save(): void { writeFileSync(this.ref, JSON.stringify(this.saved)); }

  prompt(text: string): void {
    if (this.closed) return;
    if (this.running) { this.queued.push(text); return; }
    this.saved.input.push({ role: 'user', content: text });
    this.save();
    void this.turn();
  }

  steer(text: string): void {
    if (!this.running) { this.prompt(text); return; }
    this.queued.push(text);
    this.controller?.abort();          // asked again with the new text once the cancelled request unwinds
  }

  abort(): void {
    this.queued = [];
    this.pending.clear();
    if (this.running) { this.controller?.abort(); this.running = false; this.emit({ type: 'settled', status: 'aborted' }); }
  }

  respondApproval(): void { /* no built-in tools, so no approvals */ }

  respondHostTool(id: string, result: HostToolResult): void {
    if (!this.pending.has(id) || this.pending.get(id)) return;
    this.pending.set(id, { type: 'function_call_output', call_id: id, output: result.ok ? result.text : 'ERROR: ' + result.error });
    if ([...this.pending.values()].every(Boolean)) {
      for (const out of this.pending.values()) this.saved.input.push(out!);
      this.pending.clear();
      this.save();
      void this.ask();
    }
  }

  async close(): Promise<void> { this.closed = true; this.queued = []; this.controller?.abort(); this.running = false; }

  private async turn(): Promise<void> { this.running = true; await this.ask(); }

  private async ask(): Promise<void> {
    if (this.closed || !this.running) return;
    const origin = this.o.origin();
    if (!origin) return this.settle('error', 'V8_SUPPLY_NOT_RUNNING');
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.o.requestTimeoutMs ?? 120_000);
    let body: { output?: Item[]; usage?: unknown; error?: { message?: string } };
    try {
      const res = await fetch(origin.replace(/\/$/, '') + '/v1/responses', {
        method: 'POST', signal: controller.signal,
        headers: {
          'content-type': 'application/json', Authorization: 'Bearer ' + (this.o.apiKey ?? MAGPIE_LOCAL_KEY),
          ...(this.session ? { 'X-Magpie-Session': this.session } : {}),
          ...(this.account ? { 'X-Magpie-Account': this.account } : {}),
        },
        body: JSON.stringify({
          model: this.saved.model, instructions: this.saved.instructions, input: this.saved.input, stream: false,
          tools: this.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
        }),
      });
      const raw = await res.text();
      // Quota and rate refusals keep their status so the second line of defence (S2) can tell them apart.
      if (!res.ok) {
        // When the quota is back, if anyone said: Magpie's own header (unix seconds), else Retry-After (seconds).
        const said = Number(res.headers.get('x-magpie-resets-at') ?? '');
        const after = Number(res.headers.get('retry-after') ?? '');
        const resets = said > 0 ? said : after > 0 ? Math.floor(Date.now() / 1000 + after) : 0;
        return this.settle('error', `HTTP ${res.status}${resets ? ' resets=' + resets : ''}: ${raw.slice(0, 300)}`);
      }
      body = JSON.parse(raw);
    } catch (err) {
      if (controller.signal.aborted) {
        if (this.closed || !this.running) return;
        if (this.queued.length) return this.followUp();      // steered: ask again with the new words
        return this.settle('error', 'V8_MODEL_TIMEOUT');
      }
      return this.settle('error', err instanceof Error ? err.message : String(err));
    } finally { clearTimeout(timer); if (this.controller === controller) this.controller = null; }

    const output = Array.isArray(body.output) ? body.output : [];
    const calls = output.filter(i => i.type === 'function_call');
    const text = output.filter(i => i.type === 'message')
      .flatMap(i => Array.isArray(i.content) ? i.content as Item[] : [])
      .filter(c => c.type === 'output_text').map(c => String(c.text ?? '')).join('');
    // Keep what the model said and called, so the next request carries the whole conversation.
    for (const i of output) if (i.type === 'message' || i.type === 'function_call') this.saved.input.push(i);
    this.save();
    if (text.trim()) this.emit({ type: 'message', text });
    if (!calls.length) {
      if (this.queued.length) return this.followUp();
      return this.settle('completed');
    }
    for (const c of calls) this.pending.set(String(c.call_id), null);
    for (const c of calls) {
      let args: unknown = {};
      try { args = JSON.parse(String(c.arguments ?? '{}')); } catch { args = {}; }
      this.emit({ type: 'host_tool', id: String(c.call_id), name: String(c.name), args });
    }
  }

  /** Words that arrived while the model was busy go in as the next user message, same turn. */
  private followUp(): Promise<void> {
    this.saved.input.push({ role: 'user', content: this.queued.splice(0).join('\n\n') });
    this.save();
    return this.ask();
  }

  private settle(status: 'completed' | 'error', detail?: string): void {
    this.running = false;
    this.emit({ type: 'settled', status, ...(detail ? { detail } : {}) });
    if (status === 'completed' && this.queued.length) { const next = this.queued.splice(0).join('\n\n'); this.prompt(next); }
  }
}

export class ModelShell implements AgentShell {
  constructor(private readonly o: ModelShellOptions) {}

  async open(spec: SessionSpec): Promise<ShellSession> {
    if (spec.builtinTools) throw new Error('V8_MODEL_SHELL_HAS_NO_BUILTIN_TOOLS');   // only for the lead and the reviewer
    if (!spec.model) throw new Error('V8_MODEL_REQUIRED');
    if (!this.o.origin()) throw new Error('V8_SUPPLY_NOT_RUNNING');
    mkdirSync(this.o.historyDir, { recursive: true });
    let ref = spec.sessionRef && existsSync(spec.sessionRef) ? spec.sessionRef : null;
    let saved: Saved = { model: spec.model, instructions: spec.systemPrompt, input: [] };
    if (ref) {
      try { const old = JSON.parse(readFileSync(ref, 'utf8')) as Saved; saved = { ...old, model: spec.model, instructions: spec.systemPrompt }; }
      catch { ref = null; }
    }
    ref ??= join(this.o.historyDir, `${spec.role}-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
    const session = new ModelSession(ref, saved, spec.hostTools, spec.supplySession, this.o, spec.supplyAccount);
    writeFileSync(ref, JSON.stringify(saved));
    return session;
  }
}
