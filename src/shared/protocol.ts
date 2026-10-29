// Types shared by the core and the page. Only types here: the page imports this file too.

import type { QuestionDetails } from './questions.ts';
import type { NameColour, ProjectColours } from './name-colours.ts';
import type { ComputerInfo } from './computers.ts';
import type { SkillChoices, SkillInfo } from './skills.ts';
import type { Macro } from './macros.ts';

export type SessionStatus =
  /** The process is starting. */
  | 'starting'
  /** Waiting for Simon's next message. */
  | 'idle'
  /** Has work to start, but the limit on working sessions is reached: waiting for a free place (step 6). */
  | 'queued'
  /** Working on a turn. */
  | 'running'
  /** Working, but blocked on a permission prompt or question. */
  | 'waiting'
  | 'stopping'
  | 'ended';

/**
 * How a session's permission prompts are handled. Claude Code's "bypassPermissions" is deliberately
 * not offered: production, personal-data and similar sensitive actions must always be able to reach Simon.
 */
export type PermissionMode =
  /** Every action that needs permission asks Simon. */
  | 'default'
  /** File edits go through; commands still ask. */
  | 'acceptEdits'
  /** Claude Code's classifier approves routine actions and asks Simon about the rest. */
  | 'auto'
  /** Read-only: Claude plans but changes nothing. */
  | 'plan';

export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'auto', 'plan'];

export type SessionRole = 'session' | 'manager';

/**
 * A compact under way (docs/steps/clear-and-compact.md). Kept in the database, so a Ledung restart in
 * the middle of one loses nothing: who asked, the note for the summary, and what is known so far.
 */
export interface CompactingInfo {
  /** The session that asked: its manager, or the session itself. */
  requester: string;
  startedAt: number;
  /** The note for the summary (one line); null: only the project's Compact Instructions. */
  note: string | null;
  /** Known before the result: success from the boundary, failed from the status message. */
  outcome?: 'success' | 'failed';
  error?: string;
  /** compact_metadata of the boundary, for "Compacted: 70k → 2.4k in 16 s". */
  pre?: number;
  post?: number;
  durationMs?: number;
  /** The 10-minute alert went out. */
  alerted?: boolean;
}

/**
 * A chat's project (issue #211): a session with no project, workflow or manager. No project can be named
 * this, since a project's name starts with a letter or digit (PROJECT_NAME), so it never meets one.
 */
export const CHATS = '~chats';

/** How a session's project is shown: "Chats" for a chat, else the project's name. */
export function projectLabel(project: string): string {
  return project === CHATS ? 'Chats' : project;
}

/** The chats' settings (issue #211), for the page's New chat and Settings. */
export interface ChatsInfo {
  /** Where a new chat starts unless another folder is chosen: the config's, else the home folder. */
  folder: string;
  /** The permission mode a new chat starts in unless another is chosen. */
  permissionMode: PermissionMode;
  /** The chats' own sensitive list, edited in Settings; it starts with the suggestions. */
  sensitive: { commandPatterns: string[]; pathPatterns: string[]; mcpTools: string[] };
  /** The config's patterns for chats, always asked on top of the list; changed only in the config. */
  fromConfig: { commandPatterns: string[]; pathPatterns: string[]; mcpTools: string[] };
  /** The chats' name colour (issue #222), one for all of them, from the Chats ⚙; null: none. */
  colour: NameColour | null;
}

/** Who goes first when sessions wait for a free place (step 6). */
export type Priority = 'normal' | 'high' | 'critical';
export const PRIORITIES: readonly Priority[] = ['normal', 'high', 'critical'];

export interface SessionInfo {
  id: string;
  project: string;
  runner: 'local' | 'docker';
  title: string;
  /** Managers start and steer other sessions (step 3). */
  role: SessionRole;
  status: SessionStatus;
  permissionMode: PermissionMode;
  /** Claude Code's own session id, used to resume. Known after the session's first message. */
  claudeSessionId: string | null;
  model: string | null;
  /** The model its manager started it with (start_session); null: the project's model. */
  requestedModel: string | null;
  /** The session profile it runs with (#20); null: full, the user's whole setup. */
  profile: string | null;
  /** A clear (clear_session) counting down: when it happens. Null: none, or not started yet. Cancel stops it. */
  clearDue: number | null;
  /** When clear_session last cleared it. */
  clearedAt: number | null;
  /** A compact under way (compact_session, compact_self); null: none. */
  compacting: CompactingInfo | null;
  claudeVersion: string | null;
  /**
   * The Claude Code program its process was started with (issue #341): the user's installed one, one the
   * config names, or the SDK's copy. Absent or null: in a container, or started before Ledung recorded it.
   */
  claudeProgram?: { kind: ClaudeProgramInfo['kind']; path: string } | null;
  /** The working folder Claude Code reported. */
  cwd: string | null;
  /**
   * The folder its manager started it in (start_session's cwd, decision of 2026-10-14), kept on resume;
   * the file viewer and branch follow it. Null: the project folder.
   */
  workDir: string | null;
  createdAt: number;
  endedAt: number | null;
  endReason: string | null;
  parentId: string | null;
  /** Background commands the session has running. */
  backgroundTasks: number;
  /** A `!` command from the message box that is running now (issue #212); absent or null: none. */
  shell?: { command: string; startedAt: number } | null;
  /** The git branch of the session's folder, if it is a repository (step 5). */
  branch: string | null;
  /** How full the context is: tokens in the latest call, and the model's window. */
  contextTokens: number | null;
  contextWindow: number | null;
  /** The pull request for the branch, via the GitHub CLI where available (step 5c). */
  pr: PullRequestInfo | null;
  /** Ticket ids found with the project's pattern, as links. */
  tickets: TicketLink[];
  /** Step 6: place in the line, who set a priority and why ("critical, on Simon's answer to #12"). */
  priority: Priority;
  priorityNote: string | null;
  /** Paused by hand: its next tool call waits, and it starts no new turn, until resumed. */
  paused: boolean;
  /** Since when it has waited for a free place, while queued. */
  queuedAt: number | null;
  /** The Claude account it runs under (projects and accounts, P3); null: the computer's own login. */
  account: string | null;
  /** Archived: out of the sidebar, listed under its project's "Archived"; resuming it unarchives it. */
  archivedAt: number | null;
  /**
   * Its place among its siblings in the sidebar, once dragged (issue #88); null: never dragged, so a new
   * session shows on top and an ended one last, as before.
   */
  position: number | null;
  /** A manager's Remote Control (reachable from the Claude app) while it runs; null: none. */
  remoteControl: RemoteControlInfo | null;
  /** Since when it has had its status (issue #265); null: not known, a row from before. */
  statusSince?: number | null;
  /** Its elevated commands raise UAC on this PC's desktop (#213): the status line says so while one runs. */
  uac?: boolean;
}

