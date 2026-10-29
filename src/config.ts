// Ledung's local config: the port, the network, limits and browsing. Never committed (see README).
// Projects used to be listed here; they now live in Ledung's database and are managed in the page,
// and any listed here are copied in once (projects and accounts, P1).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { appDir, envSetting, PACKAGED, userDataDir } from './platform/paths.ts';
import { PERMISSION_MODES, type PermissionMode } from './shared/protocol.ts';
import { validateSensitive } from './sessions/sensitive.ts';
import { ProfilesSetting, RoleProfilesSetting, validateProfiles } from './sessions/profiles.ts';
import { SkillChoicesSetting } from './sessions/skills.ts';
import { LockdownSetting } from './projects/lockdown.ts';
import { COMPUTER_COLOURS, COMPUTER_NAME_MAX, type ComputerColour } from './shared/computers.ts';
import { USAGE_REPO } from './shared/published-usage.ts';
import { ACCOUNT_NAME, canonicalContainerFolder, DEFAULT_ACCOUNT, sameFolder, sharedLoginFolders } from './accounts/store.ts';

/** Patterns that make a request sensitive (always to the user), on top of the built-in ones. */
const SensitiveSetting = z
  .object({
    $comment: z.string().optional(),
    commandPatterns: z.array(z.string()).default([]),
    pathPatterns: z.array(z.string()).default([]),
    mcpTools: z.array(z.string()).default([]),
  })
  .default({ commandPatterns: [], pathPatterns: [], mcpTools: [] });

/** The permission mode new sessions in a project start in; changeable per session in the page. */
const PermissionModeSetting = z.enum(PERMISSION_MODES as [PermissionMode, ...PermissionMode[]]).optional();

/** Ticket ids to find in a session's title, branch and pull request, shown as links (step 5c). */
const TicketsSetting = z.object({ pattern: z.string().min(1), url: z.string().min(1) }).optional();

/**
 * A written process projects' sessions follow (issue #21): a folder with a manager's file and a
 * session's file, and where each project keeps its own settings for it. Only names from the config,
 * so the code knows no process (repository stays generic).
 */
const WorkflowFields = {
  $comment: z.string().optional(),
  /** The process folder on this computer. */
  folder: z.string().min(1),
  /** Inside the folder: what a manager reads first. */
  managerFile: z.string().min(1),
  /** Inside the folder: what every other session reads first. */
  sessionFile: z.string().min(1),
  /** Inside each project's folder: the project's own settings for the process. */
  projectConfig: z.string().min(1),
  /** Inside the folder: the workflow's session profiles, read at every session start (#298). */
  profilesFile: z.string().min(1).optional(),
  /** Inside the folder: the workflow's nudges, texts shown on a prompt while the context is over a threshold (#405). */
  nudgesFile: z.string().min(1).optional(),
};

/** The single "workflow" block (issue #21): the first workflow, named "default" unless it says otherwise (issue #132). */
const WorkflowSetting = z.object({ name: z.string().min(1).max(48).optional(), ...WorkflowFields }).optional();

/** More workflows by name (issue #132); a project picks one, or none. */
const WorkflowsSetting = z.array(z.object({ name: z.string().min(1).max(48), ...WorkflowFields })).optional();

/** The name the single "workflow" block goes by when it gives none (issue #132). */
export const DEFAULT_WORKFLOW_NAME = 'default';

/**
 * Per project: whether it follows a workflow (default: yes on this computer, no in a container), which one
 * (none: the first, which is how every project before issue #132 is stored), and its own config path.
 */
const ProjectWorkflowSetting = z.object({
  use: z.boolean().optional(),
  name: z.string().min(1).optional(),
  projectConfig: z.string().min(1).optional(),
}).optional();

/**
 * The project's dev ship command, as a pattern (case-insensitive) matched against the whole of a Bash command: while
 * the user is away and allows dev ship, a manager's command that is exactly one plain command and matches
 * it goes through (issue #35); so does one from a session that manager started, and `cd <path> &&` before it
 * and output redirects after it are set aside (issue #408). None: dev ship allows nothing in this project.
 */
const DevShipSetting = z.string().min(1).refine((p) => {
  try {
    new RegExp(p, 'i');
    return true;
  } catch {
    return false;
  }
}, 'is not a valid regular expression').optional();

