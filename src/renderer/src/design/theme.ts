/**
 * App-wide theme: one day/night switch for the whole window.
 *
 * Everything is styled through tokens, so night is a token swap: this module stamps `data-cth-theme` on <html> and
 * the stylesheets carry the night overrides.
 *
 * The boss picks day, night or "跟系统" (A1, 老板 2026-11-20). Following the system listens to Windows' own light/dark
 * setting and changes with it, the way OpenMausBot's theme runtime does (src/lib/theme/runtime.ts:
 * matchMedia('(prefers-color-scheme: dark)') with a change listener). The day/night button in the top bar picks the
 * other one of the two explicitly.
 */
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

export type AppTheme = 'light' | 'dark';
export type ThemeChoice = AppTheme | 'system';

const LS_KEY = 'cth.theme';
/** Pre-0.3.4 the terminal had its own theme key — honored once as the seed. */
const LEGACY_LS_KEY = 'cth.ptyTheme';

function loadChoice(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(LS_KEY) ?? window.localStorage.getItem(LEGACY_LS_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch { /* noop */ }
  return 'light';
}

const systemQuery = (): MediaQueryList | null => {
  try { return typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null; } catch { return null; }
};
const systemTheme = (): AppTheme => (systemQuery()?.matches ? 'dark' : 'light');

let choice: ThemeChoice = loadChoice();
let theme: AppTheme = choice === 'system' ? systemTheme() : choice;
const subscribers = new Set<() => void>();

function apply(): void {
  try { document.documentElement.dataset.cthTheme = theme; } catch { /* SSR/tests */ }
}
apply();

/** Windows' "show animations" turned off: no fade. Same check as OpenMausBot's reducedMotion() (src/lib/onboarding.ts). */
function reducedMotion(): boolean {
  try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return true; }
}

/**
 * A2 (老板 2026-11-20): day and night cross-fade instead of jumping. Copied from OpenMausBot's withViewTransition
 * (src/components/onboarding/view-transition.ts): the browser keeps a picture of the old look, the update runs
 * (React included, through flushSync, so the new look is complete), and the two pictures fade into each other.
 * The fade's length is in global.css (::view-transition-old/new(root)).
 */
function withViewTransition(update: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<unknown> } };
  if (reducedMotion() || typeof doc.startViewTransition !== 'function' || document.visibilityState !== 'visible') { update(); return; }
  // Marks this transition as the theme's, so the plain fade applies and not the page-change one (v8.css).
  const root = document.documentElement;
  root.dataset.cthThemeFade = '';
  const vt = doc.startViewTransition(() => { flushSync(update); });
  const done = () => { delete root.dataset.cthThemeFade; };
  vt.finished.then(done, done);
}

function settle(): void {
  const next = choice === 'system' ? systemTheme() : choice;
  const notify = () => subscribers.forEach(fn => fn());
  if (next === theme) { notify(); return; }
  try {
    withViewTransition(() => { theme = next; apply(); notify(); });
  } catch { theme = next; apply(); notify(); }
}

// Windows' own setting changed: follow it when the boss chose to.
try { systemQuery()?.addEventListener('change', () => { if (choice === 'system') settle(); }); } catch { /* old engines */ }

export function appTheme(): AppTheme { return theme; }
export function themeChoice(): ThemeChoice { return choice; }

/** Day, night or follow the system. */
export function setThemeChoice(next: ThemeChoice): void {
  if (next === choice) return;
  choice = next;
  try { window.localStorage.setItem(LS_KEY, next); } catch { /* noop */ }
  settle();
}

export function setAppTheme(next: AppTheme): void { setThemeChoice(next); }

/** The top bar's button: the other one of day and night. */
export function toggleAppTheme(): AppTheme {
  const next: AppTheme = theme === 'dark' ? 'light' : 'dark';
  setThemeChoice(next);
  return next;
}

const subscribe = (onChange: () => void) => { subscribers.add(onChange); return () => { subscribers.delete(onChange); }; };
export function useAppTheme(): AppTheme { return useSyncExternalStore(subscribe, () => theme); }
export function useThemeChoice(): ThemeChoice { return useSyncExternalStore(subscribe, () => choice); }
