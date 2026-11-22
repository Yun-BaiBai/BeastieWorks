import { tr } from '../../shared/i18n';
import { rmTree } from './rmTree';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run } from './acpRegistry';
import type { SkillToolView } from '../../shared/v8/skills';

/**
 * The command-line tools behind the skills that ship with the app (A5): agent-browser and agent-desktop from npm,
 * agent-reach with uv (its own install guide), find-skills through npx.
 *
 * - Installed into the app's own folder (<data>/v8/tools), never globally. A small launcher per tool goes in
 *   <data>/v8/tools/bin, which is put on PATH when the app starts, so every agent the app starts finds the tools.
 * - A computer without Node.js (most friends'): `node`, `npm` and `npx` launchers in the same folder run the app's own
 *   Electron as Node and the npm that ships with the app (老板 2026-11-17). They are written only when the computer
 *   has none of its own.
 * - A tool already on this computer (the boss's own install) is used as it is.
 * - Nothing is downloaded before the person has seen the size and pressed the button.
 */

export interface ToolDef {
  /** The skill it belongs to (the skill's folder name). */
  skill: string;
  /** The command the skill tells an agent to run. */
  command: string;
  kind: 'npm' | 'uv' | 'npx';
  /** npm: the package; uv: what `uv tool install` gets. */
  source?: string;
  /** Said with the size, before installing. */
  note?: string;
}

export const SHIPPED_TOOLS: ToolDef[] = [
  { skill: 'agent-browser', command: 'agent-browser', kind: 'npm', source: 'agent-browser',
    get note() { return tr('第一次用时它还要另下一个专用 Chrome（agent-browser install），小怪会先问你'); } },
  { skill: 'agent-desktop', command: 'agent-desktop', kind: 'npm', source: 'agent-desktop' },
  { skill: 'agent-reach', command: 'agent-reach', kind: 'uv', source: 'https://github.com/Panniantong/Agent-Reach/releases/latest/download/agent-reach.zip',
    get note() { return tr('按 Agent Reach 自己的说明用 uv 装；装好后各平台怎么接，小怪用到时照技能说明做'); } },
  { skill: 'find-skills', command: 'npx', kind: 'npx' },
];

const WIN = process.platform === 'win32';

export class SkillTools {
  constructor(private readonly o: {
    /** <data>/v8/tools */
    dir: string;
    /** The program that runs as Node (the app's Electron) and the environment it needs. */
    node: { command: string; env?: Record<string, string> };
    /** npm's own cli.js shipped with the app, when there is one. */
    npmCli?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  }) {}

  get binDir(): string { return path.join(this.o.dir, 'bin'); }
  private get npmDir(): string { return path.join(this.o.dir, 'npm'); }
  private env(): NodeJS.ProcessEnv { return this.o.env ?? process.env; }

  /** PATH with the tools' folder first (for process.env at start). */
  pathWithTools(): { key: string; value: string } {
    const env = this.env();
    const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
    const dirs = (env[key] ?? '').split(path.delimiter).filter(d => d && path.resolve(d) !== path.resolve(this.binDir));
    return { key, value: [this.binDir, ...dirs].join(path.delimiter) };
  }

  /** Where `command` is on this computer's PATH, leaving out the app's own tool folder. */
  onPath(command: string): string | null {
    const env = this.env();
    const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
    const exts = WIN ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
    for (const d of (env[key] ?? '').split(path.delimiter)) {
      if (!d || path.resolve(d) === path.resolve(this.binDir)) continue;
      for (const e of exts) { const f = path.join(d, command + e.toLowerCase()); if (existsSync(f)) return f; }
    }
    return null;
  }

  private launcher(name: string, program: string, args: string[], env: Record<string, string> = {}): void {
    mkdirSync(this.binDir, { recursive: true });
    if (WIN) {
      const sets = Object.entries(env).map(([k, v]) => `set "${k}=${v}"\r\n`).join('');
      writeFileSync(path.join(this.binDir, name + '.cmd'), `@echo off\r\nsetlocal\r\n${sets}"${program}" ${args.map(a => `"${a}"`).join(' ')} %*\r\n`);
    } else {
      const file = path.join(this.binDir, name);
      const sets = Object.entries(env).map(([k, v]) => `${k}='${v}' `).join('');
      writeFileSync(file, `#!/bin/sh\n${sets}exec '${program}' ${args.map(a => `'${a}'`).join(' ')} "$@"\n`);
      chmodSync(file, 0o755);
    }
  }

  private launcherFile(name: string): string { return path.join(this.binDir, WIN ? name + '.cmd' : name); }

  /** node, npm and npx launchers, for a computer that has none of its own. */
  ensureBasics(): void {
    const asNode = this.o.node.env ?? {};
    if (!this.onPath('node')) this.launcher('node', this.o.node.command, [], asNode);
    if (this.o.npmCli && existsSync(this.o.npmCli)) {
      const npx = path.join(path.dirname(this.o.npmCli), 'npx-cli.js');
      if (!this.onPath('npm')) this.launcher('npm', this.o.node.command, [this.o.npmCli], asNode);
      if (!this.onPath('npx') && existsSync(npx)) this.launcher('npx', this.o.node.command, [npx], asNode);
    }
  }

