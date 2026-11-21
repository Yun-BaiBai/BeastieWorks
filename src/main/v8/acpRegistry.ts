import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AcpShellOptions } from './acpShell';

/**
 * The official ACP Registry: the public list of agents that speak ACP, with how each is installed and started.
 * Reading it is how the app knows every common agent without a line of code per agent.
 *
 * - The list is fetched from the registry's CDN, kept as a file, and read from that file when offline. A copy that
 *   ships with the app is the last resort.
 * - An agent is installed into the app's own folder (never system-wide), from the address the registry gives:
 *   an archive checked against the registry's sha256, or an npm package.
 * - Signing in to an agent stays with the person, in that agent.
 *
 * The approach follows t3code's `provider-acp-registry` (MIT); that package is built on Effect and could not be
 * brought over as it is.
 */

export const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

interface BinaryTarget { archive: string; cmd: string; args?: string[]; env?: Record<string, string>; sha256?: string }
interface PackageTarget { package: string; args?: string[]; env?: Record<string, string> }
export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description?: string;
  website?: string;
  icon?: string;
  license?: string;
  distribution: { binary?: Record<string, BinaryTarget>; npx?: PackageTarget; uvx?: PackageTarget };
}
export interface Registry { version: string; agents: RegistryAgent[] }

export interface RegistryPaths {
  /** Where the fetched list is kept. */
  cacheFile: string;
  /** The copy that ships with the app. */
  bundledFile?: string;
  /** Where agents are installed, one folder per agent and version. */
  installRoot: string;
  /** A program that runs a JavaScript file: Electron as Node in the app, node in tests. */
  node: { command: string; env?: Record<string, string> };
  /** npm's own cli.js when the app ships one; otherwise the `npm` on PATH is used. */
  npmCli?: string;
}

function parse(text: string): Registry {
  const data = JSON.parse(text) as Partial<Registry>;
  if (!Array.isArray(data.agents)) throw new Error('ACP_REGISTRY_INVALID');
  const agents = data.agents.filter(a => a && typeof a.id === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(a.id) && typeof a.name === 'string' && typeof a.version === 'string' && a.distribution && typeof a.distribution === 'object');
  return { version: String(data.version ?? ''), agents };
}