/**
 * The message board between managers (docs/steps/message-board.md): the limits, the same for every
 * board. Which repo a project uses, its allowlist and the front desk are per project, set in the page
 * ("Per project", 2026-10-14). repo, allow and frontDesk are the block from before: moved once into the
 * projects that use the board (Boards.adoptLegacy), and only read for that.
 */
/** A board repo, "owner/name". */
export const BOARD_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Reaching this Ledung from anywhere through a relay (issue #160, docs/steps/relay.md). The tunnel to the
 * relay uses relay, name and secret; publicName is the name the phone opens over HTTPS, which the server
 * answers to (step 3). It is one exact DNS name: never a wildcard, an address or one of this computer's names,
 * because a passkey's RP ID must be a domain and the guards compare it exactly.
 */
export const PUBLIC_NAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,63}$/;
const RemoteSetting = z.object({
  $comment: z.string().optional(),
  relay: z.string().min(1),
  name: z.string().min(1),
  publicName: z.string().transform((n) => n.trim().toLowerCase()).pipe(z.string().regex(PUBLIC_NAME, 'publicName must be one DNS name such as pc.example.com: no wildcard, port, scheme or address.')),
  secret: z.string().min(1),
  /**
   * Encryption through the relay (docs/steps/relay-e2e.md 3a): "optional" takes both encrypted streams and plain
   * ones from a relay that still ends TLS itself; "required" closes plain ones, so such a relay shows at once.
   */
  tls: z.enum(['optional', 'required']).default('optional'),
  /**
   * Ledung gets its own certificate for publicName by ACME TLS-ALPN-01 through the relay (issue #202,
   * docs/steps/relay-e2e.md 3b): Pebble on this computer for tests, Let's Encrypt staging, or production. Left
   * out: tls.key and tls.crt are put in the remote folder by hand.
   */
  acme: z.enum(['pebble', 'staging', 'production']).optional(),
  /**
   * Only with "acme": "pebble": its directory, and the mock DNS server (host:port) the CAA lookup asks instead of
   * this computer's, as in the spike (docs/steps/relay-e2e-spike). Pebble's API root must be trusted through
   * NODE_EXTRA_CA_CERTS.
   */
  pebble: z.object({
    directory: z.string().url().default('https://localhost:14000/dir'),
    dns: z.string().min(1).optional(),
  }).optional(),
  /**
   * Tests only: reach linked computers' public names (issue #245) through this "host:port", a local stand-in for the
   * server, instead of their own addresses. Their certificates are still checked; trust a test root with
   * NODE_EXTRA_CA_CERTS.
   */
  linkVia: z.string().regex(/^[A-Za-z0-9.-]+:\d{1,5}$/, 'linkVia is host:port.').optional(),
}).optional();
export type RemoteConfig = NonNullable<z.infer<typeof RemoteSetting>>;

/** Remote settings saved by Join with a code (issue #237), checked like the config's block; throws a readable error. */
export function parseRemote(raw: unknown): RemoteConfig {
  const result = RemoteSetting.unwrap().safeParse(raw);
  if (!result.success) throw new Error(result.error.issues.map((i) => `${i.path.join('.') || 'remote'}: ${i.message}`).join('; '));
  return result.data;
}

/**
 * Which ACME server Join with a code gets the certificate from (issue #237): Let's Encrypt production unless this
 * says otherwise, which only tests and trials need.
 */
const RelayJoinSetting = z.object({
  $comment: z.string().optional(),
  acme: z.enum(['pebble', 'staging', 'production']).default('production'),
  pebble: z.object({
    directory: z.string().url().default('https://localhost:14000/dir'),
    dns: z.string().min(1).optional(),
  }).optional(),
}).default({ acme: 'production' });

/**
 * The computers whose Ledungs this page shows as tabs (issue #232, mockup variant A): a name, a colour and that
 * Ledung's public name each. The entry with this Ledung's own remote.publicName is this computer, so the same list
 * can go in every computer's config. Shown only with more than one computer.
 */
