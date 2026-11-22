/**
 * v8 workbench settings (config.v8). Everything optional: with nothing set the workbench runs on the fake shell in
 * a demo repository, so the board can be used without spending anything. Real work runs with shell: 'acp'.
 */
export interface V8Settings {
  /** The project the gremlins work on: any folder (see workspace.ts). Unset: a demo repository under userData. */
  projectRoot?: string;
  /** 'fake' (default): scripted lead and gremlins, no model. 'acp': the agents already on this computer, one per role
   *  (see `acp`). oh-my-pi, when wanted, is one of those agents (A16). */
  shell?: 'fake' | 'acp';
  /** With shell 'acp': which agent from the roster plays each role, and on which model. The reviewer defaults to the
   *  lead's agent. */
  acp?: { lead: V8AcpRole; worker: V8AcpRole; reviewer?: V8AcpRole };
  /** What a gremlin does when its account runs out of quota (第 5 步, requirements 6, 7, 46). Unset: wait. Changing it
   *  never restarts the workbench; it applies to the next time quota runs out. */
  onQuota?: V8QuotaRule;
  /** What the boss calls the lead (requirement 26). Unset: 主理小怪. */
  leadName?: string;
  /** Folders whose sub-folders are skills for the app's skill library (第 6 步). Unset: ~/.agents/skills and ~/.claude/skills, the ones that exist. */
  skillRoots?: string[];
  /** Spending cap per ticket in USD: a ticket that reaches it stops and waits for the boss. Unset: no cap. Applied while work goes on. */
  maxCostUsd?: number;
  /** Every "done" is checked by the review gremlin before it reaches the boss. Default true. */
  review?: boolean;
  /** A10: after each accepted ticket the lead's agent writes a few lines into the project's notebook. Default true. */
  notes?: boolean;
  /** Number of normal slots (gremlins at once), 1–8. Default 2 (规范第 5 节). Applied while work goes on. */
  slots?: number;
  /** One extra slot used only for work the boss just spoke to, so the boss's words never queue. Default true. */
  emergencySlot?: boolean;
  /**
   * The desks (工位), each with its own gremlin (requirements 61, 63; 老板 2026-11-21). Unset: `slots` desks, each set up
   * as `acp.worker` with `onQuota` (see desks.ts, which reads both). Applied while work goes on; a desk's change counts
   * from its next ticket.
   */
  desks?: V8Desk[];
}

/** One desk and the gremlin at it, as the boss set them up. */
export interface V8Desk {
  /** Stable id, also the scheduler's slot id ('slot-1', …). */
  id: string;
  /** What the boss calls it. Unset: 工位 01, 工位 02, … by position. */
  name?: string;
  /** Which gremlin sits there (an art name, see renderer cast). Unset: by position. */
  look?: string;
  agent: string; model?: string; effort?: string;
  /** Skills of the library this gremlin may not use (skill ids). Unset: every switched-on skill. */
  skillsOff?: string[];
  /** When its account runs out of quota. Unset: wait. */
  onQuota?: V8QuotaPlan;
}

/**
 * Running out of quota, per desk (requirement 63) and for the lead and the reviewer (requirement 66): wait for the
 * reset, or go on with the backups in order, at most 5 (OpenMausBot's FallbackChain, ModelSection.tsx). Each backup is
 * a model the same agent offers, its own or another maker's through Magpie. When the last one runs out too, it waits.
 */
export interface V8QuotaPlan { do: 'wait' | 'switch'; backups?: Array<{ model: string; effort?: string }> }

/**
 * The boss's rule for running out of quota. wait: the ticket waits until the quota starts over (when the maker says), then
 * goes on. switch: it goes on at once on this model (and effort, if set) of the same agent; if it is already on that model
 * and runs out again, it waits.
 */
export interface V8QuotaRule { do: 'wait' | 'switch'; model?: string; effort?: string }

/** One role played by an agent from the roster: its id there (e.g. 'codex-acp'), and the model and effort it offers. */
export interface V8AcpRole { agent: string; model?: string; effort?: string;
  /** The lead's and the reviewer's own rule for running out of quota (requirement 66). Unset: wait. Not used for acp.worker. */
  onQuota?: V8QuotaPlan }

