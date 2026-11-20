import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Bring a skill in from GitHub (requirement 41: skills can be fetched from a link, and dropped again).
 *
 * Ported from OpenMausBot (Apache-2.0): server/skill-fetch.ts (finding the skill folders in a repository, reading
 * them at one commit and checking every file against that commit) and server/skill-folder.ts (which files come in and
 * how they are written). Changes: zod replaced by plain checks; the folder is written by this app's skill library;
 * messages in Chinese for the person.
 */

const API = 'https://api.github.com';
const RAW_HOST = 'raw.githubusercontent.com';
const USER_AGENT = 'BeastieWorks-skills';
const LISTING_MAX_BYTES = 1_048_576;
// GitHub allows 60 API requests an hour without sign-in; downloads from the raw host are not counted against it.
const IMPORT_LIMITS = { apiRequests: 128, downloads: 1_000, bytes: 64 * 1_048_576, ms: 120_000 };
const PARALLEL_DOWNLOADS = 4;
export const SKILL_FILE_MAX_BYTES = 256 * 1024;
/** `depth` counts path segments, file name included. */
export const SKILL_FOLDER_LIMITS = { files: 200, bytes: 16 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, depth: 8 } as const;
export const MAX_SKILLS_PER_IMPORT = 30;
const MAX_FOLDERS_WALKED = 24;
const MAX_CHILDREN_PER_FOLDER = 60;

class ImportLimitError extends Error {}
class GitHubApiError extends Error {}

export type SkippedReason = 'link' | 'submodule' | 'hidden' | 'generated' | 'name' | 'deep' | 'large' | 'duplicate' | 'full' | 'lfs' | 'unlisted';
export interface SkippedFile { path: string; reason: SkippedReason }
export interface GitHubSkillOrigin { owner: string; repo: string; ref: string; commit: string; path: string }
export interface FetchedSkill {
  source: string;
  github?: GitHubSkillOrigin;
  files: Array<{ path: string; content: Buffer; executable: boolean }>;
  skipped: SkippedFile[];
}
interface FolderEntry { path: string; kind: 'file' | 'folder' | 'link' | 'submodule'; size: number; executable?: boolean }
interface ContentEntry { type: string; name: string; path: string; sha?: string; download_url?: string | null }
interface Target { owner: string; repo: string; ref?: string; path: string; skill?: string; rawUrl?: string }

const NOT_A_SOURCE = '这不像 GitHub 仓库、文件夹或 SKILL.md 的链接，也不像 skills.sh 的技能页';

// One budget for the whole import, enforced while reading the stream.
function boundedImportFetch(fetcher: typeof fetch): typeof fetch {
  let apiRequests = 0, downloads = 0, bytes = 0;
  const signal = AbortSignal.timeout(IMPORT_LIMITS.ms);
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const listing = String(input).startsWith(`${API}/`);
    if (listing ? ++apiRequests > IMPORT_LIMITS.apiRequests : ++downloads > IMPORT_LIMITS.downloads) {
      throw new ImportLimitError('请求次数到上限了，换一个具体的技能文件夹链接再试。');
    }
    signal.throwIfAborted();
    const response = await fetcher(input, { ...init, signal });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); return response; }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        bytes += chunk.value.byteLength;
        if (size > (listing ? LISTING_MAX_BYTES : SKILL_FOLDER_LIMITS.fileBytes) || bytes > IMPORT_LIMITS.bytes) {
          throw new ImportLimitError('文件太大了，换一个小一点的技能文件夹再试。');
        }
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
  }) as typeof fetch;
}

const OWNER_OR_REPO = /^[\w.-]+$/;

/** Null for a path that does not decode, or would climb out of where it is used once decoded. */
function decodedPath(p: string): string | null {
  try {
    const decoded = p.split('/').filter(Boolean).map(decodeURIComponent).join('/');
    return decoded.split('/').some(part => part === '.' || part === '..') ? null : decoded;
  } catch { return null; }
}

