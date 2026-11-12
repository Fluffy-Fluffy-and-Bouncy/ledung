// Waiting for you's lists: what waits for the user, sorted by tier, and the recently answered. A question
// a manager is handling is in neither (issue #96) but still opens on its own. Pure, so it can be tested.
import type { QuestionInfo } from '../../src/shared/protocol.ts';
import { deskCompare, deskQuestion, HISTORY_DAYS, HISTORY_PER_PROJECT, tierOf, type DeskQuestion } from '../../src/shared/questions.ts';

/** The part of `localStorage` used here, so tests can pass their own. */
export type FilterStore = Pick<Storage, 'getItem' | 'setItem'>;

/** One project or all (all but the hidden ones); kept in the browser like the page's other view settings. */
export interface Filter { mode: 'one' | 'all'; one: string; hidden: string[] }
const FILTER_KEY = 'ledung.waitingFilter';

export function readFilter(store: FilterStore): Filter {
  try {
    const f = JSON.parse(store.getItem(FILTER_KEY) ?? 'null');
    if (f && (f.mode === 'one' || f.mode === 'all')) return { mode: f.mode, one: String(f.one ?? ''), hidden: Array.isArray(f.hidden) ? f.hidden.map(String) : [] };
  } catch { /* unreadable: the default */ }
  return { mode: 'all', one: '', hidden: [] };
}

export function writeFilter(store: FilterStore, f: Filter): void {
  try { store.setItem(FILTER_KEY, JSON.stringify(f)); } catch { /* private mode: kept for this visit only */ }
}

/** A renamed project (issue #116) keeps its place in this browser's filter: shown alone, or hidden. */
export function renameInFilter(store: FilterStore, from: string, to: string): void {
  const f = readFilter(store);
  if (f.one !== from && !f.hidden.includes(from)) return;
  writeFilter(store, { mode: f.mode, one: f.one === from ? to : f.one, hidden: f.hidden.map((p) => (p === from ? to : p)) });
}

export interface Item { q: QuestionInfo; v: DeskQuestion; project: string; tier: string | null }

/** 3: an order's keep-it question (issue #105); 2: a proposed order to confirm (#105); 1: a refused call (issue #104); 0: any other. */
const first = (i: Item) => (i.q.details?.order ? (i.q.details.order.confirm ? 2 : 3) : i.q.details?.refusal ? 1 : 0);

/**
 * Waiting for you history (issue #306), from the closed questions newest first: per project the last 100 answered
 * (and as many withdrawn), and every one of the last 30 days besides, as Ledung sends them (questionHistory). It was
 * the newest 30 of all projects together, of the 50 Ledung sent.
 */
function history(closed: Item[], now: number): Item[] {
  const since = now - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Map<string, number>();
  return closed.filter((i) => {
    const key = `${i.project}\n${i.q.status === 'answered'}`;
    const place = (seen.get(key) ?? 0) + 1;
    seen.set(key, place);
    return place <= HISTORY_PER_PROJECT || (i.q.answeredAt ?? i.q.askedAt) >= since;
  });
}

/**
 * History read when Waiting for you opens (issue #306), added to the questions the page has: a question it has already
 * (whole from the page load, or newer from the live connection) is never replaced by its light history entry.
 */
export function withHistory(have: Record<number, QuestionInfo>, history: QuestionInfo[]): Record<number, QuestionInfo> {
  const out = { ...have };
  for (const q of history) if (!out[q.id]) out[q.id] = q;
  return out;
}

/** The question an opened page shows: the whole one once read, for a light history entry; else as it is. */
export function opened(item: Item, whole: QuestionInfo | null): Item {
  if (!item.q.light || !whole || whole.id !== item.q.id) return item;
  return { ...item, q: whole, v: deskQuestion(whole) };
}

export function waitingLists(
  questions: QuestionInfo[],
  projectOf: (sessionId: string) => string,
  tiersOf: (project: string) => string[],
  shown: (project: string) => boolean,
  visibleTiers: string[],
  now = Date.now(),
) {
  const items: Item[] = questions.map((q) => {
    const v = deskQuestion(q);
    const project = projectOf(q.sessionId);
    return { q, v, project, tier: tierOf(v.tier, tiersOf(project)) };
  });
  const order = deskCompare(visibleTiers);
  const forYou = items.filter((i) => i.q.status === 'open' && i.q.addressedTo === 'user' && shown(i.project))
    // An order's keep-it question at the end of away first (issue #105), then a proposed order to confirm, then a call the auto mode classifier refused
    // (issue #104), whatever their tier: the page shows them in that order, so the keys' numbers agree.
    .sort((a, b) => first(b) - first(a)
      || order({ tier: a.tier, rank: a.v.rank, askedAt: a.q.askedAt }, { tier: b.tier, rank: b.v.rank, askedAt: b.q.askedAt }));
  const done = history(items.filter((i) => i.q.status !== 'open' && shown(i.project))
    .sort((a, b) => (b.q.answeredAt ?? b.q.askedAt) - (a.q.answeredAt ?? a.q.askedAt) || b.q.id - a.q.id), now);
  // A question a manager is handling is in no list; it opens alone, e.g. from a manager's question about it.
  const listFor = (i: Item) => (i.q.status !== 'open' ? done : i.q.addressedTo === 'user' ? forYou : [i]);
  return { items, forYou, done, listFor };
}
