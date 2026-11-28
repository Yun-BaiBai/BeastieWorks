import { tr } from '../../shared/i18n';
import type { SlotConfig, TicketView } from './tickets';

/**
 * What the dispatch board (the global view) shows. Built in main from the scheduler and the live activity stream
 * (F4); F2 fills it with sample data. Everything on screen comes from here: no decoration that is not data.
 */

/** The five steps a slot card shows, in order. */
/** The same five steps for any kind of work (A7): code, writing, pictures, video. */
export const WORK_STEPS = [tr('摸底'), tr('想做法'), tr('动手'), tr('验证'), tr('交报告')] as const;

export interface BoardSlot {
  slot: SlotConfig;
  /** Display order among slots, 0-based; picks the gremlin (grunt, tri, grunt, …). */
  order: number;
  /** The gremlin the boss picked for this desk (requirement 61). Unset: by order. */
  look?: string;
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
  if (sure === 'partial') return usd > 0 ? tr('至少 ') + n : tr('未知');
  return sure === 'estimated' ? tr('约 ') + n : n;
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
  harness: { kind: 'fake' | 'acp'; label: string };
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
  /** 圆桌会议 still going or waiting for the boss's pick (A6). */
  roundtables: RoundtableView[];
  /** 工序链 (A15) still going. */
  chains: ChainView[];
  /** 拆解 (A12) being worked out or waiting for the boss. */
  splits: SplitView[];
  /** A gremlin waiting for the boss to allow one of the boss's own connector tools (老板 2026-11-28). */
  asks: ToolAsk[];
}

/** One connector tool a working gremlin asked to use, waiting for the boss. */
export interface ToolAsk {
  id: string;
  ticketId: number;
  title: string;
  /** The connector, as people say it (Notion), and the tool (notion-fetch). */
  server: string;
  tool: string;
  full: string;
  /** Its name says it changes something (create, update, delete…). */
  writes: boolean;
  since: number;
}

/** One of the two plans the lead sorted the proposals into. */
export interface RoundtablePlan { title: string; summary: string; from?: string }

/**
 * 圆桌会议 (A6): proposing (agents writing, each on its own), merging (the lead sorting them into Plan A / B),
 * choosing (the boss picks), then picked or failed.
 */
export interface RoundtableView {
  id: number;
  title: string;
  request: string;
  state: 'proposing' | 'merging' | 'choosing' | 'picked' | 'failed';
  messageId: number;
  createdAt: number;
  proposals: Array<{ agent: string; ok: boolean; title: string | null; why: string | null }>;
  plans?: { a: RoundtablePlan; b: RoundtablePlan; recommended: 'A' | 'B'; note: string };
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
  /** other: the roster page's chats and skill retelling, outside any ticket. */
  bySource: { gremlins: number; lead: number; review: number; other: number };
  byTicket: Array<{ id: number; title: string; state: import('./tickets').TicketState; costUsd: number; elapsedMs: number }>;
  /** Hard cap per session, if any, so the jar can show how full "full" is. */
  capUsd: number | null;
}

/** 档案柜: every ticket of the project, with how it ended. */
export interface ArchiveItem { id: number; title: string; originalRequest: string; state: import('./tickets').TicketState; createdAt: number; endedAt: number | null; outcome: string | null }

/** 时间线: one ticket's story, oldest first. */
export interface TimelineItem { id: string; at: number | null; who: 'boss' | 'lead' | 'gremlin' | 'review' | 'system'; kind: string; text: string }

/** One 工序链 (A15): stages done one after another, each an ordinary ticket. */
export interface ChainView {
  id: number;
  title: string;
  /** The boss's words, whole. */
  request: string;
  stages: Array<{ title: string; what: string; ticketId: number | null; state: import('./tickets').TicketState | null }>;
  /** The stage the boss may start now (the one before it was accepted), or null. */
  next: number | null;
  finished: boolean;
}

/** One 拆解 (A12): a big job and the pieces a gremlin proposes, for the boss to approve. */
export interface SplitView {
  id: number;
  title: string;
  request: string;
  state: 'splitting' | 'choosing' | 'started';
  /** The agent that worked out the split. */
  by: string;
  canSplit: boolean;
  why: string;
  pieces: Array<{ title: string; what: string }>;
}
