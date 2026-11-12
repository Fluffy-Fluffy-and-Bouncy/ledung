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