/**
 * One MCP server of a running session, as Claude Code reports it (issue #118). Only what the page and a
 * manager need: never the server's config, which can hold its environment and headers (secrets).
 */
export interface McpServerInfo {
  name: string;
  /** Claude Code's word: connected, failed, needs-auth, pending or disabled; a newer one is passed on as it is. */
  status: string;
  /** Why it failed, when it did. */
  error: string | null;
  /** The server's own name and version, once connected. */
  version: string | null;
  /** How many tools it offers, once connected. */
  tools: number;
  /** False for Ledung's own tool server, which runs inside Ledung and is not Claude Code's to restart. */
  canReconnect: boolean;
}

export interface RemoteControlInfo {
  /** 'starting': asked for, no link yet; 'on': the link works; 'unavailable': see error. */
  state: 'starting' | 'on' | 'unavailable';
  /** The session's page on claude.ai, once Claude Code gives one. */
  url: string | null;
  /**
   * The bridge's last state from Claude Code ('ready', 'connected', …). "connected" is the bridge reaching
   * claude.ai, not the app opening it (loopback 2026-10-13); null: none seen by this Ledung.
   */
  bridge: string | null;
  error: string | null;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  url: string;
  checks: 'passing' | 'failing' | 'running' | 'none';
}

/**
 * What is left of the GitHub GraphQL budget the pull request poll uses (issue #252), per login and host:
 * the worst of GitHub's readings, since its two counters can disagree.
 */
export interface GitHubBudget {
  /** "github.com", or an Enterprise host. */
  host: string;
  /** The container whose `gh` login it is; null: this computer's. */
  container: string | null;
  remaining: number;
  limit: number;
  /** When the hour's budget resets (ms). */
  resetAt: number;
  /** The pull request poll at this budget: every 3 minutes, every 10 (under 20 % left), or stopped until the reset (under 5 %). */
  polling: 'normal' | 'slow' | 'stopped';
}

export interface TicketLink {
  id: string;
  url: string;
}

/** The latest known state of one of the plan's usage limits (step 5). */
export interface LimitInfo {
  /** The account the limit belongs to ("default": the computer's own login). */
  account: string;
  /** five_hour, seven_day, seven_day_opus, … as Claude Code reports it. */
  kind: string;
  /** allowed, allowed_warning or rejected. */
  status: string;
  /** 0–1, when reported. */
  utilization: number | null;
  resetsAt: number | null;
  /** When these figures first came. */
  at: number;
  /** When Claude Code last reported these figures, unchanged or new (issue #360); `at` when not known. */
  seenAt?: number;
}

/** A usage stop (issue #278): at `percent` of a window, new turns on the account are held. */
export interface UsageStopInfo {
  account: string;
  /** The window, as LimitInfo.kind. */
  kind: string;
  /** 1–100. */
  percent: number;
  /** The window's recorded utilization, 0–1; null when none is recorded or the window has reset since. */
  utilization: number | null;
  resetsAt: number | null;
  reached: boolean;
  /** Reached, but lifted by hand for this window. */
  lifted: boolean;
  /** Reached and not lifted: new turns on the account wait. */
  holding: boolean;
  /** While holding, since when Ledung has known: a turn that began before it finishes. */
  since?: number;
}

/** A project as the page shows and edits it (projects and accounts, P1). */
/** Where a session profile comes from (#298): a workflow's profiles file, this computer's config, or a workflow's changed by it. */
export type ProfileSource = 'workflow' | 'computer' | 'workflow+computer';

/** The session profiles as Settings shows them (#298): per workflow with a profiles file, then for chats and other projects. */
export interface ProfilesView {
  groups: {
    /** The workflow's name; null: chats and projects without a workflow's profiles. */
    workflow: string | null;
    file: string | null;
    /** Why the workflow's file isn't used, so its projects get this computer's profiles only; null when it is. */
    warning: string | null;
    defaults: { manager: string | null; session: string | null };
    pluginsOff: string[];
    /**
     * allow: the permissions.allow rules its settings add, so a loosening is visible (question #708); mcp: its own MCP
     * servers, each as "name: command args" or "name: url", since they run on this computer.
     */
    profiles: { name: string; source: ProfileSource; about: string | null; allow: string[]; mcp: string[] }[];
  }[];
}

/** The user's own skills where a project's sessions run, for the skill picker (#300). */
export interface SkillListView {
  skills: SkillInfo[];
  /** The plugin ids there: their skills go on and off with the plugin (its profile), not here. */
  plugins: string[];
  /** The defaults from Settings. */
  defaults: SkillChoices;
}

