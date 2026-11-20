import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { MagpieGateway } from '../magpieGateway';

/**
 * The Magpie that ships with the app (requirement 8, 老板 2026-11-17/20): one per app, started the first time a model
 * of another maker is asked for, stopped when the app quits.
 *
 * - It reads each agent's own sign-in where the agent keeps it (MagpieGateway inPlace): the person's Codex, the app's
 *   own Claude folder, never a copy. It serves every model those sign-ins allow under one local address, translating
 *   between OpenAI's and Anthropic's kind of request, so a Codex gremlin can work on a Claude model and the other way.
 * - Its own settings stay in the app's folder; no statistics, no updates, no account discovery beyond this computer.
 * - The key is the app's name to Magpie on this computer (`magpie-<app>`), not a secret (Magpie docs/integrating.md).
 */

export const MAGPIE_KEY = 'magpie-beastie';
/** A ticket's model is Magpie's when it is written as `magpie:<Magpie's id>` (Magpie's ids are `provider/model`). */
export const MAGPIE_PREFIX = 'magpie:';
export const viaMagpie = (model: string | null | undefined): string | null => model?.startsWith(MAGPIE_PREFIX) ? model.slice(MAGPIE_PREFIX.length) : null;

export interface MagpieModel { id: string; label: string; provider: string; efforts: string[] }

/** One account's quota as Magpie reports it. `usedPercent` 0–100; `resetsAt` ms since epoch. */
export interface MagpieQuota {
  provider: string;
  plan: string | null;
  error: string | null;
  windows: Array<{ name: string; usedPercent: number; resetsAt: number | null }>;
}

/** Magpie's quota entry, with the window either on the entry or under `quota` (its cached files nest it there). */
export function readMagpieQuota(raw: unknown): MagpieQuota | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const q = (a.quota && typeof a.quota === 'object' ? a.quota : a) as Record<string, unknown>;
  const provider = typeof a.provider === 'string' ? a.provider : typeof q.provider === 'string' ? q.provider : null;
  if (!provider) return null;
  const windows = (Array.isArray(q.windows) ? q.windows : []).flatMap(w => {
    if (!w || typeof w !== 'object') return [];
    const x = w as Record<string, unknown>;
    const used = typeof x.used === 'number' ? x.used : typeof x.usedPercent === 'number' ? x.usedPercent : typeof x.used_percent === 'number' ? x.used_percent : null;
    if (used === null) return [];
    const at = typeof x.resetsAt === 'string' || typeof x.resetsAt === 'number' ? new Date(x.resetsAt).getTime()
      : typeof x.resets_at === 'string' || typeof x.resets_at === 'number' ? new Date(x.resets_at).getTime() : NaN;
    return [{ name: typeof x.name === 'string' ? x.name : '', usedPercent: Math.max(0, Math.min(100, used)), resetsAt: Number.isFinite(at) ? at : null }];
  });
  return { provider, plan: typeof q.plan === 'string' && q.plan ? q.plan : null, error: typeof a.error === 'string' && a.error ? a.error : null, windows };
}

export interface MagpieServiceOptions {
  /** The Magpie program: shipped with the app, or (while developing) one named by BEASTIE_MAGPIE_EXE. */
  exe(): string | null;
  /** The app's folder for Magpie's own settings and runs. */
  root: string;
  /** Where the app's Claude keeps its sign-in, and the folder of the Claude program the Claude bridge runs. */
  claude(): { configDir: string | null; programDir: string | null };
}

export class MagpieService {
  private gateway = new MagpieGateway();
  private starting: Promise<string> | null = null;
  private listed: { at: number; models: MagpieModel[] } | null = null;

  constructor(private readonly o: MagpieServiceOptions) {}

