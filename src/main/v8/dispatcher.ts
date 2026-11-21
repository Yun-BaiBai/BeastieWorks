import { tr } from '../../shared/i18n';
import type { Delivery, Report, TicketState } from '../../shared/v8/tickets';
import type { Scheduler } from './scheduler';
import { quotaRefusal, probeLive, PROBE_DEFAULTS, type ProbeLimits, type ProbeStatus } from './hotswap';
import type { AgentShell, HostTool, ShellEvent, ShellSession, CostBasis } from './shell';
import { REPORT_NUDGE, REPORT_TOOL, WORKER_SYSTEM, reportRefused, workerBrief, workerFollowUp } from './prompts';

/**
 * Drives the gremlins: takes launches from the scheduler, runs each one in a shell session, turns shell events into
 * scheduler facts, and frees the slot when a report comes in. One session per ticket; it is closed after each
 * report and resumed by ref for the next assignment, so an idle ticket costs no process.
 */

export interface ApprovalRequest { ticketId: number; tool: string; detail: string }

export interface DispatcherOptions {
  /** The ticket's own working directory (a git worktree from B3 on). */
  workdir(ticketId: number): string | Promise<string>;
  /** Spec section 6. Until B3 brings the directory rule, the default refuses everything. */
  approve?(request: ApprovalRequest): boolean;
  /** The skill library (第 6 步): a gremlin's brief names the skills that fit, and it can list and fetch them. */
  /** A10: the project's notebook, under the boss's words. */
  notes?: { briefLines(): string[] };
  skills?: { briefLines(about: string): string[]; call(name: string, args: unknown): { ok: true; text: string } | { ok: false; error: string }; tools: HostTool[] };
  /** The three-state probe (v8 计划书 S2.2): how often to look, and the limits. Defaults: every 30 s, 3 min, 90 min. */
  probe?: Partial<ProbeLimits> & { intervalMs?: number };
  clock?: () => number;
}

/** What the dispatch board shows live. Not stored: the scheduler's tables are the record. */
export type Activity =
  | { type: 'launched'; ticketId: number; assignmentId: number; slotId: string }
  | { type: 'tool'; ticketId: number; name: string; args: unknown; phase: 'start' | 'end'; ok?: boolean; summary?: string }
  | { type: 'said'; ticketId: number; text: string }
  | { type: 'cost'; ticketId: number; usd: number; basis: CostBasis }
  | { type: 'approval'; ticketId: number; tool: string; detail: string; allowed: boolean }
  | { type: 'reported'; ticketId: number; report: Report; state: TicketState }
  | { type: 'refused'; ticketId: number; code: string }
  | { type: 'ended'; ticketId: number; assignmentId: number; why: 'reported' | 'exited' | 'stopped' }
  /** The review gremlin started on a ticket, or gave its verdict ('skipped': it gave none). */
  | { type: 'reviewing'; ticketId: number }
  | { type: 'reviewed'; ticketId: number; outcome: 'passed' | 'rejected' | 'escalated' | 'skipped'; reason: string }
  /** The account ran out of quota and Magpie had nothing left: the ticket now waits (等额度). */
  | { type: 'quota'; ticketId: number; resetsAt: number | null }
  /** The three-state probe changed its mind about a running gremlin. */
  | { type: 'probe'; ticketId: number; status: ProbeStatus };

interface Live {
  ticketId: number; assignmentId: number; session: ShellSession; off: () => void; reported: boolean; nudged: boolean; stopping: boolean;
  startedAt: number; lastAt: number; probe: ProbeStatus;
}

export class Dispatcher {
  private live = new Map<number, Live>();
  /** Tickets whose gremlin session is being opened (it can take tens of seconds), and a 等一等 asked meanwhile. */
  private opening = new Set<number>();
  private parked = new Map<number, (assignmentId: number) => void>();
  private listeners = new Set<(a: Activity) => void>();
  private chain: Promise<void> = Promise.resolve();
  private watch: ReturnType<typeof setInterval> | null = null;
  /** Set on shutdown: a session that finishes opening afterwards closes itself. */
  private closed = false;
  private closing = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly limits: ProbeLimits;

  constructor(private readonly scheduler: Scheduler, private readonly shell: AgentShell, private readonly options: DispatcherOptions) {
    this.now = options.clock ?? Date.now;
    this.limits = { ...PROBE_DEFAULTS, ...(options.probe ?? {}) };
  }