export interface ProjectInfo {
  name: string;
  runner: 'local' | 'docker';
  /** Where it is, for display: the folder, or container:folder. */
  where: string;
  path?: string;
  container?: string;
  pathInContainer?: string;
  user?: string;
  account: string | null;
  model: string | null;
  /** Its manager's model; null: the same as its sessions. */
  managerModel: string | null;
  permissionMode: PermissionMode | null;
  managerGrant: string | null;
  /** Its manager's project tools run without asking the user (decision of 2026-10-14). */
  projectToolsUnasked: boolean;
  /** Its manager reads and changes projects' workflow settings (issue #306); changes that loosen what reaches the user stay asked. */
  projectSettingsTools?: boolean;
  /** Its usage is published by its name to the shared usage repo (issue #363); otherwise as `other#` and a hash. */
  publishUsageName?: boolean;
  /** The usage repo it publishes to, owner/name (issue #380); null or none: the computer's default one. */
  usageRepo?: string | null;
  /** The session profile its manager and its sessions start with (#20); null: the config's default. */
  profiles: { manager: string | null; session: string | null };
  /** The profiles its sessions can be started with, "full" first: its workflow's and this computer's (#298). */
  profileNames?: string[];
  /** Which of the user's own skills its manager and sessions get (#300); empty: Settings' defaults. */
  skills: SkillChoices;
  sensitive: { commandPatterns: string[]; pathPatterns: string[]; mcpTools: string[] };
  /** The project's dev ship command, a pattern; away mode may let it through (issue #35). */
  devShipCommand: string | null;
  tickets: { pattern: string; url: string } | null;
  /** Its question tiers in order (issues #59, #96): never empty, the five standard ones unless the project changed them. */
  questionTiers: string[];
  /** Folders outside the project folder its sessions may also work in, such as its git worktrees (2026-10-14). */
  extraFolders: string[];
  /** Whether it follows a configured workflow (issue #21) and which by name (issue #132; none: the first); null: the default for its kind. */
  workflow: { use?: boolean; name?: string; projectConfig?: string } | null;
  /** Its one manager, once started. */
  managerId: string | null;
  createdAt: number;
  /** Its name colours in the sidebar and the session headers (issue #83). */
  colours: ProjectColours;
  /**
   * Lockdown (issue #109): level off, A or B; while locked, the board and Remote Control only if let in.
   * Level B: the hosts its shell may reach (none: no network) and, for a container, its marked island network.
   */
  lockdown: { level: 'off' | 'A' | 'B'; board: boolean; remoteControl: boolean; network?: string[]; dockerNetwork?: string | null };
}

/**
 * The configured workflows by name, in order (issue #132), and for the one asked about (none: the first)
 * its project config path and whether the folder has it (issue #21).
 */
export interface WorkflowCheckView {
  workflows: string[];
  /** False: no such workflow, or none configured. */
  on: boolean;
  projectConfig: string | null;
  exists: boolean | null;
}

/** The folder browser, as the page gets it (src/projects/browse.ts). */
export interface FolderListingView {
  path: string;
  parent: string | null;
  roots: string[];
  entries: { name: string; path: string; git: string | null; project: string | null }[];
}

export interface ContainerInfoView {
  name: string;
  image: string;
  user: string;
}

/** Settings → Accounts' choices (issue #283): the account chats run on and the one Add project preselects; null: default. */
export interface AccountChoices {
  chats: string | null;
  newProjects: string | null;
}

/** A Claude account as the page sees it: a login folder; Ledung keeps no token (issue #342). */
export interface AccountInfoView {
  name: string;
  kind: 'folder';
  /** Its login folder on this computer, as written everywhere (macOS names the Keychain entry from it). */
  configDir: string;
  /** Its login folder in containers, null for the default (~/.ledung-accounts/<name>). */
  containerDir: string | null;
  /** Who a session last found itself logged in as. */
  email: string | null;
  organization: string | null;
  plan: string | null;
  seenAt: number | null;
  createdAt: number;
  /** Listed under "claudeAccounts" in the config file (issue #425): removed in the page, it comes back at the next start. */
  inConfigFile?: boolean;
  /** The config file's whatItIsFor for it, if any. */
  whatItIsFor?: string | null;
}

/**
 * Whether Claude Code is signed in for an account (issue #333), as Ledung last checked: on start, when the
 * account is added, on Check again and on a session start. Only the ones not signed in are sent to the page.
 */
/** A Claude Code program on this computer (issue #341). */
export interface ClaudeProgramInfo {
  /** installed: the user's own `claude`; path: the one the config's "claudeExecutable" names; bundled: the Agent SDK's copy. */
  kind: 'installed' | 'path' | 'bundled';
  path: string;
  /** What `--version` said; null when it couldn't be read. */
  version: string | null;
}

/** Settings' Claude Code (issue #341): which program new sessions start, or why none can. */
export interface ClaudeCodeView {
  /** The config's "claudeExecutable": "installed", "bundled" or a path. */
  setting: string;
  /** The Claude Code version the Agent SDK was built against: the oldest one sessions run. */
  required: string | null;
  /** What a session started now runs; null: none can start (see problem). */
  program: ClaudeProgramInfo | null;
  /** The user's own (or the configured path's) program as found, usable or not. */
  installed: ClaudeProgramInfo | null;
  bundled: ClaudeProgramInfo | null;
  /** Why no session can start: Claude Code missing, too old, or its version unreadable, with how to fix it; null: none. */
  problem: string | null;
}

export interface SignInInfo {
  /** The account's name, or "default" for the computer's own login. */
  account: string;
  /** in: signed in; out: not; unknown: the check could not run (nothing is refused on it). */
  state: 'in' | 'out' | 'unknown';
  /** How it is signed in, as Claude Code says (claude.ai, oauth_token, api_key); null when not or unknown. */
  method: string | null;
  /** Why the check could not run, for unknown. */
  detail: string | null;
  checkedAt: number;
}

/** A not-signed-in account as the page's banner shows it: what to do, in words. */
export interface SignInProblem {
  account: string;
  help: string;
}

/** Older name. */
export type ProjectSummary = ProjectInfo;

