/**
 * v8 workbench settings (config.v8). Everything optional: with nothing set the workbench runs on the fake shell in
 * a demo repository, so the board can be used without spending anything. Real models only with shell: 'omp'.
 */
export interface V8Settings {
  /** The project the gremlins work on: any folder (see workspace.ts). Unset: a demo repository under userData. */
  projectRoot?: string;
  /** 'fake' (default): scripted lead and gremlins, no model. 'omp': oh-my-pi with a real model. 'acp': the agents
   *  already on this computer, one per role (see `acp`). */
  shell?: 'fake' | 'omp' | 'acp';
  /** With shell 'acp': which agent from the roster plays each role, and on which model. The reviewer defaults to the
   *  lead's agent. */
  acp?: { lead: V8AcpRole; worker: V8AcpRole; reviewer?: V8AcpRole };
  /** What a gremlin does when its account runs out of quota (第 5 步, requirements 6, 7, 46). Unset: wait. Changing it
   *  never restarts the workbench; it applies to the next time quota runs out. */
  onQuota?: V8QuotaRule;
  /** What the boss calls the lead (requirement 26). Unset: 小怪A. */
  leadName?: string;
  /** Folders whose sub-folders are skills for the app's skill library (第 6 步). Unset: ~/.agents/skills and ~/.claude/skills, the ones that exist. */
  skillRoots?: string[];
  /** Model for the lead and the slots, e.g. 'openai/gpt-5.4-mini'. */
  model?: string;
  /** Hard spending cap per session in USD (passed to omp). Default 0.5. */
  maxCostUsd?: number;
  /** Every "done" is checked by the review gremlin before it reaches the boss. Default true. */
  review?: boolean;
  /** Number of normal slots, 1–4. Default 2 (规范第 5 节). */
  slots?: number;
  /** One extra slot used only for work the boss just spoke to, so the boss's words never queue. Default true. */
  emergencySlot?: boolean;
  /** The supply layer (v8 计划书 S1): Magpie between every harness and the providers. Unset: harnesses connect
   *  directly with their own keys, as before. */
  supply?: V8SupplySettings;
  omp?: {
    exe?: string;
    agentDir?: string;
    /** A file holding the model API key; read into the child's environment only. */
    keyFile?: string;
    /** Environment variable the key goes into. Default OPENAI_API_KEY. */
    keyEnv?: string;
    /** Directories put in front of PATH for the gremlins, e.g. a Python. Also allowed in commands. */
    extraPath?: string[];
  };
}

/**
 * The boss's rule for running out of quota. wait: the ticket waits until the quota starts over (when the maker says), then
 * goes on. switch: it goes on at once on this model (and effort, if set) of the same agent; if it is already on that model
 * and runs out again, it waits.
 */
export interface V8QuotaRule { do: 'wait' | 'switch'; model?: string; effort?: string }

/** One role played by an agent from the roster: its id there (e.g. 'codex-acp'), and the model and effort it offers. */
export interface V8AcpRole { agent: string; model?: string; effort?: string }

export interface V8SupplySettings {
  /** Absolute path to the digest-checked Magpie program (v0.1.1336). */
  magpieExe?: string;
  /** Sign-ins the boss gives to the gateway, copied privately; never all by default. */
  providers?: Array<'claude' | 'codex' | 'copilot' | 'gemini' | 'grok'>;
  /** Use a gateway running elsewhere instead of starting one (https, or loopback http). */
  remote?: string;
  /** Environment variable holding the remote gateway's token (AGENTCORP_GATEWAY_AUTH_…). */
  remoteAuthEnv?: string;
  /** How the lead and the reviewer reach their model: straight to the gateway (default; they need no harness), or
   *  through the harness like a gremlin (only one that can drop all its own tools, e.g. oh-my-pi). */
  thinkersVia?: 'model' | 'harness';
}
