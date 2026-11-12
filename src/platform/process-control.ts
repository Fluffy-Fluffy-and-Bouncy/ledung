// What resource limits may do to a job's processes (docs/steps/resource-limits.md): lower and restore their OS
// priority on their own, and, only on the person's click on a job's card, suspend, resume or end them. Never kill or
// suspend automatically (point 6). Every pid comes from Ledung's own process list, as a job's process under one of its
// sessions; it is checked to be a positive whole number before it goes anywhere, and acted on only while it is still
// the same process (its start time, security review of the resource limits, finding 1).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Never Ledung itself, its launcher, or the system's first processes. */
const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 4 && pid !== process.pid && pid !== process.ppid;

/** "Below normal" on Windows; nice 10 on macOS and Linux (open choice 7). */
export const LOWERED = os.constants.priority.PRIORITY_BELOW_NORMAL;

export interface PriorityControl {
  /** The process's priority now; null: gone or not readable. */
  get(pid: number): number | null;
  /** True when it took. */
  set(pid: number, priority: number): boolean;
}

/** Linux keeps a nice value per thread: a process's existing threads keep theirs unless each is set (finding 10). */
function threadsOf(pid: number): number[] {
  if (process.platform !== 'linux') return [];
  try {
    return fs.readdirSync(`/proc/${pid}/task`).map(Number).filter((t) => Number.isSafeInteger(t) && t > 0 && t !== pid);
  } catch {
    return [];
  }
}

export const osPriority: PriorityControl = {
  get(pid) {
    if (!validPid(pid)) return null;
    try {
      return os.getPriority(pid);
    } catch {
      return null;
    }
  },
  set(pid, priority) {
    if (!validPid(pid)) return false;
    try {
      os.setPriority(pid, priority);
    } catch {
      // Gone, or (macOS and Linux) raising it back needs rights an ordinary user doesn't have.
      return false;
    }
    for (const tid of threadsOf(pid)) {
      try {
        os.setPriority(tid, priority);
      } catch {
        // A thread that ended meanwhile.
      }
    }
    return true;
  },
};

/**
 * Lowers a process's priority if it isn't already that low. Returns the priority it had (to put back later), or null
 * when nothing was changed. On every OS a higher number is a lower priority.
 */
export function lower(pid: number, control: PriorityControl = osPriority): number | null {
  const was = control.get(pid);
  if (was === null || was >= LOWERED) return null;
  return control.set(pid, LOWERED) ? was : null;
}

/**
 * Puts back a priority Ledung lowered, only if the process is still at the priority Ledung gave it: one changed since
 * (by the person, or by the process) is left alone. The caller has checked it is still the same process.
 */
export function restore(pid: number, was: number, control: PriorityControl = osPriority): 'restored' | 'left' | 'refused' {
  const now = control.get(pid);
  if (now === null || now !== LOWERED) return 'left';
  return control.set(pid, was) ? 'restored' : 'refused';
}

/** A process to act on, with the start time Ledung's list gave it (Windows, Unix milliseconds); null: none known. */
export interface Target {
  pid: number;
  started: number | null;
}

/** Windows FILETIME of a Unix-millisecond start, as the process list's CreationDate gave it. */
const fileTime = (ms: number) => (BigInt(Math.round(ms)) + 11644473600000n) * 10000n;

// Windows has no signal for suspending a process: ntdll's NtSuspendProcess and NtResumeProcess, as Process Explorer
// uses. Each process is opened once, its creation time compared with the one Ledung recorded, and acted on through
// that same handle, so a pid reused meanwhile is never touched. Prints one line per process: its pid and "ok" or why not.
const WINDOWS_ACT = (targets: { pid: number; ft: bigint }[], action: 'suspend' | 'resume' | 'end') => `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class LedungAct {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr h);
  public static string Act(int pid, long created, string action) {
    IntPtr h = OpenProcess(0x0800 | 0x0001 | 0x1000, false, pid);
    if (h == IntPtr.Zero) return "gone";
    try {
      long c, e, k, u;
      if (!GetProcessTimes(h, out c, out e, out k, out u)) return "unreadable";
      // The list's start time is rounded to milliseconds: within 1 ms (10000 units) is the same process.
      if (created > 0 && Math.Abs(c - created) > 10000) return "another process";
      if (action == "suspend") return NtSuspendProcess(h) == 0 ? "ok" : "refused";
      if (action == "resume") return NtResumeProcess(h) == 0 ? "ok" : "refused";
      return TerminateProcess(h, 1) ? "ok" : "refused";
    } finally { CloseHandle(h); }
  }
}
'@
${targets.map((t) => `[Console]::Out.WriteLine("${t.pid} " + [LedungAct]::Act(${t.pid}, ${t.ft}, '${action}'))`).join('\n')}
`;

/** At most this many processes per click: a job's tree, not a whole PC; keeps the script within Windows' command line. */
const MAX_TARGETS = 300;

/**
 * Suspends, resumes or ends the processes; the person's click only. Returns how many it acted on. On Windows each is
 * checked by its start time on the handle it is acted through; elsewhere the caller has just checked them against a
 * fresh process list (a few milliseconds before the signal).
 */
export async function actOn(targets: Target[], action: 'suspend' | 'resume' | 'end'): Promise<{ done: number; skipped: number }> {
  const valid = targets.filter((t) => validPid(t.pid)).slice(0, MAX_TARGETS);
  if (!valid.length) return { done: 0, skipped: targets.length };
  if (process.platform === 'win32') {
    const script = WINDOWS_ACT(valid.map((t) => ({ pid: t.pid, ft: t.started === null ? 0n : fileTime(t.started) })), action);
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 60000 });
    const done = stdout.split(/\r?\n/).filter((l) => / ok$/.test(l.trim())).length;
    return { done, skipped: targets.length - done };
  }
  let done = 0;
  for (const t of valid) {
    try {
      if (action === 'end') {
        // A suspended one is resumed first so it can end.
        process.kill(t.pid, 'SIGCONT');
        process.kill(t.pid, 'SIGTERM');
      } else process.kill(t.pid, action === 'suspend' ? 'SIGSTOP' : 'SIGCONT');
      done++;
    } catch {
      // Gone.
    }
  }
  return { done, skipped: targets.length - done };
}