/**
 * Every message Ledung stores. `kind` says what `data` holds:
 * - `user`: text Simon typed, `{ text }`.
 * - `sdk`: a message from Claude Code as the Agent SDK delivered it.
 * - `permission`: a permission request, `{ permissionId, toolName, input, title, reason }`.
 * - `decision`: the answer to one, `{ permissionId, behavior, by, message?, answers? }`.
 * - `event`: something Ledung did, `{ text }` (started, stopped, resumed, failed).
 * - `question`: the session asked with ask_user, `{ questionId }`; the question itself is a QuestionInfo.
 * - `shell`: a `!` command Simon ran from the message box (issue #212), see ShellBlock.
 * A `user` message delivered by Ledung rather than typed by Simon has `{ from: 'ledung' }`, and lists the
 * answers it delivered in `answerTo` (question ids).
 */
export interface StoredMessage {
  id: number;
  sessionId: string;
  at: number;
  kind: 'user' | 'sdk' | 'permission' | 'decision' | 'event' | 'question' | 'shell';
  data: any;
}

/** A `!` command's block in the history (issue #212): what ran, where, and how it ended. */
export interface ShellBlock {
  command: string;
  /** The shell it ran in, e.g. "Git Bash", or the container. */
  shell: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Ended before it finished: its time limit, Stop, or Restart Ledung. */
  cut: 'timeout' | 'stopped' | 'restart' | null;
  truncated: boolean;
  durationMs: number;
  /** Claude got it as context; false when the session ended or Ledung restarted first. */
  toClaude: boolean;
}

export type PermissionStatus = 'pending' | 'allowed' | 'denied' | 'cancelled';

export interface PermissionInfo {
  id: string;
  sessionId: string;
  at: number;
  toolName: string;
  input: Record<string, unknown>;
  title: string | null;
  reason: string | null;
  status: PermissionStatus;
  /** 'user', or the id of the manager deciding it (step 4). */
  addressedTo: string;
  /**
   * The sensitive rule it matched. Only the user allows a sensitive request, once: directly, or through
   * the manager's question about it (issue #51). No grant and no manager decision allows one.
   */
  sensitive: string | null;
  /** For an allowed request: 'once', or 'session' (this request and its repeats). */
  scope: 'once' | 'session' | null;
  /** A command that elevates and so raises UAC on this PC's desktop (#213): the card says so. Left out: no. */
  uac?: boolean;
  /** 'user', 'ledung', or the manager session that decided. */
  decidedBy: string | null;
  decidedAt: number | null;
  message: string | null;
}

/** A rule allowed for the rest of a session (step 4). */
export interface GrantInfo {
  id: number;
  sessionId: string;
  rule: string;
  grantedBy: string;
  createdAt: number;
}

/** Simon's answer to a permission request or a multiple-choice question. */
export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  /** For allow: just this request (default), or this request and its repeats in the session. */
  scope?: 'once' | 'session';
  /** Shown to the session when denying. */
  message?: string;
  /** For AskUserQuestion: question text → chosen label(s) or typed answer. */
  answers?: Record<string, string>;
}

export type QuestionStatus = 'open' | 'answered' | 'withdrawn';

/** A verdict on a screenshot: the Shot Judge's right, off and can't tell (issue #60). */
export type ShotVerdict = 'pass' | 'fail' | 'unsure';

/** A screenshot attached to a question (issue #60): a PNG or JPEG inside the asking session's project folder. */
export interface QuestionShot {
  /** Relative to the project folder, with forward slashes; checked when asked. */
  path: string;
  /** The issue or group it belongs to, e.g. "#198 Cart shows VAT per rate"; shots are grouped by it. */
  group: string;
  lookFor: string;
  /** The done-condition it is judged against. */
  doneWhen: string | null;
  /** Short facts: version, place, state. */
  facts: string[];
  /** What others thought: the asker, a reviewer, the agent that took it. */
  opinions: { who: string; text: string; verdict: ShotVerdict | null }[];
}

/** A question a session asked with ask_user. `id` is its number ("question #12"). */
export interface QuestionInfo {
  id: number;
  sessionId: string;
  askedAt: number;
  question: string;
  options: string[] | null;
  /** 'user', or (from step 3) the id of the manager session it went to. */
  addressedTo: string;
  status: QuestionStatus;
  answer: string | null;
  answeredAt: number | null;
  /** 'user', or the id of the manager session that decided under its standing grant. */
  answeredBy: string | null;
  /** For a manager's question: the question from one of its sessions it is about. */
  aboutQuestion: number | null;
  /** The answer is Simon's answer to this (manager's) question, forwarded verbatim. */
  forwardedFrom: number | null;
  /**
   * For a manager's question: the permission request from one of its sessions it is about (issue #51).
   * Ledung wrote the question; the user's answer decides that request, once.
   */
  aboutRequest: string | null;
  /** Screenshots to judge (issue #60); the verdicts become the answer. */
  shots: QuestionShot[] | null;
  /** When the answer reached the session; null while it waits for the session to be free. */
  deliveredAt: number | null;
  withdrawnReason: string | null;
  /** The structured fields the asker gave, for the question desk (issue #59); null for a plain question. */
  details: QuestionDetails | null;
  /**
   * The question `aboutQuestion` names, sent with this one so the page can show it whatever it has loaded
   * (issue #368); null when there is none or it is gone.
   */
  original?: OriginalQuestion | null;
  /**
   * The asker's conversation just before it asked, oldest first, taken when it asked and kept (issue #368).
   * Null for a question from before that, or one Ledung asked itself.
   */
  earlier?: ConversationLine[] | null;
  /** What the asker attached with ask_user's sources (issue #369), in its order, fetched and kept when it asked. Null: none. */
  sources?: AttachedSource[] | null;
}

/**
 * The question a manager's question is about, with what the page shows of it (issue #368), and the sources it
 * attached (issue #369, the manager's decision a on PR #378's review: a worker's sources reach the user through
 * its manager's question too).
 */
