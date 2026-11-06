// Reads every process's CPU time and memory, every few seconds, with one measuring process for the
// whole machine (step 6). Per platform, as the brief's cross-platform rules ask:
// - Windows: one long-running PowerShell that prints the process list in a loop (starting a new
//   PowerShell every few seconds would itself cost CPU). It ends by itself when Ledung does.
// - macOS and Linux: `ps` every few seconds, which is cheap.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Total CPU time used so far, in seconds. */
  cpuSeconds: number;
  memBytes: number;
  /** Process group, from ps (macOS, Linux); Windows has none. */
  pgid?: number;
}

export type ProcessList = Map<number, ProcInfo>;

const run = promisify(execFile);

/** "[[dd-]hh:]mm:ss[.ff]" from ps, in seconds. */
export function parsePsTime(t: string): number {
  const [days, rest] = t.includes('-') ? [Number(t.split('-')[0]), t.split('-')[1]!] : [0, t];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return days * 86400 + parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
}

export function parsePs(stdout: string): ProcessList {
  const list: ProcessList = new Map();
  for (const line of stdout.split('\n')) {
    // The process group is the last column, when asked for (#169).
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)(?:\s+(\d+))?$/);
    if (!m) continue;
    const p: ProcInfo = { pid: Number(m[1]), ppid: Number(m[2]), cpuSeconds: parsePsTime(m[3]!), memBytes: Number(m[4]) * 1024 };
    if (m[5] !== undefined) p.pgid = Number(m[5]);
    list.set(p.pid, p);
  }
  return list;
}

/** Lines "pid,ppid,cpu100ns,workingSet" from the PowerShell loop. */
export function parseWindowsLines(lines: string[]): ProcessList {
  const list: ProcessList = new Map();
  for (const line of lines) {
    const [pid, ppid, cpu, mem] = line.split(',').map(Number);
    if (!pid || Number.isNaN(cpu)) continue;
    list.set(pid, { pid, ppid: ppid ?? 0, cpuSeconds: (cpu ?? 0) / 1e7, memBytes: mem ?? 0 });
  }
  return list;
}

const WINDOWS_LOOP = (intervalSec: number, ledungPid: number) => `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  if (-not (Get-Process -Id ${ledungPid})) { exit }
  $p = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize
  # The time the list was read, in Unix milliseconds: Node may handle two batches back to back (#157).
  [Console]::Out.WriteLine("#BEGIN $([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())")
  foreach ($x in $p) { [Console]::Out.WriteLine("$($x.ProcessId),$($x.ParentProcessId),$([long]$x.KernelModeTime + [long]$x.UserModeTime),$($x.WorkingSetSize)") }
  [Console]::Out.WriteLine('#END')
  [Console]::Out.Flush()
  Start-Sleep -Seconds ${intervalSec}
}`;

/**
 * Turns the PowerShell loop's lines into one process list per batch, each with the time PowerShell
 * read it (its `#BEGIN <ms>` line). Not the time Node gets to the batch: when Ledung's event loop is
 * busy, two batches arrive back to back, and a CPU delta over a whole interval divided by a gap of a
 * few milliseconds read as 26 cores on a 12-thread machine (#157). A `#BEGIN` without a time (an
 * older loop) falls back to the time of handling.
 */
export function windowsBatchReader(onList: (list: ProcessList, at: number) => void, now: () => number = Date.now): (line: string) => void {
  let lines: string[] | null = null;
  let at = 0;
  return (line) => {
    if (line.startsWith('#BEGIN')) {
      lines = [];
      const read = Number(line.slice('#BEGIN'.length).trim());
      at = read > 0 ? read : now();
    } else if (line === '#END' && lines) {
      onList(parseWindowsLines(lines), at);
      lines = null;
    } else lines?.push(line);
  };
}

export class ProcessSampler {
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly intervalSec: number;
  private readonly onList: (list: ProcessList, at: number) => void;

  constructor(intervalSec: number, onList: (list: ProcessList, at: number) => void) {
    this.intervalSec = intervalSec;
    this.onList = onList;
  }

