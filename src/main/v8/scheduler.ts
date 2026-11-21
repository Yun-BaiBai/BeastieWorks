import { tr } from '../../shared/i18n';
import type Database from 'better-sqlite3';
import type {
  AssignmentEnd, AssignmentStatus, Delivery, Launch, Report, ReportKind, ReviewRow, ReviewVerdict, SlotConfig, TicketState, TicketView, V8Message,
} from '../../shared/v8/tickets';
import { MAX_REVIEW_REJECTIONS } from '../../shared/v8/tickets';
import { createV8Schema } from './schema';
import { ticketState } from './ticketState';
import { routingNoteWords, validateReport, validateReview } from './reports';

/**
 * The v8 scheduler: an ordinary program, not a model. It is the only writer of the v8 tables; the lead and the
 * gremlins can only ask it for things (spec section 1).
 *
 * Naming: commands are imperative (openTicket, stopTicket); facts reported by the shell layer are past tense
 * (assignmentStarted, reportReceived). Every call runs in one transaction. Refusals are Error('V8_…') codes.
 */

interface TicketRow {
  id: number; source_message_id: number; title: string; original_request: string; routing_note: string;
  session_ref: string | null; workdir: string | null; created_at: number; ended_at: number | null; end_kind: 'done' | 'stopped' | null;
  queue_rank: number;
}
/**
 * How urgent a pending assignment is. Both levels go before ordinary work; only BOSS may use the emergency slot
 * (规范第 5 节: the emergency slot is only for the boss speaking to a ticket, so the boss's words never queue).
 */
const URGENT_NONE = 0, URGENT_REWORK = 1, URGENT_BOSS = 2;
const QUEUE_ORDER = 'ORDER BY a.urgent DESC, t.queue_rank, t.created_at, t.id, a.id';
interface AssignmentRow {
  id: number; ticket_id: number; status: AssignmentStatus; slot_id: string | null; urgent: number; recovery: number;
  created_at: number; started_at: number | null; ended_at: number | null; end_reason: AssignmentEnd | null;
}
interface MessageRow {
  id: number; ticket_id: number | null; assignment_id: number | null; author: V8Message['author'];
  kind: V8Message['kind']; body: string; review: ReviewVerdict | null; created_at: number;
}
interface SlotRow { id: string; label: string; model: string | null; emergency: number; position: number }

export interface SchedulerOptions {
  clock?: () => number;
  /** Every "done" waits for the review gremlin before it reaches the boss (spec section 7). */
  review?: boolean;
}

const MAX_SAY = 20000;
const TITLE_MAX = 40;
const RETRY_NOTE = tr('老板让它再试一次');
const QUOTA_NOTE = tr('账号额度用完，等额度：');
const PARK_NOTE = tr('老板让它先停下等额度：');
const RESUME_NOTE: Record<QuotaResume, string> = {
  reset: tr('额度恢复了，接着干。先检查目录和提交记录，再决定从哪里继续。'),
  boss: tr('老板让它现在接着干。先检查目录和提交记录，再决定从哪里继续。'),
  account: tr('老板给它换了账号，接着干。先检查目录和提交记录，再决定从哪里继续。'),
  model: tr('老板给它换了模型，接着干。先检查目录和提交记录，再决定从哪里继续。'),
  effort: tr('老板给它换了推理档位，接着干。先检查目录和提交记录，再决定从哪里继续。'),
};
const RESUME_NOTES = new Set(Object.values(RESUME_NOTE));
/** Why a ticket waiting for quota goes on. */
export type QuotaResume = 'reset' | 'boss' | 'account' | 'model' | 'effort';
export interface QuotaWait { ticketId: number; assignmentId: number; since: number; resetsAt: number | null; detail: string }
/** Per-ticket supply override: which model and which account its sessions use (v8 计划书 S2.3). */
export interface TicketSupply { model: string | null; account: string | null; effort: string | null }
const REVIEW_NOTE = tr('审查没通过：');
const DEFAULT_SLOTS: SlotConfig[] = [{ id: 'slot-1', label: tr('工位 01'), model: null, emergency: false }];

export class Scheduler {
  private readonly now: () => number;
  private readonly review: boolean;

  constructor(private readonly db: Database.Database, options: SchedulerOptions = {}) {
    this.now = options.clock ?? Date.now;
    this.review = options.review === true;
    createV8Schema(db);
    if (!this.db.prepare('SELECT 1 FROM v8_slots LIMIT 1').get()) this.setSlots(DEFAULT_SLOTS);
  }

  // ---------- talk ----------

  /** The boss says something in the talk bar. It goes to the lead; no ticket yet. */
  bossSaid(text: string): number {
    return this.tx(() => this.insertMessage(null, null, 'boss', 'say', this.say(text)));
  }

