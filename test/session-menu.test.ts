// A session's ⚙ menu (issue #81): what moves into it, what stays in the header, Ctrl+O and Escape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canInterrupt, escapeClosesMenu, isToolCallsKey, sessionControls } from '../web/src/sessionMenu.ts';
import type { SessionInfo } from '../src/shared/protocol.ts';

type Shown = Parameters<typeof sessionControls>[0];
const s = (over: Partial<Shown> = {}): Shown => ({ role: 'session', status: 'idle', clearDue: null, compacting: null, claudeSessionId: 'c1', claudeVersion: null, ...over });
const STATUSES: SessionInfo['status'][] = ['starting', 'idle', 'queued', 'running', 'waiting', 'stopping', 'ended'];

test('the menu holds away (managers), permissions, priority (sessions), tool calls, usage, pause and stop (Done 2)', () => {
  assert.deepEqual(sessionControls(s({ role: 'manager' })).menu, ['away', 'permissions', 'toolCalls', 'usage', 'pause', 'stop']);
  assert.deepEqual(sessionControls(s({ role: 'session' })).menu, ['permissions', 'priority', 'toolCalls', 'usage', 'pause', 'stop']);
});

test('the Claude Code version is read-only info at the end of the menu, once known (Martin 15:24, on #81)', () => {
  for (const role of ['manager', 'session'] as const) {
    for (const status of STATUSES) {
      const menu = sessionControls(s({ role, status, claudeVersion: '2.1.295' })).menu;
      assert.equal(menu.at(-1), 'version', `${role} ${status}`);
    }
  }
  assert.ok(!sessionControls(s({ claudeVersion: null })).menu.includes('version'));
});

test('pause and stop are offered exactly where the header offered them before: not stopping, not ended', () => {
  for (const status of STATUSES) {
    const menu = sessionControls(s({ status })).menu;
    const live = status !== 'ended' && status !== 'stopping';
    assert.equal(menu.includes('pause'), live, status);
    assert.equal(menu.includes('stop'), live, status);
    // Permissions, tool calls and usage are always there (disabled where they were before).
    for (const c of ['permissions', 'toolCalls', 'usage'] as const) assert.ok(menu.includes(c), `${c} ${status}`);
  }
});

test('Start now while queued stays in the header (Done 3); Interrupt is no longer there in any state (#89)', () => {
  for (const status of STATUSES) {
    const header: string[] = sessionControls(s({ status, clearDue: 5, compacting: { requester: 'x', startedAt: 0, note: null } })).header;
    assert.ok(!header.includes('interrupt'), status);
    assert.equal(header.includes('startNow'), status === 'queued', status);
  }
});

test('the stop sign above Send can be pressed exactly while running or waiting, greyed out otherwise (#89)', () => {
  for (const status of STATUSES) assert.equal(canInterrupt({ status }), status === 'running' || status === 'waiting', status);
});

test('the clear countdown and the compacting notice stay in the header, except on an ended session', () => {
  const compacting = { requester: 'x', startedAt: 0, note: null };
  assert.deepEqual(sessionControls(s({ status: 'running', clearDue: 5, compacting })).header, ['clear', 'compacting']);
  assert.deepEqual(sessionControls(s({ status: 'idle', clearDue: 0 })).header, ['clear']);
  assert.deepEqual(sessionControls(s({ status: 'ended', clearDue: 5, compacting })).header, ['resume', 'archive']);
});

test('an ended session keeps Resume (when it can be resumed) and Archive (sessions only) in the header', () => {
  assert.deepEqual(sessionControls(s({ status: 'ended' })).header, ['resume', 'archive']);
  assert.deepEqual(sessionControls(s({ status: 'ended', claudeSessionId: null })).header, ['archive']);
  assert.deepEqual(sessionControls(s({ status: 'ended', role: 'manager' })).header, ['resume']);
  assert.deepEqual(sessionControls(s({ status: 'idle' })).header, []);
});

const key = (over: Partial<Parameters<typeof isToolCallsKey>[0]> = {}) =>
  ({ key: 'o', code: 'KeyO', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...over });

test('Ctrl+O toggles tool calls; ⌘O, Ctrl+Shift+O, Alt and plain O do not (Done 5)', () => {
  assert.equal(isToolCallsKey(key()), true);
  assert.equal(isToolCallsKey(key({ key: 'O' })), true, 'Caps Lock on');
  assert.equal(isToolCallsKey(key({ key: 'щ' })), true, 'a non-Latin layout: the physical O key');
  // Dvorak puts R on the O key, Colemak Y: their Ctrl+R and Ctrl+Y stay theirs; their O is elsewhere (review of PR #84).
  assert.equal(isToolCallsKey(key({ key: 'r' })), false, 'Dvorak Ctrl+R');
  assert.equal(isToolCallsKey(key({ key: 'y' })), false, 'Colemak Ctrl+Y');
  assert.equal(isToolCallsKey(key({ key: 'o', code: 'KeyS' })), true, 'Dvorak O sits on the S key');
  assert.equal(isToolCallsKey(key({ key: 'o', code: 'Semicolon' })), true, 'Colemak O sits on the ; key');
  assert.equal(isToolCallsKey(key({ ctrlKey: false })), false);
  assert.equal(isToolCallsKey(key({ ctrlKey: false, metaKey: true })), false, '⌘O stays the browser\'s');
  assert.equal(isToolCallsKey(key({ metaKey: true })), false);
  assert.equal(isToolCallsKey(key({ shiftKey: true })), false);
  assert.equal(isToolCallsKey(key({ altKey: true })), false);
  assert.equal(isToolCallsKey(key({ isComposing: true })), false);
  assert.equal(isToolCallsKey(key({ key: 'p', code: 'KeyP' })), false);
});

test('Escape closes the menu unless already marked used (Done 6, and #78\'s Settings Escape)', () => {
  assert.equal(escapeClosesMenu({ key: 'Escape', defaultPrevented: false, isComposing: false }), true);
  assert.equal(escapeClosesMenu({ key: 'Escape', defaultPrevented: true, isComposing: false }), false);
  assert.equal(escapeClosesMenu({ key: 'Escape', defaultPrevented: false, isComposing: true }), false);
  assert.equal(escapeClosesMenu({ key: 'Enter', defaultPrevented: false, isComposing: false }), false);
});
