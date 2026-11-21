import { app } from 'electron';
import { readAppConfig } from './appConfig';
import { resolveLanguage, setLanguage } from '../shared/i18n';

/**
 * A8: the interface language for the main process, from the settings, before any other module of the main process is
 * loaded (index.ts imports this first), so words made when a module loads are in that language too.
 */
export function uiLanguageNow(): 'zh' | 'en' {
  return resolveLanguage(readAppConfig().uiLanguage, app.getPreferredSystemLanguages?.()[0] || Intl.DateTimeFormat().resolvedOptions().locale);
}

setLanguage(uiLanguageNow());
