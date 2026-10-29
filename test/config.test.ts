import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';

test('fills in defaults', () => {
  const config = parseConfig({ projects: [{ name: 'a', runner: 'local', path: 'C:\\a' }] });
  assert.equal(config.port, 4317);
  assert.deepEqual(config.sensitive.commandPatterns, []);
});

test('accepts both runners', () => {
  const config = parseConfig({
    projects: [
      { name: 'a', runner: 'local', path: '/a' },
      { name: 'b', runner: 'docker', container: 'c', pathInContainer: '/workspaces/b', user: 'vscode' },
    ],
  });
  assert.equal(config.projects.length, 2);
});

test('names the problem in a broken config', () => {
  assert.throws(() => parseConfig({ projects: [{ name: 'a', runner: 'docker', container: 'c' }] }), /pathInContainer/);
  assert.throws(() => parseConfig({ projects: [{ name: 'a', runner: 'ssh' }] }), /projects\.0/);
});

test('rejects two projects with the same name', () => {
  assert.throws(
    () => parseConfig({ projects: [{ name: 'a', runner: 'local', path: '/a' }, { name: 'a', runner: 'local', path: '/b' }] }),
    /two projects named "a"/,
  );
});

test('a project can set the permission mode its sessions start in', () => {
  const config = parseConfig({ projects: [{ name: 'a', runner: 'local', path: '/a', permissionMode: 'auto' }] });
  assert.equal(config.projects[0]!.permissionMode, 'auto');
});

test('bypassing permissions cannot be configured', () => {
  assert.throws(() => parseConfig({ projects: [{ name: 'a', runner: 'local', path: '/a', permissionMode: 'bypassPermissions' }] }), /permissionMode/);
});

test('"lan" is off by default and takes true or one address', () => {
  assert.equal(parseConfig({}).lan, false);
  assert.equal(parseConfig({ lan: true }).lan, true);
  assert.equal(parseConfig({ lan: '192.168.1.20' }).lan, '192.168.1.20');
  assert.throws(() => parseConfig({ lan: 'my-pc' }), /lan/);
});

test('the user name defaults to "the user"', () => {
  assert.equal(parseConfig({}).userName, 'the user');
  assert.equal(parseConfig({ userName: 'Simon' }).userName, 'Simon');
});
