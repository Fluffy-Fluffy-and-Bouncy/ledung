// Where the Ledung Helper's link cards and the step bar's "Do it myself instead" lead (docs/steps/ledung-helper.md):
// Ledung's own pages only, and a project the card names only when it is there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helperLinkView, myselfView } from '../web/src/helper/helperNav.ts';
import { CARD_LINKS } from '../src/shared/helper-cards.ts';
import { SETUP_STEP_IDS } from '../src/shared/setup.ts';

const projects = [{ name: 'shop', managerId: 'm-1' }, { name: 'atlas', managerId: null }];

test('a link card leads to a page of Ledung\'s, and to a project only when it is there', () => {
  for (const to of CARD_LINKS) {
    const view = helperLinkView(to, 'shop', projects);
    assert.ok(view && !/^[a-z]+:\/\//i.test(view), `${to}: ${view}`);
  }
  assert.equal(helperLinkView('manager', 'shop', projects), 'm-1');
  assert.equal(helperLinkView('manager', 'atlas', projects), 'p:atlas', "a manager not started yet: the project's start page");
  assert.equal(helperLinkView('workflow', 'nowhere', projects), null);
  assert.equal(helperLinkView('project-settings', null, projects), null);
  assert.equal(helperLinkView('add-project', null, projects), 'add');
});

test('every step but the name has a plain form; the project\'s steps wait for a project', () => {
  for (const step of SETUP_STEP_IDS) {
    if (step === 'name') assert.equal(myselfView(step, null), null);
    else assert.ok(myselfView(step, 'shop'), step);
  }
  assert.equal(myselfView('grant', 'shop'), 'ps:shop/powers');
  assert.equal(myselfView('sensitive', 'shop'), 'ps:shop/safety');
  assert.equal(myselfView('grant', null), 'add');
});

test('the helper chat\'s approval card says what happens in plain words, not the tool\'s name', async () => {
  const { helperApprovalText } = await import('../web/src/helper/helperNav.ts');
  assert.deepEqual(helperApprovalText('mcp__ledung__add_project', { name: 'my-app', folder: '/.ome\my-app' }, "a manager's project tool, always yours to approve"),
    { title: 'Add the project "my-app"?', lines: ['Folder: /.ome\my-app'] });
  assert.deepEqual(helperApprovalText('mcp__ledung__create_project', { name: 'Atlas', github: true, permission_mode: 'auto' }, null),
    { title: 'Create the project "Atlas"?', lines: ['A new folder with git in your projects folder, and a private GitHub repository', 'Permission mode: Auto'] });
  assert.deepEqual(helperApprovalText('mcp__ledung__set_project_basics', { project: 'shop', permissionMode: 'auto' }, 'a change to "shop" that lets more through without you: permission mode for new sessions Ask → Auto'),
    { title: 'Change "shop"?', lines: ['permission mode for new sessions Ask → Auto'] });
  assert.equal(helperApprovalText('Bash', { command: 'ls' }, null), null, 'anything else: the usual card');
});

test("a change Ledung couldn't word plainly gets the usual card, with its input shown (code review, finding 2)", async () => {
  const { helperApprovalText } = await import('../web/src/helper/helperNav.ts');
  assert.equal(helperApprovalText('mcp__ledung__set_project_settings', { project: 'shop' }, 'Ledung could not check this change (x; y), so it asks'), null);
  assert.equal(helperApprovalText('mcp__ledung__set_project_basics', { project: 'shop' }, 'a sensitive MCP tool'), null);
  assert.equal(helperApprovalText('mcp__ledung__set_project_basics', { project: 'shop' }, null), null);
});

test("a change to Ledung's settings reads plainly: what it opens, the risk, the narrower choice", async () => {
  const { helperApprovalText } = await import('../web/src/helper/helperNav.ts');
  const rule = "a change to Ledung's settings that opens up: folders Ledung may use /home/me → /home/me, /. Risk: The folder browser may then reach everything under /. Narrower: a folder of its own instead, e.g. /dev-work.";
  const t = helperApprovalText('mcp__ledung__change_ledung_setting', { setting: 'browseRoots' }, rule)!;
  assert.equal(t.title, "Change Ledung's settings?");
  assert.equal(t.lines[0], 'folders Ledung may use /home/me → /home/me, /');
  assert.match(t.lines[1]!, /^Risk: /);
  assert.match(t.lines[2]!, /^Narrower: a folder of its own/);
  assert.equal(helperApprovalText('mcp__ledung__change_ledung_setting', {}, 'something else'), null);
});

test('a link card opens Settings at the very section, by a label the group draws; every secret names one (acceptance round 6, 26)', async () => {
  const { LINK_SECTIONS, focusSettingNext, takeSettingFocus } = await import('../web/src/helper/helperNav.ts');
  const { LEDUNG_GROUPS } = await import('../web/src/settingsGroups.ts');
  const { SECRET_SETTINGS } = await import('../src/sessions/helper-settings.ts');
  for (const [to, s] of Object.entries(LINK_SECTIONS)) {
    const group = LEDUNG_GROUPS.find((g) => `settings:${g.id}` === s!.view);
    assert.ok(group, `${to}: ${s!.view} is a Settings group`);
    assert.ok(group!.settings.some((x) => x.label === s!.label), `${to}: "${s!.label}" is drawn in ${group!.label}`);
  }
  for (const secret of SECRET_SETTINGS) {
    assert.ok((CARD_LINKS as readonly string[]).includes(secret.open), secret.id);
    assert.ok(LINK_SECTIONS[secret.open as keyof typeof LINK_SECTIONS], `${secret.id} opens a section`);
  }
  assert.equal(helperLinkView('join-code', null, []), 'settings:remote');
  focusSettingNext('join-code');
  assert.equal(takeSettingFocus('settings:claude'), null, 'only for its own page');
  assert.equal(takeSettingFocus('settings:remote'), 'Remote access');
  assert.equal(takeSettingFocus('settings:remote'), null, 'once');
});

test('a declined request in the helper chat reads plainly, with no tool name (acceptance round 6, 16)', async () => {
  const { helperDeclinedText } = await import('../web/src/helper/helperNav.ts');
  const lines = [
    helperDeclinedText('mcp__ledung__change_ledung_setting', { setting: 'lanSignIn', value: false }),
    helperDeclinedText('mcp__ledung__set_project_basics', { project: 'shop', permissionMode: 'auto' }),
    helperDeclinedText('mcp__ledung__add_project', { name: 'shop', folder: '/x' }),
    helperDeclinedText('mcp__ledung__whatever', {}),
  ];
  assert.deepEqual(lines.slice(1, 3), ['You declined changing "shop": permission mode Auto.', 'You declined adding the project "shop".']);
  for (const l of lines) assert.ok(!/mcp__|_project|ledung__/.test(l), l);
});