/** The list: fresh from the CDN when it answers, otherwise the last kept copy, otherwise the one shipped with the app. */
export async function loadRegistry(p: RegistryPaths, fetchImpl: typeof fetch = fetch): Promise<{ registry: Registry; source: 'network' | 'cache' | 'bundled' }> {
  try {
    const res = await fetchImpl(ACP_REGISTRY_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const registry = parse(text);
    mkdirSync(path.dirname(p.cacheFile), { recursive: true });
    writeFileSync(p.cacheFile + '.tmp', text);
    renameSync(p.cacheFile + '.tmp', p.cacheFile);
    return { registry, source: 'network' };
  } catch { /* offline or the CDN is down: use what we have */ }
  if (existsSync(p.cacheFile)) { try { return { registry: parse(readFileSync(p.cacheFile, 'utf8')), source: 'cache' }; } catch { /* damaged */ } }
  if (p.bundledFile && existsSync(p.bundledFile)) return { registry: parse(readFileSync(p.bundledFile, 'utf8')), source: 'bundled' };
  throw new Error('ACP_REGISTRY_UNAVAILABLE');
}

export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  return `${os}-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
}

export type AgentAvailability =
  /** `version`: the one installed; `update`: a newer one the registry lists, or null. */
  | { state: 'ready'; launch: AcpShellOptions; version: string; update: string | null }
  | { state: 'not_installed'; how: 'binary' | 'npx' }
  | { state: 'unsupported'; reason: string };

const versionDir = (v: string) => v.replace(/[^A-Za-z0-9._-]/g, '_');
function agentDir(p: RegistryPaths, agent: RegistryAgent): string {
  return path.join(p.installRoot, agent.id, versionDir(agent.version));
}

/** Versions of this agent already in the app's folder, newest first (by modification time). */
export function installedVersions(p: RegistryPaths, agentId: string): string[] {
  const root = path.join(p.installRoot, agentId);
  let names: string[];
  try { names = readdirSync(root).filter(n => !n.endsWith('.staging') && !n.endsWith('.download')); } catch { return []; }
  return names.filter(n => { try { return statSync(path.join(root, n)).isDirectory(); } catch { return false; } })
    .sort((a, b) => statSync(path.join(root, b)).mtimeMs - statSync(path.join(root, a)).mtimeMs);
}

/** `@scope/name@1.2.3` or `name@1.2.3` → the name without the version. */
function packageName(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function packageLaunch(p: RegistryPaths, agent: RegistryAgent, target: PackageTarget): AcpShellOptions | null {
  const root = path.join(agentDir(p, agent), 'npm', 'node_modules'), dir = path.join(root, ...packageName(target.package).split('/'));
  let manifest: { bin?: string | Record<string, string> };
  try { manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as typeof manifest; } catch { return null; }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin ? Object.values(manifest.bin)[0] : undefined;
  if (!bin) return null;
  const script = path.resolve(dir, bin);
  if (!inside(dir, script) || !existsSync(script)) return null;
  return { label: agent.name, command: p.node.command, args: [script, ...(target.args ?? [])], env: { ...(p.node.env ?? {}), ...(target.env ?? {}) } };
}

function binaryLaunch(p: RegistryPaths, agent: RegistryAgent, target: BinaryTarget): AcpShellOptions | null {
  const dir = path.join(agentDir(p, agent), 'bin'), command = path.resolve(dir, target.cmd);
  if (!inside(dir, command) || !existsSync(command)) return null;
  return { label: agent.name, command, args: target.args ?? [], env: target.env };
}

/**
 * Agents installed from their npm package even where the official list also offers a single program. Claude
 * (老板 2026-11-20: the app no longer ships Claude Code; a friend installs it from the official source when they want
 * it): the package lays out the Claude program the way the app looks for it (findClaude) for sign-in and for Magpie.
 */
const FROM_PACKAGE = new Set(['claude-acp']);
function pickBinary(agent: RegistryAgent, key: string): BinaryTarget | undefined {
  return FROM_PACKAGE.has(agent.id) && agent.distribution.npx ? undefined : agent.distribution.binary?.[key];
}

/** Whether this agent can be started now, and if not, what installing it would take on this computer. */
export function availability(p: RegistryPaths, agent: RegistryAgent, key = platformKey()): AgentAvailability {
  const npx = agent.distribution.npx, binary = pickBinary(agent, key);
  // The registry's version first; then an older one already installed (the registry moved on): it still runs, and
  // the roster offers the update.
  const tried = [versionDir(agent.version), ...installedVersions(p, agent.id).filter(v => v !== versionDir(agent.version))];
  for (const v of tried) {
    const at = { ...agent, version: v };
    const launch = (binary ? binaryLaunch(p, at, binary) : null) ?? (npx ? packageLaunch(p, at, npx) : null);
    if (launch) return { state: 'ready', launch, version: v, update: v === versionDir(agent.version) ? null : agent.version };
  }
  if (binary) return { state: 'not_installed', how: 'binary' };
  if (npx) return { state: 'not_installed', how: 'npx' };
  return { state: 'unsupported', reason: agent.distribution.uvx ? 'needs Python (uv), which the app does not install' : `no download for ${key}` };
}

export function run(command: string, args: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const child = spawn(viaShell ? `"${command}"` : command, args, { cwd, env: { ...process.env, ...(env ?? {}) }, windowsHide: true, shell: viaShell, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => { if (err.length < 2000) err += d.toString(); });
    child.once('error', e => reject(new Error(`${path.basename(command)} could not start: ${e.message}`)));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${code}): ${err.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 400)}`)));
  });
}

async function installBinary(dir: string, target: BinaryTarget, fetchImpl: typeof fetch): Promise<void> {
  const url = new URL(target.archive);
  if (url.protocol !== 'https:') throw new Error('ACP_REGISTRY_DOWNLOAD_NOT_HTTPS');
  const matches = (b: Buffer) => !target.sha256 || createHash('sha256').update(b).digest('hex') === target.sha256.toLowerCase();
  // A download that finished but could not be unpacked is kept and used again, when the registry gives a checksum to trust it by.
  const kept = dir + '.download';
  let bytes: Buffer | null = null;
  if (target.sha256 && existsSync(kept)) { const had = readFileSync(kept); if (matches(had)) bytes = had; }
  if (!bytes) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!res.ok) throw new Error('download failed: HTTP ' + res.status);
    bytes = Buffer.from(await res.arrayBuffer());
    if (!matches(bytes)) throw new Error('ACP_REGISTRY_CHECKSUM_MISMATCH');
    mkdirSync(path.dirname(kept), { recursive: true });
    writeFileSync(kept, bytes);
  }
  const staging = dir + '.staging';
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const name = path.basename(url.pathname) || 'download';
  if (/\.(zip|tar\.gz|tgz|tar\.xz|tar\.bz2|tar)$/i.test(name)) {
    // bsdtar (Windows 10+, macOS) and GNU tar both refuse `..` paths. On Windows the system's own tar is named in
    // full: another tar earlier on PATH (Git's) reads `D:` as a remote host.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    await run(tar, ['-xf', kept, '-C', staging], staging);
  } else {
    const file = path.resolve(staging, target.cmd);   // a bare program, not an archive
    if (!inside(staging, file)) throw new Error('ACP_REGISTRY_COMMAND_OUTSIDE');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes, { mode: 0o755 });
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  rmSync(kept, { force: true });
}

