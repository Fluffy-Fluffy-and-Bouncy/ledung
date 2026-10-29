// The sidebar strip shows the selected project's account, else the last one selected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountLabel, selectedProject, projectAccountShown, stripAccount } from '../web/src/limitAccount.ts';

const sessions = [{ id: 's1', project: 'alpha' }, { id: 's2', project: 'beta' }, { id: 's3', project: 'gone' }];
const projects = [{ name: 'alpha', account: null }, { name: 'beta', account: 'Private' }];

test('a session or project page selects its project', () => {
  assert.equal(selectedProject('s2', sessions), 'beta');
  assert.equal(selectedProject('p:alpha', sessions), 'alpha');
  assert.equal(selectedProject('ps:beta', sessions), 'beta');
  for (const id of [null, 'overview', 'waiting', 'usage', 'a:alpha', 'unknown']) assert.equal(selectedProject(id, sessions), null);
});

test('a selected project gives its account, null meaning the default login', () => {
  assert.deepEqual(stripAccount('s1', sessions, projects, 'Private'), { account: 'default', remember: true });
  assert.deepEqual(stripAccount('s2', sessions, projects, null), { account: 'Private', remember: true });
});

test('with nothing selected the remembered account stays, even across views', () => {
  assert.deepEqual(stripAccount('overview', sessions, projects, 'Private'), { account: 'Private', remember: false });
  assert.deepEqual(stripAccount('a:alpha', sessions, projects, 'default'), { account: 'default', remember: false });
});

test('a session of a removed project keeps the remembered account', () => {
  assert.deepEqual(stripAccount('s3', sessions, projects, 'Private'), { account: 'Private', remember: false });
});

test('before any selection the first project decides, else the default login', () => {
  assert.deepEqual(stripAccount(null, sessions, [{ name: 'beta', account: 'Private' }], null), { account: 'Private', remember: false });
  assert.deepEqual(stripAccount(null, [], [], null), { account: 'default', remember: false });
});

test('the default login is named Default', () => {
  assert.equal(accountLabel('default'), 'Default');
  assert.equal(accountLabel('Private'), 'Private');
});

test('the sidebar names a project account unless it is this computer\'s own login (#394)', () => {
  // A project with no account, or the default one, runs on the computer's own login: nothing is named.
  assert.equal(projectAccountShown(undefined), null);
  assert.equal(projectAccountShown(null), null);
  assert.equal(projectAccountShown('default'), null);
  // A named account is always named, even when it is the only one added (it was hidden then before #394).
  assert.equal(projectAccountShown('work'), 'work');
});
