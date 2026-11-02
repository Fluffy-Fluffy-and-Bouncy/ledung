// The "Archived (N)" entry at the end of each project group in the sidebar (issue #157): some never
// use it, so Settings can hide it (Martin, 2026-10-16 23:39: "I want to be able to hide the
// "Archived (x)" button/text"). Off unless switched on (Martin, 2026-11-03 00:19, issue #95), so an
// entry of '0' from when it was on by default reads off as well; kept per browser like the status dot
// switch (#151). Switching it on is the way to the archived sessions (Martin, 2026-10-16 23:43: "they
// are reachable by enabling the settings again, and that is fine").

export const ARCHIVED_LINK_KEY = 'ledung.archivedLink';

/** The parts of `localStorage` used here, so tests can pass their own. */
export type ArchivedLinkStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Whether the sidebar shows "Archived (N)" in this browser; off unless switched on. */
export function readArchivedLink(store: ArchivedLinkStore): boolean {
  try { return store.getItem(ARCHIVED_LINK_KEY) === '1'; } catch { return false; }
}

/** Saves the switch; off is the default, so it removes the entry. */
export function saveArchivedLink(store: ArchivedLinkStore, on: boolean): void {
  try {
    if (on) store.setItem(ARCHIVED_LINK_KEY, '1');
    else store.removeItem(ARCHIVED_LINK_KEY);
  } catch { /* private mode: kept for this visit only */ }
}

/** Whether a project group ends with its "Archived (N)" entry: switched on, something archived, group open. */
export function showsArchivedLink(on: boolean, archived: number, folded: boolean): boolean {
  return on && archived > 0 && !folded;
}
