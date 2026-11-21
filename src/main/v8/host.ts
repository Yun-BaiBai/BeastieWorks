import type { V8Settings } from '../../shared/v8/settings';
import { V8Workbench } from './workbench';
import { projectStateDir } from './projects';

/**
 * Keeps exactly one workbench open: the one for the current project and settings. When the project or any setting
 * changes, the open workbench is shut down cleanly (sessions closed; running work is recovered when that project is
 * opened again) and the new project's workbench is opened from its own folder. No Electron here, so it is testable.
 */
export class WorkbenchHost {
  private bench: V8Workbench | null = null;
  private key: string | null = null;
  /** The settings applied while work goes on, as last applied. */
  private live: string | null = null;
  private pending: Promise<V8Workbench> | null = null;

  constructor(private readonly o: {
    /** Base folder; each project gets <base>/projects/<key>. */
    base: string;
    settings(): V8Settings | undefined;
    enabled(): boolean;
    onChange(): void;
    /** How to start an agent from the roster (shell 'acp'). */
    acpLaunch?: (agent: string) => Promise<import('./acpShell').AcpShellOptions | null>;
    quotaOf?: (agent: string) => Promise<import('../../shared/v8/agents').AgentQuota>;
    skills?: import('./skillLibrary').SkillLibrary;
    /** Tests only: pace of the demo cast. */
    demoPace?: number;
  }) {}

  /** The current project's workbench, opening (or switching to) it if needed. Calls are serialised. */
  get(): Promise<V8Workbench> {
    if (!this.o.enabled()) return Promise.reject(new Error('V8_WORKBENCH_OFF'));
    const settings = this.o.settings() ?? {};
    // The quota rule is read live by the workbench (quotaRule below), the slots and the spending cap are applied to the
    // running workbench (applyLive), the skill folders are read by the library each time: changing any of them does
    // not restart the work.
    const key = JSON.stringify({ ...settings, onQuota: undefined, slots: undefined, emergencySlot: undefined, maxCostUsd: undefined, skillRoots: undefined, notes: undefined });
    if (this.bench && this.key === key && !this.pending) {
      const live = JSON.stringify([settings.slots, settings.emergencySlot, settings.maxCostUsd]);
      if (live !== this.live) { this.live = live; const b = this.bench; return b.applyLive(settings).then(() => b); }
      return Promise.resolve(this.bench);
    }
    this.live = JSON.stringify([settings.slots, settings.emergencySlot, settings.maxCostUsd]);
    const prior = this.pending ?? Promise.resolve(this.bench);
    const next = prior.catch(() => null).then(async current => {
      if (current && this.key === key) return current;
      if (current) { this.bench = null; await current.shutdown().catch(() => undefined); }
      const b = new V8Workbench({ stateDir: projectStateDir(this.o.base, settings.projectRoot ?? null), settings, demoPace: this.o.demoPace, quotaRule: () => this.o.settings()?.onQuota, notesOn: () => this.o.settings()?.notes !== false, ...(this.o.acpLaunch ? { acpLaunch: this.o.acpLaunch } : {}), ...(this.o.quotaOf ? { quotaOf: this.o.quotaOf } : {}), ...(this.o.skills ? { skills: this.o.skills } : {}) });
      b.onChange(this.o.onChange);
      await b.start();
      this.bench = b; this.key = key;
      return b;
    });
    this.pending = next;
    void next.then(() => { if (this.pending === next) this.pending = null; }, () => { if (this.pending === next) this.pending = null; });
    return next;
  }

  /** The workbench that is open right now, without opening anything. */
  current(): V8Workbench | null { return this.bench; }

  async shutdown(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    const b = (await pending?.catch(() => null)) ?? this.bench;
    this.bench = null; this.key = null;
    if (b) await b.shutdown().catch(() => undefined);
  }
}
