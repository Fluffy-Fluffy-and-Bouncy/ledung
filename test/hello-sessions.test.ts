// What hello carries of the sessions, and how the page keeps its Archived (N) counts right (issue #229, audit O8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchesArchived, helloSessions, RECENT_ARCHIVED_MS, withArchived, withSession, type KnownSessions } from '../src/shared/hello-sessions.ts';
import type { ProjectInfo, SessionInfo } from '../src/shared/protocol.ts';
import { REMOVED_PROJECTS, sidebarTree } from '../web/src/sessionTree.ts';

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** Only the fields the selection reads; the rest of a session doesn't matter to it. */
function s(id: string, opts: { project?: string; archivedAt?: number | null; parentId?: string | null; createdAt?: number } = {}): SessionInfo {
  return { id, project: opts.project ?? 'p', archivedAt: opts.archivedAt ?? null, parentId: opts.parentId ?? null, createdAt: opts.createdAt ?? NOW - 30 * DAY } as SessionInfo;
}

const ids = (list: SessionInfo[]) => list.map((x) => x.id);

/** A sidebar group's Archived (N), as the sidebar builds it from what the page knows; projects p and q exist. */
function archivedIn(known: KnownSessions, group = 'p'): number {
  const projects = ['p', 'q'].map((name) => ({ name, managerId: null }) as unknown as ProjectInfo);
  const tree = sidebarTree(known.sessions, projects, new Set(['p', 'q']), known.olderArchived);
  return tree.groups.find((g) => g.name === group)?.archived ?? 0;
}

test('hello keeps sessions not archived and those archived within the window; older archived ones are counted by project', () => {
  const all = [
    s('live'),
    s('just-archived', { archivedAt: NOW - 60_000 }),
    s('edge', { archivedAt: NOW - RECENT_ARCHIVED_MS }),
    s('old', { archivedAt: NOW - 3 * DAY }),
    s('old-q', { project: 'q', archivedAt: NOW - 10 * DAY }),
    s('old-q2', { project: 'q', archivedAt: NOW - RECENT_ARCHIVED_MS - 1 }),
  ];
  const { sessions, olderArchived } = helloSessions(all, [], NOW);
  // Kept in the order given (newest first from the store), which the page relies on.
  assert.deepEqual(ids(sessions), ['live', 'just-archived', 'edge']);
  assert.deepEqual(olderArchived, { p: 1, q: 2 });
});

test('an old archived session that a question or prompt names is kept, and so is the manager above it', () => {
  const all = [
    s('worker', { archivedAt: NOW - 5 * DAY, parentId: 'mgr' }),
    s('mgr', { archivedAt: NOW - 6 * DAY, parentId: 'top' }),
    s('top', { archivedAt: NOW - 7 * DAY }),
    s('other', { archivedAt: NOW - 5 * DAY }),
  ];
  const { sessions, olderArchived } = helloSessions(all, ['worker', 'user', 'no-such-id', ''], NOW);
  assert.deepEqual(ids(sessions), ['worker', 'mgr', 'top']);
  assert.deepEqual(olderArchived, { p: 1 }, 'only the one nothing names is counted');
});

test('a live session under an old archived manager brings that manager along', () => {
  const { sessions, olderArchived } = helloSessions([s('child', { parentId: 'gone-mgr' }), s('gone-mgr', { archivedAt: NOW - 9 * DAY })], [], NOW);
  assert.deepEqual(ids(sessions), ['child', 'gone-mgr']);
  assert.deepEqual(olderArchived, {});
});

test('a parent loop in the data does not hang the selection', () => {
  const { sessions } = helloSessions([s('a', { parentId: 'b' }), s('b', { parentId: 'a', archivedAt: NOW - 9 * DAY })], [], NOW);
  assert.deepEqual(ids(sessions), ['a', 'b']);
});

test("a group's Archived count adds what the page has and what hello only counted", () => {
  const list = [s('x'), s('a1', { archivedAt: NOW - 1000 }), s('a2', { project: 'q', archivedAt: NOW - 1000 })];
  const older = { p: 4, q: 2, gone: 3 };
  assert.equal(archivedIn({ sessions: list, olderArchived: older }, 'p'), 5);
  assert.equal(archivedIn({ sessions: list, olderArchived: older }, 'q'), 3);
  // A group of several projects, as "Removed projects" is: every project not known, shown for its count alone.
  assert.equal(archivedIn({ sessions: list, olderArchived: older }, REMOVED_PROJECTS), 3);
  assert.equal(archivedIn({ sessions: list, olderArchived: {} }, 'p'), 1);
});