  /** The lead replies to the boss, optionally about one ticket. */
  leadSaid(text: string, ticketId: number | null = null): number {
    return this.tx(() => {
      if (ticketId !== null) this.ticketRow(ticketId);
      return this.insertMessage(ticketId, null, 'lead', 'say', this.say(text));
    });
  }

  // ---------- lead tools ----------

  /**
   * Opens a ticket from one of the boss's own messages. The original request is copied from that message, never
   * written by the lead, so the gremlin always sees the boss's exact words. One message opens at most one ticket.
   */
  openTicket(input: { fromMessageId: number; routingNote: string; title?: string }): number {
    return this.tx(() => {
      const source = this.message(input.fromMessageId);
      if (source.author !== 'boss' || source.kind !== 'say' || source.ticket_id !== null) throw new Error('V8_NEEDS_BOSS_MESSAGE');
      if (this.db.prepare('SELECT 1 FROM v8_tickets WHERE source_message_id=?').get(source.id)) throw new Error('V8_MESSAGE_ALREADY_TICKETED');
      const note = (input.routingNote ?? '').trim();
      if (note.length > 300 || routingNoteWords(note) > 30) throw new Error('V8_ROUTING_NOTE_TOO_LONG');
      const title = (input.title?.trim() || source.body.trim().replace(/\s+/g, ' ')).slice(0, TITLE_MAX);
      const now = this.now();
      const id = Number(this.db.prepare(`INSERT INTO v8_tickets(source_message_id,title,original_request,routing_note,created_at)
        VALUES(?,?,?,?,?)`).run(source.id, title, source.body, note, now).lastInsertRowid);
      this.newAssignment(id, { urgent: URGENT_NONE, recovery: false });
      return id;
    });
  }

  /** The lead passes one of the boss's talk-bar messages to a ticket, word for word. */
  forwardToTicket(messageId: number, ticketId: number): Delivery {
    return this.tx(() => {
      const m = this.message(messageId);
      if (m.author !== 'boss' || m.kind !== 'say' || m.ticket_id !== null) throw new Error('V8_NEEDS_BOSS_MESSAGE');
      return this.deliver(ticketId, m.body);
    });
  }

  /** The boss speaks to one gremlin directly (from its slot page): an answer, a nudge, or a reply to a failure. */
  tellTicket(ticketId: number, text: string): Delivery {
    return this.tx(() => this.deliver(ticketId, this.say(text)));
  }

  /** Only at the boss's request. Returns the running assignments the shell must abort. */
  stopTicket(ticketId: number): { abort: number[] } {
    return this.tx(() => {
      const t = this.ticketRow(ticketId);
      if (t.end_kind) throw new Error('V8_TICKET_ENDED');
      const now = this.now();
      const abort = (this.db.prepare("SELECT id FROM v8_assignments WHERE ticket_id=? AND status='RUNNING'").pluck().all(ticketId) as number[]);
      this.db.prepare(`UPDATE v8_assignments SET status='ENDED',ended_at=?,end_reason='stopped' WHERE ticket_id=? AND status IN ('PENDING','RUNNING')`).run(now, ticketId);
      this.db.prepare("UPDATE v8_tickets SET ended_at=?,end_kind='stopped' WHERE id=?").run(now, ticketId);
      this.insertMessage(ticketId, null, 'system', 'note', tr('老板叫停了这张工单'));
      return { abort };
    });
  }

  // ---------- boss decisions ----------

  /** The boss accepts the result. Only from 等你看. */
  confirmTicket(ticketId: number): void {
    this.tx(() => {
      if (this.state(ticketId) !== 'REVIEW') throw new Error('V8_NOT_AWAITING_REVIEW');
      this.db.prepare("UPDATE v8_tickets SET ended_at=?,end_kind='done' WHERE id=?").run(this.now(), ticketId);
      this.insertMessage(ticketId, null, 'system', 'note', tr('老板收下了结果'));
    });
  }

  /** Same session, same directory, a new assignment. Only from 卡住 or 失败. */
  retryTicket(ticketId: number, o: { fresh?: boolean } = {}): number {
    return this.tx(() => {
      const s = this.state(ticketId);
      if (s !== 'BLOCKED' && s !== 'FAILED') throw new Error('V8_NOT_RETRYABLE');
      // Another agent cannot read this session: start a new one, which picks up from the directory (S2.7).
      if (o.fresh) this.db.prepare('UPDATE v8_tickets SET session_ref=NULL WHERE id=?').run(ticketId);
      const id = this.newAssignment(ticketId, { urgent: URGENT_BOSS, recovery: false });
      this.insertMessage(ticketId, id, 'system', 'note', RETRY_NOTE);
      return id;
    });
  }

