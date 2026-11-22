// A8: the interface language is set before any other module of the main process loads.
import { uiLanguageNow } from './i18nInit';
import { app, BrowserWindow, ipcMain, screen, shell } from 'electron';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { readAppConfig, writeAppConfig, type AppConfig } from './appConfig';
import { registerV8Ipc, shutdownV8 } from './v8/ipc';
import { language, setLanguage } from '../shared/i18n';

/**
 * 小怪工坊 (Beastie Works): one window, the v8 workbench. Everything the app does lives in ./v8; this file opens the
 * window, keeps the settings, and lets the window open https pages in the person's browser. Nothing here talks to
 * the network: no updates, no analytics, no remote data (老板 2026-11-20).
 */

/** The whole screen is one 1440×920 picture scaled to the window (renderer Canvas.tsx). Below about this size the
 *  small print gets hard to read, so the window opens at about the size the boss picked and does not go smaller (A13,
 *  老板 2026-11-20: "默认打开差不多就是这么大"; sizes are in Windows scaled pixels, ×1.25 on his screen).
 *  On a screen smaller than that, the limit is the screen's own free area. */
const MIN = { width: 1090, height: 710 };
const DEFAULT = MIN;
let mainWindow: BrowserWindow | null = null;

/** Only web pages go to the person's browser; anything else a page asks to open is refused. */
function openOutside(url: string): boolean {
  if (!/^https:\/\//.test(url)) return false;
  void shell.openExternal(url);
  return true;
}

function createWindow(): BrowserWindow {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const fit = (want: { width: number; height: number }) => ({ width: Math.min(want.width, area.width), height: Math.min(want.height, area.height) });
  const min = fit(MIN), size = fit(DEFAULT);
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: min.width,
    minHeight: min.height,
    icon: join(__dirname, 'tray-icon.png'),
    title: 'Beastie Works',
    autoHideMenuBar: true,
    backgroundColor: '#f5f4ef',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  // Links open in the browser, never inside the app; the window never navigates away from the workbench.
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) { event.preventDefault(); openOutside(url); }
  });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

ipcMain.handle('config:get', (): AppConfig => readAppConfig());
// A8: the window asks for the language before it shows anything; changing it restarts the app.
ipcMain.on('i18n:lang', event => { event.returnValue = language(); });
ipcMain.handle('i18n:set', (_event, choice: unknown) => {
  if (choice !== 'zh' && choice !== 'en' && choice !== 'system') throw new Error('V8_ARGUMENT');
  writeAppConfig({ uiLanguage: choice });
  setLanguage(uiLanguageNow());
  // Words made when the main process started (desk names, notes) are in the old language: start again. Work that was
  // running carries on after the restart, as after any restart.
  setTimeout(() => { app.relaunch(); app.quit(); }, 200);
  return language();
});
ipcMain.handle('config:update', (_event, patch: unknown): AppConfig => writeAppConfig(patch as Partial<AppConfig>));
ipcMain.handle('app:openExternal', (_event, url: unknown) =>
  typeof url === 'string' && openOutside(url) ? { ok: true } : { ok: false, error: 'blocked url' });

// Every ticket's copy, diff and accept runs on git. A computer without git of its own (most friends') uses the one
// that ships with the app (MinGit, resources/git); it goes on PATH so the agents the app starts find it too.
function useShippedGit(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const key = Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'Path';
  const dirs = (process.env[key] ?? '').split(delimiter).filter(Boolean);
  if (dirs.some(d => existsSync(join(d, 'git.exe')))) return;
  const shipped = join(process.resourcesPath, 'git', 'cmd');
  if (existsSync(join(shipped, 'git.exe'))) process.env[key] = [shipped, ...dirs].join(delimiter);
}
useShippedGit();

registerV8Ipc(ipcMain, { userData: app.getPath('userData'), settings: () => readAppConfig().v8, enabled: () => true });

// One app per data folder: a second start brings the open window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  if (process.platform === 'win32') app.setAppUserModelId('works.beastie.app');
  void app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { app.quit(); });
  // Quitting waits for the agents, sign-in programs and Magpie to stop (at most 10 s), then quits for real; Electron
  // does not wait for a promise on its own (C3 review, finding 7).
  let quitting = false;
  app.on('will-quit', event => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void Promise.race([shutdownV8().catch(() => undefined), new Promise(r => setTimeout(r, 10_000))]).then(() => app.quit());
  });
}
