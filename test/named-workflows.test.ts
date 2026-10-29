// Several named workflows, one per project (issue #132): the old single block, two workflows, None,
// an unknown name, and what each project's sessions are told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, parseProject, workflowsOf, type LedungConfig, type ProjectConfig } from '../src/config.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import type { Management } from '../src/sessions/management.ts';
import { workflowInstructions, type ProjectWorkflow } from '../src/sessions/workflow.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import type { SessionInfo } from '../src/shared/protocol.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

// Names made up for the test: the code knows no process.
const FIRST = { folder: path.resolve('/process-one'), managerFile: 'LEAD.md', sessionFile: 'WORKER.md', projectConfig: 'one/CONFIG.md' };
const SECOND = { name: 'second', folder: path.resolve('/process-two'), managerFile: 'boss.md', sessionFile: 'hand.md', projectConfig: 'two/SETUP.md' };

function tempFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-named-workflows-'));
}

function managerWith(config: Record<string, unknown>, root: string): SessionManager {
  return refuseRealSignInStores(new SessionManager(parseConfig({ ...config, browseRoots: [root], projectsFolder: root, idleStopMinutes: 0 }), new Store(openDatabase(':memory:')), () => {}));
}

/** The workflow a session of this project starts with, as the manager hands it to the session. */
function workflowOf(manager: SessionManager, name: string, role: 'manager' | 'session'): ProjectWorkflow | null {
  const project = (manager.projects().find((p) => p.name === name));
  assert.ok(project, `project ${name}`);
  const config = (manager as unknown as { projectStore: { get(n: string): { config: ProjectConfig } } }).projectStore.get(name).config;
  const info = { id: `${name}-${role}`, project: name, runner: config.runner, role, profile: null, requestedModel: null } as unknown as SessionInfo;
  const options = (manager as unknown as { sessionOptions(p: ProjectConfig, i: SessionInfo): { workflow: ProjectWorkflow | null } }).sessionOptions(config, info);
  return options.workflow;
}

/** The paragraph a session is told, or null for none. */
function told(manager: SessionManager, name: string, role: 'manager' | 'session'): string | null {
  const w = workflowOf(manager, name, role);
  return w ? workflowInstructions(w, role) : null;
}

const addLocal = (manager: SessionManager, root: string, name: string, extra: Record<string, unknown> = {}) => {
  const folder = path.join(root, name);
  fs.mkdirSync(folder, { recursive: true });
  return manager.addProject({ name, runner: 'local', path: folder, ...extra } as ProjectConfig);
};

test('the old single "workflow" block is one workflow, named "default"; a project from before follows it as before', () => {
  const config = parseConfig({ workflow: FIRST });
  // The config reads back exactly as written: nobody has to edit theirs.
  assert.deepEqual(config.workflow, FIRST);
  assert.deepEqual(workflowsOf(config), [{ ...FIRST, name: 'default' }]);
  const root = tempFolder();
  const manager = managerWith({ workflow: FIRST }, root);
  addLocal(manager, root, 'old');
  addLocal(manager, root, 'off', { workflow: { use: false } });
  addLocal(manager, root, 'own', { workflow: { projectConfig: 'MINE.md' } });
  assert.equal(
    told(manager, 'old', 'manager'),
    `This project follows a written process. Before anything else, read ${path.join(FIRST.folder, 'LEAD.md')} in full and follow it. `
      + `The project's process config ${path.join(root, 'old', 'one', 'CONFIG.md')} does not exist yet: say so to whoever you ask (ask_user) before doing anything that needs it.`,
  );
  assert.ok(told(manager, 'old', 'session')!.includes(`read ${path.join(FIRST.folder, 'WORKER.md')} in full`));
  assert.equal(told(manager, 'off', 'manager'), null);
  assert.equal(workflowOf(manager, 'own', 'session')!.projectConfig, path.join(root, 'own', 'MINE.md'));
  // The Add project form's default config path is the block's, as before.
  assert.equal(manager.workflowCheck(undefined, undefined).projectConfig, 'one/CONFIG.md');
});

test('the single block may give itself a name', () => {
  assert.deepEqual(workflowsOf(parseConfig({ workflow: { ...FIRST, name: 'house' } })).map((w) => w.name), ['house']);
});