  // ---------- slots and dispatch ----------

  setSlots(slots: SlotConfig[]): void {
    this.tx(() => {
      if (!Array.isArray(slots) || slots.length === 0 || slots.length > 16) throw new Error('V8_SLOTS_INVALID');
      const ids = new Set<string>();
      for (const s of slots) {
        if (!s || typeof s.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(s.id) || ids.has(s.id) || typeof s.label !== 'string' || !s.label.trim()) throw new Error('V8_SLOTS_INVALID');
        ids.add(s.id);
      }
      if (!slots.some(s => !s.emergency)) throw new Error('V8_SLOTS_NEED_ONE_NORMAL');
      const busy = this.db.prepare("SELECT DISTINCT slot_id FROM v8_assignments WHERE status='RUNNING'").pluck().all() as string[];
      if (busy.some(id => !ids.has(id))) throw new Error('V8_SLOT_BUSY');
      this.db.prepare('DELETE FROM v8_slots').run();
      const ins = this.db.prepare('INSERT INTO v8_slots(id,label,model,emergency,position) VALUES(?,?,?,?,?)');
      slots.forEach((s, i) => ins.run(s.id, s.label.trim(), s.model ?? null, s.emergency ? 1 : 0, i));
    });
  }

  /**
   * The boss moves a queued ticket to the front of the ordinary queue. Work the boss spoke to and review rework still
   * go first. Returns the ticket's new queue position (1-based).
   */
  moveToFront(ticketId: number): number {
    return this.tx(() => {
      if (this.state(ticketId) !== 'QUEUED') throw new Error('V8_NOT_QUEUED');
      const lowest = this.db.prepare('SELECT MIN(queue_rank) FROM v8_tickets WHERE end_kind IS NULL').pluck().get() as number | null;
      this.db.prepare('UPDATE v8_tickets SET queue_rank=? WHERE id=?').run((lowest ?? 0) - 1, ticketId);
      const queued = this.db.prepare(`SELECT a.ticket_id FROM v8_assignments a JOIN v8_tickets t ON t.id=a.ticket_id
        WHERE a.status='PENDING' AND t.end_kind IS NULL ${QUEUE_ORDER}`).pluck().all() as number[];
      return queued.indexOf(ticketId) + 1;
    });
  }

  slots(): SlotConfig[] {
    return (this.db.prepare('SELECT * FROM v8_slots ORDER BY position').all() as SlotRow[])
      .map(r => ({ id: r.id, label: r.label, model: r.model, emergency: !!r.emergency }));
  }

  /**
   * Fills free slots and marks those assignments RUNNING. Order: work the boss just spoke to first, then oldest
   * ticket first. The emergency slot only takes work the boss just spoke to.
   */
  nextLaunches(): Launch[] {
    return this.tx(() => {
      const busy = new Set(this.db.prepare("SELECT slot_id FROM v8_assignments WHERE status='RUNNING'").pluck().all() as string[]);
      const free = this.slots().filter(s => !busy.has(s.id));
      const pending = this.db.prepare(`SELECT a.* FROM v8_assignments a JOIN v8_tickets t ON t.id=a.ticket_id
        WHERE a.status='PENDING' AND t.end_kind IS NULL ${QUEUE_ORDER}`).all() as AssignmentRow[];
      const launches: Launch[] = [];
      const now = this.now();
      for (const a of pending) {
        const normal = free.findIndex(s => !s.emergency);
        const i = normal >= 0 ? normal : a.urgent >= URGENT_BOSS ? free.findIndex(s => s.emergency) : -1;
        if (i < 0) continue;
        const slot = free.splice(i, 1)[0];
        this.db.prepare("UPDATE v8_assignments SET status='RUNNING',slot_id=?,started_at=? WHERE id=?").run(slot.id, now, a.id);
        const t = this.ticketRow(a.ticket_id);
        launches.push({ assignmentId: a.id, ticketId: a.ticket_id, slotId: slot.id, sessionRef: t.session_ref, recovery: !!a.recovery });
      }
      return launches;
    });
  }

  // ---------- facts from the shell layer ----------

  /** The shell opened (or reused) the ticket's session. The first session ref sticks for the ticket's life. */
  assignmentStarted(assignmentId: number, sessionRef: string): void {
    this.tx(() => {
      const a = this.assignment(assignmentId);
      if (a.status !== 'RUNNING') throw new Error('V8_ASSIGNMENT_NOT_RUNNING');
      if (typeof sessionRef !== 'string' || !sessionRef.trim() || sessionRef.length > 500) throw new Error('V8_SESSION_REF_INVALID');
      this.db.prepare('UPDATE v8_tickets SET session_ref=COALESCE(session_ref,?) WHERE id=?').run(sessionRef, a.ticket_id);
    });
  }

