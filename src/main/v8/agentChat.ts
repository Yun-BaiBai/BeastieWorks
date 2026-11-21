import { tr } from '../../shared/i18n';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AcpShell, type AcpSession, type AcpShellOptions } from './acpShell';
import type { ChatTurn, SessionChoices } from '../../shared/v8/agents';

/**
 * A plain chat with one agent from the roster page: the smallest real thing the app does with an agent.
 *
 * Each agent gets one session, in an empty folder of its own, so there is nothing of the person's for it to read or
 * change; every permission request is refused. A message here is a real message to a real model.
 */
export class AgentChats {
  private sessions = new Map<string, Promise<AcpSession>>();
  private busy = new Set<string>();

  constructor(private readonly deps: { scratchRoot: string; launch(id: string): Promise<AcpShellOptions | null>; turnTimeoutMs?: number;
    /** What a chat turn cost, so the roster page's chats and skill retelling reach the ledger. */
    onCost?(usd: number, basis: import('./shell').CostBasis): void }) {}

  private open(id: string): Promise<AcpSession> {
    let s = this.sessions.get(id);
    if (!s) {
      s = (async () => {
        const launch = await this.deps.launch(id);
        if (!launch) throw new Error(tr('这个 agent 现在启动不了。'));
        const cwd = path.join(this.deps.scratchRoot, id.replace(/[^A-Za-z0-9._-]/g, '_'));
        mkdirSync(cwd, { recursive: true });
        return new AcpShell(launch).open({ role: 'worker', cwd, model: null, sessionRef: null, systemPrompt: '', hostTools: [], builtinTools: true });
      })();
      this.sessions.set(id, s);
      s.catch(() => { if (this.sessions.get(id) === s) this.sessions.delete(id); });
    }
    return s;
  }

  async say(id: string, text: string): Promise<ChatTurn> {
    if (!text.trim()) throw new Error('V8_ARGUMENT');
    if (this.busy.has(id)) return { reply: '', refused: [], error: tr('上一句还没答完，等它答完再说。') };
    this.busy.add(id);
    try {
      let session: AcpSession;
      try { session = await this.open(id); } catch (err) { return { reply: '', refused: [], error: plain(err) }; }
      return await new Promise<ChatTurn>(resolve => {
        const said: string[] = [], refused: string[] = [];
        let done = false;
        const finish = (error: string | null) => {
          if (done) return;
          done = true; clearTimeout(timer); off();
          if (error && !said.length) { void this.close(id); }
          resolve({ reply: said.join('\n\n'), refused, error });
        };
        const off = session.onEvent(e => {
          if (e.type === 'message') said.push(e.text);
          else if (e.type === 'cost') this.deps.onCost?.(e.usd, e.basis ?? 'reported');
          else if (e.type === 'approval') { refused.push(e.detail || e.tool); session.respondApproval(e.id, false); }
          else if (e.type === 'settled') finish(e.status === 'error' ? (e.detail ?? tr('出错了')) : null);
          else if (e.type === 'exited') { this.sessions.delete(id); finish(e.detail); }
        });
        const timer = setTimeout(() => { session.abort(); finish(tr('等了太久没有答完，已经停下。')); }, this.deps.turnTimeoutMs ?? 180_000);
        session.prompt(text);
      });
    } finally {
      this.busy.delete(id);
    }
  }

  /** Start the agent if it is not running and read what it offers. Sends no message, so it uses no quota. */
  async choices(id: string): Promise<SessionChoices> { return (await this.open(id)).choices(); }

  /** Switch the open session's model or reasoning effort. */
  async choose(id: string, kind: 'model' | 'effort', value: string): Promise<SessionChoices> {
    if (this.busy.has(id)) throw new Error(tr('它正在回话，等它答完再换。'));
    return (await this.open(id)).choose(kind, value);
  }

  /** Close one agent's session, or all of them. */
  async close(id?: string): Promise<void> {
    const ids = id ? [id] : [...this.sessions.keys()];
    await Promise.all(ids.map(async k => {
      const s = this.sessions.get(k);
      this.sessions.delete(k);
      try { await (await s)?.close(); } catch { /* already gone */ }
    }));
  }
}

function plain(err: unknown): string {
  const text = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err);
  return /authentication required|auth_required/i.test(text) ? tr('还没登录：要先在这个 agent 里登录。') : text.slice(0, 300);
}