function target(owner: string, repo: string, ref: string | undefined, p: string, extra: Partial<Target> = {}): Target | { error: string } {
  try { ref = ref === undefined ? undefined : decodeURIComponent(ref); } catch { return { error: NOT_A_SOURCE }; }
  const decoded = decodedPath(p);
  if (!OWNER_OR_REPO.test(owner) || !OWNER_OR_REPO.test(repo) || [owner, repo].some(part => /^\.+$/.test(part)) || decoded === null ||
    (ref !== undefined && (!ref || ref === '.' || ref === '..' || /[\s?#]/.test(ref)))) return { error: NOT_A_SOURCE };
  return { owner, repo, ...(ref ? { ref } : {}), path: decoded, ...extra };
}

/** A GitHub repository, folder or SKILL.md link, a raw SKILL.md link, a skills.sh page, or owner/repo. */
export function parseSkillSource(input: string): Target | { error: string } {
  const text = input.trim();
  if (!text) return { error: '先贴一个 GitHub 仓库、文件夹或 SKILL.md 的链接' };
  const raw = text.match(/^(https?):\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.+\/)?SKILL\.md$/i);
  if (raw) {
    // Plain http sends the skill URL in the clear; refuse it rather than upgrade it.
    if (raw[1]!.toLowerCase() !== 'https') return { error: '请用 https:// 开头的链接' };
    const parts = (raw[4] ?? '').split('/').filter(Boolean);
    const named = parts[0] === 'refs' && (parts[1] === 'heads' || parts[1] === 'tags') ? 3 : 1;
    if (parts.length < named) return { error: NOT_A_SOURCE };
    return target(raw[2]!, raw[3]!, parts[named - 1], parts.slice(named).join('/'), { rawUrl: text });
  }
  const github = text.replace(/[?#].*$/, '');
  const blob = github.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/((?:.*\/)?)SKILL\.md$/i);
  if (blob) return target(blob[1]!, blob[2]!, blob[3]!, blob[4]!, { rawUrl: `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}SKILL.md` });
  const tree = github.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/i);
  if (tree) return target(tree[1]!, tree[2]!, tree[3], tree[4] ?? '');
  const registry = text.match(/^https?:\/\/skills\.sh\/([\w.-]+)\/([\w.-]+)(?:\/([\w.-]+))?\/?$/i);
  if (registry) {
    if ([registry[1], registry[2]].some(part => part === '.' || part === '..') ||
      (registry[3] && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(registry[3]))) return { error: NOT_A_SOURCE };
    // skills.sh pages install from github.com/<owner>/<repo>, filtered to the named skill.
    return { owner: registry[1]!, repo: registry[2]!, path: '', skill: registry[3] };
  }
  const shorthand = text.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) return target(shorthand[1]!, shorthand[2]!, undefined, '');
  return { error: NOT_A_SOURCE };
}

function asEntries(listing: unknown): ContentEntry[] {
  if (!Array.isArray(listing)) return [];
  return listing.flatMap((item): ContentEntry[] => {
    if (!item || typeof item !== 'object') return [];
    const e = item as Record<string, unknown>;
    if (typeof e.type !== 'string' || typeof e.name !== 'string' || typeof e.path !== 'string') return [];
    return [{ type: e.type, name: e.name, path: e.path, sha: typeof e.sha === 'string' ? e.sha : undefined,
      download_url: typeof e.download_url === 'string' ? e.download_url : null }];
  });
}

function encodePath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  // A URL parser resolves dot segments, which would aim the request at another endpoint of the host.
  if (parts.some(part => part === '.' || part === '..')) throw new Error(`refusing the path ${JSON.stringify(p)}`);
  return parts.map(encodeURIComponent).join('/');
}

function apiError(response: Response, url: string): GitHubApiError {
  const limited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
  return new GitHubApiError(limited ? 'GitHub 对不登录的请求有每小时上限，已经用完了，过一会儿再试。' : `GitHub 回了 ${response.status}（${url}）`);
}

async function apiGet(url: string, fetcher: typeof fetch, accept = 'application/vnd.github+json'): Promise<Response> {
  const response = await fetcher(url, { headers: { accept, 'user-agent': USER_AGENT } });
  if (!response.ok) throw apiError(response, url);
  return response;
}

/** The commit `ref` names now; HEAD is the default branch. */
async function resolveCommit(owner: string, repo: string, ref: string, fetcher: typeof fetch): Promise<string> {
  const url = `${API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
  const sha = (await (await apiGet(url, fetcher, 'application/vnd.github.sha')).text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitHubApiError(`GitHub 没给出这个链接对应的提交（${url}）`);
  return sha;
}

/** A repository read at one commit; `trees` holds the folder hashes its listings named. */
interface Snapshot { owner: string; repo: string; commit: string; trees: Map<string, string> }

async function listDir(snapshot: Snapshot, p: string, fetcher: typeof fetch): Promise<ContentEntry[]> {
  const url = `${API}/repos/${snapshot.owner}/${snapshot.repo}/contents/${encodePath(p)}?ref=${snapshot.commit}`;
  const entries = asEntries(await (await apiGet(url, fetcher)).json());
  for (const entry of entries) if (entry.type === 'dir' && entry.sha) snapshot.trees.set(entry.path, entry.sha);
  return entries;
}

// Pin download links to https on the raw host, no port or credentials, so a tampered response cannot aim fetches elsewhere.
function assertPinnedRawUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`refusing to download ${url} — not a valid URL`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hostname !== RAW_HOST) {
    throw new Error(`refusing to download ${url} — skill files must be https://raw.githubusercontent.com links`);
  }
}