  /** A gremlin handed in its report. The report ends the assignment and frees the slot. */
  reportReceived(assignmentId: number, input: unknown): TicketState {
    return this.tx(() => {
      const a = this.assignment(assignmentId);
      if (a.status !== 'RUNNING') throw new Error('V8_ASSIGNMENT_NOT_RUNNING');
      const report = validateReport(input);
      this.insertMessage(a.ticket_id, a.id, 'worker', 'report', JSON.stringify(report), this.review && report.kind === 'done' ? 'pending' : 'not_required');
      this.endAssignment(a.id, 'reported');
      return this.state(a.ticket_id);
    });
  }

  /**
   * The account ran out of quota mid-assignment (v8 计划书 S2). Not a failure: the assignment ends without a report and
   * the ticket waits (等额度) until the quota is back, the boss switches account or model, or says something to it.
   * `resetsAt` is when the provider said the quota is back (ms), if it said.
   */
  assignmentOutOfQuota(assignmentId: number, info: { resetsAt: number | null; detail: string; byBoss?: boolean }): TicketState {
    return this.tx(() => {
      const a = this.assignment(assignmentId);
      if (a.status !== 'RUNNING') throw new Error('V8_ASSIGNMENT_NOT_RUNNING');
      const detail = (info.detail || tr('额度用完')).trim().slice(0, 500);
      const resets = info.resetsAt !== null && Number.isSafeInteger(info.resetsAt) && info.resetsAt > 0 ? info.resetsAt : null;
      this.endAssignment(a.id, 'exited');
      this.db.prepare('INSERT INTO v8_quota_waits(ticket_id,assignment_id,resets_at,detail,created_at) VALUES(?,?,?,?,?)').run(a.ticket_id, a.id, resets, detail, this.now());
      this.insertMessage(a.ticket_id, a.id, 'system', 'note', (info.byBoss ? PARK_NOTE : QUOTA_NOTE) + detail);
      return this.state(a.ticket_id);
    });
  }

  /** When the open quota wait of a ticket ends, learned after the fact (from the maker's quota page). */
  setQuotaReset(ticketId: number, resetsAt: number): void {
    if (!Number.isSafeInteger(resetsAt) || resetsAt <= 0) throw new Error('V8_ARGUMENT');
    this.db.prepare('UPDATE v8_quota_waits SET resets_at=? WHERE ticket_id=? AND resolved_at IS NULL AND resets_at IS NULL').run(resetsAt, ticketId);
  }

  /** Tickets waiting for quota, oldest first. */
  quotaWaits(): QuotaWait[] {
    return (this.db.prepare(`SELECT w.ticket_id,w.assignment_id,w.created_at,w.resets_at,w.detail FROM v8_quota_waits w JOIN v8_tickets t ON t.id=w.ticket_id
      WHERE w.resolved_at IS NULL AND t.end_kind IS NULL ORDER BY w.id`).all() as Array<{ ticket_id: number; assignment_id: number; created_at: number; resets_at: number | null; detail: string }>)
      .map(w => ({ ticketId: w.ticket_id, assignmentId: w.assignment_id, since: w.created_at, resetsAt: w.resets_at, detail: w.detail }));
  }

  /** A ticket waiting for quota goes on: same session, same directory, ahead of ordinary work. */
  resumeFromQuota(ticketId: number, how: QuotaResume): number {
    return this.tx(() => {
      if (this.state(ticketId) !== 'WAITING_QUOTA') throw new Error('V8_NOT_WAITING_QUOTA');
      this.db.prepare('UPDATE v8_quota_waits SET resolved_how=? WHERE ticket_id=? AND resolved_at IS NULL').run(how, ticketId);
      const id = this.newAssignment(ticketId, { urgent: how === 'reset' ? URGENT_REWORK : URGENT_BOSS, recovery: false });
      this.insertMessage(ticketId, id, 'system', 'note', RESUME_NOTE[how]);
      return id;
    });
  }

  /**
   * The running assignment of a ticket ends so the work goes on at once in a new one, on the same session: the boss
   * changed its model or effort while it worked (v8 第 4 步). Returns the new assignment, or null if nothing was
   * running. The caller closes the old session first.
   */
  restartRunning(ticketId: number, how: 'model' | 'effort'): { ended: number; next: number } | null {
    return this.tx(() => {
      const ended = this.runningAssignment(ticketId);
      if (ended === null) return null;
      this.endAssignment(ended, 'restart');
      const next = this.newAssignment(ticketId, { urgent: URGENT_BOSS, recovery: false });
      this.insertMessage(ticketId, next, 'system', 'note', RESUME_NOTE[how]);
      return { ended, next };
    });
  }

