import { tr } from '../../shared/i18n';
import type { DoneReport } from '../../shared/v8/tickets';
import type { Scheduler } from './scheduler';
import type { Activity, Dispatcher } from './dispatcher';
import type { AgentShell, ShellEvent, ShellSession } from './shell';
import { REVIEW_NUDGE, REVIEW_SYSTEM, REVIEW_TOOL, reviewBrief } from './prompts';
import { quotaRefusal } from './hotswap';
import { nextBackup } from '../../shared/v8/desks';

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
  /** Gives up on a review after this long (default 20 min): the ticket goes to the boss unreviewed. */
  timeoutMs?: number;
  /** After the verdict, how long to wait for the turn to settle so its cost is counted (default 15 s). */
  settleGraceMs?: number;
  /** The ticket's directory (the review runs there, though it has no tools to touch it). */
  cwd(ticketId: number): string;
  /** Everything the gremlin changed in its directory, as a diff. */
  diff(ticketId: number): string;
  onCost?(usd: number, basis: import('./shell').CostBasis): void;
  /** Its own rule for running out of quota, read each time (requirement 66). Unset: as before, the work goes on
   *  unreviewed with a note. */
  plan?(): import('../../shared/v8/settings').V8QuotaPlan | undefined;
  /** A line for the board's feed (quota ran out, switched, waiting). */
  onNote?(text: string, tone: 'boss' | 'question'): void;
}

