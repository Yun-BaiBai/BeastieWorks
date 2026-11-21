/** One line of a project's notebook (A10). */
export interface ProjectNote {
  id: number;
  text: string;
  /** preference 偏好, fact 项目设定, decision 老板定下的事, lesson 验证过的坑. Lines the boss writes are facts. */
  kind: 'preference' | 'fact' | 'decision' | 'lesson';
  /** The words it rests on, copied from what was said; null for a line the boss wrote himself. */
  evidence: string | null;
  /** The ticket it was learned from; null for the boss's own lines. */
  ticketId: number | null;
  at: number;
}

export interface NotesView {
  notes: ProjectNote[];
  /** Whether a line is written after each accepted ticket (it costs a little of the lead agent's quota). */
  capture: boolean;
  /** Capturing needs the lead to be an agent of this computer. */
  canCapture: boolean;
}