  /** The running assignment of a ticket, if any. */
  runningAssignment(ticketId: number): number | null {
    const a = this.db.prepare("SELECT id FROM v8_assignments WHERE ticket_id=? AND status='RUNNING' ORDER BY id DESC LIMIT 1").get(ticketId) as { id: number } | undefined;
    return a?.id ?? null;
  }

  /** Pin a ticket's sessions to a model, an effort and/or an account; null clears that part. Applies from its next session. */
  setTicketSupply(ticketId: number, s: Partial<TicketSupply>): void {
    this.tx(() => {
      this.ticketRow(ticketId);
      const now = this.ticketSupply(ticketId);
      const next = { model: s.model !== undefined ? s.model : now.model, account: s.account !== undefined ? s.account : now.account, effort: s.effort !== undefined ? s.effort : now.effort };
      for (const v of [next.model, next.account, next.effort]) if (v !== null && (typeof v !== 'string' || !/^[!-~]{1,200}$/.test(v))) throw new Error('V8_SUPPLY_OVERRIDE_INVALID');
      this.db.prepare('INSERT INTO v8_ticket_supply(ticket_id,model,account,effort,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(ticket_id) DO UPDATE SET model=excluded.model,account=excluded.account,effort=excluded.effort,updated_at=excluded.updated_at')
        .run(ticketId, next.model, next.account, next.effort, this.now());
    });
  }

  ticketSupply(ticketId: number): TicketSupply {
    const r = this.db.prepare('SELECT model,account,effort FROM v8_ticket_supply WHERE ticket_id=?').get(ticketId) as TicketSupply | undefined;
    return r ?? { model: null, account: null, effort: null };
  }

  /** The session ended without a report (crash, kill, timeout). Recorded as a failure so it reaches the boss. */
  assignmentExited(assignmentId: number, detail: string): TicketState | null {
    return this.tx(() => {
      const a = this.assignment(assignmentId);
      if (a.status !== 'RUNNING') return null;
      const reason = tr('小怪没交报告就停了：') + (typeof detail === 'string' && detail.trim() ? detail.trim().slice(0, 500) : tr('原因未知'));
      this.insertMessage(a.ticket_id, a.id, 'system', 'report', JSON.stringify({ kind: 'failed', reason } satisfies Report), 'not_required');
      this.endAssignment(a.id, 'exited');
      return this.state(a.ticket_id);
    });
  }

  /**
   * After the app restarts nothing is running any more. Every assignment that was RUNNING is marked interrupted and
   * a recovery assignment is queued for it, oldest ticket first; its first message tells the gremlin to check the
   * directory and history before repeating anything.
   */
  recoverAfterRestart(): number[] {
    return this.tx(() => {
      const running = this.db.prepare(`SELECT a.* FROM v8_assignments a JOIN v8_tickets t ON t.id=a.ticket_id
        WHERE a.status='RUNNING' ORDER BY t.created_at, t.id`).all() as AssignmentRow[];
      const now = this.now();
      const fresh: number[] = [];
      for (const a of running) {
        this.db.prepare("UPDATE v8_assignments SET status='INTERRUPTED',ended_at=?,end_reason='restart' WHERE id=?").run(now, a.id);
        this.insertMessage(a.ticket_id, a.id, 'system', 'note', tr('应用重启，这次派工被打断了'));
        fresh.push(this.newAssignment(a.ticket_id, { urgent: URGENT_NONE, recovery: true }));
      }
      return fresh;
    });
  }

  // ---------- review ----------

  /** "Done" reports waiting for the review gremlin: the newest report of a ticket that is still open. */
  pendingReviews(): Array<{ ticketId: number; reportMessageId: number; report: Report }> {
    const rows = this.db.prepare(`SELECT m.id,m.ticket_id,m.body FROM v8_messages m JOIN v8_tickets t ON t.id=m.ticket_id
      WHERE m.kind='report' AND m.review='pending' AND t.end_kind IS NULL
        AND m.assignment_id=(SELECT MAX(id) FROM v8_assignments WHERE ticket_id=m.ticket_id) ORDER BY m.id`).all() as Array<{ id: number; ticket_id: number; body: string }>;
    return rows.map(r => ({ ticketId: r.ticket_id, reportMessageId: r.id, report: JSON.parse(r.body) as Report }));
  }

