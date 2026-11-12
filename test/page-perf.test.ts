// The page's own rendering costs (issue #233): the sidebar's tree from one pass, one shared clock, polls that rest
// while the page is hidden, and the conversation drawn from its end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CHATS, type ProjectInfo, type SessionInfo } from '../src/shared/protocol.ts';
import { indexSessions, REMOVED_PROJECTS, sidebarTree } from '../web/src/sessionTree.ts';
import { shipMode } from '../web/src/components/shipMode.ts';
import { onTick, runningClocks } from '../web/src/clock.ts';
import { pollWhileShown, type Page } from '../web/src/pollShown.ts';
import { NEAR_TOP, STEP, TAIL, stepUp, tailStart, windowStart } from '../web/src/messageWindow.ts';

/** A session with what the tree and the ship read; createdAt orders undragged siblings newest first. */
function s(id: string, project: string, more: Partial<SessionInfo> = {}): SessionInfo {
  return { id, project, title: id, parentId: null, status: 'idle', role: 'worker', archivedAt: null, position: null, createdAt: 0, backgroundTasks: 0, paused: false, clearDue: null, clearedAt: null, ...more } as unknown as SessionInfo;
}
const project = (name: string, managerId: string | null) => ({ name, managerId }) as unknown as ProjectInfo;

test('the index finds each session by id and the sessions each one started, in list order', () => {
  const list = [s('m', 'a', { role: 'manager' }), s('w1', 'a', { parentId: 'm' }), s('x', 'b'), s('w2', 'a', { parentId: 'm' })];
  const index = indexSessions(list);
  assert.equal(index.byId.get('x')?.id, 'x');
  assert.equal(index.byId.get('nope'), undefined);
  assert.deepEqual(index.childrenOf('m').map((c) => c.id), ['w1', 'w2']);
  assert.deepEqual(index.childrenOf('x'), []);
});

test('the sidebar tree: chats first, each project with its manager and its sessions, removed projects last, archived counted', () => {
  const list = [
    s('m', 'a', { role: 'manager', createdAt: 1 }),
    s('w-old', 'a', { parentId: 'm', createdAt: 2 }),
    s('w-new', 'a', { parentId: 'm', createdAt: 3 }),
    s('own', 'a', { createdAt: 4 }),
    s('own-child', 'a', { parentId: 'own', createdAt: 5 }),
    s('gone', 'a', { createdAt: 6, archivedAt: 9 }),
    s('chat', CHATS, { createdAt: 7 }),
    s('orphan', 'removed-one', { createdAt: 8 }),
    s('orphan-old', 'removed-two', { archivedAt: 9 }),
  ];
  const projects = [project('a', 'm'), project('empty', null)];
  const { groups, shown } = sidebarTree(list, projects, new Set(['a', 'empty']));
  assert.deepEqual(groups.map((g) => [g.name, g.rows.map((r) => `${r.s.id}:${r.depth}:${r.drag}`), g.archived]), [
    [CHATS, ['chat:0:t:' + CHATS], 0],
    // The manager stays first; its sessions and a top-level session's own, newest first, one step in.
    ['a', ['m:0:null', 'w-new:1:c:m', 'w-old:1:c:m', 'own:0:t:a', 'own-child:1:c:own'], 1],
    ['empty', [], 0],
    [REMOVED_PROJECTS, ['orphan:0:null'], 1],
  ]);
  // Archived sessions leave the rows, and the lookup the menu and the folds use.
  assert.equal(shown.byId.has('gone'), false);
  assert.equal(shown.byId.has('own'), true);
});

test('a group with nothing in it is left out unless it is a project or Chats', () => {
  const { groups } = sidebarTree([], [], new Set());
  assert.deepEqual(groups.map((g) => g.name), [CHATS]);
});

test("a manager's ship sails with one boat per working session it started, given only its own sessions", () => {
  const manager = s('m', 'a', { role: 'manager', status: 'running' });
  const children = [s('w1', 'a', { parentId: 'm', status: 'running' }), s('w2', 'a', { parentId: 'm', status: 'running' }), s('w3', 'a', { parentId: 'm', status: 'idle' })];
  assert.deepEqual(shipMode(manager, children), { kind: 'working', followers: 2, clearedAt: null });
  // Stopped with sessions still open: the fleet gathers beside it; with all ended, none.
  const idle = { ...manager, status: 'idle' } as SessionInfo;
  assert.deepEqual(shipMode(idle, [children[2]!]), { kind: 'stopped', behind: 'fleet', clearedAt: null });
  assert.deepEqual(shipMode(idle, [{ ...children[2]!, status: 'ended' } as SessionInfo]), { kind: 'stopped', behind: 'none', clearedAt: null });
});

test('everything that ticks at one period shares one timer, which stops with its last listener', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  assert.equal(runningClocks(), 0);
  let a = 0, b = 0, c = 0;
  const stopA = onTick(180, () => a++);
  const stopB = onTick(180, () => b++);
  const stopC = onTick(1000, () => c++);
  assert.equal(runningClocks(), 2);
  t.mock.timers.tick(360);
  assert.deepEqual([a, b, c], [2, 2, 0]);
  stopA();
  t.mock.timers.tick(1000);
  assert.deepEqual([a, b, c], [2, 7, 1]);
  stopB();
  stopC();
  assert.equal(runningClocks(), 0);
  // The same function twice is two listeners, each stopped on its own.
  const fn = () => a++;
  const one = onTick(500, fn);
  const two = onTick(500, fn);
  t.mock.timers.tick(500);
  assert.equal(a, 4);
  one();
  t.mock.timers.tick(500);
  assert.equal(a, 5);
  two();
  assert.equal(runningClocks(), 0);
});

