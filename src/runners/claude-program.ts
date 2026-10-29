// Which Claude Code a session on this computer runs (issue #341): the user's own installed `claude` by default,
// so Ledung is a front end to the user's Claude Code (#339 point 3), or the copy the Agent SDK installs with
// Ledung when the config asks for it. The SDK names the Claude Code it was built against in its package.json
// (`claudeCodeVersion`), and `claude --version` prints "2.1.304 (Claude Code)" without signing in or spending
// tokens (checked 2026-10-27 on 2.1.295 and 2.1.304). An installed one older than the SDK's own, one whose
// version can't be read, or none at all is never run: the SDK speaks to Claude Code in a protocol that moves
// with it, so an older program may misread what it is sent. Sessions are refused and the page says how to
// install or update it; nothing falls back silently (Martin, 2026-10-27).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeCodeView, ClaudeProgramInfo } from '../shared/protocol.ts';
import { PACKAGED } from '../platform/paths.ts';

const SDK = '@anthropic-ai/claude-agent-sdk';

/** The config's "claudeExecutable": "installed", "bundled", or a full path to a Claude Code program. */
export type ClaudeSetting = string;

/**
 * The Claude Code binary the Agent SDK starts on this computer when it is given none, found the way the SDK
 * finds it (its platform package; on Linux the musl build first where there is no glibc); null when none is installed.
 */
export function sdkClaudeBinary(resolve: (id: string) => string = createRequire(import.meta.resolve(SDK)).resolve): string | null {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const arch = process.arch;
  let packages = [`${SDK}-${process.platform}-${arch}`];
  if (process.platform === 'linux') {
    const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
    const musl = report !== undefined && report.header?.glibcVersionRuntime === undefined;
    packages = musl ? [`${SDK}-linux-${arch}-musl`, `${SDK}-linux-${arch}`] : [`${SDK}-linux-${arch}`, `${SDK}-linux-${arch}-musl`];
  }
  for (const p of packages) {
    try {
      return resolve(`${p}/claude${exe}`);
    } catch {
      // Not installed for this platform: try the next.
    }
  }
  return null;
}