async function fetchBytes(url: string, fetcher: typeof fetch): Promise<Buffer> {
  assertPinnedRawUrl(url);
  // The raw host never redirects: error rather than follow one to an arbitrary host.
  const response = await fetcher(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'error' });
  if (!response.ok) throw new Error(`下载失败（${response.status}）`);
  return Buffer.from(await response.arrayBuffer());
}

const passThrough = (error: unknown) => error instanceof ImportLimitError || (error instanceof Error && error.name === 'TimeoutError');

/** Mirrors skills.sh's toSkillSlug: page slugs come from SKILL.md names, which can differ from folder names. */
export const toSkillSlug = (name: string) =>
  name.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');

async function skillNameFrom(entries: ContentEntry[], fetcher: typeof fetch): Promise<string | undefined> {
  const skillMd = entries.find(entry => entry.type === 'file' && entry.name === 'SKILL.md' && entry.download_url);
  if (!skillMd) return undefined;
  try {
    const text = (await fetchBytes(skillMd.download_url!, fetcher)).toString('utf8');
    return text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  } catch (error) {
    if (passThrough(error)) throw error;
    return undefined;
  }
}

/** The skills.sh registry's discovery order: the path, skills/, .claude/skills/, .agents/skills/, then direct children. */
async function discoverSkillDirs(t: Target, snapshot: Snapshot, fetcher: typeof fetch): Promise<string[]> {
  const root = await listDir(snapshot, t.path, fetcher);
  const wanted = t.skill ? toSkillSlug(t.skill) || undefined : undefined;
  const dirMatches = (dir: string) => !!wanted && toSkillSlug(dir.split('/').at(-1)!) === wanted;
  const isWanted = async (dir: string, entries: ContentEntry[]) => {
    if (!wanted) return true;
    if (dirMatches(dir)) return true;
    const name = await skillNameFrom(entries, fetcher);
    return !!name && toSkillSlug(name) === wanted;
  };
  if (root.some(entry => entry.type === 'file' && entry.name === 'SKILL.md') && (await isWanted(t.path, root))) return [t.path];
  const dirs = root.filter(entry => entry.type === 'dir');
  const found: string[] = [];
  const preferred = ['skills', '.claude', '.agents'];
  const rank = (name: string) => (wanted && toSkillSlug(name) === wanted ? 0 : preferred.includes(name) ? 1 : 2);
  const ordered = [...dirs].sort((a, b) => rank(a.name) - rank(b.name));
  const enough = () => found.length >= (wanted ? 1 : MAX_SKILLS_PER_IMPORT);
  for (const dir of ordered.slice(0, MAX_FOLDERS_WALKED)) {
    if (enough()) break;
    const base = dir.name === '.claude' || dir.name === '.agents' ? `${dir.path}/skills` : dir.path;
    let children: ContentEntry[];
    try { children = await listDir(snapshot, base, fetcher); } catch (error) { if (passThrough(error)) throw error; continue; }
    if (children.some(entry => entry.type === 'file' && entry.name === 'SKILL.md')) {
      if (await isWanted(base, children)) found.push(base);
      continue;
    }
    const childDirs = children.filter(entry => entry.type === 'dir');
    const exact = wanted ? childDirs.find(child => dirMatches(child.path)) : undefined;
    const candidates = exact
      ? [exact, ...childDirs.filter(child => child !== exact).slice(0, MAX_CHILDREN_PER_FOLDER - 1)]
      : childDirs.slice(0, MAX_CHILDREN_PER_FOLDER);
    for (const child of candidates) {
      if (enough()) break;
      try {
        const inner = await listDir(snapshot, child.path, fetcher);
        if (inner.some(entry => entry.type === 'file' && entry.name === 'SKILL.md') && (await isWanted(child.path, inner))) found.push(child.path);
      } catch (error) { if (passThrough(error)) throw error; }
    }
  }
  return found;
}

