import { chmodSync, readdirSync, rmSync, type RmOptions } from 'node:fs';
import path from 'node:path';

/**
 * Removes a folder and everything in it, read-only files included. The Node inside Electron 43 (24.22) no longer
 * removes a read-only file on Windows (EPERM), and git marks its object files read-only, so a ticket's copy or an
 * installed agent could not be removed (found when upgrading Electron, 2026-11-22). Like the older rmSync: on EPERM
 * every file is made writable, then it tries again.
 */
export function rmTree(target: string, options: RmOptions = {}): void {
  try { rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100, ...options }); return; }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err; }
  writable(target);
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200, ...options });
}

function writable(p: string): void {
  try { chmodSync(p, 0o666); } catch { /* gone, or a folder */ }
  let entries: import('node:fs').Dirent[] = [];
  try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) writable(full);
    else { try { chmodSync(full, 0o666); } catch { /* gone */ } }
  }
}