  start(): void {
    if (process.platform === 'win32') this.startWindows();
    else this.startPosix();
  }

  private startWindows(): void {
    this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_LOOP(this.intervalSec, process.pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    readline.createInterface({ input: this.child.stdout! }).on('line', windowsBatchReader(this.onList));
    // If the measuring process dies, measuring stops; Ledung itself is unaffected (a broken helper
    // degrades to nothing, never to a dead Ledung — brief section 6). Try again once a minute.
    this.child.on('exit', () => {
      this.child = null;
      if (!this.stopped) this.timer = setTimeout(() => this.startWindows(), 60000);
    });
  }

  private startPosix(): void {
    const tick = async () => {
      try {
        // Timed as ps starts, not when its output is handled: a busy event loop delays the second (#157).
        const at = Date.now();
        const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,time=,rss=,pgid='], { maxBuffer: 16 * 1024 * 1024 });
        this.onList(parsePs(stdout), at);
      } catch {
        // Skip this round.
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.intervalSec * 1000);
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.child?.kill();
  }
}

/** The process and all its descendants. */
export function treeOf(list: ProcessList, root: number): ProcInfo[] {
  const children = new Map<number, ProcInfo[]>();
  for (const p of list.values()) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const out: ProcInfo[] = [];
  const seen = new Set<number>();
  const walk = (pid: number) => {
    const p = list.get(pid);
    if (!p || seen.has(pid)) return;
    seen.add(pid);
    out.push(p);
    for (const c of children.get(pid) ?? []) if (c.pid !== pid) walk(c.pid);
  };
  walk(root);
  return out;
}

/** The processes a session's tree held at the last sample, kept to go on counting those that left it (#169). */
export type TreeMemory = Map<number, ProcInfo>;

/** The same process as the one seen last time: its CPU time never shrinks, and its parent is unchanged or gone. */
function sameProcess(was: ProcInfo, now: ProcInfo, list: ProcessList): boolean {
  return now.cpuSeconds >= was.cpuSeconds && (now.ppid === was.ppid || !list.has(was.ppid));
}

/**
 * A session's processes: the tree under its root, plus everything that belonged to the session at
 * the last sample and has since left that tree (#169). A command started in the background can lose
 * its line to the root when a process between them exits: on macOS and Linux it moves to pid 1, on
 * Windows its parent id names a process that is gone. Its CPU then counted for the machine but not
 * for the session, which read "idle, 0.0 cores". So a session also keeps:
 * - every process it held last time that is still the same process (`sameProcess`), with its tree;
 * - on Windows, the children of a process it held that has since exited (their parent id still names it);
 * - on macOS and Linux, every process in a process group one of its processes led: a background
 *   command stays in its shell's group after the shell exits, even one that lived between two samples.
 * Without a root or a memory, it is the plain tree.
 */
export function sessionTree(list: ProcessList, root: number | undefined, memory: TreeMemory | null): { tree: ProcInfo[]; memory: TreeMemory } {
  const seeds: number[] = [];
  if (root && list.has(root)) seeds.push(root);
  if (memory) {
    const gone = new Set<number>();
    const groups = new Set<number>();
    for (const was of memory.values()) {
      const now = list.get(was.pid);
      if (now && sameProcess(was, now, list)) seeds.push(was.pid);
      else if (!now) gone.add(was.pid);
      // Only a group the session's own process leads: a host in Ledung's group must not take in Ledung.
      if (was.pgid !== undefined && was.pgid === was.pid && was.pgid > 1) groups.add(was.pgid);
    }
    for (const p of list.values()) {
      if (gone.has(p.ppid) || (p.pgid !== undefined && groups.has(p.pgid))) seeds.push(p.pid);
    }
  }
  const out: TreeMemory = new Map();
  for (const seed of seeds) {
    if (out.has(seed)) continue;
    for (const p of treeOf(list, seed)) out.set(p.pid, p);
  }
  return { tree: [...out.values()], memory: out };
}
