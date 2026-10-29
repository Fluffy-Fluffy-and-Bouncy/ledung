// Project lockdown, "island" (issue #109): an opt-in per-project setting that walls a project off from
// other projects' agents. Off on every project unless set (Martin, 2026-10-15 19:02: "off by default").
// Level A: nothing reaches in, the project may reach out. Level B, nearly air-gapped, adds that it can't
// reach out either: its manager loses every tool that reaches other managers or projects, and its sessions
// launch with the airgap profile below (research report §5, "Level B"). Not on native Windows, where
// Claude Code doesn't sandbox shell commands: held by Martin (2026-10-15 19:12, "Hold that one").
//
// Ledung's own checks (management.ts, manager.ts) read the setting on every call, so a change applies at
// once. What Claude Code takes at launch (Remote Control, the board tools, the sandbox the other sessions
// run in) applies when Ledung restarts the sessions, keeping their conversations (manager.ts).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { rulePath } from '../sessions/boundary.ts';
import type { Profile } from '../sessions/profiles.ts';

export const LOCKDOWN_LEVELS = ['off', 'A', 'B'] as const;
export type LockdownLevel = (typeof LOCKDOWN_LEVELS)[number];

export const LockdownSetting = z.object({
  $comment: z.string().optional(),
  level: z.enum(LOCKDOWN_LEVELS).default('off'),
  /** The message board stays on for a locked project (Martin, 19:12: off by default). */
  board: z.boolean().optional(),
  /** Its manager keeps Remote Control (Martin, 19:12: off by default). */
  remoteControl: z.boolean().optional(),
  /** Level B: the hosts its shell commands may reach; none: no network at all. */
  network: z.array(z.string().min(1)).optional(),
  /** Level B, container project: the Docker network the user marked as its island network. */
  dockerNetwork: z.string().min(1).optional(),
}).optional();

export interface Lockdown {
  level: LockdownLevel;
  board: boolean;
  remoteControl: boolean;
  /** Level B: the hosts its shell may reach; none: no network. */
  network?: string[];
  /** Level B, container project: its marked island network. */
  dockerNetwork?: string | null;
}

export const NO_LOCKDOWN: Lockdown = { level: 'off', board: false, remoteControl: false, network: [], dockerNetwork: null };

/** A project's lockdown as stored; none: off. */
export function lockdownOf(p: { lockdown?: { level?: LockdownLevel; board?: boolean; remoteControl?: boolean; network?: string[]; dockerNetwork?: string | null } | null }): Lockdown {
  const l = p.lockdown;
  if (!l || !l.level || l.level === 'off') return NO_LOCKDOWN;
  // Hosts and an island network count only at level B: one saved at level A would otherwise come
  // along into B without the page (review round 1, finding 1).
  const b = l.level === 'B';
  return {
    level: l.level, board: l.board === true, remoteControl: l.remoteControl === true,
    network: b ? [...new Set(l.network ?? [])] : [], dockerNetwork: b ? l.dockerNetwork ?? null : null,
  };
}

export const isLocked = (p: Parameters<typeof lockdownOf>[0]) => lockdownOf(p).level !== 'off';

const RANK: Record<LockdownLevel, number> = { off: 0, A: 1, B: 2 };

/**
 * Whether going from one setting to the other opens the project up: a lower level, the board or Remote
 * Control let back in while it stays locked, or at level B a host or a Docker network let in. Only the
 * user may do that, from the open page (Martin, 2026-10-15: "turning it off or down a level only by
 * Martin from the page").
 */
export function opensUp(before: Lockdown, after: Lockdown): boolean {
  if (RANK[after.level] < RANK[before.level]) return true;
  if (after.level === 'off') return false;
  if ((after.board && !before.board) || (after.remoteControl && !before.remoteControl)) return true;
  if (after.level !== 'B') return false;
  const had = before.network ?? [];
  return (after.network ?? []).some((h) => !had.includes(h)) || (!!after.dockerNetwork && after.dockerNetwork !== before.dockerNetwork);
}

/** Whether what Claude Code takes at launch changes for the project's own sessions. */
export function launchChanges(before: Lockdown, after: Lockdown): boolean {
  return before.level !== after.level || before.board !== after.board || before.remoteControl !== after.remoteControl
    || (before.network ?? []).join('\n') !== (after.network ?? []).join('\n') || (before.dockerNetwork ?? null) !== (after.dockerNetwork ?? null);
}

/**
 * Why this lockdown can't be set here, or null. Level B on native Windows is held by Martin (2026-10-15
 * 19:12, "unsure for now. Hold that one"): not offered, never quietly treated as A.
 */