const ComputersSetting = z.array(z.object({
  $comment: z.string().optional(),
  name: z.string().trim().min(1).max(COMPUTER_NAME_MAX),
  colour: z.enum(COMPUTER_COLOURS as [ComputerColour, ...ComputerColour[]], { message: `colour is one of ${COMPUTER_COLOURS.join(', ')}.` }).optional(),
  publicName: z.string().transform((n) => n.trim().toLowerCase()).pipe(z.string().regex(PUBLIC_NAME, 'publicName must be one DNS name such as pc.example.com: no wildcard, port, scheme or address.')),
  /** Its Ledung's port on that computer, for its local page (http://127.0.0.1:<port>), which may frame this one (#241). */
  port: z.number().int().min(1).max(65535).optional(),
})).default([]).superRefine((list, ctx) => {
  const names = list.map((c) => c.publicName);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) ctx.addIssue({ code: 'custom', message: `Two computers have the public name ${twice}.` });
});

/** Keys starting with "$" explain the one beside them (the file is JSON, which has no comments): dropped before the check. */
function withoutNotes(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('$')));
}

/**
 * One Claude account written in the config (issue #425): plain field names a person reads without the docs, and
 * nothing secret, as Ledung keeps no sign-in (#342). Strict, so a misspelt field is an error rather than ignored.
 */
const ClaudeAccountSetting = z.preprocess(withoutNotes, z.object({
  whatItIsFor: z.string().trim().max(200).optional(),
  signInFolderOnThisComputer: z.string().trim().min(1, 'give a folder, or leave the field out for Ledung\'s own')
    .refine((f) => path.isAbsolute(f), 'give the whole path, such as D:\\Claude sign-ins\\work or /Users/you/claude-signins/work')
    .refine((f) => !sharedLoginFolders().some((s) => sameFolder(s, f)), 'that is this computer\'s own Claude Code folder; an account needs a folder of its own')
    .optional(),
  signInFolderInContainers: z.string().trim().min(1, 'give a folder, or leave the field out for ~/.ledung-accounts/<name>')
    .refine((f) => canonicalContainerFolder(f) !== null, 'starts with ~/ or /, of letters, digits and . _ / + - only')
    .refine((f) => canonicalContainerFolder(f) !== '~/.claude', 'that is the container user\'s own Claude Code folder; an account needs a folder of its own')
    .optional(),
}).strict());

/** The accounts block (issue #425), by account name. Ledung adds the ones it doesn't have; removing stays in the page. */
const ClaudeAccountsSetting = z.preprocess(withoutNotes, z.record(z.string(), ClaudeAccountSetting)).default({}).superRefine((accounts, ctx) => {
  const names = Object.keys(accounts);
  // Checked here rather than on the record's key, whose own message zod replaces with "Invalid key in record".
  for (const n of names) {
    if (!ACCOUNT_NAME.test(n)) ctx.addIssue({ code: 'custom', path: [n], message: 'an account name is letters, digits, "_" or "-" (at most 32), starting with a letter or digit' });
    else if (n === DEFAULT_ACCOUNT) ctx.addIssue({ code: 'custom', path: [n], message: '"default" is this computer\'s own login; give the account another name' });
  }
  // Two accounts on one folder would share a sign-in, and removing one would sign the other out (review of #342, I3).
  for (const [i, a] of names.entries()) {
    for (const b of names.slice(i + 1)) {
      const fa = accounts[a]!.signInFolderOnThisComputer;
      const fb = accounts[b]!.signInFolderOnThisComputer;
      if (fa && fb && sameFolder(fa, fb)) ctx.addIssue({ code: 'custom', path: [b, 'signInFolderOnThisComputer'], message: `the same folder as "${a}"; each account needs a folder of its own` });
      const ca = accounts[a]!.signInFolderInContainers;
      const cb = accounts[b]!.signInFolderInContainers;
      if (ca && cb && canonicalContainerFolder(ca) === canonicalContainerFolder(cb)) ctx.addIssue({ code: 'custom', path: [b, 'signInFolderInContainers'], message: `the same folder as "${a}"; each account needs a folder of its own` });
    }
  }
});
export type ClaudeAccountConfig = z.infer<typeof ClaudeAccountSetting>;

