// What the Machine panel folds away and what it keeps open (issue #284: the sidebar's top-left had grown bloated).
// Pure, so the rules are tested without a browser. The resource limits' own rules (docs/steps/resource-limits.md)
// are untouched: this only decides what is drawn.

/** A wait in "Waiting for room" longer than this keeps the list open (Martin, issue #284: "unless an item has waited over a minute"). */
export const WAIT_OPEN_MS = 60_000;

/** The list opens by itself while any item in it has waited longer than a minute. */
export function waitingOpen(line: { since: number }[], now: number): boolean {
  return line.some((w) => now - w.since > WAIT_OPEN_MS);
}

/** A job over its share needs the person, so its full card stays open; any other job is one line. */
export function jobOpen(job: { state: string }): boolean {
  return job.state === 'over';
}

/**
 * Busy, ready, over and paused jobs first; parked ones apart, folded under them, so a few leftover daemons don't
 * crowd the panel on a phone (resource limits round 2, "What is shown").
 */
export function splitParked<T extends { state: string }>(jobs: T[]): { active: T[]; parked: T[] } {
  return { active: jobs.filter((j) => j.state !== 'parked'), parked: jobs.filter((j) => j.state === 'parked') };
}

/** A pass's state in words for its card (round 2): ready, busy, parked, resumed above the limits. */
export function passStateText(job: { state: string; deliveredAt: number | null; goAt: number; quietSince: number | null; parkedAt: number | null; resumedAbove: boolean }, now: number, mins: (ms: number) => string): string {
  if (job.state === 'ready') return job.deliveredAt === null ? 'Ready: the go is on its way to the session; holds its room' : `Ready: go given ${mins(now - job.deliveredAt)} ago, work not started; holds its room`;
  if (job.state === 'parked') return `Parked: quiet${job.parkedAt ? ` for ${mins(now - job.parkedAt)}` : ''}, holds no room`;
  if (job.state === 'busy') {
    const quiet = job.quietSince !== null ? `; quiet for ${mins(now - job.quietSince)}` : '';
    return `${job.resumedAbove ? 'Busy, resumed above the limits' : 'Busy'}${quiet}`;
  }
  return job.state;
}

/**
 * A job's one-line bar: its most-used reservation, as used over reserved (1 = all of it), and whether any resource is
 * over what it reserved. A job that reserved nothing has 0.
 */
export function jobUse(job: { granted: Record<string, number>; using: Record<string, number> }): { share: number; over: boolean } {
  let share = 0;
  let over = false;
  for (const [dim, g] of Object.entries(job.granted)) {
    const u = job.using[dim] ?? 0;
    if (g > 0) share = Math.max(share, u / g);
    if (u > g) over = true;
  }
  return { share, over };
}

/**
 * The WSL hint (resource limits round 2, problem 5) is due when WSL holds more than a quarter of the memory limit, or
 * of all memory with no limit set.
 */
export function wslHintDue(r: { wsl?: number | null; limits: Record<string, number> }, memTotal: number): boolean {
  const base = r.limits.ram ?? memTotal;
  return !!r.wsl && base > 0 && r.wsl > base / 4;
}