export function levelProblem(l: Lockdown, platform: NodeJS.Platform = process.platform): string | null {
  return l.level === 'B' && platform === 'win32'
    ? 'Lockdown level B (nearly air-gapped) is not available on Windows yet: Claude Code runs shell commands there without its sandbox. Use level A.'
    : null;
}

/** The folders a project keeps to itself: its folder and its extra folders (its worktrees). None for a container project. */
export function projectFolders(p: { runner: string; path?: string; extraFolders?: string[] }): string[] {
  return p.runner === 'local' && p.path ? [p.path, ...(p.extraFolders ?? [])] : [];
}

function realOrResolved(folder: string): string {
  try {
    return fs.realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
}

/** Is `inner` the folder `outer` or inside it? Real paths, so a link can't hide it. */
export function within(outer: string, inner: string): boolean {
  const rel = path.relative(realOrResolved(outer), realOrResolved(inner));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Why a folder can't belong to another project while `locked` is locked: it is one of the locked
 * project's folders or inside one. A folder that contains a locked one stays allowed (a workspace
 * folder above several projects); its sessions are denied the locked folder like every other session.
 */
export function overlapProblem(folder: string, lockedName: string, lockedFolders: string[]): string | null {
  const hit = lockedFolders.find((f) => within(f, folder));
  return hit ? `${folder} is inside the locked project "${lockedName}" (${hit}); a locked project's folders are its own.` : null;
}

/**
 * What every session outside the locked projects gets while at least one project is locked (Martin,
 * 2026-10-15 19:12: "yes"): Read and Edit deny rules on the locked folders (file tools, every OS) and,
 * on macOS and Linux, its shell in Claude Code's sandbox with those folders denied to read and write.
 * No unsandboxed retry, so a command can't step around it; sandboxed commands still prompt as before
 * (no auto-allow), so nothing is allowed that wasn't. Native Windows has no sandbox: file tools only.
 * None locked: nothing, so a Ledung with no locked project runs exactly as before.
 */
export function othersSettings(lockedFolders: string[], platform: NodeJS.Platform = process.platform): {
  permissions: { deny: string[] };
  sandbox?: { enabled: true; failIfUnavailable: true; allowUnsandboxedCommands: false; autoAllowBashIfSandboxed: false; filesystem: { denyRead: string[]; denyWrite: string[] } };
} | null {
  if (!lockedFolders.length) return null;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const all = [...new Set(lockedFolders.flatMap((f) => [p.resolve(f), platform === process.platform ? realOrResolved(f) : p.resolve(f)]))];
  const deny = all.flatMap((d) => {
    const r = rulePath(d, platform);
    return [`Read(${r})`, `Read(${r}/**)`, `Edit(${r})`, `Edit(${r}/**)`];
  });
  if (platform === 'win32') return { permissions: { deny } };
  return {
    permissions: { deny },
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, filesystem: { denyRead: all, denyWrite: all } },
  };
}

/** Settings with the lockdown's added to what is there: deny rules and denied paths are added, the sandbox switched on. */
export function withOthersSettings(settings: Record<string, unknown> | undefined, extra: ReturnType<typeof othersSettings>): Record<string, unknown> | undefined {
  if (!extra) return settings;
  const own = settings ?? {};
  const object = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const permissions = object(own.permissions);
  const out: Record<string, unknown> = { ...own, permissions: { ...permissions, deny: [...strings(permissions.deny), ...extra.permissions.deny] } };
  if (extra.sandbox) {
    const sandbox = object(own.sandbox);
    const filesystem = object(sandbox.filesystem);
    const { filesystem: fsExtra, ...switches } = extra.sandbox;
    out.sandbox = {
      ...sandbox, ...switches,
      filesystem: {
        ...filesystem,
        denyRead: [...strings(filesystem.denyRead), ...fsExtra.denyRead],
        denyWrite: [...strings(filesystem.denyWrite), ...fsExtra.denyWrite],
      },
    };
  }
  return out;
}

// --- Level B, nearly air-gapped (research report §5) -------------------------------------------------

/**
 * Claude Code's own tools that reach beyond the session: the web, the cloud, other Claude sessions on
 * this computer, the user's phone, published artifacts. A level B session doesn't get them.
 */
export const AIRGAP_DISALLOWED_TOOLS = [
  'WebFetch', 'WebSearch', 'RemoteTrigger', 'SendMessage', 'ListAgents', 'PushNotification', 'DesignSync',
  'Artifact', 'ArtifactComments', 'ArtifactData', 'ArtifactCheck',
];

/**
 * The profile every level B session runs with, whatever profile it was started with: none of the user's
 * MCP servers, plugins or settings (hooks, allow rules), and none of the tools above. A profile's settings
 * file is left out too, so nothing in it can widen the airgap.
 */
export const AIRGAP_PROFILE: Profile = { mcpServers: 'none', plugins: 'none', disallowedTools: AIRGAP_DISALLOWED_TOOLS, userSettings: false };

