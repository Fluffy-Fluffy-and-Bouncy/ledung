// A workflow by default (issue #21): on, off and a missing project config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, parseProject, type LocalProjectConfig } from '../src/config.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { Management } from '../src/sessions/management.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { instructions, MCP_LIMIT_ENV, type ToolHandlers } from '../src/sessions/tools.ts';
import { checkFolder, projectWorkflow, workflowInstructions } from '../src/sessions/workflow.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

// Names made up for the test: the code knows no process.
const WORKFLOW = { folder: path.resolve('/process'), managerFile: 'lead/LEAD.md', sessionFile: 'lead/WORKER.md', projectConfig: 'cfg/PROJECT.md' };

function projectFolder(withConfig: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-workflow-'));
  if (withConfig) {
    fs.mkdirSync(path.join(dir, 'cfg'));
    fs.writeFileSync(path.join(dir, 'cfg', 'PROJECT.md'), '# config\n');
  }
  return dir;
}

const handlers = (role: 'manager' | 'session', workflow?: string): ToolHandlers => ({
  userName: 'Simon', role, asksWhom: role === 'manager' ? 'Simon' : 'your manager "M"', ask: () => { throw new Error('unused'); }, withdraw: () => '', workflow,
});

test('on: a manager is told the manager file and the project config', () => {
  const dir = projectFolder(true);
  const w = projectWorkflow(WORKFLOW, parseProject({ name: 'p', runner: 'local', path: dir }))!;
  assert.equal(
    workflowInstructions(w, 'manager'),
    `This project follows a written process. Before anything else, read ${path.join(WORKFLOW.folder, 'lead/LEAD.md')} in full and follow it. `
      + `The project's process config is ${path.join(dir, 'cfg', 'PROJECT.md')}; wherever the process names its config file, it means that one.`,
  );
  // After Ledung's own instructions, as decided (questions #16 and #29).
  const text = instructions(handlers('manager', workflowInstructions(w, 'manager')));
  assert.ok(text.endsWith(`by hand.\n\n${workflowInstructions(w, 'manager')}`));
});

test('on: every other session is told the session file', () => {
  const dir = projectFolder(true);
  const w = projectWorkflow(WORKFLOW, parseProject({ name: 'p', runner: 'local', path: dir }))!;
  const text = workflowInstructions(w, 'session');
  assert.ok(text.includes(`read ${path.join(WORKFLOW.folder, 'lead/WORKER.md')} in full`));
  assert.ok(!text.includes('LEAD.md'));
});

test('missing project config: the session is told to say so', () => {
  const dir = projectFolder(false);
  const w = projectWorkflow(WORKFLOW, parseProject({ name: 'p', runner: 'local', path: dir }))!;
  assert.equal(w.configExists, false);
  assert.ok(workflowInstructions(w, 'manager').endsWith(
    `The project's process config ${path.join(dir, 'cfg', 'PROJECT.md')} does not exist yet: say so to whoever you ask (ask_user) before doing anything that needs it.`,
  ));
});

test('a project can name its own config path', () => {
  const dir = projectFolder(false);
  fs.writeFileSync(path.join(dir, 'OWN.md'), 'x');
  const w = projectWorkflow(WORKFLOW, parseProject({ name: 'p', runner: 'local', path: dir, workflow: { projectConfig: 'OWN.md' } }))!;
  assert.equal(w.projectConfig, path.join(dir, 'OWN.md'));
  assert.equal(w.configExists, true);
});

test('off: no workflow configured, or the project switched off, adds nothing', () => {
  const dir = projectFolder(true);
  assert.equal(parseConfig({}).workflow, undefined);
  assert.equal(projectWorkflow(undefined, parseProject({ name: 'p', runner: 'local', path: dir })), null);
  assert.equal(projectWorkflow(WORKFLOW, parseProject({ name: 'p', runner: 'local', path: dir, workflow: { use: false } })), null);
  for (const role of ['manager', 'session'] as const) {
    const text = instructions(handlers(role));
    assert.ok(!text.includes('written process'));
    // The last line is Ledung's own, exactly as before the workflow existed.
    assert.ok(text.endsWith(role === 'manager' ? 'pause_session and resume_session pause one of your sessions by hand.' : "they are not Simon's words."));
  }
});

test('containers are out unless the project says so; then their config is not looked for', () => {
  const docker = { name: 'd', runner: 'docker', container: 'c', pathInContainer: '/work/d' };
  assert.equal(projectWorkflow(WORKFLOW, parseProject(docker)), null);
  const w = projectWorkflow(WORKFLOW, parseProject({ ...docker, workflow: { use: true } }))!;
  assert.equal(w.projectConfig, '/work/d/cfg/PROJECT.md');
  assert.equal(w.configExists, null);
  assert.ok(workflowInstructions(w, 'session').includes("The project's process config is /work/d/cfg/PROJECT.md;"));
});

