// What the Machine panel folds away and what it keeps open (issue #284: the sidebar's top-left had grown bloated).
// Pure, so the rules are tested without a browser. The resource limits' own rules (docs/steps/resource-limits.md)
// are untouched: this only decides what is drawn.

/** A wait in "Waiting for room" longer than this keeps the list open (Martin, issue #284: "unless an item has waited over a minute"). */
export const WAIT_OPEN_MS = 60_000;

/** The list opens by itself while any item in it has waited longer than a minute. */
export function waitingOpen(line: { since: number }[], now: number): boolean {
  return line.some((w) => now - w.since > WAIT_OPEN_MS);
}

/** A job over its share needs the person, so its full card stays open; a going or paused job is one line. */
export function jobOpen(job: { state: 'going' | 'over' | 'paused' }): boolean {
  return job.state === 'over';
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