test('two workflows: each project is told the files of the one it names; naming none, the first', () => {
  const root = tempFolder();
  const manager = managerWith({ workflow: FIRST, workflows: [SECOND] }, root);
  addLocal(manager, root, 'a');
  addLocal(manager, root, 'b', { workflow: { name: 'second' } });
  addLocal(manager, root, 'c', { workflow: { name: 'default' } });
  fs.mkdirSync(path.join(root, 'b', 'two'));
  fs.writeFileSync(path.join(root, 'b', 'two', 'SETUP.md'), '# setup\n');

  for (const name of ['a', 'c']) {
    assert.ok(told(manager, name, 'manager')!.includes(`read ${path.join(FIRST.folder, 'LEAD.md')} in full`), name);
    assert.ok(told(manager, name, 'session')!.includes(`read ${path.join(FIRST.folder, 'WORKER.md')} in full`), name);
  }
  assert.equal(
    told(manager, 'b', 'manager'),
    `This project follows a written process. Before anything else, read ${path.join(SECOND.folder, 'boss.md')} in full and follow it. `
      + `The project's process config is ${path.join(root, 'b', 'two', 'SETUP.md')}; wherever the process names its config file, it means that one.`,
  );
  const session = told(manager, 'b', 'session')!;
  assert.ok(session.includes(`read ${path.join(SECOND.folder, 'hand.md')} in full`));
  assert.ok(!session.includes('process-one'));
  // The page gets the choice back as it was stored.
  assert.deepEqual(manager.projects().find((p) => p.name === 'b')!.workflow, { name: 'second' });
});

test('only a "workflows" list: its first is the default', () => {
  const root = tempFolder();
  const manager = managerWith({ workflows: [SECOND] }, root);
  addLocal(manager, root, 'a');
  assert.ok(told(manager, 'a', 'manager')!.includes(path.join(SECOND.folder, 'boss.md')));
});

test('None: no workflow paragraph, whatever is configured', () => {
  const root = tempFolder();
  const manager = managerWith({ workflow: FIRST, workflows: [SECOND] }, root);
  addLocal(manager, root, 'none', { workflow: { use: false } });
  addLocal(manager, root, 'none-named', { workflow: { use: false, name: 'second' } });
  for (const name of ['none', 'none-named']) {
    for (const role of ['manager', 'session'] as const) assert.equal(told(manager, name, role), null, `${name} ${role}`);
  }
  // No workflow configured at all: none either, as before.
  const bare = managerWith({}, root);
  addLocal(bare, root, 'plain');
  assert.equal(told(bare, 'plain', 'manager'), null);
});

test('a container follows the workflow it names only when switched on', () => {
  const root = tempFolder();
  const manager = managerWith({ workflow: FIRST, workflows: [SECOND] }, root);
  manager.addProject(parseProject({ name: 'box', runner: 'docker', container: 'c', pathInContainer: '/work/box', workflow: { name: 'second' } }));
  manager.addProject(parseProject({ name: 'box-on', runner: 'docker', container: 'c', pathInContainer: '/work/on', workflow: { name: 'second', use: true } }));
  assert.equal(workflowOf(manager, 'box', 'manager'), null);
  const on = workflowOf(manager, 'box-on', 'manager')!;
  assert.equal(on.projectConfig, '/work/on/two/SETUP.md');
  assert.equal(on.rulesFile('manager'), path.join(SECOND.folder, 'boss.md'));
});

