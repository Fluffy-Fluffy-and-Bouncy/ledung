// One long-lived Windows PowerShell that answers requests, one at a time (#230, audit O4 and O6).
// Starting powershell.exe costs more CPU than the process list it is started for, so a list every
// few seconds goes to a PowerShell that is already running: Node writes one line, PowerShell runs
// the script's answer and prints its lines between "#BEGIN" and "#END". It exits when its input
// closes: when Ledung ends, or after a while with no request.
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';

export interface PowerShellWorkerOptions {
  /** The PowerShell that answers one request: `$req` holds the line Node wrote; whatever it writes is the answer. */
  answer: string;
  /** Exit after this long with no request; the next request starts it again. */
  idleMs?: number;
  /** An answer that takes longer is given up: the PowerShell is ended and the request fails. */
  answerMs?: number;
  /** After a PowerShell that would not start or died, no new one for this long (as the monitor's minute before #230). */
  retryMs?: number;
  /** For tests: what is started instead of powershell.exe. */
  spawn?: () => ChildProcess;
}

export interface PowerShellAnswer {
  lines: string[];
  /** What PowerShell put after "#BEGIN" (the monitor's read time, #157); empty when nothing. */
  begin: string;
}

const LOOP = (answer: string) => `[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
while ($null -ne ($req = [Console]::In.ReadLine())) {
${answer}
  [Console]::Out.WriteLine('#END')
  [Console]::Out.Flush()
}`;

/**
 * Requests are answered in order, never two at once. One sent while another runs waits for it; that
 * keeps "a list taken after I asked" true for every caller.
 */
export class PowerShellWorker {
  private readonly opts: PowerShellWorkerOptions;
  private child: ChildProcess | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private current: { lines: string[]; begin: string | null; done: (a: PowerShellAnswer) => void; fail: (e: Error) => void } | null = null;
  private idle: NodeJS.Timeout | null = null;
  private failedAt = 0;
  private closed = false;

  constructor(opts: PowerShellWorkerOptions) {
    this.opts = opts;
  }

  /** How many PowerShells this worker has started (for tests and the EXERCISED line). */
  starts = 0;

  request(line = ''): Promise<PowerShellAnswer> {
    const next = this.queue.catch(() => {}).then(() => this.ask(line));
    this.queue = next;
    return next;
  }

  /** Ends the PowerShell for good; requests after this fail. */
  close(): void {
    this.closed = true;
    this.end();
  }

  private ask(line: string): Promise<PowerShellAnswer> {
    if (this.closed) return Promise.reject(new Error('closed'));
    if (this.failedAt && Date.now() - this.failedAt < (this.opts.retryMs ?? 60_000)) return Promise.reject(new Error('PowerShell failed a moment ago'));
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const child = this.child ?? this.startChild();
    // Kept alive while it answers; otherwise it must not hold Ledung, or a test, open.
    ref(child, true);
    return new Promise<PowerShellAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failedAt = Date.now();
        this.current?.fail(new Error('PowerShell did not answer in time'));
        this.end();
      }, this.opts.answerMs ?? 60_000);
      const settle = () => {
        clearTimeout(timer);
        this.current = null;
        if (this.child) ref(this.child, false);
        if (this.child && !this.closed) this.idle = setTimeout(() => this.end(), this.opts.idleMs ?? 30_000).unref();
      };
      this.current = {
        lines: [], begin: null,
        done: (a) => { settle(); resolve(a); },
        fail: (e) => { settle(); reject(e); },
      };
      child.stdin!.write(`${line.replace(/[\r\n]/g, ' ')}\n`);
    });
  }

  private startChild(): ChildProcess {
    const child = this.opts.spawn?.() ?? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LOOP(this.opts.answer)], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    this.starts++;
    this.child = child;
    child.stdin!.on('error', () => {});
    readline.createInterface({ input: child.stdout! }).on('line', (l) => {
      const c = this.current;
      // A PowerShell given up on may still print; its lines must not land in the next one's answer.
      if (!c || this.child !== child) return;
      if (l.startsWith('#BEGIN')) c.begin = l.slice('#BEGIN'.length).trim();
      else if (l === '#END') c.done({ lines: c.lines, begin: c.begin ?? '' });
      else c.lines.push(l);
    });
    const gone = () => {
      if (this.child !== child) return;
      this.child = null;
      if (this.current) {
        this.failedAt = Date.now();
        this.current.fail(new Error('PowerShell ended'));
      }
    };
    child.on('error', gone);
    child.on('exit', gone);
    return child;
  }

  private end(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    this.current?.fail(new Error('PowerShell ended'));
    child.stdin?.end();
    // Its input closed, it exits by itself; one stuck in a list is ended.
    const kill = setTimeout(() => child.kill(), 5000).unref();
    child.once('exit', () => clearTimeout(kill));
  }
}

/** Whether the child and its pipes keep Node's event loop running. */
function ref(child: ChildProcess, on: boolean): void {
  for (const h of [child, child.stdin, child.stdout] as ({ ref?: () => void; unref?: () => void } | null)[]) {
    if (on) h?.ref?.();
    else h?.unref?.();
  }
}
