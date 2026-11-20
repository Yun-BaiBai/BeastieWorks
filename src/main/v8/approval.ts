import { inside } from './workspace';
import type { ApprovalRequest } from './dispatcher';

/**
 * Spec section 6. The boundary is the ticket's directory, not the tool's name: in the 2026-11-13 trial a gremlin
 * refused the write tool simply wrote the same file through the shell. So every request is judged by what it
 * touches:
 *   - writing and editing: only files inside the ticket's directory;
 *   - shell commands: only running the project's own tests and builds, reading, and local git, with no path outside
 *     the directory and nothing that deletes, installs, pushes or reaches the network;
 *   - anything else (evaluating arbitrary code, unknown tools): refused.
 * Refused work comes back to the gremlin, which can ask the boss with a question report.
 */

const SAFE_COMMAND = /^\s*(?:(?:python3?|py)(?:\.exe)?\s|pytest\b|node(?:\.exe)?\s|npm\s+(?:test|t|run\s+(?:test|build|lint|typecheck|check))\b|npx\s+(?:tsc|vitest|jest|eslint|prettier\s+--check)\b|pnpm\s+(?:test|run\s+(?:test|build|lint|check))\b|git\s+(?:status|diff|log|show|add|commit|restore|checkout\s+--)\b|ls\b|dir\b|cat\b|type\b|echo\b|grep\b|rg\b|head\b|tail\b|wc\b|printf\b|find\b|sed\b|sort\b|uniq\b|cut\b|tr\b|pwd\b|where\b|which\b|basename\b|dirname\b|diff\b|true\b)/i;
const FORBIDDEN = /(?:^|[\s;&|`(])(?:rm|rmdir|del|erase|rd|format|mklink|curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|ssh|scp|sudo|runas|powershell|pwsh|cmd)(?:\.exe)?(?=$|[\s;&|)])|git\s+(?:push|remote|fetch|pull|clone|reset\s+--hard|clean|config)|(?:npm|pnpm|yarn|pip|pip3|uv|cargo|go)\s+(?:install|i|add|get)\b|find\b[^|;&]*\s-(?:delete|exec|execdir|ok|okdir|fprint\w*)\b|sed\b[^|;&]*\s-i\b|https?:\/\/|>\s*\/dev\/|\$\(|`/i;

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
  /** The app's own tools, which omp may expose as virtual paths (xd://<name>). Writing to those is calling them. */
  hostTools?: string[];
}

export function directoryPolicy(o: DirectoryPolicyOptions): (r: ApprovalRequest) => boolean {
  return r => {
    const dir = o.workdir(r.ticketId);
    const field = (name: string) => new RegExp('^' + name + ':\\s*(.+)$', 'm').exec(r.detail)?.[1]?.trim() ?? null;
    switch (r.tool) {
      case 'write': case 'edit': case 'patch': case 'multiedit': {
        const target = field('Path') ?? field('File');
        if (!target) return false;
        // A URI is never a file path: only our own tools, exposed by omp as xd://<name>, may be written to.
        // (A Windows drive such as C:/x has one slash after the colon, so it is never taken for a URI.)
        const uri = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(target);
        if (uri) return uri[1].toLowerCase() === 'xd' && (o.hostTools ?? []).includes(uri[2]);
        return inside(dir, target);
      }
      case 'bash': case 'shell': case 'sh': {
        const command = field('Command');
        if (!command || command.length > 2000 || FORBIDDEN.test(command)) return false;
        // Every part of a chained command must be one of the safe kinds.
        // A tool named by its full path (e.g. the project's own Python) counts as that tool if it lives in a tool dir.
        const named = (p: string) => p.replace(/^"?([A-Za-z]:[\\/][^"\s]+|\/[^"\s]+)"?(?=\s|$)/, (m, exe: string) =>
          (o.toolDirs ?? []).some(t => inside(t, exe)) ? exe.split(/[\\/]/).pop()! : m);
        const parts = command.split(/&&|\|\||;|\|/).map(p => named(p.trim())).filter(Boolean);
        if (!parts.length || !parts.every(p => SAFE_COMMAND.test(p))) return false;
        return pathsIn(command).every(p => inside(dir, p) || (o.toolDirs ?? []).some(t => inside(t, p)));
      }
      default:
        return false;
    }
  };
}
