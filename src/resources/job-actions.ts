import { treeFrom } from '../platform/process-tree.ts';

// One action at a time on a job's processes (acceptance test of PR #261, finding 1): two Pauses at once (a
// double-click, or the phone and the PC together) both passed the "already paused?" check before either set it, so
// Windows' suspend count went to 2 and one Resume left the job frozen for good. The guard is checked and set before
// the action's first await, and every action (Pause, Resume, Stop) waits its turn by being refused.

export const JOB_BUSY = 'Another action on this job is still under way: wait for it to finish, then try again.';

/**
 * What a Stop or Pause leaves alone, from a fresh list: the job's processes the failed guesses reach that still run,
 * and the job's processes that are gone. A gone one is never "another program" left alone (its command line can't be
 * read, so it fails the check): a second Stop on a paused job counted what the first had just ended as an unnamed
 * other program and told the session again (acceptance test 6 of PR #476). Gone ones are only dropped from the job.
 */
export function leftAloneNow(guessedOut: number[], fresh: FreshProcess[], reached: Set<number>, jobPids: number[]): { alone: number[]; gone: number[] } {
  const alive = new Set(fresh.map((p) => p.pid));
  const job = new Set(jobPids);
  const alone = [...new Set([...guessedOut, ...guessedOut.flatMap((pid) => treeFrom(fresh, pid).map((p) => p.pid))])].filter((pid) => !reached.has(pid) && alive.has(pid) && job.has(pid));
  return { alone, gone: jobPids.filter((pid) => !alive.has(pid)) };
}

export class JobActions {
  private readonly busy = new Set<string>();

  /** Runs `action` for job `id`, or throws at once (synchronously checked) while another one for it runs. */
  run<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) return Promise.reject(new Error(JOB_BUSY));
    this.busy.add(id);
    let p: Promise<T>;
    try {
      p = action();
    } catch (e) {
      this.busy.delete(id);
      return Promise.reject(e);
    }
    return p.finally(() => this.busy.delete(id));
  }

  isBusy(id: string): boolean {
    return this.busy.has(id);
  }
}

/** A process in a fresh list (src/platform/process-tree.ts): its start time as the platform gives it, and its name. */
export interface FreshProcess {
  pid: number;
  ppid: number;
  /** Windows: a FILETIME as digits; elsewhere ps's start date; compared only where it is a FILETIME. */
  started: string;
  name: string;
}

/** A Windows FILETIME (digits) as Unix milliseconds, as the sampler records it; null for anything else. */
export function fileTimeMs(started: string): number | null {
  if (!/^\d+$/.test(started) || started === '0') return null;
  return Number(BigInt(started) / 10000n - 11644473600000n);
}

/**
 * The part of a fresh list of every process that a job's action looks at: its session's host with everything under
 * it, and each detached process of the job whose parent is gone (adopted by the book) with everything under that.
 * A `nohup` job's shell has exited, so it is under no host (acceptance test 3 of PR #476).
 */
export function jobProcessesNow(all: FreshProcess[], host: number, adopted: number[]): FreshProcess[] {
  const out = new Map<number, FreshProcess>();
  for (const root of [host, ...adopted]) for (const p of treeFrom(all, root)) out.set(p.pid, p);
  return [...out.values()];
}

/** A command line's words, quotes taken off; `split`: a shell's operators (`&`, `;`, `>`) also end a word outside quotes. */
function words(command: string, split = false): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].flatMap((m) => m[1] ?? m[2] ?? (split ? (m[3] ?? '').split(/[;&|()<>]+/) : [m[3] ?? ''])).filter(Boolean);
}

/** A word as compared: lower case, a path down to its last part, a program without .exe, .cmd or .bat. */
function bare(word: string): string {
  return (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

/**
 * Whether a process's command line is what a detaching call ran (re-review of PR #476): its program and each of its
 * arguments are words of the call (a path compared by its last part, so `python train.py &` matches
 * `C:\Python\python.exe train.py`). A program the call never named (an app another launcher started) never matches.
 */
export function commandIsCalls(processCommand: string, callCommand: string): boolean {
  const [program, ...args] = words(processCommand).map(bare);
  if (!program) return false;
  const call = new Set(words(callCommand, true).map(bare));
  return call.has(program) && args.every((a) => call.has(a));
}

/**
 * Which detached processes Ledung took as a session's only by when they started may be acted on: the same process
 * (start time as in the fresh list), its command one of the session's detaching calls', and its working folder inside
 * one of the session's folders where that can be read. Counting on a timing guess is fine; pausing or ending an
 * outside program on one is not (re-review of PR #476: a game whose launcher exited between two samples).
 */
export function provenByCommand(
  guessed: { pid: number; commands: string[] }[],
  fresh: FreshProcess[],
  found: { pid: number; started: string; command: string; cwd: string | null }[],
  folders: string[],
  inside: (folder: string, cwd: string) => boolean,
): number[] {
  const out: number[] = [];
  for (const g of guessed) {
    const now = fresh.find((p) => p.pid === g.pid);
    const c = found.find((f) => f.pid === g.pid);
    if (!now || !c || c.started !== now.started) continue;
    if (!g.commands.some((call) => commandIsCalls(c.command, call))) continue;
    if (c.cwd !== null && !folders.some((f) => inside(f, c.cwd!))) continue;
    out.push(g.pid);
  }
  return out;
}

/**
 * The processes to act on for a job, from a list taken just now of its session's host and everything under it
 * (finding 5): the job's processes that are still the same process (start time, where the platform gives one),
 * plus everything they started since the last sample (a `make -j` or a trainer's workers), never the host, Claude
 * Code (the host's child) or Claude Code's console host. Each with its start time from the fresh list, for Windows'
 * check on the handle; null where none is known.
 */
export function jobTargetsNow(job: { pid: number; started: number | null }[], fresh: FreshProcess[], host: number): { pid: number; started: number | null }[] {
  const byPid = new Map(fresh.map((p) => [p.pid, p]));
  const claude = new Set(fresh.filter((p) => p.ppid === host).map((p) => p.pid));
  const excluded = (p: FreshProcess) => p.pid === host || claude.has(p.pid) || (claude.has(p.ppid) && /^conhost\.exe$/i.test(p.name));
  const roots: number[] = [];
  for (const t of job) {
    const p = byPid.get(t.pid);
    if (!p || excluded(p)) continue;
    const now = fileTimeMs(p.started);
    // Within 1 ms: the sampler rounds the same FILETIME to milliseconds.
    if (t.started !== null && now !== null && Math.abs(now - t.started) > 1) continue;
    roots.push(p.pid);
  }
  const children = new Map<number, FreshProcess[]>();
  for (const p of fresh) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const out = new Map<number, { pid: number; started: number | null }>();
  const walk = (pid: number) => {
    const p = byPid.get(pid);
    if (!p || out.has(pid) || excluded(p)) return;
    out.set(pid, { pid, started: fileTimeMs(p.started) });
    for (const c of children.get(pid) ?? []) walk(c.pid);
  };
  for (const r of roots) walk(r);
  return [...out.values()];
}
