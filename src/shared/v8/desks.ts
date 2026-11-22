import type { V8Desk, V8QuotaPlan, V8QuotaRule, V8Settings } from './settings';

/** At most this many desks (老板 2026-11-21: 最多 8 个). */
export const MAX_DESKS = 8;
/** At most this many backup models per desk (OpenMausBot's FallbackChain keeps five). */
export const MAX_BACKUPS = 5;

/** The old single rule (one for every gremlin) as a plan: switch to its one model. */
export function planOf(rule: V8QuotaRule | undefined): V8QuotaPlan | undefined {
  if (!rule) return undefined;
  if (rule.do !== 'switch' || !rule.model) return { do: 'wait' };
  return { do: 'switch', backups: [{ model: rule.model, ...(rule.effort ? { effort: rule.effort } : {}) }] };
}

/**
 * The desks as the boss set them, or, before he set any, the old way: `slots` desks, each the `acp.worker` role with
 * the one `onQuota` rule, so nothing he set before is lost (方案第 4 点). Ids are stable: 'slot-1' … as before, so tickets
 * running at a desk keep it. Never more than MAX_DESKS, never none.
 */
export function desksOf(s: V8Settings | undefined): V8Desk[] {
  const set = Array.isArray(s?.desks) ? s!.desks.filter(d => d && typeof d.id === 'string' && /^[a-z0-9-]{1,32}$/.test(d.id) && typeof d.agent === 'string') : [];
  if (set.length) return set.slice(0, MAX_DESKS);
  const n = Math.max(1, Math.min(MAX_DESKS, Math.floor(s?.slots ?? 2)));
  const w = s?.acp?.worker;
  const plan = planOf(s?.onQuota);
  return Array.from({ length: n }, (_, i): V8Desk => ({
    id: 'slot-' + (i + 1), agent: w?.agent ?? 'demo',
    ...(w?.model ? { model: w.model } : {}), ...(w?.effort ? { effort: w.effort } : {}),
    ...(plan ? { onQuota: plan } : {}),
  }));
}

/** A new desk's id: the first 'slot-N' not taken. */
export function newDeskId(desks: V8Desk[]): string {
  for (let i = 1; ; i++) if (!desks.some(d => d.id === 'slot-' + i)) return 'slot-' + i;
}

/** The desk's name on the board: the boss's, or 工位 0N by position. */
export function deskLabel(d: V8Desk, position: number, numbered: (n: string) => string): string {
  return d.name?.trim() || numbered(String(position + 1).padStart(2, '0'));
}

/**
 * The backup to go on with when the account runs out on `model`: the one after it in the plan, or (when it is on none of
 * them) the first that differs from it. Null: wait (the plan says so, or every backup is used up).
 */
export function nextBackup(plan: V8QuotaPlan | undefined, model: string | null, effort: string | null): { model: string; effort?: string } | null {
  if (plan?.do !== 'switch') return null;
  const backups = (plan.backups ?? []).filter(b => b && b.model).slice(0, MAX_BACKUPS);
  const at = backups.findIndex(b => b.model === model && (!b.effort || b.effort === effort));
  const next = at >= 0 ? backups[at + 1] : backups.find(b => b.model !== model || (!!b.effort && b.effort !== effort));
  return next ?? null;
}
