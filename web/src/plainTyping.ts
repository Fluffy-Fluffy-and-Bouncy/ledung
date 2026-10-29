// Autocorrect in the page's text fields (issue #147): it mangled code, names, paths and Swedish, so
// it is off unless switched on in Settings. Only autocorrect: spell checking and automatic capitals
// stay as the browser has them (Martin, 2026-10-16 13:59). Kept per browser, like the notifications
// switch (#80). Every free-text field spreads the props from usePlainTyping (usePlainTyping.ts);
// test/plain-typing.test.ts fails on a field without them. Password fields don't take them.

export const AUTOCORRECT_KEY = 'ledung.autocorrect';

/** The parts of `localStorage` used here, so tests can pass their own. */
export type TypingStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Whether autocorrect is switched on in this browser; off unless switched on. */
export function readAutocorrect(store: TypingStore): boolean {
  try { return store.getItem(AUTOCORRECT_KEY) === '1'; } catch { return false; }
}

/** Saves the switch; off is the default, so it removes the entry. */
export function saveAutocorrect(store: TypingStore, on: boolean): void {
  try {
    if (on) store.setItem(AUTOCORRECT_KEY, '1');
    else store.removeItem(AUTOCORRECT_KEY);
  } catch { /* private mode: kept for this visit only */ }
}

const OFF = { autoCorrect: 'off' } as const;
const BROWSER_DEFAULT = {} as const;

/** The props a text field spreads: autocorrect off, or nothing, which leaves the browser's default. */
export function typingProps(autocorrect: boolean): { autoCorrect?: 'off' } {
  return autocorrect ? BROWSER_DEFAULT : OFF;
}
