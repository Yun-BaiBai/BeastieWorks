import { anyLang, dateLocale, tr } from '../../shared/i18n';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import { sureOf } from '../../shared/v8/board';
import type { CostBasis } from './shell';
import type { BoardData, BoardSlot, DeliveryDetail, FeedLine, FileChange, RingMark, SlotDetail, TalkLine, WorkLogLine } from '../../shared/v8/board';
import type { DoneReport, SlotConfig, TicketView, V8Message } from '../../shared/v8/tickets';
import type { V8Desk, V8QuotaRule, V8Settings } from '../../shared/v8/settings';
import { MAX_BACKUPS, deskLabel, desksOf, nextBackup, planOf } from '../../shared/v8/desks';
import { Scheduler } from './scheduler';
import { Dispatcher, type Activity } from './dispatcher';
import { Lead } from './lead';
import type { AgentShell } from './shell';
import { FakeShell } from './fakeShell';
import { TicketWorkspaces } from './workspace';
import { directoryPolicy } from './approval';
import { demoScripts } from './demoScripts';
import { REPORT_TOOL } from './prompts';
import { Reviewer } from './reviewer';
import { soonestBack } from './quotaRead';
import { SKILL_TOOLS, type SkillLibrary } from './skillLibrary';
import type { AgentQuota } from '../../shared/v8/agents';
import { AcpShell, type AcpShellOptions } from './acpShell';
import { agentName } from './acpQuirks';
import { makerOf } from './maker';
import type { V8AcpRole } from '../../shared/v8/settings';
import { Roundtable, type Proposer } from './roundtable';
import { oneShot } from './oneShot';
import { Chains } from './chains';
import { Splits } from './splits';
import { NOTES_NUDGE, NOTES_SYSTEM, NOTES_TOOL, ProjectNotes, acceptNotes, notesBrief } from './notes';
import type { NotesView } from '../../shared/v8/notes';
import { GLANCE_NUDGE, GLANCE_SYSTEM, GLANCE_TOOL, PATROL_DEFAULTS, acceptGlance, glanceBrief, overload, overloadWords, type PatrolLimits } from './patrol';

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
  /** The lead's and the reviewer's own rules for running out of quota, read each time (requirement 66). Default: the
   *  settings the workbench was opened with. */
  rolePlan?: (role: 'lead' | 'reviewer') => import('../../shared/v8/settings').V8QuotaPlan | undefined;
  /** The app's skill library (第 6 步); gremlins get it only on agents that take the app's tools. */
  skills?: SkillLibrary;
  /** The three-state probe's limits and pace (v8 计划书 S2.2); tests shorten them. */
  probe?: { silentMs?: number; hardMs?: number; intervalMs?: number };
  /** The patrol's 压垮 and 跑偏 rules (A11); tests shorten them. */
  patrol?: Partial<PatrolLimits>;
  /** Tests: give up on a roundtable proposer after this long. */
  proposeTimeoutMs?: number;
  /** A10: whether accepted tickets are written into the project's notebook (read live; default on). */
  notesOn?: () => boolean;
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
/** At most this many gremlins at once (plus the emergency slot). */
export const MAX_SLOTS = 8;
/** The per-ticket spending cap the app enforces: none for oh-my-pi (it stops itself) or when not set. */
const capOf = (s: V8Settings): number | null => typeof s.maxCostUsd === 'number' && s.maxCostUsd > 0 ? s.maxCostUsd : null;

export class V8Workbench {
  readonly scheduler: Scheduler;
  readonly dispatcher: Dispatcher;
  readonly lead: Lead;
  readonly reviewer: Reviewer | null;
  /** 圆桌会议 (A6): only with agents from the roster, and two makers at least. */
  readonly roundtable: Roundtable | null;
  /** The lead's agent, for the patrol's glance (A11). */
  private readonly thinker: AgentShell | null;
  /** One-off sessions running in the background (notes, the patrol's glance, roundtable proposers, splits): closing
   *  cuts them off and waits for them, so nothing writes after the database is closed. */
  private readonly quit = new AbortController();
  private readonly background = new Set<Promise<unknown>>();
  private inBackground(work: Promise<unknown>): void {
    const p = work.catch(() => undefined).finally(() => this.background.delete(p));
    this.background.add(p);
  }
  /** A15: 工序链. */
  readonly chains: Chains;
  /** A12: 拆解. Null without agents of this computer. */
  readonly splits: Splits | null;
  /** A10: this project's notebook. */
  readonly notes: ProjectNotes;
  private readonly patrolLimits: PatrolLimits;
  private patrolTimer: ReturnType<typeof setInterval> | null = null;
  /** Per ticket: when the patrol last glanced, and what it already warned about (once each). */
  private patrolled = new Map<number, { glancedAt: number; warned: Set<string> }>();
  private glancing = new Set<number>();
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
  /**
   * The spending cap per ticket in dollars (settings.maxCostUsd), for agents that do not stop by themselves (oh-my-pi
   * did, with --max-cost). A ticket that reaches it stops and waits for the boss; "再试一次" allows it the same again.
   */
  private capUsd: number | null = null;
  private allowance = new Map<number, number>();
  private spentBy = { lead: 0, review: 0, other: 0 };
  /** How each turn counted today's money was known (see CostSure). */
  private spentBases = new Set<CostBasis>();
  private listeners = new Set<() => void>();
  private seq = 0;

