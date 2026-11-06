// Typical costs (step 6c): per project and kind of command, what a turn that ran it usually used.
// Shown to Simon first; using them to decide whether there is room is a later decision.
import type { TurnResource, TypicalCost } from '../shared/protocol.ts';

/**
 * A turn's CPU figures held at the machine's thread count. Turns recorded before #157 was fixed can
 * carry a peak far above it (a measuring artefact, see capCores in monitor.ts); they stay in the
 * database as they are and are held at the limit when read.
 */
export function capTurnCores<T extends TurnResource>(t: T, threads: number): T {
  if (threads <= 0 || (t.peakCores <= threads && t.avgCores <= threads)) return t;
  return { ...t, peakCores: Math.min(t.peakCores, threads), avgCores: Math.min(t.avgCores, threads) };
}

/** `threads`: the machine's thread count, which no turn's CPU figure may exceed (#157); 0 holds nothing. */
export function typicalCosts(rows: (TurnResource & { project: string })[], threads = 0): TypicalCost[] {
  const turns = rows.map((t) => capTurnCores(t, threads));
  const groups = new Map<string, (TurnResource & { project: string })[]>();
  for (const t of turns) {
    const kinds = t.commands.length ? [...new Set(t.commands)] : [''];
    for (const k of kinds) {
      const key = `${t.project}\u0000${k}`;
      // In place: copying the list for every turn was quadratic (#356).
      const group = groups.get(key);
      if (group) group.push(t);
      else groups.set(key, [t]);
    }
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  return [...groups.entries()]
    .map(([key, ts]) => {
      const [project, command] = key.split('\u0000') as [string, string];
      return {
        project, command, turns: ts.length,
        avgCores: avg(ts.map((t) => t.avgCores)),
        peakCores: avg(ts.map((t) => t.peakCores)),
        peakMem: avg(ts.map((t) => t.peakMem)),
        durationMs: avg(ts.map((t) => t.durationMs)),
      };
    })
    .sort((a, b) => b.turns - a.turns || b.peakMem - a.peakMem);
}
