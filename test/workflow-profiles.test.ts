// Session profiles from the workflow (#298, Martin's decision of 2026-10-23, question #700): the workflow's profiles
// file, a missing or bad one, a computer's override, plugin ids that aren't installed, and the order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseConfig } from '../src/config.ts';
import { Management } from '../src/sessions/management.ts';
import { SessionManager, UserError } from '../src/sessions/manager.ts';
import type { SessionInfo } from '../src/shared/protocol.ts';
import { profileOptions, ProfileSetting, type Profile } from '../src/sessions/profiles.ts';
import { withSkillsOff } from '../src/sessions/skills.ts';
import { effectiveProfiles, parseWorkflowProfiles, readWorkflowProfiles } from '../src/sessions/workflow-profiles.ts';
import { workflowInstructions, type ProjectWorkflow } from '../src/sessions/workflow.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

/** A workflow's file as the decision describes it: lead and slim, with defaults and Anthropic's two plugins off. */
const WORKFLOW = {
  $about: 'A comment, ignored like the config\'s.',
  version: 1,
  defaultProfiles: { manager: 'lead', session: 'slim' },
  pluginsOff: ['session-report@claude-plugins-official'],
  profiles: {
    $note: 'also ignored',
    lead: { about: 'Managers', settings: { syncClaudeAiSkills: false } },
    slim: { about: 'Workers', mcpServers: 'none', plugins: 'none', disallowedTools: ['Workflow', 'Artifact'], settings: { enableArtifact: false } },
    deploy: { mcpServers: 'none', plugins: 'none', settings: { permissions: { allow: ['Bash(deploy)'] } } },
  },
};

const NO_COMPUTER = { profiles: {}, defaultProfiles: {}, pluginsOff: [] };

test("the workflow's profiles file is read: its profiles in Ledung's schema with inline settings, its defaults and pluginsOff; \"$\" keys are comments", () => {
  const read = parseWorkflowProfiles('profiles.json', JSON.stringify(WORKFLOW));
  assert.equal(read.problem, null);
  const p = effectiveProfiles(NO_COMPUTER, read);
  assert.deepEqual(Object.keys(p.profiles), ['lead', 'slim', 'deploy']);
  assert.deepEqual(p.profiles.slim, {
    about: 'Workers', mcpServers: 'none', plugins: 'none', disallowedTools: ['Workflow', 'Artifact'], userSettings: true, settings: { enableArtifact: false },
  });
  // A field the file leaves out gets Ledung's default, as in the config.
  assert.deepEqual(p.profiles.lead, { about: 'Managers', mcpServers: 'all', plugins: 'all', disallowedTools: [], userSettings: true, settings: { syncClaudeAiSkills: false } });
  assert.deepEqual(p.defaults, { manager: 'lead', session: 'slim' });
  assert.deepEqual(p.pluginsOff, ['session-report@claude-plugins-official']);
  assert.deepEqual(p.sources, { lead: 'workflow', slim: 'workflow', deploy: 'workflow' });
  assert.equal(p.warning, null);
});

test("a profile's inline settings go in the flag layer under the settings file's, and the skill picker's off skills on top (#300)", () => {
  const p = ProfileSetting.parse({ plugins: 'none', settings: { syncClaudeAiSkills: false, model: 'a', skillOverrides: { mine: 'name-only' } } });
  const settings = profileOptions(p, ['x@m'], { model: 'b' }).settings as Record<string, unknown>;
  assert.deepEqual(settings, { syncClaudeAiSkills: false, model: 'b', skillOverrides: { mine: 'name-only' }, enabledPlugins: { 'x@m': false } }, 'the file wins over the profile on model');
  assert.deepEqual(withSkillsOff(settings, ['blocket'])!.skillOverrides, { mine: 'name-only', blocket: 'off' });
});

