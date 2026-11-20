/**
 * The ticket-level line of defence (v8 计划书 S2), pure helpers.
 *
 * The first line is Magpie: a refused request is retried on another account or fallback model and the gremlin never
 * notices. Only when Magpie has nothing left does a refusal reach the harness and end the turn with an error. Then:
 *   - quotaRefusal tells a quota/rate refusal from any other error, and reads when the quota is back if it was said;
 *   - probeLive is the three-state probe of v7 (executionProbe.ts), driven by structured events instead of terminal
 *     output: ACTIVE, SUSPECT_SILENT (only a warning, never kills), CONFIRMED_STALLED (past the hard limit).
 */

const QUOTA = /\b429\b|quota|rate.?limit|usage.?limit|insufficient_quota|too many requests|overloaded|额度|限流/i;

/** A quota or rate refusal, with when it resets (ms since epoch) if the error said so; null for any other error. */
export function quotaRefusal(detail: string | undefined | null, now = Date.now()): { resetsAt: number | null } | null {
  const text = String(detail ?? '');
  if (!QUOTA.test(text)) return null;
  // Our own connection writes "resets=<unix seconds>" (from X-Magpie-Resets-At or Retry-After); providers often
  // say "try again in N seconds/minutes".
  const unix = /resets=(\d{9,11})\b/.exec(text);
  if (unix) return { resetsAt: Number(unix[1]) * 1000 };
  const rel = /(?:try again|retry|resets?) in (\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)\b/i.exec(text);
  if (rel) {
    const n = Number(rel[1]), unit = rel[2].toLowerCase();
    const ms = unit.startsWith('h') ? n * 3_600_000 : unit.startsWith('m') ? n * 60_000 : n * 1000;
    return { resetsAt: now + Math.round(ms) };
  }
  return { resetsAt: null };
}

export type ProbeStatus = 'ACTIVE' | 'SUSPECT_SILENT' | 'CONFIRMED_STALLED';
export interface ProbeLimits {
  /** Quiet this long while alive: a yellow warning only (v7: 3 minutes). */
  silentMs: number;
  /** One assignment running this long is stopped and handed to the boss (v7: 90 minutes). */
  hardMs: number;
}
export const PROBE_DEFAULTS: ProbeLimits = { silentMs: 3 * 60_000, hardMs: 90 * 60_000 };

/** Same rules as v7's executionProbe, on event times. A dead process is reported by the shell itself. */
export function probeLive(now: number, startedAt: number, lastEventAt: number, limits: ProbeLimits = PROBE_DEFAULTS): { status: ProbeStatus; reason: string } {
  if (now - startedAt >= limits.hardMs) return { status: 'CONFIRMED_STALLED', reason: 'hard-limit' };
  if (now - Math.max(startedAt, lastEventAt) >= limits.silentMs) return { status: 'SUSPECT_SILENT', reason: 'silent' };
  return { status: 'ACTIVE', reason: 'recent-activity' };
}
