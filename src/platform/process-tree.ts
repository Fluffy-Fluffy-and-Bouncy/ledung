// Find and end a process together with everything it started.
//
// On Windows, processes a session started in the background outlive claude.exe, and once it has
// exited they can no longer be found through it (docs/steps/step-1a-spike.md, finding 2). So the
// tree is recorded first, and later only processes from that record are ended. Each process is
// identified by its id and start time, so a reused id is never killed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Start time as reported by the platform; compared as an opaque string. */
  started: string;
  name: string;
}

/** Every process this user can see. */
export async function listAll(): Promise<ProcessInfo[]> {
  if (process.platform === 'win32') {
    const script =
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CreationDate.ToFileTimeUtc())`t$($_.Name)" }';
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [pid, ppid, started, name] = line.split('\t');
      return { pid: Number(pid), ppid: Number(ppid), started: started ?? '', name: name ?? '' };
    });
  }
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split('\n').filter((l) => l.trim()).map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    return m
      ? { pid: Number(m[1]), ppid: Number(m[2]), started: m[3] ?? '', name: m[4] ?? '' }
      : { pid: -1, ppid: -1, started: '', name: '' };
  }).filter((p) => p.pid > 0);
}

/** The command line of every process this user can see (#117: which release folders are in use). */
export async function commandLines(): Promise<string[]> {
  if (process.platform === 'win32') {
    // Windows PowerShell writes in the console's code page otherwise; a path like C:\Users\Åsa must survive.
    const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }';
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.split(/\r?\n/).filter(Boolean);
  }
  // -ww: whole command lines, however long.
  const { stdout } = await run('ps', ['-A', '-ww', '-o', 'args='], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\n').filter((l) => l.trim());
}

/** A process's command line and, where the platform lets it be read cheaply (Linux), its working folder. */
export interface ProcessCommand {
  pid: number;
  /** As listAll gives it, to tell the same process from a reused id. */
  started: string;
  command: string;
  cwd: string | null;
}

/**
 * The command lines of a few processes, for the person's Pause and Stop on a detached job: a process Ledung took as a
 * session's only by when it started is acted on only if its command is the session's detaching call's (re-review of
 * PR #476). Windows gives no other process's working folder without reading its memory, macOS only through lsof.
 */
export async function commandsOf(pids: number[]): Promise<ProcessCommand[]> {
  const ids = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  if (!ids.length) return [];
  if (process.platform === 'win32') {
    const filter = ids.map((p) => `ProcessId=${p}`).join(' OR ');
    const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId)\`t$($_.CreationDate.ToFileTimeUtc())\`t$($_.CommandLine -replace '[\\r\\n\\t]', ' ')" }`;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [pid, started, ...rest] = line.split('\t');
      return { pid: Number(pid), started: started ?? '', command: rest.join(' '), cwd: null };
    }).filter((p) => ids.includes(p.pid));
  }
  let stdout = '';
  try {
    ({ stdout } = await run('ps', ['-ww', '-o', 'pid=,lstart=,args=', '-p', ids.join(',')], { maxBuffer: 16 * 1024 * 1024 }));
  } catch (e) {
    // ps exits 1 when none of them runs any more.
    stdout = (e as { stdout?: string }).stdout ?? '';
  }
  const fs = await import('node:fs');
  return stdout.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/)).filter((m) => m !== null).map((m) => {
    const pid = Number(m[1]);
    let cwd: string | null = null;
    if (process.platform === 'linux') {
      try {
        cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        // Not ours to read, or gone.
      }
    }
    return { pid, started: m[2] ?? '', command: m[3] ?? '', cwd };
  });
}

/** The process and all its descendants, as they are right now. */
export async function snapshotTree(rootPid: number): Promise<ProcessInfo[]> {
  return treeFrom(await listAll(), rootPid);
}

/** A start time as a number that orders correctly, or null when the platform gave none. */
function startOrder(started: string): bigint | null {
  // Windows: a FILETIME, too big for a Number to keep exact. Elsewhere: ps's lstart date.
  if (/^\d+$/.test(started)) return BigInt(started);
  const ms = Date.parse(started);
  return Number.isNaN(ms) ? null : BigInt(ms);
}

/**
 * The process and all its descendants in a process list. A child counts only if it started no
 * earlier than its parent: Windows keeps a child's parent id after the parent exits, so once that
 * id is reused, the new process would otherwise adopt the old one's children. Session hosts outlive
 * the Ledung that started them, so a test process that got a dead Ledung's id took every host it
 * had started with it (#162).
 */
export function treeFrom(all: ProcessInfo[], rootPid: number): ProcessInfo[] {
  const byParent = new Map<number, ProcessInfo[]>();
  for (const p of all) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const root = all.find((p) => p.pid === rootPid);
  if (!root) return [];
  const out: ProcessInfo[] = [root];
  const walk = (parent: ProcessInfo) => {
    const parentStart = startOrder(parent.started);
    for (const child of byParent.get(parent.pid) ?? []) {
      if (child.pid === parent.pid || out.some((p) => p.pid === child.pid)) continue;
      const childStart = startOrder(child.started);
      // Without both start times there is no telling an orphan from a child; leave it alone.
      if (parentStart === null || childStart === null || childStart < parentStart) continue;
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * Which of the recorded processes are still running (same id and same start time), in `now` if given: a list
 * taken a moment ago saves taking another, which under load can take seconds (#251).
 */
export async function stillRunning(recorded: ProcessInfo[], now?: ProcessInfo[]): Promise<ProcessInfo[]> {
  if (recorded.length === 0) return [];
  const list = now ?? await listAll();
  return recorded.filter((r) => list.some((p) => p.pid === r.pid && p.started === r.started));
}

/** End the recorded processes that are still running (in `now`, as stillRunning). Returns the ones that were ended. */
export async function killRecorded(recorded: ProcessInfo[], now?: ProcessInfo[]): Promise<ProcessInfo[]> {
  const alive = await stillRunning(recorded, now);
  for (const p of alive) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  return alive;
}