  /**
   * The review gremlin's verdict on one "done" report. Pass: the boss sees it. Fail: back to the same gremlin with
   * the reason, until it has failed MAX_REVIEW_REJECTIONS times; then the boss decides. A verdict on a report that is
   * no longer the ticket's newest (the boss spoke meanwhile, or stopped it) is ignored.
   */
  recordReview(reportMessageId: number, input: unknown): 'passed' | 'rejected' | 'escalated' | 'stale' {
    return this.tx(() => {
      const v = validateReview(input);
      const m = this.message(reportMessageId);
      if (m.kind !== 'report' || m.ticket_id === null) throw new Error('V8_NOT_A_REPORT');
      const latest = this.db.prepare('SELECT MAX(id) FROM v8_assignments WHERE ticket_id=?').pluck().get(m.ticket_id) as number;
      if (m.review !== 'pending' || m.assignment_id !== latest || this.ticketRow(m.ticket_id).end_kind) return 'stale';
      const verdict = v.verdict === 'pass' ? 'passed' : 'rejected';
      this.db.prepare('INSERT INTO v8_reviews(ticket_id,report_message_id,verdict,reason,checks_json,created_at) VALUES(?,?,?,?,?,?)')
        .run(m.ticket_id, m.id, verdict, v.reason, JSON.stringify(v.checks), this.now());
      this.db.prepare('UPDATE v8_messages SET review=? WHERE id=?').run(verdict, m.id);
      if (verdict === 'passed') return 'passed';
      const rejections = this.db.prepare("SELECT COUNT(*) FROM v8_reviews WHERE ticket_id=? AND verdict='rejected'").pluck().get(m.ticket_id) as number;
      if (rejections >= MAX_REVIEW_REJECTIONS) {
        this.insertMessage(m.ticket_id, null, 'system', 'note', tr('审查打回了 {0} 次，交给老板决定：{1}', [rejections, v.reason]));
        return 'escalated';
      }
      const id = this.newAssignment(m.ticket_id, { urgent: URGENT_REWORK, recovery: false });
      this.insertMessage(m.ticket_id, id, 'system', 'note', REVIEW_NOTE + v.reason);
      return 'rejected';
    });
  }

  /**
   * The review gremlin gave no verdict (its session failed or it never answered). The work goes to the boss
   * unreviewed, with a note saying so: never left waiting, never passed silently.
   */
  skipReview(reportMessageId: number, why: string): boolean {
    return this.tx(() => {
      const m = this.message(reportMessageId);
      if (m.kind !== 'report' || m.ticket_id === null || m.review !== 'pending') return false;
      this.db.prepare("UPDATE v8_messages SET review='not_required' WHERE id=?").run(m.id);
      this.insertMessage(m.ticket_id, null, 'system', 'note', tr('审查没给结论，直接交给老板：') + (why.trim() || tr('原因未知')).slice(0, 300));
      return true;
    });
  }

  /**
   * The boss asks for a review of work that reached them unreviewed (the reviewer could not give a verdict, e.g.
   * it was signed out). Only the newest "done" report of a ticket still open, and only if it has no verdict yet.
   */
  requestReview(ticketId: number): boolean {
    return this.tx(() => {
      const latest = this.db.prepare('SELECT MAX(id) FROM v8_assignments WHERE ticket_id=?').pluck().get(ticketId) as number | null;
      const m = this.db.prepare("SELECT id,body,review FROM v8_messages WHERE ticket_id=? AND kind='report' AND assignment_id=? ORDER BY id DESC LIMIT 1").get(ticketId, latest) as { id: number; body: string; review: string | null } | undefined;
      if (!m || this.ticketRow(ticketId).end_kind || (JSON.parse(m.body) as Report).kind !== 'done' || m.review !== 'not_required') return false;
      if (this.db.prepare('SELECT COUNT(*) FROM v8_reviews WHERE report_message_id=?').pluck().get(m.id)) return false;
      this.db.prepare("UPDATE v8_messages SET review='pending' WHERE id=?").run(m.id);
      this.insertMessage(ticketId, null, 'system', 'note', tr('老板要求重新审一次。'));
      return true;
    });
  }

  /** Review verdicts, newest first: one ticket's, or everything since a moment (the review page's "today"). */
  reviews(o: { ticketId?: number; since?: number } = {}): ReviewRow[] {
    const rows = (o.ticketId !== undefined
      ? this.db.prepare('SELECT * FROM v8_reviews WHERE ticket_id=? ORDER BY id DESC').all(o.ticketId)
      : this.db.prepare('SELECT * FROM v8_reviews WHERE created_at>=? ORDER BY id DESC').all(o.since ?? 0)) as Array<{ id: number; ticket_id: number; report_message_id: number; verdict: 'passed' | 'rejected'; reason: string; checks_json: string; created_at: number }>;
    return rows.map(r => ({ id: r.id, ticketId: r.ticket_id, reportMessageId: r.report_message_id, verdict: r.verdict, reason: r.reason, checks: JSON.parse(r.checks_json), createdAt: r.created_at }));
  }

  // ---------- reads ----------