export type OriginalQuestion = Pick<QuestionInfo, 'id' | 'sessionId' | 'askedAt' | 'question' | 'options' | 'details' | 'status' | 'sources'>;

/**
 * A source attached to a question (issue #369): Ledung fetched it itself when the question was asked and keeps it
 * word for word, so the question page shows what the asker pointed at even after the conversation is pruned or the
 * comment edited. `named` is what the asker gave (a session, a link, a number), shown when it could not be fetched.
 */
export type AttachedSource =
  | { kind: 'reply'; named: string; sessionId: string; messageId: number; at: number; text: string; cut?: boolean }
  | {
    kind: 'comment'; named: string; url: string; what: 'comment' | 'review comment' | 'review';
    repo: string; number: number; author: string; at: string; text: string; cut?: boolean;
    /** A review comment's file and line. */
    path?: string | null; line?: number | null;
  }
  | { kind: 'question'; named: string; question: OriginalQuestion & Pick<QuestionInfo, 'answer' | 'answeredAt' | 'answeredBy'> }
  | FailedSource;

/** A source Ledung could not find, fetch or let the asker have: the question is asked all the same, and says why. */
export interface FailedSource { kind: 'reply' | 'comment' | 'question'; named: string; error: string }

/**
 * One message of a conversation, word for word (issue #368): the session's own reply, what Ledung delivered to it
 * (a manager's message, a worker's report, an answer), or what the user wrote to it. Tool calls are not kept.
 */
export interface ConversationLine {
  at: number;
  kind: 'reply' | 'delivered' | 'user';
  text: string;
  /** Cut to keep the question small; the rest is in the conversation. */
  cut?: boolean;
}

// --- Usage (step 5) ----------------------------------------------------------------------------

export type UsagePeriod = 'week' | '7d' | '30d' | '90d' | 'all';

export interface UsageFilter {
  /** "week" is since the plan's weekly limit last reset. */
  period: UsagePeriod;
  project?: string;
  model?: string;
  branch?: string;
  role?: string;
  /** What started the turn: user, answer, manager, ledung, unknown. */
  trigger?: string;
  account?: string;
}

export interface UsageTotals {
  tokens: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  thinking: number;
  /** API-equivalent, in dollars. */
  cost: number;
  calls: number;
  sessions: number;
  subagentTokens: number;
}

export interface UsageCell {
  byModel: Record<string, number>;
  tokens: number;
  cost: number;
  subagentShare: number;
}

export interface UsageReport {
  since: number;
  totals: UsageTotals;
  /** Models in the filtered period, most used first. */
  models: string[];
  projects: string[];
  options: { projects: string[]; models: string[]; branches: string[]; accounts: string[] };
  matrix: (UsageCell & { project: string; roles: (UsageCell & { role: string })[] })[];
  daily: { day: string; tokens: number; byModel: Record<string, number>; byProject: Record<string, number>; byTrigger: Record<string, number> }[];
  recent: {
    sessionId: string; title: string; role: SessionRole; project: string; branch: string | null; models: string[];
    firstAt: number; lastAt: number; calls: number; tokens: number; cost: number; subagentShare: number;
  }[];
}

export interface UsageCall {
  at: number;
  model: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  thinking: number | null;
  tokens: number;
  cost: number | null;
  subagent: string | null;
  trigger: string;
  /** A /compact's own model call (clear-and-compact plan), not a call of a turn. */
  compaction?: boolean;
}

export interface SessionUsage {
  totals: UsageTotals;
  models: string[];
  calls: UsageCall[];
}

/** Where every session stands, for the Overview and the session list. */
export interface Overview {
  todayTokens: number;
  sessions: Record<string, { today: number; total: number; costTotal: number; lastReply: string | null; lastReplyAt: number | null }>;
}

/** A file from a session's project folder, as the file viewer shows it. */
export interface ProjectFileView {
  path: string;
  kind: 'markdown' | 'text';
  content: string;
}

// --- Machine resources (step 6) -----------------------------------------------------------------

export interface ResourceFigures {
  /** CPU in use, in cores (1.0 = one core fully busy). */
  cores: number;
  memBytes: number;
}

export interface MachineInfo {
  at: number;
  /** This computer. */
  cpus: number;
  cores: number;
  memTotal: number;
  memUsed: number;
  /** Docker's virtual machine, when Docker is running. */
  docker: { cpus: number; cores: number; memTotal: number; memUsed: number } | null;
  /** Per live session: its whole process tree (or its process group in a container). */
  sessions: Record<string, ResourceFigures>;
  /** Sessions working now (managers and paused sessions don't count) and the limit. */
  working: number;
  limit: number;
  /** Session ids waiting for a free place, in the order they will start. */
  line: string[];
}

/** What one turn used (step 6c). */
export interface TurnResource {
  sessionId: string;
  startedAt: number;
  durationMs: number;
  avgCores: number;
  peakCores: number;
  peakMem: number;
  model: string | null;
  trigger: string;
  commands: string[];
}

/** Typical cost of turns in a project that ran a kind of command (or none). */
export interface TypicalCost {
  project: string;
  /** The command's first words ("npm run build"), or "" for turns that ran no command. */
  command: string;
  turns: number;
  avgCores: number;
  peakCores: number;
  peakMem: number;
  durationMs: number;
}

/**
 * What away mode lets a manager do without the user (issue #35). Computer control (issue #328) gates
 * nothing in Ledung: it tells managers they may take over this computer, for their own rules.
 */
export type AwayKind = 'merge' | 'devShip' | 'computerControl';
export const AWAY_KINDS: AwayKind[] = ['merge', 'devShip', 'computerControl'];
/** Allowed when the page names none: computer control only when asked for (Martin, 2026-10-27, question #813). */
export const AWAY_DEFAULT: AwayKind[] = ['merge', 'devShip'];

