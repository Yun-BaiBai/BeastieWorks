import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { sureOf } from '../../shared/v8/board';
import type { CostBasis } from './shell';
import type { BoardData, BoardSlot, DeliveryDetail, FeedLine, FileChange, RingMark, SlotDetail, TalkLine, WorkLogLine } from '../../shared/v8/board';
import type { DoneReport, SlotConfig, TicketView, V8Message } from '../../shared/v8/tickets';
import type { V8QuotaRule, V8Settings } from '../../shared/v8/settings';
import { Scheduler } from './scheduler';
import { Dispatcher, type Activity } from './dispatcher';
import { Lead } from './lead';
import type { AgentShell } from './shell';
import { FakeShell } from './fakeShell';
import { OmpShell } from './ompShell';
import { TicketWorkspaces } from './workspace';
import { directoryPolicy } from './approval';
import { demoScripts } from './demoScripts';
import { REPORT_TOOL } from './prompts';
import { Reviewer } from './reviewer';
import { soonestBack } from './quotaRead';
import { SKILL_TOOLS, type SkillLibrary } from './skillLibrary';
import type { AgentQuota } from '../../shared/v8/agents';
import { V8Supply, supplySession, type SupplyStatus } from './supply';
import { ModelShell } from './modelShell';
import { AcpShell, type AcpShellOptions } from './acpShell';
import { agentName } from './acpQuirks';
import type { V8AcpRole } from '../../shared/v8/settings';

/**
 * The v8 workbench, put together: scheduler, lead, dispatcher, shell, one worktree per ticket and the directory
 * approval rule, plus a live tracker that turns shell activity into what the board shows.
 *
 * Its own database file (v8.db) so the v7 tables and migrations are untouched. The record is the scheduler's
 * tables; the tracker's live detail (what a gremlin is doing right now, today's cost) is memory only.
 */

export interface WorkbenchOptions {
  /** Folder for v8.db, worktrees, sessions and the demo repository. */
  stateDir: string;
  settings: V8Settings;
  /** Injected in tests: a shell to use instead of the one the settings pick. */
  shell?: AgentShell;
  /** Pace for the demo cast (1 = human speed). */
  demoPace?: number;
  /** With shell 'acp': how to start an agent from the roster, by its id. */
  acpLaunch?: (agent: string) => Promise<AcpShellOptions | null>;
  /** An agent's quota as its maker reports it (quotaRead.ts), for 等一等: when to go on. */
  quotaOf?: (agent: string) => Promise<AgentQuota>;
  /** The boss's rule for running out of quota, read each time it happens (default: settings.onQuota). */
  quotaRule?: () => V8QuotaRule | undefined;
  /** The app's skill library (第 6 步); gremlins get it only on agents that take the app's tools. */
  skills?: SkillLibrary;
  /** Tests only: the supply gateway talks to this local fake upstream instead of real providers. */
  supplyFixture?: string;
  /** The three-state probe's limits and pace (v8 计划书 S2.2); tests shorten them. */
  probe?: { silentMs?: number; hardMs?: number; intervalMs?: number };
  /** How often to look at tickets waiting for quota (default 60 s, as v7), and how long to wait before trying again
   *  when nobody said when the quota is back (default 15 min). */
  quotaPollMs?: number;
  quotaUnknownRetryMs?: number;
  clock?: () => number;
}

interface SlotLive { ticketId: number; startedAt: number; live: string | null; phase: 'working' | 'checking'; step: number; reportingUntil: number; cost: number; bases: Set<CostBasis> }
interface TicketLive { log: WorkLogLine[]; files: Map<string, FileChange>; cost: number; bases: Set<CostBasis>; startedAt: number | null; elapsedMs: number }

const MAX_LOG = 40, MAX_FEED = 40;
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

export class V8Workbench {
  readonly scheduler: Scheduler;
  readonly dispatcher: Dispatcher;
  readonly lead: Lead;
  readonly reviewer: Reviewer | null;
  /** The supply layer (Magpie), when the settings name one. */
  readonly supply: V8Supply | null;
  private reviewing: number | null = null;
  readonly projectRoot: string;
  private readonly db: Database.Database;
  private readonly spaces: TicketWorkspaces;
  private readonly now: () => number;
  private slotLive = new Map<string, SlotLive>();
  private ticketLive = new Map<number, TicketLive>();
  private feed: FeedLine[] = [];
  private ring: RingMark[] = [];
  private spent = 0;
  private spentBy = { lead: 0, review: 0 };
  /** How each turn counted today's money was known (see CostSure). */
  private spentBases = new Set<CostBasis>();
  private listeners = new Set<() => void>();
  private seq = 0;

