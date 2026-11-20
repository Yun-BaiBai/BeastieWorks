import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// Two checks the Magpie gateway makes before it writes a file or starts a program. Moved here unchanged from the old
// harness (workOrderFiles.ts, seatAdapter.ts) when it was removed (老板 2026-11-20).

function requireValue(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

/** A path inside `root`: relative, no `..`, no Windows device names, and no link on the way. */
export function workspacePath(root: string, path: string): string {
  requireValue(isAbsolute(root), 'WORKSPACE_MUST_BE_ABSOLUTE');
  const canonical = realpathSync(root);
  requireValue(text(path) && !isAbsolute(path) && !/[:\x00-\x1f]/.test(path), 'UNSAFE_CONTRACT_PATH');
  const parts = path.replace(/\\/g, '/').split('/');
  requireValue(parts.every(x => x && x !== '.' && x !== '..' && !/[. ]$/.test(x) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(x)), 'UNSAFE_CONTRACT_PATH');
  const target = resolve(canonical, ...parts);
  requireValue(relative(canonical, target) !== '' && !relative(canonical, target).startsWith('..' + sep), 'UNSAFE_CONTRACT_PATH');
  let cursor = canonical;
  for (const part of parts) {
    cursor = join(cursor, part);
    if (existsSync(cursor)) requireValue(!lstatSync(cursor).isSymbolicLink(), 'LINK_IN_CONTRACT_PATH');
  }
  return target;
}

/** A program given by its full path, a file that exists, and on Windows a real .exe or .com. */
export function validateSeatExecutable(command: string): void {
  requireValue(isAbsolute(command) && existsSync(command) && lstatSync(command).isFile(), 'SEAT_REQUIRES_ABSOLUTE_EXECUTABLE');
  if (process.platform === 'win32') requireValue(/\.(exe|com)$/i.test(command), 'SEAT_REQUIRES_NATIVE_WINDOWS_EXECUTABLE');
}
