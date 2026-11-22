/**
 * v8 tickets: shared types for the scheduler (main) and the dispatch board (renderer).
 * Spec: work/claude-v8-direction-20261113/v8-规范.md, sections 1–3.
 */
import { tr } from '../../shared/i18n';

/** One state per ticket at any moment; see ticketState() for the order the rules are tried in. */
export type TicketState =
  | 'ANSWER'   // 等你回答: the gremlin asked one question and is waiting
  | 'REVIEW'   // 等你看: the gremlin says it is done (or there is nothing to do) and review let it through
  | 'BLOCKED'  // 卡住
  | 'FAILED'   // 失败
  | 'WAITING_QUOTA' // 等额度: the account ran out; it goes on when the quota is back or the boss switches account
  | 'QUEUED'   // 排队: waiting for a free slot
  | 'IDLE'     // 空闲: nothing running and nothing asked of anyone
  | 'WORKING'  // 进行中
  | 'DONE'     // 完成: the boss accepted it
  | 'STOPPED'; // 已停: the boss stopped it

export const TICKET_STATE_LABEL: Readonly<Record<TicketState, string>> = Object.freeze({
  ANSWER: tr('等你回答'), REVIEW: tr('等你看'), BLOCKED: tr('卡住'), FAILED: tr('失败'), WAITING_QUOTA: tr('等额度'), QUEUED: tr('排队'),
  IDLE: tr('空闲'), WORKING: tr('进行中'), DONE: tr('完成'), STOPPED: tr('已停'),
});

/** Every time a gremlin stops it hands in exactly one of these. */
export type ReportKind = 'done' | 'question' | 'blocked' | 'failed' | 'nothing';

export interface DoneReport {
  kind: 'done';
  /** What changed, in a sentence or two. */
  summary: string;
  /** Files touched, relative to the ticket's work directory. */
  changed: string[];
  /** How it was checked. A "done" without real verification output is refused. */
  verification: { command: string; output: string };
}
export interface QuestionReport {
  kind: 'question';
  question: string;
  /** Up to five choices; empty for an open question. */
  options: Array<{ id: string; label: string }>;
  /** The gremlin's pick, one of the option ids. */
  recommended?: string;
}
export interface BlockedReport { kind: 'blocked'; where: string; tried: string }
export interface FailedReport { kind: 'failed'; reason: string }
export interface NothingReport { kind: 'nothing'; reason: string }
export type Report = DoneReport | QuestionReport | BlockedReport | FailedReport | NothingReport;

/**
 * Review of a "done" report. 'rejected' on the newest report means review rejected it the maximum number of times
 * and handed it to the boss; earlier rejections are followed by a new assignment.
 */
export type ReviewVerdict = 'not_required' | 'pending' | 'passed' | 'rejected';

export interface ReviewCheckInput { label: string; ok: boolean; detail: string }
export interface ReviewInput { verdict: 'pass' | 'fail'; reason: string; checks: ReviewCheckInput[] }
export interface ReviewRow { id: number; ticketId: number; reportMessageId: number; verdict: 'passed' | 'rejected'; reason: string; checks: ReviewCheckInput[]; createdAt: number }
/** How many times review may send one ticket back before the boss decides. */
export const MAX_REVIEW_REJECTIONS = 2;

export type AssignmentStatus = 'PENDING' | 'RUNNING' | 'ENDED' | 'INTERRUPTED';
export type AssignmentEnd = 'reported' | 'exited' | 'stopped' | 'restart';

export type MessageAuthor = 'boss' | 'lead' | 'worker' | 'system';

export interface V8Message {
  id: number;
  ticketId: number | null;
  assignmentId: number | null;
  author: MessageAuthor;
  kind: 'say' | 'report' | 'note';
  /** Plain text for 'say' and 'note'; the parsed Report for 'report'. */
  body: string | Report;
  createdAt: number;
}

export interface SlotConfig {
  id: string;
  label: string;
  /** Model the shell is started with; null until a real shell is wired in (B3). */
  model: string | null;
  /** The emergency slot only takes work the boss just spoke to, so his words never wait in line. */
  emergency: boolean;
}

export interface TicketView {
  id: number;
  title: string;
  originalRequest: string;
  routingNote: string;
  state: TicketState;
  createdAt: number;
  endedAt: number | null;
  /** Slot the current assignment runs on, if any. */
  slotId: string | null;
  /** Queue position among QUEUED tickets (1 = next), else null. */
  queuePosition: number | null;
  /** Set while the ticket waits for quota: when the provider said it is back (ms), if it said. */
  quotaWait?: { since: number; resetsAt: number | null } | null;
  /** The desk the boss named for it (requirement 62): it runs there only. Null: any free desk. */
  targetSlot?: string | null;
}

/** What the scheduler hands the shell layer when a slot frees up. */
export interface Launch {
  assignmentId: number;
  ticketId: number;
  slotId: string;
  /** The ticket's existing session, if a previous assignment started one. */
  sessionRef: string | null;
  /** True after a host restart: the first message must say "check the directory and history first". */
  recovery: boolean;
}

/** How a boss message on a ticket reaches the gremlin. */
export type Delivery =
  | { kind: 'steer'; assignmentId: number }   // a gremlin is running: insert it into the live session
  | { kind: 'queued'; assignmentId: number }; // nothing running: a new assignment carries it
