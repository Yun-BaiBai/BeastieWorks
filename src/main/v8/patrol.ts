import { tr } from '../../shared/i18n';
import type { HostTool } from './shell';

/**
 * 巡查 (A11, requirement 40: "转一圈看哪个 bot 卡住了、跑偏了、压垮了"). 卡住 is the dispatcher's three-state probe
 * (hotswap.ts probeLive). This file holds the other two:
 *   压垮 — a running ticket has spent far more time or money than finished ones usually do. Counted, no model.
 *   跑偏 — what the gremlin is doing has little to do with the boss's words. Judged by a model glancing at its last
 *          actions (boss's answer 2026-11-20: worth a little quota), only for work that has run a while.
 * Both only warn the boss; neither stops the work.
 */

export const PATROL_DEFAULTS = {
  /** How often the patrol goes round. */
  everyMs: 60_000,
  /** 压垮: this many times the usual, with at least this many finished tickets to compare with. */
  overloadTimes: 3, minPeers: 3,
  /** …and not for small amounts: at least this long, or this much money. */
  overloadMinMs: 10 * 60_000, overloadMinUsd: 0.05,
  /** 跑偏: first glance after this long at work, then again every this long. */
  glanceAfterMs: 15 * 60_000, glanceEveryMs: 15 * 60_000,
};
export type PatrolLimits = typeof PATROL_DEFAULTS;

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** 压垮: how a running ticket compares with finished ones. Null when it is within bounds or there is too little to go by. */
export function overload(
  running: { elapsedMs: number; costUsd: number },
  finished: Array<{ elapsedMs: number; costUsd: number }>,
  limits: PatrolLimits = PATROL_DEFAULTS,
): { what: 'time' | 'money'; times: number; usual: number; now: number } | null {
  if (finished.length < limits.minPeers) return null;
  const usualMs = median(finished.map(f => f.elapsedMs));
  if (usualMs > 0 && running.elapsedMs >= limits.overloadMinMs && running.elapsedMs >= usualMs * limits.overloadTimes) {
    return { what: 'time', times: running.elapsedMs / usualMs, usual: usualMs, now: running.elapsedMs };
  }
  const usualUsd = median(finished.map(f => f.costUsd));
  if (usualUsd > 0 && running.costUsd >= limits.overloadMinUsd && running.costUsd >= usualUsd * limits.overloadTimes) {
    return { what: 'money', times: running.costUsd / usualUsd, usual: usualUsd, now: running.costUsd };
  }
  return null;
}

export function overloadWords(o: NonNullable<ReturnType<typeof overload>>): string {
  const n = o.times >= 10 ? Math.round(o.times) : Math.round(o.times * 10) / 10;
  return o.what === 'time'
    ? tr('干了 {0} 分钟，同类的活一般 {1} 分钟，多了 {2} 倍，还在干', [Math.round(o.now / 60_000), Math.max(1, Math.round(o.usual / 60_000)), n])
    : tr('花了 ${0}，同类的活一般 ${1}，多了 {2} 倍，还在干', [o.now.toFixed(2), o.usual.toFixed(2), n]);
}

export const GLANCE_TOOL: HostTool = {
  name: 'submit_patrol',
  description: '交巡查结论，只交一次。',
  parameters: {
    type: 'object',
    properties: {
      on_track: { type: 'boolean', description: '它干的是不是老板要的那件事' },
      reason: { type: 'string', description: '一句话：为什么这么判断。跑偏时说偏到哪去了' },
    },
    required: ['on_track', 'reason'],
  },
};

export const GLANCE_SYSTEM = [
  '你是小怪工坊的巡查。你只看一眼：一只正在干活的小怪，干的还是不是老板要的那件事。',
  '你只拿到老板的原话和它最近的动作。为了弄清现状去读文件、查资料，都算在干正事；只有明显在做和原话无关的事，才算跑偏。拿不准就算没跑偏。',
  '调用 submit_patrol 交结论，只交一次，然后结束。',
].join('\n');

export const GLANCE_NUDGE = '你还没有调用 submit_patrol。现在交结论：on_track 和一句理由。';

export function glanceBrief(o: { request: string; routingNote: string | null; minutes: number; actions: string[]; files: string[] }): string {
  return [
    '老板的原话：', o.request,
    ...(o.routingNote ? ['', '总管备注：' + o.routingNote] : []),
    '', `它已经干了 ${o.minutes} 分钟。最近的动作（新的在前）：`, ...(o.actions.length ? o.actions.map(a => '- ' + a) : ['（还没有动作）']),
    ...(o.files.length ? ['', '动过的文件：' + o.files.join('、')] : []),
  ].join('\n');
}

export function acceptGlance(raw: unknown): { onTrack: boolean; reason: string } {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof a.on_track !== 'boolean') throw new Error(tr('on_track 要填 true 或 false'));
  if (typeof a.reason !== 'string' || !a.reason.trim()) throw new Error(tr('reason 不能空着'));
  return { onTrack: a.on_track, reason: a.reason.trim().slice(0, 200) };
}
