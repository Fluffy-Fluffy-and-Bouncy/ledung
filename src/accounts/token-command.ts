// `ledung account token <name>` (issue #85): puts a long-lived token from `claude setup-token` into Claude Code's own
// sign-in store for an account's folder, the one way a token gets there, since Claude Code has no command for it.
// Martin, 2026-11-02 23:03, Ledung question #518: "A command you run yourself ... Ledung's server and page never
// receive the token." So this runs in the user's own terminal and talks to no Ledung: it only reads the account's
// folder from the database. The token is held here until it is in the store, and is never printed, logged or put on
// a command line.
import path from 'node:path';
import type { Readable } from 'node:stream';
import { configPath, loadConfig, type LedungConfig } from '../config.ts';
import { dropSqliteWarning } from '../platform/node-warnings.ts';
import { userDataDir } from '../platform/paths.ts';
import { chooseClaude } from '../runners/claude-program.ts';
import { checkSignIn, type SignIn } from './signin.ts';
import { localStore, signInRecord } from './signin-store.ts';
import { ACCOUNT_NAME, LOGIN_ENV, SIGN_IN_ENV } from './store.ts';

const USAGE = 'Use: ledung account token <account name>. The token is asked for afterwards, or read from a pipe; it never goes on the command line.';

/** A token as `claude setup-token` gives it, sized so that a half-pasted one or a stray text is refused. */
const TOKEN = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{40,900}$/;

export interface TokenCommandDeps {
  /** The account's sign-in folder on this computer, or the names there are when it has none. */
  findAccount(name: string): Promise<{ folder: string } | { names: string[] }>;
  /** The token as given, or null when the user stopped. */
  readToken(): Promise<string | null>;
  store: { hasSignIn(folder: string): Promise<boolean>; put(folder: string, record: string): Promise<void> };
  /** What Claude Code says about the folder alone; never throws. */
  check(folder: string): Promise<SignIn>;
  print(line: string): void;
}

/** The token without the spaces and line ends a terminal adds when it wraps a long line; null when it isn't one. */
export function cleanToken(given: string): string | null {
  const token = given.replace(/\s+/g, '');
  return TOKEN.test(token) ? token : null;
}

/**
 * One piece of typed or pasted text, applied to what is held so far: Enter at the end of a piece ends it; a line end
 * inside one is a wrapped paste and is dropped. Keys that are not text (arrows and the like) are ignored.
 */
export function applyKeys(held: string, piece: string): { held: string; done: 'enter' | 'stop' | null } {
  let text = held;
  const keys = piece.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '');
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (key === '\x03') return { held: '', done: 'stop' };
    if (key === '\x04') return { held: text, done: 'enter' };
    if (key === '\x7f' || key === '\b') text = text.slice(0, -1);
    else if (key === '\r' || key === '\n') {
      if (i === keys.length - 1) return { held: text, done: 'enter' };
    } else if (key >= ' ') text += key;
  }
  return { held: text, done: null };
}

/** Reads a line from the terminal with nothing shown. In raw mode, so a paste has no line-length limit either. */
export function readHidden(input: Readable & { setRawMode(on: boolean): unknown }): Promise<string | null> {
  return new Promise((resolve) => {
    let held = '';
    const finish = (value: string | null) => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.setRawMode(false);
      input.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      const next = applyKeys(held, String(chunk));
      held = next.held;
      if (next.done) finish(next.done === 'stop' ? null : held);
    };
    const onEnd = () => finish(held);
    input.setRawMode(true);
    input.on('data', onData);
    input.on('end', onEnd);
    input.resume();
  });
}

/** All of a pipe: `pbpaste | ledung account token <name>`. */
async function readPipe(input: Readable): Promise<string> {
  let text = '';
  for await (const chunk of input) text += String(chunk);
  return text;
}

/** The account's folder, from the database as it stands; read-only, so a running Ledung is not disturbed. */
async function findInDatabase(name: string, file: string): Promise<{ folder: string } | { names: string[] }> {
  // Loaded here, not at the top: the `ledung` command would load it on every start, with Node's warning (#428).
  dropSqliteWarning();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT name, config_dir FROM accounts ORDER BY name').all() as { name: string; config_dir: string }[];
    const row = rows.find((r) => r.name === name);
    return row ? { folder: row.config_dir } : { names: rows.map((r) => r.name) };
  } finally {
    db.close();
  }
}

