import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { MagpieGateway, MagpieClient, MAGPIE_RUNTIME, type MagpieStatus } from '../magpieGateway';
import { discoverSubscriptions, selectSubscriptionSources, type SubscriptionProvider } from '../subscriptionSources';
import type { V8SupplySettings } from '../../shared/v8/settings';

/**
 * The supply layer (v8 计划书 S1): the Magpie gateway, run privately per project, between every harness and the model
 * providers. It owns accounts, routing, quota and usage; harnesses only see one local endpoint.
 *
 * Reused from v7 as is: MagpieGateway (private HOME, allow-listed env, random loopback port, no auto-update or stats,
 * digest-checked binary) and the subscription sources (only the providers the boss ticked are copied, originals are
 * never touched, contents are never read here).
 */

/** Local label Magpie expects as the bearer token from this app (not a secret; v7 Phase 1E). */
export const MAGPIE_LOCAL_KEY = 'magpie-agentcorp';
/** The environment variable a harness reads the local label from. */
export const MAGPIE_KEY_ENV = 'AGENTCORP_MAGPIE_KEY';

export interface SupplyStatus {
  configured: boolean;
  running: boolean;
  origin: string | null;
  version: string;
  remote: boolean;
  /** Which sign-ins exist on this machine (presence only, never contents) and which the boss gave to the gateway. */
  signIns: Array<{ provider: SubscriptionProvider; present: boolean; given: boolean }>;
  error: string | null;
}

export interface SupplyOptions {
  /** The project's v8 state directory; the gateway's private folder goes under it. */
  root: string;
  settings: V8SupplySettings;
  /** For tests: a local fake upstream instead of real providers. */
  fixtureUpstream?: string;
  /** Where to look for sign-ins (tests point these at a temp folder). */
  home?: string;
  config?: string;
}

const PROVIDERS: SubscriptionProvider[] = ['claude', 'codex', 'copilot', 'gemini', 'grok'];

export class V8Supply {
  private gateway = new MagpieGateway();
  private error: string | null = null;

  constructor(private readonly o: SupplyOptions) {}

  private homes() {
    return { home: this.o.home ?? homedir(), config: this.o.config ?? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming') };
  }

  async start(): Promise<SupplyStatus> {
    const s = this.o.settings;
    this.error = null;
    try {
      mkdirSync(this.o.root, { recursive: true });
      if (s.remote) await this.gateway.connectRemote(this.o.root, s.remote, s.remoteAuthEnv);
      else {
        if (!s.magpieExe) throw new Error('V8_SUPPLY_NO_MAGPIE');
        const given = s.providers ?? [];
        const { home, config } = this.homes();
        await this.gateway.start({
          root: this.o.root, executable: s.magpieExe,
          ...(given.length ? { subscriptionSources: selectSubscriptionSources(home, config, given) } : {}),
          ...(this.o.fixtureUpstream ? { fixtureUpstream: this.o.fixtureUpstream } : {}),
        });
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
    return this.status();
  }

  stop(): Promise<void> { return this.gateway.stop(); }

  /** The endpoint harnesses talk to, or null when the gateway is not up. */
  origin(): string | null { const g = this.gateway.status(); return g.running ? g.origin : null; }

  status(): SupplyStatus {
    const g: MagpieStatus = this.gateway.status();
    const { home, config } = this.homes();
    const found = new Set(discoverSubscriptions(home, config).filter(x => x.safe).map(x => x.provider));
    const given = new Set(this.o.settings.providers ?? []);
    return {
      configured: true, running: g.running, origin: g.running ? g.origin : null, version: g.version ?? MAGPIE_RUNTIME.version,
      remote: !!g.remote, signIns: PROVIDERS.map(p => ({ provider: p, present: found.has(p), given: given.has(p) })), error: this.error,
    };
  }

  private client(): MagpieClient { return this.gateway.client(); }
  /** Raw readings; parsing into per-account quota for the screens is S4's job. Unknown stays unknown. */
  quotas() { return this.client().quotas(); }
  models() { return this.client().models(); }
  route(session: string) { return this.client().route(session); }
  trace() { return this.client().trace(); }
}

/** The session mark Magpie keeps a ticket on one account by (and attributes usage to). Max 128 chars. */
export function supplySession(project: string, role: 'lead' | 'worker' | 'reviewer', ticketId?: number, assignmentId?: number): string {
  const p = project.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'project';
  if (role === 'lead') return `${p}-lead`;
  return `${p}-${role === 'reviewer' ? 'review' : 'work'}-t${ticketId ?? 0}${assignmentId !== undefined ? '-a' + assignmentId : ''}`;
}

/**
 * A private oh-my-pi agent folder for one session: only a models.yml with one provider, Magpie, carrying this
 * session's mark. With Magpie in front, omp needs no sign-in of its own, so nothing is lost. Written as JSON, which
 * YAML reads as is. Returns the folder and the model name to pass to omp.
 */
export function ompGatewayAgentDir(base: string, session: string, origin: string, model: string, account?: string): { dir: string; model: string } {
  const safe = session.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  const dir = join(base, safe);
  mkdirSync(dir, { recursive: true });
  const id = model.trim();
  if (!id) throw new Error('V8_SUPPLY_MODEL_REQUIRED');
  const config = {
    providers: {
      magpie: {
        baseUrl: origin.replace(/\/$/, '') + '/v1',
        api: 'openai-responses',
        apiKey: MAGPIE_KEY_ENV,
        headers: { 'X-Magpie-Session': session, ...(account ? { 'X-Magpie-Account': account } : {}) },
        models: [{ id, name: id }],
      },
    },
  };
  writeFileSync(join(dir, 'models.yml'), JSON.stringify(config, null, 2) + '\n');
  return { dir, model: 'magpie/' + id };
}
