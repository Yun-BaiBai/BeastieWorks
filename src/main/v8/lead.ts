import type { Scheduler } from './scheduler';
import type { Dispatcher, Activity } from './dispatcher';
import type { AgentShell, HostToolResult, ShellEvent, ShellSession } from './shell';
import { LEAD_SYSTEM, LEAD_TOOLS, bossToLead, questionForBoss, reportToLead, reviewToLead } from './prompts';
import { TICKET_STATE_LABEL } from '../../shared/v8/tickets';

/**
 * The lead: one long-lived session with no built-in tools, only the six tools below (spec section 4). It cannot
 * read, write or run anything, so it cannot do the work itself. Everything it does goes through the scheduler.
 *
 * Input is queued while the lead is mid-turn and sent as one prompt when the turn ends, so a turn is never
 * interrupted and nothing the boss says is lost.
 */

export interface LeadOptions {
  cwd: string; model: string | null; sessionRef?: string | null;
  /** Its name, as the boss set it. */
  name?: string;
  /** The supply session mark for the lead (v8 计划书 S1.5). */
  supplySession?: string;
  /** The lead is a model too: what each of its turns cost, so the day's total is honest. */
  onCost?(usd: number, basis: import('./shell').CostBasis): void;
}

export class Lead {
  private session: ShellSession | null = null;
  private busy = false;
  private inbox: string[] = [];
  private repliedThisTurn = false;
  private lastText = '';
  private offActivity: (() => void) | null = null;

  constructor(private readonly scheduler: Scheduler, private readonly dispatcher: Dispatcher, private readonly shell: AgentShell, private readonly options: LeadOptions) {}

  async start(): Promise<void> {
    this.session = await this.shell.open({
      role: 'lead', cwd: this.options.cwd, model: this.options.model, sessionRef: this.options.sessionRef ?? null,
      systemPrompt: (this.options.name ? `你的名字叫「${this.options.name}」，老板会这样叫你。\n` : '') + LEAD_SYSTEM, hostTools: LEAD_TOOLS, builtinTools: false,
      ...(this.options.supplySession ? { supplySession: this.options.supplySession } : {}),
    });
    this.session.onEvent(e => { void this.onEvent(e); });
    this.offActivity = this.dispatcher.onActivity(a => this.onActivity(a));
  }

  get ref(): string | null { return this.session?.ref ?? null; }

  /** The boss types in the talk bar. Recorded first, so his words exist even if the lead never answers. */
  bossSays(text: string): number {
    const id = this.scheduler.bossSaid(text);
    this.send(bossToLead(id, text));
    return id;
  }

  async stop(): Promise<void> {
    this.offActivity?.();
    await this.session?.close();
    this.session = null;
  }

  // ---------- internals ----------

  private onActivity(a: Activity): void {
    if (a.type === 'reported') {
      // A "done" waiting for review is not news yet; the lead hears about it when review has spoken.
      if (a.report.kind === 'done' && a.state === 'WORKING') return;
      this.send(reportToLead(this.scheduler.ticket(a.ticketId), a.report));
      return;
    }
    if (a.type === 'reviewed' && a.outcome !== 'rejected') {
      const r = this.scheduler.latestReport(a.ticketId);
      this.send(reviewToLead(this.scheduler.ticket(a.ticketId), a.outcome, a.reason, r?.kind === 'done' ? r : null));
    }
  }

  private send(text: string): void {
    if (!this.session) throw new Error('V8_LEAD_NOT_STARTED');
    if (this.busy) { this.inbox.push(text); return; }
    this.busy = true;
    this.repliedThisTurn = false;
    this.lastText = '';
    this.session.prompt(text);
  }

  private async onEvent(e: ShellEvent): Promise<void> {
    if (!this.session) return;
    if (e.type === 'message') { this.lastText = e.text; return; }
    if (e.type === 'cost') { this.options.onCost?.(e.usd, e.basis ?? 'reported'); return; }
    if (e.type === 'host_tool') { this.session.respondHostTool(e.id, await this.tool(e.name, e.args)); return; }
    // omp asks before a first-class host tool. The lead's own six tools are allowed (each goes through the scheduler);
    // it has nothing else, and anything else is refused.
    if (e.type === 'approval') { this.session.respondApproval(e.id, LEAD_TOOLS.some(t => t.name === e.tool)); return; }
    if (e.type === 'settled' || e.type === 'exited') {
      // A model that answers in plain text instead of calling reply_to_boss still reaches the boss.
      if (e.type === 'settled' && e.status === 'completed' && !this.repliedThisTurn && this.lastText.trim()) this.scheduler.leadSaid(this.lastText.trim());
      this.busy = false;
      if (this.inbox.length) { const next = this.inbox.splice(0).join('\n\n'); this.send(next); }
    }
  }

  private async tool(name: string, raw: unknown): Promise<HostToolResult> {
    const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const num = (k: string) => { const v = a[k]; if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Error('V8_ARGUMENT_' + k.toUpperCase()); return v; };
    const str = (k: string) => { const v = a[k]; if (typeof v !== 'string') throw new Error('V8_ARGUMENT_' + k.toUpperCase()); return v; };
    try {
      switch (name) {
        case 'list_tickets': {
          const open = this.scheduler.tickets().filter(t => t.state !== 'DONE' && t.state !== 'STOPPED');
          return { ok: true, text: open.length ? open.map(t => `#${t.id} [${TICKET_STATE_LABEL[t.state]}${t.queuePosition ? ` · 排队第 ${t.queuePosition}` : ''}] ${t.title}`).join('\n') : '没有进行中的工单。' };
        }
        case 'open_ticket': {
          const id = this.scheduler.openTicket({ fromMessageId: num('message_id'), routingNote: str('routing_note'), ...(typeof a.title === 'string' ? { title: a.title } : {}) });
          await this.dispatcher.pump();
          return { ok: true, text: `已开工单 #${id}，状态：${TICKET_STATE_LABEL[this.scheduler.state(id)]}。` };
        }
        case 'forward_to_ticket': {
          const d = await this.dispatcher.forward(num('message_id'), num('ticket_id'));
          return { ok: true, text: d.kind === 'steer' ? '已经插话给正在干活的小怪。' : '已转过去，小怪接着做。' };
        }
        case 'stop_ticket': {
          this.scheduler.bossMessage(num('message_id'));
          await this.dispatcher.stop(num('ticket_id'));
          return { ok: true, text: '已叫停。' };
        }
        case 'move_to_front': {
          this.scheduler.bossMessage(num('message_id'));
          const at = this.scheduler.moveToFront(num('ticket_id'));
          return { ok: true, text: `已提前，现在排队第 ${at}。` };
        }
        case 'reply_to_boss': {
          this.scheduler.leadSaid(str('text'));
          this.repliedThisTurn = true;
          return { ok: true, text: '已发给老板。' };
        }
        case 'ask_boss': {
          const ticketId = num('ticket_id');
          const r = this.scheduler.latestReport(ticketId);
          if (this.scheduler.state(ticketId) !== 'ANSWER' || r?.kind !== 'question') throw new Error('V8_NO_OPEN_QUESTION');
          this.scheduler.leadSaid(questionForBoss(this.scheduler.ticket(ticketId), r), ticketId);
          this.repliedThisTurn = true;
          return { ok: true, text: '问题已原样转给老板。' };
        }
        default:
          return { ok: false, error: '没有这个工具：' + name };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
