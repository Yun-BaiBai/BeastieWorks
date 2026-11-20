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
}

export interface SkillLibraryView {
  /** The folders the skills were read from. */
  roots: string[];
  skills: LibrarySkill[];
}