/**
 * The oldest Claude Code a level B session runs on: the version these settings were checked against
 * (the Agent SDK's own, 2.1.295, 2026-10-15). An older one may not know a setting the airgap relies on
 * (blockReadsOutsideWorkingDirectories came in 2.1.257; the sandbox's strictAllowlist has no documented
 * first version) and would ignore it without a word, so it is refused instead.
 */
export const AIRGAP_MIN_CLAUDE = '2.1.295';

/** Why this Claude Code version can't run a level B session, or null. version null: it couldn't be found. */
export function versionProblem(version: string | null): string | null {
  const parts = (v: string) => (v.match(/\d+(\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  if (version !== null) {
    const have = parts(version);
    const need = parts(AIRGAP_MIN_CLAUDE);
    const first = need.findIndex((n, i) => (have[i] ?? 0) !== n);
    if (first < 0 || (have[first] ?? 0) > need[first]!) return null;
  }
  return `Lockdown level B needs Claude Code ${AIRGAP_MIN_CLAUDE} or newer, and ${version === null ? "its version couldn't be read" : `this is ${version.trim()}`}. Update Claude Code, or set the project to level A.`;
}

/**
 * Where shell commands can still read outside the session's folders once Claude Code's outside-reads
 * block is on: it walls the home folders, /Users and /Volumes itself, but not the shared temp places,
 * where other programs and other Claude sessions leave files (review round 1, test finding 1: a `cat`
 * of a file in /tmp succeeded). Real paths: on macOS a rule on the /tmp or /var link itself breaks every
 * command, and denying / as a whole stops git and the shell (tried on 2.1.295, 2026-10-15).
 */
const SHARED_READ_PLACES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/private/tmp', '/private/var/tmp', '/private/var/folders'],
  linux: ['/tmp', '/var/tmp', '/home', '/root', '/mnt', '/media', '/srv', '/run/user'],
};

/**
 * A level B session's own temp folder, which Claude Code uses instead of the shared one
 * (CLAUDE_CODE_TMPDIR): the shared one holds every project's background output. Under /tmp, which the
 * airgap walls, and let back in for this session only. Short: Claude Code makes sockets inside it, and
 * with too long a path it quietly gives the shell the shared folder again (seen live at 46 characters
 * with its own sub-folder, fine at 31 and 35; 2.1.295, 2026-10-15).
 */
export function airgapTempFolder(sessionId: string): string {
  return path.posix.join('/tmp', `lb-${sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`);
}

/**
 * Makes the session's temp folder, private to this user, and returns its real path. Refuses one that
 * is there already but isn't a private folder of this user's, so nobody can hand a session theirs.
 */
export function makeAirgapTempFolder(folder: string): string {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(folder);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) {
    throw new Error(`The temp folder ${folder} for this nearly air-gapped session isn't a private folder of this user's; remove it and start again.`);
  }
  return fs.realpathSync(folder);
}

/**
 * What a level B session's settings get, on top of everything else (the data-folder boundary, other
 * locked projects' folders). Set through the flag layer, so the project's own settings can't loosen it:
 * - file tools refuse reads outside the working folders, in every mode;
 * - no claude.ai connectors, no project MCP servers, no hooks from settings files or plugins (they run
 *   outside the sandbox; Ledung's own hooks are not settings hooks), no bypass mode;
 * - the session can't change its project's Claude Code settings or MCP file, so it can't loosen its next launch;
 * - with `sandbox` (a session on this computer, macOS or Linux): shell commands in the sandbox with no way
 *   out (no unsandboxed retry, no excluded commands, no extra write paths), no reads outside its folders
 *   and its own temp folder `tmp` (Claude Code's block plus the shared places above), and no network but
 *   the hosts the user let in, refused outright rather than asked.
 * A container project runs without the sandbox: the container is the wall, checked before each start.
 */
export function airgapSettings(o: { network: string[]; folders: string[]; sandbox: boolean; tmp?: string | null; platform?: NodeJS.Platform }): Record<string, unknown> {
  const platform = o.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const own = [...new Set(o.folders.flatMap((f) => ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json'].map((x) => p.join(f, x))))];
  const out: Record<string, unknown> = {
    permissions: {
      deny: [...own.map((f) => `Edit(${rulePath(f, platform)})`), ...AIRGAP_DISALLOWED_TOOLS.slice(0, 2)],
      blockReadsOutsideWorkingDirectories: true,
      disableBypassPermissionsMode: 'disable',
    },
    disableClaudeAiConnectors: true,
    enableAllProjectMcpServers: false,
    disableAllHooks: true,
  };
  if (o.sandbox) {
    out.sandbox = {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, excludedCommands: [],
      network: { allowedDomains: o.network, strictAllowlist: true, allowAllUnixSockets: false, allowUnixSockets: [], allowLocalBinding: false },
      filesystem: {
        denyRead: SHARED_READ_PLACES[platform] ?? [],
        // Its own folders and temp folder only (they may sit in a walled place, such as a project under /tmp).
        allowRead: [...new Set([...o.folders.flatMap((f) => [p.resolve(f), platform === process.platform ? realOrResolved(f) : p.resolve(f)]), ...(o.tmp ? [o.tmp] : [])])],
        allowWrite: [], denyWrite: own,
      },
    };
  }
  return out;
}

/**
 * Settings with the airgap's laid over them: deny rules and denied paths are added to what is there; every
 * other airgap key replaces the session's own, so a profile or settings file can't keep a way out.
 */
export function withAirgapSettings(settings: Record<string, unknown> | undefined, airgap: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!airgap) return settings;
  const own = settings ?? {};
  const object = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const permissions = object(own.permissions);
  const extraPermissions = object(airgap.permissions);
  const out: Record<string, unknown> = {
    ...own, ...airgap,
    permissions: { ...permissions, ...extraPermissions, deny: [...strings(permissions.deny), ...strings(extraPermissions.deny)] },
  };
  if (airgap.sandbox) {
    const sandbox = object(own.sandbox);
    const filesystem = object(sandbox.filesystem);
    const extra = object(airgap.sandbox);
    const extraFs = object(extra.filesystem);
    out.sandbox = {
      ...sandbox, ...extra,
      filesystem: {
        ...filesystem, ...extraFs,
        denyRead: [...strings(filesystem.denyRead), ...strings(extraFs.denyRead)],
        denyWrite: [...strings(filesystem.denyWrite), ...strings(extraFs.denyWrite)],
      },
    };
  }
  return out;
}

/**
 * The environment a level B session keeps of Ledung's: what a shell and Claude Code need to run and to
 * log in, nothing else, so tokens, SSH agents and cloud keys in Ledung's environment don't reach it
 * (research report, finding 0.4). An account's own login is added after this.
 */
const AIRGAP_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LANGUAGE', 'TERM', 'TZ', 'COLORTERM',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

export function airgapEnvironment(env: NodeJS.ProcessEnv, tmp: string | null = null): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(env).filter(([k]) => AIRGAP_ENV.has(k) || k.startsWith('LC_')));
  // Its own temp folder, for Claude Code and for the shell (the shared ones are walled).
  return tmp ? { ...kept, CLAUDE_CODE_TMPDIR: tmp, TMPDIR: tmp, TMP: tmp, TEMP: tmp } : kept;
}

/**
 * Why a container can't hold a level B project, from `docker inspect`'s record of it, or null: a mount
 * of the Docker socket (control of every container), a mount outside the project folder, or a network
 * the user didn't mark as the island network. Host networking counts as unmarked; no network is fine.
 */
export function containerProblem(inspected: unknown, o: { container: string; folder: string; network: string | null }): string | null {
  const c = (Array.isArray(inspected) ? inspected[0] : inspected) as {
    Mounts?: { Source?: string; Destination?: string }[];
    HostConfig?: { NetworkMode?: string };
    NetworkSettings?: { Networks?: Record<string, unknown> };
  } | undefined;
  if (!c || typeof c !== 'object') return `Docker gave no record of the container "${o.container}".`;
  const mounts = c.Mounts ?? [];
  const socket = mounts.find((m) => [m.Source, m.Destination].some((x) => x?.endsWith('docker.sock')));
  if (socket) return `The container "${o.container}" has the Docker socket mounted (${socket.Destination}); a level B project's container can't control Docker.`;
  const outside = mounts.find((m) => {
    const rel = path.posix.relative(o.folder, m.Destination ?? '/');
    return rel.startsWith('..') || path.posix.isAbsolute(rel);
  });
  if (outside) return `The container "${o.container}" mounts ${outside.Source ?? 'a volume'} at ${outside.Destination}, outside the project folder ${o.folder}; a level B project's container may mount only that folder.`;
  const mode = c.HostConfig?.NetworkMode ?? '';
  const networks = Object.keys(c.NetworkSettings?.Networks ?? {});
  if (mode === 'none' && networks.every((n) => n === 'none')) return null;
  const unmarked = (mode === 'host' ? ['host'] : networks.length ? networks : [mode || 'default']).filter((n) => n !== o.network);
  if (unmarked.length) {
    return `The container "${o.container}" is on the network ${unmarked.map((n) => `"${n}"`).join(', ')}, which isn't marked as this project's island network${o.network ? ` ("${o.network}")` : ' (none is marked)'}. Mark it in the project's lockdown settings once it only reaches what the project may.`;
  }
  return null;
}