  /** Call once when the app starts: whatever was running before the restart is queued again as recovery. */
  start(): Promise<void> {
    this.scheduler.recoverAfterRestart();
    if (!this.watch) {
      this.watch = setInterval(() => { void this.probeAll(); }, this.options.probe?.intervalMs ?? 30_000);
      this.watch.unref?.();
    }
    return this.pump();
  }

  /** The three-state probe over every running gremlin. Yellow only warns; red stops it and hands it to the boss. */
  async probeAll(): Promise<void> {
    const now = this.now();
    for (const l of [...this.live.values()]) {
      if (l.stopping || l.reported) continue;
      const p = probeLive(now, l.startedAt, l.lastAt, this.limits);
      if (p.status === l.probe) continue;
      l.probe = p.status;
      this.emit({ type: 'probe', ticketId: l.ticketId, status: p.status });
      if (p.status !== 'CONFIRMED_STALLED') continue;
      l.stopping = true;
      this.scheduler.assignmentExited(l.assignmentId, tr('跑了 {0} 分钟还没交报告，先停下等老板决定', [Math.round(this.limits.hardMs / 60_000)]));
      l.session.abort();
      await this.finish(l, 'exited');
    }
  }

  /** Fill free slots. Calls are serialised so two pumps never race for the same slot. */
  pump(): Promise<void> {
    this.chain = this.chain.then(async () => {
      for (const l of this.scheduler.nextLaunches()) await this.launch(l.assignmentId, l.ticketId, l.slotId, l.sessionRef);
    }).catch(() => undefined);
    return this.chain;
  }

  /** The boss speaks to one gremlin directly. */
  tell(ticketId: number, text: string): Promise<Delivery> { return this.delivered(this.scheduler.tellTicket(ticketId, text)); }

  /** The lead forwards one of the boss's talk-bar messages to a ticket. */
  forward(messageId: number, ticketId: number): Promise<Delivery> { return this.delivered(this.scheduler.forwardToTicket(messageId, ticketId)); }

  async stop(ticketId: number): Promise<void> {
    const { abort } = this.scheduler.stopTicket(ticketId);
    for (const id of abort) {
      const l = this.live.get(id);
      if (!l) continue;
      l.stopping = true;
      l.session.abort();
      await this.finish(l, 'stopped');
    }
    await this.pump();
  }

  /**
   * Stop the running gremlin of a ticket without calling it a failure, for the boss's 等一等 / 换模型 / 换档 (第 4 步).
   * `end` records what happens to its assignment (wait for quota, or go on at once with the new setting); the old
   * session is closed before the next one may open on the same session ref. False if nothing was running.
   */
  async pause(ticketId: number, end: (assignmentId: number) => void): Promise<boolean> {
    const l = [...this.live.values()].find(x => x.ticketId === ticketId && !x.stopping && !x.reported);
    if (!l) {
      if (!this.opening.has(ticketId)) return false;
      this.parked.set(ticketId, end);
      return true;
    }
    l.stopping = true;
    l.session.abort();
    await this.finish(l, 'stopped');
    end(l.assignmentId);
    await this.pump();
    return true;
  }

  /** Close every live session (app quit). Their assignments stay RUNNING and are recovered on the next start. */
  async shutdown(): Promise<void> {
    if (this.watch) { clearInterval(this.watch); this.watch = null; }
    // Sessions still opening finish opening and close themselves (launch checks this) before anything else closes.
    this.closed = true;
    await Promise.race([this.chain.catch(() => undefined), new Promise(r => setTimeout(r, 15_000))]);
    const all = [...this.live.values()];
    this.live.clear();
    for (const l of all) { l.off(); await l.session.close().catch(() => undefined); }
    // Sessions that were already finishing (a report just came in) are still closing; wait for those too.
    await Promise.all([...this.closing]);
  }

