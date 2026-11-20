import type { SlotConfig, TicketView } from './tickets';

/**
 * What the dispatch board (the global view) shows. Built in main from the scheduler and the live activity stream
 * (F4); F2 fills it with sample data. Everything on screen comes from here: no decoration that is not data.
 */

/** The five steps a slot card shows, in order. */
export const WORK_STEPS = ['摸底', '找原因', '改代码', '验证', '交报告'] as const;

export interface BoardSlot {
  slot: SlotConfig;
  /** Display order among slots, 0-based; picks the gremlin (grunt, tri, grunt, …). */
  order: number;
  ticket: TicketView | null;
  /** What the gremlin is doing now, e.g. "edit src/export.ts · 第 42 行". */
  live: string | null;
  /** 'checking' while it runs verification, so the gremlin holds its magnifier. */
  phase: 'working' | 'checking' | null;
  /** Index into WORK_STEPS of the step in progress. */
  step: number;
  startedAt: number | null;
  costUsd: number;
  costSure: CostSure;
  /** True for the moment a report is being handed in: the wire to the lead flows backwards. */
  reporting: boolean;
  /** The few actions before the current one, newest first (live, this run of the app). */
  recent: string[];
}

export interface BoardReview {
  /** Off: done work goes straight to the boss, and the card says so. */
  enabled: boolean;
  passedToday: number;
  lastPassed: string | null;
  /** The ticket being reviewed right now, if any. */
  current: string | null;
}

export type FeedTone = 'slot' | 'question' | 'review' | 'lead' | 'boss';
export interface FeedLine { id: string; at: number; who: string; text: string; tone: FeedTone }

export interface TalkLine {
  id: string;
  author: 'boss' | 'lead';
  text: string;
  /** A gremlin's question passed on by the lead: one tap answers it. */
  question?: { ticketId: number; options: Array<{ id: string; label: string }>; recommended?: string };
}

/**
 * How sure a money figure is. exact: every turn in it was reported in dollars by the agent. estimated: some turns
 * are their tokens at list prices. partial: some turns could not be priced at all, so the real figure is higher.
 */
export type CostSure = 'exact' | 'estimated' | 'partial';

/** The figure as the boss reads it: "$0.12", "约 $0.12", "至少 $0.12", or "未知". */
export function moneyText(usd: number, sure: CostSure): string {
  const n = '$' + usd.toFixed(usd > 0 && usd < 0.1 ? 3 : 2);
  if (sure === 'partial') return usd > 0 ? '至少 ' + n : '未知';
  return sure === 'estimated' ? '约 ' + n : n;
}

/** The least sure of several. */
export function sureOf(bases: Iterable<'reported' | 'estimated' | 'unknown'>): CostSure {
  let sure: CostSure = 'exact';
  for (const b of bases) { if (b === 'unknown') return 'partial'; if (b === 'estimated') sure = 'estimated'; }
  return sure;
}

/** One tick on the ring per event today, coloured by kind, newest last. */
export type RingMark = 'event' | 'waiting' | 'passed' | 'refused';

export interface BoardData {
  project: string;
  /** The lead's name, as the boss set it (requirement 26). */
  leadName: string;
  /** The agent harness the gremlins run in: oh-my-pi with a real model, or the demo cast. */
  harness: { kind: 'omp' | 'fake' | 'acp'; label: string };
  /** Which model the lead and the reviewer run on (null: the harness default). Slots carry their own. */
  agents: { lead: string | null; review: string | null };
  now: number;
  slots: BoardSlot[];
  emergency: BoardSlot | null;
  review: BoardReview;
  /** QUEUED tickets in launch order. */
  queue: TicketView[];
  /** Tickets waiting for quota (等额度), each with when it is back if known. */
  resting: TicketView[];
  /** Tickets waiting for the boss: 等你看, 等你回答, 卡住, 失败. Oldest first. */
  waiting: TicketView[];
  feed: FeedLine[];
  talk: TalkLine[];
  ring: RingMark[];
  /** Tickets finished (accepted) in this project, for the pipeline strip. */
  done: number;
  spentTodayUsd: number;
  spentSure: CostSure;
}

// ---------- local pages (F3) ----------

/** One line of what a gremlin is doing: a tool call, a thought, or something the boss said to it. */
export interface WorkLogLine { id: string; kind: string; text: string }
export interface FileChange { path: string; plus: number; minus: number }

/** 工位: one slot and the ticket on it, in full. */
export interface SlotDetail {
  slot: BoardSlot;
  /** When the boss said the original words. */
  saidAt: number;
  log: WorkLogLine[];
  files: FileChange[];
  /** Which agent the gremlin runs on and the model and effort it uses now (null: the agent's default). */
  tuning?: { agent: string | null; model: string | null; effort: string | null };
  /** The last question the gremlin asked on this ticket, and whether it is still open. */
  question: { text: string; open: boolean } | null;
}

/** 交付: everything needed to accept or send back one finished ticket. */
export interface DeliveryDetail {
  ticketId: number;
  title: string;
  originalRequest: string;
  summary: string;
  files: FileChange[];
  /** Unified diff text; lines start with '+', '-' or a file header. */
  diff: string;
  verification: { command: string; output: string };
  elapsedMs: number;
  costUsd: number;
  costSure: CostSure;
  reviewPassed: boolean;
  /** Why review let it through to the boss without passing it (rejected twice, or gave no verdict). */
  reviewNote: string | null;
  /** Before/after pictures when the gremlin attached them (data URLs). */
  shots: { before: string; after: string } | null;
}

export interface ReviewCheck { label: string; detail: string; ok: boolean }
export interface ReviewRecord { id: string; title: string; ok: boolean; note: string | null; at: number }
/** 审查: how the last result was checked, and today's record. */
export interface ReviewDetail { latest: { title: string; checks: ReviewCheck[] } | null; history: ReviewRecord[] }

// ---------- more local pages ----------

/** 账本: where today's money went. Costs are counted while the app runs (not stored across restarts yet). */
export interface LedgerDetail {
  totalUsd: number;
  totalSure: CostSure;
  /** Gremlins doing the work, the lead talking, the reviewer checking. */
  bySource: { gremlins: number; lead: number; review: number };
  byTicket: Array<{ id: number; title: string; state: import('./tickets').TicketState; costUsd: number; elapsedMs: number }>;
  /** Hard cap per session, if any, so the jar can show how full "full" is. */
  capUsd: number | null;
}

/** 档案柜: every ticket of the project, with how it ended. */
export interface ArchiveItem { id: number; title: string; originalRequest: string; state: import('./tickets').TicketState; createdAt: number; endedAt: number | null; outcome: string | null }

/** 时间线: one ticket's story, oldest first. */
export interface TimelineItem { id: string; at: number | null; who: 'boss' | 'lead' | 'gremlin' | 'review' | 'system'; kind: string; text: string }