/** The user is away (issue #35): since and until are epoch ms. */
export interface AwayInfo {
  since: number;
  until: number;
  allow: AwayKind[];
}

/** A board repo as the page's chip and settings show it (docs/steps/message-board.md, "Per project"). */
export interface BoardRepoStatus {
  /** "owner/name" of the board repo. */
  repo: string;
  backend: string;
  /** off: no project here has it on, or not signed in; starting: first poll pending; ok; error: the last poll failed (backing off). */
  state: 'off' | 'starting' | 'ok' | 'error';
  /** Who this Ledung posts as there, once known. */
  identity: string | null;
  /** In plain words, e.g. "Board off: sign in with `gh auth login`". */
  error: string | null;
  lastPollAt: number | null;
  nextPollAt: number | null;
  /** The projects here that name this repo, on or off. */
  projects: string[];
  /** The project whose manager gets posts addressed to just "@me" on this repo; null: such posts wake nobody. */
  frontDesk: string | null;
  /** Posts dropped because no project on this repo allows their sender, per login. */
  ignored: { login: string; count: number; lastAt: number }[];
  /** Posts for this Ledung in the last 24 hours that reached no manager (no front desk, project off). */
  quiet: number;
  /** Threads whose waking is paused for a project (the per-thread cap), until the hour is over. */
  paused: { project: string; threadId: string; until: number }[];
}

/** A project's board setting, as the page shows and sends it. */
export interface ProjectBoardView {
  enabled: boolean;
  /** "owner/name"; null: none chosen (the board is off). */
  repo: string | null;
  /** Logins whose posts may reach this project's manager. */
  allow: string[];
  channels: string[];
  /** Posts addressed to this project from senders its allowlist doesn't name, per login. */
  ignored: { login: string; count: number; lastAt: number }[];
}

/** The message board as the page's chip and settings show it (docs/steps/message-board.md). */
export interface BoardStatus {
  /** Some project names a board repo. */
  configured: boolean;
  /** Who this Ledung posts as (the PC's `gh` login, the same on every board), once known. */
  identity: string | null;
  /** Each repo a project names. */
  boards: BoardRepoStatus[];
  /** Each project's setting; a project not listed is off. */
  projects: Record<string, ProjectBoardView>;
  /** Unread posts per project (channels it follows and quiet ones). */
  unread: Record<string, number>;
}

/** The people with access to a project's board repo, for its allowlist picker (GET /api/board-projects/<name>/people, decision 5). */
export interface BoardPeopleView {
  source: 'collaborators' | 'members' | 'none';
  people: { id: string; name: string | null; avatarUrl: string | null }[];
  note: string | null;
  /** Allowlisted logins no longer among the collaborators. */
  lostAccess: string[];
}

/** The picker for a project's board repo (GET /api/board-repos): boards other projects use first, then the repos the GitHub login can reach. */
export interface BoardRepoChoicesView {
  /** Repos other projects here already use as boards, with those projects. */
  used: { repo: string; projects: string[] }[];
  /** Repos the login can reach (newest push first); empty when `error` says why they could not be read. */
  repos: { repo: string; private: boolean }[];
  /** More repos exist than were read; a typed name still works. */
  truncated: boolean;
  /** Why the list of reachable repos is missing, in plain words; null when it was read. */
  error: string | null;
}

/** How a post reached one of this Ledung's projects; 'sent' is a post the project itself made. */
export type BoardDeliveryKind = 'wake' | 'quiet' | 'channel' | 'ignored';

/** A thread in the Board view's list (GET /api/board-threads), read-only. */
export interface BoardThreadSummary {
  /** "owner/name" of the board repo. */
  repo: string;
  id: string;
  title: string;
  /** Everyone who wrote or was addressed: "@login", "@login/Project", "#channel". */
  participants: string[];
  updatedAt: number;
  /** Posts Ledung holds for it, dropped ones included. */
  posts: number;
  /** Posts dropped because no project here allows their sender; only their id and author are kept. */
  dropped: number;
  /** Posts for this Ledung that reached no manager's inbox. */
  unsent: number;
  /** Posts a project here did not get because its allowlist does not name the sender. */
  refused: number;
  /** This Ledung's projects that took part (a post delivered to it, or posted by it). */
  projects: string[];
  /** Unread posts per project. */
  unread: Record<string, number>;
  /** The last post that has text, cut short; null when only dropped posts are known. */
  last: { author: string; viaLedung: boolean; fromProject: string | null; mine: boolean; text: string; at: number } | null;
  /** Only dropped posts are known: no title or text. */
  onlyDropped: boolean;
  /** The thread on the service. */
  url: string | null;
}

export interface BoardThreadsView {
  threads: BoardThreadSummary[];
  /** More threads exist than were listed. */
  truncated: boolean;
}

/** One post in a thread (GET /api/board-thread). Read-only. */
export interface BoardPostView {
  id: string;
  /** The sender as the service records it, never taken from the text. */
  author: string;
  /** It carried Ledung's header; without it a person typed it on the service. */
  viaLedung: boolean;
  /** The sending manager's project, as its header says. */
  fromProject: string | null;
  /** Sent by this Ledung's manager of that project. */
  mine: boolean;
  recipients: string[];
  /** null: the post was dropped (no project here allows its sender) and no text was kept. */
  text: string | null;
  at: number;
  /** Where it went among this Ledung's projects; empty: to nobody. */
  deliveries: { project: string; kind: BoardDeliveryKind; read: boolean }[];
  /** Reached at least one inbox / reached none (quiet, dropped) / not for this Ledung / sent from here. */
  status: 'delivered' | 'quiet' | 'other' | 'ignored' | 'sent';
  url: string | null;
  /** The post's evidence files (board attachments). */
  attachments: BoardAttachmentView[];
}