// --- which files come in (skill-folder.ts) ---

const GENERATED = new Set(['__pycache__', 'node_modules', 'venv']);
const unsafeCharacter = (char: string) => char < ' ' || char === '\u007f' || '<>:"|?*\\'.includes(char);
// Windows refuses these names in any folder, with or without an extension.
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/** Why `p` (relative, "/"-separated) may not be written inside a skill folder; null when it may. */
export function skillFilePathProblem(p: string, folder = false): SkippedReason | null {
  const parts = p.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || [...part].some(unsafeCharacter) || /[. ]$/.test(part) ||
      WINDOWS_DEVICE.test(part) || Buffer.byteLength(part, 'utf8') > 255) return 'name';
    if (part.startsWith('.')) return 'hidden';
    if (GENERATED.has(part.toLowerCase())) return 'generated';
  }
  return parts.length > SKILL_FOLDER_LIMITS.depth - (folder ? 1 : 0) ? 'deep' : null;
}

const depthOf = (p: string) => p.split('/').length;
const comparable = (p: string) => p.normalize('NFC').toLowerCase();

/** What of a folder listing comes in, SKILL.md first and shallow files before deep ones, within the limits. */
export function planSkillFolder<T extends FolderEntry>(entries: readonly T[]): { take: T[]; skipped: SkippedFile[] } {
  const ordered = [...entries].sort((a, b) => depthOf(a.path) - depthOf(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const skillMd = ordered.find(entry => entry.path === 'SKILL.md' && entry.kind === 'file');
  const take: T[] = skillMd ? [skillMd] : [];
  const skipped: SkippedFile[] = [];
  const closed: string[] = [];
  const held = new Map<string, { spelling: string; folder: boolean }>(skillMd ? [['skill.md', { spelling: 'SKILL.md', folder: false }]] : []);
  let bytes = skillMd?.size ?? 0;
  const clashes = (p: string) => {
    const parts = p.split('/');
    return parts.some((_, index) => {
      const prefix = parts.slice(0, index + 1).join('/');
      const holder = held.get(comparable(prefix));
      return holder !== undefined && (index === parts.length - 1 || !holder.folder || holder.spelling !== prefix);
    });
  };
  const hold = (p: string) => {
    const parts = p.split('/');
    parts.forEach((_, index) => {
      const prefix = parts.slice(0, index + 1).join('/');
      held.set(comparable(prefix), { spelling: prefix, folder: index < parts.length - 1 });
    });
  };
  for (const entry of ordered) {
    if (entry === skillMd || closed.some(prefix => entry.path.startsWith(prefix))) continue;
    const skip = (reason: SkippedReason) => skipped.push({ path: entry.kind === 'folder' ? `${entry.path}/` : entry.path, reason });
    if (entry.kind === 'link' || entry.kind === 'submodule') { skip(entry.kind); continue; }
    const problem = skillFilePathProblem(entry.path, entry.kind === 'folder');
    if (problem) { skip(problem); if (entry.kind === 'folder') closed.push(`${entry.path}/`); continue; }
    if (entry.kind === 'folder') continue;
    if (entry.size > SKILL_FOLDER_LIMITS.fileBytes) skip('large');
    else if (clashes(entry.path)) skip('duplicate');
    else if (take.length >= SKILL_FOLDER_LIMITS.files || bytes + entry.size > SKILL_FOLDER_LIMITS.bytes) skip('full');
    else { take.push(entry); bytes += entry.size; hold(entry.path); }
  }
  return { take, skipped };
}

/** Every entry below `dir` at the snapshot's commit, in one request however deep the folder goes. */
async function folderTree(snapshot: Snapshot, dir: string, fetcher: typeof fetch): Promise<Array<FolderEntry & { sha: string }>> {
  if (dir && !snapshot.trees.has(dir)) await listDir(snapshot, dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '', fetcher);
  const sha = dir ? snapshot.trees.get(dir) : snapshot.commit;
  if (!sha) throw new GitHubApiError(`GitHub 没列出文件夹 ${dir}`);
  const url = `${API}/repos/${snapshot.owner}/${snapshot.repo}/git/trees/${sha}?recursive=1`;
  const j = await (await apiGet(url, fetcher)).json() as { truncated?: unknown; tree?: unknown };
  if (!Array.isArray(j.tree)) throw new GitHubApiError(`GitHub 的文件夹清单读不懂（${url}）`);
  if (j.truncated === true) throw new ImportLimitError('这个技能文件夹里的文件太多了，换一个小一点的文件夹再试。');
  return j.tree.flatMap((e): Array<FolderEntry & { sha: string }> => {
    if (!e || typeof e !== 'object') return [];
    const x = e as Record<string, unknown>;
    if (typeof x.path !== 'string' || typeof x.mode !== 'string' || typeof x.type !== 'string' || typeof x.sha !== 'string') return [];
    return [{ path: x.path, sha: x.sha, size: typeof x.size === 'number' ? x.size : 0,
      kind: x.type === 'tree' ? 'folder' : x.type === 'commit' ? 'submodule' : x.mode === '120000' ? 'link' : 'file',
      executable: x.mode === '100755' }];
  });
}

const gitBlobSha = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const isLfsPointer = (bytes: Buffer) => bytes.length < 1024 && bytes.toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1\n');

async function fetchSkillFolder(t: Target, snapshot: Snapshot, dir: string, fetcher: typeof fetch): Promise<FetchedSkill> {
  const entries = await folderTree(snapshot, dir, fetcher);
  const { take, skipped } = planSkillFolder(entries);
  if (take[0]?.path !== 'SKILL.md') throw new Error(`${dir || '仓库根目录'} 里没有 SKILL.md`);
  if (take[0].size > SKILL_FILE_MAX_BYTES) throw new Error(`SKILL.md 超过 ${SKILL_FILE_MAX_BYTES / 1024}KB`);
  const files: FetchedSkill['files'] = [];
  for (let i = 0; i < take.length; i += PARALLEL_DOWNLOADS) {
    const batch = await Promise.all(take.slice(i, i + PARALLEL_DOWNLOADS).map(async entry => {
      const location = encodePath(dir ? `${dir}/${entry.path}` : entry.path);
      const content = await fetchBytes(`https://${RAW_HOST}/${snapshot.owner}/${snapshot.repo}/${snapshot.commit}/${location}`, fetcher);
      // Every file is the one the commit's tree names, so the recorded commit is what came in.
      if (gitBlobSha(content) !== entry.sha) throw new Error(`${entry.path} 和提交 ${snapshot.commit.slice(0, 7)} 对不上，再导入一次试试`);
      return { path: entry.path, content, executable: Boolean(entry.executable) };
    }));
    for (const file of batch) {
      if (file.path !== 'SKILL.md' && isLfsPointer(file.content)) skipped.push({ path: file.path, reason: 'lfs' });
      else files.push(file);
    }
  }
  const ref = t.ref ? `@${t.ref}` : '';
  return {
    source: `github.com/${snapshot.owner}/${snapshot.repo}${ref}/${dir}`.replace(/\/$/, ''),
    github: { owner: snapshot.owner, repo: snapshot.repo, ref: t.ref ?? 'HEAD', commit: snapshot.commit, path: dir },
    files, skipped,
  };
}

async function fetchSkills(t: Target, fetcher: typeof fetch): Promise<FetchedSkill[]> {
  const commit = await resolveCommit(t.owner, t.repo, t.ref ?? 'HEAD', fetcher);
  const snapshot: Snapshot = { owner: t.owner, repo: t.repo, commit, trees: new Map() };
  const dirs = await discoverSkillDirs(t, snapshot, fetcher);
  if (!dirs.length) {
    throw new Error(t.skill ? `那里找不到叫 "${t.skill}" 的技能，核对一下 skills.sh 页面上的名字`
      : '那里找不到 SKILL.md，贴一个技能文件夹，或者带 skills 文件夹的仓库');
  }
  const skills: FetchedSkill[] = [];
  for (const dir of dirs) skills.push(await fetchSkillFolder(t, snapshot, dir, fetcher));
  return skills;
}

/** Every skill a link points at, read at one commit, or why not. */
export async function fetchSkillFromSource(input: string, fetcher: typeof fetch = fetch): Promise<{ skills: FetchedSkill[] } | { error: string }> {
  const parsed = parseSkillSource(input);
  if ('error' in parsed) return parsed;
  fetcher = boundedImportFetch(fetcher);
  try {
    return { skills: await fetchSkills(parsed, fetcher) };
  } catch (error) {
    if (parsed.rawUrl && error instanceof GitHubApiError) {
      try {
        const content = await fetchBytes(parsed.rawUrl, fetcher);
        return { skills: [{ source: parsed.rawUrl, files: [{ path: 'SKILL.md', content, executable: false }], skipped: [{ path: '', reason: 'unlisted' }] }] };
      } catch { /* the error below */ }
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Into `folder`, which must not exist yet: each level created as a real folder, never over or through anything. */
export function writeSkillFolder(folder: string, files: ReadonlyArray<{ path: string; content: Buffer | string; executable?: boolean }>): void {
  mkdirSync(folder);
  for (const file of files) {
    const target = resolve(folder, file.path);
    // Refused here too, whatever the caller checked, so no path can leave the folder.
    if ((file.path !== 'SKILL.md' && skillFilePathProblem(file.path)) || relative(folder, target).split(/[\\/]/)[0] === '..') {
      throw new Error(`refusing to write ${JSON.stringify(file.path)} outside the skill folder`);
    }
    let at = folder;
    for (const part of file.path.split('/').slice(0, -1)) {
      at = join(at, part);
      if (!existsSync(at)) mkdirSync(at);
      if (!lstatSync(at).isDirectory()) throw new Error(`${file.path} has no real folder to go in`);
    }
    writeFileSync(target, file.content, { flag: 'wx' });
  }
}
