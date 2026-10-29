// A `!` command from the message box (issue #212): run once in the session's folder, its output collected
// for the conversation. Ledung runs it, not the session host, which stays small (decision of 2026-10-18).
// Ended with everything it started on its time limit, on Stop and on Restart Ledung.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killRecorded, listAll, treeFrom, type ProcessInfo } from '../platform/process-tree.ts';

/** Like Claude Code's Bash tool: two minutes. */
export const SHELL_TIMEOUT_MS = 2 * 60 * 1000;
/** Per stream; the Bash tool cuts its output at about this much too. */
export const SHELL_MAX_CHARS = 30_000;
/** How often the command's processes are recorded, so one it started and left behind is still found (finding 2). */
const RECORD_EVERY_MS = 2000;

export type ShellKind = 'bash' | 'powershell';

export interface ShellResult {
  stdout: string;
  stderr: string;
  /** null when it was ended (cut) or ended by a signal. */
  exitCode: number | null;
  /** Why it was ended before it finished; null: it finished. */
  cut: 'timeout' | 'stopped' | 'restart' | null;
  /** Output above SHELL_MAX_CHARS was left out. */
  truncated: boolean;
  durationMs: number;
}

export interface ShellRun {
  readonly done: Promise<ShellResult>;
  /** Ends it and everything it started; `done` then resolves with `cut` set. */
  stop(why: 'stopped' | 'restart'): Promise<void>;
}

export interface ShellSpawn {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  /** What else ends it, beyond the processes on this computer (a container's own processes). */
  endInside?: () => Promise<void>;
}

/** Git Bash on Windows, found as Claude Code finds it: CLAUDE_CODE_GIT_BASH_PATH, else next to git on the PATH. */
export function gitBashPath(env: NodeJS.ProcessEnv = process.env, exists: (f: string) => boolean = fs.existsSync): string | null {
  const set = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (set && exists(set)) return set;
  const dirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  for (const dir of dirs) {
    if (!exists(path.join(dir, 'git.exe'))) continue;
    // git.exe is in Git\cmd (the installer's usual PATH entry) or Git\bin; bash.exe is in Git\bin.
    for (const bash of [path.join(dir, '..', 'bin', 'bash.exe'), path.join(dir, 'bash.exe')]) if (exists(bash)) return path.resolve(bash);
  }
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
    const bash = root && path.join(root, 'Git', 'bin', 'bash.exe');
    if (bash && exists(bash)) return bash;
  }
  return null;
}

/** The program and arguments that run `command` on this computer, in the shell decided for it (decision 6 of #212). */
export function localShell(command: string, kind: ShellKind, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[]; name: string } {
  if (platform === 'win32' && kind === 'powershell') {
    // Windows PowerShell writes in the console's code page otherwise (as in process-tree.ts).
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`], name: 'PowerShell' };
  }
  if (platform === 'win32') {
    const bash = gitBashPath(env);
    if (!bash) throw new Error('Git Bash was not found. Install Git for Windows, set CLAUDE_CODE_GIT_BASH_PATH, or set "windowsShell": "powershell" in the config.');
    return { command: bash, args: ['-c', command], name: 'Git Bash' };
  }
  return { command: fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', args: ['-c', command], name: 'bash' };
}

/** A time as listAll gives start times: a FILETIME on Windows, a parseable date elsewhere (process-tree.ts startOrder). */
function startStamp(ms: number, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? String((BigInt(ms) + 11644473600000n) * 10000n) : new Date(ms).toISOString();
}

/** Keeps the first `max` characters of a stream. */
class Capped {
  text = '';
  truncated = false;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  add(chunk: Buffer | string): void {
    if (this.truncated) return;
    this.text += chunk.toString();
    if (this.text.length > this.max) {
      this.text = this.text.slice(0, this.max);
      this.truncated = true;
    }
  }
}

/** Starts the command; see ShellRun. */
export function startShell(spec: ShellSpawn, opts: { timeoutMs?: number; maxChars?: number } = {}): ShellRun {
  const timeoutMs = opts.timeoutMs ?? SHELL_TIMEOUT_MS;
  const started = Date.now();
  const out = new Capped(opts.maxChars ?? SHELL_MAX_CHARS);
  const err = new Capped(opts.maxChars ?? SHELL_MAX_CHARS);
  let cut: ShellResult['cut'] = null;
  /** Set once it has exited (null: by a signal or an error); undefined while it runs. */
  let exitCode: number | null | undefined;
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    // Its own process group elsewhere, so the group can be ended at once.
    detached: process.platform !== 'win32',
  });
  // Every process it started, recorded as it runs: on Windows one left behind can't be found through it once
  // it has exited (docs/steps/step-1a-spike.md, finding 2). Kept by id and start time, so a reused id is safe.
  const recorded = new Map<string, ProcessInfo>();
  let root: ProcessInfo | null = null;
  // Should it exit before the first snapshot: a stand-in that started just before it, so only processes started
  // after it count as its own.
  const standIn = (pid: number): ProcessInfo => ({ pid, ppid: process.pid, name: '', started: startStamp(started - 1000) });
  /** Adds what runs now to the record; returns the process list it used, or null when it got none. */
  const record = async (): Promise<ProcessInfo[] | null> => {
    if (!child.pid) return null;
    try {
      const all = await listAll();
      root ??= all.find((p) => p.pid === child.pid) ?? null;
      const r = root ?? standIn(child.pid);
      // The root stays in the list after it has exited, so what it left behind is still found by its parent id.
      const alive = all.some((p) => p.pid === r.pid && p.started === r.started);
      for (const p of treeFrom(alive ? all : [...all.filter((p) => p.pid !== r.pid), r], r.pid)) recorded.set(`${p.pid}:${p.started}`, p);
      return all;
    } catch {
      // A missed snapshot only makes the record less complete.
      return null;
    }
  };
  void record();
  const recorder = setInterval(() => void record(), RECORD_EVERY_MS);
  child.stdout?.on('data', (c) => out.add(c));
  child.stderr?.on('data', (c) => err.add(c));

  let ending: Promise<void> | null = null;
  const end = (why: NonNullable<ShellResult['cut']> | null): Promise<void> => {
    if (why && !cut && exitCode === undefined) cut = why;
    ending ??= (async () => {
      clearInterval(recorder);
      // Its list also tells what still runs, so ending takes one list, not two (#251).
      const now = await record();
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }
      child.kill('SIGKILL');
      await killRecorded([...recorded.values()], now ?? undefined).catch(() => []);
      await spec.endInside?.().catch(() => {});
    })();
    return ending;
  };

  const timer = setTimeout(() => void end('timeout'), timeoutMs);
  const done = new Promise<ShellResult>((resolve) => {
    let resolved = false;
    const finish = async () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // Whatever it left behind goes too: nothing could stop it later (issue #212, Done looks like).
      await end(null);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ stdout: out.text, stderr: err.text, exitCode: cut ? null : exitCode ?? null, cut, truncated: out.truncated || err.truncated, durationMs: Date.now() - started });
    };
    child.on('error', (e) => {
      err.add(`${e.message}\n`);
      exitCode = null;
      void finish();
    });
    // 'close' waits for the output; a process it left behind holding the output open is not waited for long.
    child.on('close', () => void finish());
    child.on('exit', (code) => {
      exitCode = code;
      setTimeout(() => void finish(), 1000);
    });
  });
  return {
    done,
    stop: async (why) => {
      await end(why);
      await done;
    },
  };
}

