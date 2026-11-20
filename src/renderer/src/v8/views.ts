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
  | { kind: 'setup' };

/** The board element a page was opened from, so its gremlin can fly back there. */
export type HeroKey = string;

/** Opens a local page from a door on the board. */
export type Door = (view: View, from: HeroKey | null) => void;

export const HERO_NAME = 'v8-hero';

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * Change pages with the gremlin flying between them (View Transitions). `name(where)` says which side carries the
 * hero name: the old page's element is captured first, then React commits the new page synchronously inside the
 * transition callback and the new page's hero is captured. Without support (or with reduced motion) it just
 * switches.
 */
export function transition(change: () => void, name: (where: 'old' | 'new' | null) => void): void {
  if (!document.startViewTransition || reduced()) { flushSync(() => { change(); name(null); }); return; }
  flushSync(() => name('old'));
  const t = document.startViewTransition(() => { flushSync(() => { change(); name('new'); }); });
  void t.finished.finally(() => flushSync(() => name(null)));
}
