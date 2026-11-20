import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/**
 * One workbench folder per project: its own v8.db, worktrees and sessions, so tickets of different projects never
 * mix and ticket numbers start at 1 in each. The demo project (no project set) has a folder of its own too.
 *
 *   <base>/projects/<name>-<hash8>/   a real project; <hash8> from its resolved path, case-insensitive
 *   <base>/projects/demo/             the demo repository
 *
 * Each folder carries project.json (where the project is, when it was first opened) for project switching later.
 */

export interface ProjectRecord { key: string; root: string | null; name: string; dir: string; createdAt: number }

const slug = (s: string) => s.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';

/** The folder key of a project: stable for the same path, different for different paths. */
export function projectKey(root: string | null): string {
  if (!root) return 'demo';
  const full = resolve(root);
  // Windows paths are case-insensitive: the whole key is, so one folder never gets two workbenches.
  return slug(basename(full)).toLowerCase() + '-' + createHash('sha256').update(full.toLowerCase()).digest('hex').slice(0, 8);
}

/** The project's workbench folder, created with its project.json the first time. */
export function projectStateDir(base: string, root: string | null, now = Date.now()): string {
  const key = projectKey(root);
  const dir = join(base, 'projects', key);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'project.json');
  if (!existsSync(file)) {
    const record: Omit<ProjectRecord, 'dir'> = { key, root: root ? resolve(root) : null, name: root ? basename(resolve(root)) : '演示项目', createdAt: now };
    writeFileSync(file, JSON.stringify(record, null, 2));
  }
  return dir;
}

/** Every project that has a workbench folder, oldest first. */
export function listProjects(base: string): ProjectRecord[] {
  const root = join(base, 'projects');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d => {
    try {
      const r = JSON.parse(readFileSync(join(root, d.name, 'project.json'), 'utf8')) as Omit<ProjectRecord, 'dir'>;
      return [{ ...r, dir: join(root, d.name) }];
    } catch { return []; }
  }).sort((a, b) => a.createdAt - b.createdAt);
}