  onActivity(listener: (a: Activity) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** Assignments with a live session, for tests and the board. */
  running(): number[] { return [...this.live.keys()]; }

  /** Other parts of the workbench (the review gremlin) report on the same stream the board and the lead listen to. */
  announce(a: Activity): void { this.emit(a); }

  // ---------- internals ----------

  private async delivered(d: Delivery): Promise<Delivery> {
    if (d.kind === 'steer') {
      const l = this.live.get(d.assignmentId);
      const ctx = this.scheduler.assignmentContext(d.assignmentId);
      if (l) l.session.steer(tr('老板说：') + ctx.riders[ctx.riders.length - 1]);
    } else {
      await this.pump();
    }
    return d;
  }

  private async launch(assignmentId: number, ticketId: number, slotId: string, sessionRef: string | null): Promise<void> {
    const ticket = this.scheduler.ticket(ticketId);
    const ctx = this.scheduler.assignmentContext(assignmentId);
    const slot = this.scheduler.slots().find(s => s.id === slotId);
    // The boss may have pinned this ticket to another model or account (S2.3); that wins over the slot's own.
    const pin = this.scheduler.ticketSupply(ticketId);
    let session: ShellSession | null = null;
    this.opening.add(ticketId);
    try {
      session = await this.shell.open({
        role: 'worker', cwd: await this.options.workdir(ticketId), model: pin.model ?? slot?.model ?? null, sessionRef,
        ...(pin.effort ? { effort: pin.effort } : {}),
        ...(pin.account ? { supplyAccount: pin.account } : {}),
        systemPrompt: WORKER_SYSTEM, hostTools: [REPORT_TOOL, ...(this.options.skills?.tools ?? [])], builtinTools: true,
      });
      this.scheduler.assignmentStarted(assignmentId, session.ref);
      // The boss may have switched the model or effort while the session was opening: use it from the first word.
      const now = this.scheduler.ticketSupply(ticketId);
      if (now.model && now.model !== pin.model) await session.choose?.('model', now.model);
      if (now.effort && now.effort !== pin.effort) await session.choose?.('effort', now.effort);
    } catch (err) {
      this.opening.delete(ticketId);
      this.parked.delete(ticketId);
      // Opened but failing right after: the session is closed, never left running unmanaged (C3 review, finding 6).
      if (session) await session.close().catch(() => undefined);
      this.scheduler.assignmentExited(assignmentId, tr('开不了会话：') + (err instanceof Error ? err.message : String(err)));
      this.emit({ type: 'ended', ticketId, assignmentId, why: 'exited' });
      return;
    }
    this.opening.delete(ticketId);
    // Stopped or closing while it was opening: the session goes, the gremlin never starts (C3 review, finding 6).
    if (this.closed || this.scheduler.state(ticketId) === 'STOPPED') { this.parked.delete(ticketId); await session.close().catch(() => undefined); return; }
    const t0 = this.now();
    const l: Live = { ticketId, assignmentId, session, off: () => undefined, reported: false, nudged: false, stopping: false, startedAt: t0, lastAt: t0, probe: 'ACTIVE' };
    l.off = session.onEvent(e => { void this.onEvent(l, e); });
    this.live.set(assignmentId, l);
    this.emit({ type: 'launched', ticketId, assignmentId, slotId });
    // Only a session that really carries on the old one gets the short follow-up. An agent that cannot load an old
    // session opens a new one (another ref): that one gets the whole brief again, the follow-up after it (C3 review,
    // finding 8).
    const resumed = !!sessionRef && session.ref === sessionRef;
    const followUp = () => workerFollowUp({ recovery: ctx.recovery, riders: ctx.riders, retry: ctx.retry, reviewNotes: ctx.reviewNotes, resumed: ctx.resumed });
    session.prompt(resumed
      ? followUp()
      : workerBrief(ticket, { recovery: ctx.recovery, riders: ctx.riders }) + (this.options.notes?.briefLines().join('\n') ?? '') + (this.options.skills?.briefLines(ticket.title + ' ' + ticket.originalRequest).join('\n') ?? '')
        + (sessionRef ? '\n\n' + followUp() : ''));
    // 等一等 while it was opening: it stops now, after the brief is in its conversation so it can pick up from there.
    const parked = this.parked.get(ticketId);
    // Not awaited: launch runs inside the pump chain, and pause pumps again.
    if (parked) { this.parked.delete(ticketId); void this.pause(ticketId, parked); }
  }

  /** The gremlin session of this ticket is still being opened. */
  isOpening(ticketId: number): boolean { return this.opening.has(ticketId); }

  private async onEvent(l: Live, e: ShellEvent): Promise<void> {
    if (!this.live.has(l.assignmentId)) return;
    l.lastAt = this.now();
    if (l.probe === 'SUSPECT_SILENT') { l.probe = 'ACTIVE'; this.emit({ type: 'probe', ticketId: l.ticketId, status: 'ACTIVE' }); }
    switch (e.type) {
      case 'tool_start': this.emit({ type: 'tool', ticketId: l.ticketId, name: e.name, args: e.args, phase: 'start' }); return;
      case 'tool_end': this.emit({ type: 'tool', ticketId: l.ticketId, name: e.name, args: null, phase: 'end', ok: e.ok, summary: e.summary }); return;
      case 'message': this.emit({ type: 'said', ticketId: l.ticketId, text: e.text }); return;
      case 'cost': this.emit({ type: 'cost', ticketId: l.ticketId, usd: e.usd, basis: e.basis ?? 'reported' }); return;
      case 'approval': {
        // The app's own tools are always allowed: calling one is asking the scheduler, which checks the arguments.
        // (omp asks before a host tool when it is first-class; refusing our own report tool would strand the work.)
        const own = e.tool === REPORT_TOOL.name;
        const allowed = own || (!l.reported && (this.options.approve?.({ ticketId: l.ticketId, tool: e.tool, detail: e.detail }) ?? false));
        l.session.respondApproval(e.id, allowed);
        this.emit({ type: 'approval', ticketId: l.ticketId, tool: e.tool, detail: e.detail, allowed });
        return;
      }
      case 'host_tool': {
        if (e.name !== REPORT_TOOL.name && this.options.skills?.tools.some(t => t.name === e.name)) {
          let r: { ok: true; text: string } | { ok: false; error: string };
          try { r = this.options.skills.call(e.name, e.args); } catch (err) { r = { ok: false, error: tr('技能库读不了：') + (err instanceof Error ? err.message : String(err)) }; }
          l.session.respondHostTool(e.id, r);
          if (r.ok && e.name === 'use_skill') this.emit({ type: 'tool', ticketId: l.ticketId, name: tr('用技能 ') + String((e.args as { name?: unknown } | null)?.name ?? ''), args: null, phase: 'start' });
          return;
        }
        if (e.name !== REPORT_TOOL.name) { l.session.respondHostTool(e.id, { ok: false, error: tr('没有这个工具：') + e.name }); return; }
        if (l.reported) { l.session.respondHostTool(e.id, { ok: false, error: tr('这次派工已经交过报告了。') }); return; }
        try {
          const state = this.scheduler.reportReceived(l.assignmentId, e.args);
          l.reported = true;
          l.session.respondHostTool(e.id, { ok: true, text: tr('报告收到。这一轮可以结束了。') });
          this.emit({ type: 'reported', ticketId: l.ticketId, report: this.scheduler.latestReport(l.ticketId)!, state });
        } catch (err) {
          const code = err instanceof Error ? err.message : String(err);
          l.session.respondHostTool(e.id, { ok: false, error: reportRefused(code) });
          this.emit({ type: 'refused', ticketId: l.ticketId, code });
        }
        return;
      }
      case 'settled': {
        if (l.reported) return this.finish(l, 'reported');
        if (l.stopping || e.status === 'aborted') return;
        if (e.status === 'completed' && !l.nudged) { l.nudged = true; l.session.prompt(REPORT_NUDGE); return; }
        // Out of quota with nothing left in Magpie: not a failure, the ticket waits (等额度).
        const quota = e.status === 'error' ? quotaRefusal(e.detail, this.now()) : null;
        if (quota) {
          this.scheduler.assignmentOutOfQuota(l.assignmentId, { resetsAt: quota.resetsAt, detail: e.detail ?? '' });
          this.emit({ type: 'quota', ticketId: l.ticketId, resetsAt: quota.resetsAt });
          return this.finish(l, 'exited');
        }
        this.scheduler.assignmentExited(l.assignmentId, e.status === 'error' ? tr('出错：') + (e.detail ?? '') : tr('两次停下都没交报告'));
        return this.finish(l, 'exited');
      }
      case 'exited': {
        if (l.reported) return this.finish(l, 'reported');
        if (!l.stopping) this.scheduler.assignmentExited(l.assignmentId, e.detail);
        return this.finish(l, l.stopping ? 'stopped' : 'exited');
      }
    }
  }

  private async finish(l: Live, why: 'reported' | 'exited' | 'stopped'): Promise<void> {
    if (!this.live.delete(l.assignmentId)) return;
    l.off();
    const closing = l.session.close().catch(() => undefined);
    this.closing.add(closing);
    await closing;
    this.closing.delete(closing);
    this.emit({ type: 'ended', ticketId: l.ticketId, assignmentId: l.assignmentId, why });
    if (why !== 'stopped') await this.pump();
  }

  private emit(a: Activity): void { for (const fn of [...this.listeners]) { try { fn(a); } catch { /* a broken listener must not stop the work */ } } }
}