/** A page whose visibility the test sets; shown() fires the change. */
function fakePage(): Page & { set(state: string): void } {
  const fns = new Set<() => void>();
  const page = {
    visibilityState: 'visible',
    addEventListener: (_: 'visibilitychange', fn: () => void) => fns.add(fn),
    removeEventListener: (_: 'visibilitychange', fn: () => void) => fns.delete(fn),
    set(state: string) {
      page.visibilityState = state;
      for (const fn of fns) fn();
    },
  };
  return page;
}

test('a poll loads at once and on its period while shown, not while hidden, and once on coming back when due', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const page = fakePage();
  let loads = 0;
  const stop = pollWhileShown(() => loads++, 15000, page);
  assert.equal(loads, 1);
  t.mock.timers.tick(15000);
  assert.equal(loads, 2);
  // Hidden: four periods pass with no load.
  page.set('hidden');
  t.mock.timers.tick(60000);
  assert.equal(loads, 2);
  // Shown again with its period long past: one load at once.
  page.set('visible');
  assert.equal(loads, 3);
  // Hidden and shown again within the period: nothing extra.
  page.set('hidden');
  page.set('visible');
  assert.equal(loads, 3);
  stop();
  t.mock.timers.tick(60000);
  page.set('hidden');
  page.set('visible');
  assert.equal(loads, 3);
});

test('shown again between two rounds, the next round does not load a second time a moment later (review of #237)', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const page = fakePage();
  let loads = 0;
  const stop = pollWhileShown(() => loads++, 15000, page);
  assert.equal(loads, 1);
  // Hidden at once; shown again at 74 s, a second before the 75 s round: one load on being shown.
  page.set('hidden');
  t.mock.timers.tick(74000);
  assert.equal(loads, 1);
  page.set('visible');
  assert.equal(loads, 2);
  // The 75 s round, a second after that load: none.
  t.mock.timers.tick(1000);
  assert.equal(loads, 2);
  // The 90 s round, 16 s after it: the regular load.
  t.mock.timers.tick(15000);
  assert.equal(loads, 3);
  stop();
});

test('a long conversation is drawn from its end, a batch further up at a time, always with the message it was opened at', () => {
  // 5000 items: the last TAIL are drawn; a short one is drawn whole.
  assert.equal(tailStart(5000), 5000 - TAIL);
  assert.equal(tailStart(40), 0);
  assert.equal(stepUp(5000 - TAIL), 5000 - TAIL - STEP);
  assert.equal(stepUp(50), 0);
  // Nothing to keep on screen: as it is.
  assert.equal(windowStart(4700, 5000, -1), 4700);
  // A question at 1000: drawn from a little above it.
  assert.equal(windowStart(4700, 5000, 1000), 980);
  // Already drawn further up than that: unchanged.
  assert.equal(windowStart(500, 5000, 1000), 500);
  // A start past the end (the list got shorter) comes back inside it.
  assert.equal(windowStart(9000, 5000, -1), 4999);
  assert.equal(windowStart(0, 0, -1), 0);
  assert.ok(NEAR_TOP > 0);
});

// The class (issue #233): a component that ticks or polls on a timer of its own. Each mounted copy ran one, so a
// list of them ran as many. Ticking goes through the shared clock, polling through pollWhileShown; the timers left
// are each in a page shown once, listed here with why.
const OWN_TIMERS = new Set([
  'web/src/clock.ts', // the shared clock itself
  'web/src/pollShown.ts', // the poll that rests while the page is hidden
  'web/src/components/DevicesSettings.tsx', // Settings → Devices, one at a time
  'web/src/components/FlowRuns.tsx', // the workflow page's run list, one per page
  'web/src/components/LinkedSettings.tsx', // Settings, one at a time
  'web/src/components/SettingsFrame.tsx', // Settings' update status, one at a time
  'web/src/components/UsagePublishSettings.tsx', // Settings, one at a time
  'web/src/components/UsageStopsSettings.tsx', // Settings → usage stops, one at a time
  'web/src/usage/SharedView.tsx', // Usage → Shared, one at a time
]);

function timerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...timerFiles(p));
    else if (/\.tsx?$/.test(e.name) && /\bsetInterval\(/.test(fs.readFileSync(p, 'utf8'))) out.push(p.split(path.sep).join('/'));
  }
  return out;
}

test('no part of the page runs a timer of its own outside the shared clock, the hidden-page poll and the listed pages', () => {
  const found = timerFiles('web/src');
  // The probe finds what is there: the clock's own timer.
  assert.ok(found.includes('web/src/clock.ts'), `the scan found ${found.join(', ') || 'nothing'}`);
  assert.deepEqual(found.filter((f) => !OWN_TIMERS.has(f)), []);
});
