// Managers' project_settings and set_project_settings (issue #306; Martin's a on question #687, 2026-10-23): reads
// free under the acting manager's project's toggle; a change that loosens what reaches the user (a new grant, its own
// included; a new dev ship command; a sensitive pattern removed) asked of the user; any other change unasked; a
// locked project never read or changed, its own manager included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Management } from '../src/sessions/management.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { parseConfig, parseProject } from '../src/config.ts';
import { loosensGate } from '../src/projects/gate.ts';
import { applyPatch, looseningChanges } from '../src/projects/settings-tools.ts';
import { ledungToolServer, LEDUNG_TOOLS, SETTINGS_CHANGE_TOOLS, type ManagerHandlers, type ToolHandlers } from '../src/sessions/tools.ts';
import { unaskedTool } from '../src/sessions/session.ts';
import type { ProjectInfo } from '../src/shared/protocol.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const base = (extra: Record<string, unknown> = {}) => parseProject({
  name: 'p', runner: 'local', path: '/p', managerGrant: 'ordinary code decisions', devShipCommand: '^npm run ship$',
  sensitive: { commandPatterns: ['deploy'], pathPatterns: ['secrets/'], mcpTools: ['mcp__prod__run'] }, ...extra,
});
const after = (patch: Record<string, unknown>) => parseProject(applyPatch(base(), { project: 'p', ...patch }));

test('what loosens what reaches the user is the page rule of #107, with before and after for the prompt', () => {
  // Loosening: a new grant, a new dev ship command, any sensitive pattern removed.
  assert.deepEqual(looseningChanges(base(), after({ managerGrant: 'may merge anything' })), ['manager grant "ordinary code decisions" → "may merge anything"']);
  assert.deepEqual(looseningChanges(base(), after({ devShipCommand: '.*' })), ['dev ship command "^npm run ship$" → ".*"']);
  assert.deepEqual(looseningChanges(base(), after({ sensitive: { commandPatterns: [] } })), ['sensitive command pattern removed: "deploy"']);
  assert.deepEqual(looseningChanges(base(), after({ sensitive: { pathPatterns: [] } })), ['sensitive path pattern removed: "secrets/"']);
  assert.deepEqual(looseningChanges(base(), after({ sensitive: { mcpTools: [] } })), ['sensitive MCP tool removed: "mcp__prod__run"']);
  const fresh = parseProject({ name: 'p', runner: 'local', path: '/p' });
  assert.deepEqual(looseningChanges(fresh, parseProject(applyPatch(fresh, { project: 'p', managerGrant: 'anything' }))), ['manager grant none → "anything"'], 'a first grant too');
  // Not loosening: clearing a grant or the dev ship command, adding patterns, tiers, tickets, the workflow.
  for (const patch of [
    { managerGrant: null }, { managerGrant: '' }, { devShipCommand: null },
    { sensitive: { commandPatterns: ['deploy', 'gh pr merge'] } }, { questionTiers: ['Now', 'Later'] }, { questionTiers: null },
    { tickets: { pattern: 'AB#\\d+', url: 'https://example.test/{id}' } }, { workflow: { name: 'flow' } }, { workflow: null },
  ]) {
    const a = after(patch);
    assert.deepEqual(looseningChanges(base(), a), [], JSON.stringify(patch));
    assert.equal(loosensGate(base(), a as unknown as Record<string, unknown>), false, `the page agrees: ${JSON.stringify(patch)}`);
  }
  // A field left out stays; a list given replaces only that list.
  const tiers = after({ questionTiers: ['Now'] });
  assert.equal(tiers.managerGrant, 'ordinary code decisions');
  assert.deepEqual(after({ sensitive: { commandPatterns: ['x', 'deploy'] } }).sensitive, { commandPatterns: ['x', 'deploy'], pathPatterns: ['secrets/'], mcpTools: ['mcp__prod__run'] });
});

test("switching a project's settings tools on loosens the gate, so the server asks for the open page's key", () => {
  assert.equal(loosensGate(base(), { ...base(), projectSettingsTools: true }), true);
  assert.equal(loosensGate(null, { name: 'q', projectSettingsTools: true }), true, 'a new project with it on');
  assert.equal(loosensGate(base({ projectSettingsTools: true }), { ...base(), projectSettingsTools: true }), false, 'kept on');
  assert.equal(loosensGate(base({ projectSettingsTools: true }), { ...base() }), false, 'switched off');
});