/** A board post's attachment as the page shows it. */
export interface BoardAttachmentView {
  name: string;
  kind: 'png' | 'jpeg' | 'text';
  size: number;
  /** "board:owner/name/<thread>/<file>" in this Ledung's board cache; null: not fetched, or pruned. */
  file: string | null;
  /** Why it could not be fetched. */
  error: string | null;
  pruned: boolean;
}

export interface BoardThreadView {
  repo: string;
  id: string;
  title: string;
  participants: string[];
  /** "GitHub", for "typed on GitHub by @x". */
  service: string;
  url: string | null;
  /** True when Ledung has not seen this thread at all. */
  missing: boolean;
  posts: BoardPostView[];
  /** The thread has more posts than were listed. */
  truncated: boolean;
}

/** Who a new board repo can be created under (GET /api/board-owners). */
export interface BoardOwnersView {
  owners: { login: string; kind: 'user' | 'org' }[];
}

/** One step of Settings' "Update Ledung" (#100). */
export interface UpdateStepView {
  label: string;
  state: 'waiting' | 'running' | 'done' | 'failed';
  /** The step's last output lines, when it has finished. */
  output?: string;
}

/** Where a shortcut that starts Ledung goes (issue #415): the Desktop and Start menu on Windows, Applications on macOS. */
export type ShortcutPlaceId = 'desktop' | 'start-menu' | 'applications';

export interface ShortcutPlace {
  id: ShortcutPlaceId;
  label: string;
  /** Ledung.lnk or Ledung.app in that place's folder. */
  file: string;
  present: boolean;
}

/** The first-run question and Settings → Shortcuts (GET /api/shortcuts, issue #415). */
export interface ShortcutsView {
  kind: 'windows' | 'mac' | 'other';
  /** False where Ledung makes no shortcuts (Linux); `reason` says so. */
  available: boolean;
  reason: string | null;
  /** The first-run question has been answered, Yes or No; it is not asked again. */
  asked: boolean;
  places: ShortcutPlace[];
}

/** Add the shortcuts, take them away, or No to the first-run question (POST /api/shortcuts). */
export type ShortcutAction = 'add' | 'remove' | 'decline';

/** Settings' "Update Ledung" (GET /api/update, #100). */
export interface UpdateView {
  /** False when Ledung runs straight from a source folder or from the npm package; `reason` says so. */
  available: boolean;
  reason?: string;
  /** Set when Ledung was installed from npm: the installed version. Updates come from npm then (#105). */
  npm?: { version: string };
  /** The update ends in a restart, which needs the launcher. */
  canRestart: boolean;
  /** The release Ledung runs: its source folder and commit (null when its source was not a git clone). */
  running: { commit: string | null; source: string; releasedAt?: string } | null;
  /** The last check of origin/main. */
  check: {
    checkedAt: string;
    /** origin/main's commit. */
    latest: string;
    /** False when the running release's commit is not known; `behind` then counts from the source folder's own commit. */
    commitKnown: boolean;
    /** New changes on main: first-parent commits, one per merged pull request. */
    behind: number;
    upToDate: boolean;
    /** The CHANGELOG bullets added since, in the file's order (newest first). */
    changes: string[];
  } | null;
  checkError: string | null;
  checking: boolean;
  steps: UpdateStepView[];
  updating: boolean;
  /** Why the last update stopped; the running Ledung was left as it was. */
  refused: string | null;
  /** The release is built and Ledung is restarting into it. */
  restarting: boolean;
}

/**
 * Settings → Relay on the relay admin's Ledung (issue #237): what the page may know of the admin settings. Never the
 * admin key or the Cloudflare token themselves: the key's SHA-256 (what goes in the relay's config) and whether a
 * token is set.
 */
export interface RelayAdminView {
  /** The relay as Ledung reaches it, wss://host; null: not set. */
  relay: string | null;
  /** SHA-256 of the admin key, for the relay's "adminKeySha256"; null: no key made yet. */
  keySha256: string | null;
  tokenSet: boolean;
}

/** An invite not used yet (issue #237). */
export interface RelayInviteInfo {
  id: string;
  owner: string;
  name: string;
  host: string;
  expiresAt: number;
}

/** A computer that joined with an invite and waits for its CAA record: the Approve card in Waiting for you (#237). */
export interface NewComputerInfo {
  name: string;
  owner: string;
  host: string;
  accountUrl: string;
  /** The exact record to add, as a zone file line. */
  record: string;
  enrolledAt: number;
  /** A Cloudflare token is set, so Approve can write the record; false: Copy only. */
  approvable: boolean;
}

/**
 * A pairing a linked computer asked for (issue #273, docs/steps/computer-tabs-link.md part 2): shown in Waiting for
 * you on this computer, so a browser paired with it from another computer's page never goes unseen.
 */
export interface LinkPairingInfo {
  id: string;
  /** The linked computer's name here. */
  computer: string;
  /** When it asked for the code. */
  at: number;
  /** The device that paired with the code; null while nobody has (the code lives 10 minutes). */
  device: { id: string; name: string } | null;
}

/** The tunnel to the relay (issue #160), shown in Settings. */
export interface RemoteStatus {
  /** connecting: the first attempt since start; reconnecting: lost or refused, trying again. */
  state: 'connecting' | 'connected' | 'reconnecting';
  /** The public name phones use for this Ledung. */
  publicName: string;
  /** Why the last attempt failed; null while connected. */
  error: string | null;
  /** What is wrong with encryption through the relay (no certificate, a plain stream refused); null or absent: nothing. */
  tls?: string | null;
  /** The certificate Ledung gets for the public name by ACME (issue #202); absent: no "acme" in the config. */
  certificate?: CertificateStatus;
}

/**
 * Where the ACME certificate stands (issue #202, docs/steps/relay-e2e.md 3b). offline: nothing usable yet and the
 * tunnel is not connected, which every order needs; waiting-caa: the account exists and Ledung waits for the CAA
 * record naming it; ordering: an order is open; valid: a usable certificate, renewed at two-thirds of its life;
 * failed: the last order failed, and the next try waits for the back-off.
 */
