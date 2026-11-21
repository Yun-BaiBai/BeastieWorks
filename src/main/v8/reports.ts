import type { Report, ReviewInput } from '../../shared/v8/tickets';

/** The review gremlin's verdict: pass or fail, one reason, and the three standard checks. */
export function validateReview(input: unknown): ReviewInput {
  const r = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  if ((r.verdict !== 'pass' && r.verdict !== 'fail') || typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > 2000) throw new Error('V8_REVIEW_INVALID');
  if (!Array.isArray(r.checks) || r.checks.length !== 3) throw new Error('V8_REVIEW_INVALID');
  const checks = r.checks.map(c => {
    const x = (c ?? {}) as Record<string, unknown>;
    if (typeof x.label !== 'string' || !x.label.trim() || x.label.length > 100 || typeof x.ok !== 'boolean' || typeof x.detail !== 'string' || x.detail.length > 1000) throw new Error('V8_REVIEW_INVALID');
    return { label: x.label, ok: x.ok, detail: x.detail };
  });
  // A pass with a failed check is not a pass.
  if (r.verdict === 'pass' && checks.some(c => !c.ok)) throw new Error('V8_REVIEW_CONTRADICTS_CHECKS');
  return { verdict: r.verdict, reason: r.reason, checks };
}

const LIMIT = 8000;
const text = (v: unknown, max = LIMIT): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const fail = (): never => { throw new Error('V8_REPORT_INVALID'); };

/**
 * Enforced facts about a report (spec section 3). Returns a clean copy with only the known fields.
 * The one rule that matters most: "done" must carry real verification output. In the 2026-11-13 trial a gremlin
 * that could not run its tests still reported success.
 */
export function validateReport(input: unknown): Report {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail();
  const r = input as Record<string, unknown>;
  switch (r.kind) {
    case 'done': {
      const v = r.verification as Record<string, unknown> | undefined;
      if (!text(r.summary) || !Array.isArray(r.changed) || r.changed.length > 500 || !r.changed.every(p => text(p, 1000))) return fail();
      if (!v || typeof v !== 'object' || !text(v.command, 2000) || !text(v.output)) throw new Error('V8_DONE_NEEDS_VERIFICATION');
      return { kind: 'done', summary: r.summary as string, changed: [...(r.changed as string[])], verification: { command: v.command as string, output: v.output as string } };
    }
    case 'question': {
      const options = r.options ?? [];
      if (!text(r.question, 2000) || !Array.isArray(options) || options.length > 5) return fail();
      const clean = options.map(o => {
        const x = o as Record<string, unknown>;
        if (!x || !text(x.id, 64) || !text(x.label, 200)) return fail();
        return { id: x.id as string, label: x.label as string };
      });
      if (new Set(clean.map(o => o.id)).size !== clean.length) return fail();
      if (r.recommended !== undefined && !clean.some(o => o.id === r.recommended)) return fail();
      return { kind: 'question', question: r.question as string, options: clean, ...(r.recommended !== undefined ? { recommended: r.recommended as string } : {}) };
    }
    case 'blocked':
      if (!text(r.where, 2000) || !text(r.tried)) return fail();
      return { kind: 'blocked', where: r.where as string, tried: r.tried as string };
    case 'failed':
      if (!text(r.reason)) return fail();
      return { kind: 'failed', reason: r.reason as string };
    case 'nothing':
      if (!text(r.reason)) return fail();
      return { kind: 'nothing', reason: r.reason as string };
    default:
      return fail();
  }
}

/** Routing notes stay short: at most 30 words, a CJK character counting as half a word. */
export function routingNoteWords(note: string): number {
  const latin = note.match(/[A-Za-z0-9_.\-/]+/g)?.length ?? 0;
  const cjk = note.match(/[㐀-鿿豈-﫿]/g)?.length ?? 0;
  return latin + Math.ceil(cjk / 2);
}
