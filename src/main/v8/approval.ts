import { resolve } from 'node:path';
import { inside } from './workspace';
import type { ApprovalRequest } from './dispatcher';

/**
 * Spec section 6. The boundary is the ticket's directory, not the tool's name: in the 2026-11-13 trial a gremlin
 * refused the write tool simply wrote the same file through the shell. So every request is judged by what it
 * touches:
 *   - writing and editing: only files inside the ticket's directory;
 *   - shell commands: only running the project's own tests and builds, reading (including ffprobe / mediainfo, which
 *     only look at a picture, sound or video file; A7), and local git, with no path outside
 *     the directory and nothing that deletes, installs, pushes or reaches the network;
 *   - anything else (evaluating arbitrary code, unknown tools): refused.
 * Refused work comes back to the gremlin, which can ask the boss with a question report.
 */

const SAFE_COMMAND = /^\s*(?:(?:python3?|py)(?:\.exe)?\s|pytest\b|node(?:\.exe)?\s|npm\s+(?:test|t|run\s+(?:test|build|lint|typecheck|check))\b|npx\s+(?:tsc|vitest|jest|eslint|prettier\s+--check)\b|pnpm\s+(?:test|run\s+(?:test|build|lint|check))\b|git\s+(?:status|diff|log|show|add|commit|restore|checkout\s+--)\b|ls\b|dir\b|cat\b|type\b|echo\b|grep\b|rg\b|head\b|tail\b|wc\b|printf\b|find\b|sed\b|sort\b|uniq\b|cut\b|tr\b|pwd\b|where\b|which\b|basename\b|dirname\b|diff\b|true\b|ffprobe(?:\.exe)?\s|mediainfo(?:\.exe)?\s)/i;
const FORBIDDEN = /(?:^|[\s;&|`(])(?:node|python3?|py)(?:\.exe)?\s+(?:[^|;&]*\s)?(?:-e|--eval|-p|--print|-c|-r|--require|--import|--input-type)(?=[\s=]|$)|(?:^|[\s;&|`(])(?:rm|rmdir|del|erase|rd|format|mklink|curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|ssh|scp|sudo|runas|powershell|pwsh|cmd)(?:\.exe)?(?=$|[\s;&|)])|git\s+(?:push|remote|fetch|pull|clone|reset\s+--hard|clean|config)|(?:npm|pnpm|yarn|pip|pip3|uv|cargo|go)\s+(?:install|i|add|get)\b|find\b[^|;&]*\s-(?:delete|exec|execdir|ok|okdir|fprint\w*)\b|sed\b[^|;&]*\s-i\b|https?:\/\/|>\s*\/dev\/|\$\(|`|%[A-Za-z_][\w()]*%|\$env:|\$\{|\$[A-Za-z_]\w*|--output\b/i;
// The last ones (1.0 review, finding 1): a path written through an environment variable (%TEMP%, $env:TEMP, ${HOME},
// $HOME) cannot be checked, so it is refused; and git writing to a file of its choosing (--output).

/** Every value of a "Key: value" line of a request's detail (a request may name several files). */
function fieldsOf(detail: string, ...names: string[]): string[] {
  const re = new RegExp('^(?:' + names.join('|') + '):\\s*(.+)$', 'gm');
  return [...detail.matchAll(re)].map(m => m[1]!.trim()).filter(Boolean);
}

/**
 * The whole command of a request: everything after "Command:", continuation lines included, up to the next field
 * the app writes (Path:, File:). A command split over several lines is several commands (C3 review, finding 1).
 */
function commandOf(detail: string): string | null {
  const at = /^Command:[ \t]*/m.exec(detail);
  if (!at) return null;
  const rest = detail.slice(at.index + at[0].length);
  const end = rest.search(/^(?:Path|File|Cwd):/m);
  const command = (end < 0 ? rest : rest.slice(0, end)).replace(/\s+$/, '');
  return command.trim() ? command : null;
}

/** Every absolute path (Windows or POSIX) and every `..` escape mentioned in a command. */
function pathsIn(command: string): string[] {
  // POSIX-looking paths only when they have two segments (/usr/bin) or a well-known root; a lone /b or /s is a
  // Windows command switch, not a path.
  const abs = command.match(/[A-Za-z]:[\\/][^\s"'<>|;&]*|(?<![\w.])\/(?!\/)(?:[^\s"'<>|;&/]+\/[^\s"'<>|;&]*|(?:dev|etc|tmp|usr|home|var|bin|mnt|proc|root|opt)\b[^\s"'<>|;&]*)/g) ?? [];
  const up = command.match(/(?:^|[\s"'=])(\.\.[\\/][^\s"'<>|;&]*)/g)?.map(s => s.trim().replace(/^["'=]/, '')) ?? [];
  return [...abs, ...up];
}

export interface DirectoryPolicyOptions {
  /** The ticket's own directory. */
  workdir(ticketId: number): string;
  /** Read-only places a command may name besides the directory, e.g. the Python the tests run with. */
  toolDirs?: string[];
  /** The app's own tools, which an agent may expose as virtual paths (xd://<name>). Writing to those is calling them. */
  hostTools?: string[];
  /**
   * Files of the ticket folder that must not be written: the project's big files, linked in rather than copied, so
   * writing one would change the project's own file before the boss accepts anything (C3 review, finding 2).
   */
  protectedFiles?(ticketId: number): string[];
}

export function directoryPolicy(o: DirectoryPolicyOptions): (r: ApprovalRequest) => boolean {
  return r => {
    const dir = o.workdir(r.ticketId);
    const field = (name: string) => new RegExp('^' + name + ':\\s*(.+)$', 'm').exec(r.detail)?.[1]?.trim() ?? null;
    switch (r.tool) {
      case 'write': case 'edit': case 'patch': case 'multiedit': {
        // Every file the request names, not only the first (C3 review, finding 1).
        const targets = fieldsOf(r.detail, 'Path', 'File');
        if (!targets.length) return false;
        const locked = new Set((o.protectedFiles?.(r.ticketId) ?? []).map(p => resolve(dir, p).toLowerCase()));
        return targets.every(target => {
          // A URI is never a file path: only our own tools, exposed as xd://<name>, may be written to.
          // (A Windows drive such as C:/x has one slash after the colon, so it is never taken for a URI.)
          const uri = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(target);
          if (uri) return uri[1]!.toLowerCase() === 'xd' && (o.hostTools ?? []).includes(uri[2]!);
          return inside(dir, target) && !locked.has(resolve(dir, target).toLowerCase());
        });
      }
      case 'bash': case 'shell': case 'sh': {
        const command = commandOf(r.detail);
        if (!command || command.length > 2000 || FORBIDDEN.test(command)) return false;
        // Where it runs, when the agent says (Antigravity's Cwd): inside the ticket's folder only.
        if (!fieldsOf(r.detail, 'Cwd').every(c => inside(dir, c))) return false;
        // Every part of a chained command must be one of the safe kinds.
        // A tool named by its full path (e.g. the project's own Python) counts as that tool if it lives in a tool dir.
        const named = (p: string) => p.replace(/^"?([A-Za-z]:[\\/][^"\s]+|\/[^"\s]+)"?(?=\s|$)/, (m, exe: string) =>
          (o.toolDirs ?? []).some(t => inside(t, exe)) ? exe.split(/[\\/]/).pop()! : m);
        // A single & chains commands in cmd too (1.0 review, finding 1): split on it as on the others.
        const parts = command.split(/&&|\|\||;|\||&|\r?\n/).map(p => named(p.trim())).filter(Boolean);
        if (!parts.length || !parts.every(p => SAFE_COMMAND.test(p))) return false;
        return pathsIn(command).every(p => inside(dir, p) || (o.toolDirs ?? []).some(t => inside(t, p)));
      }
      default:
        return false;
    }
  };
}

/** Commands that only look: listing, reading, searching, counting, git's read-only views, media inspection. */
const READ_ONLY_COMMAND = /^\s*(?:git\s+(?:status|diff|log|show|ls-files|blame)\b|ls\b|dir\b|cat\b|type\b|echo\b|grep\b|rg\b|head\b|tail\b|wc\b|find\b|sort\b|uniq\b|cut\b|tr\b|pwd\b|where\b|which\b|basename\b|dirname\b|tree\b|ffprobe(?:\.exe)?\s|mediainfo(?:\.exe)?\s)/i;

/**
 * For the roundtable's proposers (A6): they may read the project, never change it. Writes and edits are refused
 * outright; a command passes only when every part of it just looks and names no path outside the folder.
 */
export function readOnlyPolicy(dir: string): (tool: string, detail: string) => boolean {
  return (tool, detail) => {
    const t = tool.toLowerCase();
    // ACP's kinds (acpShell describePermission): read and search look at files, think touches nothing.
    if (t === 'think') return true;
    if (/^(read|grep|glob|ls|list|search|view)$/.test(t)) {
      const targets = fieldsOf(detail, 'Path', 'File');
      return targets.every(p => inside(dir, p));
    }
    if (!/^(bash|shell|sh|execute)$/.test(t)) return false;
    const command = commandOf(detail);
    if (!command || command.length > 2000 || FORBIDDEN.test(command) || /[>]/.test(command)) return false;
    if (!fieldsOf(detail, 'Cwd').every(c => inside(dir, c))) return false;
    const parts = command.split(/&&|\|\||;|\||&|\r?\n/).map(p => p.trim()).filter(Boolean);
    if (!parts.length || !parts.every(p => READ_ONLY_COMMAND.test(p))) return false;
    return pathsIn(command).every(p => inside(dir, p));
  };
}
