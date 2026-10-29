// A project's tab and the Chats tab in Settings (issue #366, mockup E; Martin 2026-10-28, Ledung question #325): the
// groups and their addresses, every field of the old project page in a group, the Ledung defaults with Reset, the Save
// bar's count, and that what Save sends for the sensitive list is what was shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHATS_GROUPS, PROJECT_GROUPS, settingsTabs, tabGroupOf, tabGroupView, tabOf, tabView } from '../web/src/settingsGroups.ts';
import { isSettingsView, leaveSettings, stepsInto, type SettingsSteps } from '../web/src/settingsNav.ts';
import { selectedProject } from '../web/src/limitAccount.ts';
import {
  FIELD_GROUP, RESET, changedFields, emptySettings, inherit, profileDefaults, settingsOf, toApi, type Settings,
} from '../web/src/projects/projectSettings.ts';
import type { ProfilesView, ProjectInfo } from '../src/shared/protocol.ts';

const project = (over: Partial<ProjectInfo> = {}): ProjectInfo => ({
  name: 'Demo', runner: 'local', where: '/home/demo', account: null, model: null, managerModel: null, permissionMode: null, managerGrant: null, projectToolsUnasked: false,
  sensitive: { commandPatterns: ['\\bgit push\\b'], pathPatterns: ['\\.env$'], mcpTools: ['mcp__prod__deploy'] }, devShipCommand: null, tickets: null,
  questionTiers: ['Blocks', 'Later'], extraFolders: [], profiles: { manager: null, session: null }, skills: {}, workflow: null, managerId: null, createdAt: 0,
  colours: { manager: null, sessions: 'same' }, lockdown: { level: 'off', board: false, remoteControl: false }, ...over,
});

test("the project tab's side menu is mockup E's, in the issue's order", () => {
  assert.deepEqual(PROJECT_GROUPS.map((g) => g.label), [
    'General', 'What always goes to you', "Manager's powers", 'Skills & profiles', 'Look', 'Workflow', 'Tickets & questions', 'Message board', 'Remove project',
  ]);
  assert.deepEqual(CHATS_GROUPS.map((g) => g.label), ['General', 'What always goes to you', 'Look']);
});

test("every field of the old project page is in a group (Done: every field in the tab)", () => {
  // The old page's fields, as its labels read (ProjectViews.tsx before #366), and its two other sections.
  const old = [
    'Name', 'Claude account', 'Model', 'Model for its manager', 'Permissions for new sessions', 'What the manager may decide for you',
    'Its manager adds projects and starts or stops other managers without asking you', 'Its manager reads and changes workflow settings of your projects',
    'Lockdown', 'Profile for its manager', 'Profile for its sessions', 'Skills', 'Workflow', 'Project config for the workflow',
    'What always goes to you', 'Dev ship command', 'Ticket pattern', 'Ticket link', 'Question tiers', 'Extra folders',
    'Use the board in this project', 'Remove project',
    // Added on main while this was built (#363).
    'Publish its usage under its name',
    // From the manager's ⚙ menu (Martin, #325).
    'Manager name', "Its sessions' names",
  ];
  const labels = PROJECT_GROUPS.flatMap((g) => g.settings.map((s) => s.label));
  for (const label of old) assert.ok(labels.includes(label), label);
  assert.deepEqual(PROJECT_GROUPS.find((g) => g.id === 'look')!.settings.map((s) => s.label), ['Manager name', "Its sessions' names"]);
  // Every form field has a group, and the sensitive list's fields are exactly the What always goes to you group's.
  for (const k of Object.keys(emptySettings()) as (keyof Settings)[]) assert.ok(PROJECT_GROUPS.some((g) => g.id === FIELD_GROUP[k]), k);
  assert.deepEqual(Object.entries(FIELD_GROUP).filter(([, g]) => g === 'safety').map(([k]) => k), ['commandPatterns', 'pathPatterns']);
});

test('a group of a project or Chats tab has its own address; the old ones open the tab', () => {
  assert.deepEqual(tabView('ps:Web site'), { project: 'Web site', group: null });
  assert.deepEqual(tabView('ps:Web site/look'), { project: 'Web site', group: 'look' });
  assert.deepEqual(tabView('chats'), { project: null, group: null });
  assert.deepEqual(tabView('chats:safety'), { project: null, group: 'safety' });
  for (const other of [null, 'settings', 'settings:look', 'p:Demo', 'a:Demo', 'chat', 'session-1']) assert.equal(tabView(other), null, String(other));
  assert.equal(tabGroupView('Web site', 'look'), 'ps:Web site/look');
  assert.equal(tabGroupView(null, 'look'), 'chats:look');
  assert.equal(tabOf('ps:Web site/look'), 'ps:Web site');
  assert.equal(tabOf('chats:look'), 'chats');
  // The old project-settings and Chats-settings addresses lead to the tabs: General on a wide screen, the list on a phone.
  assert.equal(tabGroupOf(tabView('ps:Demo')!, false), 'general');
  assert.equal(tabGroupOf(tabView('ps:Demo')!, true), null);
  assert.equal(tabGroupOf(tabView('chats')!, false), 'general');
  assert.equal(tabGroupOf(tabView('ps:Demo/safety')!, true), 'safety');
  assert.equal(tabGroupOf(tabView('ps:Demo/nope')!, false), 'general');
  // A Chats group the project tab has, and the other way round.
  assert.equal(tabGroupOf(tabView('chats:powers')!, false), 'general');
  assert.equal(tabGroupOf(tabView('chats:look')!, false), 'look');
  assert.deepEqual(settingsTabs([{ name: 'Demo' }]).map((t) => t.id), ['ledung', 'chats', 'ps:Demo', 'add']);
  // The strip of limits still finds the project in a group's address.
  assert.equal(selectedProject('ps:Demo/look', []), 'Demo');
});

