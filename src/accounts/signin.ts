// Is Claude Code signed in for an account (issue #333)? Asked with `claude auth status --json` of the
// Claude Code sessions start (the user's installed one or the SDK's copy, issue #341), so the answer is
// about the same build and login a session gets. It reads the login where Claude Code keeps it and calls
// no one: no tokens are spent (checked on Claude Code 2.1.304, 2026-10-27: exit 0 and "loggedIn": true
// signed in, by account, token or API key; exit 1 and "loggedIn": false with an empty login folder). A token's or a key's worth is not checked: one that
// is present counts as signed in, and a bad one still fails at the session's first turn.
import { execFile } from 'node:child_process';
import { commandFor, sdkClaudeBinary } from '../runners/claude-program.ts';
import type { SignInInfo } from '../shared/protocol.ts';

export type SignIn = Omit<SignInInfo, 'account'>;

/** What running a command gave: its exit code (null: it didn't run or was stopped) and what it printed. */
export interface CommandResult {
  code: number | null;
  stdout: string;
  /** Why it didn't run, when it didn't. */
  error?: string;
}

export type RunCommand = (command: string, args: string[], env: Record<string, string>, timeoutMs: number, cwd?: string) => Promise<CommandResult>;

/** The SDK's own copy of Claude Code, which a check uses when it is given no other (issue #341 moved it to the runners). */
export { sdkClaudeBinary } from '../runners/claude-program.ts';

/** What `claude auth status --json` said, as signed in, signed out, or unknown with why. */
export function readAuthStatus(result: CommandResult): SignIn {
  const at = Date.now();
  if (result.error) return { state: 'unknown', method: null, detail: result.error, checkedAt: at };
  const parsed = jsonOf(result.stdout) as { loggedIn?: unknown; authMethod?: unknown } | null;
  if (!parsed || typeof parsed.loggedIn !== 'boolean') {
    return { state: 'unknown', method: null, detail: `claude auth status gave no answer (exit code ${result.code ?? 'none'})`, checkedAt: at };
  }
  const method = typeof parsed.authMethod === 'string' && parsed.authMethod !== 'none' ? parsed.authMethod : null;
  return parsed.loggedIn ? { state: 'in', method, detail: null, checkedAt: at } : { state: 'out', method: null, detail: null, checkedAt: at };
}

