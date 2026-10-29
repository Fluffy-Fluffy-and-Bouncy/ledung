// The sidebar's order of projects and sessions, and where a dragged row lands (issue #88). Pure, so tests reach it.

/** What the sidebar knows of a session to place it among its siblings. */
export interface Placed {
  status: string;
  createdAt: number;
  /** Its dragged place among its siblings; null: never dragged. */
  position: number | null;
}

/**
 * Siblings in the sidebar: sessions nobody dragged that still run on top, newest first (so a new one
 * appears there, as before); then the dragged ones in their dragged order, ended or not; then ended
 * sessions nobody dragged, newest first. With nothing dragged this is the order from before.
 */
export function siblingOrder(a: Placed, b: Placed): number {
  return band(a) - band(b) || (a.position !== null && b.position !== null ? a.position - b.position : b.createdAt - a.createdAt);
}

function band(s: Placed): number {
  return s.position !== null ? 1 : s.status === 'ended' ? 2 : 0;
}

/** The list with `id` moved to the slot before `slot` in the old list (slot = length: last). */
export function moved(ids: string[], id: string, slot: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const rest = ids.filter((x) => x !== id);
  const to = Math.max(0, Math.min(rest.length, slot > from ? slot - 1 : slot));
  return [...rest.slice(0, to), id, ...rest.slice(to)];
}

/** The slot a pointer at `y` drops into: before the first row whose middle is below it. */
export function dropSlot(middles: number[], y: number): number {
  const i = middles.findIndex((m) => y < m);
  return i < 0 ? middles.length : i;
}

/** Whether dropping into this slot leaves the row where it is (just above or just below itself). */
export function staysPut(ids: string[], id: string, slot: number): boolean {
  const from = ids.indexOf(id);
  return slot === from || slot === from + 1;
}
