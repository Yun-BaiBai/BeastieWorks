import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { readAppConfig, writeAppConfig, type AppConfig } from './appConfig';
import { registerV8Ipc, shutdownV8 } from './v8/ipc';

/**
 * 小怪工坊 (Beastie Works): one window, the v8 workbench. Everything the app does lives in ./v8; this file opens the
 * window, keeps the settings, and lets the window open https pages in the person's browser. Nothing here talks to
 * the network: no updates, no analytics, no remote data (老板 2026-11-20).
 */

const MIN = { width: 880, height: 560 };
let mainWindow: BrowserWindow | null = null;

/** Only web pages go to the person's browser; anything else a page asks to open is refused. */
function openOutside(url: string): boolean {
  if (!/^https:\/\//.test(url)) return false;
  void shell.openExternal(url);
  return true;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: MIN.width,
    minHeight: MIN.height,
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
  app.on('will-quit', () => { void shutdownV8(); });
}
