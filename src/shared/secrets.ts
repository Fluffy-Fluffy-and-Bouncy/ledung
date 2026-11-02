// A secret locked in the message box (issue #468): the message carries a token with its name, the value goes
// to Ledung on its own, and Claude is told only that the name is available as an environment variable.
// Shared by the page (the lock, the chip, the default name) and Ledung (expanding the token for Claude).

/**
 * How long a secret lives: for the one message's turn, for this session (until it is archived), for this
 * session until removed, or for every session of its project until removed.
 */
export type SecretLifetime = 'once' | 'session' | 'kept' | 'project';
export const SECRET_LIFETIMES: readonly SecretLifetime[] = ['once', 'session', 'kept', 'project'];

export const SECRET_LIFETIME_LABEL: Record<SecretLifetime, string> = {
  once: 'Once: this message',
  session: 'This session',
  kept: 'This session, until removed',
  project: 'All sessions of the project, until removed',
};

/** What the page sees of a secret: never its value. */
export interface SecretInfo {
  id: string;
  name: string;
  /** The environment variable it is in: the name in capitals, "-" and "." as "_". */
  env: string;
  lifetime: SecretLifetime;
  createdAt: number;
  /**
   * Whether the session's running Claude Code gets it in its commands now. False when the session runs with
   * an environment fixed before this release (it gets it from its next start or resume) or isn't running.
   */
  reachesNow: boolean;
}

/** The token a locked secret leaves in the message: `[🔑 name]`. */
export const secretToken = (name: string): string => `[🔑 ${name}]`;
const TOKEN = /\[🔑 ([a-z][a-z0-9._-]{0,39})\]/g;

/** The names of the secret tokens in a text, in order, each once. */
export function tokenNames(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[1]!))];
}

/** A secret's environment variable. */
export const envName = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9]/g, '_');

// Variables a shell, Claude Code or Ledung relies on: a secret by such a name would change how commands run
// or which account Claude Code uses, or be dropped on the way (sessionEnv strips LEDUNG_*).
const RESERVED = new Set([
  'PATH', 'HOME', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'TERM', 'IFS', 'ENV',
  'PS1', 'PS2', 'PS4', 'PROMPT_COMMAND', 'HOSTNAME', 'SHLVL', 'CDPATH', 'SHELLOPTS', 'BASHOPTS', 'NODE_OPTIONS', 'PATHEXT', 'COMSPEC',
  'SYSTEMROOT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'PROGRAMFILES', 'HOMEDRIVE', 'HOMEPATH',
]);
const RESERVED_PREFIXES = ['LEDUNG_', 'CLAUDE_', 'ANTHROPIC_', 'BASH_', 'LD_', 'DYLD_', 'LC_', 'MCP_', 'OTEL_'];

/** Why a name can't be a secret's, or null. */
export function secretNameProblem(name: string): string | null {
  if (!/^[a-z][a-z0-9._-]{0,39}$/.test(name)) return 'A name is 1 to 40 small letters, digits, "-", "_" or ".", starting with a letter.';
  const env = envName(name);
  if (RESERVED.has(env) || RESERVED_PREFIXES.some((p) => env.startsWith(p))) return `$${env} is used by the shell, Claude Code or Ledung; choose another name.`;
  return null;
}

/** The longest value Ledung keeps, and the shortest it blanks in what it shows (shorter ones would blank ordinary words). */
export const MAX_SECRET_LENGTH = 16 * 1024;
export const MIN_BLANKED_LENGTH = 4;

/** How the text Claude reads for a token starts. */
export const SECRET_FOR_CLAUDE_START = '🔑 secret "';

/** What Claude reads in place of the token. */
export const secretForClaude = (name: string): string =>
  `${SECRET_FOR_CLAUDE_START}${name}" (available as $${envName(name)} in your commands; never print it)`;

/** Claude's text for a message: each token of a known name becomes secretForClaude; `used`, the names found. */
export function expandSecrets(text: string, known: ReadonlySet<string>): { text: string; used: string[] } {
  const used: string[] = [];
  const out = text.replace(TOKEN, (whole, name: string) => {
    if (!known.has(name)) return whole;
    if (!used.includes(name)) used.push(name);
    return secretForClaude(name);
  });
  return { text: out, used };
}

/** A "!" command's text: each token of a known name becomes a reference to its variable in that shell. */
export function expandSecretsForShell(command: string, known: ReadonlySet<string>, powershell: boolean): string {
  return command.replace(TOKEN, (whole, name: string) => (known.has(name) ? (powershell ? `$env:${envName(name)}` : `"$${envName(name)}"`) : whole));
}

// Known token shapes name themselves.
const SHAPES: [RegExp, string][] = [
  [/^(?:gh[pousr]_|github_pat_)/, 'github-token'],
  [/^npm_/, 'npm-token'],
  [/^sk-/, 'api-key'],
  [/^AKIA[0-9A-Z]{16}$/, 'aws-key'],
  [/^xox[abposr]-/, 'slack-token'],
  [/^eyJ[\w-]+\.eyJ/, 'jwt'],
  [/^-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private-key'],
];
const KEYWORDS: Record<string, string> = {
  password: 'password', passwd: 'password', pwd: 'password', pw: 'password', pass: 'password', passphrase: 'passphrase', pin: 'pin',
  token: 'token', secret: 'secret', key: 'key', apikey: 'api-key', code: 'code', credential: 'credential', credentials: 'credential',
};
const FILLERS = new Set(['the', 'my', 'a', 'an', 'is', 'your', 'our', 'this', 'that', 'here', 'use', 'with', 'for', 'and', 'to', 'it', 'of', 'new', 'as', 'its', 'are', 'was']);

/**
 * A name for a secret from what it looks like and the words just before it ("the npm token is …" → npm-token),
 * else "secret"; with -2, -3 … when the name is taken.
 */
export function suggestSecretName(before: string, value: string, taken: readonly string[] = []): string {
  let name = SHAPES.find(([re]) => re.test(value.trim()))?.[1];
  if (!name) {
    const words = before.toLowerCase().match(/[a-z0-9]+/g)?.slice(-5) ?? [];
    for (let i = words.length - 1; i >= 0 && !name; i--) {
      const word = KEYWORDS[words[i]!];
      if (!word) continue;
      const prev = words[i - 1];
      name = prev && !FILLERS.has(prev) && /^[a-z][a-z0-9]{0,15}$/.test(prev) && !KEYWORDS[prev] ? `${prev}-${word}` : word;
      if (prev === 'api' && word === 'key') name = 'api-key';
    }
  }
  name ??= 'secret';
  if (secretNameProblem(name)) name = 'secret';
  if (!taken.includes(name)) return name;
  for (let n = 2; ; n++) if (!taken.includes(`${name}-${n}`)) return `${name}-${n}`;
}

/**
 * The runtime files a running session's secrets are in (src/secrets/runtime.ts), named in a tool call's path or
 * command: a session reading one asks the person (sensitive), and the file viewer never shows one.
 */
export const SECRET_FILE_PATTERN = /ledung-secrets-[0-9a-f]{8}|ledung-[0-9a-f]{8}-[0-9a-f-]{27}\.(?:env|secrets)\b/i;
export const SECRET_FILE_RULE = "Ledung's file of locked secrets, always yours to approve";

/**
 * The rule for sessions, with every message that carries a secret (UserPromptSubmit's context): in the tool
 * server's instructions it would take a session's past Claude Code's limit, which raises it for every server (#32).
 */
export const SECRET_RULE = 'A 🔑 secret is only in the environment of your commands: use it as "$NAME", and never print, echo or write out its value.';