test('Add project check: nothing when off, missing and present when on', () => {
  const without = projectFolder(false);
  const withIt = projectFolder(true);
  const anywhere = () => true;
  assert.deepEqual(checkFolder(undefined, without, undefined, anywhere), { on: false, projectConfig: null, exists: null });
  assert.deepEqual(checkFolder(WORKFLOW, without, undefined, anywhere), { on: true, projectConfig: 'cfg/PROJECT.md', exists: false });
  assert.deepEqual(checkFolder(WORKFLOW, withIt, undefined, anywhere), { on: true, projectConfig: 'cfg/PROJECT.md', exists: true });
  assert.deepEqual(checkFolder(WORKFLOW, undefined, undefined, anywhere), { on: true, projectConfig: 'cfg/PROJECT.md', exists: null });
  assert.equal(checkFolder(WORKFLOW, withIt, 'other.md', anywhere).exists, false);
  // Somewhere Ledung may not look: no answer either way.
  assert.equal(checkFolder(WORKFLOW, withIt, undefined, () => false).exists, null);
});

test('the config takes a workflow block and per-project settings', () => {
  const config = parseConfig({ workflow: WORKFLOW, projects: [{ name: 'a', runner: 'local', path: '/a', workflow: { use: false } }] });
  assert.deepEqual(config.workflow, WORKFLOW);
  assert.throws(() => parseConfig({ workflow: { folder: '/x' } }), /workflow\.managerFile/);
});

test('the Add project check looks only inside the folders Ledung may use', () => {
  const root = projectFolder(true);
  const outside = projectFolder(true);
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ workflow: WORKFLOW, browseRoots: [root], projectsFolder: root, idleStopMinutes: 0 }), new Store(openDatabase(':memory:')), () => {}));
  assert.equal(manager.workflowCheck(root, undefined).exists, true);
  assert.throws(() => manager.workflowCheck(outside, undefined), /outside the folders/);
  // The config path typed in the form (review of #21): absolute inside the allowed folders is looked at,
  // missing inside is reported missing, and absolute or ".." outside gets no answer, so no file elsewhere can be probed.
  assert.equal(manager.workflowCheck(root, path.join(root, 'cfg', 'PROJECT.md')).exists, true);
  assert.equal(manager.workflowCheck(root, 'cfg/MISSING.md').exists, false);
  assert.equal(manager.workflowCheck(root, 'new/folder/MISSING.md').exists, false);
  assert.equal(manager.workflowCheck(root, path.join(outside, 'cfg', 'PROJECT.md')).exists, null);
  assert.equal(manager.workflowCheck(root, path.relative(root, path.join(outside, 'cfg', 'PROJECT.md'))).exists, null);
});

test("the paragraph is part of the instructions Claude Code's tool server limit is raised for (#32)", async () => {
  const own = process.env[MCP_LIMIT_ENV];
  delete process.env[MCP_LIMIT_ENV];
  const dir = projectFolder(true);
  const project = parseProject({ name: 'p', runner: 'local', path: dir }) as LocalProjectConfig;
  const w = projectWorkflow(WORKFLOW, project)!;
  const limitFor = async (workflow: typeof w | null) => {
    const store = new Store(openDatabase(':memory:'));
    const management = new Management({
      store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async () => {},
      startSession: async () => { throw new Error('not used'); },
      stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p'], decidePermission: () => true,
      machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
      setPriority: () => {}, setPaused: () => {}, handoffProblem: () => null, shotPath: (_id, file) => file,
      projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
      ensureManager: async () => { throw new Error('not used'); },
    });
    const info = store.createSession({ id: 's', project: 'p', runner: 'local', title: 'Lead', parentId: null, permissionMode: 'default', role: 'manager' });
    const session = new Session({
      info, store, publish: () => {}, userName: 'Simon', management, workflow,
      runner: new LocalRunner(project),
      gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    });
    return Number((await session.claudeOptions({ onLine: () => {}, onStderr: () => {} })).env?.[MCP_LIMIT_ENV]);
  };
  try {
    // A manager's instructions already run past the default limit, so the limit is their length; the
    // paragraph comes after a blank line, so it raises the limit by its own length and two line breaks.
    assert.equal(await limitFor(w) - await limitFor(null), workflowInstructions(w, 'manager').length + 2);
  } finally {
    if (own !== undefined) process.env[MCP_LIMIT_ENV] = own;
    removeTemp(dir);
  }
});
