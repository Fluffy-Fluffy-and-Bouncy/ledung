import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { ProjectStore } from '../src/projects/store.ts';
import { parseConfig } from '../src/config.ts';
import { SUGGESTIONS } from '../src/shared/sensitive-suggestions.ts';
import { removeTemp } from './temp.ts';

const config = parseConfig({
  projects: [
    { name: 'one', runner: 'local', path: 'C:/p/one', permissionMode: 'auto' },
    { name: 'two', runner: 'docker', container: 'c', pathInContainer: '/w', user: 'dev' },
  ],
});

test('config projects are copied in once, with an existing manager linked', () => {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 'old-mgr', project: 'one', runner: 'local', title: 'm', parentId: null, permissionMode: 'default', role: 'manager' });
  const projects = new ProjectStore(store.database);
  assert.deepEqual(projects.importFromConfig(config.projects), ['one', 'two']);
  assert.equal(projects.get('one')!.managerId, 'old-mgr');
  assert.equal(projects.get('two')!.managerId, null);
  // Removed in the page: it doesn't come back from the config.
  projects.remove('two');
  assert.deepEqual(projects.importFromConfig(config.projects), []);
  assert.deepEqual(projects.list().map((p) => p.config.name), ['one']);
});

test('adding checks names and duplicates; updating keeps the name and the place', () => {
  const projects = new ProjectStore(new Store(openDatabase(':memory:')).database);
  projects.add({ name: 'web app', runner: 'local', path: 'C:/p/web', sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] } });
  assert.throws(() => projects.add({ name: 'web app', runner: 'local', path: 'C:/x', sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] } }), /already a project/);
  assert.throws(() => projects.add({ name: '../evil', runner: 'local', path: 'C:/x' } as never), /letters, digits/);
  const updated = projects.update('web app', { name: 'other', runner: 'local', path: 'C:/elsewhere', account: 'work', model: 'haiku' } as never);
  assert.equal(updated.config.name, 'web app');
  assert.equal(updated.config.runner === 'local' && updated.config.path, 'C:/p/web');
  assert.equal(updated.config.account, 'work');
  // Saving the settings with the model fields left empty clears them (inherit; decision of 2026-10-13).
  const pinned = projects.update('web app', { name: 'web app', runner: 'local', path: 'C:/p/web', model: 'sonnet', managerModel: 'opus' } as never);
  assert.equal(pinned.config.managerModel, 'opus');
  const cleared = projects.update('web app', { name: 'web app', runner: 'local', path: 'C:/p/web', managerModel: 'opus' } as never);
  assert.equal(cleared.config.model, undefined);
  assert.equal(cleared.config.managerModel, 'opus');
  // A removed project's name can be used again.
  projects.remove('web app');
  projects.add({ name: 'web app', runner: 'local', path: 'C:/p/web2', sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] } });
  assert.equal(projects.list().length, 1);
});

test('the suggested sensitive patterns are added to existing projects once, keeping their own and never reviving a deleted one', () => {
  const projects = new ProjectStore(new Store(openDatabase(':memory:')).database);
  const mine = { commandPatterns: ['mine'], pathPatterns: [], mcpTools: ['mcp__prod__'] };
  projects.add({ name: 'old', runner: 'local', path: 'C:/p/old', sensitive: mine });
  projects.add({ name: 'plain', runner: 'local', path: 'C:/p/plain', sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] } });
  assert.equal(projects.addSuggestionsOnce(), 2);
  const old = projects.get('old')!.config.sensitive;
  assert.equal(old.commandPatterns[0], 'mine');
  assert.deepEqual(old.mcpTools, ['mcp__prod__']);
  assert.equal(old.commandPatterns.length, 1 + SUGGESTIONS.filter((s) => s.kind === 'command').length);
  assert.equal(projects.get('plain')!.config.sensitive.pathPatterns.length, SUGGESTIONS.filter((s) => s.kind === 'path').length);
  // The user deletes the push entry; a later start changes nothing.
  const pushless = projects.get('plain')!.config;
  projects.update('plain', { ...pushless, sensitive: { ...pushless.sensitive, commandPatterns: pushless.sensitive.commandPatterns.filter((p) => !p.includes('push')) } });
  assert.equal(projects.addSuggestionsOnce(), 0);
  assert.ok(!projects.get('plain')!.config.sensitive.commandPatterns.some((p) => p.includes('git')));
});

test('name colours (issue #83) are kept per project, survive a settings save, and refuse non-palette values', () => {
  const projects = new ProjectStore(new Store(openDatabase(':memory:')).database);
  projects.add({ name: 'web', runner: 'local', path: 'C:/p/web', sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] } });
  assert.deepEqual(projects.get('web')!.colours, { manager: null, sessions: 'same' });
  projects.setColours('web', { manager: 'teal', sessions: 'pink' });
  assert.deepEqual(projects.get('web')!.colours, { manager: 'teal', sessions: 'pink' });
  // Saving the project's settings doesn't touch its colours.
  projects.update('web', { name: 'web', runner: 'local', path: 'C:/p/web', model: 'haiku' } as never);
  assert.deepEqual(projects.get('web')!.colours, { manager: 'teal', sessions: 'pink' });
  assert.throws(() => projects.setColours('web', { manager: '#123456' }), /not one of the name colours/);
  assert.deepEqual(projects.get('web')!.colours, { manager: 'teal', sessions: 'pink' });
  assert.throws(() => projects.setColours('nope', { manager: 'red' }), /no project named/);
  // Back to no colours.
  projects.setColours('web', { manager: null, sessions: 'same' });
  assert.deepEqual(projects.get('web')!.colours, { manager: null, sessions: 'same' });
});

test('name colours (issue #83) survive closing and reopening the database file, as on a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-colours-'));
  try {
    const file = path.join(dir, 'ledung.db');
    const first = openDatabase(file);
    const before = new ProjectStore(first);
    before.add({ name: 'web', runner: 'local', path: 'C:/p/web', sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] } });
    before.add({ name: 'api', runner: 'local', path: 'C:/p/api', sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] } });
    before.setColours('web', { manager: 'purple', sessions: 'orange' });
    first.close();
    const second = openDatabase(file);
    const after = new ProjectStore(second);
    assert.deepEqual(after.get('web')!.colours, { manager: 'purple', sessions: 'orange' });
    assert.deepEqual(after.get('api')!.colours, { manager: null, sessions: 'same' });
    second.close();
  } finally {
    removeTemp(dir);
  }
});