const BoardSetting = z.object({
  $comment: z.string().optional(),
  backend: z.literal('github').default('github'),
  /** Before per-project boards: "owner/name" of the one board repo. */
  repo: z.string().regex(BOARD_REPO, 'Write the repo as owner/name.').optional(),
  /** Before per-project boards: logins whose posts may reach a manager (decision 5). */
  allow: z.array(z.string().regex(/^[A-Za-z0-9-]{1,39}$/, 'is not a login')).default([]),
  /** Before per-project boards: the project whose manager gets posts addressed to just "@me". */
  frontDesk: z.string().min(1).optional(),
  pollSeconds: z.number().int().min(2).max(300).default(5),
  /** Caps (decision 7). */
  postsPerHour: z.number().int().min(1).max(1000).default(20),
  wakesPerThreadPerHour: z.number().int().min(1).max(100).default(6),
  /** Addressed posts to one manager within this many seconds become one wake; 0: each wakes at once. */
  burstSeconds: z.number().int().min(0).max(60).default(5),
  /** Board attachments are pruned (the cache, and this Ledung's uploads in evidence/) after this many days, and when their thread is closed. */
  evidenceDays: z.number().int().min(1).max(3650).default(30),
}).optional();

/** Project names: shown in the page and used in messages to managers. */
export const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/;
const ProjectName = z.string().regex(PROJECT_NAME, 'Use letters, digits, spaces, ".", "_" or "-" (at most 48), starting with a letter or digit.');

const LocalProject = z.object({
  name: ProjectName,
  runner: z.literal('local'),
  /** The project folder on this machine. */
  path: z.string().min(1),
  /**
   * Folders outside the project folder where its sessions may also work, such as where its git worktrees
   * go (start_session's cwd, decision of 2026-10-14). None: only the project folder and folders inside it.
   */
  extraFolders: z.array(z.string().min(1).refine((f) => path.isAbsolute(f), 'Give each extra folder as a full path.')).max(20).optional(),
  model: z.string().optional(),
  /** Its manager's model; none: the same as its sessions (decision of 2026-10-13). */
  managerModel: z.string().optional(),
  permissionMode: PermissionModeSetting,
  managerGrant: z.string().optional(),
  /** Its manager's project tools (add_project, create_project, start_manager, stop_manager) run unasked (decision of 2026-10-14). */
  projectToolsUnasked: z.boolean().optional(),
  /** Its manager reads and changes the workflow settings of projects that aren't locked, its own too (issue #306). */
  projectSettingsTools: z.boolean().optional(),
  /** Its usage is published to the shared usage repo under its name (issue #363); none: as `other#` and a hash. */
  publishUsageName: z.boolean().optional(),
  /** The usage repo it publishes to, owner/name (issue #380); none: the computer's default one (Settings → Publish usage). */
  usageRepo: z.string().regex(USAGE_REPO, 'Write the usage repository as owner/name.').optional(),
  sensitive: SensitiveSetting,
  devShipCommand: DevShipSetting,
  tickets: TicketsSetting,
  /** Its question tiers in order, for ask_user and Waiting for you (issues #59, #96); none or empty: the five standard ones. */
  questionTiers: z.array(z.string().min(1).max(80)).optional(),
  workflow: ProjectWorkflowSetting,
  /** The Claude account its manager and sessions use; none: whatever Claude Code is logged in as. */
  account: z.string().min(1).optional(),
  /** The session profile its manager and its sessions start with (#20); none: the config's default. */
  profiles: RoleProfilesSetting.optional(),
  /** Which of the user's own skills its manager and sessions get (#300); none: Settings' defaults. */
  skills: SkillChoicesSetting.optional(),
  /** Lockdown (issue #109): walled off from other projects' agents; none: off. */
  lockdown: LockdownSetting,
});

const DockerProject = z.object({
  name: ProjectName,
  runner: z.literal('docker'),
  /** Name of the running container (`docker ps`). */
  container: z.string().min(1),
  /** The project folder inside the container. */
  pathInContainer: z.string().min(1),
  /** User to run Claude Code as inside the container. */
  user: z.string().min(1).optional(),
  model: z.string().optional(),
  managerModel: z.string().optional(),
  permissionMode: PermissionModeSetting,
  /** What this project's manager may decide on the user's behalf (the brief's fixed limits always apply). */
  managerGrant: z.string().optional(),
  /** Its manager's project tools (add_project, create_project, start_manager, stop_manager) run unasked (decision of 2026-10-14). */
  projectToolsUnasked: z.boolean().optional(),
  /** Its manager reads and changes the workflow settings of projects that aren't locked, its own too (issue #306). */
  projectSettingsTools: z.boolean().optional(),
  /** Its usage is published to the shared usage repo under its name (issue #363); none: as `other#` and a hash. */
  publishUsageName: z.boolean().optional(),
  /** The usage repo it publishes to, owner/name (issue #380); none: the computer's default one (Settings → Publish usage). */
  usageRepo: z.string().regex(USAGE_REPO, 'Write the usage repository as owner/name.').optional(),
  sensitive: SensitiveSetting,
  devShipCommand: DevShipSetting,
  tickets: TicketsSetting,
  /** Its question tiers in order, for ask_user and Waiting for you (issues #59, #96); none or empty: the five standard ones. */
  questionTiers: z.array(z.string().min(1).max(80)).optional(),
  workflow: ProjectWorkflowSetting,
  account: z.string().min(1).optional(),
  profiles: RoleProfilesSetting.optional(),
  skills: SkillChoicesSetting.optional(),
  lockdown: LockdownSetting,
});