/** The real thing: this computer's store, Ledung's database, this terminal. */
export function realDeps(): TokenCommandDeps {
  const store = localStore();
  return {
    findAccount: async (name) => {
      const file = path.join(userDataDir(), 'ledung.db');
      try {
        return await findInDatabase(name, file);
      } catch {
        return { names: [] };
      }
    },
    readToken: async () => {
      if (!process.stdin.isTTY) return readPipe(process.stdin);
      process.stderr.write('Paste the token from `claude setup-token` and press Enter (nothing is shown): ');
      const token = await readHidden(process.stdin as Readable & { setRawMode(on: boolean): unknown });
      process.stderr.write('\n');
      return token;
    },
    store,
    check: async (folder) => {
      let setting: LedungConfig['claudeExecutable'] = 'installed';
      try {
        setting = loadConfig(configPath()).claudeExecutable;
      } catch {
        // No config, or a broken one: the Claude Code on the PATH is the one to ask.
      }
      const binary = (await chooseClaude(setting)).program?.path ?? null;
      return checkSignIn(folderOnlyEnv(process.env, folder), { binary });
    },
    print: (line) => console.log(line),
  };
}

/** The environment that makes Claude Code answer about the folder alone: no token or key of the terminal's, no LEDUNG_*. */
export function folderOnlyEnv(base: NodeJS.ProcessEnv, folder: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !LOGIN_ENV.includes(k) && !k.startsWith('LEDUNG_')) env[k] = v;
  return { ...env, [SIGN_IN_ENV]: folder };
}

/** `ledung account ...`: returns the exit code. 0: stored and Claude Code sees it; 1: not; 2: wrongly used. */
export async function accountCommand(args: string[], deps: TokenCommandDeps = realDeps()): Promise<number> {
  // Exactly these three words: a token given as a fourth is refused here, and not echoed.
  const [what, name, ...rest] = args;
  if (what !== 'token' || !name || rest.length || !ACCOUNT_NAME.test(name)) {
    deps.print(USAGE);
    return 2;
  }
  const found = await deps.findAccount(name);
  if (!('folder' in found)) {
    deps.print(`There is no account named "${name}" in Ledung. ${found.names.length ? `Its accounts: ${found.names.join(', ')}.` : 'Add it under Settings → Claude & usage → Accounts first.'}`);
    return 1;
  }
  const given = await deps.readToken();
  if (given === null) {
    deps.print('Stopped. Nothing was changed.');
    return 1;
  }
  const token = cleanToken(given);
  if (!token) {
    // What was given is not repeated: it may be some other secret.
    deps.print('That is not a long-lived token: `claude setup-token` prints one starting with sk-ant-oat. Nothing was changed.');
    return 1;
  }
  let replaced: boolean;
  try {
    replaced = await deps.store.hasSignIn(found.folder);
    await deps.store.put(found.folder, signInRecord(token));
  } catch (e) {
    deps.print(`The token could not be stored: ${(e as Error).message}. Nothing was changed.`);
    return 1;
  }
  deps.print(`The token is in Claude Code's sign-in for "${name}"${replaced ? ', in place of the sign-in that was there' : ''}.`);
  const after = await deps.check(found.folder);
  // A key in Claude Code's shared settings says signed in for any folder, so only the token's own answer counts.
  if (after.state === 'in' && after.method === 'claude.ai' && after.kind === 'token') {
    deps.print('Claude Code sees it: signed in with a long-lived token. It reads what is stored without trying it, so the first session is what proves the token.');
    deps.print('Press Check again under Settings → Claude & usage → Accounts to see it in Ledung.');
    return 0;
  }
  if (after.state === 'unknown') deps.print(`Claude Code could not be asked whether it worked: ${after.detail ?? 'no answer'}.`);
  else if (after.state === 'out') deps.print('It did NOT work: Claude Code says this account is not signed in.');
  else deps.print(`It did NOT work: Claude Code answers with something else for this account (${after.method ?? 'an unknown sign-in'}${after.kind === 'login' ? ', a /login' : ''}).`);
  return 1;
}
