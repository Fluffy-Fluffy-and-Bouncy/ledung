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
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)$/);
    if (!m) continue;
    list.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), cpuSeconds: parsePsTime(m[3]!), memBytes: Number(m[4]) * 1024 });
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
  [Console]::Out.WriteLine('#BEGIN')
  foreach ($x in $p) { [Console]::Out.WriteLine("$($x.ProcessId),$($x.ParentProcessId),$([long]$x.KernelModeTime + [long]$x.UserModeTime),$($x.WorkingSetSize)") }
  [Console]::Out.WriteLine('#END')
  [Console]::Out.Flush()
  Start-Sleep -Seconds ${intervalSec}
}`;

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
    let lines: string[] | null = null;
    readline.createInterface({ input: this.child.stdout! }).on('line', (line) => {
      if (line === '#BEGIN') lines = [];
      else if (line === '#END' && lines) {
        this.onList(parseWindowsLines(lines), Date.now());
        lines = null;
      } else lines?.push(line);
    });
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
        const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,time=,rss='], { maxBuffer: 16 * 1024 * 1024 });
        this.onList(parsePs(stdout), Date.now());
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
