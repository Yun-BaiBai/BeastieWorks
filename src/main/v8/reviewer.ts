import type { DoneReport } from '../../shared/v8/tickets';
import type { Scheduler } from './scheduler';
import type { Activity, Dispatcher } from './dispatcher';
import type { AgentShell, ShellEvent, ShellSession } from './shell';
import { REVIEW_NUDGE, REVIEW_SYSTEM, REVIEW_TOOL, reviewBrief } from './prompts';

/**
 * The review gremlin (spec section 7). Every "done" waits for it. It works in a fresh session with no tools of its
 * own and sees exactly three things: the boss's words, the diff, and the verification output. It answers with one
 * verdict and three checks. One review at a time; each in a new session, closed afterwards.
 *
 * Pass: the boss sees the work. Fail: the same gremlin gets it back with the reason (the scheduler limits the rounds
 * and then hands it to the boss). No verdict at all: the boss gets it unreviewed, with a note saying so.
 */

export interface ReviewerOptions {
  model: string | null;
  /** The ticket's directory (the review runs there, though it has no tools to touch it). */
  cwd(ticketId: number): string;
  /** Everything the gremlin changed in its directory, as a diff. */
  diff(ticketId: number): string;
  onCost?(usd: number, basis: import('./shell').CostBasis): void;
  /** The supply session mark for one review (v8 计划书 S1.5). */
  supplySession?(ticketId: number): string;
}

export class Reviewer {
  private busy = false;
  private again = false;
  private current: ShellSession | null = null;
  private off: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly scheduler: Scheduler, private readonly dispatcher: Dispatcher, private readonly shell: AgentShell, private readonly o: ReviewerOptions) {}

  /** Starts listening, and reviews whatever was left waiting when the app last closed. */
  start(): void {
    this.off = this.dispatcher.onActivity((a: Activity) => { if (a.type === 'reported' && a.report.kind === 'done') void this.kick(); });
    void this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.off?.();
    await this.current?.close().catch(() => undefined);
    this.current = null;
  }

  /** Review everything pending, one at a time. Safe to call any number of times. */
  async kick(): Promise<void> {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      do {
        this.again = false;
        for (const p of this.scheduler.pendingReviews()) {
          if (this.stopped) return;
          await this.review(p.ticketId, p.reportMessageId, p.report as DoneReport);
        }
      } while (this.again && !this.stopped);
    } finally { this.busy = false; }
  }

  private async review(ticketId: number, reportMessageId: number, report: DoneReport): Promise<void> {
    const t = this.scheduler.ticket(ticketId);
    const bossLater = this.scheduler.messages(ticketId).filter(m => m.author === 'boss').map(m => String(m.body)).filter(b => b !== t.originalRequest);
    this.dispatcher.announce({ type: 'reviewing', ticketId });
    let session: ShellSession;
    try {
      session = await this.shell.open({ role: 'reviewer', cwd: this.o.cwd(ticketId), model: this.o.model, sessionRef: null, systemPrompt: REVIEW_SYSTEM, hostTools: [REVIEW_TOOL], builtinTools: false, ...(this.o.supplySession ? { supplySession: this.o.supplySession(ticketId) } : {}) });
    } catch (err) {
      return this.finish(ticketId, reportMessageId, null, '开不了审查会话：' + (err instanceof Error ? err.message : String(err)));
    }
    this.current = session;
    const outcome = await new Promise<{ result: 'passed' | 'rejected' | 'escalated' | 'stale'; reason: string } | { failed: string }>(resolve => {
      let nudged = false, done: { result: 'passed' | 'rejected' | 'escalated' | 'stale'; reason: string } | null = null;
      session.onEvent((e: ShellEvent) => {
        if (e.type === 'cost') { this.o.onCost?.(e.usd, e.basis ?? 'reported'); return; }
        if (e.type === 'approval') { session.respondApproval(e.id, e.tool === REVIEW_TOOL.name); return; }
        if (e.type === 'host_tool') {
          if (e.name !== REVIEW_TOOL.name || done) { session.respondHostTool(e.id, { ok: false, error: done ? '已经交过结论了。' : '没有这个工具：' + e.name }); return; }
          try {
            const args = e.args as { reason?: unknown };
            done = { result: this.scheduler.recordReview(reportMessageId, e.args), reason: typeof args?.reason === 'string' ? args.reason : '' };
            session.respondHostTool(e.id, { ok: true, text: '结论收到。' });
          } catch (err) {
            session.respondHostTool(e.id, { ok: false, error: '结论格式不对（' + (err instanceof Error ? err.message : String(err)) + '）：verdict 用 pass 或 fail，checks 三条都要有，pass 时三条都必须 ok。' });
          }
          return;
        }
        if (e.type === 'settled' || e.type === 'exited') {
          if (done) return resolve(done);
          if (e.type === 'settled' && e.status === 'completed' && !nudged) { nudged = true; session.prompt(REVIEW_NUDGE); return; }
          resolve({ failed: e.type === 'exited' ? e.detail : e.status === 'error' ? '出错：' + (e.detail ?? '') : '两次停下都没给结论' });
        }
      });
      session.prompt(reviewBrief({ originalRequest: t.originalRequest, bossLater, summary: report.summary, diff: this.o.diff(ticketId), verification: report.verification }));
    });
    await session.close().catch(() => undefined);
    this.current = null;
    if ('failed' in outcome) return this.finish(ticketId, reportMessageId, null, outcome.failed);
    if (outcome.result === 'stale') return;
    return this.finish(ticketId, reportMessageId, outcome.result, outcome.reason);
  }

  private async finish(ticketId: number, reportMessageId: number, result: 'passed' | 'rejected' | 'escalated' | null, reason: string): Promise<void> {
    if (result === null) { if (!this.scheduler.skipReview(reportMessageId, reason)) return; }
    this.dispatcher.announce({ type: 'reviewed', ticketId, outcome: result ?? 'skipped', reason });
    if (result === 'rejected') await this.dispatcher.pump();
  }
}
