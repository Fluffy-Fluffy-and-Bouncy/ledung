// A session's unsent message box text, kept in this browser so it survives view changes,
// session switches and reload (issue #73). Sending clears it.

/** The part of `localStorage` used here, so tests can pass their own. */
export type DraftStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const key = (sessionId: string) => `ledung.draft.${sessionId}`;

export function readDraft(store: DraftStore, sessionId: string): string {
  try {
    return store.getItem(key(sessionId)) ?? '';
  } catch {
    return '';
  }
}

/** Empty text removes the entry, so a sent or cleared box leaves nothing behind. */
export function writeDraft(store: DraftStore, sessionId: string, text: string): void {
  try {
    if (text) store.setItem(key(sessionId), text);
    else store.removeItem(key(sessionId));
  } catch {
    // Private mode or a full store: kept for this visit only.
  }
}