export class Reviewer {
  private busy = false;
  private again = false;
  private current: ShellSession | null = null;
  private off: (() => void) | null = null;
  private stopped = false;
  /** Out of quota and set to wait: no review starts before this (ms). */
  private pausedUntil = 0;
  /** The review in progress, so stopping waits for it (1.0 review, finding 11). */
  private working: Promise<void> | null = null;

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
    // The review being opened or run ends before the workbench closes its database (at most 10 s).
    if (this.working) await Promise.race([this.working.catch(() => undefined), new Promise(r => setTimeout(r, 10_000))]);
  }

  /** Review everything pending, one at a time. Safe to call any number of times. */
  async kick(): Promise<void> {
    if (this.busy) { this.again = true; return; }
    // Waiting for its quota: the work stays waiting for review until then.
    if (Date.now() < this.pausedUntil) return;
    this.busy = true;
    try {
      do {
        this.again = false;
        for (const p of this.scheduler.pendingReviews()) {
          // Stopped, or now waiting for its quota: the rest wait too (1.0 review, finding 10).
          if (this.stopped || Date.now() < this.pausedUntil) return;
          this.working = this.review(p.ticketId, p.reportMessageId, p.report as DoneReport);
          await this.working;
        }
      } while (this.again && !this.stopped);
    } finally { this.busy = false; }
  }

  private async review(ticketId: number, reportMessageId: number, report: DoneReport, model: string | null = this.o.model, effort: string | null = null): Promise<void> {
    const t = this.scheduler.ticket(ticketId);
    const bossLater = this.scheduler.messages(ticketId).filter(m => m.author === 'boss').map(m => String(m.body)).filter(b => b !== t.originalRequest);
    this.dispatcher.announce({ type: 'reviewing', ticketId });
    let session: ShellSession;
    try {
      // Opening counts against the same deadline as the review: an agent that never answers holds up nothing.
      const opening = this.shell.open({ role: 'reviewer', cwd: this.o.cwd(ticketId), model, ...(effort ? { effort } : {}), sessionRef: null, systemPrompt: REVIEW_SYSTEM, hostTools: [REVIEW_TOOL], builtinTools: false });
      let late: ReturnType<typeof setTimeout> | undefined;
      session = await Promise.race([opening, new Promise<never>((_, no) => { late = setTimeout(() => { void opening.then(x => x.close(), () => undefined); no(new Error(tr('审查会话开得太久'))); }, this.o.timeoutMs ?? 20 * 60_000); late.unref?.(); })]).finally(() => clearTimeout(late));
      if (this.stopped) { await session.close().catch(() => undefined); return; }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (await this.outOfQuota(ticketId, reportMessageId, report, model, effort, why)) return;
      return this.finish(ticketId, reportMessageId, null, tr('开不了审查会话：') + why);
    }
    this.current = session;
    const outcome = await new Promise<{ result: 'passed' | 'rejected' | 'escalated' | 'stale'; reason: string } | { failed: string }>(resolve => {
      let nudged = false, done: { result: 'passed' | 'rejected' | 'escalated' | 'stale'; reason: string } | null = null;
      // One review that never ends must not hold up every review after it (C3 review, finding 9).
      const timer = setTimeout(() => { session.abort(); resolve({ failed: tr('审查超时没给结论') }); }, this.o.timeoutMs ?? 20 * 60_000);
      timer.unref?.();
      let grace: ReturnType<typeof setTimeout> | null = null;
      const end = (r: Parameters<typeof resolve>[0]) => { clearTimeout(timer); if (grace) clearTimeout(grace); resolve(r); };
      session.onEvent((e: ShellEvent) => {
        if (e.type === 'cost') { this.o.onCost?.(e.usd, e.basis ?? 'reported'); return; }
        if (e.type === 'approval') { session.respondApproval(e.id, e.tool === REVIEW_TOOL.name); return; }
        if (e.type === 'host_tool') {
          if (e.name !== REVIEW_TOOL.name || done) { session.respondHostTool(e.id, { ok: false, error: done ? tr('已经交过结论了。') : tr('没有这个工具：') + e.name }); return; }
          try {
            const args = e.args as { reason?: unknown };
            done = { result: this.scheduler.recordReview(reportMessageId, e.args), reason: typeof args?.reason === 'string' ? args.reason : '' };
            session.respondHostTool(e.id, { ok: true, text: tr('结论收到。') });
            // The verdict is in and counts now. The turn's bill comes when it settles, so wait for that a little
            // (B4 rerun: closing at once lost every review's cost), but not forever (C3 review, finding 9).
            clearTimeout(timer);
            const verdict = done;
            grace = setTimeout(() => end(verdict), this.o.settleGraceMs ?? 15_000);
            grace.unref?.();
          } catch (err) {
            session.respondHostTool(e.id, { ok: false, error: tr('结论格式不对（') + (err instanceof Error ? err.message : String(err)) + tr('）：verdict 用 pass 或 fail，checks 三条都要有，pass 时三条都必须 ok。') });
          }
          return;
        }
        if (e.type === 'settled' || e.type === 'exited') {
          if (done) return end(done);
          if (e.type === 'settled' && e.status === 'completed' && !nudged) { nudged = true; session.prompt(REVIEW_NUDGE); return; }
          end({ failed: e.type === 'exited' ? e.detail : e.status === 'error' ? tr('出错：') + (e.detail ?? '') : tr('两次停下都没给结论') });
        }
      });
      session.prompt(reviewBrief({ originalRequest: t.originalRequest, bossLater, summary: report.summary, diff: this.o.diff(ticketId), verification: report.verification }));
    });
    await session.close().catch(() => undefined);
    this.current = null;
    if ('failed' in outcome) {
      if (await this.outOfQuota(ticketId, reportMessageId, report, model, effort, outcome.failed)) return;
      return this.finish(ticketId, reportMessageId, null, outcome.failed);
    }
    if (outcome.result === 'stale') return;
    return this.finish(ticketId, reportMessageId, outcome.result, outcome.reason);
  }

  /**
   * Its account ran out (requirement 66), whether at opening or during the review (1.0 review, finding 10): review
   * again on the next backup, or wait for the quota with the work still waiting for review, rather than pass it on
   * unreviewed. True: handled (the review goes on or waits). False: not a quota refusal, or no rule set.
   */
  private async outOfQuota(ticketId: number, reportMessageId: number, report: DoneReport, model: string | null, effort: string | null, detail: string): Promise<boolean> {
    const out = quotaRefusal(detail, Date.now());
    if (!out || !this.o.plan) return false;
    const next = nextBackup(this.o.plan(), model, effort);
    if (next) {
      this.o.onNote?.(tr('审查额度用完，按你定的规矩换成 {0} 再审', [next.model]), 'boss');
      await this.review(ticketId, reportMessageId, report, next.model, next.effort ?? effort);
      return true;
    }
    const at = out.resetsAt && out.resetsAt > Date.now() ? out.resetsAt : Date.now() + 15 * 60_000;
    this.pausedUntil = at;
    this.o.onNote?.(tr('审查额度用完，等额度：{0} 再审', [new Date(at).toTimeString().slice(0, 5)]), 'question');
    const wake = setTimeout(() => { void this.kick(); }, at - Date.now() + 1000);
    wake.unref?.();
    return true;
  }

  private async finish(ticketId: number, reportMessageId: number, result: 'passed' | 'rejected' | 'escalated' | null, reason: string): Promise<void> {
    if (result === null) { if (!this.scheduler.skipReview(reportMessageId, reason)) return; }
    this.dispatcher.announce({ type: 'reviewed', ticketId, outcome: result ?? 'skipped', reason });
    if (result === 'rejected') await this.dispatcher.pump();
  }
}
