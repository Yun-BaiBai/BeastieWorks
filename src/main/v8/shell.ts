/**
 * The only surface the app sees of an agent shell (spec section 8). oh-my-pi's RPC mode is the first real one (B3);
 * FakeShell (fakeShell.ts) plays it from a script for tests. Swapping shells means swapping this one layer.
 *
 * The six actions:
 *   open    — start (or resume) a session in a directory, with a model and a tool list
 *   prompt  — say something and start a turn
 *   steer   — insert a message into the turn that is running
 *   abort   — stop the turn now
 *   events  — tool calls, messages, approval requests, host-tool calls, the end of a turn
 *   respond — answer an approval request or a host-tool call
 */

/** A tool the app provides to the model. The lead has only these; a gremlin has these plus the shell's own. */
export interface HostTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface SessionSpec {
  role: 'lead' | 'worker' | 'reviewer';
  /** Working directory. For a gremlin, the ticket's own worktree. */
  cwd: string;
  model: string | null;
  /** Reasoning effort for this session, when the boss chose one for the ticket; else the role's own. */
  effort?: string | null;
  /** Resume this earlier session instead of starting a new one. */
  sessionRef: string | null;
  /** Replaces the shell's default system prompt (the lead), or is appended to it (a gremlin). */
  systemPrompt: string;
  hostTools: HostTool[];
  /** False for the lead: no reading, writing or running anything, so it cannot do the work itself. */
  builtinTools: boolean;
  /** The supply layer's session mark (X-Magpie-Session): keeps this session on one account and bills it to its
   *  ticket. Unset when no gateway is in front. */
  /** Pin this session to one gateway account (X-Magpie-Account), when the boss switched the ticket's account. */
  supplyAccount?: string;
}

export type ShellEvent =
  | { type: 'tool_start'; callId: string; name: string; args: unknown }
  | { type: 'tool_end'; callId: string; name: string; ok: boolean; summary: string }
  | { type: 'message'; text: string }
  | { type: 'approval'; id: string; tool: string; detail: string }
  | { type: 'host_tool'; id: string; name: string; args: unknown }
  /** What a turn cost. 'reported': the agent said it in dollars; 'estimated': its tokens at list prices; 'unknown':
   *  neither (usd is then 0). Missing basis means 'reported' (oh-my-pi and the model shell report dollars). */
  | { type: 'cost'; usd: number; basis?: CostBasis }
  /** The turn is over. 'completed' also covers a turn that ended without calling the report tool. */
  | { type: 'settled'; status: 'completed' | 'aborted' | 'error'; detail?: string }
  /** The session's process is gone. */
  | { type: 'exited'; detail: string };

export type CostBasis = 'reported' | 'estimated' | 'unknown';

export type HostToolResult = { ok: true; text: string } | { ok: false; error: string };

export interface ShellSession {
  /** Stable id the shell can resume from later. */
  readonly ref: string;
  prompt(text: string): void;
  steer(text: string): void;
  abort(): void;
  respondApproval(id: string, allow: boolean): void;
  respondHostTool(id: string, result: HostToolResult): void;
  onEvent(listener: (event: ShellEvent) => void): () => void;
  /** Switch this session's model or reasoning effort, where the agent offers it (ACP). */
  choose?(kind: 'model' | 'effort', value: string): Promise<unknown>;
  /** End the session's process. The session can still be resumed by ref. */
  close(): Promise<void>;
}

export interface AgentShell {
  open(spec: SessionSpec): Promise<ShellSession>;
}