  constructor(private readonly o: WorkbenchOptions) {
    this.now = o.clock ?? Date.now;
    mkdirSync(o.stateDir, { recursive: true });
    this.db = new Database(join(o.stateDir, 'v8.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.scheduler = new Scheduler(this.db, { clock: this.now, review: o.settings.review !== false });
    const s = o.settings;
    // 规范第 5 节: two slots by default, plus one emergency slot kept for work the boss just spoke to.
    const count = Math.min(4, Math.max(1, Math.floor(s.slots ?? 2)));
    // With agents from the roster each role names its own model; the slots show the gremlins'.
    const model = (s.shell === 'acp' ? s.acp?.worker.model : s.model) ?? null;
    const slots: SlotConfig[] = Array.from({ length: count }, (_, i) => ({ id: 'slot-' + (i + 1), label: '工位 ' + String(i + 1).padStart(2, '0'), model, emergency: false }));
    if (s.emergencySlot !== false) slots.push({ id: 'slot-emergency', label: '应急', model, emergency: true });
    // Apply new slot settings even when work was left running (after a crash every running assignment is still
    // marked so until start() recovers it). Only removing a slot that holds running work is refused; then the old
    // slots stay until that work is done and the settings apply on the next start.
    if (JSON.stringify(this.scheduler.slots()) !== JSON.stringify(slots)) {
      try { this.scheduler.setSlots(slots); } catch (err) { if (!(err instanceof Error && err.message === 'V8_SLOT_BUSY')) throw err; }
    }

    // The supply layer comes first: the shell asks it for the gateway's address when a session opens.
    this.supply = s.supply && (s.supply.magpieExe || s.supply.remote)
      ? new V8Supply({ root: join(o.stateDir, 'gateway'), settings: s.supply, ...(o.supplyFixture ? { fixtureUpstream: o.supplyFixture } : {}) })
      : null;
    const mark = basename(o.stateDir);
    this.projectRoot = s.projectRoot ?? this.demoRepo();
    this.spaces = new TicketWorkspaces(this.projectRoot, join(o.stateDir, 'work'));
    const acp = !o.shell && s.shell === 'acp' ? s.acp ?? null : null;
    if (!o.shell && s.shell === 'acp' && !acp) throw new Error('V8_ACP_ROLES_MISSING');
    const shell = o.shell ?? (acp ? this.roleShell(acp.worker) : this.makeShell());
    // The lead and the reviewer do no work: with a gateway they talk to the model directly (v8 计划书 S1.8).
    const thinker = acp ? this.roleShell(acp.lead)
      : this.supply && !o.shell && s.shell === 'omp' && (s.supply?.thinkersVia ?? 'model') === 'model'
      ? new ModelShell({ origin: () => this.supply?.origin() ?? null, historyDir: join(o.stateDir, 'conversations') })
      : shell;
    const reviewShell = acp?.reviewer ? this.roleShell(acp.reviewer) : thinker;
    // An agent from the roster brings its own tools for reading; the lead's room is an empty folder, so there is
    // nothing to read, and every other tool is refused (spec section 4, boss's answer 6 of the final plan).
    const leadCwd = acp ? join(o.stateDir, 'lead-room') : this.projectRoot;
    if (acp) mkdirSync(leadCwd, { recursive: true });
    const extra = s.omp?.extraPath ?? [];
    this.dispatcher = new Dispatcher(this.scheduler, shell, {
      workdir: id => this.spaces.ensure(id),
      approve: directoryPolicy({ workdir: id => this.spaces.path(id), toolDirs: extra, hostTools: [REPORT_TOOL.name, ...(o.skills ? SKILL_TOOLS.map(t => t.name) : [])] }),
      supplySession: (ticketId, assignmentId) => supplySession(mark, 'worker', ticketId, assignmentId),
      clock: this.now, ...(o.probe ? { probe: o.probe } : {}),
      ...(o.skills ? { skills: { briefLines: (about: string) => o.skills!.briefLines(about), call: (n: string, a: unknown) => o.skills!.call(n, a), tools: SKILL_TOOLS } } : {}),
    });
    this.lead = new Lead(this.scheduler, this.dispatcher, thinker, { cwd: leadCwd, name: this.leadName(), model: acp ? acp.lead.model ?? null : model, supplySession: supplySession(mark, 'lead'), onCost: (usd, basis) => { this.spentBases.add(basis); this.spent += usd; this.spentBy.lead += usd; this.changed(); } });
    this.reviewer = s.review === false ? null : new Reviewer(this.scheduler, this.dispatcher, reviewShell, {
      model: acp ? (acp.reviewer ?? acp.lead).model ?? null : model, cwd: id => this.spaces.path(id), diff: id => this.rawDiff(id), supplySession: id => supplySession(mark, 'reviewer', id), onCost: (usd, basis) => { this.spentBases.add(basis); this.spent += usd; this.spentBy.review += usd; this.changed(); },
    });
    this.dispatcher.onActivity(a => this.track(a));
  }

  async start(): Promise<void> {
    await this.supply?.start();
    await this.lead.start();
    await this.dispatcher.start();
    this.reviewer?.start();
    this.quotaTimer = setInterval(() => { void this.checkQuota(); }, this.o.quotaPollMs ?? 60_000);
    this.quotaTimer.unref?.();
    this.changed();
  }

  /**
   * Tickets waiting for quota go on by themselves when the provider's reset time has passed; when nobody said when,
   * they try again after a while (and come straight back here if the quota is still out). v8 计划书 S2.3.
   */
  async checkQuota(): Promise<number> {
    const now = this.now(), retry = this.o.quotaUnknownRetryMs ?? 15 * 60_000;
    let resumed = 0;
    for (const w of this.scheduler.quotaWaits()) {
      const due = w.resetsAt !== null ? now >= w.resetsAt : now - w.since >= retry;
      if (!due) continue;
      try { this.scheduler.resumeFromQuota(w.ticketId, 'reset'); resumed++; } catch { /* moved on meanwhile */ }
    }
    if (resumed) { await this.dispatcher.pump(); this.changed(); }
    return resumed;
  }

  // ---------- the boss's hot-swap actions (S2.3, S2.7) ----------

  /** Go on now, on the same account (the boss knows the quota is back). */
  async resumeNow(ticketId: number): Promise<void> { this.scheduler.resumeFromQuota(ticketId, 'boss'); await this.dispatcher.pump(); this.changed(); }

  /** Put this ticket on another account; a ticket waiting for quota goes on at once. */
  async switchAccount(ticketId: number, account: string | null): Promise<void> {
    this.scheduler.setTicketSupply(ticketId, { account });
    if (this.scheduler.state(ticketId) === 'WAITING_QUOTA') this.scheduler.resumeFromQuota(ticketId, 'account');
    await this.dispatcher.pump(); this.changed();
  }

  /**
   * Put this ticket on another model, or another reasoning effort. Waiting for quota: it goes on at once. Working:
   * the gremlin stops for a moment and goes on in the same conversation with the new setting (第 4 步). Otherwise
   * the setting applies from its next session.
   */
  async switchModel(ticketId: number, model: string | null): Promise<void> { await this.retune(ticketId, 'model', { model }); }
  async switchEffort(ticketId: number, effort: string | null): Promise<void> { await this.retune(ticketId, 'effort', { effort }); }

  private async retune(ticketId: number, how: 'model' | 'effort', s: { model?: string | null; effort?: string | null }): Promise<void> {
    this.scheduler.setTicketSupply(ticketId, s);
    const what = how === 'model' ? '模型换成 ' + (s.model ?? '默认') : '推理档位换成 ' + (s.effort ?? '默认');
    if (this.scheduler.state(ticketId) === 'WAITING_QUOTA') {
      this.scheduler.resumeFromQuota(ticketId, how);
      this.pushFeed(this.label(ticketId), what + '，接着干', 'boss');
    } else if (this.dispatcher.isOpening(ticketId)) {
      // Still opening its session: it picks the new setting up before its first word (Dispatcher.launch).
      this.pushFeed(this.label(ticketId), what + '，开工就用新的', 'boss');
    } else if (await this.dispatcher.pause(ticketId, () => { this.scheduler.restartRunning(ticketId, how); })) {
      this.pushFeed(this.label(ticketId), what + '，停一下接着干', 'boss');
    }
    await this.dispatcher.pump(); this.changed();
  }

  /**
   * 等一等: the working gremlin stops and waits for quota. It goes on by itself when the tightest quota window of its
   * agent starts over (read from the maker, no quota used), or when the boss says go on.
   */
  async waitForQuota(ticketId: number): Promise<{ resetsAt: number | null }> {
    const agent = this.workerAgent();
    const q = agent && this.o.quotaOf ? await this.o.quotaOf(agent).catch(() => null) : null;
    const resetsAt = soonestBack(q);
    const when = resetsAt ? new Date(resetsAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' 额度重置后接着干' : '不知道额度几点重置，过一阵再试';
    const paused = await this.dispatcher.pause(ticketId, id => { this.scheduler.assignmentOutOfQuota(id, { resetsAt, detail: when, byBoss: true }); });
    if (!paused) throw new Error('V8_NOT_WORKING');
    this.pushFeed(this.label(ticketId), '先停下等额度（' + when + '）', 'boss');
    this.changed();
    return { resetsAt };
  }

  /**
   * A gremlin's account ran out of quota (the ticket is already waiting): do what the boss set beforehand (第 5 步).
   * switch: go on at once on the boss's backup model and effort, unless it is already on them. wait: stay waiting;
   * when the refusal did not say when the quota is back, ask the maker (no quota used). The board says which.
   */
  async applyQuotaRule(ticketId: number, resetsAt: number | null): Promise<void> {
    const rule = this.o.quotaRule ? this.o.quotaRule() : this.o.settings.onQuota;
    const who = this.label(ticketId);
    const pin = this.scheduler.ticketSupply(ticketId);
    const role = this.workerAgent() ? this.o.settings.acp?.worker : undefined;
    const model = pin.model ?? role?.model ?? null, effort = pin.effort ?? role?.effort ?? null;
    if (rule?.do === 'switch' && rule.model && (rule.model !== model || (rule.effort && rule.effort !== effort))) {
      try {
        this.scheduler.setTicketSupply(ticketId, { model: rule.model, ...(rule.effort ? { effort: rule.effort } : {}) });
        this.scheduler.resumeFromQuota(ticketId, 'model');
        this.pushFeed(who, `额度用完，按你定的规矩换成 ${rule.model}${rule.effort ? '（' + rule.effort + ' 档）' : ''}接着干`, 'boss');
        await this.dispatcher.pump(); this.changed();
        return;
      } catch { /* moved on meanwhile: fall through to waiting */ }
    }
    let back = resetsAt;
    if (back === null) {
      const agent = this.workerAgent();
      back = soonestBack(agent && this.o.quotaOf ? await this.o.quotaOf(agent).catch(() => null) : null);
      if (back !== null && back > this.now()) this.scheduler.setQuotaReset(ticketId, back);
      else back = null;
    }
    const when = back ? new Date(back).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' 额度重置后自己接着干' : '不知道额度几点重置，过一阵再试';
    const why = rule?.do === 'switch' && rule.model ? `已经在用备用的 ${rule.model}，也用完了，等额度` : '按你定的规矩等额度';
    this.pushFeed(who, `额度用完，${why}（${when}）`, 'question');
    this.changed();
  }

  /** What the boss calls the lead (requirement 26). */
  leadName(): string { return this.o.settings.leadName?.trim().slice(0, 20) || '小怪A'; }

  /** The agent the gremlins run on, when they run on an ACP agent. */
  workerAgent(): string | null { return this.o.settings.shell === 'acp' ? this.o.settings.acp?.worker.agent ?? null : null; }

  private quotaTimer: ReturnType<typeof setInterval> | null = null;

  async shutdown(): Promise<void> {
    if (this.quotaTimer) { clearInterval(this.quotaTimer); this.quotaTimer = null; }
    await this.reviewer?.stop();
    await this.dispatcher.shutdown();
    await this.lead.stop();
    await this.supply?.stop();
    this.db.close();
  }

  /** The supply layer at a glance (v8 计划书 S1.6). Null when no gateway is configured. */
  supplyStatus(): SupplyStatus | null { return this.supply?.status() ?? null; }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // ---------- the boss's actions ----------

  say(text: string): number { const id = this.lead.bossSays(text); this.changed(); return id; }
  /** An answer to a gremlin's question, or anything else the boss says to one ticket. */
  async tell(ticketId: number, text: string): Promise<void> { await this.dispatcher.tell(ticketId, text); this.changed(); }
  async stop(ticketId: number): Promise<void> { await this.dispatcher.stop(ticketId); this.changed(); }
  /** The boss asks for a review of work that reached them unreviewed. */
  reviewAgain(ticketId: number): void {
    if (!this.reviewer || !this.scheduler.requestReview(ticketId)) throw new Error('V8_NOTHING_TO_REVIEW');
    this.changed();
    void this.reviewer.kick();
  }

  /**
   * The boss accepts the work: it goes into the project first, then the ticket is done. If any file it changes was
   * changed in the project since the ticket started, nothing goes in and the ticket stays waiting (V8_APPLY_CONFLICT
   * names the files), so the boss's own edits are never overwritten.
   */
  accept(ticketId: number): { applied: string[] } {
    const r = this.spaces.base(ticketId) ? this.spaces.apply(ticketId) : { applied: [], conflicts: [] };
    if (r.conflicts.length) throw new Error('V8_APPLY_CONFLICT: ' + r.conflicts.join('、'));
    this.scheduler.confirmTicket(ticketId); this.mark('passed'); this.changed();
    return { applied: r.applied };
  }
  async reject(ticketId: number, why: string): Promise<void> { await this.tell(ticketId, '打回重做：' + (why.trim() || '没写原因')); this.mark('refused'); }
  /** Try a stuck or failed ticket again. With another model (or later another agent) it starts a fresh session that
   *  picks up from the directory, since the old session cannot be read by it (S2.7). */
  async retry(ticketId: number, o: { model?: string; fresh?: boolean } = {}): Promise<void> {
    if (o.model) this.scheduler.setTicketSupply(ticketId, { model: o.model });
    this.scheduler.retryTicket(ticketId, { fresh: o.fresh ?? false });
    await this.dispatcher.pump(); this.changed();
  }
  /** The boss moves a queued ticket to the front (排队页「提到最前」). */
  front(ticketId: number): number { const at = this.scheduler.moveToFront(ticketId); this.changed(); return at; }

  // ---------- what the screens show ----------

  board(): BoardData {
    const now = this.now();
    const tickets = this.scheduler.tickets();
    const slotOf = (slot: SlotConfig, order: number): BoardSlot => {
      const ticket = tickets.find(t => t.slotId === slot.id && t.state === 'WORKING') ?? null;
      const l = ticket ? this.slotLive.get(slot.id) : undefined;
      const live = l && l.ticketId === ticket?.id ? l : undefined;
      return { slot, order, ticket, live: live?.live ?? null, phase: ticket ? live?.phase ?? 'working' : null, step: live?.step ?? 0,
        startedAt: live?.startedAt ?? null, costUsd: live?.cost ?? 0, costSure: sureOf(live?.bases ?? []), reporting: !!live && live.reportingUntil > now,
        recent: ticket ? (this.ticketLive.get(ticket.id)?.log ?? []).filter(l => l.kind !== '说').slice(1, 4).map(l => (l.kind + ' ' + l.text).trim()) : [] };
    };
    const slots = this.scheduler.slots();
    const normal = slots.filter(s => !s.emergency).map((s, i) => slotOf(s, i));
    const emergency = slots.find(s => s.emergency);
    return {
      project: this.projectName(),
      leadName: this.leadName(),
      harness: this.o.settings.shell === 'acp' && this.o.settings.acp
        ? { kind: 'acp', label: this.acpLabel(this.o.settings.acp) }
        : this.o.settings.shell === 'omp'
        ? { kind: 'omp', label: 'oh-my-pi' + (this.supply?.origin() ? ' · 经 Magpie' : '') }
        : { kind: 'fake', label: '演示小怪（不调用模型）' + (this.supply?.origin() ? ' · Magpie 已启动' : '') },
      agents: this.o.settings.shell === 'acp' && this.o.settings.acp
        ? { lead: this.o.settings.acp.lead.model ?? null, review: (this.o.settings.acp.reviewer ?? this.o.settings.acp.lead).model ?? null }
        : { lead: this.o.settings.model ?? null, review: this.o.settings.model ?? null },
      now,
      slots: normal,
      emergency: emergency ? slotOf(emergency, 1) : null,
      review: this.reviewSummary(),
      queue: tickets.filter(t => t.state === 'QUEUED').sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0)),
      resting: tickets.filter(t => t.state === 'WAITING_QUOTA'),
      waiting: tickets.filter(t => ['ANSWER', 'REVIEW', 'BLOCKED', 'FAILED'].includes(t.state)).sort((a, b) => a.createdAt - b.createdAt),
      feed: this.feedLines(),
      talk: this.talk(tickets),
      ring: this.ring.slice(-120),
      done: tickets.filter(t => t.state === 'DONE').length,
      spentTodayUsd: this.spent,
      spentSure: sureOf(this.spentBases),
    };
  }

  /** One ticket in full: its history (record) and what its gremlin did (live, this run of the app). */
  ticket(id: number): { view: TicketView; messages: V8Message[]; log: WorkLogLine[]; files: FileChange[] } {
    const t = this.ticketLive.get(id);
    return { view: this.scheduler.ticket(id), messages: this.scheduler.messages(id), log: t?.log ?? [], files: [...(t?.files.values() ?? [])] };
  }

  slotDetail(slotId: string): SlotDetail | null {
    const b = this.board();
    const slot = [...b.slots, ...(b.emergency ? [b.emergency] : [])].find(s => s.slot.id === slotId);
    if (!slot?.ticket) return null;
    const t = this.ticketLive.get(slot.ticket.id);
    const q = [...this.scheduler.messages(slot.ticket.id)].reverse().find(m => m.kind === 'report' && typeof m.body === 'object' && m.body.kind === 'question');
    const pin = this.scheduler.ticketSupply(slot.ticket.id);
    const role = this.o.settings.shell === 'acp' ? this.o.settings.acp?.worker : undefined;
    return {
      slot, saidAt: slot.ticket.createdAt, log: t?.log ?? [], files: [...(t?.files.values() ?? [])],
      tuning: { agent: this.workerAgent(), model: pin.model ?? slot.slot.model ?? role?.model ?? null, effort: pin.effort ?? role?.effort ?? null },
      question: q && typeof q.body === 'object' && q.body.kind === 'question' ? { text: q.body.question, open: slot.ticket.state === 'ANSWER' } : null,
    };
  }

  delivery(ticketId: number): DeliveryDetail | null {
    const view = this.scheduler.ticket(ticketId);
    const r = this.scheduler.latestReport(ticketId);
    if (view.state !== 'REVIEW' || !r) return null;
    const t = this.ticketLive.get(ticketId);
    const done = r.kind === 'done' ? r as DoneReport : null;
    return {
      ticketId, title: view.title, originalRequest: view.originalRequest,
      summary: done ? done.summary : '它说不用做：' + (r.kind === 'nothing' ? r.reason : ''),
      files: done ? done.changed.map(p => t?.files.get(p) ?? { path: p, plus: 0, minus: 0 }) : [],
      diff: done ? this.diff(ticketId) : '',
      verification: done ? done.verification : { command: '', output: '' },
      elapsedMs: t?.elapsedMs ?? 0, costUsd: t?.cost ?? 0, costSure: sureOf(t?.bases ?? []), ...this.reviewOf(ticketId), shots: null,
    };
  }

  /** 账本: where the money went since the app started. */
  ledger(): import('../../shared/v8/board').LedgerDetail {
    const byTicket = this.scheduler.tickets().map(t => {
      const l = this.ticketLive.get(t.id);
      return { id: t.id, title: t.title, state: t.state, costUsd: l?.cost ?? 0, elapsedMs: (l?.elapsedMs ?? 0) + (l?.startedAt ? this.now() - l.startedAt : 0) };
    }).sort((a, b) => b.costUsd - a.costUsd || b.id - a.id);
    const gremlins = byTicket.reduce((s, t) => s + t.costUsd, 0);
    return { totalUsd: this.spent, totalSure: sureOf(this.spentBases), bySource: { gremlins, lead: this.spentBy.lead, review: this.spentBy.review }, byTicket,
      capUsd: this.o.settings.shell === 'omp' ? this.o.settings.maxCostUsd ?? 0.5 : null };
  }

  /** 档案柜: every ticket, newest first, with a one-line outcome. */
  archive(): import('../../shared/v8/board').ArchiveItem[] {
    return this.scheduler.tickets().reverse().map(t => {
      const r = this.scheduler.latestReport(t.id);
      const outcome = t.state === 'STOPPED' ? '老板叫停了' : !r ? null
        : r.kind === 'done' ? r.summary : r.kind === 'question' ? '问：' + r.question : r.kind === 'blocked' ? '卡在：' + r.where : r.kind === 'failed' ? '失败：' + r.reason : '不用做：' + r.reason;
      return { id: t.id, title: t.title, originalRequest: t.originalRequest, state: t.state, createdAt: t.createdAt, endedAt: t.endedAt, outcome };
    });
  }

  /** One ticket's story, oldest first: the record (messages, reports, reviews) and, for this run, the gremlin's actions. */
  timeline(ticketId: number): import('../../shared/v8/board').TimelineItem[] {
    const items: import('../../shared/v8/board').TimelineItem[] = [];
    for (const m of this.scheduler.messages(ticketId, 500)) {
      const body = m.body;
      if (m.kind === 'report' && typeof body === 'object') {
        const text = body.kind === 'done' ? `做完了：${body.summary}（验证：${body.verification.command} → ${body.verification.output.trim().split('\n').pop()}）`
          : body.kind === 'question' ? '问你：' + body.question : body.kind === 'blocked' ? '卡住了：' + body.where : body.kind === 'failed' ? '失败了：' + body.reason : '发现不用做：' + body.reason;
        items.push({ id: 'm' + m.id, at: m.createdAt, who: m.author === 'system' ? 'system' : 'gremlin', kind: '报告', text });
      } else {
        items.push({ id: 'm' + m.id, at: m.createdAt, who: m.author === 'boss' ? 'boss' : m.author === 'lead' ? 'lead' : m.author === 'worker' ? 'gremlin' : /审查/.test(String(body)) ? 'review' : 'system', kind: m.author === 'boss' ? '你说' : m.author === 'lead' ? this.leadName() : '记录', text: String(body) });
      }
    }
    for (const r of this.scheduler.reviews({ ticketId })) {
      items.push({ id: 'r' + r.id, at: r.createdAt, who: 'review', kind: r.verdict === 'passed' ? '审查通过' : '审查打回', text: r.reason + '　' + r.checks.map(c => (c.ok ? '✓' : '✕') + c.label).join(' ') });
    }
    const live = this.ticketLive.get(ticketId)?.log ?? [];
    const firstReport = items.find(i => i.kind === '报告')?.at ?? null;
    // The gremlin's actions have no timestamps of their own; they come before its first report.
    const acts = [...live].reverse().filter(l => l.kind !== '说').slice(-12).map((l, i): import('../../shared/v8/board').TimelineItem => ({ id: 'a' + i, at: null, who: 'gremlin', kind: l.kind, text: l.text }));
    items.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    // The boss's own words live in the lead's conversation, not on the ticket; the ticket keeps them verbatim.
    if (!items.some(i => i.who === 'boss')) {
      try { const t = this.scheduler.ticket(ticketId); items.unshift({ id: 'request', at: t.createdAt, who: 'boss', kind: '你说', text: t.originalRequest }); } catch { /* unknown ticket */ }
    }
    if (acts.length) {
      const at = firstReport === null ? items.length : items.findIndex(i => i.at === firstReport);
      items.splice(at < 0 ? items.length : at, 0, ...acts);
    }
    return items;
  }

  /** The review page: the latest verdict with its checks, and today's record. */
  reviewDetail(): import('../../shared/v8/board').ReviewDetail {
    const today = this.scheduler.reviews({ since: startOfDay(this.now()) });
    const title = (id: number) => { try { return this.scheduler.ticket(id).title; } catch { return '工单 #' + id; } };
    const latest = today[0] ?? this.scheduler.reviews()[0];
    return {
      latest: latest ? { title: title(latest.ticketId), checks: latest.checks } : null,
      history: today.map(r => ({ id: 'r' + r.id, title: title(r.ticketId), ok: r.verdict === 'passed', note: r.verdict === 'passed' ? null : r.reason, at: r.createdAt })),
    };
  }

  // ---------- internals ----------

  private reviewSummary(): BoardData['review'] {
    if (!this.reviewer) return { enabled: false, passedToday: 0, lastPassed: null, current: null };
    const today = this.scheduler.reviews({ since: startOfDay(this.now()) });
    const passed = today.filter(r => r.verdict === 'passed');
    const title = (id: number) => { try { return this.scheduler.ticket(id).title; } catch { return '工单 #' + id; } };
    return { enabled: true, passedToday: passed.length, lastPassed: passed[0] ? title(passed[0].ticketId) : null, current: this.reviewing !== null ? title(this.reviewing) : null };
  }

  private reviewOf(ticketId: number): { reviewPassed: boolean; reviewNote: string | null } {
    if (!this.reviewer) return { reviewPassed: false, reviewNote: null };
    const latest = this.scheduler.reviews({ ticketId })[0];
    if (latest?.verdict === 'passed') return { reviewPassed: true, reviewNote: null };
    const notes = [...this.scheduler.messages(ticketId)].reverse().filter(m => m.author === 'system');
    const asked = notes.findIndex(m => /^老板要求重新审/.test(String(m.body)));
    const skippedAt = notes.findIndex(m => /^审查/.test(String(m.body)));
    const skipped = skippedAt >= 0 && (asked < 0 || skippedAt < asked) ? notes[skippedAt] : undefined;
    return { reviewPassed: false, reviewNote: latest ? '审查打回了两次，交给你决定：' + latest.reason : skipped ? String(skipped.body) : null };
  }

  /** Everything the gremlin changed, for the review gremlin (build and test leftovers left out). */
  private rawDiff(ticketId: number): string { return this.spaces.diff(ticketId); }

  /**
   * Who plays which role, in words. Requirement 32/33: review counts only when another maker's model does it, so a
   * reviewer on the gremlins' own agent is called out on the board.
   */
  private acpLabel(acp: NonNullable<V8Settings['acp']>): string {
    const reviewer = acp.reviewer ?? acp.lead;
    const parts = [`本机 agent · 小怪A 用 ${agentName(acp.lead.agent)}，干活用 ${agentName(acp.worker.agent)}`];
    if (this.o.settings.review !== false) {
      parts.push(reviewer.agent === acp.worker.agent
        ? `审查和干活是同一家（${agentName(reviewer.agent)}），不算换一家审`
        : `审查用 ${agentName(reviewer.agent)}`);
    }
    return parts.join('，');
  }

  /** One role played by an agent from the roster. It is looked up when a session opens, so a sign-in made after
   *  the workbench started still counts. */
  private roleShell(role: V8AcpRole): AgentShell {
    const find = this.o.acpLaunch;
    return {
      open: async spec => {
        const launch = find ? await find(role.agent) : null;
        if (!launch) throw new Error(`V8_ACP_AGENT_UNAVAILABLE: ${role.agent}`);
        return new AcpShell({ ...launch, ...(role.model ? { model: role.model } : {}), ...(role.effort ? { effort: role.effort } : {}) }).open(spec);
      },
    };
  }

  private makeShell(): AgentShell {
    const s = this.o.settings;
    if (s.shell !== 'omp') return new FakeShell(demoScripts(this.o.demoPace ?? 1));
    const omp = s.omp ?? {};
    const env: Record<string, string> = {};
    if (omp.keyFile) env[omp.keyEnv ?? 'OPENAI_API_KEY'] = readFileSync(omp.keyFile, 'utf8').replace(/\s+/g, '');
    return new OmpShell({
      exe: omp.exe ?? 'omp', agentDir: omp.agentDir ?? join(this.o.stateDir, 'omp-agent'), sessionDir: join(this.o.stateDir, 'sessions'),
      env, extraPath: omp.extraPath ?? [], maxCostUsd: s.maxCostUsd ?? 0.5, readyTimeoutMs: 60000,
      ...(this.supply ? { gateway: { origin: () => this.supply?.origin() ?? null, agentBase: join(this.o.stateDir, 'omp-via-gateway') } } : {}),
    });
  }

  /** A small git repository for the fake shell to "work" in, so the board works with nothing configured. */
  private demoRepo(): string {
    const root = join(this.o.stateDir, 'demo-repo');
    if (existsSync(join(root, '.git'))) return root;
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# 演示项目\n\n新工作台的演示仓库。假的小怪只假装在这里干活，不会改文件。\n');
    writeFileSync(join(root, 'src', 'demo.ts'), 'export const hello = () => "hello";\n');
    const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore', windowsHide: true });
    git('init', '-q'); git('add', '-A');
    execFileSync('git', ['-C', root, '-c', 'user.name=Gremlin Works', '-c', 'user.email=demo@local.invalid', 'commit', '-qm', 'demo'], { stdio: 'ignore', windowsHide: true });
    return root;
  }

  private projectName(): string { return this.o.settings.projectRoot ? this.projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? '项目' : '演示项目'; }

  /** The same change for the delivery page: less context, file headers shortened to the file's name. */
  private diff(ticketId: number): string {
    return this.spaces.diff(ticketId, { context: 1, maxChars: 20000 })
      .split('\n').filter(l => !/^(diff --git|index |@@|\+\+\+ |--- |new file mode)/.test(l) || l.startsWith('+++ '))
      .map(l => (l.startsWith('+++ ') ? l.slice(6) : l)).slice(0, 200).join('\n');
  }

  private talk(tickets: TicketView[]): TalkLine[] {
    // Enough history for the talk bar to scroll back through; the board shows the newest at the bottom.
    const lines = this.scheduler.messages(null, 60);
    return lines.map((m, i): TalkLine => {
      const line: TalkLine = { id: 'm' + m.id, author: m.author === 'boss' ? 'boss' : 'lead', text: String(m.body) };
      // The lead's latest line about a ticket that is waiting for an answer carries the question's options.
      if (m.author === 'lead' && m.ticketId !== null && !lines.slice(i + 1).some(n => n.ticketId === m.ticketId)) {
        const t = tickets.find(x => x.id === m.ticketId);
        const r = t?.state === 'ANSWER' ? this.scheduler.latestReport(t.id) : null;
        if (r?.kind === 'question') line.question = { ticketId: t!.id, options: r.options, ...(r.recommended ? { recommended: r.recommended } : {}) };
      }
      return line;
    }).slice(-40);
  }

  private feedLines(): FeedLine[] {
    const talk = this.scheduler.messages(null, 8).map((m): FeedLine => ({ id: 'm' + m.id, at: m.createdAt, who: m.author === 'boss' ? '你' : this.leadName(), text: String(m.body).replace(/\s+/g, ' ').slice(0, 60), tone: m.author === 'boss' ? 'boss' : 'lead' }));
    return [...this.feed, ...talk].sort((a, b) => b.at - a.at).slice(0, 8);
  }

  private label(ticketId: number): string {
    const t = this.scheduler.tickets().find(x => x.id === ticketId);
    return this.scheduler.slots().find(s => s.id === t?.slotId)?.label ?? '工单 #' + ticketId;
  }

  private pushFeed(who: string, text: string, tone: FeedLine['tone']): void {
    this.feed.unshift({ id: 'a' + ++this.seq, at: this.now(), who, text: text.slice(0, 80), tone });
    this.feed.length = Math.min(this.feed.length, MAX_FEED);
  }

  private mark(m: RingMark): void { this.ring.push(m); if (this.ring.length > 120) this.ring.shift(); }

  private live(ticketId: number): TicketLive {
    let t = this.ticketLive.get(ticketId);
    if (!t) { t = { log: [], files: new Map(), cost: 0, bases: new Set(), startedAt: null, elapsedMs: 0 }; this.ticketLive.set(ticketId, t); }
    return t;
  }

  private track(a: Activity): void {
    const t = this.live(a.ticketId);
    const slotEntry = [...this.slotLive.entries()].find(([, l]) => l.ticketId === a.ticketId);
    const s = slotEntry?.[1];
    const log = (kind: string, text: string) => { t.log.unshift({ id: 'l' + ++this.seq, kind, text: text.slice(0, 160) }); t.log.length = Math.min(t.log.length, MAX_LOG); };
    switch (a.type) {
      case 'launched':
        this.slotLive.set(a.slotId, { ticketId: a.ticketId, startedAt: this.now(), live: null, phase: 'working', step: 0, reportingUntil: 0, cost: 0, bases: new Set() });
        t.startedAt = this.now();
        this.pushFeed(this.label(a.ticketId), '开工：' + this.scheduler.ticket(a.ticketId).title, 'slot');
        this.mark('event');
        break;
      case 'tool': {
        if (a.phase !== 'start') break;
        const args = (a.args ?? {}) as Record<string, unknown>;
        const what = String(args.path ?? args.command ?? args.pattern ?? '').slice(0, 80);
        log(a.name, what);
        if (s) {
          s.live = (a.name + ' ' + what).trim();
          if (/^(edit|write|patch)$/.test(a.name)) { s.step = Math.max(s.step, 2); s.phase = 'working'; }
          else if (/^(bash|shell|eval)$/.test(a.name) && s.step >= 2) { s.step = Math.max(s.step, 3); s.phase = 'checking'; }
          else if (/^(read|grep|glob|find)$/.test(a.name) && s.step === 0 && t.log.length > 3) s.step = 1;
        }
        if (/^(edit|write|patch)$/.test(a.name) && typeof args.path === 'string' && !args.path.includes('://')) {
          const f = t.files.get(args.path) ?? { path: args.path, plus: 0, minus: 0 };
          t.files.set(args.path, f);
        }
        break;
      }
      case 'said': log('说', a.text); break;
      case 'cost': t.cost += a.usd; t.bases.add(a.basis); this.spent += a.usd; this.spentBases.add(a.basis); if (s) { s.cost += a.usd; s.bases.add(a.basis); } break;
      case 'approval': if (!a.allowed) { log('被拒', a.tool + ' ' + (a.detail.split('\n')[1] ?? '')); this.pushFeed(this.label(a.ticketId), '被拒绝：' + a.tool, 'question'); } break;
      case 'refused': log('退回', a.code); break;
      case 'reported': {
        if (s) { s.step = 4; s.reportingUntil = this.now() + 4000; }
        const kind = a.report.kind;
        this.pushFeed(this.label(a.ticketId), kind === 'done' ? '做完了：' + a.report.summary : kind === 'question' ? '问：' + a.report.question : kind === 'blocked' ? '卡住：' + a.report.where : kind === 'failed' ? '失败：' + a.report.reason : '不用做：' + a.report.reason, kind === 'question' || kind === 'blocked' || kind === 'failed' ? 'question' : 'slot');
        this.mark(kind === 'done' || kind === 'nothing' ? 'event' : 'waiting');
        break;
      }
      case 'reviewing':
        this.reviewing = a.ticketId;
        this.pushFeed('审查', '在审：' + this.scheduler.ticket(a.ticketId).title, 'review');
        break;
      case 'reviewed':
        if (this.reviewing === a.ticketId) this.reviewing = null;
        this.pushFeed('审查', (a.outcome === 'passed' ? '通过：' : a.outcome === 'rejected' ? '打回：' : a.outcome === 'escalated' ? '打回两次，交给你：' : '没给结论：') + (a.outcome === 'passed' ? this.scheduler.ticket(a.ticketId).title : a.reason), 'review');
        this.mark(a.outcome === 'passed' ? 'passed' : a.outcome === 'skipped' ? 'waiting' : 'refused');
        break;
      case 'ended':
        if (t.startedAt) { t.elapsedMs += this.now() - t.startedAt; t.startedAt = null; }
        if (slotEntry && !(s && s.reportingUntil > this.now())) this.slotLive.delete(slotEntry[0]);
        else if (slotEntry) setTimeout(() => { if (this.slotLive.get(slotEntry[0])?.ticketId === a.ticketId) { this.slotLive.delete(slotEntry[0]); this.changed(); } }, 4000).unref?.();
        if (a.why === 'exited' && this.scheduler.state(a.ticketId) !== 'WAITING_QUOTA') this.pushFeed(this.label(a.ticketId), '停下了，没交报告', 'question');
        break;
      case 'quota': {
        log('额度', '用完了');
        this.mark('waiting');
        void this.applyQuotaRule(a.ticketId, a.resetsAt);
        break;
      }
      case 'probe':
        if (a.status === 'SUSPECT_SILENT') this.pushFeed(this.label(a.ticketId), '好一阵没动静了，还在跑', 'question');
        if (a.status === 'CONFIRMED_STALLED') this.pushFeed(this.label(a.ticketId), '超过时限还没交报告，先停下等你', 'question');
        break;
    }
    this.changed();
  }

  private changed(): void { for (const fn of [...this.listeners]) { try { fn(); } catch { /* a broken listener must not stop the work */ } } }
}
