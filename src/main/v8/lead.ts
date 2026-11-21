import { tr } from '../../shared/i18n';
import type { Scheduler } from './scheduler';
import type { Dispatcher, Activity } from './dispatcher';
import type { AgentShell, HostToolResult, ShellEvent, ShellSession } from './shell';
import { LEAD_SYSTEM, LEAD_TOOLS, bossToLead, leadRecovery, questionForBoss, reportToLead, reviewToLead } from './prompts';
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
  /** 圆桌会议 (A6): open one from the boss's message, and hand in the lead's Plan A / Plan B. Unset: no roundtables. */
  roundtable?: { open(messageId: number, title?: string): { id: number; agents: string[] }; plans(args: unknown): void };
  /** 工序链 (A15): open one from the boss's message. */
  chains?: { open(args: unknown): Promise<{ id: number; ticketId: number; stages: string[] }> };
  /** 拆解 (A12): open one from the boss's message. Unset: no splits. */
  splits?: { open(messageId: number, title?: string): { id: number; by: string } };
  /** The recent talk, oldest first, for a lead whose old conversation could not be carried on. */
  history?(): Array<{ author: 'boss' | 'lead'; text: string }>;
  /** Its session, to be carried on after a restart. */
  onSession?(ref: string): void;
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
  /** The talk before a restart, sent ahead of the next message when the old conversation is gone. */
  private recovery: string | null = null;

  constructor(private readonly scheduler: Scheduler, private readonly dispatcher: Dispatcher, private readonly shell: AgentShell, private readonly options: LeadOptions) {}

  async start(): Promise<void> {
    this.session = await this.shell.open({
      role: 'lead', cwd: this.options.cwd, model: this.options.model, sessionRef: this.options.sessionRef ?? null,
      systemPrompt: (this.options.name ? tr('你的名字叫「{0}」，老板会这样叫你。\n', [this.options.name]) : '') + LEAD_SYSTEM, hostTools: LEAD_TOOLS, builtinTools: false,
    });
    this.session.onEvent(e => { void this.onEvent(e); });
    this.offActivity = this.dispatcher.onActivity(a => this.onActivity(a));
    const ref = this.session.ref;
    const resumed = !!this.options.sessionRef && ref === this.options.sessionRef;
    if (!resumed) {
      const past = this.options.history?.() ?? [];
      if (past.length) this.recovery = leadRecovery(past);
    }
    if (ref) this.options.onSession?.(ref);
  }

  /** Whether its next message carries the talk from before a restart (it could not carry on the old session). */
  get catchingUp(): boolean { return this.recovery !== null; }

  get ref(): string | null { return this.session?.ref ?? null; }

  /** Something for the lead from the app itself (a roundtable's proposals), queued like everything else. */
  notify(text: string): void { this.send(text); }

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
    if (this.recovery) { text = this.recovery + '\n\n' + text; this.recovery = null; }
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
          return { ok: true, text: open.length ? open.map(t => `#${t.id} [${TICKET_STATE_LABEL[t.state]}${t.queuePosition ? tr(' · 排队第 {0}', [t.queuePosition]) : ''}] ${t.title}`).join('\n') : tr('没有进行中的工单。') };
        }
        case 'open_ticket': {
          const id = this.scheduler.openTicket({ fromMessageId: num('message_id'), routingNote: str('routing_note'), ...(typeof a.title === 'string' ? { title: a.title } : {}) });
          await this.dispatcher.pump();
          return { ok: true, text: tr('已开工单 #{0}，状态：{1}。', [id, TICKET_STATE_LABEL[this.scheduler.state(id)]]) };
        }
        case 'forward_to_ticket': {
          const d = await this.dispatcher.forward(num('message_id'), num('ticket_id'));
          return { ok: true, text: d.kind === 'steer' ? tr('已经插话给正在干活的小怪。') : tr('已转过去，小怪接着做。') };
        }
        case 'stop_ticket': {
          this.scheduler.bossMessage(num('message_id'));
          await this.dispatcher.stop(num('ticket_id'));
          return { ok: true, text: tr('已叫停。') };
        }
        case 'move_to_front': {
          this.scheduler.bossMessage(num('message_id'));
          const at = this.scheduler.moveToFront(num('ticket_id'));
          return { ok: true, text: tr('已提前，现在排队第 {0}。', [at]) };
        }
        case 'reply_to_boss': {
          this.scheduler.leadSaid(str('text'));
          this.repliedThisTurn = true;
          return { ok: true, text: tr('已发给老板。') };
        }
        case 'ask_boss': {
          const ticketId = num('ticket_id');
          const r = this.scheduler.latestReport(ticketId);
          if (this.scheduler.state(ticketId) !== 'ANSWER' || r?.kind !== 'question') throw new Error('V8_NO_OPEN_QUESTION');
          this.scheduler.leadSaid(questionForBoss(this.scheduler.ticket(ticketId), r), ticketId);
          this.repliedThisTurn = true;
          return { ok: true, text: tr('问题已原样转给老板。') };
        }
        case 'open_roundtable': {
          if (!this.options.roundtable) throw new Error(tr('V8_ROUNDTABLE_NEEDS_AGENTS: 圆桌会议只在用本机 agent 时能开'));
          const r = this.options.roundtable.open(num('message_id'), typeof a.title === 'string' ? a.title : undefined);
          this.scheduler.leadSaid(tr('开了圆桌：{0} 各自出一个方案，互相看不到。都交上来后我整理成 Plan A / Plan B 给你选。', [r.agents.join(tr('、'))]));
          this.repliedThisTurn = true;
          return { ok: true, text: tr('圆桌 #{0} 开了，{1} 只小怪在出方案。已经告诉老板，这一轮可以结束了。', [r.id, r.agents.length]) };
        }
        case 'open_split': {
          if (!this.options.splits) throw new Error('V8_SPLIT_NEEDS_AGENT');
          const s = this.options.splits.open(num('message_id'), typeof a.title === 'string' ? a.title : undefined);
          this.scheduler.leadSaid(tr('这件活先让 {0} 看看能不能拆开同时做，拆法出来给你看，你点头才开工。', [s.by]));
          this.repliedThisTurn = true;
          return { ok: true, text: tr('拆解 #{0} 开了。已经告诉老板，这一轮可以结束了。', [s.id]) };
        }
        case 'open_chain': {
          if (!this.options.chains) throw new Error('V8_CHAINS_OFF');
          const c = await this.options.chains.open(a);
          this.scheduler.leadSaid(tr('开了工序链，分 {0} 道：{1}。第一道已经开工，每道收下后点"开下一道"再接着做。', [c.stages.length, c.stages.join(' → ')]));
          this.repliedThisTurn = true;
          return { ok: true, text: tr('工序链 #{0} 开了，第一道是工单 #{1}。已经告诉老板，这一轮可以结束了。', [c.id, c.ticketId]) };
        }
        case 'submit_plans': {
          if (!this.options.roundtable) throw new Error('V8_ROUNDTABLE_NEEDS_AGENTS');
          this.options.roundtable.plans(a);
          this.scheduler.leadSaid(tr('圆桌的方案整理好了：Plan A 和 Plan B 在下面，你选一个就开工。'));
          this.repliedThisTurn = true;
          return { ok: true, text: tr('已交给老板选。') };
        }
        default:
          return { ok: false, error: tr('没有这个工具：') + name };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