test('project_settings runs unasked; set_project_settings is never unasked by the tool list', () => {
  assert.ok(unaskedTool('mcp__ledung__project_settings', []));
  for (const t of SETTINGS_CHANGE_TOOLS) {
    assert.ok(!LEDUNG_TOOLS.includes(t), t);
    assert.ok(!unaskedTool(t, []), t);
  }
});

const toolNames = (h: ToolHandlers) => Object.keys((ledungToolServer(h).instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
const anyManager = new Proxy({}, { get: () => () => '' }) as ManagerHandlers;

test('only a manager outside lockdown level B has the tools', () => {
  const manager: ToolHandlers = { userName: 'Simon', role: 'manager', asksWhom: 'Simon', ask: () => { throw new Error('not called'); }, withdraw: () => '', manager: anyManager };
  const worker: ToolHandlers = { userName: 'Simon', role: 'session', asksWhom: 'your manager', ask: () => { throw new Error('not called'); }, withdraw: () => '' };
  for (const t of ['project_settings', 'set_project_settings']) {
    assert.ok(toolNames(manager).includes(t), t);
    assert.ok(!toolNames(worker).includes(t), `worker: ${t}`);
    assert.ok(!toolNames({ ...manager, airgap: true }).includes(t), `level B: ${t}`);
  }
});

test('a manager at lockdown level B is refused all the same, for one launched before the change', () => {
  const store = new Store(openDatabase(':memory:'));
  const info = (name: string, level: 'off' | 'B') => ({ name, projectSettingsTools: true, lockdown: { level, board: false, remoteControl: false } }) as unknown as ProjectInfo;
  const projects = [info('island', 'B'), info('mainland', 'off')];
  const m = new Management({
    store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async () => {},
    startSession: async () => { throw new Error('not used'); }, stopSession: async () => {}, archiveSession: () => {}, projectNames: () => projects.map((p) => p.name),
    decidePermission: () => true, machine: () => { throw new Error('not used'); }, setPriority: () => {}, setPaused: () => {}, projects: () => projects,
    addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); }, ensureManager: async () => '',
    handoffProblem: () => null, shotPath: (_id, f) => f,
    projectSettings: { config: (name) => parseProject({ name, runner: 'local', path: `/${name}` }), workflows: () => [], check: () => {}, update: () => { throw new Error('must not save'); } },
  });
  store.createSession({ id: 'mgr-i', project: 'island', runner: 'local', title: 'Manager: island', parentId: null, permissionMode: 'default', role: 'manager' });
  assert.throws(() => m.projectSettings('mgr-i'), /lockdown level B/);
  assert.throws(() => m.setProjectSettings('mgr-i', { project: 'mainland', questionTiers: ['Now'] }), /lockdown level B/);
  assert.deepEqual(m.settingsChange('mgr-i', { project: 'mainland', questionTiers: ['Now'] }), { deny: 'The project "island" is in lockdown level B (nearly air-gapped): its manager can\'t reach other managers or projects.' });
});

// --- In a real session: the hook, the tool and the save --------------------------------------------------

