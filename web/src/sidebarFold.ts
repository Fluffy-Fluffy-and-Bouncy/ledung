// Folding sessions and projects in the sidebar (issue #149). A caret on a manager, or on any session that runs
// sessions, folds those away; a caret on a project folds all its rows (Martin, 2026-10-16, question #154: "a
// button next to the relevant session/manager/project so we can toggle one and show another", not one switch).
// What is hidden is added up on the row that stays, so a question or a working session is never out of
// sight. Pure helpers, kept apart from the component so tests reach them; the folds are kept per browser,
// like the sidebar width.
import type { SessionInfo } from '../../src/shared/protocol.ts';
import { statusLook } from './sessionStatus.ts';

export const FOLDED_KEY = 'ledung.sidebar.folded';
export const FOLDED_SESSIONS_KEY = 'ledung.sidebar.foldedSessions';

/** The part of `localStorage` used here, so tests can pass their own. */
export type FoldStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** What a sidebar row needs here: its session, depth (1: run by the row above) and drag group. */
export interface FoldRow {
  s: Pick<SessionInfo, 'id' | 'status' | 'paused'>;
  depth: number;
  drag: string | null;
}

/** The hidden rows behind a visible one: how many, their pending questions and permissions, whether any works. */
export interface Hidden {
  count: number;
  pending: number;
  working: boolean;
}

/** A drawn row. folds: a depth-0 row with sessions under it (it gets a caret); folded: those are folded away; hidden: what is folded away under it. */
export type FoldedRow<R extends FoldRow> = R & { folds: boolean; folded: boolean; hidden: Hidden | null };

export interface FoldView<R extends FoldRow> {
  rows: FoldedRow<R>[];
  /** What the project row stands for when folded; null when it is open. */
  project: Hidden | null;
}

const add = (h: Hidden | null, r: FoldRow, pending: Record<string, number>): Hidden => ({
  count: (h?.count ?? 0) + 1,
  pending: (h?.pending ?? 0) + (pending[r.s.id] ?? 0),
  working: (h?.working ?? false) || statusLook(r.s) === 'running',
});

/**
 * A project's rows with some sessions and/or the project folded. The open session always stays, so you
 * see where you are; kept that way it can't be dragged, because its siblings are not on screen and a drop
 * would order it against rows the drag can't see (sidebarDrag.ts reads them from the page).
 */
export function foldRows<R extends FoldRow>(rows: R[], opts: { foldedSessions: readonly string[]; folded: boolean; openId: string | null; pending: Record<string, number> }): FoldView<R> {
  const out: FoldedRow<R>[] = [];
  let project: Hidden | null = null;
  // The depth-0 row the depth-1 rows after it belong to, and its drawn row (null while the project hides it).
  let parentId: string | null = null;
  let parent: FoldedRow<R> | null = null;
  rows.forEach((r, i) => {
    if (r.depth === 0) {
      parentId = r.s.id;
      parent = null;
    }
    const gone = opts.folded || (r.depth > 0 && parentId !== null && opts.foldedSessions.includes(parentId));
    const folds = r.depth === 0 && rows[i + 1]?.depth === 1;
    if (!gone || r.s.id === opts.openId) {
      const row: FoldedRow<R> = { ...r, ...(gone ? { drag: null } : {}), folds, folded: folds && opts.foldedSessions.includes(r.s.id), hidden: null };
      out.push(row);
      if (r.depth === 0) parent = row;
      return;
    }
    if (opts.folded) project = add(project, r, opts.pending);
    else if (parent) parent.hidden = add(parent.hidden, r, opts.pending);
  });
  // Folded with nothing hidden (only the open row there) still says it is folded: count 0.
  if (opts.folded && !project) project = { count: 0, pending: 0, working: false };
  return { rows: out, project };
}

function readList(store: FoldStore, key: string): string[] {
  try {
    const v: unknown = JSON.parse(store.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeList(store: FoldStore, key: string, names: readonly string[]): void {
  try {
    if (names.length) store.setItem(key, JSON.stringify(names));
    else store.removeItem(key);
  } catch {
    // Private mode: kept for this visit only.
  }
}

/** The folded projects (and "Removed projects") by name; anything unreadable means none. */
export const readFolded = (store: FoldStore): string[] => readList(store, FOLDED_KEY);
export const writeFolded = (store: FoldStore, names: readonly string[]): void => writeList(store, FOLDED_KEY, names);

/** The sessions whose own sessions are folded away, by id; anything unreadable means none. */
export const readFoldedSessions = (store: FoldStore): string[] => readList(store, FOLDED_SESSIONS_KEY);
export const writeFoldedSessions = (store: FoldStore, ids: readonly string[]): void => writeList(store, FOLDED_SESSIONS_KEY, ids);

/** The list with `name` folded or opened; `keep` drops names that no longer exist, so the list doesn't grow forever. */
export function toggleFolded(names: readonly string[], name: string, keep: (n: string) => boolean = () => true): string[] {
  const rest = names.filter((n) => n !== name && keep(n));
  return names.includes(name) ? rest : [...rest, name];
}
