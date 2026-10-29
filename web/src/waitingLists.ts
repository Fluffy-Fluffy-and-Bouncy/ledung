// Waiting for you's lists: what waits for the user, sorted by tier, and the recently answered. A question
// a manager is handling is in neither (issue #96) but still opens on its own. Pure, so it can be tested.
import type { QuestionInfo } from '../../src/shared/protocol.ts';
import { deskCompare, deskQuestion, tierOf, type DeskQuestion } from '../../src/shared/questions.ts';

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

export function waitingLists(
  questions: QuestionInfo[],
  projectOf: (sessionId: string) => string,
  tiersOf: (project: string) => string[],
  shown: (project: string) => boolean,
  visibleTiers: string[],
) {
  const items: Item[] = questions.map((q) => {
    const v = deskQuestion(q);
    const project = projectOf(q.sessionId);
    return { q, v, project, tier: tierOf(v.tier, tiersOf(project)) };
  });
  const order = deskCompare(visibleTiers);
  const forYou = items.filter((i) => i.q.status === 'open' && i.q.addressedTo === 'user' && shown(i.project))
    .sort((a, b) => order({ tier: a.tier, rank: a.v.rank, askedAt: a.q.askedAt }, { tier: b.tier, rank: b.v.rank, askedAt: b.q.askedAt }));
  const done = items.filter((i) => i.q.status !== 'open' && shown(i.project))
    .sort((a, b) => (b.q.answeredAt ?? b.q.askedAt) - (a.q.answeredAt ?? a.q.askedAt)).slice(0, 30);
  // A question a manager is handling is in no list; it opens alone, e.g. from a manager's question about it.
  const listFor = (i: Item) => (i.q.status !== 'open' ? done : i.q.addressedTo === 'user' ? forYou : [i]);
  return { items, forYou, done, listFor };
}