type Hook = (input: unknown, id: string) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;
type Tool = { handler(a: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> };
type Opts = { hooks?: { PreToolUse?: { hooks: Hook[] }[] }; mcpServers?: Record<string, { instance: { _registeredTools: Record<string, Tool> } }> };

function ledung(toggle = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-project-settings-')));
  const at = (d: string) => path.join(root, 'missing', d);
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    userName: 'Simon',
    workflows: [
      { name: 'flow', folder: path.join(root, 'process'), managerFile: 'lead.md', sessionFile: 'worker.md', projectConfig: 'docs/CONFIG.md' },
      { name: 'other-flow', folder: path.join(root, 'other'), managerFile: 'm.md', sessionFile: 's.md', projectConfig: 'c.md' },
    ],
    projects: [
      { name: 'home', runner: 'local', path: at('home'), projectSettingsTools: toggle, managerGrant: 'ordinary code decisions', sensitive: { commandPatterns: ['deploy'] } },
      { name: 'other', runner: 'local', path: at('other'), sensitive: { commandPatterns: ['deploy'] } },
      { name: 'island', runner: 'local', path: at('island'), lockdown: { level: 'A' } },
    ],
  }), store, () => {}));
  const start = async (project: string) => {
    const s = await manager.start(project, undefined, { role: 'manager' });
    store.updateSession(s.id, { status: 'running' });
    return s.id;
  };
  const live = (id: string) => (manager as unknown as { live: Map<string, { claudeOptions(h: object): Promise<Opts>; onPermission(t: string, i: object, o: object): Promise<unknown>; decide(id: string, d: { behavior: 'allow'; scope: 'once' }, by: string): boolean }> }).live.get(id)!;
  const options = (id: string) => live(id).claudeOptions({ onLine: () => {}, onStderr: () => {} });
  /** The tool itself, as Claude Code runs it once the hook (or the user) allowed it. */
  const run = async (id: string, tool: string, input: Record<string, unknown> = {}) => {
    const r = await (await options(id)).mcpServers!.ledung!.instance._registeredTools[tool]!.handler(input);
    return { text: r.content[0]!.text, error: r.isError === true };
  };
  /** A set_project_settings call: the hook's decision, and the tool's answer when the hook allowed it. */
  const change = async (id: string, input: Record<string, unknown>) => {
    const out = await (await options(id)).hooks!.PreToolUse![0]!.hooks[0]!({ tool_name: 'mcp__ledung__set_project_settings', tool_input: input }, 'tu');
    const decision = out.hookSpecificOutput?.permissionDecision ?? null;
    const reason = out.hookSpecificOutput?.permissionDecisionReason ?? '';
    return { decision, reason, result: decision === 'allow' ? await run(id, 'set_project_settings', input) : null };
  };
  const project = (name: string) => manager.projects().find((p) => p.name === name)!;
  return { manager, store, start, run, change, project, live, at };
}

test('with the toggle off, the manager reads and changes nothing', async () => {
  const { start, run, change, project } = ledung(false);
  const id = await start('home');
  const read = await run(id, 'project_settings');
  assert.equal(read.error, true);
  assert.match(read.text, /off for your project\. Simon can switch it on/);
  const c = await change(id, { project: 'other', questionTiers: ['Now'] });
  assert.equal(c.decision, 'deny', 'refused, not asked');
  assert.match(c.reason, /off for your project/);
  assert.deepEqual(project('other').questionTiers.length, 5, 'unchanged');
});

test('reads are free: every project that is not locked, the own one too, with the workflow it follows; a locked one only by name', async () => {
  const { start, run } = ledung();
  const id = await start('home');
  const all = JSON.parse((await run(id, 'project_settings')).text);
  assert.deepEqual(Object.keys(all).sort(), ['home', 'island', 'other']);
  assert.equal(all.island, 'locked');
  assert.equal(all.home.managerGrant, 'ordinary code decisions');
  assert.equal(all.other.sensitive.commandPatterns[0], 'deploy');
  assert.equal(all.other.followsWorkflow.name, 'flow', 'the first workflow, as a project naming none follows');
  assert.equal(all.other.followsWorkflow.managerFile, 'lead.md');
  const one = await run(id, 'project_settings', { project: 'island' });
  assert.equal(one.error, true);
  assert.match(one.text, /"island" is locked: no manager reads or changes its settings/);
});

