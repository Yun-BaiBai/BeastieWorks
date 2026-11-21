/** One line of the agent roster, as the window shows it. */
export interface RosterRow {
  id: string;
  name: string;
  website: string | null;
  /** ready: can be started. missing_program: its adapter is here but the agent's own program is not. */
  state: 'ready' | 'missing_program' | 'not_installed' | 'unsupported';
  /** Whether the person is signed in to it. 'unknown' when the agent has no way to say without a message. */
  signIn: 'yes' | 'no' | 'unknown';
  /** The app can walk the person through signing in to this one (the agent's own sign-in, started from the roster). */
  canSignIn: boolean;
  /** Plain words for the person: what state it is in and what to do. */
  note: string;
  /** 第 7 步: the app can download and install it (it is in the official list and has a download for this computer). */
  canInstall?: boolean;
  /** Installed by the app from the official list: its version, a newer one if listed, and that it can be removed. */
  installed?: { version: string; update: string | null } | null;
}

/** What installing an agent downloads (asked before downloading). bytes null: the server did not say. */
export interface InstallSize { bytes: number | null; kind: 'archive' | 'package'; from: string; /** Anything else it will download, in plain words. */ note?: string }

export interface RosterView {
  rows: RosterRow[];
  /** Where the list of known agents came from this time. */
  source: 'network' | 'cache' | 'bundled';
}

/** What came back from one message to an agent. */
export interface ChatTurn {
  reply: string;
  /** Things the agent tried to do and was refused: this chat never lets an agent read, write or run anything. */
  refused: string[];
  /** Set when the turn did not finish normally, in the agent's own words. */
  error: string | null;
}

/** One thing a session can be switched to. The group is the agent's own heading for it (a provider, a route). */
export interface Choice { id: string; label: string; group: string | null }
export interface ChoiceList { current: string | null; choices: Choice[] }
/** The models and reasoning efforts one agent offers for a session, in its own words. Null: it offers no such choice. */
export interface SessionChoices { model: ChoiceList | null; effort: ChoiceList | null }

/** A sign-in started from the roster. The person signs in on the agent maker's own page; the app only shows the link. */
export interface SignInFlow {
  phase: 'waiting' | 'succeeded' | 'failed' | 'expired' | 'cancelled';
  flowId: string;
  /** The maker's sign-in page, once the agent's program has given it. */
  url: string | null;
  /** A one-time code the person types on that page (Codex's device sign-in). */
  code?: string | null;
  message: string | null;
  /** false: nothing is pasted back here (the code is typed on the maker's page, or there is none). */
  paste?: boolean;
}

/** A model of any maker the Magpie that ships with the app can serve (requirement 8). `id` is Magpie's (provider/model). */
export interface MagpieModelView { id: string; label: string; provider: string; efforts: string[] }

/** One quota window of an agent's account: how much of it is used and when it starts over. */
export interface QuotaWindow {
  /** Plain words: "5 小时", "本周", "本周 · Fable". */
  label: string;
  usedPercent: number;
  /** When the window starts over (ms since epoch), if the maker said. */
  resetsAt: number | null;
}
/**
 * An agent's quota as its maker reports it. Reading it sends no message and uses no quota.
 * ok: read just now. none: this agent has no quota the app can read (yet). error: could not read it this time.
 */
export interface AgentQuota {
  agentId: string;
  state: 'ok' | 'none' | 'error';
  windows: QuotaWindow[];
  /** The plan, when the maker says (plus, pro, max …). */
  plan: string | null;
  /** Plain words for the person when state is not ok, or a remark worth knowing. */
  note: string | null;
  checkedAt: number;
}
