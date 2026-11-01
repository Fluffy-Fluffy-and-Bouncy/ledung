// Ledung in the background (issue #456): `ledung` starts it with no window and returns, so no terminal has to stay open
// (Martin, 2026-11-01 21:41, Ledung question #1149, option a). The start runs `ledung --foreground` detached, its
// output into the log file in the data folder; `ledung stop` asks the running Ledung to stop, as Stop Ledung in the
// page does. Used by the npm command (src/cli.ts); the release launcher and Martin's own start are unchanged.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COOKIE_NAME } from '../server/security.ts';
import { exercisedLine } from './exercised.ts';
import { userDataDir } from './paths.ts';
import { answersSignIn, configuredPort, NOT_RUNNING_CODE, savedToken } from './running.ts';

/** The log file a background Ledung writes to, in the data folder. */
export const LOG_FILE = 'ledung.log';
/** Past this size a start moves the log to ledung.old.log and begins a new one, so it never grows without end. */
const MAX_LOG_BYTES = 10 * 1024 * 1024;
/** How long `ledung` waits for the page before it leaves Ledung starting on its own (a first start may migrate). */
const READY_MS = 60_000;
/** How long `ledung stop` waits for Ledung to be gone: stopping its sessions takes a moment. */
const STOPPED_MS = 60_000;

export function logFile(dataDir = userDataDir()): string {
  return path.join(dataDir, LOG_FILE);
}

/** Moves a log past MAX_LOG_BYTES aside, keeping one older copy. */
export function rotateLog(file: string, maxBytes = MAX_LOG_BYTES): void {
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size <= maxBytes) return;
  const old = path.join(path.dirname(file), 'ledung.old.log');
  fs.rmSync(old, { force: true });
  fs.renameSync(file, old);
}

/** The end of the log, for a start that failed: what Ledung said before it stopped. */
export function logTail(file: string, lines = 20): string {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface BackgroundStart {
  /** Node's arguments for the foreground command: the cli itself with --foreground and the passed-on flags. */
  args: string[];
  configFile: string;
  dataDir?: string;
  /** Default: console.log. */
  print?: (line: string) => void;
  readyMs?: number;
}

/**
 * Starts the foreground command detached, with no window, its output appended to the log, and returns once Ledung
 * answers (0), once it gave up (its exit code, with the end of the log), or after readyMs still starting (0).
 */
export async function startInBackground(opts: BackgroundStart): Promise<number> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const dataDir = opts.dataDir ?? userDataDir();
  const file = logFile(dataDir);
  rotateLog(file);
  // Only this user may read it, as the sign-in token's own file (src/server/security.ts): Ledung prints its sign-in
  // link there (Mac check of PR #11, note 3). A log another start made is narrowed too.
  const out = fs.openSync(file, 'a', 0o600);
  if (process.platform !== 'win32') fs.fchmodSync(out, 0o600);
  fs.writeSync(out, `\n--- ${new Date().toISOString()} Ledung starting in the background\n`);
  const child = spawn(process.execPath, opts.args, {
    // Its own process group and session, and no console on Windows: closing the terminal or Ctrl+C there leaves it be.
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    // Shown in Settings next to the log's path: this Ledung's output goes there.
    env: { ...process.env, LEDUNG_LOG_FILE: file },
  });
  fs.closeSync(out);
  let exited: number | null = null;
  child.on('exit', (code) => { exited = code ?? 1; });
  child.on('error', (e) => {
    print(e.message);
    exited = 1;
  });
  child.unref();

  const deadline = Date.now() + (opts.readyMs ?? READY_MS);
  while (Date.now() < deadline) {
    await sleep(500);
    if (exited !== null) {
      print(`Ledung stopped while starting (exit code ${exited}). The end of its log, ${file}:`);
      print(logTail(file));
      return exited || 1;
    }
    const port = configuredPort(opts.configFile);
    const token = savedToken(dataDir);
    if (port !== null && token !== null && (await answersSignIn(port, token, 2000))) {
      exercisedLine('EXERCISED #456 Ledung started in the background');
      print(`Ledung is running in the background at http://127.0.0.1:${port}`);
      print(`Log:  ${file}`);
      print('Stop it with "ledung stop", or Stop Ledung in Settings → Update & restart.');
      return 0;
    }
  }
  print(`Ledung is still starting in the background; it opens its page when it is ready. Log: ${file}`);
  return 0;
}

export interface StopOptions {
  configFile: string;
  dataDir?: string;
  print?: (line: string) => void;
  stoppedMs?: number;
}

/**
 * `ledung stop`: asks this data folder's Ledung to stop, as Stop Ledung in the page does, and waits until it is gone.
 * The token goes only to a Ledung that has proved it holds it (src/platform/running.ts). Exits NOT_RUNNING_CODE when
 * none runs.
 */
export async function stopRunning(opts: StopOptions): Promise<number> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const port = configuredPort(opts.configFile);
  const token = savedToken(opts.dataDir);
  if (port === null || token === null || !(await answersSignIn(port, token))) {
    print('Ledung is not running.');
    return NOT_RUNNING_CODE;
  }
  const origin = `http://127.0.0.1:${port}`;
  const res = await fetch(`${origin}/api/stop`, { method: 'POST', headers: { Cookie: `${COOKIE_NAME}=${token}`, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) {
    const error = ((await res.json().catch(() => ({}))) as { error?: string }).error;
    print(`Ledung refused to stop: ${error ?? res.statusText}`);
    return 1;
  }
  print('Stopping Ledung and its sessions...');
  const deadline = Date.now() + (opts.stoppedMs ?? STOPPED_MS);
  while (Date.now() < deadline) {
    await sleep(500);
    if (!(await answersSignIn(port, token, 2000))) {
      print('Ledung stopped.');
      return 0;
    }
  }
  print('Ledung has not stopped yet; it is still stopping its sessions.');
  return 1;
}
