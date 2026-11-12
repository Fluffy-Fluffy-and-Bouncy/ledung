// The session list indexed once per change (issue #233, audit O9): each sidebar row asked for its own sessions
// by scanning the whole list (its ship, its team's tokens, its child rows), so 50 sessions cost 2,500 steps per
// redraw. Built here in one pass, each row looks its own up.
import { CHATS, type ProjectInfo, type SessionInfo } from '../../src/shared/protocol.ts';
import { siblingOrder } from './sidebarOrder.ts';

const NONE: readonly SessionInfo[] = Object.freeze([]);

export interface SessionIndex {
  byId: Map<string, SessionInfo>;
  /** The sessions each one started, in list order. */
  childrenOf(id: string): readonly SessionInfo[];
}

export function indexSessions(sessions: readonly SessionInfo[]): SessionIndex {
  const byId = new Map<string, SessionInfo>();
  const children = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    byId.set(s.id, s);
    if (s.parentId == null) continue;
    const list = children.get(s.parentId);
    if (list) list.push(s);
    else children.set(s.parentId, [s]);
  }
  return { byId, childrenOf: (id) => children.get(id) ?? NONE };
}

/** Sessions by a key of each (their project, their sidebar group), in list order, in one pass. */
export function groupBy<K>(sessions: readonly SessionInfo[], key: (s: SessionInfo) => K): Map<K, SessionInfo[]> {
  const groups = new Map<K, SessionInfo[]>();
  for (const s of sessions) {
    const k = key(s);
    const list = groups.get(k);
    if (list) list.push(s);
    else groups.set(k, [s]);
  }
  return groups;
}

/** The sidebar group for sessions of projects that were removed. */
export const REMOVED_PROJECTS = 'Removed projects';

/** A session's row in the sidebar; drag: the siblings it can be dragged among, null when it stays put (issue #88). */
export type Row = { s: SessionInfo; depth: number; drag: string | null };

export interface SidebarGroup {
  name: string;
  project: ProjectInfo | null;
  rows: Row[];
  /** Its archived sessions, for "Archived (N)". */
  archived: number;
}

/**
 * The sidebar's groups: Chats, each project, then "Removed projects"; in each the manager with the sessions it runs,
 * then the sessions started outside it. Archived sessions leave the rows and are counted. Built from one pass over the
 * list (issue #233); the order within a level is the dragged one (issue #88). known: the projects' names.
 * olderArchived: archived sessions hello only counted, by project (issue #229), added to each group's count.
 */
export function sidebarTree(sessions: readonly SessionInfo[], projects: readonly ProjectInfo[], known: ReadonlySet<string>, olderArchived: Readonly<Record<string, number>> = {}): { shown: SessionIndex; groups: SidebarGroup[] } {
  const groupOfProject = (project: string) => (project === CHATS || known.has(project) ? project : REMOVED_PROJECTS);
  const groupOf = (s: SessionInfo) => groupOfProject(s.project);
  const live = sessions.filter((s) => !s.archivedAt);
  const byGroup = groupBy(live, groupOf);
  const archivedIn = groupBy(sessions.filter((s) => s.archivedAt), groupOf);
  const countedIn = new Map<string, number>();
  for (const [project, n] of Object.entries(olderArchived)) countedIn.set(groupOfProject(project), (countedIn.get(groupOfProject(project)) ?? 0) + n);
  const shown = indexSessions(live);
  // drag: the siblings a row can be dragged among (sidebarDrag.ts); null for the manager, which stays first,
  // and in "Removed projects", whose rows belong to no one project.
  const withChildren = (s: SessionInfo, drag: string | null, movable: boolean): Row[] =>
    [{ s, depth: 0, drag }, ...[...shown.childrenOf(s.id)].sort(siblingOrder).map((c) => ({ s: c, depth: 1, drag: movable ? `c:${s.id}` : null }))];
  const rowsFor = (group: string, managerId: string | null, project: string | null): Row[] => {
    const members = byGroup.get(group) ?? [];
    const ids = new Set(members.map((s) => s.id));
    const manager = managerId ? shown.byId.get(managerId) : undefined;
    const top = members.filter((s) => s.id !== managerId && (!s.parentId || !ids.has(s.parentId))).sort(siblingOrder);
    return [...(manager ? withChildren(manager, null, !!project) : []), ...top.flatMap((s) => withChildren(s, project ? `t:${project}` : null, !!project))];
  };
  // Chats first (issue #211), a group of their own apart from every project, always shown for its New chat.
  const groups = [
    { name: CHATS, project: null as ProjectInfo | null, rows: rowsFor(CHATS, null, CHATS) },
    ...projects.map((p) => ({ name: p.name, project: p as ProjectInfo | null, rows: rowsFor(p.name, p.managerId, p.name) })),
    { name: REMOVED_PROJECTS, project: null, rows: rowsFor(REMOVED_PROJECTS, null, null) },
  ].map((g) => ({ ...g, archived: (archivedIn.get(g.name)?.length ?? 0) + (countedIn.get(g.name) ?? 0) }))
    .filter((g) => g.project || g.name === CHATS || g.rows.length || g.archived);
  return { shown, groups };
}

/**
 * Usage → Sessions' rows (issue #235): each top-level session that runs, or that started one that runs, managers
 * first and then newest first, each followed by the running sessions it started in the same order; ended sessions are
 * left out. Built from the index, not a scan of the list per row. index: for the rows' own lookups.
 */
export function usageRows(sessions: readonly SessionInfo[]): { index: SessionIndex; rows: SessionInfo[] } {
  const index = indexSessions(sessions);
  const live = (s: SessionInfo) => s.status !== 'ended';
  const order = (a: SessionInfo, b: SessionInfo) => Number(b.role === 'manager') - Number(a.role === 'manager') || b.createdAt - a.createdAt;
  const top = sessions.filter((s) => (!s.parentId || !index.byId.has(s.parentId)) && (live(s) || index.childrenOf(s.id).some(live)));
  const rows = top.sort(order).flatMap((s) => [s, ...index.childrenOf(s.id).filter(live).sort(order)]);
  return { index, rows };
}
