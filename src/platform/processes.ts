// Reads every process's CPU time and memory, every few seconds, with one measuring process for the
// whole machine (step 6). Per platform, as the brief's cross-platform rules ask:
// - Windows: one long-running PowerShell that prints the process list in a loop (starting a new
//   PowerShell every few seconds would itself cost CPU). It ends by itself when Ledung does.
// - macOS and Linux: `ps` every few seconds, which is cheap.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { parseWindowsGpu, WINDOWS_GPU_READ, WINDOWS_GPU_SETUP, type GpuRaw } from './gpu.ts';

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Total CPU time used so far, in seconds. */
  cpuSeconds: number;
  memBytes: number;
  /** Process group, from ps (macOS, Linux); Windows has none. */
  pgid?: number;
  /** Start time in Unix milliseconds, from Windows; ps gives none here (#169). */
  started?: number;
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

/** Windows FILETIME (100 ns since 1601) to Unix milliseconds; exact, since a FILETIME is beyond a Number. */
export function fileTimeToMs(fileTime: string): number | undefined {
  if (!/^\d+$/.test(fileTime) || fileTime === '0') return undefined;
  return Number(BigInt(fileTime) / 10000n - 11644473600000n);
}

/** Lines "pid,ppid,cpu100ns,workingSet[,creationFileTime]" from the PowerShell loop. */
export function parseWindowsLines(lines: string[]): ProcessList {
  const list: ProcessList = new Map();
  for (const line of lines) {
    const fields = line.split(',');
    const [pid, ppid, cpu, mem] = fields.slice(0, 4).map(Number);
    if (!pid || Number.isNaN(cpu)) continue;
    const p: ProcInfo = { pid, ppid: ppid ?? 0, cpuSeconds: (cpu ?? 0) / 1e7, memBytes: mem ?? 0 };
    const started = fields[4] === undefined ? undefined : fileTimeToMs(fields[4].trim());
    if (started !== undefined) p.started = started;
    list.set(pid, p);
  }
  return list;
}

const WINDOWS_LOOP = (intervalSec: number, ledungPid: number) => `
$ErrorActionPreference = 'SilentlyContinue'
${WINDOWS_GPU_SETUP}
while ($true) {
  if (-not (Get-Process -Id ${ledungPid})) { exit }
  $p = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize,CreationDate
  # The time the list was read, in Unix milliseconds: Node may handle two batches back to back (#157).
  [Console]::Out.WriteLine("#BEGIN $([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())")
  # The start time tells a reused process id from the process that had it (#169, as #162); 0 when Windows gives none.
  foreach ($x in $p) {
    $c = 0; if ($x.CreationDate) { $c = $x.CreationDate.ToFileTimeUtc() }
    [Console]::Out.WriteLine("$($x.ProcessId),$($x.ParentProcessId),$([long]$x.KernelModeTime + [long]$x.UserModeTime),$($x.WorkingSetSize),$c")
  }
  # The GPU's counters in the same batch (resource limits): "G ..." lines, read by gpu.ts.
  [Console]::Out.WriteLine("G T,$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())")
${WINDOWS_GPU_READ}
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
export function windowsBatchReader(onList: (list: ProcessList, at: number, gpu?: { raw: GpuRaw; at: number }) => void, now: () => number = Date.now): (line: string) => void {
  let lines: string[] | null = null;
  let gpuLines: string[] = [];
  let gpuAt = 0;
  let at = 0;
  return (line) => {
    if (line.startsWith('#BEGIN')) {
      lines = [];
      gpuLines = [];
      gpuAt = 0;
      const read = Number(line.slice('#BEGIN'.length).trim());
      at = read > 0 ? read : now();
    } else if (line === '#END' && lines) {
      // The GPU's lines (resource limits), timed by their own "G T" line: they are read after the process list.
      onList(parseWindowsLines(lines), at, gpuAt > 0 ? { raw: parseWindowsGpu(gpuLines), at: gpuAt } : undefined);
      lines = null;
    } else if (lines && line.startsWith('G T,')) gpuAt = Number(line.slice(4)) || at;
    else if (lines && line.startsWith('G ')) gpuLines.push(line);
    else lines?.push(line);
  };
}

export class ProcessSampler {
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly intervalSec: number;
  private readonly onList: (list: ProcessList, at: number, gpu?: { raw: GpuRaw; at: number }) => void;

  constructor(intervalSec: number, onList: (list: ProcessList, at: number, gpu?: { raw: GpuRaw; at: number }) => void) {
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
    // A watchdog: a loop that stops sending batches (a stuck counter read) is ended, and so started again below
    // (security review of the resource limits, finding 6).
    let lastBatch = Date.now();
    const child = this.child;
    const watchdog = setInterval(() => {
      if (Date.now() - lastBatch > Math.max(60_000, this.intervalSec * 6000)) child.kill();
    }, 15_000);
    watchdog.unref();
    child.on('exit', () => clearInterval(watchdog));
    readline.createInterface({ input: this.child.stdout! }).on('line', windowsBatchReader((list, at, gpu) => {
      lastBatch = Date.now();
      this.onList(list, at, gpu);
    }));
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

/**
 * A child that started before its parent is not its child: Windows keeps a parent id after the
 * parent exits, so a process that later gets that id would adopt the old one's children (#162, #169).
 * Without both start times (ps, an older loop) it counts.
 */
export function startedAfter(child: ProcInfo, parent: ProcInfo): boolean {
  return child.started === undefined || parent.started === undefined || child.started >= parent.started;
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
    for (const c of children.get(pid) ?? []) if (c.pid !== pid && startedAfter(c, p)) walk(c.pid);
  };
  walk(root);
  return out;
}

/** The processes a session's tree held at the last sample, kept to go on counting those that left it (#169). */
export type TreeMemory = Map<number, ProcInfo>;

/**
 * The same process as the one seen last time: the same start time where Windows gives one; otherwise
 * its CPU time never shrinks, and its parent is unchanged or gone.
 */
function sameProcess(was: ProcInfo, now: ProcInfo, list: ProcessList): boolean {
  if (was.started !== undefined && now.started !== undefined) return was.started === now.started;
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
    const gone = new Map<number, ProcInfo>();
    const groups = new Set<number>();
    for (const was of memory.values()) {
      const now = list.get(was.pid);
      const same = now !== undefined && sameProcess(was, now, list);
      if (same) seeds.push(was.pid);
      else if (!now) gone.set(was.pid, was);
      // Only a group the session's own process leads (a host in Ledung's group must not take in Ledung),
      // and only while that leader is gone or still the same: a reused id leads someone else's group.
      if (was.pgid !== undefined && was.pgid === was.pid && was.pgid > 1 && (same || !now)) groups.add(was.pgid);
    }
    for (const p of list.values()) {
      const parent = gone.get(p.ppid);
      if ((parent && startedAfter(p, parent)) || (p.pgid !== undefined && groups.has(p.pgid))) seeds.push(p.pid);
    }
  }
  const out: TreeMemory = new Map();
  for (const seed of seeds) {
    if (out.has(seed)) continue;
    for (const p of treeOf(list, seed)) out.set(p.pid, p);
  }
  return { tree: [...out.values()], memory: out };
}