  constructor(private readonly o: WorkbenchOptions) {
    this.now = o.clock ?? Date.now;
    mkdirSync(o.stateDir, { recursive: true });
    this.db = new Database(join(o.stateDir, 'v8.db'));
    // What each ticket has spent and how far the boss let it go, kept across restarts and project switches, so the
    // per-ticket cap means the same after a restart (C3 review, finding 12).
    this.db.exec('CREATE TABLE IF NOT EXISTS v8_ticket_spend(ticket_id INTEGER PRIMARY KEY, cost REAL NOT NULL DEFAULT 0, allowance REAL)');
    // The lead's session, kept so a restart carries on the same conversation (C3 review, finding 8, the lead's half).
    this.db.exec('CREATE TABLE IF NOT EXISTS v8_lead_session(id INTEGER PRIMARY KEY CHECK (id = 1), agent TEXT NOT NULL, ref TEXT NOT NULL)');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.scheduler = new Scheduler(this.db, { clock: this.now, review: o.settings.review !== false });
    const s = o.settings;
    this.applySlots(s);
    this.capUsd = capOf(s);
    // With agents from the roster each role names its own model.
    const model = (s.shell === 'acp' ? s.acp?.worker.model : null) ?? null;

    this.projectRoot = s.projectRoot ?? this.demoRepo();
    this.spaces = new TicketWorkspaces(this.projectRoot, join(o.stateDir, 'work'));
    const acp = !o.shell && s.shell === 'acp' ? s.acp ?? null : null;
    if (!o.shell && s.shell === 'acp' && !acp) throw new Error('V8_ACP_ROLES_MISSING');
    const shell = o.shell ?? (acp ? this.roleShell(acp.worker) : this.makeShell());
    // Each role on its own agent; without agents (the demo) the lead and the reviewer share the gremlins' shell.
    const thinker = acp ? this.roleShell(acp.lead) : shell;
    const reviewShell = acp?.reviewer ? this.roleShell(acp.reviewer) : thinker;
    // An agent from the roster brings its own tools for reading; the lead's room is an empty folder, so there is
    // nothing to read, and every other tool is refused (spec section 4, boss's answer 6 of the final plan).
    const leadCwd = acp ? join(o.stateDir, 'lead-room') : this.projectRoot;
    if (acp) mkdirSync(leadCwd, { recursive: true });
    this.notes = new ProjectNotes(join(o.stateDir, 'notes.json'), this.now);
    this.dispatcher = new Dispatcher(this.scheduler, shell, {
      workdir: id => this.spaces.ensure(id),
      approve: directoryPolicy({ workdir: id => this.spaces.path(id), protectedFiles: id => this.spaces.big(id).filter(b => b.linked).map(b => b.path), hostTools: [REPORT_TOOL.name, ...(o.skills ? SKILL_TOOLS.map(t => t.name) : [])] }),
      clock: this.now, ...(o.probe ? { probe: o.probe } : {}),
      notes: { briefLines: () => this.notes.briefLines() },
      ...(o.skills ? { skills: { briefLines: (about: string, slotId?: string) => o.skills!.briefLines(about, this.ranAt(slotId)?.skillsOff ?? []), call: (n: string, a: unknown, slotId?: string) => o.skills!.call(n, a, this.ranAt(slotId)?.skillsOff ?? []), tools: SKILL_TOOLS } } : {}),
      // Each desk's gremlin on the desk's own agent, model and effort (requirement 61), read when its ticket starts.
      ...(acp ? { shellFor: (slotId: string) => { const d = this.desk(slotId); return d ? this.roleShell(d) : null; } } : {}),
    });
    this.thinker = acp ? thinker : null;
    this.patrolLimits = { ...PATROL_DEFAULTS, ...(o.patrol ?? {}) };
    // Only a session of the same agent is carried on; another agent starts new and catches up from the talk.
    const leadAgent = acp ? acp.lead.agent : 'demo';
    const kept = this.db.prepare('SELECT agent, ref FROM v8_lead_session WHERE id = 1').get() as { agent: string; ref: string } | undefined;
    this.lead = new Lead(this.scheduler, this.dispatcher, thinker, { cwd: leadCwd, name: this.leadName(), model: acp ? acp.lead.model ?? null : model,
      sessionRef: kept && kept.agent === leadAgent ? kept.ref : null,
      ...(acp ? { plan: () => this.rolePlan('lead') } : {}),
      onNote: (text: string, tone: 'boss' | 'question') => { this.pushFeed(this.leadName(), text, tone); this.changed(); },
      clock: this.now,
      // The desks as the board shows them, so the boss can name one (requirement 62).
      desks: () => {
        const tickets = this.scheduler.tickets();
        return this.scheduler.slots().filter(s => !s.emergency).map(s => {
          const d = this.desk(s.id);
          const on = tickets.find(t => t.slotId === s.id && t.state === 'WORKING');
          const agent = d && this.o.settings.shell === 'acp' ? agentName(d.agent) : tr('演示小怪');
          return { id: s.id, label: s.label, agent, model: s.model, busyWith: on ? `#${on.id} ${on.title}` : null,
            waiting: tickets.filter(t => t.targetSlot === s.id && t.state === 'QUEUED').length };
        });
      },
      history: () => this.scheduler.messages(null, 30).map(m => ({ author: m.author === 'boss' ? 'boss' as const : 'lead' as const, text: String(m.body) })),
      onSession: ref => { this.db.prepare('INSERT INTO v8_lead_session(id, agent, ref) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET agent = excluded.agent, ref = excluded.ref').run(leadAgent, ref); },
      ...(acp ? { roundtable: { open: (m: number, t?: string) => this.roundtable!.open(m, t), plans: (a: unknown) => this.roundtable!.plans(a) } } : {}), chains: { open: (a: unknown) => this.chains.open(a) }, ...(acp ? { splits: { open: (m: number, t?: string) => this.splits!.open(m, t) } } : {}), onCost: (usd, basis) => { this.spentBases.add(basis); this.spent += usd; this.spentBy.lead += usd; this.changed(); } });
    this.reviewer = s.review === false ? null : new Reviewer(this.scheduler, this.dispatcher, reviewShell, {
      model: acp ? (acp.reviewer ?? acp.lead).model ?? null : model, cwd: id => this.spaces.path(id), diff: id => this.rawDiff(id), onCost: (usd, basis) => { this.spentBases.add(basis); this.spent += usd; this.spentBy.review += usd; this.changed(); },
      ...(acp ? { plan: () => this.rolePlan('reviewer') } : {}),
      onNote: (text, tone) => { this.pushFeed(tr('审查'), text, tone); this.changed(); },
    });
    this.roundtable = acp ? new Roundtable({
      db: this.db, scheduler: this.scheduler, projectRoot: this.projectRoot,
      proposers: () => this.proposers(),
      toLead: text => this.lead.notify(text),
      startTicket: async () => { await this.dispatcher.pump(); },
      onCost: (usd, basis) => { this.spentBases.add(basis); this.spent += usd; this.spentBy.lead += usd; this.changed(); },
      onChange: () => this.changed(), clock: this.now, ...(o.proposeTimeoutMs ? { proposeTimeoutMs: o.proposeTimeoutMs } : {}),
      signal: this.quit.signal, track: w => this.inBackground(w),
    }) : null;
    this.splits = acp ? new Splits({
      db: this.db, scheduler: this.scheduler, projectRoot: this.projectRoot,
      splitter: () => this.proposers().find(p => p.agent === acp.worker.agent) ?? null,
      startTicket: async () => { await this.dispatcher.pump(); },
      onCost: (usd, basis) => { this.spentBases.add(basis); this.spent += usd; this.spentBy.lead += usd; this.changed(); },
      onChange: () => this.changed(), clock: this.now, signal: this.quit.signal, track: w => this.inBackground(w),
    }) : null;
    this.chains = new Chains({ db: this.db, scheduler: this.scheduler, startTicket: async () => { await this.dispatcher.pump(); }, onChange: () => this.changed(), clock: this.now });
    this.dispatcher.onActivity(a => this.track(a));
  }