  state(ticketId: number): TicketState {
    const t = this.ticketRow(ticketId);
    const a = this.db.prepare('SELECT id,status FROM v8_assignments WHERE ticket_id=? ORDER BY id DESC LIMIT 1').get(ticketId) as { id: number; status: AssignmentStatus } | undefined;
    const r = a ? this.db.prepare("SELECT body,review FROM v8_messages WHERE assignment_id=? AND kind='report' ORDER BY id DESC LIMIT 1").get(a.id) as { body: string; review: ReviewVerdict | null } | undefined : undefined;
    const waiting = a ? !!this.db.prepare('SELECT 1 FROM v8_quota_waits WHERE assignment_id=? AND resolved_at IS NULL').get(a.id) : false;
    return ticketState({
      ended: t.end_kind,
      latestAssignment: a ? { id: a.id, status: a.status } : null,
      latestReport: r ? { kind: (JSON.parse(r.body) as Report).kind as ReportKind, review: r.review ?? 'not_required' } : null,
      quotaWait: waiting,
    });
  }

  tickets(): TicketView[] {
    const rows = this.db.prepare('SELECT * FROM v8_tickets ORDER BY created_at, id').all() as TicketRow[];
    const queued = this.db.prepare(`SELECT a.ticket_id FROM v8_assignments a JOIN v8_tickets t ON t.id=a.ticket_id
      WHERE a.status='PENDING' AND t.end_kind IS NULL ${QUEUE_ORDER}`).pluck().all() as number[];
    return rows.map(t => {
      const running = this.db.prepare("SELECT slot_id FROM v8_assignments WHERE ticket_id=? AND status='RUNNING' ORDER BY id DESC LIMIT 1").pluck().get(t.id) as string | undefined;
      const position = queued.indexOf(t.id);
      return {
        id: t.id, title: t.title, originalRequest: t.original_request, routingNote: t.routing_note, state: this.state(t.id),
        createdAt: t.created_at, endedAt: t.ended_at, slotId: running ?? null, queuePosition: position >= 0 ? position + 1 : null,
        quotaWait: this.openWait(t.id),
      };
    });
  }

  ticket(id: number): TicketView {
    const v = this.tickets().find(t => t.id === id);
    if (!v) throw new Error('V8_TICKET_NOT_FOUND');
    return v;
  }

  /** The text of one of the boss's talk-bar or ticket messages; refuses anything else. */
  bossMessage(id: number): string {
    const m = this.message(id);
    if (m.author !== 'boss' || m.kind !== 'say') throw new Error('V8_NEEDS_BOSS_MESSAGE');
    return m.body;
  }

  /** What a new assignment must carry: the boss's messages that rode along with it, and whether it is a retry. */
  assignmentContext(assignmentId: number): { ticketId: number; riders: string[]; retry: boolean; recovery: boolean; reviewNotes: string[]; resumed: boolean } {
    const a = this.assignment(assignmentId);
    const rows = this.db.prepare("SELECT author,kind,body FROM v8_messages WHERE assignment_id=? AND kind IN ('say','note') ORDER BY id").all(assignmentId) as Pick<MessageRow, 'author' | 'kind' | 'body'>[];
    return {
      ticketId: a.ticket_id,
      riders: rows.filter(r => r.author === 'boss').map(r => r.body),
      retry: rows.some(r => r.author === 'system' && r.body === RETRY_NOTE),
      reviewNotes: rows.filter(r => r.author === 'system' && r.body.startsWith(REVIEW_NOTE)).map(r => r.body.slice(REVIEW_NOTE.length)),
      recovery: !!a.recovery,
      resumed: rows.some(r => r.author === 'system' && RESUME_NOTES.has(r.body)),
    };
  }

  /** The newest report on a ticket, if any. */
  latestReport(ticketId: number): Report | null {
    const r = this.db.prepare("SELECT body FROM v8_messages WHERE ticket_id=? AND kind='report' ORDER BY id DESC LIMIT 1").pluck().get(ticketId) as string | undefined;
    return r ? JSON.parse(r) as Report : null;
  }

  /**
   * The talk bar (ticketId null): what the boss said to the lead, and everything the lead said to the boss, including
   * lines about one ticket. Or one ticket's full history. Oldest first.
   */
  messages(ticketId: number | null, limit = 200): V8Message[] {
    const rows = (ticketId === null
      ? this.db.prepare("SELECT * FROM v8_messages WHERE (ticket_id IS NULL AND author='boss') OR (author='lead' AND kind='say') ORDER BY id DESC LIMIT ?").all(limit)
      : this.db.prepare('SELECT * FROM v8_messages WHERE ticket_id=? ORDER BY id DESC LIMIT ?').all(ticketId, limit)) as MessageRow[];
    return rows.reverse().map(m => ({
      id: m.id, ticketId: m.ticket_id, assignmentId: m.assignment_id, author: m.author, kind: m.kind,
      body: m.kind === 'report' ? JSON.parse(m.body) as Report : m.body, createdAt: m.created_at,
    }));
  }