export interface CertificateStatus {
  state: 'offline' | 'waiting-caa' | 'ordering' | 'valid' | 'failed';
  /** Which ACME server: Pebble (tests), Let's Encrypt staging or production. */
  acme: 'pebble' | 'staging' | 'production';
  /** The ACME account's URL as the server gave it, never built here (spike #199); null before it exists. */
  accountUrl: string | null;
  /** The CAA record to add for the public name, as a zone file line; null before the account exists. */
  record: string | null;
  /** The certificate in use (ms since 1970); null: none. */
  validUntil: number | null;
  /** When it is renewed; null: no certificate. */
  renewAt: number | null;
  /** Why the last order failed, or what the CAA lookup found instead; null: nothing to say. */
  error: string | null;
  /** When Ledung next looks up CAA or tries again (ms since 1970); null: nothing scheduled. */
  nextTry: number | null;
}

/** The running version and where its source is: Settings → About, for AGPL section 13 (issue #332). */
export interface SourceOffer {
  /** "v1, commit 1a2b3c4", "ledung v1.1", or the version and the folder it runs from. */
  version: string;
  /** The repository, at the running commit when it is known. */
  url: string;
}

/** The config file as Settings shows it (issue #353): when it was last read, why a changed one was refused, what waits for a restart. */
export interface ConfigStatus {
  file: string;
  /** When the settings in use were read: at start, or at the last reload. */
  readAt: number;
  /** readAt is a reload, not the start. */
  reloaded: boolean;
  /** The changed file was refused, and the settings in use stay: why, in one line. Null: none refused. */
  problem: string | null;
  /** Settings changed in the file that apply at the next Restart Ledung. */
  restartFor: string[];
}

export type ServerEvent =
  /** `build` names the running release; when it changes, the page offers a reload. */
  | {
      type: 'hello';
      build: string;
      /**
       * This live connection's key (#104), only on the live connection, never in GET state. The page sends
       * it with every change; deciding something sensitive is refused without it.
       */
      pageKey?: string;
      canRestart: boolean;
      /** The running version and a link to its source (issue #332). */
      source?: SourceOffer;
      /** The name shown for the person using Ledung ("Simon"), from the config. */
      userName: string;
      sessions: SessionInfo[];
      permissions: PermissionInfo[];
      /** Open questions, and the most recent answered or withdrawn ones. */
      questions: QuestionInfo[];
      projects: ProjectSummary[];
      limits: LimitInfo[];
      /** Usage stops and where they stand (issue #278). */
      usageStops?: UsageStopInfo[];
      /** Away mode, or null when the user is here (issue #35). */
      away: AwayInfo | null;
      /** The session profiles in the config, "full" first (#20). */
      profiles: string[];
      /** The message board for the chip; configured: false when there is none. */
      board?: BoardStatus;
      /** Why lockdown level B can't be chosen on this computer (issue #109); null or left out: it can. */
      lockdownB?: string | null;
      /** The shell a "!" command runs in on this computer, for the message box's hint (issue #212). */
      bangShell?: string;
      /** The tunnel to the relay (issue #160); null or left out: none is configured. */
      remote?: RemoteStatus | null;
      /** The computers for the tabs, this one among them (issue #232); tabs show only with more than one. */
      computers?: ComputerInfo[];
      /** This page came through the public name, not on the computer itself: the remote frame (issue #232). */
      throughPublicName?: boolean;
      /** Computers waiting for the relay admin's Approve (issue #237); left out: none, or this Ledung is no relay admin. */
      newComputers?: NewComputerInfo[];
      /** Pairings linked computers asked for (issue #273); local pages only, left out through the public name. */
      linkPairings?: LinkPairingInfo[];
      /** The chats' settings (issue #211). */
      chats?: ChatsInfo;
      /** The GitHub budget the pull request poll sees (issue #252); empty or left out: no reading yet. */
      github?: GitHubBudget[];
      /** The config file's reloads (issue #353). */
      config?: ConfigStatus;
      /** The macros from Settings, in their order (issue #410); left out: none. */
      macros?: Macro[];
    }
  | { type: 'config'; config: ConfigStatus }
  | { type: 'chats'; chats: ChatsInfo }
  | { type: 'computers'; computers: ComputerInfo[] }
  | { type: 'session'; session: SessionInfo }
  | { type: 'message'; message: StoredMessage }
  | { type: 'permission'; permission: PermissionInfo }
  | { type: 'question'; question: QuestionInfo }
  | { type: 'limits'; limits: LimitInfo[] }
  | { type: 'usageStops'; usageStops: UsageStopInfo[] }
  | { type: 'macros'; macros: Macro[] }
  | { type: 'machine'; machine: MachineInfo }
  | { type: 'away'; away: AwayInfo | null }
  | { type: 'board'; board: BoardStatus }
  | { type: 'github'; github: GitHubBudget[] }
  | { type: 'remote'; remote: RemoteStatus | null }
  | { type: 'newComputers'; computers: NewComputerInfo[] }
  | { type: 'linkPairings'; pairings: LinkPairingInfo[] }
  | { type: 'projects'; projects: ProjectInfo[] }
  | {
      type: 'accounts'; accounts: AccountInfoView[]; defaultIdentity: Omit<AccountInfoView, 'name' | 'kind' | 'configDir' | 'createdAt'> | null; choices: AccountChoices;
      /** The accounts in use that Claude Code is not signed in for (issue #333); empty or left out: none. */
      signedOut?: SignInProblem[];
      /** Claude Code missing or too old on this computer (issue #341), with how to fix it; null or left out: none. */
      claudeProblem?: string | null;
      /** Accounts in the config file's "claudeAccounts" that couldn't be added or changed (issue #425), in words; empty or left out: none. */
      configFileProblems?: string[];
    };