const Project = z.discriminatedUnion('runner', [LocalProject, DockerProject]);

/** The port when the config names none; the launchers' open-or-start check reads the same (issue #415). */
export const DEFAULT_PORT = 4317;

const Config = z.object({
  $comment: z.string().optional(),
  port: z.number().int().min(1024).max(65535).default(DEFAULT_PORT),
  /** How sessions and the page refer to the person using Ledung, e.g. "Simon". */
  userName: z.string().min(1).default('the user'),
  /**
   * Also reachable from other computers on the local network (plain HTTP, sign-in still required):
   * an address of this computer, to answer only there, or true for all of its addresses.
   */
  lan: z.union([z.boolean(), z.ipv4()]).default(false),
  /** With "lan": false here means other computers need no sign-in; anyone on that network can use Ledung. */
  lanSignIn: z.boolean().default(true),
  projects: z.array(Project).default([]),
  /** Claude accounts written in the file (issue #425): added when Ledung doesn't have them; the page adds and removes too. */
  claudeAccounts: ClaudeAccountsSetting,
  /** Sensitive patterns for every project. */
  sensitive: SensitiveSetting,
  /** How many sessions may work at the same time (step 6); managers don't count. Changeable in the page. */
  maxWorkingSessions: z.number().int().min(1).max(100).default(10),
  /**
   * Usage stops (issue #278): per account ("default": this computer's own login), the percent of a plan window
   * (five_hour, seven_day) at which new turns on that account are held, e.g. { "default": { "seven_day": 98 } }.
   * Changeable in the page's Settings, which then take precedence.
   */
  usageStops: z.record(z.string().min(1), z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.number().min(1).max(100))).default({}),
  /**
   * Days after a session ends before Ledung shrinks its stored tool results to their first lines (issue #349). Claude
   * Code keeps the full output in its own transcript; conversations, questions, permissions and usage are kept.
   * Default 3 (Martin, 2026-10-28, Ledung question #869; was 14).
   */
  keepToolResultsDays: z.number().int().min(1).max(3650).default(3),
  /** Stop a session after this many minutes idle, to free its process; 0: never. Managers are never stopped. */
  idleStopMinutes: z.number().int().min(0).max(7 * 24 * 60).default(60),
  /** Folders the page's folder browser may show; default: the home folder of whoever runs Ledung. */
  browseRoots: z.array(z.string().min(1)).optional(),
  /** Where new projects are created; default: a Projects folder in the home folder. */
  projectsFolder: z.string().min(1).optional(),
  workflow: WorkflowSetting,
  workflows: WorkflowsSetting,
  /** Session profiles by name (#20): what a session gets of the user's own setup. "full" is built in; one named as a workflow's changes it field by field (#298). */
  profiles: ProfilesSetting,
  /** The profile for each role where the project names none, over a workflow's own; default: full. */
  defaultProfiles: RoleProfilesSetting.default({}),
  /** Plugin ids (as in Claude Code's enabledPlugins) turned off in every session where installed, whatever its profile (issue #265); added to a workflow's (#298). */
  pluginsOff: z.array(z.string().min(1)).default([]),
  /** Managers turn on Remote Control, as "<project> lead" in the Claude app (#19); false: none do. */
  remoteControl: z.boolean().default(true),
  /**
   * The Claude Code sessions on this computer run (issue #341): "installed", the user's own `claude` (on the PATH or
   * where its installers put it); "bundled", the copy the Agent SDK installs with Ledung; or a full path to one.
   * One that is missing or older than the SDK needs is never run: sessions are refused and the page says how to fix it
   * (Martin, 2026-10-27). "bundled" only when set here. Containers run their own.
   */
  claudeExecutable: z.string().min(1).refine((v) => v === 'installed' || v === 'bundled' || path.isAbsolute(v), 'claudeExecutable is "installed", "bundled" or a full path to Claude Code.').default('installed'),
  /** The shell a "!" command from the message box runs in on Windows (issue #212): Git Bash, as Claude's Bash tool, or PowerShell. */
  windowsShell: z.enum(['bash', 'powershell']).default('bash'),
  board: BoardSetting,
  remote: RemoteSetting,
  relayJoin: RelayJoinSetting,
  computers: ComputersSetting,
  /**
   * Chats (issue #211): sessions with no project. Where a new one starts (default: the home folder), its
   * permission mode (default: Auto, Martin 18:19 on question #297), and patterns always asked in chats on
   * top of the list edited in the page.
   */
  chats: z.object({
    $comment: z.string().optional(),
    folder: z.string().min(1).optional(),
    permissionMode: z.enum(PERMISSION_MODES as [PermissionMode, ...PermissionMode[]]).default('auto'),
    sensitive: SensitiveSetting,
  }).default({ permissionMode: 'auto', sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] } }),
}).superRefine((c, ctx) => {
  const names = workflowsOf(c).map((w) => w.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) ctx.addIssue({ code: 'custom', path: ['workflows'], message: `Two workflows are named "${twice}"; give each its own name.` });
  // "none" is how a project and add_project say it follows no workflow.
  if (names.some((n) => n.trim().toLowerCase() === 'none')) ctx.addIssue({ code: 'custom', path: ['workflows'], message: 'A workflow cannot be named "none".' });
});

