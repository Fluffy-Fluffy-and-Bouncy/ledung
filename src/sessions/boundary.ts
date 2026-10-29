// What no session may read or change (#104): Ledung's data folder (the sign-in token, the database with
// every transcript and answer, the hosts' records, logs and secrets, the accounts' tokens) and the hosts'
// sockets. Everything runs as the same OS user, so only Claude Code can refuse it: Read and Edit deny
// rules in the settings layer Ledung passes (every OS, file tools), and the sandbox's denyRead for shell
// commands where Claude Code's sandbox runs (macOS, Linux; not native Windows). Set through that layer,
// a project's own settings can't lift them.
//
// One exception: an account's login folder may sit inside the data folder (accounts/<name>), and Claude
// Code keeps the session's memory and saved tool output there, so a session keeps its own login folder.
import fs from 'node:fs';
import path from 'node:path';
import { pipePath } from '../host/protocol.ts';

/** Files in the data folder that are denied even before they exist. */
const ALWAYS_DENIED = ['auth-token', 'ledung.db*', 'hosts', 'accounts/*.token'];

/**
 * The paths (absolute, `*` allowed in the last part) a session is refused: the whole data folder, or,
 * when the session's login folder is inside it, everything there but the way down to that folder.
 * list: a folder's entries; injected for tests.
 */
export function deniedPaths(dataDir: string, ownLoginFolder: string | null, list: (dir: string) => string[] = listDir, p: path.PlatformPath = path): string[] {
  const rel = ownLoginFolder ? p.relative(dataDir, ownLoginFolder) : '';
  if (!ownLoginFolder || !rel || rel.startsWith('..') || p.isAbsolute(rel)) return [dataDir];
  const out = ALWAYS_DENIED.map((d) => p.join(dataDir, d));
  // Down the path to the login folder, everything beside it is denied.
  let dir = dataDir;
  for (const part of rel.split(p.sep)) {
    for (const name of list(dir)) if (name !== part) out.push(p.join(dir, name));
    dir = p.join(dir, part);
  }
  return [...new Set(out)];
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** A path as Claude Code's permission rules write an absolute one: `//` first; on Windows C:\x is //c/x. */
export function rulePath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return `/${p}`;
  const posix = p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
  return `/${posix}`;
}

/** The settings that refuse them, for the settings layer Ledung passes to Claude Code. */
export function boundarySettings(o: {
  dataDir: string;
  ownLoginFolder: string | null;
  platform?: NodeJS.Platform;
  list?: (dir: string) => string[];
  realpath?: (p: string) => string;
  /** Where the hosts' Unix sockets are; by default where this computer's hosts put them. */
  socketDir?: string;
}): { permissions: { deny: string[] }; sandbox?: { filesystem: { denyRead: string[] } } } {
  const platform = o.platform ?? process.platform;
  const realpath = o.realpath ?? realpathOrSame;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const paths = deniedPaths(o.dataDir, o.ownLoginFolder, o.list, p);
  // Named pipes on Windows aren't files the tools open; the host's secret guards them (#104).
  if (platform !== 'win32') {
    const socketDir = o.socketDir ?? path.dirname(pipePath('x'));
    paths.push(p.join(socketDir, 'ledung-host-*'));
  }
  // The same place by its real path too (on macOS /tmp is /private/tmp), so neither spelling gets through.
  const all = [...new Set(paths.flatMap((d) => [d, realParent(d, realpath, p)]))];
  const deny = all.flatMap((d) => {
    const r = rulePath(d, platform);
    return [`Read(${r})`, `Read(${r}/**)`, `Edit(${r})`, `Edit(${r}/**)`];
  });
  return platform === 'win32'
    ? { permissions: { deny } }
    : { permissions: { deny }, sandbox: { filesystem: { denyRead: all } } };
}

function realpathOrSame(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** The path with its folder resolved (its last part may be a pattern or not exist yet). */
function realParent(d: string, realpath: (p: string) => string, p: path.PlatformPath): string {
  return p.join(realpath(p.dirname(d)), p.basename(d));
}

/**
 * Settings with the boundary added: deny rules and denyRead are added to any the session's settings
 * (its profile's settings file) already have; nothing else in them changes.
 */
export function withBoundary(settings: Record<string, unknown> | undefined, boundary: ReturnType<typeof boundarySettings>): Record<string, unknown> {
  const own = settings ?? {};
  const object = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const permissions = object(own.permissions);
  const out: Record<string, unknown> = { ...own, permissions: { ...permissions, deny: [...strings(permissions.deny), ...boundary.permissions.deny] } };
  if (boundary.sandbox) {
    const sandbox = object(own.sandbox);
    const filesystem = object(sandbox.filesystem);
    out.sandbox = { ...sandbox, filesystem: { ...filesystem, denyRead: [...strings(filesystem.denyRead), ...boundary.sandbox.filesystem.denyRead] } };
  }
  return out;
}
