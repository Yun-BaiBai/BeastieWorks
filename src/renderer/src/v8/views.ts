import { flushSync } from 'react-dom';

/** Where the workbench is: the board, or one local page. */
export type View =
  | { kind: 'board' }
  | { kind: 'slot'; slotId: string }
  | { kind: 'lead' }
  | { kind: 'delivery'; ticketId: number }
  | { kind: 'queue' }
  | { kind: 'review' }
  | { kind: 'ledger' }
  | { kind: 'archive' }
  | { kind: 'timeline'; ticketId: number }
  | { kind: 'crew' }
  | { kind: 'agents' }
  | { kind: 'skills' }
  | { kind: 'notes' }
  | { kind: 'setup' };

/** The board element a page was opened from, so its gremlin can fly back there. */
export type HeroKey = string;

/** Opens a local page from a door on the board. */
export type Door = (view: View, from: HeroKey | null) => void;

export const HERO_NAME = 'v8-hero';

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** The page just put in eases in; the top bar and the notice stay put. */
function easeIn(): void {
  const canvas = document.querySelector('.v8-canvas');
  if (!canvas) return;
  for (const el of canvas.querySelectorAll(':scope > :not(.v8-top):not(.v8-notice)')) {
    el.animate([{ opacity: 0, translate: '0 14px' }, { opacity: 1, translate: '0 0' }], { duration: 300, easing: 'cubic-bezier(.2, .9, .2, 1)' });
  }
}

/**
 * Change pages with the gremlin flying between them (View Transitions). `name(where)` says which side carries the
 * hero name: the old page's element is captured first, then React commits the new page synchronously inside the
 * transition callback and the new page's hero is captured. Without support (or with reduced motion) it just
 * switches.
 */
export function transition(change: () => void, name: (where: 'old' | 'new' | null) => void, fly = true): void {
  if (!document.startViewTransition || reduced()) { flushSync(() => { change(); name(null); }); return; }
  // A3 (老板 2026-11-20 "换页一顿"): a view transition first pictures the whole window, which takes 45–60ms on an
  // integrated GPU even when nothing changes. Like OpenMausBot (view transitions only for rare moments), only a
  // gremlin flying between the board and its page pays that; the top bar's page buttons switch at once and the new
  // page eases in on the GPU (opacity and translate only, the same motion as v8-vin in v8.css).
  if (!fly) { flushSync(() => { change(); name(null); }); easeIn(); return; }
  flushSync(() => name('old'));
  const t = document.startViewTransition(() => { flushSync(() => { change(); name('new'); }); });
  void t.finished.finally(() => flushSync(() => name(null)));
}
