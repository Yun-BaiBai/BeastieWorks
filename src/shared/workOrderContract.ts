export type ReasoningEffort = 'low'|'medium'|'high'|'xhigh';
export const isReasoningEffort=(v:unknown):v is ReasoningEffort=>typeof v==='string'&&['low','medium','high','xhigh'].includes(v);

/** AgentCorp adaptation of Crew Contract's Mission and handoff fields. */
export interface CheckCommand {
  command: string;
  args: string[];
  timeout_ms: number;
}
export interface MissionContract {
  id: string;
  outcome: string;
  inputs: { sources: string[]; tools: string[]; artifacts: string[]; exclude: string[] };
  output: { primary: string; derivatives: string[] };
  frequency: { kind: 'once' | 'on_demand'; trigger: string };
  definition_of_done: string[];
  human_gates: string[];
  token_budget: { limit: number; unit: 'tokens' | 'budget_units'; context_policy: string };
  target_files: string[];
  checks: CheckCommand[];
  max_rework_rounds: number;
  review_mode?: 'scripts'|'lead';
  /** Lead-authored per-order choice; boss settings retain priority. */
  reasoning_effort?: ReasoningEffort;
}
export interface HandoffReport {
  mission_id: string;
  execution_id: string;
  lease_version: number;
  from_role: string;
  to_role: string;
  artifact_url: string;
  what_changed: string[];
  open_questions: string;
  next_action: string;
  budget_spent: number | null;
  budget_left: number | null;
  budget_precision: 'reported' | 'estimated' | 'unknown';
  summary: string;
}
export interface RunWorkOrder {
  root: string;
  taskId: string;
  seatId: string;
  persona: string;
  playbook: string;
  command: string;
  args: string[];
  timeout_ms: number;
  adapter?: SeatAdapterOptions;
}
export interface SeatAdapterOptions {
  kind: 'command' | 'codex';
  /** Scoped coordinator delegation only; omitted/false denies public skill discovery. Not an OS network grant. */
  skill_discovery_network?: boolean;
  /** Separate fixed GitHub Git-data text acquisition; discovery alone never grants it. */
  skill_source_network?: boolean;
  env_allowlist?: string[];
  staged_instructions?: string[];
  /** Explicit gateway only; no automatic global account/config discovery. */
  gateway_endpoint?: string;
  gateway_kind?: 'magpie';
  gateway_authorization_env?:string;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  /** Coordinator-derived runtime identity, never a caller override. */
  execution_settings_sha256?:string;
}
export interface WorkOrderResult {
  replacementTicketId?:string;
  projectId: string;
  taskId: string;
  executionId: string;
  leaseVersion: number;
  status: string;
  errors: string[];
}
