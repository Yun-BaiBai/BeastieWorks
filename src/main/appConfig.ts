import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { V8Settings } from '../shared/v8/settings';

/**
 * The app's settings: config.json in the app's data folder. 小怪工坊 reads and writes only its own part (`v8`);
 * anything else an older version of the app wrote there is kept as it was.
 */
export interface AppConfig {
  v8?: V8Settings;
  /** A8: the interface language: Chinese, English, or the computer's own. */
  uiLanguage?: 'zh' | 'en' | 'system';
  [older: string]: unknown;
}

function file(): string {
  return join(app.getPath('userData'), 'config.json');
}

export function readAppConfig(): AppConfig {
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AppConfig : {};
  } catch {
    return {};
  }
}

/** Merges `patch` into the settings and writes them whole (to a side file first, so a crash never leaves half). */
export function writeAppConfig(patch: Partial<AppConfig>): AppConfig {
  const next: AppConfig = { ...readAppConfig(), ...(patch && typeof patch === 'object' ? patch : {}) };
  const target = file();
  if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true });
  const side = target + '.tmp';
  writeFileSync(side, JSON.stringify(next, null, 2));
  renameSync(side, target);
  return next;
}
