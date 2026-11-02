// How a session's locked secrets (issue #468) reach its commands while it runs (the manager's a on question
// #1565, 2026-11-02). Claude Code sources the file CLAUDE_ENV_FILE names before every Bash command, but reads
// its text once per session (Claude Code 2.1.301), so that file is fixed at launch and only sources a second
// one, which Ledung rewrites whenever the session's secrets change: a secret added mid-session reaches the
// next command, and the session host stays as it is. The second file holds the values in plain text, owner
// only, while the session runs; it goes when the session's Claude Code ends, and on Ledung's start for any
// session no longer running.
//
// A local session's files are in a private folder in this user's temp folder (not the data folder, which a
// sandboxed shell may not read, #104); a container session's are in the container's /tmp, written through
// `docker exec -i` with the values on stdin, never on a command line.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWithInput } from '../runners/runner.ts';

/** A secret as it goes into a command's environment. */
export interface SecretValue {
  env: string;
  value: string;
}

export interface SecretRuntime {
  /** CLAUDE_ENV_FILE as Claude Code sees it where it runs. */
  readonly envFile: string;
  /** The fixed text of the env file: unsets what launch put in the environment, then sources the current values. */
  envScript(launchNames: readonly string[]): string;
  /** Writes the env file before launch where Ledung can (local); a container's is written by the launch itself. */
  prepare(script: string): void;
  /** Rewrites the values file; none left, it goes. */
  write(values: readonly SecretValue[]): Promise<void>;
  /** Removes both files. Never throws. */
  clear(): Promise<void>;
}

/** Single quotes for a POSIX shell. */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The values file: one export per secret. */
export function exportLines(values: readonly SecretValue[]): string {
  return values.map((v) => `export ${v.env}=${shQuote(v.value)}\n`).join('');
}

function envScriptFor(valuesFile: string, launchNames: readonly string[], chained: string | null): string {
  return [
    '# Ledung: this session\'s locked secrets (issue #468). Never print them.',
    ...(chained ? [`if [ -f ${shQuote(chained)} ]; then . ${shQuote(chained)}; fi`] : []),
    ...(launchNames.length ? [`unset ${launchNames.join(' ')} 2>/dev/null`] : []),
    `if [ -f ${shQuote(valuesFile)} ]; then . ${shQuote(valuesFile)}; fi`,
    '',
  ].join('\n');
}

/** The file names of a session's two files; only the characters a session id has. */
const base = (sessionId: string) => `ledung-${sessionId.replace(/[^A-Za-z0-9-]/g, '')}`;

/**
 * This Ledung's private folder for local sessions' files: in the user's temp folder, named per data folder so
 * a test copy has its own. Made owner-only; one that exists but isn't a private folder of this user's is refused.
 */
export function localSecretsDir(dataDir: string): string {
  const tag = crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), `ledung-secrets-${tag}`);
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a folder.`);
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user.`);
    if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
  }
}

function writePrivate(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch {
    // Windows refuses to replace a file a shell has open just then; written in place instead.
    fs.rmSync(temp, { force: true });
    fs.writeFileSync(file, text, { mode: 0o600 });
  }
}

/** A path as Git Bash on Windows reads it, C:/Users/…; unchanged elsewhere. */
const shellPath = (p: string) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);

export class LocalSecretRuntime implements SecretRuntime {
  envFile: string;
  private valuesFile: string;
  private dir: string;
  private readonly sessionId: string;
  /** A CLAUDE_ENV_FILE Ledung itself was started with, still sourced first. */
  private readonly chained: string | null;

  constructor(dir: string, sessionId: string, chained: string | null = process.env.CLAUDE_ENV_FILE ?? null) {
    this.sessionId = sessionId;
    this.dir = dir;
    this.envFile = path.join(dir, `${base(sessionId)}.env`);
    this.valuesFile = path.join(dir, `${base(sessionId)}.secrets`);
    this.chained = chained && path.resolve(chained) !== path.resolve(this.envFile) ? chained : null;
  }

  /** The folder its files are in. */
  get folder(): string {
    return this.dir;
  }

  /** Into a level B session's own temp folder: the one place its sandboxed shell may read (#109). */
  moveTo(dir: string): void {
    this.dir = dir;
    this.envFile = path.join(dir, `${base(this.sessionId)}.env`);
    this.valuesFile = path.join(dir, `${base(this.sessionId)}.secrets`);
  }

