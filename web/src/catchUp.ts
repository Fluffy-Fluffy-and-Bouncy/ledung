// A reconnect catches an open chat up instead of reloading it (issue #178): reloading the newest 500 dropped
// what "Load earlier" had added and moved the view, and through the relay reconnects are frequent.
import type { StoredMessage } from '../../src/shared/protocol.ts';

/** The page size of the messages endpoint: a full page means there may be more. */
export const PAGE = 500;

/**
 * The shown list with the newer messages added, in id order and each once. A live message can arrive while the
 * catch-up is on its way, so the fetched ones are not simply put after the last. Unchanged when nothing is new,
 * so nothing re-renders.
 */
export function withNewer(shown: StoredMessage[], newer: StoredMessage[]): StoredMessage[] {
  const have = new Set(shown.map((m) => m.id));
  const fresh = newer.filter((m) => !have.has(m.id));
  if (!fresh.length) return shown;
  return [...shown, ...fresh].sort((a, b) => a.id - b.id);
}

/** Every message after `lastId`, page by page until a page is not full. */
export async function fetchNewer(lastId: number, fetchAfter: (afterId: number) => Promise<StoredMessage[]>): Promise<StoredMessage[]> {
  const all: StoredMessage[] = [];
  for (let after = lastId; ; ) {
    const page = await fetchAfter(after);
    all.push(...page);
    // A page that does not move past `after` would ask for the same one forever.
    const next = page.at(-1)?.id ?? after;
    if (page.length < PAGE || next <= after) return all;
    after = next;
  }
}
