// The find bar's search (#445): what to ask webContents.findInPage for as the person types and steps, and the "n of m"
// the bar shows from its answers. No Electron in it, so the root tests run it (test/desktop.test.ts); main.ts sends the
// requests and hands the answers back. The keys that drive it are desktop/keys.ts's findKey.

/** One findInPage call: Electron's `findNext` true starts a new search, false steps through the current one. */
export interface FindRequest {
  text: string;
  forward: boolean;
  findNext: boolean;
}

/** The fields of Electron's found-in-page result the bar uses. */
export interface FindResult {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

/** The longest text the bar searches for: a paste of a whole log is cut, not sent to the page's search whole. */
export const MAX_FIND_TEXT = 1000;

/**
 * The bar's line for one answer: "n of m", or "No matches" once the search is done; null for an answer that says
 * nothing yet (Chromium sends a first count with no active match, then the final one).
 */
export function findLabel(result: Pick<FindResult, 'activeMatchOrdinal' | 'matches' | 'finalUpdate'>): string | null {
  if (result.matches === 0) return result.finalUpdate ? 'No matches' : null;
  if (result.activeMatchOrdinal <= 0) return null;
  return `${result.activeMatchOrdinal} of ${result.matches}`;
}

/** One window's search: the text in its bar and the request whose answers the bar shows. */
export class FindSession {
  #text = '';
  #request: number | null = null;

  /** The text in the bar, kept while it is closed, so it opens again with the last search, as a browser's does. */
  get text(): string {
    return this.#text;
  }

  /** The person typed: a new search for the text, or "stop" (clear the highlights) when the box is empty. */
  query(text: string): FindRequest | 'stop' {
    this.#text = text.slice(0, MAX_FIND_TEXT);
    this.#request = null;
    return this.#text === '' ? 'stop' : { text: this.#text, forward: true, findNext: true };
  }

  /** Enter (forward) or Shift+Enter: the next or previous match of the same search; nothing with an empty box. */
  step(forward: boolean): FindRequest | null {
    return this.#text === '' ? null : { text: this.#text, forward, findNext: false };
  }

  /** The bar opened again: the kept text searched anew, so its highlights come back; nothing with an empty box. */
  reopen(): FindRequest | null {
    return this.#text === '' ? null : this.query(this.#text) as FindRequest;
  }

  /** The id findInPage gave the request just sent: only its answers count. */
  sent(requestId: number): void {
    this.#request = requestId;
  }

  /** The bar closed: later answers to its last request are dropped. The text stays for the next open. */
  closed(): void {
    this.#request = null;
  }

  /** The bar's line for an answer, or null to leave it as it is: a stale answer (an older search's) or one with nothing yet. */
  answer(result: FindResult): string | null {
    if (this.#request === null || result.requestId !== this.#request) return null;
    return findLabel(result);
  }
}