  envScript(launchNames: readonly string[]): string {
    return envScriptFor(shellPath(this.valuesFile), launchNames, this.chained && shellPath(this.chained));
  }

  prepare(script: string): void {
    ensurePrivateDir(this.dir);
    writePrivate(this.envFile, script);
  }

  async write(values: readonly SecretValue[]): Promise<void> {
    if (!values.length) {
      fs.rmSync(this.valuesFile, { force: true });
      return;
    }
    ensurePrivateDir(this.dir);
    writePrivate(this.valuesFile, exportLines(values));
  }

  async clear(): Promise<void> {
    for (const f of [this.valuesFile, this.envFile]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // Gone with the temp folder, or held open a moment; Ledung's next start removes it.
      }
    }
  }
}

/** How Ledung reaches a container: `docker exec -i` with stdin, as a project's user. */
export interface ContainerTarget {
  container: string;
  user?: string;
}

export class DockerSecretRuntime implements SecretRuntime {
  readonly envFile: string;
  private readonly valuesFile: string;
  readonly target: ContainerTarget;
  private readonly exec: (args: string[], input: string | null) => Promise<unknown>;

  constructor(target: ContainerTarget, sessionId: string, exec?: (args: string[], input: string | null) => Promise<unknown>) {
    this.target = target;
    this.envFile = `/tmp/${base(sessionId)}.env`;
    this.valuesFile = `/tmp/${base(sessionId)}.secrets`;
    this.exec = exec ?? ((args, input) => runWithInput('docker', args, input, 20_000));
  }

  private sh(script: string, input: string | null): Promise<unknown> {
    const user = this.target.user ? ['-u', this.target.user] : [];
    return this.exec(['exec', '-i', ...user, this.target.container, 'sh', '-c', script], input);
  }

  envScript(launchNames: readonly string[]): string {
    return envScriptFor(this.valuesFile, launchNames, null);
  }

  /** The launch writes it (DockerRunner.launchSpec), since only the container has it. */
  prepare(): void {}

  async write(values: readonly SecretValue[]): Promise<void> {
    if (!values.length) {
      await this.sh(`rm -f ${shQuote(this.valuesFile)}`, null);
      return;
    }
    // A new file renamed into place: /tmp is shared, so nothing another user put there is written through.
    await this.sh(`umask 077; t=$(mktemp /tmp/ledung-XXXXXX) && cat > "$t" && mv -f "$t" ${shQuote(this.valuesFile)}`, exportLines(values));
  }

  async clear(): Promise<void> {
    await this.sh(`rm -f ${shQuote(this.valuesFile)} ${shQuote(this.envFile)}`, null).catch(() => {});
  }
}

/** The part of a container's launch script that writes the env file, private to the container user, and names it. */
export function containerEnvFilePart(envFile: string, script: string): string {
  return `(umask 077; printf '%s' ${shQuote(script)} > ${shQuote(envFile)}); CLAUDE_ENV_FILE=${shQuote(envFile)}; export CLAUDE_ENV_FILE; `;
}

/** The session ids of the files in a local folder of them, for the clean-up at Ledung's start. */
export function localRuntimeSessions(dir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const m = /^ledung-([A-Za-z0-9-]+)\.(?:env|secrets)(?:\.\d+\.tmp)?$/.exec(name);
    if (!m) continue;
    const files = out.get(m[1]!) ?? [];
    files.push(path.join(dir, name));
    out.set(m[1]!, files);
  }
  return out;
}

/** The files in a container's /tmp of sessions that aren't running: listed and removed in one call. */
export async function cleanContainer(target: ContainerTarget, live: ReadonlySet<string>, exec?: (args: string[], input: string | null) => Promise<{ stdout: string }>): Promise<number> {
  const run = exec ?? ((args, input) => runWithInput('docker', args, input, 20_000));
  const user = target.user ? ['-u', target.user] : [];
  const { stdout } = await run(['exec', '-i', ...user, target.container, 'sh', '-c', 'for f in /tmp/ledung-*.env /tmp/ledung-*.secrets; do [ -f "$f" ] && echo "$f"; done; true'], null);
  const stale = stdout.split('\n').map((l) => l.trim()).filter((f) => {
    const m = /^\/tmp\/ledung-([A-Za-z0-9-]+)\.(?:env|secrets)$/.exec(f);
    return m && !live.has(m[1]!);
  });
  if (stale.length) await run(['exec', '-i', ...user, target.container, 'sh', '-c', `rm -f ${stale.map(shQuote).join(' ')}`], null);
  return stale.length;
}