test("a missing or bad profiles file leaves this computer's profiles, with a warning naming the file: never a silent full", () => {
  const computer = { profiles: { mine: { plugins: 'none' as const } }, defaultProfiles: { session: 'mine' }, pluginsOff: ['ts@m'] };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-wf-profiles-'));
  try {
    const missing = readWorkflowProfiles({ folder, profilesFile: 'process/profiles.json' })!;
    assert.match(missing.problem!, /profiles\.json was not found/);
    const bad: [string, RegExp][] = [
      ['{ "version": 1, "profiles": ', /is not valid JSON/],
      [JSON.stringify({ ...WORKFLOW, version: 2 }), /version: version must be 1/],
      [JSON.stringify({ version: 1 }), /profiles:/],
      [JSON.stringify({ version: 1, profiles: { full: {} } }), /"full" is built in/],
      [JSON.stringify({ version: 1, profiles: { s: { disallowedTools: ['mcp__ledung__ask_user'] } } }), /Ledung's own tools always stay/],
      [JSON.stringify({ version: 1, profiles: { s: { plugins: 'some' } } }), /profiles\.s\.plugins/],
      [JSON.stringify({ version: 1, defaultProfiles: { session: 'nope' }, profiles: {} }), /defaultProfiles\.session: no profile named "nope"/],
    ];
    for (const [text, why] of [...bad]) {
      fs.mkdirSync(path.join(folder, 'process'), { recursive: true });
      fs.writeFileSync(path.join(folder, 'process', 'profiles.json'), text);
      const read = readWorkflowProfiles({ folder, profilesFile: 'process/profiles.json' })!;
      assert.match(read.problem!, why, text);
      assert.ok(read.problem!.includes(path.join(folder, 'process', 'profiles.json')), 'the message names the file');
    }
    for (const read of [missing, parseWorkflowProfiles('p.json', '[]')]) {
      const p = effectiveProfiles(computer, read);
      assert.deepEqual(Object.keys(p.profiles), ['mine']);
      assert.deepEqual(p.defaults, { session: 'mine' });
      assert.deepEqual(p.pluginsOff, ['ts@m']);
      assert.match(p.warning!, /Sessions use this computer's own profiles until it is fixed\./);
    }
    // No profilesFile: nothing is read and nothing is wrong (today's behaviour).
    assert.equal(readWorkflowProfiles({ folder }), null);
    assert.equal(effectiveProfiles(computer, null).warning, null);
  } finally {
    removeTemp(folder);
  }
});

test("a profile's settings can't deny Ledung's tools or put them behind a prompt, in the workflow's file or the config", () => {
  const file = (settings: object) => JSON.stringify({ version: 1, profiles: { s: { settings } } });
  for (const [settings, why] of [
    [{ permissions: { deny: ['mcp__ledung'] } }, /profiles\.s\.settings\.permissions\.deny: Ledung's own tools always stay \(mcp__ledung\)/],
    [{ permissions: { deny: ['Bash(rm:*)', 'mcp__ledung__*'] } }, /permissions\.deny: .*\(mcp__ledung__\*\)/],
    // The file takes no ask rules at all (question #708); the config refuses this one for being Ledung's.
    [{ permissions: { ask: ['mcp__ledung__ask_user'] } }, /permissions\.ask/],
    [{ permissions: { deny: ['mcp__*'] } }, /permissions\.deny/],
  ] as const) {
    assert.match(parseWorkflowProfiles('p.json', file(settings)).problem!, why);
    assert.throws(() => parseConfig({ profiles: { s: { settings } } }), why);
  }
  assert.throws(() => parseConfig({ profiles: { s: { settings: { permissions: { ask: ['mcp__ledung__ask_user'] } } } } }), /permissions\.ask: Ledung's own tools always stay/);
  // Other servers' tools and built-ins may be denied (and, in the config, asked).
  const fine = { permissions: { deny: ['mcp__other__x', 'Bash(rm:*)', 'mcp__ledungish'], allow: ['mcp__ledung__ask_user'] } };
  assert.equal(parseWorkflowProfiles('p.json', file(fine)).problem, null);
  assert.doesNotThrow(() => parseConfig({ profiles: { s: { settings: { ...fine, permissions: { ...fine.permissions, ask: ['WebFetch'] } } } } }));
});

test("no wildcard or spelling takes Ledung's tools away, through disallowedTools or a deny rule (review round 2 of #298)", () => {
  const taking = ['mcp__*', '*', 'mcp__led*', 'mcp__ledung*', 'mcp*', 'MCP__LEDUNG', 'Mcp__Ledung__Ask_User', '*ask_user', 'mcp__ledung__*(x)'];
  for (const rule of taking) {
    assert.throws(() => parseConfig({ profiles: { s: { disallowedTools: [rule] } } }), /disallowedTools: Ledung's own tools always stay/, rule);
    assert.match(parseWorkflowProfiles('p.json', JSON.stringify({ version: 1, profiles: { s: { disallowedTools: [rule] } } })).problem!, /Ledung's own tools always stay/, rule);
    assert.throws(() => parseConfig({ profiles: { s: { settings: { permissions: { deny: [rule] } } } } }), /permissions\.deny: Ledung's own tools always stay/, rule);
  }
  // Wildcards that can't reach Ledung's tools stay usable.
  const fine = ['mcp__other__*', 'mcp__o*', 'Bash*', 'Workflow', 'mcp__ledungish', 'mcp__ledungish__*'];
  assert.doesNotThrow(() => parseConfig({ profiles: { s: { disallowedTools: fine, settings: { permissions: { deny: fine } } } } }));
});

test("a workflow file's inline settings take only the allowed keys (Martin, question #708); any other makes the file invalid, naming the key", () => {
  const file = (settings: object) => JSON.stringify({ version: 1, profiles: { s: { settings } } });
  const allowed = {
    syncClaudeAiSkills: false, enableArtifact: false, skillOverrides: { notes: 'off' }, claudeMdExcludes: ['**/x.md'], model: 'haiku',
    permissions: { allow: ['Bash(deploy)'], deny: ['WebFetch'] },
  };
  assert.equal(parseWorkflowProfiles('p.json', file(allowed)).problem, null);
  for (const [settings, key] of [
    [{ hooks: { PreToolUse: [] } }, 'profiles.s.settings.hooks'],
    [{ disableAllHooks: true }, 'profiles.s.settings.disableAllHooks'],
    [{ env: { ANTHROPIC_BASE_URL: 'http://x' } }, 'profiles.s.settings.env'],
    [{ apiKeyHelper: 'get-key.sh' }, 'profiles.s.settings.apiKeyHelper'],
    [{ permissions: { defaultMode: 'bypassPermissions' } }, 'profiles.s.settings.permissions.defaultMode'],
    // Nested keys are held to the list too.
    [{ permissions: { allow: [], additionalDirectories: ['/'] } }, 'profiles.s.settings.permissions.additionalDirectories'],
  ] as const) {
    const read = parseWorkflowProfiles('p.json', file(settings));
    assert.ok(read.problem?.includes(`${key} is not allowed in a workflow's profiles file`), `${key}: ${read.problem}`);
    // So the fallback and its warning apply, naming the key.
    assert.ok(effectiveProfiles(NO_COMPUTER, read).warning!.includes(key));
  }
  assert.match(parseWorkflowProfiles('p.json', file({ permissions: { allow: 'Bash(*)' } })).problem!, /permissions\.allow must be a list of rules/);
  // The computer's own config is the user's, and keeps settingsFile's reach.
  assert.doesNotThrow(() => parseConfig({ profiles: { s: { settings: { env: { X: '1' } } } } }));
});

test("a computer's profile of the same name changes the workflow's field by field; a new name is the computer's own", () => {
  const read = parseWorkflowProfiles('profiles.json', JSON.stringify(WORKFLOW));
  const computer = parseConfig({ profiles: { slim: { disallowedTools: ['Workflow'] }, private: { about: 'Mine', mcpServers: 'none' } } });
  const p = effectiveProfiles(computer, read);
  // disallowedTools replaced (lists are not unioned); everything slim's computer entry leaves out stays the workflow's.
  assert.deepEqual(p.profiles.slim, {
    about: 'Workers', mcpServers: 'none', plugins: 'none', disallowedTools: ['Workflow'], userSettings: true, settings: { enableArtifact: false },
  });
  assert.deepEqual(p.profiles.private, { about: 'Mine', mcpServers: 'none', plugins: 'all', disallowedTools: [], userSettings: true });
  assert.deepEqual(p.sources, { lead: 'workflow', slim: 'workflow+computer', deploy: 'workflow', private: 'computer' });
});

test("pluginsOff are the workflow's and the computer's together, and an id this computer doesn't have is skipped quietly", () => {
  const read = parseWorkflowProfiles('profiles.json', JSON.stringify({ ...WORKFLOW, pluginsOff: ['a@m', 'gone@m'] }));
  const p = effectiveProfiles({ profiles: {}, defaultProfiles: {}, pluginsOff: ['a@m', 'b@m', 'mem@m'] }, read);
  assert.deepEqual(p.pluginsOff, ['a@m', 'gone@m', 'b@m', 'mem@m']);
  // Installed here: a, b and x. gone@m and mem@m (the Mac has no claude-mem) are not written at all.
  const full = ProfileSetting.parse({});
  assert.deepEqual(profileOptions(full, ['a@m', 'b@m', 'x@m'], undefined, p.pluginsOff).settings, { enabledPlugins: { 'a@m': false, 'b@m': false } });
  assert.deepEqual(profileOptions(full, [], undefined, p.pluginsOff), {}, 'none installed: no settings layer at all');
});

/** A Ledung whose one workflow names a profiles file in a temp folder, with project p following it. */
function managerWith(config: object, file: object | string | null, store = new Store(openDatabase(':memory:'))) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-wf-'));
  if (file !== null) fs.writeFileSync(path.join(folder, 'profiles.json'), typeof file === 'string' ? file : JSON.stringify(file));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    userName: 'Simon',
    workflow: { folder, managerFile: 'lead.md', sessionFile: 'worker.md', projectConfig: 'LEAD-CONFIG.md', profilesFile: 'profiles.json' },
    // The project folder doesn't exist, so a session ends at once; what it was started with is what counts here.
    projects: [{ name: 'p', runner: 'local', path: path.join(folder, 'missing-project') }],
    ...config,
  }), store, () => {}));
  return { store, manager, folder, cleanup: () => removeTemp(folder) };
}

test('order, later wins: full → the workflow\'s file → the computer\'s config → the project\'s settings → start_session', async () => {
  const profile = async (m: SessionManager, store: Store, opts: { role?: 'manager' | 'session'; profile?: string } = {}) => {
    const s = await m.start('p', undefined, opts);
    const name = store.getSession(s.id)!.profile;
    if (opts.role === 'manager') store.updateSession(s.id, { status: 'ended' });
    return name;
  };
  // Without a file: full.
  const none = managerWith({}, { version: 1, profiles: {} });
  try {
    assert.equal(await profile(none.manager, none.store), 'full');
  } finally {
    none.cleanup();
  }
  // The workflow's defaults per role.
  const wf = managerWith({}, WORKFLOW);
  try {
    assert.equal(await profile(wf.manager, wf.store), 'slim');
    assert.equal(await profile(wf.manager, wf.store, { role: 'manager' }), 'lead');
  } finally {
    wf.cleanup();
  }
  // The computer's default over the workflow's, for its role only; the project's over that; start_session's over all.
  const all = managerWith({ defaultProfiles: { session: 'deploy' } }, WORKFLOW);
  try {
    assert.equal(await profile(all.manager, all.store), 'deploy');
    assert.equal(await profile(all.manager, all.store, { role: 'manager' }), 'lead');
    const p = all.manager.projects().find((x) => x.name === 'p')!;
    all.manager.updateProject('p', { name: 'p', runner: 'local', path: p.path!, sensitive: p.sensitive, profiles: { session: 'lead' } });
    assert.equal(await profile(all.manager, all.store), 'lead');
    assert.equal(await profile(all.manager, all.store, { profile: 'full' }), 'full');
    assert.equal(await profile(all.manager, all.store, { profile: 'slim' }), 'slim');
  } finally {
    all.cleanup();
  }
});

test("a session started and resumed gets the workflow's profile as this computer changes it, and the pluginsOff of both", async () => {
  const { store, manager, cleanup } = managerWith({ profiles: { slim: { userSettings: false } }, pluginsOff: ['mine@m'] }, WORKFLOW);
  try {
    const s = await manager.start('p');
    store.updateSession(s.id, { status: 'ended', claudeSessionId: 'claude-1' });
    await manager.resume(s.id);
    const live = (manager as unknown as { live: Map<string, { profile: Profile | undefined; pluginsOff: string[] }> }).live.get(s.id)!;
    assert.deepEqual(live.profile, {
      about: 'Workers', mcpServers: 'none', plugins: 'none', disallowedTools: ['Workflow', 'Artifact'], userSettings: false, settings: { enableArtifact: false },
    });
    assert.deepEqual(live.pluginsOff, ['session-report@claude-plugins-official', 'mine@m']);
  } finally {
    cleanup();
  }
});

test("with the workflow's file broken a start that needs its profile is refused saying why, the computer's own still start, and Settings shows the warning", async () => {
  const { store, manager, cleanup } = managerWith({ profiles: { mine: { plugins: 'none' } }, defaultProfiles: { session: 'slim' } }, '{ not json');
  try {
    await assert.rejects(manager.start('p'), (e: Error) => e instanceof UserError
      && /no session profile named "slim"/.test(e.message) && /profiles\.json is not valid JSON/.test(e.message));
    const s = await manager.start('p', undefined, { profile: 'mine' });
    assert.equal(store.getSession(s.id)!.profile, 'mine');
    // Not silent: the session's workflow instructions carry the problem at every start and resume...
    const live = (manager as unknown as { live: Map<string, { workflow: ProjectWorkflow | null }> }).live.get(s.id)!;
    assert.match(workflowInstructions(live.workflow!, 'session'), /profiles\.json is not valid JSON.*this computer's own profiles until it is fixed\.$/);
    // Only a manager is asked to report it, so workers don't each open a question about it (review of #298).
    assert.match(workflowInstructions(live.workflow!, 'manager'), /until it is fixed\. Tell whoever you ask \(ask_user\) once\.$/);
    // ...and a manager's start_session refusal names it (the reply to a start that went through: next test).
    store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager: p', parentId: null, permissionMode: 'default', role: 'manager' });
    const management = (manager as unknown as { management: { startSession(id: string, a: { task: string; profile?: string }): Promise<string> } }).management;
    await assert.rejects(management.startSession('mgr', { task: 'x' }), /no session profile named "slim".*is not valid JSON/);
    const view = manager.profilesView();
    assert.equal(view.groups[0]!.workflow, 'default');
    assert.match(view.groups[0]!.warning!, /is not valid JSON.*this computer's own profiles/);
    assert.deepEqual(view.groups[0]!.profiles.map((p) => [p.name, p.source]), [['mine', 'computer']]);
  } finally {
    cleanup();
  }
});

test("a manager's start_session reply carries the profiles file's problem, so the manager hears of it at its next start", async () => {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager: p', parentId: null, permissionMode: 'default', role: 'manager' });
  const started = { id: 'w', title: 'Worker', status: 'running', profile: 'full', workDir: null } as unknown as SessionInfo;
  for (const [warning, expect] of [['The file is broken.', / Note: The file is broken\.$/], [null, /nothing running\.$/]] as const) {
    const management = new Management({
      store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async () => {},
      startSession: async () => started, profilesWarning: () => warning,
      stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p'], decidePermission: () => true,
      machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
      setPriority: () => {}, setPaused: () => {}, handoffProblem: () => null, shotPath: (_id, file) => file,
      projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
      ensureManager: async () => { throw new Error('not used'); },
    });
    assert.match(await management.startSession('mgr', { task: 'x' }), expect);
  }
});

test("Settings and the page's profile lists show the workflow's profiles with where each comes from", () => {
  const { manager, cleanup } = managerWith({ profiles: { slim: { disallowedTools: [] }, private: {} }, pluginsOff: ['mine@m'] }, WORKFLOW);
  try {
    assert.deepEqual(manager.profileNames(), ['full', 'lead', 'slim', 'deploy', 'private']);
    const [workflow, others] = manager.profilesView().groups;
    assert.equal(workflow!.workflow, 'default');
    assert.equal(workflow!.warning, null);
    assert.deepEqual(workflow!.profiles.map((p) => [p.name, p.source]), [['lead', 'workflow'], ['slim', 'workflow+computer'], ['deploy', 'workflow'], ['private', 'computer']]);
    // Each profile's allow rules, so a loosening shows (question #708).
    assert.deepEqual(workflow!.profiles.map((p) => [p.name, p.allow]), [['lead', []], ['slim', []], ['deploy', ['Bash(deploy)']], ['private', []]]);
    assert.deepEqual(workflow!.defaults, { manager: 'lead', session: 'slim' });
    assert.deepEqual(workflow!.pluginsOff, ['session-report@claude-plugins-official', 'mine@m']);
    // Chats and projects outside the workflow: the computer's own only.
    assert.equal(others!.workflow, null);
    assert.deepEqual(others!.profiles.map((p) => [p.name, p.source]), [['slim', 'computer'], ['private', 'computer']]);
    assert.deepEqual(others!.defaults, { manager: null, session: null });
    // The page's profile pickers: a project following the workflow lists its profiles; one out of it, the computer's only.
    assert.deepEqual(manager.projects().find((p) => p.name === 'p')!.profileNames, ['full', 'lead', 'slim', 'deploy', 'private']);
    const p = manager.projects().find((x) => x.name === 'p')!;
    const out = manager.updateProject('p', { name: 'p', runner: 'local', path: p.path!, sensitive: p.sensitive, workflow: { use: false } });
    assert.deepEqual(out.profileNames, ['full', 'slim', 'private']);
  } finally {
    cleanup();
  }
});

test("Settings lists a profile's own MCP servers with what each runs or reaches, as it lists allow rules", () => {
  const { manager, cleanup } = managerWith({}, { version: 1, profiles: {
    web: { mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@0.0.83', '--headless'] }, docs: { type: 'http', url: 'https://docs.example/mcp' } } },
    slim: { mcpServers: 'none' },
  } });
  try {
    assert.deepEqual(manager.profilesView().groups[0]!.profiles.map((p) => [p.name, p.mcp]), [
      ['web', ['playwright: npx @playwright/mcp@0.0.83 --headless', 'docs: https://docs.example/mcp']], ['slim', []],
    ]);
  } finally {
    cleanup();
  }
});

test("the config takes a workflow's profilesFile, and then lets defaultProfiles name a profile only the workflow has", () => {
  const workflow = { folder: '/wf', managerFile: 'l.md', sessionFile: 'w.md', projectConfig: 'c.md' };
  assert.equal(parseConfig({ workflow: { ...workflow, profilesFile: 'process/profiles.json' } }).workflow!.profilesFile, 'process/profiles.json');
  assert.deepEqual(parseConfig({ workflow: { ...workflow, profilesFile: 'p.json' }, defaultProfiles: { session: 'slim' } }).defaultProfiles, { session: 'slim' });
  assert.throws(() => parseConfig({ workflow, defaultProfiles: { session: 'slim' } }), /defaultProfiles.session: no profile named "slim"/);
});