test('a change that loosens nothing runs at once and is saved as the page saves it', async () => {
  const { start, change, project } = ledung();
  const id = await start('home');
  const had = project('other').sensitive.commandPatterns;
  const c = await change(id, { project: 'other', questionTiers: ['Now', 'Later'], workflow: { name: 'other-flow' }, sensitive: { commandPatterns: [...had, 'gh pr merge'] } });
  assert.equal(c.decision, 'allow');
  assert.equal(c.result!.error, false, c.result!.text);
  assert.match(c.result!.text, /Saved workflow, questionTiers, sensitive for "other"/);
  const other = project('other');
  assert.deepEqual(other.questionTiers, ['Now', 'Later']);
  assert.equal(other.workflow?.name, 'other-flow');
  assert.deepEqual(other.sensitive.commandPatterns, [...had, 'gh pr merge']);
  // Its own project too, and clearing its own grant tightens.
  const own = await change(id, { project: 'home', managerGrant: null });
  assert.equal(own.decision, 'allow');
  assert.equal(project('home').managerGrant, null);
  // What the page would refuse is refused before anything runs.
  const bad = await change(id, { project: 'other', workflow: { name: 'no-such-flow' } });
  assert.equal(bad.decision, 'deny');
  assert.match(bad.reason, /no workflow named "no-such-flow"/);
});

test('a new grant, its own included, a new dev ship command or a removed pattern is asked of the user, with before and after', async () => {
  const { start, change, project, live, store, run } = ledung();
  const id = await start('home');
  for (const [input, before] of [
    [{ project: 'home', managerGrant: 'may merge anything' }, /manager grant "ordinary code decisions" → "may merge anything"/],
    [{ project: 'other', managerGrant: 'may merge anything' }, /"other" that loosens what reaches you: manager grant none → "may merge anything"/],
    [{ project: 'other', devShipCommand: '.*' }, /dev ship command none → ".\*"/],
    [{ project: 'other', sensitive: { commandPatterns: [] } }, /sensitive command patterns removed: "deploy", /],
  ] as const) {
    const c = await change(id, input);
    assert.equal(c.decision, 'ask', JSON.stringify(input));
    assert.match(c.reason, before);
  }
  assert.equal(project('home').managerGrant, 'ordinary code decisions', 'nothing ran');
  assert.equal(project('other').managerGrant, null);
  // Claude Code hands an asked call to Ledung's permission flow: a sensitive prompt that only the user allows,
  // whatever grant the manager has, with what it loosens on it.
  void live(id).onPermission('mcp__ledung__set_project_settings', { project: 'home', managerGrant: 'may merge anything' }, { signal: new AbortController().signal, toolUseID: 'tu-x' });
  const asked = store.pendingPermissions().find((p) => p.sessionId === id)!;
  assert.equal(asked.addressedTo, 'user');
  assert.match(asked.sensitive!, /manager grant "ordinary code decisions" → "may merge anything"/);
  // Without the user's allow the tool itself refuses it too, whatever let the call through (review of #306, M3).
  const unallowed = await run(id, 'set_project_settings', { project: 'home', managerGrant: 'may merge anything' });
  assert.equal(unallowed.error, true);
  assert.match(unallowed.text, /Simon did not allow it; nothing was saved/);
  // Once the user allows it, the tool saves it.
  assert.ok(live(id).decide(asked.id, { behavior: 'allow', scope: 'once' }, 'user'));
  const approved = await run(id, 'set_project_settings', { project: 'home', managerGrant: 'may merge anything' });
  assert.equal(approved.error, false, approved.text);
  assert.equal(project('home').managerGrant, 'may merge anything');
  // One allow, one save.
  const again = await run(id, 'set_project_settings', { project: 'home', managerGrant: 'may merge anything' });
  assert.match(again.text, /Nothing to change/);
});

test('an allowed change that would loosen more than its prompt showed, because the project changed meanwhile, is refused', async () => {
  const { start, change, run, live, store, manager, project, at } = ledung();
  const id = await start('home');
  const had = project('other').sensitive.commandPatterns;
  const input = { project: 'other', sensitive: { commandPatterns: had.filter((p) => p !== 'deploy') } };
  assert.equal((await change(id, input)).decision, 'ask');
  void live(id).onPermission('mcp__ledung__set_project_settings', input, { signal: new AbortController().signal, toolUseID: 'tu-y' });
  const asked = store.pendingPermissions().find((p) => p.sessionId === id)!;
  assert.match(asked.sensitive!, /sensitive command pattern removed: "deploy"$/);
  // While the prompt waits, the user adds a pattern in the page; the call's list would now remove it too.
  manager.updateProject('other', parseProject({ name: 'other', runner: 'local', path: at('other'), sensitive: { commandPatterns: [...had, 'rm -rf'] } }));
  assert.ok(live(id).decide(asked.id, { behavior: 'allow', scope: 'once' }, 'user'));
  const late = await run(id, 'set_project_settings', input);
  assert.equal(late.error, true);
  assert.match(late.text, /changed while Simon was asked, so this change now loosens more than they allowed; nothing was saved/);
  assert.deepEqual(project('other').sensitive.commandPatterns, [...had, 'rm -rf']);
});

