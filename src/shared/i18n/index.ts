import en from './en.json';

/**
 * A8 界面语言: Chinese (the source) or English.
 *
 * Orca's way (src/renderer/src/i18n: the words live in a language file per language, the code calls a translate
 * function) without i18next: the Chinese text itself is the key, so the code still reads as Chinese and a missing
 * English line falls back to the Chinese. Words that change go in as {0}, {1} … (or {name}) and are filled in after
 * the lookup, so English can put them in another order.
 *
 * The language is set once before anything is shown: the main process reads it from the settings at start
 * (main/i18nInit.ts), the window gets it from the preload. Changing it reloads the window.
 */

export type UiLanguage = 'zh' | 'en';
export type UiLanguageChoice = UiLanguage | 'system';

const EN = en as Record<string, string>;

function startLanguage(): UiLanguage {
  const fromWindow = (globalThis as { cth?: { uiLanguage?: unknown } }).cth?.uiLanguage;
  return fromWindow === 'en' ? 'en' : 'zh';
}

let lang: UiLanguage = startLanguage();

export function setLanguage(l: UiLanguage): void { lang = l; }
export function language(): UiLanguage { return lang; }

/** The choice made in the settings → the language used; "system" follows the computer's own (Chinese or not). */
export function resolveLanguage(choice: unknown, systemLocale: string): UiLanguage {
  if (choice === 'en' || choice === 'zh') return choice;
  return /^zh\b/i.test(systemLocale) ? 'zh' : 'en';
}

/** The text in the current language, with {0}, {1} … / {name} filled in. */
export function tr(zh: string, vars?: Record<string, unknown> | unknown[]): string {
  const text = lang === 'en' ? EN[zh] ?? zh : zh;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => {
    // Like a template literal: whatever is there is turned into text; only a name that is not given stays.
    return k in (vars as object) ? String((vars as Record<string, unknown>)[k]) : m;
  });
}

/** The text in every language, for matching words that were saved earlier in whichever language was on then. */
export function anyLang(zh: string): string[] {
  const e = EN[zh];
  return e && e !== zh ? [zh, e] : [zh];
}

/**
 * What an agent is told about the boss's language. The instructions themselves stay in Chinese (models read them
 * either way); with the English interface the agents are told to write what the boss reads in English.
 */
export function withLanguageRule(systemPrompt: string): string {
  if (lang !== 'en' || !systemPrompt.trim()) return systemPrompt;
  return systemPrompt + '\n\nThe boss uses the English interface: write everything the boss will read (replies, questions, reports, plans, titles, reasons) in English, whatever language these instructions are in.';
}

/** The locale for dates and times in the interface language. */
export function dateLocale(): string { return lang === 'en' ? 'en-US' : 'zh-CN'; }
