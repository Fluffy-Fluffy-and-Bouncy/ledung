// Which sessions the live connection's hello carries (issue #229, audit O8). Every session ever made was sent on
// every page open, hundreds of archived ones included, though the page shows those only under a project's Archived.
// Now hello carries the sessions not archived, those archived lately, and those its questions and prompts name; the
// rest are counted per project, so each Archived (N) stays right, and fetched when an Archived list opens.
import type { SessionInfo } from './protocol.ts';

/** How long an archived session still comes with hello: what was just archived stays at hand. */
export const RECENT_ARCHIVED_MS = 24 * 60 * 60 * 1000;

export interface HelloSessions {
  sessions: SessionInfo[];
  /** Archived sessions left out of `sessions`, counted by project. */
  olderArchived: Record<string, number>;
}

/**
 * all: every session; named: ids that something else in hello points at (a question's asker, answerer or addressee,
 * a prompt's session), kept so their names, colours and projects still show. A kept session's manager is kept too.
 */
export function helloSessions(all: SessionInfo[], named: Iterable<string>, now: number): HelloSessions {
  const byId = new Map(all.map((s) => [s.id, s]));
  const keep = new Set<string>();
  const add = (id: string | null | undefined) => {
    for (let s = id ? byId.get(id) : undefined; s && !keep.has(s.id); s = s.parentId ? byId.get(s.parentId) : undefined) keep.add(s.id);
  };
  for (const s of all) if (s.archivedAt == null || s.archivedAt >= now - RECENT_ARCHIVED_MS) add(s.id);
  for (const id of named) add(id);
  const olderArchived: Record<string, number> = {};
  for (const s of all) if (!keep.has(s.id)) olderArchived[s.project] = (olderArchived[s.project] ?? 0) + 1;
  // all's own order (newest first), which the page relies on as before.
  return { sessions: all.filter((s) => keep.has(s.id)), olderArchived };
}

/**
 * Whether the page fetches every archived session: while hello has left some out, when a project's Archived list is
 * open ("a:<name>"), or when a session's link names one the page lacks once hello has come (an old archived one).
 */
export function fetchesArchived(at: { openId: string | null; loaded: boolean; unknownSession: boolean; olderArchived: Record<string, number> }): boolean {
  if (!Object.keys(at.olderArchived).length) return false;
  return !!at.openId?.startsWith('a:') || (at.loaded && at.unknownSession);
}

/** The page's sessions and the archived ones it only has counts of. */
export interface KnownSessions {
  sessions: SessionInfo[];
  olderArchived: Record<string, number>;
}

/** The fetched archived sessions added (those it has already stay, its own are newer); nothing is left only counted. */
export function withArchived(known: KnownSessions, archived: SessionInfo[]): KnownSessions {
  const have = new Set(known.sessions.map((s) => s.id));
  return { sessions: [...known.sessions, ...archived.filter((s) => !have.has(s.id))], olderArchived: {} };
}

/**
 * A session's change from the live connection. One the page lacks is either new or one hello only counted (archived,
 * then resumed, unarchived or changed): an archived one hello left out was made more than RECENT_ARCHIVED_MS before
 * it, and a new one after it, so its age tells them apart, with half the window to spare for the computers' clocks.
 * The counted one moves from its project's count into the list, so the Archived (N) links don't count it twice.
 */
export function withSession(known: KnownSessions, session: SessionInfo, helloAt: number): KnownSessions {
  if (known.sessions.some((s) => s.id === session.id)) {
    return { ...known, sessions: known.sessions.map((s) => (s.id === session.id ? session : s)) };
  }
  const sessions = [session, ...known.sessions];
  const counted = known.olderArchived[session.project] ?? 0;
  if (!counted || session.createdAt >= helloAt - RECENT_ARCHIVED_MS / 2) return { ...known, sessions };
  return { sessions, olderArchived: { ...known.olderArchived, [session.project]: counted - 1 } };
}