  /** Magpie's address, starting it the first time. */
  origin(): Promise<string> {
    const s = this.gateway.status();
    if (s.running && s.origin) return Promise.resolve(s.origin);
    this.starting ??= (async () => {
      const exe = this.o.exe();
      if (!exe || !existsSync(exe)) throw new Error('V8_MAGPIE_MISSING');
      mkdirSync(this.o.root, { recursive: true });
      const c = this.o.claude();
      const env: Record<string, string> = {};
      if (c.configDir) env.CLAUDE_CONFIG_DIR = c.configDir;
      if (c.programDir) env.PATH = c.programDir;
      const started = await this.gateway.start({ root: this.o.root, executable: exe, inPlace: { env } });
      if (!started.origin) throw new Error('V8_MAGPIE_MISSING');
      return started.origin;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  /**
   * The models Magpie serves now, as the person's sign-ins allow. A sign-in's models arrive a few seconds after Magpie
   * starts (Claude's do), so a fresh start waits a moment and asks again when the first answer looks short.
   */
  async models(fresh = false): Promise<MagpieModel[]> {
    if (!fresh && this.listed && Date.now() - this.listed.at < 60_000) return this.listed.models;
    const origin = await this.origin();
    const read = async () => {
      const r = await fetch(origin + '/v1/models', { headers: { Authorization: 'Bearer ' + MAGPIE_KEY }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error('V8_MAGPIE_MODELS_' + r.status);
      const j = await r.json() as { data?: Array<{ id?: unknown; display_name?: unknown; owned_by?: unknown; supported_reasoning_levels?: Array<{ effort?: unknown }> }> };
      return (j.data ?? []).filter(m => typeof m.id === 'string').map((m): MagpieModel => ({
        id: m.id as string,
        label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.id as string,
        provider: typeof m.owned_by === 'string' ? m.owned_by : String(m.id).split('/')[0] ?? '',
        efforts: (m.supported_reasoning_levels ?? []).map(x => String(x.effort ?? '')).filter(Boolean),
      }));
    };
    let models = await read();
    if (!this.listed) {
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const again = await read();
        if (again.length <= models.length && i >= 2) { models = again; break; }
        models = again;
      }
    }
    // A sign-in Magpie found but cannot use (Google stopped serving Gemini CLI's personal sign-in, 2026-11) says so in
    // its quotas with an error: its models are left out rather than offered and failing.
    try {
      const q = await fetch(origin + '/v1/magpie/quotas', { headers: { Authorization: 'Bearer ' + MAGPIE_KEY }, signal: AbortSignal.timeout(15_000) });
      const j = q.ok ? await q.json() as { data?: Array<{ provider?: unknown; error?: unknown; windows?: unknown[] }> } : { data: [] };
      const broken = new Set((j.data ?? []).filter(a => typeof a.error === 'string' && a.error && !(a.windows?.length)).map(a => String(a.provider)));
      const working = new Set((j.data ?? []).filter(a => !(typeof a.error === 'string' && a.error)).map(a => String(a.provider)));
      models = models.filter(m => !broken.has(m.provider) || working.has(m.provider));
    } catch { /* no quotas: keep the list as it is */ }
    this.listed = { at: Date.now(), models };
    return models;
  }

  /**
   * The quotas Magpie reads from the sign-ins it found on this computer ("balances and quota windows for every key,
   * plan and account", Magpie's README): one entry per account. Reading them sends no message.
   */
  async quotas(): Promise<MagpieQuota[]> {
    const origin = await this.origin();
    const r = await fetch(origin + '/v1/magpie/quotas', { headers: { Authorization: 'Bearer ' + MAGPIE_KEY }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error('V8_MAGPIE_QUOTAS_' + r.status);
    const j = await r.json() as { data?: unknown[] };
    return (j.data ?? []).map(readMagpieQuota).filter((q): q is MagpieQuota => q !== null);
  }

  stop(): Promise<void> { this.listed = null; return this.gateway.stop(); }
}

/** Where the Magpie program is: next to the packaged app, or the one a developer names. */
export function magpieExe(resourcesPath: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const shipped = resourcesPath ? path.join(resourcesPath, 'magpie', 'magpie-v0.1.1336.exe') : null;
  if (shipped && existsSync(shipped)) return shipped;
  return env.BEASTIE_MAGPIE_EXE && existsSync(env.BEASTIE_MAGPIE_EXE) ? env.BEASTIE_MAGPIE_EXE : null;
}