test('a workflow name not in the config is refused; one taken out since leaves the project with none, and its other settings can still be saved', () => {
  const root = tempFolder();
  const manager = managerWith({ workflow: FIRST, workflows: [SECOND] }, root);
  fs.mkdirSync(path.join(root, 'x'));
  assert.throws(() => manager.addProject({ name: 'x', runner: 'local', path: path.join(root, 'x'), workflow: { name: 'third' } } as ProjectConfig),
    /no workflow named "third"; the config has "default", "second"/);
  addLocal(manager, root, 'y', { workflow: { name: 'second' } });
  assert.throws(() => manager.updateProject('y', { name: 'y', runner: 'local', path: path.join(root, 'y'), workflow: { name: 'third' } } as ProjectConfig), /no workflow named "third"/);

  // The same projects with "second" taken out of the config.
  const store = (manager as unknown as { store: Store }).store;
  const later = refuseRealSignInStores(new SessionManager(parseConfig({ workflow: FIRST, browseRoots: [root], projectsFolder: root, idleStopMinutes: 0 }), store, () => {}));
  assert.equal(told(later, 'y', 'manager'), null, 'not quietly another workflow');
  later.updateProject('y', { name: 'y', runner: 'local', path: path.join(root, 'y'), model: 'haiku', workflow: { name: 'second' } } as ProjectConfig);
  assert.equal(later.projects().find((p) => p.name === 'y')!.model, 'haiku');
});

test('add_project and create_project name the workflow, or none', async () => {
  const root = tempFolder();
  const manager = managerWith({ workflow: FIRST, workflows: [SECOND] }, root);
  const management = (manager as unknown as { management: Management }).management;
  fs.mkdirSync(path.join(root, 'one'));
  fs.mkdirSync(path.join(root, 'two'));
  fs.mkdirSync(path.join(root, 'three'));
  await management.addProject('mgr', { name: 'one', folder: path.join(root, 'one'), workflow: 'second' });
  await management.addProject('mgr', { name: 'two', folder: path.join(root, 'two'), workflow: 'none' });
  await management.addProject('mgr', { name: 'three', folder: path.join(root, 'three') });
  assert.ok(told(manager, 'one', 'session')!.includes(path.join(SECOND.folder, 'hand.md')));
  assert.equal(told(manager, 'two', 'manager'), null);
  assert.ok(told(manager, 'three', 'manager')!.includes(path.join(FIRST.folder, 'LEAD.md')));
  // Naming none, they store the first workflow's name, as the page does for a new project (review of #132).
  assert.deepEqual(manager.projects().find((p) => p.name === 'three')!.workflow, { name: 'default' });
  assert.deepEqual(manager.projects().find((p) => p.name === 'two')!.workflow, { use: false });
  await management.createProject('mgr', { name: 'five' });
  assert.deepEqual(manager.projects().find((p) => p.name === 'five')!.workflow, { name: 'default' });
  await assert.rejects(management.createProject('mgr', { name: 'four', workflow: 'third' }), /no workflow named "third"/);
  assert.ok(!fs.existsSync(path.join(root, 'four')), 'a refused workflow leaves no folder behind');
});

test('the Add project check lists the workflows and follows the one chosen', () => {
  const root = tempFolder();
  const manager = managerWith({ workflow: FIRST, workflows: [SECOND] }, root);
  fs.mkdirSync(path.join(root, 'two'), { recursive: true });
  fs.writeFileSync(path.join(root, 'two', 'SETUP.md'), 'x');
  assert.deepEqual(manager.workflowCheck(root, undefined), { workflows: ['default', 'second'], on: true, projectConfig: 'one/CONFIG.md', exists: false });
  assert.deepEqual(manager.workflowCheck(root, undefined, 'second'), { workflows: ['default', 'second'], on: true, projectConfig: 'two/SETUP.md', exists: true });
  assert.equal(manager.workflowCheck(root, undefined, 'third').on, false);
  assert.deepEqual(managerWith({}, root).workflowCheck(root, undefined), { workflows: [], on: false, projectConfig: null, exists: null });
});

test('the config refuses two workflows of one name, and the name "none"', () => {
  assert.throws(() => parseConfig({ workflow: FIRST, workflows: [{ ...SECOND, name: 'default' }] }), /Two workflows are named "default"/);
  assert.throws(() => parseConfig({ workflows: [SECOND, SECOND] }), /Two workflows are named "second"/);
  assert.throws(() => parseConfig({ workflows: [{ ...SECOND, name: 'None' }] }), /cannot be named "none"/);
  assert.throws(() => parseConfig({ workflows: [{ ...SECOND, name: undefined }] }), /workflows\.0\.name/);
  const config: LedungConfig = parseConfig({ workflows: [SECOND] });
  assert.equal(config.workflow, undefined);
});