  /**
   * The roundtable's proposers (A6): the agents the boss chose for the gremlins, the review and the lead, each once
   * (boss's answer 2026-11-20). Each proposes on the model and effort of the first role it plays.
   */
  private proposers(): Proposer[] {
    const acp = this.o.settings.shell === 'acp' ? this.o.settings.acp : undefined;
    if (!acp) return [];
    const seen = new Set<string>(), out: Proposer[] = [];
    for (const role of [acp.worker, acp.reviewer ?? acp.lead, acp.lead]) {
      if (seen.has(role.agent)) continue;
      seen.add(role.agent);
      out.push({ agent: role.agent, label: agentName(role.agent), shell: this.roleShell(role), model: role.model ?? null, effort: role.effort ?? null });
    }
    return out;
  }

  /** The boss picks Plan A or B: a ticket opens and gets going (A6). */
  async pickPlan(roundtableId: number, which: 'A' | 'B'): Promise<number> {
    if (!this.roundtable) throw new Error('V8_NO_ROUNDTABLE');
    const id = await this.roundtable.pick(roundtableId, which);
    this.pushFeed(tr('圆桌'), tr('你选了 Plan {0}，开了工单 #{1}', [which, id]), 'boss');
    this.changed();
    return id;
  }

  /**
   * 巡查 (A11): 压垮 and 跑偏, beside the dispatcher's 卡住. Warnings go to the boss through the talk bar, once per
   * ticket and kind; nothing is stopped. Returns what it warned about, for tests.
   */
  async patrol(): Promise<string[]> {
    const now = this.now(), L = this.patrolLimits, said: string[] = [];
    const tickets = this.scheduler.tickets();
    const spent = (id: number) => { const l = this.ticketLive.get(id); return l ? { elapsedMs: l.elapsedMs + (l.startedAt ? now - l.startedAt : 0), costUsd: l.cost } : null; };
    const finished = tickets.filter(t => t.state === 'DONE' || t.state === 'REVIEW').map(t => spent(t.id)).filter((x): x is { elapsedMs: number; costUsd: number } => !!x && x.elapsedMs > 0);
    for (const t of tickets.filter(x => x.state === 'WORKING')) {
      const s = spent(t.id);
      if (!s) continue;
      const p = this.patrolled.get(t.id) ?? { glancedAt: 0, warned: new Set<string>() };
      this.patrolled.set(t.id, p);
      const o = overload(s, finished, L);
      if (o && !p.warned.has(o.what)) {
        p.warned.add(o.what);
        const text = tr('巡查：工单 #{0}「{1}」可能压垮了——{2}。要不要叫停你定。', [t.id, t.title, overloadWords(o)]);
        this.scheduler.leadSaid(text, t.id); this.pushFeed(tr('巡查'), text.slice(3), 'question'); said.push(text);
      }
      // 跑偏: a glance by the lead's agent, only for work that has run a while (boss's answer 2026-11-20).
      if (this.thinker && s.elapsedMs >= L.glanceAfterMs && now - p.glancedAt >= L.glanceEveryMs && !this.glancing.has(t.id) && !p.warned.has('drift')) {
        p.glancedAt = now;
        this.glancing.add(t.id);
        const live = this.ticketLive.get(t.id);
        const acp = this.o.settings.acp!;
        try {
          const r = await oneShot({
            shell: this.thinker, tool: GLANCE_TOOL, nudge: GLANCE_NUDGE, accept: acceptGlance,
            spec: { role: 'reviewer', cwd: join(this.o.stateDir, 'lead-room'), model: acp.lead.model ?? null, systemPrompt: GLANCE_SYSTEM, builtinTools: false },
            prompt: glanceBrief({ request: t.originalRequest, routingNote: t.routingNote, minutes: Math.round(s.elapsedMs / 60_000),
              actions: (live?.log ?? []).filter(l => l.kind !== '说').slice(0, 12).map(l => (l.kind + ' ' + l.text).trim()), files: [...(live?.files.keys() ?? [])].slice(0, 20) }),
            onCost: (usd, basis) => { this.spentBases.add(basis); this.spent += usd; this.spentBy.lead += usd; },
            timeoutMs: 5 * 60_000, signal: this.quit.signal,
          });
          if (r.ok && !r.value.onTrack && this.scheduler.state(t.id) === 'WORKING') {
            p.warned.add('drift');
            const text = tr('巡查：工单 #{0}「{1}」可能跑偏了——{2}。还在干，要不要叫停或者跟它说一声你定。', [t.id, t.title, r.value.reason]);
            this.scheduler.leadSaid(text, t.id); this.pushFeed(tr('巡查'), text.slice(3), 'question'); said.push(text);
          }
        } finally { this.glancing.delete(t.id); }
      }
    }
    for (const id of [...this.patrolled.keys()]) if (!tickets.some(t => t.id === id && t.state === 'WORKING')) this.patrolled.delete(id);
    if (said.length) this.changed();
    return said;
  }

  async start(): Promise<void> {
    // A ticket that ended while the app was down (or before this fix) may still hold its big files read-only.
    for (const t of this.scheduler.tickets()) if (t.state === 'DONE' || t.state === 'STOPPED') this.spaces.release(t.id);
    await this.lead.start();
    await this.dispatcher.start();
    this.reviewer?.start();
    this.roundtable?.resumeAfterRestart();
    this.splits?.resumeAfterRestart();
    this.patrolTimer = setInterval(() => { this.inBackground(this.patrol()); }, this.patrolLimits.everyMs);
    this.patrolTimer.unref?.();
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
    const what = how === 'model' ? tr('模型换成 ') + (s.model ?? tr('默认')) : tr('推理档位换成 ') + (s.effort ?? tr('默认'));
    if (this.scheduler.state(ticketId) === 'WAITING_QUOTA') {
      this.scheduler.resumeFromQuota(ticketId, how);
      this.pushFeed(this.label(ticketId), what + tr('，接着干'), 'boss');
    } else if (this.dispatcher.isOpening(ticketId)) {
      // Still opening its session: it picks the new setting up before its first word (Dispatcher.launch).
      this.pushFeed(this.label(ticketId), what + tr('，开工就用新的'), 'boss');
    } else if (await this.dispatcher.pause(ticketId, () => { this.scheduler.restartRunning(ticketId, how); })) {
      this.pushFeed(this.label(ticketId), what + tr('，停一下接着干'), 'boss');
    }
    await this.dispatcher.pump(); this.changed();
  }

