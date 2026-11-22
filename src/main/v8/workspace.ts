import { tr } from '../../shared/i18n';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Leftovers of running tests, never the gremlin's work: kept out of every diff the reviewer or the boss sees.
 * (Found in the first real review: running the tests left __pycache__/*.pyc, and review rejected the work for it.)
 * Only caches: build output (dist, build, out) and logs can be what a project delivers (a video rendered to out/),
 * so they follow the project's own .gitignore (C3 review, finding 14).
 */
/** Where catchUp puts the project's version of a file both sides changed, for the gremlin to merge (never accepted). */
export const MERGE_DIR = '.beastie-merge';
export const ARTIFACTS = ['__pycache__', '*.pyc', '*.pyo', '.pytest_cache', 'node_modules', '.cache', '.DS_Store', MERGE_DIR];
const artifactSpecs = ARTIFACTS.map(a => ':(exclude,glob)**/' + a + (a.includes('*') ? '' : '/**'));
const artifactFiles = ARTIFACTS.filter(a => a.includes('*') || a.startsWith('.DS')).map(a => ':(exclude,glob)**/' + a);

/** Who the app's own snapshot commits are by. Never the boss's name: these never reach the boss's history. */
const SNAPSHOT_AUTHOR = ['-c', 'user.name=Beastie Works', '-c', 'user.email=snapshot@beastie.invalid', '-c', 'commit.gpgsign=false'];

/** What happened when the boss accepted a ticket: files put into the project, and files left alone because the
 *  project's copy changed meanwhile (so nobody's work is overwritten). */
export interface ApplyResult { applied: string[]; conflicts: string[] }

/**
 * Files at least this big (video, audio, footage) are not copied for each ticket (要求第 3 条: a video project of a few
 * GB must not be copied per ticket). They stay out of the private snapshot store and the ticket folder gets a hard link
 * to the project's own file: the same file, no copy, no extra disk. The idea is OpenMausBot's (server/checkpoints.ts,
 * after Roo-Code): big media stays out of the snapshots. A gremlin that rewrites such a file in place changes the
 * project's file at once; tools that render or convert write new files, which are reviewed and accepted as usual.
 *
 * So the project's file cannot be changed before the boss accepts anything (C3 review, finding 2), a linked file is
 * read-only while its ticket is open (lock), and writable again once the ticket is done or stopped (release). Being
 * the same file, the project's copy is read-only meanwhile too. Writes to it are also refused by the approval rule.
 */
export const BIG_FILE = 20 * 1024 * 1024;
interface BigFile { path: string; size: number; mtimeMs: number; linked: boolean }
/** A path as an anchored, literal .gitignore line. */
function ignoreLine(p: string): string {
  return '/' + p.replace(/[\\*?[\]!#]/g, m => '\\' + m).replace(/ $/, '\\ ');
}

/**
 * One working folder per ticket, so two gremlins never touch the same files and every ticket's work can be reviewed
 * or thrown away on its own. Reused for every assignment of the ticket.
 *
 * A project can be any folder (要求第 3 条: a novel, a music project, not only code). When a ticket starts, the app
 * takes a snapshot of the folder as it is on disk into a private store in its own data folder (a git store nobody else
 * sees), and the ticket folder is a checkout of that snapshot on the ticket's own branch, `gw/<tag>/ticket-<id>`.
 * Nothing is ever written into the project, and a git project's own repository gets no branches or commits: a ticket
 * starts from what is on disk now, the boss's uncommitted edits and earlier accepted work included. Accepting the
 * work copies exactly the files the gremlin changed into the project (`apply`), refusing any file changed there since.
 */
export class TicketWorkspaces {
  readonly branchPrefix: string;
  private readonly mirror: string;

  constructor(private readonly repoRoot: string, private readonly baseDir: string) {
    this.branchPrefix = 'gw/' + createHash('sha256').update(resolve(baseDir).toLowerCase()).digest('hex').slice(0, 8) + '/';
    this.mirror = join(dirname(resolve(baseDir)), 'snapshot.git');
    this.recoverAccept();
  }

  /** Where an accept in progress writes down what it swaps, so a crash part way can be put right (1.0 review, 4). */
  private get journal(): string { return join(dirname(resolve(this.baseDir)), 'accept-journal.json'); }

  /**
   * An accept that did not finish (the app was killed, the power went) left its journal: every project file it had
   * moved aside goes back where it was, and the half-placed new versions go. The project is as before that accept.
   * Returns the files put back.
   */
  recoverAccept(): string[] {
    if (!existsSync(this.journal)) return [];
    let entries: Array<{ target: string; old: string | null; fresh: string | null }> = [];
    try { entries = JSON.parse(readFileSync(this.journal, 'utf8')) as typeof entries; } catch { /* unreadable: nothing to redo */ }
    const back: string[] = [];
    for (const e of entries) {
      try {
        if (e.old && existsSync(e.old)) { rmSync(e.target, { force: true, recursive: false }); renameSync(e.old, e.target); back.push(e.target); }
        else if (!e.old && e.fresh && !existsSync(e.fresh) && existsSync(e.target)) rmSync(e.target, { force: true });
        if (e.fresh && existsSync(e.fresh)) rmSync(e.fresh, { force: true });
      } catch { /* keep going: the rest still goes back */ }
    }
    rmSync(this.journal, { force: true });
    return back;
  }

  path(ticketId: number): string { return join(this.baseDir, 'ticket-' + ticketId); }
  branch(ticketId: number): string { return this.branchPrefix + 'ticket-' + ticketId; }
  private baseFile(ticketId: number): string { return join(this.baseDir, 'ticket-' + ticketId + '.base'); }
  private bigFile(ticketId: number): string { return join(this.baseDir, 'ticket-' + ticketId + '.big.json'); }
  /** The private snapshot store, made the first time. */
  private store(): void {
    if (existsSync(join(this.mirror, 'HEAD'))) return;
    mkdirSync(this.mirror, { recursive: true });
    execFileSync('git', ['init', '--bare', '--quiet', this.mirror], { windowsHide: true, stdio: 'ignore' });
    // Files are kept byte for byte: no line-ending changes on the way in or out.
    execFileSync('git', ['--git-dir', this.mirror, 'config', 'core.autocrlf', 'false'], { windowsHide: true, stdio: 'ignore' });
  }

  /** The big files the ticket started with (linked in, not copied). */
  big(ticketId: number): BigFile[] {
    try { return JSON.parse(readFileSync(this.bigFile(ticketId), 'utf8')) as BigFile[]; } catch { return []; }
  }

  /** The project's big files (its gitignore rules and build leftovers respected), kept out of the snapshot store. */
  private bigFiles(): Array<{ path: string; size: number; mtimeMs: number }> {
    if (!existsSync(join(this.mirror, 'HEAD'))) return [];
    // The store's exclude list holds the big files found last time: cleared first, so those are found again rather
    // than slipping into the snapshot as ordinary files (C3 review, finding 13).
    mkdirSync(join(this.mirror, 'info'), { recursive: true });
    writeFileSync(join(this.mirror, 'info', 'exclude'), '');
    const listed = execFileSync('git', ['--git-dir', this.mirror, '--work-tree', this.repoRoot, '-c', 'core.quotepath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.', ...artifactSpecs, ...artifactFiles],
      { windowsHide: true, maxBuffer: 64 << 20, env: { ...process.env, GIT_INDEX_FILE: join(this.mirror, 'big-index') } }).toString().split('\0').filter(Boolean);
    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const p of new Set(listed)) {
      try { const s = statSync(join(this.repoRoot, p)); if (s.isFile() && s.size >= BIG_FILE) out.push({ path: p, size: s.size, mtimeMs: s.mtimeMs }); } catch { /* gone */ }
    }
    return out;
  }

  /** The commit the ticket started from. */
  base(ticketId: number): string | null {
    try { return readFileSync(this.baseFile(ticketId), 'utf8').trim() || null; } catch { /* older ticket, below */ }
    // A ticket folder made before starting points were recorded (a worktree of the project's own repository): it
    // started at its branch's commit, as long as the gremlin did not commit (they report, they do not commit).
    const dir = this.path(ticketId);
    if (!existsSync(join(dir, '.git'))) return null;
    try { return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch { return null; }
  }

  ensure(ticketId: number): string {
    const dir = this.path(ticketId);
    // A ticket opened again (rework, an answer, a retry) holds its big files again (1.0 review, finding 2).
    if (existsSync(join(dir, '.git'))) { this.lock(ticketId); return dir; }
    if (!existsSync(this.repoRoot)) throw new Error('V8_PROJECT_MISSING');
    mkdirSync(this.baseDir, { recursive: true });
    const branch = this.branch(ticketId);
    this.store(); // the store must exist before the big files are listed against it
    const bigs = this.bigFiles();
    // Big files stay out of the store, written as the store's own ignore list: neither the snapshot nor any ticket
    // folder takes them in.
    mkdirSync(join(this.mirror, 'info'), { recursive: true });
    writeFileSync(join(this.mirror, 'info', 'exclude'), bigs.map(b => ignoreLine(b.path)).join('\n') + '\n');
    const start = this.snapshot();
    const git = (...args: string[]) => execFileSync('git', ['--git-dir', this.mirror, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 << 20 }).toString();
    let exists = true;
    try { git('rev-parse', '--verify', '--quiet', 'refs/heads/' + branch); } catch { exists = false; }
    if (exists) git('worktree', 'add', dir, branch);
    else git('worktree', 'add', '-b', branch, dir, start);
    if (!this.base(ticketId)) writeFileSync(this.baseFile(ticketId), exists ? git('merge-base', branch, start).trim() : start);
    // Each big file is linked into the ticket folder (copied only where a link cannot be made, as across drives).
    const kept: BigFile[] = [];
    for (const b of bigs) {
      const from = join(this.repoRoot, b.path), to = join(dir, b.path);
      if (!inside(dir, to) || existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      let linked = true;
      try { linkSync(from, to); } catch { linked = false; copyFileSync(from, to); }
      kept.push({ ...b, linked });
    }
    writeFileSync(this.bigFile(ticketId), JSON.stringify(kept));
    this.lock(ticketId);
    return dir;
  }

  /** The linked big files of a ticket, read-only while it is open (the project's copy too: it is the same file). */
  lock(ticketId: number): void {
    // Kept as a mark beside the ticket, so a file shared by several open tickets is known to be held (1.0 review, 2).
    if (this.big(ticketId).some(b => b.linked)) { mkdirSync(this.baseDir, { recursive: true }); writeFileSync(this.lockFile(ticketId), ''); }
    for (const b of this.big(ticketId)) if (b.linked) { try { chmodSync(join(this.path(ticketId), b.path), 0o444); } catch { /* gone */ } }
  }

  /** Writable again: the ticket is done or stopped. A file another open ticket also holds stays read-only. */
  release(ticketId: number): void {
    rmSync(this.lockFile(ticketId), { force: true });
    const held = new Set<string>();
    for (const n of this.lockedTickets()) for (const b of this.big(n)) if (b.linked) held.add(b.path);
    for (const b of this.big(ticketId)) if (b.linked && !held.has(b.path)) { try { chmodSync(join(this.path(ticketId), b.path), 0o666); } catch { /* gone */ } }
  }

  private lockFile(ticketId: number): string { return join(this.baseDir, 'ticket-' + ticketId + '.locked'); }

  /** The tickets whose linked big files are held now. */
  private lockedTickets(): number[] {
    try { return readdirSync(this.baseDir).map(n => /^ticket-(\d+)\.locked$/.exec(n)?.[1]).filter((n): n is string => !!n).map(Number); } catch { return []; }
  }

  /**
   * Record the folder as it is now in the private store and return that commit. Uses its own index file, so the
   * project folder is only read. Build leftovers and the folder's own .gitignore rules are left out.
   */
  /**
   * After an accept refused for a conflict (1.0 review, finding 13): the ticket's copy catches up with the project as
   * it is now. A file only the project changed takes the project's version; a file both changed keeps the gremlin's,
   * with the project's version beside it under .beastie-merge/ (left out of every diff and accept) for the gremlin to
   * merge. The starting point becomes the project now, so the next accept sees only the gremlin's own work.
   */
  catchUp(ticketId: number): { taken: string[]; both: string[] } {
    const dir = this.path(ticketId), base = this.base(ticketId);
    if (!base || !existsSync(dir)) throw new Error('V8_TICKET_NO_WORKSPACE');
    const mine = new Set(this.changes(ticketId).map(c => c.path));
    const now = this.snapshot();
    const out = execFileSync('git', ['--git-dir', this.mirror, '-c', 'core.quotepath=false', 'diff', base, now, '--name-status', '--no-renames', '-z'],
      { windowsHide: true, maxBuffer: 16 << 20 }).toString().split('\0').filter(Boolean);
    const taken: string[] = [], both: string[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      const status = out[i]![0], p = out[i + 1]!;
      const here = join(dir, p), there = join(this.repoRoot, p);
      if (!inside(dir, here) || !inside(this.repoRoot, there)) continue;
      if (!mine.has(p)) {
        if (status === 'D') rmSync(here, { force: true });
        else { mkdirSync(dirname(here), { recursive: true }); copyFileSync(there, here); }
        taken.push(p);
      } else {
        both.push(p);
        if (status !== 'D') { const beside = join(dir, MERGE_DIR, p); mkdirSync(dirname(beside), { recursive: true }); copyFileSync(there, beside); }
      }
    }
    writeFileSync(this.baseFile(ticketId), now);
    return { taken, both };
  }

  private snapshot(): string {
    const env = { ...process.env, GIT_INDEX_FILE: join(this.mirror, 'snapshot-index') };
    const run = (args: string[], input?: string) => execFileSync('git', [...SNAPSHOT_AUTHOR, '--git-dir', this.mirror, '--work-tree', this.repoRoot, ...args],
      { env, input, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 << 20 }).toString().trim();
    this.store();
    run(['add', '-A', '--', '.', ...artifactSpecs, ...artifactFiles]);
    const tree = run(['write-tree']);
    let parent: string | null = null;
    try { parent = run(['rev-parse', '--verify', '--quiet', 'refs/snapshots/latest']); } catch { parent = null; }
    if (parent && run(['rev-parse', parent + '^{tree}']) === tree) return parent;
    const commit = run(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'snapshot']);
    run(['update-ref', 'refs/snapshots/latest', commit]);
    return commit;
  }

  /** Files the gremlin added, changed or removed, compared with where the ticket started (build leftovers excluded). */
  changes(ticketId: number): Array<{ status: 'A' | 'M' | 'D'; path: string }> {
    const dir = this.path(ticketId), base = this.base(ticketId);
    if (!base || !existsSync(dir)) return [];
    execFileSync('git', ['-C', dir, 'add', '-A', '--intent-to-add', '--', '.', ...artifactSpecs, ...artifactFiles], { windowsHide: true, stdio: 'ignore' });
    const out = execFileSync('git', ['-C', dir, '-c', 'core.quotepath=false', 'diff', base, '--name-status', '--no-renames', '-z', '--', '.', ...artifactSpecs, ...artifactFiles],
      { windowsHide: true, maxBuffer: 16 << 20 }).toString();
    const parts = out.split('\0').filter(Boolean), list: Array<{ status: 'A' | 'M' | 'D'; path: string }> = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const s = parts[i][0];
      if (s === 'A' || s === 'M' || s === 'D') list.push({ status: s, path: parts[i + 1] });
      else if (s === 'T') list.push({ status: 'M', path: parts[i + 1] });
    }
    // Big files the ticket started with: removed, or replaced or rewritten (size or time changed).
    for (const b of this.big(ticketId)) {
      let s; try { s = statSync(join(dir, b.path)); } catch { s = null; }
      if (!s) list.push({ status: 'D', path: b.path });
      else if (s.size !== b.size || s.mtimeMs !== b.mtimeMs) list.push({ status: 'M', path: b.path });
    }
    return list;
  }

  /**
   * Put the ticket's work into the project: each changed file is copied in, each removed file removed. All or
   * nothing: if any file's copy in the project is no longer what the ticket started from (the boss edited it, or
   * another ticket's accepted work did), nothing is put in and those files are reported, so no one's work is
   * overwritten and the project is never left half-changed. Nothing is committed in the boss's repository.
   */
  apply(ticketId: number): ApplyResult {
    const dir = this.path(ticketId), base = this.base(ticketId);
    if (!base) throw new Error('V8_TICKET_NO_WORKSPACE');
    // The starting version as it looks when checked out (line endings included), to compare with the file on disk.
    const fromBase = (p: string): Buffer | null => {
      try { return execFileSync('git', ['-C', dir, 'cat-file', '--filters', `${base}:${p}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 30 }); } catch { return null; }
    };
    const current = (p: string): Buffer | null => { try { return readFileSync(join(this.repoRoot, p)); } catch { return null; } };
    // Line endings alone do not make a file different: git may check a file out with CRLF while the copy on disk
    // (written by an editor) has LF, or the other way round. Binary files (with a NUL byte) are compared exactly.
    const lf = (b: Buffer) => (b.includes(0) ? b : Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));
    const same = (a: Buffer | null, b: Buffer | null) => a === b || (a !== null && b !== null && (a.equals(b) || lf(a).equals(lf(b))));
    const bigs = new Map(this.big(ticketId).map(b => [b.path, b]));
    const statOf = (p: string) => { try { return statSync(p); } catch { return null; } };
    const plan = this.changes(ticketId).map(c => {
      const target = join(this.repoRoot, c.path);
      if (!inside(this.repoRoot, target)) return { ...c, target, wanted: null as Buffer | null, ok: false, byFile: false };
      const mine = statOf(join(dir, c.path)), theirs = statOf(target), started = bigs.get(c.path);
      if (started || (mine && mine.size >= BIG_FILE)) {
        // A big file, never read into memory: fine when the project's copy is untouched since the ticket started (or
        // absent, for a new one), or is the very same file (a rewrite through the link has already landed).
        const sameFile = !!mine && !!theirs && mine.ino === theirs.ino && mine.dev === theirs.dev;
        const ok = sameFile || (started ? !!theirs && theirs.size === started.size && theirs.mtimeMs === started.mtimeMs : !theirs);
        return { ...c, target, wanted: null as Buffer | null, ok, byFile: !sameFile };
      }
      // A folder where the file should go cannot be replaced by it: a conflict, nothing goes in.
      if (theirs?.isDirectory()) return { ...c, target, wanted: null as Buffer | null, ok: false, byFile: false };
      const now = current(c.path), was = fromBase(c.path);
      const wanted = c.status === 'D' ? null : readFileSync(join(dir, c.path));
      // Untouched since the ticket started, or already exactly what the gremlin made.
      return { ...c, target, wanted, ok: same(now, was) || same(now, wanted), byFile: false };
    });
    const result: ApplyResult = { applied: [], conflicts: plan.filter(c => !c.ok).map(c => c.path) };
    if (result.conflicts.length) return result;
    // All or nothing (C3 review, finding 3). First every new version is written beside its target; nothing in the
    // project has changed yet, so a failure here (a full disk) just cleans up. Then each target is swapped: its old
    // version renamed aside, the new one renamed in. A failure there puts back every old version swapped so far.
    const tag = '.beastie-' + process.pid + '-' + Date.now().toString(36);
    const staged: Array<{ target: string; fresh: string | null; old: string | null; path: string; keep?: boolean }> = [];
    try {
      for (const c of plan) {
        if (c.status === 'D') { staged.push({ target: c.target, fresh: null, old: null, path: c.path }); continue; }
        // Already the very file the gremlin made (a big file changed through its link): nothing to write.
        if (!c.byFile && c.wanted === null) { staged.push({ target: c.target, fresh: null, old: null, path: c.path, keep: true }); continue; }
        mkdirSync(dirname(c.target), { recursive: true });
        const fresh = c.target + tag + '.new';
        if (c.byFile) copyFileSync(join(dir, c.path), fresh);
        else writeFileSync(fresh, c.wanted ?? Buffer.alloc(0));
        staged.push({ target: c.target, fresh, old: null, path: c.path });
      }
    } catch (err) {
      for (const st of staged) if (st.fresh) rmSync(st.fresh, { force: true });
      throw err;
    }
    // Written down before anything in the project moves, so recoverAccept can undo a swap cut short by a crash.
    for (const st of staged) if (!st.keep && existsSync(st.target)) st.old = st.target + tag + '.old';
    mkdirSync(dirname(this.journal), { recursive: true });
    writeFileSync(this.journal, JSON.stringify(staged.filter(st => !st.keep).map(st => ({ target: st.target, old: st.old, fresh: st.fresh }))));
    const swapped: typeof staged = [];
    try {
      for (const st of staged) {
        if (st.keep) continue;
        if (st.old) renameSync(st.target, st.old);
        swapped.push(st);
        if (st.fresh) renameSync(st.fresh, st.target);
      }
    } catch (err) {
      // Put back what was swapped; a step that fails is said, never swallowed, and the journal stays so the next
      // start tries again (1.0 review, finding 4).
      const stuck: string[] = [];
      for (const st of swapped.reverse()) {
        try { if (st.fresh && existsSync(st.target) && !existsSync(st.fresh)) rmSync(st.target, { force: true }); } catch { stuck.push(st.path); }
        try { if (st.old) renameSync(st.old, st.target); } catch { stuck.push(st.path); }
      }
      for (const st of staged) if (st.fresh) { try { rmSync(st.fresh, { force: true }); } catch { /* a leftover beside the file */ } }
      if (stuck.length) throw new Error(tr('收下中途出错，有几个文件没能放回原样（{0}），下次打开程序会再放回一次。原因：', [stuck.join(tr('、'))]) + (err instanceof Error ? err.message : String(err)));
      rmSync(this.journal, { force: true });
      throw err;
    }
    rmSync(this.journal, { force: true });
    // Everything is in place; an old version that cannot be removed is only a leftover, not a failure.
    for (const st of staged) { if (st.old) { try { rmSync(st.old, { force: true }); } catch { /* left behind */ } } result.applied.push(st.path); }
    return result;
  }

  /**
   * What the gremlin changed in the ticket's worktree compared with where it started, new files included, without
   * build and test leftovers. Unified diff text, cut at `maxChars`.
   */
  diff(ticketId: number, o: { context?: number; maxChars?: number } = {}): string {
    const dir = this.path(ticketId);
    const max = o.maxChars ?? 30000;
    try {
      // Big files, the ticket's old ones and new ones it made, are described in a line, never shown byte by byte.
      const bigs = this.big(ticketId);
      const mb = (n: number) => (n / 1048576).toFixed(0) + ' MB';
      const sizeIn = (p: string) => { try { return statSync(join(dir, p)).size; } catch { return 0; } };
      const bigLines: string[] = [], skip: string[] = [];
      for (const c of this.changes(ticketId)) {
        const b = bigs.find(x => x.path === c.path);
        if (b) bigLines.push(c.status === 'D' ? tr('大文件 {0}（{1}）：删掉了', [c.path, mb(b.size)])
          : tr('大文件 {0}（原来 {1}）：换成了新的一份{2}', [c.path, mb(b.size), b.linked ? tr('；如果是在原文件上直接改的，改动已经在项目里了') : '']));
        else if (c.status !== 'D' && sizeIn(c.path) >= BIG_FILE) {
          bigLines.push(tr('大文件 {0}（{1}）：{2}', [c.path, mb(sizeIn(c.path)), c.status === 'A' ? tr('新做的') : tr('改了')]));
          skip.push(':(exclude,literal)' + c.path);
        }
      }
      // Make new files visible to `git diff` without staging their content.
      execFileSync('git', ['-C', dir, 'add', '-A', '--intent-to-add', '--', '.', ...artifactSpecs, ...artifactFiles], { windowsHide: true, stdio: 'ignore' });
      const out = execFileSync('git', ['-C', dir, 'diff', this.base(ticketId) ?? 'HEAD', '--no-color', '--unified=' + (o.context ?? 3), '--', '.', ...artifactSpecs, ...artifactFiles, ...skip],
        { windowsHide: true, maxBuffer: 8 << 20 }).toString();
      const text = (bigLines.length ? bigLines.join('\n') + '\n\n' : '') + out;
      return text.length > max ? text.slice(0, max) + tr('\n…（改动太长，后面省略）') : text;
    } catch { return ''; }
  }
}

/** True when `target` is `root` or inside it, after resolving `..` and symlinks of the parts that exist. */
export function inside(root: string, target: string): boolean {
  // A path that does not exist yet is judged by its nearest existing folder, links followed, so a new file under a
  // linked folder cannot land outside (1.0 review, finding 1).
  const real = (p: string) => {
    let at = resolve(p), rest = '';
    for (;;) {
      try { return rest ? join(realpathSync(at), rest) : realpathSync(at); } catch { /* not there yet */ }
      const up = dirname(at);
      if (up === at) return resolve(p);
      rest = rest ? join(basename(at), rest) : basename(at);
      at = up;
    }
  };
  const r = relative(real(root), real(resolve(root, target)));
  return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
}