test("the Chats tab's groups are steps into Settings (#78); a project's tab stays outside, as its page was", () => {
  for (const id of ['chats', 'chats:safety', 'chats:look']) assert.equal(isSettingsView(id), true, id);
  for (const id of ['ps:Demo', 'ps:Demo/look', 'p:Demo', 'a:Demo', 'chat']) assert.equal(isSettingsView(id), false, id);
  let steps: SettingsSteps = { depth: 0, root: false };
  let from: string | null = 'session-1';
  for (const to of ['settings', 'chats', 'chats:look', 'chats:safety']) {
    steps = stepsInto(from, steps, to);
    from = to;
  }
  assert.deepEqual(leaveSettings(steps), { back: 4 });
});

test('each field with a Ledung default says so, or that it overrides it; Reset is the default (Done: defaults and Reset)', () => {
  assert.deepEqual(inherit('', 'Ask'), { follows: true, text: 'Ledung default: Ask' });
  assert.deepEqual(inherit('plan', 'Ask'), { follows: false, text: 'Overrides Ledung (Ask)' });
  assert.equal(inherit({}, 'x').follows, true);
  assert.equal(inherit({ session: {} }, 'x').follows, true);
  assert.equal(inherit({ session: { off: ['review'] } }, 'x').follows, false);
  // Account, model, manager model, permission mode, skills and both profiles: Reset puts back what a new project has.
  assert.deepEqual(Object.keys(RESET).sort(), ['account', 'managerModel', 'managerProfile', 'model', 'permissionMode', 'sessionProfile', 'skills']);
  const fresh = emptySettings();
  for (const [k, v] of Object.entries(RESET)) assert.deepEqual(v, fresh[k as keyof Settings], k);
  // A reset field is left out of what Save sends, so the project follows Ledung again.
  const own = settingsOf(project({ model: 'sonnet', permissionMode: 'plan', account: 'Work', profiles: { manager: 'lean', session: null } }));
  const reset = { ...own, ...RESET } as Settings;
  const sent = toApi(reset, project());
  for (const k of ['model', 'managerModel', 'permissionMode', 'account', 'profiles', 'skills']) assert.equal(k in sent, false, k);
});

test("the profile defaults are the config's for the project's workflow, else this computer's, else full", () => {
  const view: ProfilesView = {
    groups: [
      { workflow: 'agent', file: '/w/profiles.json', warning: null, defaults: { manager: 'lead', session: 'worker' }, pluginsOff: [], profiles: [] },
      { workflow: null, file: null, warning: null, defaults: { manager: null, session: 'lean' }, pluginsOff: [], profiles: [] },
    ],
  };
  assert.deepEqual(profileDefaults(view, 'agent'), { manager: 'lead', session: 'worker' });
  assert.deepEqual(profileDefaults(view, null), { manager: 'full', session: 'lean' });
  assert.deepEqual(profileDefaults(view, 'other'), { manager: 'full', session: 'lean' });
  assert.deepEqual(profileDefaults(null, null), { manager: 'full', session: 'full' });
});

test("the Save bar counts the fields changed; nothing changed is nothing to save", () => {
  const saved = settingsOf(project());
  assert.deepEqual(changedFields(saved, settingsOf(project())), []);
  const edited = { ...saved, model: 'opus', commandPatterns: [...saved.commandPatterns, 'deploy'], questionTiers: 'Later\nBlocks' };
  assert.deepEqual(changedFields(saved, edited).sort(), ['commandPatterns', 'model', 'questionTiers']);
  assert.deepEqual([...new Set(changedFields(saved, edited).map((k) => FIELD_GROUP[k]))].sort(), ['general', 'safety', 'tickets']);
});

test('Save sends the sensitive list as shown, with the config-only MCP tools kept, exactly as the old page did', () => {
  const p = project();
  const sent = toApi(settingsOf(p), p) as { sensitive: unknown; name: string };
  assert.deepEqual(sent.sensitive, { commandPatterns: ['\\bgit push\\b'], pathPatterns: ['\\.env$'], mcpTools: ['mcp__prod__deploy'] });
  assert.equal(sent.name, 'Demo');
  // An emptied list is sent as empty, not left out: the server, not the page, decides whether a loosening needs asking.
  const emptied = toApi({ ...settingsOf(p), commandPatterns: [], pathPatterns: [] }, p) as { sensitive: unknown };
  assert.deepEqual(emptied.sensitive, { commandPatterns: [], pathPatterns: [], mcpTools: ['mcp__prod__deploy'] });
});