/** Parsed JSON, or null for anything else (an older Claude Code without the command, an error text). */
function jsonOf(text: string): unknown {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** Runs a command and never throws: a non-zero exit is an answer too (signed out is exit 1). */
export const runCommand: RunCommand = (command, args, env, timeoutMs, cwd) => new Promise((resolve) => {
  execFile(command, args, { env, cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
    if (!e) return resolve({ code: 0, stdout: String(stdout) });
    if (e.killed) return resolve({ code: null, stdout: '', error: `Claude Code did not answer within ${Math.round(timeoutMs / 1000)} s` });
    if (typeof e.code === 'number') return resolve({ code: e.code, stdout: String(stdout ?? '') });
    resolve({ code: null, stdout: '', error: `Claude Code could not be run (${e.code ?? e.message})` });
  });
});

/** Where a session runs, for its start's check: a project's own settings can sign it in (review of #333, point 3). */
export interface SignInContext {
  /** The session's folder: Claude Code reads the project's .claude/settings(.local).json there (apiKeyHelper, env). */
  cwd: string;
  /** The settings Ledung gives the session on top (its profile's and the profile's settings file), which can too. */
  settings?: Record<string, unknown>;
}

/**
 * Whether Claude Code is signed in with this environment (the one a session of the account gets), and
 * with a session's folder and settings when given, as the session itself would be. Never throws: a check
 * that can't run is "unknown", and nothing is refused on it.
 */
export async function checkSignIn(
  env: Record<string, string>,
  opts: { binary?: string | null; run?: RunCommand; timeoutMs?: number; where?: SignInContext } = {},
): Promise<SignIn> {
  const binary = opts.binary !== undefined ? opts.binary : sdkClaudeBinary();
  if (!binary) return { state: 'unknown', method: null, detail: 'no Claude Code to ask: it is not installed, or too old (see Settings → Claude Code)', checkedAt: Date.now() };
  // --settings goes before the command: `auth status` has no option of its own for it (Claude Code 2.1.304).
  const settings = opts.where?.settings && Object.keys(opts.where.settings).length ? ['--settings', JSON.stringify(opts.where.settings)] : [];
  const { command, args } = commandFor(binary);
  return readAuthStatus(await (opts.run ?? runCommand)(command, [...args, ...settings, 'auth', 'status', '--json'], env, opts.timeoutMs ?? 15000, opts.where?.cwd));
}

/** A container login folder as the shell writes it: "~/" becomes the container user's $HOME (kept paths have no quotes or "$"). */
export function shellFolder(folder: string): string {
  return folder.startsWith('~/') ? `"$HOME/${folder.slice(2)}"` : `'${folder}'`;
}

/** Where a container session runs: its container, and the user it runs as (none: the image's). */
export interface ContainerPlace {
  container: string;
  user?: string;
}

/** Where one of an account's login folders is: on this computer, or in a container its projects run in (issue #342). */
export type LoginPlace = { kind: 'local'; folder: string } | ({ kind: 'docker'; folder: string } & ContainerPlace);

/** `docker exec` into the place, as its sessions run there. */
export function dockerExecArgs(place: ContainerPlace, interactive: '-i' | '-it' | null = null): string[] {
  return ['exec', ...(interactive ? [interactive] : []), ...(place.user ? ['-u', place.user] : []), place.container];
}

/**
 * Whether Claude Code in the container is signed in with this login folder: its `claude auth status`, with the
 * container's own token and key left out, so the answer is about the folder (issue #342). Never throws.
 */
export async function checkContainerSignIn(place: ContainerPlace, folder: string | null, opts: { run?: RunCommand; timeoutMs?: number } = {}): Promise<SignIn> {
  // null: a new, empty sign-in folder made for the question and removed after it (review of #342, R2-I1).
  const script = folder === null
    ? 'D=$(mktemp -d) || exit 1; CLAUDE_SECURESTORAGE_CONFIG_DIR="$D" env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN claude auth status --json; r=$?; rm -rf "$D"; exit $r'
    : `CLAUDE_SECURESTORAGE_CONFIG_DIR=${shellFolder(folder)} exec env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN claude auth status --json`;
  const result = await (opts.run ?? runCommand)('docker', [...dockerExecArgs(place), 'sh', '-c', script], process.env as Record<string, string>, opts.timeoutMs ?? 20000);
  // Not running, or no Claude Code in it: an answer that isn't JSON says so.
  return readAuthStatus(result);
}

/** How to sign in, for the page's banner and a refused session start. What to type is between backticks. */
export function signInHelp(account: { name: string; kind: 'default' | 'folder'; configDir?: string | null }, platform = process.platform): string {
  if (account.kind === 'default') {
    return 'Claude Code is not signed in on this computer. Open a terminal, run `claude` and type `/login`, '
      + 'or give Ledung an API key in `ANTHROPIC_API_KEY`; then press Check again.';
  }
  const run = signInCommand(account.configDir ?? '', platform);
  const shell = platform === 'win32' ? 'PowerShell' : 'a terminal';
  return `The account "${account.name}" is not signed in. In ${shell}, run \`${run}\` and type \`/login\`; then press Check again.`;
}

/** The command that starts Claude Code on a sign-in folder of this computer: PowerShell on Windows, else sh (issue #425 shares it). */
export function signInCommand(dir: string, platform = process.platform): string {
  // The sign-in folder goes in Claude Code's environment, which each shell sets its own way. The path is the
  // one Ledung keeps, written exactly so: macOS names the Keychain entry from it (#342).
  return platform === 'win32' ? `$env:CLAUDE_SECURESTORAGE_CONFIG_DIR="${dir}"; claude` : `CLAUDE_SECURESTORAGE_CONFIG_DIR="${dir}" claude`;
}

/** The command, run on this computer, that starts Claude Code on a sign-in folder inside a container. */
export function containerSignInCommand(place: ContainerPlace, folder: string): string {
  // No double quotes inside: Windows PowerShell 5.1 drops them from a program's arguments. Kept container
  // folders have no spaces, so none are needed.
  const dir = folder.startsWith('~/') ? `$HOME/${folder.slice(2)}` : folder;
  return `docker ${dockerExecArgs(place, '-it').join(' ')} sh -c 'CLAUDE_SECURESTORAGE_CONFIG_DIR=${dir} exec claude'`;
}

/** How to sign in to an account's login folder inside a container (issue #342). */
export function containerSignInHelp(name: string, place: ContainerPlace, folder: string): string {
  const run = containerSignInCommand(place, folder);
  return `The account "${name}" is not signed in inside the container "${place.container}". On this computer, run \`${run}\` and type \`/login\`; then press Check again.`;
}