async function installPackage(p: RegistryPaths, dir: string, target: PackageTarget, extraArgs: string[]): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const args = ['install', '--prefix', dir, '--no-audit', '--no-fund', '--no-save', ...extraArgs, target.package];
  if (p.npmCli) await run(p.node.command, [p.npmCli, ...args], dir, p.node.env);
  else await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, dir);
}

/**
 * How much installing this agent downloads, asked before downloading anything (第 7 步: 先报大小再问). An archive:
 * its size from the download server. An npm package: the package's own unpacked size from the npm registry; what it
 * depends on comes on top, so it is a lower bound. Null when the server does not say.
 */
export async function downloadSize(agent: RegistryAgent, fetchImpl: typeof fetch = fetch, key = platformKey()): Promise<{ bytes: number | null; kind: 'archive' | 'package'; from: string }> {
  const npx = agent.distribution.npx, binary = pickBinary(agent, key);
  if (binary) {
    const url = new URL(binary.archive);
    let bytes: number | null = null;
    try {
      const res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) });
      const n = Number(res.headers.get('content-length'));
      if (res.ok && Number.isFinite(n) && n > 0) bytes = n;
    } catch { /* unknown */ }
    return { bytes, kind: 'archive', from: url.hostname };
  }
  if (npx) {
    const at = npx.package.lastIndexOf('@'), name = at > 0 ? npx.package.slice(0, at) : npx.package, version = at > 0 ? npx.package.slice(at + 1) : 'latest';
    let bytes: number | null = null;
    try {
      const res = await fetchImpl(`https://registry.npmjs.org/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(15000) });
      const n = res.ok ? Number(((await res.json()) as { dist?: { unpackedSize?: unknown } }).dist?.unpackedSize) : NaN;
      if (Number.isFinite(n) && n > 0) bytes = n;
    } catch { /* unknown */ }
    return { bytes, kind: 'package', from: 'registry.npmjs.org' };
  }
  throw new Error('ACP_REGISTRY_NO_DISTRIBUTION');
}

/** Remove an agent the app installed: its whole folder under the app's agent folder, every version. */
export function uninstallAgent(p: RegistryPaths, agentId: string): void {
  const dir = path.join(p.installRoot, agentId);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(agentId) || !inside(p.installRoot, dir)) throw new Error('V8_ARGUMENT');
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** Install one agent into the app's folder. Signing in is still done by the person, in that agent. */
/** `npmArgs`: extra npm arguments one agent needs (see acpQuirks.ts). */
export async function installAgent(p: RegistryPaths, agent: RegistryAgent, fetchImpl: typeof fetch = fetch, key = platformKey(), npmArgs: string[] = []): Promise<AcpShellOptions> {
  const npx = agent.distribution.npx, binary = pickBinary(agent, key), base = agentDir(p, agent);
  mkdirSync(base, { recursive: true });
  if (binary) await installBinary(path.join(base, 'bin'), binary, fetchImpl);
  else if (npx) await installPackage(p, path.join(base, 'npm'), npx, npmArgs);
  else throw new Error('ACP_REGISTRY_NO_DISTRIBUTION');
  const now = availability(p, agent, key);
  if (now.state !== 'ready' || now.update) throw new Error('ACP_REGISTRY_INSTALL_INCOMPLETE');
  // An update: the older versions go once the new one is in place.
  for (const v of installedVersions(p, agent.id)) if (v !== versionDir(agent.version)) rmSync(path.join(p.installRoot, agent.id, v), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return now.launch;
}
