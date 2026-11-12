// One action at a time on a job's processes (acceptance test of PR #261, finding 1): two Pauses at once (a
// double-click, or the phone and the PC together) both passed the "already paused?" check before either set it, so
// Windows' suspend count went to 2 and one Resume left the job frozen for good. The guard is checked and set before
// the action's first await, and every action (Pause, Resume, Stop) waits its turn by being refused.

export const JOB_BUSY = 'Another action on this job is still under way: wait for it to finish, then try again.';

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