test('the counts before and after fetching the archived list are the same, and the old total is what hello left out', () => {
  const all = [s('live'), s('recent', { archivedAt: NOW - 1000 }), ...Array.from({ length: 5 }, (_, i) => s(`old${i}`, { archivedAt: NOW - (2 + i) * DAY }))];
  const hello = helloSessions(all, [], NOW);
  assert.equal(archivedIn(hello), 6);
  const fetched = withArchived(hello, all.filter((x) => x.archivedAt));
  assert.equal(fetched.sessions.length, all.length, 'every session, none twice');
  assert.deepEqual(fetched.olderArchived, {});
  assert.equal(archivedIn(fetched), 6);
});

test('fetching the archived list keeps the newer copy the page already has', () => {
  const mine = { ...s('recent', { archivedAt: NOW - 1000 }), title: 'newer' } as SessionInfo;
  const stale = { ...s('recent', { archivedAt: NOW - 1000 }), title: 'older' } as SessionInfo;
  const out = withArchived({ sessions: [mine], olderArchived: { p: 1 } }, [stale, s('old', { archivedAt: NOW - 3 * DAY })]);
  assert.deepEqual(out.sessions.map((x) => x.title), ['newer', undefined]);
  assert.deepEqual(ids(out.sessions), ['recent', 'old']);
});

test('a change to a session the page has replaces it; a new session is added and counts nothing down', () => {
  const known = { sessions: [s('a')], olderArchived: { p: 2 } };
  const changed = withSession(known, { ...s('a'), title: 'renamed' } as SessionInfo, NOW);
  assert.equal(changed.sessions.length, 1);
  assert.equal(changed.sessions[0]!.title, 'renamed');
  assert.deepEqual(changed.olderArchived, { p: 2 });
  const fresh = withSession(known, s('new', { createdAt: NOW + 5000 }), NOW);
  assert.deepEqual(ids(fresh.sessions), ['new', 'a']);
  assert.deepEqual(fresh.olderArchived, { p: 2 });
});

test('a session hello only counted, resumed or unarchived, moves from the count into the list', () => {
  const all = [s('a'), s('old', { archivedAt: NOW - 3 * DAY, createdAt: NOW - 4 * DAY })];
  const hello = helloSessions(all, [], NOW);
  assert.deepEqual(hello.olderArchived, { p: 1 });
  const back = withSession(hello, s('old', { archivedAt: null, createdAt: NOW - 4 * DAY }), NOW);
  assert.deepEqual(ids(back.sessions), ['old', 'a']);
  assert.deepEqual(back.olderArchived, { p: 0 });
  assert.equal(archivedIn(back), 0, 'counted once, not twice');
  // Still archived but changed (its pull request, say): in the list now, so out of the count too.
  const changed = withSession(hello, s('old', { archivedAt: NOW - 3 * DAY, createdAt: NOW - 4 * DAY }), NOW);
  assert.equal(archivedIn(changed), 1);
});

test("a session made just before hello, on a clock up to half the window off, is new, not a counted one", () => {
  const known = { sessions: [], olderArchived: { p: 1 } };
  assert.deepEqual(withSession(known, s('n', { createdAt: NOW - RECENT_ARCHIVED_MS / 2 + 1 }), NOW).olderArchived, { p: 1 });
  assert.deepEqual(withSession(known, s('n', { createdAt: NOW - RECENT_ARCHIVED_MS }), NOW).olderArchived, { p: 0 });
  // Its project has none counted: nothing to move, whatever its age.
  assert.deepEqual(withSession(known, s('n', { project: 'q', createdAt: NOW - 9 * DAY }), NOW).olderArchived, { p: 1 });
});

test('the page fetches every archived session when an Archived list opens, while hello has left some out', () => {
  const older = { p: 3 };
  const at = (openId: string | null, more: { loaded?: boolean; unknownSession?: boolean; olderArchived?: Record<string, number> } = {}) =>
    fetchesArchived({ openId, loaded: more.loaded ?? true, unknownSession: more.unknownSession ?? false, olderArchived: more.olderArchived ?? older });
  assert.equal(at('a:p'), true, "a project's Archived list");
  assert.equal(at('a:Removed projects'), true, 'the removed projects\' list');
  assert.equal(at('a:p', { loaded: false }), true, 'opened by its link before hello');
  // Nothing left out: the page has them all already.
  assert.equal(at('a:p', { olderArchived: {} }), false);
  // Other views never fetch.
  for (const view of [null, 'waiting', 'usage', 'p:demo', 'ps:demo', 'q:12']) assert.equal(at(view), false, String(view));
  // A session's link: only one the page lacks, and only once hello has come.
  assert.equal(at('arch-400', { unknownSession: true }), true);
  assert.equal(at('arch-400', { unknownSession: true, loaded: false }), false);
  assert.equal(at('live-1', { unknownSession: false }), false);
  assert.equal(at('arch-400', { unknownSession: true, olderArchived: {} }), false);
});