  // ---------- internals ----------

  private tx<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }

  private say(text: string): string {
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_SAY) throw new Error('V8_TEXT_INVALID');
    return text;
  }

  private insertMessage(ticketId: number | null, assignmentId: number | null, author: V8Message['author'], kind: V8Message['kind'], body: string, review: ReviewVerdict | null = null): number {
    return Number(this.db.prepare(`INSERT INTO v8_messages(ticket_id,assignment_id,author,kind,body,review,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(ticketId, assignmentId, author, kind, body, review, this.now()).lastInsertRowid);
  }

  private newAssignment(ticketId: number, o: { urgent: number; recovery: boolean }): number {
    // Any new assignment (a boss message, a retry, a resume) ends a quota wait: the ticket is moving again.
    this.db.prepare("UPDATE v8_quota_waits SET resolved_at=?,resolved_how=COALESCE(resolved_how,'superseded') WHERE ticket_id=? AND resolved_at IS NULL").run(this.now(), ticketId);
    return Number(this.db.prepare("INSERT INTO v8_assignments(ticket_id,status,urgent,recovery,created_at) VALUES(?,'PENDING',?,?,?)")
      .run(ticketId, o.urgent, o.recovery ? 1 : 0, this.now()).lastInsertRowid);
  }

  private openWait(ticketId: number): { since: number; resetsAt: number | null } | null {
    const w = this.db.prepare('SELECT created_at,resets_at FROM v8_quota_waits WHERE ticket_id=? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1').get(ticketId) as { created_at: number; resets_at: number | null } | undefined;
    return w ? { since: w.created_at, resetsAt: w.resets_at } : null;
  }

  private endAssignment(id: number, reason: AssignmentEnd): void {
    this.db.prepare("UPDATE v8_assignments SET status='ENDED',ended_at=?,end_reason=? WHERE id=?").run(this.now(), reason, id);
  }

  /**
   * A boss message on a ticket. Running: steer the live session. Already waiting in line: ride along with that
   * assignment. Otherwise (answered question, reply to a failure, a finished ticket reopened): a new assignment
   * that may use the emergency slot.
   */
  private deliver(ticketId: number, body: string): Delivery {
    const t = this.ticketRow(ticketId);
    if (t.end_kind === 'stopped') throw new Error('V8_TICKET_STOPPED');
    if (t.end_kind === 'done') {
      this.db.prepare('UPDATE v8_tickets SET ended_at=NULL,end_kind=NULL WHERE id=?').run(ticketId);
      this.insertMessage(ticketId, null, 'system', 'note', tr('老板的新消息重新打开了这张工单'));
    }
    const live = this.db.prepare("SELECT id,status FROM v8_assignments WHERE ticket_id=? AND status IN ('RUNNING','PENDING') ORDER BY id DESC LIMIT 1")
      .get(ticketId) as { id: number; status: AssignmentStatus } | undefined;
    if (live?.status === 'RUNNING') {
      this.insertMessage(ticketId, live.id, 'boss', 'say', body);
      return { kind: 'steer', assignmentId: live.id };
    }
    if (live) {
      this.db.prepare('UPDATE v8_assignments SET urgent=? WHERE id=?').run(URGENT_BOSS, live.id);
      this.insertMessage(ticketId, live.id, 'boss', 'say', body);
      return { kind: 'queued', assignmentId: live.id };
    }
    const id = this.newAssignment(ticketId, { urgent: URGENT_BOSS, recovery: false });
    this.insertMessage(ticketId, id, 'boss', 'say', body);
    return { kind: 'queued', assignmentId: id };
  }

  private ticketRow(id: number): TicketRow {
    const t = this.db.prepare('SELECT * FROM v8_tickets WHERE id=?').get(id) as TicketRow | undefined;
    if (!t) throw new Error('V8_TICKET_NOT_FOUND');
    return t;
  }

  private assignment(id: number): AssignmentRow {
    const a = this.db.prepare('SELECT * FROM v8_assignments WHERE id=?').get(id) as AssignmentRow | undefined;
    if (!a) throw new Error('V8_ASSIGNMENT_NOT_FOUND');
    return a;
  }

  private message(id: number): MessageRow {
    const m = this.db.prepare('SELECT * FROM v8_messages WHERE id=?').get(id) as MessageRow | undefined;
    if (!m) throw new Error('V8_MESSAGE_NOT_FOUND');
    return m;
  }
}
