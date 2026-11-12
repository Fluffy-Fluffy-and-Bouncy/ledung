// Every process on this computer, listed for the `!` command recorders (#230, audit O4). Before, each
// recorder started a new powershell.exe every 2 s and a new one could start while the last still ran,
// so a minute-long command started about 30. Now all recorders share one lister: one list at a time,
// on Windows from one long-lived PowerShell (powershell-worker.ts). Same lines and fields as listAll
// in process-tree.ts, which the session host uses and so stays as it is (CLAUDE.md: the host changes rarely).
import { exercisedLine } from './exercised.ts';
import { listAll, type ProcessInfo } from './process-tree.ts';
import { PowerShellWorker } from './powershell-worker.ts';

const WINDOWS_ANSWER = `  [Console]::Out.WriteLine('#BEGIN')
  Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object { [Console]::Out.WriteLine("$($_.ProcessId)\`t$($_.ParentProcessId)\`t$($_.CreationDate.ToFileTimeUtc())\`t$($_.Name)") }`;

/** "pid<tab>ppid<tab>creation FILETIME<tab>name" lines, as listAll reads them on Windows. */
export function parseListLines(lines: string[]): ProcessInfo[] {
  return lines.filter(Boolean).map((line) => {
    const [pid, ppid, started, name] = line.split('\t');
    return { pid: Number(pid), ppid: Number(ppid), started: started ?? '', name: name ?? '' };
  }).filter((p) => p.pid > 0);
}

/**
 * Lists with `read`, never two at once. A call while a list is being taken gets the next one, taken
 * once that ends: a list from before the call could miss a process started just before it.
 */
export class SharedLister {
  private readonly read: () => Promise<ProcessInfo[]>;
  private running: Promise<ProcessInfo[]> | null = null;
  private next: Promise<ProcessInfo[]> | null = null;

  constructor(read: () => Promise<ProcessInfo[]>) {
    this.read = read;
  }

  list(): Promise<ProcessInfo[]> {
    // Between one read ending and the queued one starting, `running` is already clear: join the queued one then.
    if (!this.running && !this.next) return this.start();
    if (!this.running) return this.next!;
    this.next ??= this.running.catch(() => {}).then(() => {
      this.next = null;
      return this.start();
    });
    return this.next;
  }

  private start(): Promise<ProcessInfo[]> {
    const p = this.read();
    this.running = p;
    const clear = () => {
      if (this.running === p) this.running = null;
    };
    p.then(clear, clear);
    return p;
  }
}

let exercised230 = false;
let worker: PowerShellWorker | null = null;

async function readWindows(): Promise<ProcessInfo[]> {
  worker ??= new PowerShellWorker({ answer: WINDOWS_ANSWER, retryMs: 5000 });
  const { lines } = await worker.request();
  if (!exercised230) {
    exercised230 = true;
    exercisedLine('EXERCISED #230 a "!" command recorder listed processes through the shared PowerShell');
  }
  return parseListLines(lines);
}

const shared = new SharedLister(process.platform === 'win32' ? readWindows : listAll);

/** Every process this user can see, as listAll gives them, through the one shared lister. */
export function listShared(): Promise<ProcessInfo[]> {
  return shared.list();
}