test("a workflow config path outside the target project's folder is refused, relative or absolute", async () => {
  const { start, change, project, at } = ledung();
  const id = await start('home');
  for (const projectConfig of ['../home/steer.md', '..\home\steer.md', at('home/steer.md'), '/etc/steer.md', 'docs/../../home/steer.md']) {
    const c = await change(id, { project: 'other', workflow: { name: 'flow', projectConfig } });
    assert.equal(c.decision, 'deny', projectConfig);
    assert.match(c.reason, /projectConfig must be a path inside the project's folder/, projectConfig);
  }
  assert.equal(project('other').workflow, null, 'nothing saved');
  // Inside it, relative: runs.
  const ok = await change(id, { project: 'other', workflow: { name: 'flow', projectConfig: 'docs/agents/CONFIG.md' } });
  assert.equal(ok.decision, 'allow');
  assert.equal(project('other').workflow?.projectConfig, 'docs/agents/CONFIG.md');
});

test('a change the hook let through is refused if the settings changed meanwhile so that it now loosens', async () => {
  const { start, run, manager, project, at, live } = ledung();
  const id = await start('home');
  const had = project('other').sensitive.commandPatterns;
  const input = { project: 'other', sensitive: { commandPatterns: had }, questionTiers: ['Now'] };
  const { hooks } = await live(id).claudeOptions({ onLine: () => {}, onStderr: () => {} });
  const out = await hooks!.PreToolUse![0]!.hooks[0]!({ tool_name: 'mcp__ledung__set_project_settings', tool_input: input }, 'tu-2');
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'allow', 'the same pattern list and new tiers: unasked');
  // Before the tool runs, the user adds a pattern in the page: the list the call gives would now remove it.
  manager.updateProject('other', parseProject({ name: 'other', runner: 'local', path: at('other'), sensitive: { commandPatterns: [...had, 'rm -rf'] } }));
  const late = await run(id, 'set_project_settings', input);
  assert.equal(late.error, true);
  assert.match(late.text, /changed meanwhile, and this change now loosens what reaches Simon; nothing was saved/);
  assert.deepEqual(project('other').sensitive.commandPatterns, [...had, 'rm -rf']);
});

test('locked projects, its own included, are refused outright, and nothing outside the workflow fields can be changed', async () => {
  const { start, change, project, manager, at } = ledung();
  const id = await start('home');
  const locked = await change(id, { project: 'island', questionTiers: ['Now'] });
  assert.equal(locked.decision, 'deny', 'refused, not asked');
  assert.match(locked.reason, /"island" is locked/);
  for (const field of [{ lockdown: { level: 'off' } }, { projectToolsUnasked: true }, { projectSettingsTools: true }, { permissionMode: 'auto' }, { account: 'x' }, { path: '/elsewhere' }]) {
    const c = await change(id, { project: 'other', ...field });
    assert.equal(c.decision, 'deny', JSON.stringify(field));
    assert.match(c.reason, /set_project_settings changes only managerGrant, workflow, questionTiers, sensitive, devShipCommand, tickets/);
  }
  assert.equal(project('other').projectToolsUnasked, false);
  // A locked project's own manager is refused too: its settings are the user's, in the page.
  manager.updateProject('home', parseProject({ name: 'home', runner: 'local', path: at('home'), projectSettingsTools: true, lockdown: { level: 'A' } }));
  const own = await change(id, { project: 'home', questionTiers: ['Now'] });
  assert.equal(own.decision, 'deny');
  assert.match(own.reason, /"home" is locked/);
  // It may still change projects that aren't locked (level A reaches out).
  assert.equal((await change(id, { project: 'other', questionTiers: ['Now'] })).decision, 'allow');
});