/** The Claude Code version the Agent SDK was built against, from its package.json; null if it can't be read. */
export function sdkClaudeVersion(): string | null {
  try {
    const sdk = path.dirname(fileURLToPath(import.meta.resolve(SDK)));
    const v = (JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'), 'utf8')) as { claudeCodeVersion?: unknown }).claudeCodeVersion;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** The x.y.z at the start of `claude --version`'s answer ("2.1.304 (Claude Code)"); null for anything else. */
export function parseVersion(text: string): string | null {
  return text.trim().match(/^v?(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

/** Whether version `have` is at least `need`, both x.y.z. */
export function atLeast(have: string, need: string): boolean {
  const a = have.split('.').map(Number);
  const b = need.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** How to run a Claude Code program: a JavaScript one (an older npm install) runs with Node, as the SDK runs it. */
export function commandFor(program: string): { command: string; args: string[] } {
  return /\.(c|m)?js$/i.test(program) ? { command: process.execPath, args: [program] } : { command: program, args: [] };
}

/** What finding and checking Claude Code needs of the computer; the tests give their own. */
export interface Lookup {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  /** Size and change time of a file, following links; null when it isn't a file. */
  stat(file: string): { size: number; mtimeMs: number } | null;
  readText(file: string): string | null;
  realpath(file: string): string;
  /** What `<program> --version` printed, or null when it failed or took too long. */
  versionText(program: string): Promise<string | null>;
  /** The SDK's own copy and the version it expects. */
  bundled: string | null;
  required: string | null;
  /** Installed from npm, whose package leaves the SDK's copies out (#421). */
  packaged?: boolean;
}

const runVersion = (program: string): Promise<string | null> => new Promise((resolve) => {
  const { command, args } = commandFor(program);
  execFile(command, [...args, '--version'], { windowsHide: true, timeout: 15000 }, (err, stdout) => resolve(err ? null : String(stdout)));
});

export function realLookup(): Lookup {
  return {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    stat: (file) => {
      try {
        const s = fs.statSync(file);
        return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
      } catch {
        return null;
      }
    },
    readText: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    realpath: (file) => {
      try {
        return fs.realpathSync(file);
      } catch {
        return file;
      }
    },
    versionText: runVersion,
    bundled: sdkClaudeBinary(),
    required: sdkClaudeVersion(),
    packaged: PACKAGED,
  };
}

/** Why "bundled" has nothing to run, and what to do instead. */
function noBundledProblem(look: Lookup): string {
  if (!look.packaged) return `Ledung has no Claude Code of its own for ${look.platform}-${process.arch} ("claudeExecutable": "bundled" in the config). Install Claude Code from ${INSTALL_LINK} and set it back to "installed".`;
  // The npm package pins its dependencies with a shrinkwrap that leaves the SDK's eight per-platform
  // copies out, or npm would install all of them, 2.0 GB (#421; the lead's decision on question #447).
  return `Ledung installed from npm has no Claude Code of its own ("claudeExecutable": "bundled" in the config). Install Claude Code from ${INSTALL_LINK}, then set "claudeExecutable" back to "installed" in the config file (Settings → Config file says where it is).`;
}

/**
 * The program behind an npm shim on Windows: `claude.cmd` names it relative to its own folder as
 * "%dp0%\node_modules\...\cli.js" (or "%~dp0\..."); null when it names none that exists.
 */
export function shimTarget(shim: string, look: Pick<Lookup, 'readText' | 'stat'>): string | null {
  const text = look.readText(shim);
  if (!text) return null;
  const dir = path.win32.dirname(shim);
  const found = [...text.matchAll(/"%~?dp0%?\\?([^"%]+?\.(?:exe|c?js|mjs))"/gi)].map((m) => path.win32.join(dir, m[1]!));
  return found.reverse().find((f) => look.stat(f) !== null) ?? null;
}

/** The places Claude Code's installers put `claude`, after the PATH: the native installer, npm, Homebrew. */
export function knownLocations(look: Pick<Lookup, 'platform' | 'env' | 'home'>): string[] {
  const { home, env } = look;
  if (look.platform === 'win32') {
    const p = path.win32;
    const appData = env.APPDATA ?? p.join(home, 'AppData', 'Roaming');
    return [p.join(home, '.local', 'bin', 'claude.exe'), p.join(appData, 'npm', 'claude.cmd'), ...(env.npm_config_prefix ? [p.join(env.npm_config_prefix, 'claude.cmd')] : [])];
  }
  const p = path.posix;
  return [
    p.join(home, '.local', 'bin', 'claude'),
    p.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/home/linuxbrew/.linuxbrew/bin/claude',
    p.join(home, '.npm-global', 'bin', 'claude'),
    ...(env.npm_config_prefix ? [p.join(env.npm_config_prefix, 'bin', 'claude')] : []),
  ];
}

/**
 * The program to start for a `claude` found on disk: itself, the program an npm shim names on Windows,
 * or, for a link to a JavaScript file (npm on macOS and Linux), that file, which runs with Node. Null when
 * it can't be started directly (a shim that names nothing that exists).
 */
function programOf(file: string, look: Lookup): string | null {
  if (look.platform === 'win32') {
    if (/\.exe$/i.test(file)) return file;
    return /\.cmd$/i.test(file) ? shimTarget(file, look) : null;
  }
  const real = look.realpath(file);
  return /\.(c|m)?js$/i.test(real) ? real : file;
}

/**
 * The user's own Claude Code: the first `claude` on the PATH, then the usual install locations. Ledung's own
 * copy (the SDK's, or one in Ledung's node_modules on a PATH an npm script set) is never taken for it.
 */
export function findInstalled(look: Lookup): string | null {
  const win = look.platform === 'win32';
  const sep = win ? ';' : ':';
  const names = win ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const pathVar = look.env.PATH ?? look.env.Path ?? '';
  const onPath = pathVar.split(sep).filter(Boolean).flatMap((dir) => names.map((n) => (win ? path.win32 : path.posix).join(dir, n)));
  const bundled = look.bundled ? look.realpath(look.bundled) : null;
  const same = (a: string, b: string) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const file of [...onPath, ...knownLocations(look)]) {
    if (!look.stat(file)) continue;
    const program = programOf(file, look);
    if (!program || !look.stat(program)) continue;
    const real = look.realpath(program);
    if (bundled && same(real, bundled)) continue;
    if (/[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-agent-sdk/i.test(real)) continue;
    return program;
  }
  return null;
}

/** `--version` answers by program, kept while the file is unchanged: an update to Claude Code is read again. */
const versions = new Map<string, { size: number; mtimeMs: number; version: string | null }>();

/** The version a program reports, read once per change of the file. */
export async function programVersion(program: string, look: Lookup): Promise<string | null> {
  const s = look.stat(program);
  if (!s) return null;
  const known = versions.get(program);
  if (known && known.size === s.size && known.mtimeMs === s.mtimeMs) return known.version;
  const version = parseVersion((await look.versionText(program)) ?? '');
  versions.set(program, { ...s, version });
  return version;
}

/** Forgets the versions read so far (tests). */
export function forgetVersions(): void {
  versions.clear();
}

/** What a session started now gets, and why when it isn't what the setting asks for. */
export type ClaudeChoice = ClaudeCodeView;

/** Where Claude Code is installed from, for the page's banner and a refused start. */
export const INSTALL_LINK = 'https://code.claude.com/docs/en/setup';

/**
 * The Claude Code a session on this computer starts with this setting: the installed one or a given path,
 * which must be there and at least the version the SDK was built for; or the SDK's copy, only when the
 * setting says "bundled" (Martin, 2026-10-27, on #341: installed Claude Code is a requirement, with no silent
 * fallback). Otherwise there is no program, and the problem says how to install or update it.
 */
export async function chooseClaude(setting: ClaudeSetting = 'installed', look: Lookup = realLookup()): Promise<ClaudeChoice> {
  const required = look.required;
  const bundledVersion = look.bundled ? await programVersion(look.bundled, look) ?? required : null;
  const bundled: ClaudeProgramInfo | null = look.bundled ? { kind: 'bundled', path: look.bundled, version: bundledVersion } : null;
  const base = { setting, required, bundled };
  if (setting === 'bundled') {
    return { ...base, installed: null, program: bundled, problem: bundled ? null : noBundledProblem(look) };
  }
  const given = setting !== 'installed';
  const found = given ? (look.stat(setting) ? programOf(setting, look) : null) : findInstalled(look);
  const version = found ? await programVersion(found, look) : null;
  const installed: ClaudeProgramInfo | null = found ? { kind: given ? 'path' : 'installed', path: found, version } : null;
  let problem: string | null = null;
  if (!required) {
    // Without the SDK's own version nothing can be checked, and an unchecked Claude Code is never run (review of #341).
    problem = "Ledung could not read which Claude Code version its Agent SDK needs (the SDK's package.json). Install Ledung again (`npm install`).";
  } else if (!found) {
    problem = given
      ? `Ledung runs your Claude Code, and there is none at ${setting} (the config's "claudeExecutable"). Install it from ${INSTALL_LINK}, or correct the path.`
      : `Ledung runs your Claude Code, and it isn't installed on this computer. Install it from ${INSTALL_LINK}, then press Check again.`;
  } else if (!version) {
    problem = `Ledung runs your Claude Code, and the version of the one at ${found} couldn't be read. Update it (\`claude update\`) or install it again from ${INSTALL_LINK}.`;
  } else if (!atLeast(version, required)) {
    problem = `Ledung runs your Claude Code, and yours is ${version}; Ledung needs ${required} or newer. Update it (\`claude update\`), then press Check again.`;
  }
  return { ...base, installed, program: problem ? null : installed, problem };
}