  private installedVersion(def: ToolDef): string | null {
    if (def.kind === 'uv') return existsSync(path.join(this.binDir, WIN ? def.command + '.exe' : def.command)) ? '?' : null;
    if (def.kind !== 'npm' || !existsSync(this.launcherFile(def.command))) return null;
    try { return (JSON.parse(readFileSync(path.join(this.npmDir, 'node_modules', def.source!, 'package.json'), 'utf8')) as { version?: string }).version ?? '?'; }
    catch { return null; }
  }

  view(): SkillToolView[] {
    return SHIPPED_TOOLS.map((def): SkillToolView => {
      const base = { skill: def.skill, command: def.command, note: def.note ?? null };
      const ours = this.installedVersion(def);
      if (ours) return { ...base, state: 'installed', version: ours };
      if (def.kind === 'npx') return { ...base, state: this.onPath('npx') || existsSync(this.launcherFile('npx')) ? 'ready' : 'missing_basics', version: null };
      if (this.onPath(def.command)) return { ...base, state: 'on_computer', version: null };
      if (def.kind === 'uv' && !this.onPath('uv')) return { ...base, state: 'needs_uv', version: null };
      return { ...base, state: 'not_installed', version: null };
    });
  }

  private def(skill: string): ToolDef {
    const d = SHIPPED_TOOLS.find(t => t.skill === skill);
    if (!d) throw new Error(tr('这个技能没有要装的工具。'));
    return d;
  }

  /** How much installing downloads, asked before downloading anything. Null bytes: the server did not say. */
  async size(skill: string): Promise<{ bytes: number | null; kind: 'package' | 'archive'; from: string; note?: string }> {
    const def = this.def(skill), f = this.o.fetchImpl ?? fetch, note = def.note ? { note: def.note } : {};
    if (def.kind === 'npm') {
      let bytes: number | null = null;
      try {
        const res = await f(`https://registry.npmjs.org/${def.source}/latest`, { signal: AbortSignal.timeout(15000) });
        const n = res.ok ? Number(((await res.json()) as { dist?: { unpackedSize?: unknown } }).dist?.unpackedSize) : NaN;
        if (Number.isFinite(n) && n > 0) bytes = n;
      } catch { /* unknown */ }
      return { bytes, kind: 'package', from: 'registry.npmjs.org', ...note };
    }
    if (def.kind === 'uv') {
      let bytes: number | null = null;
      try {
        const res = await f(def.source!, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) });
        const n = Number(res.headers.get('content-length'));
        if (res.ok && Number.isFinite(n) && n > 0) bytes = n;
      } catch { /* unknown */ }
      // uv also fetches the Python packages agent-reach depends on (and a Python if the computer has none).
      return { bytes, kind: 'package', from: 'github.com', ...note };
    }
    throw new Error(tr('这个工具不用装。'));
  }

  async install(skill: string): Promise<SkillToolView[]> {
    const def = this.def(skill);
    this.ensureBasics();
    // Children see the tools' folder (npm runs install scripts with `node`).
    const p = this.pathWithTools(), env = { [p.key]: p.value };
    if (def.kind === 'npm') {
      mkdirSync(this.npmDir, { recursive: true });
      const args = ['install', '--prefix', this.npmDir, '--no-audit', '--no-fund', '--no-save', def.source!];
      if (this.o.npmCli) await run(this.o.node.command, [this.o.npmCli, ...args], this.npmDir, { ...(this.o.node.env ?? {}), ...env });
      else await run(WIN ? 'npm.cmd' : 'npm', args, this.npmDir, env);
      const dir = path.join(this.npmDir, 'node_modules', def.source!);
      const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[def.command] ?? (manifest.bin ? Object.values(manifest.bin)[0] : undefined);
      if (!bin) throw new Error(tr('装上了，但找不到它的启动文件。'));
      const script = path.resolve(dir, bin);
      // agent-desktop's bin is a Node script without the .js ending; both run as Node.
      this.launcher(def.command, this.o.node.command, [script], this.o.node.env ?? {});
    } else if (def.kind === 'uv') {
      const uv = this.onPath('uv');
      if (!uv) throw new Error(tr('要先装 uv（Agent Reach 用它装）。'));
      // Into the app's own folder, not uv's usual place, and never over an install of the person's own (C3 review,
      // finding 16): the tool goes in <tools>/uv and its launcher beside the others.
      await run(uv, ['tool', 'install', def.source!], this.o.dir, { ...env, UV_TOOL_DIR: path.join(this.o.dir, 'uv'), UV_TOOL_BIN_DIR: this.binDir });
    } else throw new Error(tr('这个工具不用装。'));
    return this.view();
  }

  /** Remove a tool the app installed (only those: one already on the computer is not the app's to remove). */
  remove(skill: string): SkillToolView[] {
    const def = this.def(skill);
    if (def.kind !== 'npm' || !this.installedVersion(def)) throw new Error(tr('这个工具不是小怪工坊装的，不在这里卸。'));
    rmSync(this.launcherFile(def.command), { force: true });
    rmTree(path.join(this.npmDir, 'node_modules', def.source!));
    return this.view();
  }
}
