// Settings in one place (issue #365, mockup F, Martin 2026-10-28 in Ledung question #325): which group an address
// opens, which tab a view belongs to, and when a feature in Remote & devices takes one line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FIRST_GROUP, LEDUNG_GROUPS, bannerView, groupOf, groupView, remoteFeatures, remoteWord, settingsTabs, tabOf, updateTexts, updateWord } from '../web/src/settingsGroups.ts';
import { isSettingsView, leaveSettings, stepsInto, type SettingsSteps } from '../web/src/settingsNav.ts';
import type { RemoteStatus, UpdateView } from '../src/shared/protocol.ts';

test('the Ledung tab has the side menu of f-mix.png, in its order', () => {
  assert.deepEqual(LEDUNG_GROUPS.map((g) => g.label), [
    // Macros after Sessions: issue #410, as mocked and passed by Martin in Ledung question #425.
    'Update & restart', 'Claude & usage', 'Sessions', 'Macros', 'Remote & devices', 'Look & feel', 'Notifications', 'Config file', 'About',
  ]);
  assert.deepEqual(LEDUNG_GROUPS.filter((g) => g.part === 'browser').map((g) => g.id), ['look', 'notifications']);
});

test('every setting of the old Settings page has a group (Done: every setting reachable)', () => {
  const labels = LEDUNG_GROUPS.flatMap((g) => g.settings.map((s) => s.label));
  // The old page's headings (mockups/SURVEY.md), less Chats and Add project, which are tabs now.
  for (const old of ['Accounts', 'Claude Code', 'Message board', 'Remote access', 'Phones', 'Linked computers', 'Relay', 'Computers',
    'Usage stops', 'Session profiles', 'Skills', 'App', 'Appearance', 'Autocorrect', 'Status dot', 'Show "Archived" in the sidebar',
    'Compact sidebar', 'Notifications', 'Config file', 'Restart Ledung', 'Update Ledung', 'About']) {
    assert.ok(labels.includes(old), old);
  }
  assert.deepEqual(settingsTabs([]).map((t) => t.view), ['settings', 'chats', 'add']);
});

test('settings kept in this browser are the Look & feel and Notifications ones; profiles and the config file are the config', () => {
  const browser = LEDUNG_GROUPS.flatMap((g) => g.settings.filter((s) => s.storedIn === 'browser').map(() => g.id));
  assert.deepEqual([...new Set(browser)], ['look', 'notifications']);
  const config = LEDUNG_GROUPS.flatMap((g) => g.settings.filter((s) => s.storedIn === 'config').map((s) => s.label));
  assert.deepEqual(config, ['Session profiles', 'Config file']);
});

test('the address picks the group; plain Settings opens the first on a wide screen and the list on a phone', () => {
  assert.equal(groupOf('settings:remote', false), 'remote');
  assert.equal(groupOf('settings:remote', true), 'remote');
  assert.equal(groupOf('settings', false), FIRST_GROUP);
  assert.equal(FIRST_GROUP, 'update');
  assert.equal(groupOf('settings', true), null);
  // A bookmark to a group that no longer exists lands where plain Settings would.
  assert.equal(groupOf('settings:nope', false), 'update');
  assert.equal(groupOf('settings:nope', true), null);
  // The old Accounts page is shown inline in Claude & usage.
  assert.equal(groupOf('accounts', false), 'claude');
  assert.equal(groupOf('accounts', true), 'claude');
  for (const g of LEDUNG_GROUPS) assert.equal(groupOf(groupView(g.id), false), g.id);
});

test('each tab: Ledung, Chats, one per project, Add project; a view knows its tab', () => {
  const tabs = settingsTabs([{ name: 'Demo' }, { name: 'Web site' }]);
  assert.deepEqual(tabs.map((t) => t.label), ['Ledung', 'Chats', 'Demo', 'Web site', '+ Add project']);
  assert.deepEqual(tabs.map((t) => t.view), ['settings', 'chats', 'ps:Demo', 'ps:Web site', 'add']);
  assert.equal(tabOf('settings'), 'ledung');
  assert.equal(tabOf('settings:about'), 'ledung');
  assert.equal(tabOf('accounts'), 'ledung');
  assert.equal(tabOf('chats'), 'chats');
  assert.equal(tabOf('ps:Web site'), 'ps:Web site');
  assert.equal(tabOf('add'), 'add');
  for (const outside of [null, 'overview', 'chat', 'p:Demo', 'a:Demo', 'session-1', 'q:4']) assert.equal(tabOf(outside), null, String(outside));
});

test('a group is a step into Settings, so Escape goes back past every group to where Settings was opened (#78)', () => {
  assert.equal(isSettingsView('settings:remote'), true);
  let steps: SettingsSteps = { depth: 0, root: false };
  let from: string | null = 'session-1';
  for (const to of ['settings', 'settings:remote', 'settings:look', 'settings:about']) {
    steps = stepsInto(from, steps, to);
    from = to;
  }
  assert.deepEqual(leaveSettings(steps), { back: 4 });
});

const connected: RemoteStatus = { state: 'connected', publicName: 'name.example.org', error: null };

test('with remote off: Remote access and Relay are one line, Phones and Linked computers need remote access first', () => {
  const f = remoteFeatures({ remote: null, relaySetUp: false, boardConfigured: false });
  assert.deepEqual(f, { remote: 'off', phones: 'needs', linked: 'needs', relay: 'off', board: 'off' });
  assert.equal(remoteWord(null), 'off');
});