export type ProjectConfig = z.infer<typeof Project>;
export type LocalProjectConfig = z.infer<typeof LocalProject>;
export type DockerProjectConfig = z.infer<typeof DockerProject>;
export type LedungConfig = z.infer<typeof Config>;
/** A configured workflow with its name (issue #132). */
export type WorkflowConfig = NonNullable<z.infer<typeof WorkflowsSetting>>[number];
/** A workflow's folder and files, named or not: the single block may give no name. */
export type WorkflowFiles = NonNullable<LedungConfig['workflow']>;

/** Every configured workflow in order: the single "workflow" block first, then the "workflows" list (issue #132). */
export function workflowsOf(config: { workflow?: z.infer<typeof WorkflowSetting>; workflows?: z.infer<typeof WorkflowsSetting> }): WorkflowConfig[] {
  const first = config.workflow ? [{ ...config.workflow, name: config.workflow.name ?? DEFAULT_WORKFLOW_NAME }] : [];
  return [...first, ...(config.workflows ?? [])];
}
export type BoardConfig = NonNullable<LedungConfig['board']>;

/** The board's limits: the config's block, or the defaults without one (a board needs no block, "Per project"). */
export function boardConfig(config: LedungConfig): BoardConfig {
  return config.board ?? BoardSetting.unwrap().parse({});
}

/**
 * LEDUNG_CONFIG if set, otherwise ledung.config.local.json in the folder Ledung runs from. The npm
 * package keeps it in the user data folder instead, since npm replaces the package folder on every update (#105).
 */
export function configPath(packaged = PACKAGED): string {
  const set = envSetting('CONFIG');
  if (set) return path.resolve(set);
  if (packaged) return path.join(userDataDir(), 'ledung.config.json');
  return path.join(appDir(), 'ledung.config.local.json');
}

