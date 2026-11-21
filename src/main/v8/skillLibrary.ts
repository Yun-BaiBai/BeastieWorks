import { tr } from '../../shared/i18n';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fetchSkillFromSource, toSkillSlug, writeSkillFolder } from './skillFetch';
import path from 'node:path';
import { parseSkillFrontmatter } from './skillFrontmatter';
import { rankSkills } from './skillFit';
import type { HostTool } from './shell';
import type { LibrarySkill, SkillLibraryView } from '../../shared/v8/skills';

/**
 * The app's own skill library (第 6 步, requirements 10, 11, 41, 49, 50).
 *
 * - The skills are read from folders on this computer (by default the folders agents share, ~/.agents/skills and ~/.claude/skills): every
 *   sub-folder holding a SKILL.md. Nothing is copied; the library points at them.
 * - A skill starts switched off; the boss switches it on (requirement 49). Only switched-on skills reach a gremlin.
 * - A gremlin is told the names of a few skills that fit its ticket (ranked by OpenMausBot's skill-fit, no model) and
 *   gets two tools: list_skills (names and one line each, any time) and use_skill (the full text, when it needs it).
 *   Each full-text fetch counts as one use (requirement 41: unused skills can be seen and dropped).
 * - What the boss decided (on/off), the counts and the retold summaries live in one small file of the app's own.
 */

interface Kept {
  /** true on, false off. A skill with no entry: on when it ships with the app (A5), otherwise off. */
  enabled: Record<string, boolean>;
  uses: Record<string, { count: number; last: number }>;
  retold: Record<string, { text: string; agent: string; at: number }>;
  /** Skills of the shared folders the boss took out of the app's library (their files stay where they are). */
  removed: Record<string, true>;
  /** Where each imported skill came from. */
  sources: Record<string, string>;
}

interface Found { id: string; name: string; description: string; category: string | null; dir: string; imported: boolean; builtin: boolean }

const MAX_FILE = 200_000;

/** The headings of INDEX.md and the skill names listed under each ("- **name** — …"). */
export function indexCategories(md: string): Map<string, string> {
  const out = new Map<string, string>();
  let heading: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { heading = h[1]!; continue; }
    const s = /^\s*[-*]\s+\*\*([^*]+)\*\*/.exec(line);
    if (s && heading) out.set(s[1]!.trim(), heading);
  }
  return out;
}

export const SKILL_TOOLS: HostTool[] = [
  {
    name: 'list_skills',
    description: '看技能库里能用的技能：名字和一句话说明。可以带 about（要做的事），只看相关的。随时可以看。',
    parameters: { type: 'object', properties: { about: { type: 'string', description: '要做的事，几个词就行；不填就列出全部' } } },
  },
  {
    name: 'use_skill',
    description: '取一个技能的全文（SKILL.md），照着做。技能文件夹里还有别的文件时，会列出它们的名字，再用 file 取其中一个。',
    parameters: { type: 'object', properties: { name: { type: 'string' }, file: { type: 'string', description: '技能文件夹里另一个文件的相对路径，可不填' } }, required: ['name'] },
  },
];

export class SkillLibrary {
  private found: Found[] = [];
  private readAt = 0;

  constructor(private readonly o: {
    /** Folders whose sub-folders are skills. */
    roots: () => string[];
    /** The app's own file for on/off, counts and retold summaries. */
    stateFile: string;
    /** The app's own folder for skills brought in from GitHub (they can be deleted for real). */
    importRoot?: string;
    /**
     * Skills that ship with the app and the ones ego lite brings (A5), read after the other folders: a copy of the
     * same skill in the boss's own folders wins. These start switched on.
     */
    builtinRoots?: () => string[];
    clock?: () => number;
  }) {}

  private now(): number { return (this.o.clock ?? Date.now)(); }

  private kept(): Kept {
    try {
      const k = JSON.parse(readFileSync(this.o.stateFile, 'utf8')) as Partial<Kept>;
      return { enabled: k.enabled ?? {}, uses: k.uses ?? {}, retold: k.retold ?? {}, removed: k.removed ?? {}, sources: k.sources ?? {} };
    } catch { return { enabled: {}, uses: {}, retold: {}, removed: {}, sources: {} }; }
  }