test('once remote is on, Remote access, Phones and Linked computers show in full, also while it reconnects', () => {
  for (const remote of [connected, { ...connected, state: 'reconnecting' as const, error: 'refused' }, { ...connected, state: 'connecting' as const }]) {
    const f = remoteFeatures({ remote, relaySetUp: false, boardConfigured: false });
    assert.equal(f.remote, 'on');
    assert.equal(f.phones, 'on');
    assert.equal(f.linked, 'on');
    assert.equal(remoteWord(remote), '');
  }
});

test('a relay admin who has set up sees Relay in full; where its settings are refused it is not shown', () => {
  assert.equal(remoteFeatures({ remote: null, relaySetUp: true, boardConfigured: false }).relay, 'on');
  assert.equal(remoteFeatures({ remote: connected, relaySetUp: null, boardConfigured: false }).relay, 'hidden');
});

test('the Message board is one line until a project names a board', () => {
  assert.equal(remoteFeatures({ remote: null, relaySetUp: false, boardConfigured: false }).board, 'off');
  assert.equal(remoteFeatures({ remote: null, relaySetUp: false, boardConfigured: true }).board, 'on');
});

const view = (over: Partial<UpdateView>): UpdateView => ({
  available: true, canRestart: true, running: null, check: null, checkError: null, checking: false, steps: [], updating: false, refused: null, restarting: false, ...over,
});
const check = (behind: number) => ({ checkedAt: '', latest: 'abc', commitKnown: true, behind, upToDate: behind === 0, changes: [] });

test("the header's update state", () => {
  assert.equal(updateWord(null), '');
  assert.equal(updateWord(view({})), 'not checked');
  assert.equal(updateWord(view({ check: check(0) })), 'up to date');
  assert.equal(updateWord(view({ check: check(1) })), '1 new change');
  assert.equal(updateWord(view({ check: check(3) })), '3 new changes');
  assert.equal(updateWord(view({ check: check(3), checking: true })), 'checking…');
  assert.equal(updateWord(view({ updating: true })), 'updating…');
  assert.equal(updateWord(view({ restarting: true })), 'restarting…');
  assert.equal(updateWord(view({ available: false })), 'no updates here');
  assert.equal(updateWord(view({ available: false, npm: { version: '0.1.0' } })), 'from npm');
});

// The clean install from npm (issue #412): a stranger's page must not send them to git folders and releases they don't
// have, and a banner's Settings button must land where its setting is, not on Update & restart.
test('installed from npm, Update & restart says nothing of git or releases (#412)', () => {
  const npm = updateTexts({ npm: { version: '0.1.1' }, reason: 'Ledung was installed from npm, so updates come from npm.' } as unknown as UpdateView);
  assert.equal(npm.update, null, 'the panel itself says how to update from npm');
  assert.doesNotMatch(npm.restart, /release|git|main/i);
  assert.match(npm.restart, /npm/);
  const unknown = updateTexts(null);
  assert.equal(unknown.update, null, 'while the state loads or after it fails, nothing that may be wrong for npm');
  assert.doesNotMatch(unknown.restart, /release|git|main|npm/i);
  const clone = updateTexts({ available: true } as unknown as UpdateView);
  assert.match(clone.update ?? '', /GitHub/);
  assert.match(clone.restart, /newest release/);
});

test("each banner's Settings opens the group its setting is in (#412)", () => {
  // Usage stops and Claude Code are under Claude & usage, the config file under Config file (the side menu above).
  assert.equal(bannerView('usageStop'), 'settings:claude');
  assert.equal(bannerView('claudeProblem'), 'settings:claude');
  assert.equal(bannerView('configProblem'), 'settings:config');
});

// The places that draw them must use the two helpers above, or the tests above prove nothing (test review of PR #426).
const pageSource = (file: string) => readFileSync(path.join(import.meta.dirname, '..', 'web', 'src', file), 'utf8');

test("the usage stop, Claude Code and config banners' Settings buttons go through bannerView (#412)", () => {
  const app = pageSource('App.tsx');
  const banners = app.slice(app.indexOf('ledung.usageStops.filter((s) => s.holding)'), app.indexOf('ledung.signedOut.map('));
  assert.ok(banners.length > 0, 'the three banners are found in App.tsx');
  for (const banner of ['usageStop', 'claudeProblem', 'configProblem']) assert.match(banners, new RegExp(`onClick=\\{\\(\\) => open\\(bannerView\\('${banner}'\\)\\)\\}>Settings<`));
  assert.doesNotMatch(banners, /open\('settings'\)/, 'no banner opens plain Settings');
});

test('Update & restart draws its words from updateTexts, with no git or release words of its own (#412)', () => {
  const view = pageSource('components/SettingsView.tsx');
  const update = view.slice(view.indexOf("case 'update':"), view.indexOf("case 'claude':"));
  assert.ok(update.length > 0, 'the Update & restart group is found in SettingsView.tsx');
  assert.match(update, /const texts = updateTexts\(props\.update\.view\);/);
  assert.match(update, /\{texts\.update && <p className="muted">\{texts\.update\}<\/p>\}/);
  assert.match(update, /<p className="muted">\{texts\.restart\}<\/p>/);
  assert.doesNotMatch(update, /GitHub|newest release/);
});

test('the search texts of Update & restart fit either kind of install (#412 review)', () => {
  // Search prints these under a hit whatever the install, so they cannot name releases or GitHub.
  const update = LEDUNG_GROUPS.find((g) => g.id === 'update')!;
  for (const s of update.settings) assert.doesNotMatch(s.about ?? '', /release|GitHub/i, s.label);
});
