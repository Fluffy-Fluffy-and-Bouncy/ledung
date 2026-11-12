// The sidebar's right-click menu (Simon, 2026-11-06): only what makes sense for the row, keys that open and move
// through it, and a place on the screen that keeps all of it in view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupActions, menuPlace, modelChoices, moveFocus, opensMenu, sessionActions, subMenuPlace } from '../web/src/sidebarMenu.ts';

const base = { role: 'session' as const, status: 'idle' as const, paused: false, claudeSessionId: 'c1', archivedAt: null, compacting: null, clearDue: null };

test('a running session: rename, model, priority, pause and stop, compact and clear, copy, stop and archive', () => {
  assert.deepEqual(sessionActions(base, false),
    ['rename', 'model', 'priority', 'pause', 'stop', 'compact', 'clear', 'copyId', 'stopArchive']);
  assert.ok(sessionActions({ ...base, paused: true }, false).includes('unpause'), 'a paused one offers Unpause instead');
  assert.ok(!sessionActions({ ...base, paused: true }, false).includes('pause'));
});

test('an ended session: archived directly, resumed, its model for the resume; nothing that needs it running', () => {
  assert.deepEqual(sessionActions({ ...base, status: 'ended' }, true), ['rename', 'model', 'resume', 'copyId', 'archive']);
  // One that never talked can't be resumed, so no model for a resume either.
  assert.deepEqual(sessionActions({ ...base, status: 'ended', claudeSessionId: null }, false), ['rename', 'copyId', 'archive']);
  assert.ok(!sessionActions({ ...base, status: 'ended', archivedAt: 1 }, false).includes('archive'), 'an archived one is not archived again');
});

test('a manager: the same minus Archive and Priority, plus its workflow when the project has one', () => {
  const manager = { ...base, role: 'manager' as const };
  assert.deepEqual(sessionActions(manager, true), ['rename', 'workflow', 'model', 'pause', 'stop', 'compact', 'clear', 'copyId']);
  assert.ok(!sessionActions(manager, false).includes('workflow'));
  assert.ok(!sessionActions({ ...manager, status: 'ended' }, false).includes('archive'));
});

test('a session still starting is not offered Stop and archive: a stop then may leave it unended', () => {
  assert.ok(!sessionActions({ ...base, status: 'starting' }, false).includes('stopArchive'));
  assert.ok(sessionActions({ ...base, status: 'starting' }, false).includes('model'), 'its model still changes, for its start');
});

test('a stopping session offers neither model nor stop; compact and clear wait for one already under way', () => {
  assert.deepEqual(sessionActions({ ...base, status: 'stopping' }, false), ['rename', 'priority', 'copyId']);
  assert.ok(!sessionActions({ ...base, clearDue: Date.now() }, false).includes('clear'));
  assert.ok(!sessionActions({ ...base, compacting: { requester: 'x' } as never }, false).includes('compact'));
  assert.ok(!sessionActions({ ...base, claudeSessionId: null }, false).includes('compact'), 'nothing to compact before its first message');
});

test("a project's heading: new session, settings, workflow if any, collapse all; no model (it stays in Settings)", () => {
  assert.deepEqual(groupActions('project', true, false), ['newSession', 'settings', 'workflow', 'newProject', 'collapseAll']);
  assert.deepEqual(groupActions('project', false, false), ['newSession', 'settings', 'newProject', 'collapseAll']);
  assert.deepEqual(groupActions('chats', false, false), ['newChat', 'settings', 'collapseAll']);
  assert.deepEqual(groupActions('removed', false, true), ['expandAll'], 'everything folded: Expand all');
});

test('a project heading offers Account only with more than one account to pick (Simon, 2026-11-08)', () => {
  assert.deepEqual(groupActions('project', false, false, 3), ['newSession', 'account', 'settings', 'newProject', 'collapseAll']);
  assert.ok(!groupActions('project', false, false, 1).includes('account'), "only this computer's own login: nothing to pick");
  assert.ok(!groupActions('chats', false, false, 3).includes('account'));
});

test('a submenu opens to the right of its row, to the left at the screen edge, and moves up to stay on screen', () => {
  const item = { left: 100, right: 300, top: 200 };
  assert.deepEqual(subMenuPlace(item, 180, 150, 1280, 800), { left: 300, top: 200 });
  assert.deepEqual(subMenuPlace({ left: 1000, right: 1200, top: 200 }, 180, 150, 1280, 800), { left: 820, top: 200 });
  assert.deepEqual(subMenuPlace({ left: 100, right: 300, top: 750 }, 180, 150, 1280, 800), { left: 300, top: 646 });
});

test("the models: the project's default first, then opus, sonnet, haiku; a full name it started with is listed too", () => {
  assert.deepEqual(modelChoices(null).map((m) => m.model), [null, 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(modelChoices('sonnet').map((m) => m.model), [null, 'opus', 'sonnet', 'haiku']);
  assert.deepEqual(modelChoices('claude-opus-4-1').at(-1), { model: 'claude-opus-4-1', label: 'claude-opus-4-1' });
});

test('the menu key and Shift+F10 open it; F10 alone, or with Ctrl, does not', () => {
  const k = (key: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}) =>
    ({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods });
  assert.equal(opensMenu(k('ContextMenu')), true);
  assert.equal(opensMenu(k('F10', { shiftKey: true })), true);
  assert.equal(opensMenu(k('F10')), false);
  assert.equal(opensMenu(k('F10', { shiftKey: true, ctrlKey: true })), false);
});

test('the arrow keys wrap round, Home and End go to the ends, other keys move nothing', () => {
  assert.equal(moveFocus('ArrowDown', 2, 3), 0);
  assert.equal(moveFocus('ArrowUp', 0, 3), 2);
  assert.equal(moveFocus('ArrowDown', -1, 3), 0, 'from outside the items: the first');
  assert.equal(moveFocus('End', 0, 3), 2);
  assert.equal(moveFocus('Home', 2, 3), 0);
  assert.equal(moveFocus('a', 1, 3), null);
  assert.equal(moveFocus('ArrowDown', 0, 0), null);
});

test('the menu stays on the screen: moved left at the right edge, opened upwards near the bottom', () => {
  assert.deepEqual(menuPlace(100, 100, 200, 300, 1280, 800), { left: 100, top: 100 });
  assert.deepEqual(menuPlace(1200, 100, 200, 300, 1280, 800), { left: 1076, top: 100 });
  assert.deepEqual(menuPlace(100, 700, 200, 300, 1280, 800), { left: 100, top: 400 });
  // Too tall for either side of the point (a phone): as low as it fits.
  assert.deepEqual(menuPlace(10, 300, 200, 500, 390, 600), { left: 10, top: 96 });
});