  /**
   * 等一等: the working gremlin stops and waits for quota. It goes on by itself when the tightest quota window of its
   * agent starts over (read from the maker, no quota used), or when the boss says go on.
   */
  async waitForQuota(ticketId: number): Promise<{ resetsAt: number | null }> {
    const agent = this.workerAgent(this.scheduler.lastSlot(ticketId));
    const q = agent && this.o.quotaOf ? await this.o.quotaOf(agent).catch(() => null) : null;
    const resetsAt = soonestBack(q);
    const when = resetsAt ? new Date(resetsAt).toLocaleString(dateLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + tr(' 额度重置后接着干') : tr('不知道额度几点重置，过一阵再试');
    const paused = await this.dispatcher.pause(ticketId, id => { this.scheduler.assignmentOutOfQuota(id, { resetsAt, detail: when, byBoss: true }); });
    if (!paused) throw new Error('V8_NOT_WORKING');
    this.pushFeed(this.label(ticketId), tr('先停下等额度（') + when + tr('）'), 'boss');
    this.changed();
    return { resetsAt };
  }

  /**
   * A gremlin's account ran out of quota (the ticket is already waiting): do what the boss set beforehand (第 5 步).
   * switch: go on at once on the boss's backup model and effort, unless it is already on them. wait: stay waiting;
   * when the refusal did not say when the quota is back, ask the maker (no quota used). The board says which.
   */
  async applyQuotaRule(ticketId: number, resetsAt: number | null): Promise<void> {
    // The desk the ticket ran at decides (requirement 63); the emergency desk follows the old single rule.
    const slotId = this.scheduler.lastSlot(ticketId);
    const desk = this.ranAt(slotId);
    const plan = desk ? desk.onQuota : planOf(this.o.quotaRule ? this.o.quotaRule() : this.o.settings.onQuota);
    const who = this.label(ticketId);
    const pin = this.scheduler.ticketSupply(ticketId);
    const role = this.workerAgent(slotId) ? desk ?? this.o.settings.acp?.worker : undefined;
    const model = pin.model ?? role?.model ?? null, effort = pin.effort ?? role?.effort ?? null;
    // The backups in order (OpenMausBot's FallbackChain): the one after the model it ran out on, or the first.
    const backups = plan?.do === 'switch' ? (plan.backups ?? []).filter(b => b && b.model).slice(0, MAX_BACKUPS) : [];
    const next = nextBackup(plan, model, effort);
    if (next) {
      try {
        this.scheduler.setTicketSupply(ticketId, { model: next.model, ...(next.effort ? { effort: next.effort } : {}) });
        this.scheduler.resumeFromQuota(ticketId, 'model');
        this.pushFeed(who, tr('额度用完，按你定的规矩换成 {0}{1}接着干', [next.model, next.effort ? tr('（{0} 档）', [next.effort]) : '']), 'boss');
        await this.dispatcher.pump(); this.changed();
        return;
      } catch { /* moved on meanwhile: fall through to waiting */ }
    }
    let back = resetsAt;
    if (back === null) {
      const agent = this.workerAgent(slotId);
      back = soonestBack(agent && this.o.quotaOf ? await this.o.quotaOf(agent).catch(() => null) : null);
      if (back !== null && back > this.now()) this.scheduler.setQuotaReset(ticketId, back);
      else back = null;
    }
    const when = back ? new Date(back).toLocaleString(dateLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + tr(' 额度重置后自己接着干') : tr('不知道额度几点重置，过一阵再试');
    const why = backups.length ? tr('备用的也用完了（最后在用 {0}），等额度', [model ?? '']) : tr('按你定的规矩等额度');
    this.pushFeed(who, tr('额度用完，{0}（{1}）', [why, when]), 'question');
    this.changed();
  }

  /** What the boss calls the lead (requirement 26). */
  leadName(): string { return this.o.settings.leadName?.trim().slice(0, 20) || tr('主理小怪'); }

  /** The agent the gremlins run on, when they run on an ACP agent. */
  workerAgent(slotId?: string | null): string | null {
    if (this.o.settings.shell !== 'acp') return null;
    return this.ranAt(slotId)?.agent ?? this.o.settings.acp?.worker.agent ?? null;
  }

  /** The lead's or the reviewer's rule for running out of quota (requirement 66): read live, as the desks' are. */
  private rolePlan(role: 'lead' | 'reviewer'): import('../../shared/v8/settings').V8QuotaPlan | undefined {
    if (this.o.rolePlan) return this.o.rolePlan(role);
    const acp = this.o.settings.acp;
    return role === 'lead' ? acp?.lead.onQuota : (acp?.reviewer ?? acp?.lead)?.onQuota;
  }

  /** Each desk as it was when its current (or last) work started (1.0 review, finding 7). */
  private atLaunch = new Map<string, V8Desk | null>();

  /** The desk a piece of work runs at, as it was when the work started; the desk now if nothing started there yet. */
  private ranAt(slotId: string | null | undefined): V8Desk | null {
    if (slotId && this.atLaunch.has(slotId)) return this.atLaunch.get(slotId) ?? null;
    return this.desk(slotId);
  }

  /** A desk as the boss set it up (requirement 61), or null for the emergency desk and for none. */
  desk(slotId: string | null | undefined): V8Desk | null {
    if (!slotId) return null;
    const d = desksOf(this.o.settings).find(x => x.id === slotId) ?? null;
    // Before the boss set desks, the one old rule is read live, as it always was (changing it restarts nothing).
    if (d && !this.o.settings.desks?.length && this.o.quotaRule) { const plan = planOf(this.o.quotaRule()); return plan ? { ...d, onQuota: plan } : { ...d, onQuota: undefined }; }
    return d;
  }

  private quotaTimer: ReturnType<typeof setInterval> | null = null;

  async shutdown(): Promise<void> {
    this.quit.abort();
    await Promise.allSettled([...this.background]);
    if (this.quotaTimer) { clearInterval(this.quotaTimer); this.quotaTimer = null; }
    if (this.patrolTimer) { clearInterval(this.patrolTimer); this.patrolTimer = null; }
    await this.reviewer?.stop();
    await this.dispatcher.shutdown();
    await this.lead.stop();
    this.db.close();
  }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // ---------- the boss's actions ----------

  say(text: string): number { const id = this.lead.bossSays(text); this.changed(); return id; }
  /** An answer to a gremlin's question, or anything else the boss says to one ticket. */
  async tell(ticketId: number, text: string): Promise<void> { await this.dispatcher.tell(ticketId, text); this.changed(); }
  async stop(ticketId: number): Promise<void> { await this.dispatcher.stop(ticketId); this.spaces.release(ticketId); this.changed(); }
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
    // Only work that is waiting for the boss goes into the project: a stale page must not write first and fail after
    // (C3 review, finding 4).
    if (this.scheduler.state(ticketId) !== 'REVIEW') throw new Error('V8_NOT_AWAITING_REVIEW');
    // The big files it linked in are writable again before the project's copies are replaced.
    this.spaces.release(ticketId);
    let r: { applied: string[]; conflicts: string[] };
    // Not accepted, by a conflict or a failure: the ticket is still open, so its big files are read-only again.
    try { r = this.spaces.base(ticketId) ? this.spaces.apply(ticketId) : { applied: [], conflicts: [] }; } catch (err) { this.spaces.lock(ticketId); throw err; }
    if (r.conflicts.length) this.spaces.lock(ticketId);
    if (r.conflicts.length) { this.conflicted.add(ticketId); throw new Error('V8_APPLY_CONFLICT: ' + r.conflicts.join(tr('、'))); }
    this.scheduler.confirmTicket(ticketId); this.mark('passed'); this.changed();
    this.chains.accepted(ticketId, r.applied);
    this.inBackground(this.captureNotes(ticketId));
    return { applied: r.applied };
  }

  /**
   * A10: after the boss accepts a ticket, the lead's agent reads his words on it and the report once and writes the
   * few lines worth keeping into the project's notebook (notes.ts). Off in the settings, or without an agent for the
   * lead, nothing is written. Returns the lines added.
   */
  async captureNotes(ticketId: number): Promise<string[]> {
    if (!this.thinker || this.o.notesOn?.() === false) return [];
    const t = this.scheduler.ticket(ticketId);
    const bossLines = this.scheduler.messages(ticketId).filter(m => m.author === 'boss' && m.kind === 'say' && typeof m.body === 'string').map(m => String(m.body));
    const rep = this.scheduler.latestReport(ticketId);
    const report = rep?.kind === 'done' ? [rep.summary, rep.verification.command, rep.verification.output.slice(0, 2000)].join('\n') : '';
    const notebook = this.notes.list().map(n => n.text);
    const bossWords = [t.originalRequest, ...bossLines].join('\n');
    const acp = this.o.settings.acp!;
    const r = await oneShot({
      shell: this.thinker, tool: NOTES_TOOL, nudge: NOTES_NUDGE,
      accept: raw => acceptNotes(raw, { bossWords, report, notebook }),
      spec: { role: 'reviewer', cwd: join(this.o.stateDir, 'lead-room'), model: acp.lead.model ?? null, systemPrompt: NOTES_SYSTEM, builtinTools: false },
      prompt: notesBrief({ request: t.originalRequest, bossLines, report: report || null, notebook }),
      signal: this.quit.signal,
      onCost: (usd, basis) => { this.spentBases.add(basis); this.spent += usd; this.spentBy.lead += usd; },
      timeoutMs: 5 * 60_000,
    });
    if (!r.ok || !r.value.length || this.quit.signal.aborted) return [];
    const added = this.notes.addFrom(r.value, ticketId).map(n => n.text);
    this.pushFeed(tr('笔记'), tr('从工单 #{0} 记了 {1} 条：{2}', [ticketId, added.length, added.join(tr('；'))]), 'lead');
    this.changed();
    return added;
  }

  /** A12: the boss approves a split (split) or has it done whole (whole). */
  async decideSplit(id: number, how: 'split' | 'whole'): Promise<number[]> {
    if (!this.splits) throw new Error('V8_NOTHING_TO_DECIDE');
    const t = await this.splits.decide(id, how); this.changed(); return t;
  }

  /** A15: the boss presses "开下一道". */
  async nextStage(chainId: number): Promise<number> { const id = await this.chains.next(chainId); this.changed(); return id; }

  /** A10: the notebook for the notes page. */
  notesView(): NotesView {
    return { notes: this.notes.list(), capture: this.o.notesOn?.() !== false, canCapture: !!this.thinker };
  }
  noteAdd(text: string): NotesView { this.notes.add(text); this.changed(); return this.notesView(); }
  noteEdit(id: number, text: string): NotesView { this.notes.edit(id, text); this.changed(); return this.notesView(); }
  noteRemove(id: number): NotesView { this.notes.remove(id); this.changed(); return this.notesView(); }
  async reject(ticketId: number, why: string): Promise<void> {
    // Sent back after an accept refused for a conflict: the gremlin first gets the project as it is now (1.0 review, 13).
    let caught = '';
    if (this.conflicted.delete(ticketId)) {
      try {
        const c = this.spaces.catchUp(ticketId);
        caught = '\n\n' + tr('（程序已把你的工作副本换成项目现在的样子：你没动过的文件用了项目里的新版本。{0}）', [c.both.length ? tr('这几个文件你和项目都改过：{0}；项目里现在的版本放在 .beastie-merge/ 下面同样的位置，把两边合在一起再交，.beastie-merge 不用删，它不会放进项目', [c.both.join(tr('、'))]) : tr('没有两边都改过的文件')]);
      } catch { /* the folder is gone: the gremlin starts from the project anyway */ }
    }
    await this.tell(ticketId, tr('打回重做：') + (why.trim() || tr('没写原因')) + caught); this.mark('refused');
  }

  /** Tickets whose last accept was refused for a conflict (reject then catches the copy up). */
  private conflicted = new Set<number>();
  /** Try a stuck or failed ticket again. With another model (or later another agent) it starts a fresh session that
   *  picks up from the directory, since the old session cannot be read by it (S2.7). */
  /**
   * The slots the settings ask for (规范第 5 节: two by default, up to eight, plus one emergency slot for work the boss
   * just spoke to). Applied even when work was left running; only removing a slot that holds running work is refused,
   * and then the old slots stay until that work is done.
   */
  private applySlots(s: V8Settings): void {
    // The desks as the boss set them up, each with its own name and model (requirement 61); before he set any, the old
    // count with the one worker role (desks.ts).
    const model = (s.shell === 'acp' ? s.acp?.worker.model : null) ?? null;
    const slots: SlotConfig[] = desksOf(s).slice(0, MAX_SLOTS).map((d, i) => ({ id: d.id, label: deskLabel(d, i, n => tr('工位 ') + n), model: s.shell === 'acp' ? d.model ?? null : null, emergency: false }));
    if (s.emergencySlot !== false) slots.push({ id: 'slot-emergency', label: tr('应急'), model, emergency: true });
    if (JSON.stringify(this.scheduler.slots()) !== JSON.stringify(slots)) {
      try { this.scheduler.setSlots(slots); } catch (err) { if (!(err instanceof Error && err.message === 'V8_SLOT_BUSY')) throw err; }
    }
  }

  /** Settings that apply while work goes on (老板 2026-11-20 A1): the slots and the spending cap. */
  async applyLive(s: V8Settings): Promise<void> {
    this.o.settings = s;
    this.applySlots(s);
    this.capUsd = capOf(s);
    await this.dispatcher.pump();
    this.changed();
  }

  async retry(ticketId: number, o: { model?: string; fresh?: boolean } = {}): Promise<void> {
    // A ticket stopped at the spending cap may spend the same again.
    const live = this.live(ticketId);   // read back after a restart too
    if (this.capUsd && live && live.cost >= (this.allowance.get(ticketId) ?? this.capUsd)) { this.allowance.set(ticketId, live.cost + this.capUsd); this.keepSpend(ticketId); }
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
      const look = this.desk(slot.id)?.look;
      return { slot, order, ...(look ? { look } : {}), ticket, live: live?.live ?? null, phase: ticket ? live?.phase ?? 'working' : null, step: live?.step ?? 0,
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
        : { kind: 'fake', label: tr('演示小怪（不调用模型）') },
      agents: this.o.settings.shell === 'acp' && this.o.settings.acp
        ? { lead: this.o.settings.acp.lead.model ?? null, review: (this.o.settings.acp.reviewer ?? this.o.settings.acp.lead).model ?? null }
        : { lead: null, review: null },
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
      roundtables: this.roundtable?.views() ?? [],
      chains: this.chains.views(),
      splits: this.splits?.views() ?? [],
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
    const role = this.o.settings.shell === 'acp' ? this.ranAt(slotId) ?? this.o.settings.acp?.worker : undefined;
    return {
      slot, saidAt: slot.ticket.createdAt, log: t?.log ?? [], files: [...(t?.files.values() ?? [])],
      tuning: { agent: this.workerAgent(slotId), model: pin.model ?? slot.slot.model ?? role?.model ?? null, effort: pin.effort ?? role?.effort ?? null },
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
      summary: done ? done.summary : tr('它说不用做：') + (r.kind === 'nothing' ? r.reason : ''),
      files: done ? done.changed.map(p => t?.files.get(p) ?? { path: p, plus: 0, minus: 0 }) : [],
      diff: done ? this.diff(ticketId) : '',
      verification: done ? done.verification : { command: '', output: '' },
      elapsedMs: t?.elapsedMs ?? 0, costUsd: t?.cost ?? 0, costSure: sureOf(t?.bases ?? []), ...this.reviewOf(ticketId), shots: null,
    };
  }

  /** Money spent outside tickets: chatting with an agent on the roster page, or having it retell a skill. */
  spendOutside(usd: number, basis: import('./shell').CostBasis): void {
    this.spentBases.add(basis); this.spent += usd; this.spentBy.other += usd; this.changed();
  }

  /** 账本: where the money went since the app started. */
  ledger(): import('../../shared/v8/board').LedgerDetail {
    const byTicket = this.scheduler.tickets().map(t => {
      const l = this.ticketLive.get(t.id);
      return { id: t.id, title: t.title, state: t.state, costUsd: l?.cost ?? 0, elapsedMs: (l?.elapsedMs ?? 0) + (l?.startedAt ? this.now() - l.startedAt : 0) };
    }).sort((a, b) => b.costUsd - a.costUsd || b.id - a.id);
    const gremlins = byTicket.reduce((s, t) => s + t.costUsd, 0);
    return { totalUsd: this.spent, totalSure: sureOf(this.spentBases), bySource: { gremlins, lead: this.spentBy.lead, review: this.spentBy.review, other: this.spentBy.other }, byTicket,
      capUsd: this.capUsd };
  }

  /** 档案柜: every ticket, newest first, with a one-line outcome. */
  archive(): import('../../shared/v8/board').ArchiveItem[] {
    return this.scheduler.tickets().reverse().map(t => {
      const r = this.scheduler.latestReport(t.id);
      const outcome = t.state === 'STOPPED' ? tr('老板叫停了') : !r ? null
        : r.kind === 'done' ? r.summary : r.kind === 'question' ? tr('问：') + r.question : r.kind === 'blocked' ? tr('卡在：') + r.where : r.kind === 'failed' ? tr('失败：') + r.reason : tr('不用做：') + r.reason;
      return { id: t.id, title: t.title, originalRequest: t.originalRequest, state: t.state, createdAt: t.createdAt, endedAt: t.endedAt, outcome };
    });
  }

  /** One ticket's story, oldest first: the record (messages, reports, reviews) and, for this run, the gremlin's actions. */
  timeline(ticketId: number): import('../../shared/v8/board').TimelineItem[] {
    const items: import('../../shared/v8/board').TimelineItem[] = [];
    for (const m of this.scheduler.messages(ticketId, 500)) {
      const body = m.body;
      if (m.kind === 'report' && typeof body === 'object') {
        const text = body.kind === 'done' ? tr('做完了：{0}（验证：{1} → {2}）', [body.summary, body.verification.command, body.verification.output.trim().split('\n').pop()])
          : body.kind === 'question' ? tr('问你：') + body.question : body.kind === 'blocked' ? tr('卡住了：') + body.where : body.kind === 'failed' ? tr('失败了：') + body.reason : tr('发现不用做：') + body.reason;
        items.push({ id: 'm' + m.id, at: m.createdAt, who: m.author === 'system' ? 'system' : 'gremlin', kind: tr('报告'), text });
      } else {
        items.push({ id: 'm' + m.id, at: m.createdAt, who: m.author === 'boss' ? 'boss' : m.author === 'lead' ? 'lead' : m.author === 'worker' ? 'gremlin' : anyLang('审查').some(w => String(body).includes(w)) ? 'review' : 'system', kind: m.author === 'boss' ? tr('你说') : m.author === 'lead' ? this.leadName() : tr('记录'), text: String(body) });
      }
    }
    for (const r of this.scheduler.reviews({ ticketId })) {
      items.push({ id: 'r' + r.id, at: r.createdAt, who: 'review', kind: r.verdict === 'passed' ? tr('审查通过') : tr('审查打回'), text: r.reason + tr('　') + r.checks.map(c => (c.ok ? '✓' : '✕') + c.label).join(' ') });
    }
    const live = this.ticketLive.get(ticketId)?.log ?? [];
    const firstReport = items.find(i => i.kind === tr('报告'))?.at ?? null;
    // The gremlin's actions have no timestamps of their own; they come before its first report.
    const acts = [...live].reverse().filter(l => l.kind !== '说').slice(-12).map((l, i): import('../../shared/v8/board').TimelineItem => ({ id: 'a' + i, at: null, who: 'gremlin', kind: l.kind, text: l.text }));
    items.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    // The boss's own words live in the lead's conversation, not on the ticket; the ticket keeps them verbatim.
    if (!items.some(i => i.who === 'boss')) {
      try { const t = this.scheduler.ticket(ticketId); items.unshift({ id: 'request', at: t.createdAt, who: 'boss', kind: tr('你说'), text: t.originalRequest }); } catch { /* unknown ticket */ }
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
    const title = (id: number) => { try { return this.scheduler.ticket(id).title; } catch { return tr('工单 #') + id; } };
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
    const title = (id: number) => { try { return this.scheduler.ticket(id).title; } catch { return tr('工单 #') + id; } };
    return { enabled: true, passedToday: passed.length, lastPassed: passed[0] ? title(passed[0].ticketId) : null, current: this.reviewing !== null ? title(this.reviewing) : null };
  }

  private reviewOf(ticketId: number): { reviewPassed: boolean; reviewNote: string | null } {
    if (!this.reviewer) return { reviewPassed: false, reviewNote: null };
    const latest = this.scheduler.reviews({ ticketId })[0];
    // A pass counts only for the report it looked at: work redone since then has not been reviewed (C3 review,
    // finding 10).
    const report = [...this.scheduler.messages(ticketId)].reverse().find(m => m.kind === 'report');
    if (latest?.verdict === 'passed' && latest.reportMessageId === report?.id) {
      // Requirement 32/33: review by the worker's own agent is no second opinion; the pass says so (C3, finding 11).
      const acp = this.o.settings.shell === 'acp' ? this.o.settings.acp : undefined;
      // By the company behind the models actually used, not only the agent: a Codex desk on a Claude model through
      // Magpie is Anthropic's work (1.0 review, finding 12). Unknown makers fall back to comparing the agents.
      let same = false;
      if (acp) {
        const reviewer = acp.reviewer ?? acp.lead;
        const slotId = this.scheduler.lastSlot(ticketId);
        const workerAgent = this.workerAgent(slotId) ?? acp.worker.agent;
        const workerModel = this.scheduler.ticketSupply(ticketId).model ?? this.ranAt(slotId)?.model ?? acp.worker.model ?? null;
        const a = makerOf(workerAgent, workerModel), b = makerOf(reviewer.agent, reviewer.model ?? null);
        same = a && b ? a === b : workerAgent === reviewer.agent;
      }
      return { reviewPassed: true, reviewNote: same ? tr('这次审查和干活用的是同一家公司的模型，不算换一家审。') : null };
    }
    const notes = [...this.scheduler.messages(ticketId)].reverse().filter(m => m.author === 'system');
    const asked = notes.findIndex(m => anyLang('老板要求重新审一次。').includes(String(m.body)));
    const skippedAt = notes.findIndex(m => anyLang('审查').some(w => String(m.body).startsWith(w)));
    const skipped = skippedAt >= 0 && (asked < 0 || skippedAt < asked) ? notes[skippedAt] : undefined;
    return { reviewPassed: false, reviewNote: latest ? tr('审查打回了两次，交给你决定：') + latest.reason : skipped ? String(skipped.body) : null };
  }

  /** Everything the gremlin changed, for the review gremlin (build and test leftovers left out). */
  private rawDiff(ticketId: number): string { return this.spaces.diff(ticketId); }

  /**
   * Who plays which role, in words. Requirement 32/33: review counts only when another maker's model does it, so a
   * reviewer on the gremlins' own agent is called out on the board.
   */
  private acpLabel(acp: NonNullable<V8Settings['acp']>): string {
    const reviewer = acp.reviewer ?? acp.lead;
    // The desks may run on different agents now (requirement 61): name each once.
    const workers = [...new Set(desksOf(this.o.settings).map(d => d.agent))];
    const parts = [tr('本机 agent · 主理小怪 用 {0}，干活用 {1}', [agentName(acp.lead.agent), workers.map(agentName).join(tr('、'))])];
    if (this.o.settings.review !== false) {
      parts.push(workers.includes(reviewer.agent)
        ? tr('审查和干活是同一家（{0}），不算换一家审', [agentName(reviewer.agent)])
        : tr('审查用 {0}', [agentName(reviewer.agent)]));
    }
    return parts.join(tr('，'));
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

  /** Without agents of this computer: the scripted demo gremlins, which call no model. */
  private makeShell(): AgentShell {
    return new FakeShell(demoScripts(this.o.demoPace ?? 1));
  }

  /** A small git repository for the fake shell to "work" in, so the board works with nothing configured. */
  private demoRepo(): string {
    const root = join(this.o.stateDir, 'demo-repo');
    if (existsSync(join(root, '.git'))) return root;
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'README.md'), tr('# 演示项目\n\n新工作台的演示仓库。假的小怪只假装在这里干活，不会改文件。\n'));
    writeFileSync(join(root, 'src', 'demo.ts'), 'export const hello = () => "hello";\n');
    const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore', windowsHide: true });
    git('init', '-q'); git('add', '-A');
    execFileSync('git', ['-C', root, '-c', 'user.name=Gremlin Works', '-c', 'user.email=demo@local.invalid', 'commit', '-qm', 'demo'], { stdio: 'ignore', windowsHide: true });
    return root;
  }

  private projectName(): string { return this.o.settings.projectRoot ? this.projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? tr('项目') : tr('演示项目'); }

  /** The same change for the delivery page: less context, file headers shortened to the file's name. */
  private diff(ticketId: number): string {
    const raw = this.spaces.diff(ticketId, { context: 1, maxChars: 20000 });
    const lines = raw.split('\n').filter(l => !/^(diff --git|index |@@|\+\+\+ |--- |new file mode)/.test(l) || l.startsWith('+++ '))
      .map(l => (l.startsWith('+++ ') ? l.slice(6) : l));
    // Cut for the page, but never silently: every file accepting would put in is named (C3 review, finding 18).
    if (lines.length <= 200 && raw.length < 20000) return lines.join('\n');
    const all = this.spaces.changes(ticketId).map(c => c.path);
    return [...lines.slice(0, 200), tr('…（改动太长，这里只显示了前面一部分。收下会放进项目的一共 {0} 个文件：{1}）', [all.length, all.join(tr('、'))])].join('\n');
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
    const talk = this.scheduler.messages(null, 8).map((m): FeedLine => ({ id: 'm' + m.id, at: m.createdAt, who: m.author === 'boss' ? tr('你') : this.leadName(), text: String(m.body).replace(/\s+/g, ' ').slice(0, 60), tone: m.author === 'boss' ? 'boss' : 'lead' }));
    return [...this.feed, ...talk].sort((a, b) => b.at - a.at).slice(0, 8);
  }

  private label(ticketId: number): string {
    const t = this.scheduler.tickets().find(x => x.id === ticketId);
    return this.scheduler.slots().find(s => s.id === t?.slotId)?.label ?? tr('工单 #') + ticketId;
  }

  private pushFeed(who: string, text: string, tone: FeedLine['tone']): void {
    this.feed.unshift({ id: 'a' + ++this.seq, at: this.now(), who, text: text.slice(0, 80), tone });
    this.feed.length = Math.min(this.feed.length, MAX_FEED);
  }

  private mark(m: RingMark): void { this.ring.push(m); if (this.ring.length > 120) this.ring.shift(); }

  private live(ticketId: number): TicketLive {
    let t = this.ticketLive.get(ticketId);
    if (!t) {
      const kept = this.db.prepare('SELECT cost, allowance FROM v8_ticket_spend WHERE ticket_id=?').get(ticketId) as { cost: number; allowance: number | null } | undefined;
      t = { log: [], files: new Map(), cost: kept?.cost ?? 0, bases: new Set(), startedAt: null, elapsedMs: 0 };
      if (kept?.allowance != null && !this.allowance.has(ticketId)) this.allowance.set(ticketId, kept.allowance);
      this.ticketLive.set(ticketId, t);
    }
    return t;
  }

  /** Write down what a ticket has spent and how far it may go (see v8_ticket_spend). */
  private keepSpend(ticketId: number): void {
    const t = this.ticketLive.get(ticketId);
    const a = this.allowance.get(ticketId);
    this.db.prepare('INSERT INTO v8_ticket_spend(ticket_id,cost,allowance) VALUES(?,?,?) ON CONFLICT(ticket_id) DO UPDATE SET cost=excluded.cost, allowance=excluded.allowance')
      .run(ticketId, t?.cost ?? 0, a !== undefined && Number.isFinite(a) ? a : null);
  }

  private track(a: Activity): void {
    const t = this.live(a.ticketId);
    const slotEntry = [...this.slotLive.entries()].find(([, l]) => l.ticketId === a.ticketId);
    const s = slotEntry?.[1];
    const log = (kind: string, text: string) => { t.log.unshift({ id: 'l' + ++this.seq, kind, text: text.slice(0, 160) }); t.log.length = Math.min(t.log.length, MAX_LOG); };
    switch (a.type) {
      case 'launched':
        // The desk as it was when this work started: what it runs on until it ends (1.0 review, finding 7).
        this.atLaunch.set(a.slotId, this.desk(a.slotId));
        this.slotLive.set(a.slotId, { ticketId: a.ticketId, startedAt: this.now(), live: null, phase: 'working', step: 0, reportingUntil: 0, cost: 0, bases: new Set() });
        t.startedAt = this.now();
        this.pushFeed(this.label(a.ticketId), tr('开工：') + this.scheduler.ticket(a.ticketId).title, 'slot');
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
      case 'said': log(tr('说'), a.text); break;
      case 'cost': {
        t.cost += a.usd; t.bases.add(a.basis); this.spent += a.usd; this.spentBases.add(a.basis); if (s) { s.cost += a.usd; s.bases.add(a.basis); }
        this.keepSpend(a.ticketId);
        const limit = this.capUsd ? this.allowance.get(a.ticketId) ?? this.capUsd : null;
        if (limit !== null && t.cost >= limit && this.scheduler.state(a.ticketId) === 'WORKING') {
          // Stopped once at this limit, as stuck (卡住) so it waits for the boss with "再试一次", which raises the limit
          // (retry above). The work so far stays in its folder.
          this.allowance.set(a.ticketId, Number.POSITIVE_INFINITY);
          const where = tr('花到上限了（这件活设的上限是 ${0}，已经花了 ${1}）', [limit.toFixed(2), t.cost.toFixed(2)]);
          this.pushFeed(this.label(a.ticketId), where + tr('，先停下等你决定'), 'question');
          void this.dispatcher.pause(a.ticketId, id => {
            this.scheduler.reportReceived(id, { kind: 'blocked', where, tried: tr('程序按你设的花费上限让它停下；做到一半的东西还在它的工作副本里。点"再试一次"让它再花这么多接着干。') });
          }).catch(() => undefined).finally(() => {
            if (this.allowance.get(a.ticketId) === Number.POSITIVE_INFINITY) this.allowance.set(a.ticketId, limit);
            this.keepSpend(a.ticketId);
            this.changed();
          });
        }
        break;
      }
      case 'approval': if (!a.allowed) { log(tr('被拒'), a.tool + ' ' + (a.detail.split('\n')[1] ?? '')); this.pushFeed(this.label(a.ticketId), tr('被拒绝：') + a.tool, 'question'); } break;
      case 'refused': log(tr('退回'), a.code); break;
      case 'reported': {
        if (s) { s.step = 4; s.reportingUntil = this.now() + 4000; }
        const kind = a.report.kind;
        this.pushFeed(this.label(a.ticketId), kind === 'done' ? tr('做完了：') + a.report.summary : kind === 'question' ? tr('问：') + a.report.question : kind === 'blocked' ? tr('卡住：') + a.report.where : kind === 'failed' ? tr('失败：') + a.report.reason : tr('不用做：') + a.report.reason, kind === 'question' || kind === 'blocked' || kind === 'failed' ? 'question' : 'slot');
        this.mark(kind === 'done' || kind === 'nothing' ? 'event' : 'waiting');
        break;
      }
      case 'reviewing':
        this.reviewing = a.ticketId;
        this.pushFeed(tr('审查'), tr('在审：') + this.scheduler.ticket(a.ticketId).title, 'review');
        break;
      case 'reviewed':
        if (this.reviewing === a.ticketId) this.reviewing = null;
        this.pushFeed(tr('审查'), (a.outcome === 'passed' ? tr('通过：') : a.outcome === 'rejected' ? tr('打回：') : a.outcome === 'escalated' ? tr('打回两次，交给你：') : tr('没给结论：')) + (a.outcome === 'passed' ? this.scheduler.ticket(a.ticketId).title : a.reason), 'review');
        this.mark(a.outcome === 'passed' ? 'passed' : a.outcome === 'skipped' ? 'waiting' : 'refused');
        break;
      case 'ended':
        if (t.startedAt) { t.elapsedMs += this.now() - t.startedAt; t.startedAt = null; }
        if (slotEntry && !(s && s.reportingUntil > this.now())) this.slotLive.delete(slotEntry[0]);
        else if (slotEntry) setTimeout(() => { if (this.slotLive.get(slotEntry[0])?.ticketId === a.ticketId) { this.slotLive.delete(slotEntry[0]); this.changed(); } }, 4000).unref?.();
        if (a.why === 'exited' && this.scheduler.state(a.ticketId) !== 'WAITING_QUOTA') this.pushFeed(this.label(a.ticketId), tr('停下了，没交报告'), 'question');
        break;
      case 'quota': {
        log(tr('额度'), tr('用完了'));
        this.mark('waiting');
        void this.applyQuotaRule(a.ticketId, a.resetsAt);
        break;
      }
      case 'probe':
        if (a.status === 'SUSPECT_SILENT') this.pushFeed(this.label(a.ticketId), tr('好一阵没动静了，还在跑'), 'question');
        if (a.status === 'CONFIRMED_STALLED') this.pushFeed(this.label(a.ticketId), tr('超过时限还没交报告，先停下等你'), 'question');
        break;
    }
    this.changed();
  }

  private changed(): void { for (const fn of [...this.listeners]) { try { fn(); } catch { /* a broken listener must not stop the work */ } } }
}