export function parseConfig(raw: unknown): LedungConfig {
  const result = Config.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join('.') || '(top level)'}: ${i.message}`).join('\n');
    throw new Error(`The config has problems:\n${problems}`);
  }
  try {
    validateSensitive(result.data.sensitive);
    validateSensitive(result.data.chats.sensitive);
    for (const p of result.data.projects) validateSensitive(p.sensitive);
    // With a workflow's profiles file the defaults may name its profiles: checked when a session starts (#298).
    const fromWorkflow = workflowsOf(result.data).some((w) => w.profilesFile);
    validateProfiles(result.data.profiles, fromWorkflow ? null : result.data.defaultProfiles);
  } catch (e) {
    throw new Error(`The config has problems:\n  - ${(e as Error).message}`);
  }
  const names = new Set<string>();
  for (const p of result.data.projects) {
    if (names.has(p.name)) throw new Error(`The config has two projects named "${p.name}".`);
    names.add(p.name);
  }
  return result.data;
}

/** A project's settings as the page or the database gives them; throws a readable error. */
export function parseProject(raw: unknown): ProjectConfig {
  const result = Project.safeParse(raw);
  if (!result.success) {
    throw new Error(result.error.issues.map((i) => `${i.path.join('.') || 'project'}: ${i.message}`).join('; '));
  }
  validateSensitive(result.data.sensitive);
  return result.data;
}

/** What the npm package writes on its first start: the defaults, with a pointer to the rest (#105). */
const FIRST_CONFIG = {
  $comment: 'Written by Ledung on its first start. Projects and Claude accounts are added in the page (accounts can also be listed under "claudeAccounts" here); the other settings are described in ledung.config.example.json, next to Ledung\'s package.json.',
  port: DEFAULT_PORT,
};

/** Writes a default config when there is none: the npm package's first start (#105). True if it wrote one. */
export function createDefaultConfig(file = configPath()): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    // 'wx': never overwrite a config that is there, or that another Ledung wrote a moment ago.
    fs.writeFileSync(file, `${JSON.stringify(FIRST_CONFIG, null, 2)}\n`, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  return true;
}

export function loadConfig(file = configPath()): LedungConfig {
  if (!fs.existsSync(file)) {
    throw new Error(`No config file at ${file}. Copy ledung.config.example.json to ledung.config.local.json and fill it in.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`The config file ${file} is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(raw);
}

/**
 * Which settings a changed config file applies without a restart (issue #353), in one place: the type makes every
 * new setting go in one of the two. "live": read when needed, so it counts from the next new or resumed session
 * (running ones keep what they started with). "restart": bound at start, by the server and its listener, the relay
 * link, the boards or the parts that copy the user's name, so the page says Restart Ledung to apply it.
 */
export const SETTING_RELOAD = {
  $comment: 'live',
  port: 'restart',
  userName: 'restart',
  lan: 'restart',
  lanSignIn: 'restart',
  projects: 'live',
  claudeAccounts: 'live',
  sensitive: 'live',
  maxWorkingSessions: 'live',
  usageStops: 'live',
  keepToolResultsDays: 'live',
  idleStopMinutes: 'live',
  browseRoots: 'live',
  projectsFolder: 'live',
  workflow: 'live',
  workflows: 'live',
  profiles: 'live',
  defaultProfiles: 'live',
  pluginsOff: 'live',
  remoteControl: 'live',
  claudeExecutable: 'live',
  windowsShell: 'live',
  board: 'restart',
  remote: 'restart',
  relayJoin: 'restart',
  computers: 'restart',
  chats: 'live',
} as const satisfies Record<keyof LedungConfig, 'live' | 'restart'>;

export type SettingName = keyof LedungConfig;

/** The top-level settings whose values differ between two configs, in SETTING_RELOAD's order. */
export function changedSettings(a: LedungConfig, b: LedungConfig): SettingName[] {
  return (Object.keys(SETTING_RELOAD) as SettingName[]).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/**
 * The config to run on after a reload: the new file's live settings over the running ones, with every restart-only
 * setting kept as Ledung started with it.
 */
export function withLiveSettings(running: LedungConfig, next: LedungConfig): LedungConfig {
  const merged: Record<string, unknown> = { ...running };
  for (const k of Object.keys(SETTING_RELOAD) as SettingName[]) if (SETTING_RELOAD[k] === 'live') merged[k] = next[k];
  return merged as LedungConfig;
}

/**
 * Why a config file can't be used, in one line for the page (issue #353). Never the file's text: V8's JSON errors
 * quote a piece of it, which may be a secret, so only the place is kept.
 */
export function configProblem(text: string): { config: LedungConfig } | { problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const where = /position (\d+)/.exec((e as Error).message);
    if (!where) return { problem: 'The config file is not valid JSON.' };
    const before = text.slice(0, Number(where[1])).split('\n');
    return { problem: `The config file is not valid JSON at line ${before.length}, column ${before.at(-1)!.length + 1}.` };
  }
  try {
    return { config: parseConfig(raw) };
  } catch (e) {
    const lines = (e as Error).message.split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
    return { problem: lines.length > 1 ? `${lines[0]} ${lines.slice(1).join('; ')}` : lines[0] ?? 'The config has problems.' };
  }
}