  private keep(k: Kept): void {
    mkdirSync(path.dirname(this.o.stateFile), { recursive: true });
    const tmp = this.o.stateFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(k, null, 1));
    renameSync(tmp, this.o.stateFile);
  }

  /** Read the skill folders again (at most every few seconds). */
  private scan(force = false): Found[] {
    if (!force && this.now() - this.readAt < 5000 && this.found.length) return this.found;
    const out: Found[] = [];
    const removed = this.kept().removed;
    const builtin = new Set(this.o.builtinRoots?.() ?? []);
    const roots = [...(this.o.importRoot ? [this.o.importRoot] : []), ...this.o.roots().filter(r => !builtin.has(r)), ...builtin];
    for (const root of roots) {
      const imported = root === this.o.importRoot, shipped = builtin.has(root);
      let names: string[];
      try { names = readdirSync(root); } catch { continue; }
      let cats = new Map<string, string>();
      // The folder may be a link (~/.agents/skills often points at a shared library): look beside where it really is.
      let real = root;
      try { real = realpathSync(root); } catch { /* as given */ }
      for (const index of [path.join(real, 'INDEX.md'), path.join(real, '..', 'INDEX.md')]) {
        if (existsSync(index)) { try { cats = indexCategories(readFileSync(index, 'utf8')); } catch { /* none */ } break; }
      }
      for (const id of names.sort()) {
        const dir = path.join(root, id), file = path.join(dir, 'SKILL.md');
        if (out.some(s => s.id === id) || !existsSync(file) || (!imported && removed[id])) continue;
        let fm: { name?: string; description?: string } = {};
        try { fm = parseSkillFrontmatter(readFileSync(file, 'utf8').slice(0, 20_000)); } catch { continue; }
        const name = fm.name?.trim() || id;
        out.push({ id, name, description: (fm.description ?? '').trim(), category: imported ? tr('从网上导入') : shipped ? tr('自带') : cats.get(name) ?? cats.get(id) ?? null, dir, imported, builtin: shipped });
      }
    }
    this.found = out;
    this.readAt = this.now();
    return out;
  }

  view(): SkillLibraryView {
    const k = this.kept();
    return {
      roots: this.o.roots(),
      skills: this.scan(true).map((s): LibrarySkill => ({
        id: s.id, name: s.name, description: s.description, category: s.category,
        enabled: on(k, s), uses: k.uses[s.id]?.count ?? 0, lastUsed: k.uses[s.id]?.last ?? null, retold: k.retold[s.id] ?? null,
        imported: s.imported, source: k.sources[s.id] ?? null, builtin: s.builtin,
      })),
    };
  }

  /** Switch skills on or off. */
  setEnabled(ids: string[], on: boolean): void {
    const k = this.kept();
    for (const id of ids) k.enabled[id] = on;
    this.keep(k);
  }

  private enabled(): Found[] { const k = this.kept(); return this.scan().filter(s => on(k, s)); }

  /** The switched-on skills that fit a piece of work, best first. Everything switched on when `about` is empty. */
  fitting(about: string, max = 8): Array<{ name: string; description: string }> {
    const on = this.enabled();
    const ranked = about.trim() ? rankSkills(on, about) : on;
    return ranked.slice(0, max).map(s => ({ name: s.name, description: oneLine(s.description) }));
  }

  /** The lines a gremlin's brief gets: the names of the skills that fit, and how to get one. Empty when none fit. */
  briefLines(about: string): string[] {
    const fit = this.fitting(about, 6);
    if (!fit.length) {
      // The boss writes in Chinese and most skill descriptions are English, so word matching often finds nothing:
      // still say the library is there, with a few names.
      const on = this.enabled();
      if (!on.length) return [];
      return ['', `技能库里开着 ${on.length} 个技能（比如 ${on.slice(0, 6).map(s => s.name).join('、')}）。用得上就用 list_skills 看说明，用 use_skill 取全文再照做。`];
    }
    return ['', '技能库里可能用得上的技能（只给了名字；要用哪个，先用 use_skill 取全文再照做；list_skills 看全部）：', ...fit.map(s => `- ${s.name}：${s.description.slice(0, 80)}`)];
  }

  /** A gremlin's call to list_skills or use_skill. */
  call(name: string, args: unknown): { ok: true; text: string } | { ok: false; error: string } {
    const a = (args && typeof args === 'object' ? args : {}) as { about?: unknown; name?: unknown; file?: unknown };
    if (name === 'list_skills') {
      const list = this.fitting(typeof a.about === 'string' ? a.about : '', 40);
      return { ok: true, text: list.length ? list.map(s => tr('- {0}：{1}', [s.name, s.description])).join('\n') : tr('技能库里没有对得上的技能。') };
    }
    if (name !== 'use_skill') return { ok: false, error: tr('没有这个工具：') + name };
    const wanted = typeof a.name === 'string' ? a.name.trim() : '';
    const s = this.enabled().find(x => x.name === wanted || x.id === wanted);
    if (!s) return { ok: false, error: tr('技能库里没有能用的「{0}」。用 list_skills 看有哪些。', [wanted]) };
    const files = otherFiles(s.dir);
    let text: string;
    if (typeof a.file === 'string' && a.file.trim()) {
      const rel = a.file.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!files.includes(rel)) return { ok: false, error: tr('技能「{0}」里没有 {1}。有这些：{2}', [s.name, rel, files.join(tr('，')) || tr('没有别的文件')]) };
      text = readFileSync(path.join(s.dir, rel), 'utf8').slice(0, MAX_FILE);
    } else {
      text = readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8').slice(0, MAX_FILE);
      if (files.length) text += tr('\n\n---\n这个技能的文件夹里还有：{0}。要看哪个，用 use_skill 带 file 取。', [files.slice(0, 60).join(tr('，'))]);
    }
    const k = this.kept();
    k.uses[s.id] = { count: (k.uses[s.id]?.count ?? 0) + 1, last: this.now() };
    this.keep(k);
    return { ok: true, text };
  }

  /** The full text of one skill, for the boss's "让 agent 复述" (any skill, on or off). */
  text(id: string): string {
    const s = this.scan().find(x => x.id === id);
    if (!s) throw new Error('V8_SKILL_NOT_FOUND');
    return readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8').slice(0, MAX_FILE);
  }

  /**
   * Drop a skill (requirement 41). One brought in from GitHub is deleted with its folder; one of the shared folders is
   * only taken out of this app's library, because other programs use those folders too.
   */
  remove(id: string): 'deleted' | 'taken-out' {
    const s = this.scan(true).find(x => x.id === id);
    if (!s) throw new Error('V8_SKILL_NOT_FOUND');
    const k = this.kept();
    delete k.enabled[id]; delete k.uses[id]; delete k.retold[id]; delete k.sources[id];
    if (s.imported) { rmSync(s.dir, { recursive: true, force: true }); this.keep(k); this.scan(true); return 'deleted'; }
    k.removed[id] = true;
    this.keep(k);
    this.scan(true);
    return 'taken-out';
  }

  /** Put back every skill of the shared folders that was taken out. */
  restoreRemoved(): number {
    const k = this.kept();
    const n = Object.keys(k.removed).length;
    k.removed = {};
    this.keep(k);
    this.scan(true);
    return n;
  }

  /**
   * Bring skills in from a GitHub link (OpenMausBot's skill-fetch: read at one commit, every file checked against it).
   * They land in the app's own folder, switched off until the boss switches them on (requirement 49).
   */
  async importFrom(link: string, fetcher: typeof fetch = fetch): Promise<{ added: string[]; skipped: string[] } | { error: string }> {
    if (!this.o.importRoot) return { error: tr('这个技能库没有导入用的文件夹') };
    const got = await fetchSkillFromSource(link, fetcher);
    if ('error' in got) return got;
    mkdirSync(this.o.importRoot, { recursive: true });
    const k = this.kept();
    const taken = new Set(this.scan(true).map(s => s.id));
    const added: string[] = [], skipped: string[] = [];
    for (const skill of got.skills) {
      const skillMd = skill.files.find(f => f.path === 'SKILL.md');
      if (!skillMd) continue;
      const fm = parseSkillFrontmatter(skillMd.content.toString('utf8').slice(0, 20_000));
      const base = toSkillSlug(fm.name || skill.github?.path.split('/').at(-1) || skill.github?.repo || 'skill') || 'skill';
      let id = base;
      for (let i = 2; taken.has(id) || existsSync(path.join(this.o.importRoot, id)); i++) id = base + '-' + i;
      writeSkillFolder(path.join(this.o.importRoot, id), skill.files);
      taken.add(id);
      k.sources[id] = skill.source;
      added.push(fm.name || id);
      skipped.push(...skill.skipped.map(x => x.path || tr('SKILL.md 之外的文件')));
    }
    this.keep(k);
    this.scan(true);
    return { added, skipped };
  }

  saveRetold(id: string, agent: string, text: string): void {
    const k = this.kept();
    k.retold[id] = { text: text.trim().slice(0, 4000), agent, at: this.now() };
    this.keep(k);
  }
}

/** Switched on: what the boss chose, else on for a skill that ships with the app. */
function on(k: Kept, s: Found): boolean { return k.enabled[s.id] ?? s.builtin; }

function oneLine(s: string): string { return s.replace(/\s+/g, ' ').trim().slice(0, 240); }

/** Text files in a skill's folder besides SKILL.md, relative, at most three folders down. */
function otherFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      if (n.startsWith('.') || n === 'node_modules') continue;
      const p = path.join(d, n), r = rel ? rel + '/' + n : n;
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 3) walk(p, r, depth + 1); }
      else if (r !== 'SKILL.md' && st.size <= MAX_FILE && /\.(md|txt|json|ya?ml|py|js|ts|mjs|cjs|sh|ps1|html|css|csv)$/i.test(n)) out.push(r);
      if (out.length >= 200) return;
    }
  };
  walk(dir, '', 0);
  return out;
}

/** retell prompt: what an agent is asked when the boss wants a skill retold. */
export function retellPrompt(skillText: string): string {
  return ['下面是一个技能的全文。用三到五句简体中文大白话复述：它现在是做什么的、什么时候该用、具体怎么做。只复述，不评价，不加原文没有的内容。', '', '---', skillText].join('\n');
}
