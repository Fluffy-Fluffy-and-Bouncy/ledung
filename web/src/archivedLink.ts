// The "Archived (N)" entry at the end of each project group in the sidebar (issue #157): some never
// use it, so Settings can hide it (Martin, 2026-10-16 23:39: "I want to be able to hide the
// "Archived (x)" button/text"). Shown unless switched off, kept per browser like the status dot
// switch (#151). Switching it back on is the way back to the archived sessions (Martin, 23:43: "they
// are reachable by enabling the settings again, and that is fine").

export const ARCHIVED_LINK_KEY = 'ledung.archivedLink';

/** The parts of `localStorage` used here, so tests can pass their own. */
export type ArchivedLinkStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Whether the sidebar shows "Archived (N)" in this browser; shown unless switched off. */
export function readArchivedLink(store: ArchivedLinkStore): boolean {
  try { return store.getItem(ARCHIVED_LINK_KEY) !== '0'; } catch { return true; }
}

/** Saves the switch; on is the default, so it removes the entry. */
export function saveArchivedLink(store: ArchivedLinkStore, on: boolean): void {
  try {
    if (on) store.removeItem(ARCHIVED_LINK_KEY);
    else store.setItem(ARCHIVED_LINK_KEY, '0');
  } catch { /* private mode: kept for this visit only */ }
}

/** Whether a project group ends with its "Archived (N)" entry: switched on, something archived, group open. */
export function showsArchivedLink(on: boolean, archived: number, folded: boolean): boolean {
  return on && archived > 0 && !folded;
}
