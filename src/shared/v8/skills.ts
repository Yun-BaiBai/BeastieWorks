/** One skill of the app's skill library (第 6 步), as the library page shows it. */
export interface LibrarySkill {
  /** Its folder name, unique in the library. */
  id: string;
  name: string;
  description: string;
  /** The heading it sits under in the library's INDEX.md (设计, 视频 …), or null. */
  category: string | null;
  /** Gremlins can see and use it. Imported skills start off (requirement 49): the boss turns them on. */
  enabled: boolean;
  /** How many times a gremlin fetched its full text, and when last. */
  uses: number;
  lastUsed: number | null;
  /** The latest time an agent retold in a few sentences what it does now (requirement 50), for the boss to check. */
  retold: { text: string; agent: string; at: number } | null;
  /** Brought in from GitHub into the app's own folder (can be deleted), as opposed to one of the shared folders. */
  imported: boolean;
  /** Where an imported skill came from (github.com/owner/repo/path). */
  source: string | null;
  /** Ships with the app, or comes with ego lite (A5). These start switched on. */
  builtin: boolean;
}

export interface SkillLibraryView {
  /** The folders the skills were read from. */
  roots: string[];
  skills: LibrarySkill[];
  /** The tools behind the skills that ship with the app. */
  tools?: SkillToolView[];
}

/** The command-line tool behind one of the skills that ship with the app (A5). */
export interface SkillToolView {
  /** The skill it belongs to. */
  skill: string;
  command: string;
  /**
   * installed: in the app's own folder (version given); on_computer: already on this computer, used as it is;
   * ready: nothing to install (find-skills runs through npx); not_installed: one click installs it;
   * needs_uv: agent-reach installs with uv, which this computer lacks; missing_basics: no npx at all.
   */
  state: 'installed' | 'on_computer' | 'ready' | 'not_installed' | 'needs_uv' | 'missing_basics';
  version: string | null;
  note: string | null;
}
