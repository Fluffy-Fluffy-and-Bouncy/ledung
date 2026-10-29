// Session profiles (#20): what a session gets of the user's own setup, chosen per project and role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseConfig, type LocalProjectConfig } from '../src/config.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { Management } from '../src/sessions/management.ts';
import { defaultModelFor, SessionManager, UserError } from '../src/sessions/manager.ts';
import { chooseProfile, parseSettingsFile, pluginIdsIn, profileByName, profileOptions, ProfileSetting, settingsFilePath, settingsFileProblem, validateProfiles, type Profile } from '../src/sessions/profiles.ts';
import { Session, type SessionSkills } from '../src/sessions/session.ts';
import { LEDUNG_SERVER, MCP_INSTRUCTIONS_LIMIT, MCP_LIMIT_ENV } from '../src/sessions/tools.ts';
import type { PermissionMode } from '../src/shared/protocol.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const slim = ProfileSetting.parse({ mcpServers: 'none', plugins: 'none', disallowedTools: ['Workflow', 'ReportFindings', 'SendFeedback'] });
const profiles = { slim, docs: ProfileSetting.parse({ plugins: ['superpowers@official'] }) };

test('slim: only Ledung\'s MCP server, every plugin found turned off, the named tools taken away', () => {
  const o = profileOptions(slim, ['a@m', 'b@m']);
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.settings, { enabledPlugins: { 'a@m': false, 'b@m': false } });
  assert.deepEqual(o.disallowedTools, ['Workflow', 'ReportFindings', 'SendFeedback']);
  assert.equal(o.settingSources, undefined, "the user's settings are still read: their allow rules stay");
  assert.equal(o.mcpServers, undefined);
});

test('full (and a profile that names nothing) changes nothing', () => {
  assert.deepEqual(profileOptions(profileByName('full', profiles), ['a@m']), {});
  assert.deepEqual(profileOptions(ProfileSetting.parse({}), ['a@m']), {});
});

test('a plugin list keeps those plugins and turns the rest off; servers of its own imply strict; userSettings false drops the user source', () => {
  assert.deepEqual(profileOptions(profiles.docs, ['superpowers@official', 'x@m']).settings, { enabledPlugins: { 'x@m': false } });
  const own = profileOptions(ProfileSetting.parse({ mcpServers: { pw: { command: 'npx', args: ['@playwright/mcp'] } }, userSettings: false }), []);
  assert.equal(own.strictMcpConfig, true);
  assert.deepEqual(Object.keys(own.mcpServers ?? {}), ['pw']);
  assert.deepEqual(own.settingSources, ['project', 'local']);
});

test('the config\'s pluginsOff go off whatever the profile: full, a keep list, and over the settings file (issue #265)', () => {
  // Only where installed (#298 decision 7): ts@m is among the ids found, so it goes off on full too.
  assert.deepEqual(profileOptions(profileByName('full', profiles), ['ts@m'], undefined, ['ts@m']), { settings: { enabledPlugins: { 'ts@m': false } } });
  assert.deepEqual(profileOptions(ProfileSetting.parse({ plugins: ['ts@m', 'x@m'] }), ['ts@m', 'x@m', 'y@m'], undefined, ['ts@m']).settings,
    { enabledPlugins: { 'y@m': false, 'ts@m': false } }, 'kept by the profile, off all the same');
  assert.deepEqual(profileOptions(slim, ['ts@m'], { model: 'haiku', enabledPlugins: { 'ts@m': true } }, ['ts@m']).settings,
    { model: 'haiku', enabledPlugins: { 'ts@m': false } }, 'listed once, and wins over the settings file');
  assert.deepEqual(parseConfig({}).pluginsOff, []);
  assert.deepEqual(parseConfig({ pluginsOff: ['ts@m'] }).pluginsOff, ['ts@m']);
});

test('plugin ids come from enabledPlugins and installed plugins; files that are not JSON are skipped', () => {
  const ids = pluginIdsIn([
    JSON.stringify({ enabledPlugins: { 'a@m': true, 'b@m': false } }),
    JSON.stringify({ version: 2, plugins: { 'c@m': [{}] } }),
    'not json',
  ]);
  assert.deepEqual(ids, ['a@m', 'b@m', 'c@m']);
});

test('the profile is the one asked for, else the project\'s for the role, else the config default, else full', () => {
  const defaults = { session: 'slim' };
  assert.equal(chooseProfile('docs', 'session', { session: 'slim' }, defaults, profiles), 'docs');
  assert.equal(chooseProfile(undefined, 'session', { session: 'docs' }, defaults, profiles), 'docs');
  assert.equal(chooseProfile(undefined, 'session', { manager: 'docs' }, defaults, profiles), 'slim');
  assert.equal(chooseProfile(undefined, 'manager', undefined, defaults, profiles), 'full');
  assert.throws(() => chooseProfile('nope', 'session', undefined, defaults, profiles), /no session profile named "nope".*Known: full, slim, docs/);
});

test("the config refuses a profile that takes Ledung's tools, redefines full, or a default that doesn't exist", () => {
  assert.throws(() => validateProfiles({ bad: ProfileSetting.parse({ disallowedTools: ['mcp__ledung__ask_user'] }) }, {}), /Ledung's own tools always stay/);
  assert.throws(() => validateProfiles({ bad: ProfileSetting.parse({ disallowedTools: ['mcp__ledung'] }) }, {}), /Ledung's own tools always stay/);
  assert.throws(() => validateProfiles({ bad: ProfileSetting.parse({ mcpServers: { ledung: { command: 'x' } } }) }, {}), /Ledung's own server/);
  assert.throws(() => validateProfiles({ full: ProfileSetting.parse({}) }, {}), /built in/);
  assert.throws(() => parseConfig({ profiles: { slim: {} }, defaultProfiles: { session: 'slimmer' } }), /defaultProfiles.session: no profile named "slimmer"/);
  assert.deepEqual(parseConfig({ profiles: { slim: { plugins: 'none' } }, defaultProfiles: { session: 'slim' } }).defaultProfiles, { session: 'slim' });
});

test('the example config parses, with its "$" comments, and defines slim', () => {
  const example = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'ledung.config.example.json'), 'utf8'));
  const config = parseConfig(example);
  assert.deepEqual(Object.keys(config.profiles), ['slim']);
  assert.equal(config.profiles.slim!.mcpServers, 'none');
});

function managerWith(config: object, store = new Store(openDatabase(':memory:'))) {
  const folder = path.join(os.tmpdir(), 'ledung-profiles-test-missing-folder');
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    userName: 'Simon',
    profiles: { slim: { mcpServers: 'none', plugins: 'none' } },
    projects: [{ name: 'p', runner: 'local', path: folder }],
    ...config,
  }), store, () => {}));
  return { store, manager };
}

test('a session is started with the profile asked for and keeps it; an unknown one is refused before anything starts', async () => {
  const { store, manager } = managerWith({ defaultProfiles: { session: 'slim' } });
  // The folder doesn't exist, so the session ends at once; what it was started with is what counts here.
  const asked = await manager.start('p', undefined, { profile: 'full' });
  assert.equal(store.getSession(asked.id)!.profile, 'full');
  const byDefault = await manager.start('p');
  assert.equal(store.getSession(byDefault.id)!.profile, 'slim');
  const before = manager.sessions().length;
  await assert.rejects(manager.start('p', undefined, { profile: 'nope' }), (e: Error) => e instanceof UserError && /no session profile named "nope"/.test(e.message));
  assert.equal(manager.sessions().length, before, 'no session was created');
});

test("a project may only name profiles the config has, and its choice wins over the config's default", async () => {
  const { store, manager } = managerWith({});
  const p = manager.projects().find((x) => x.name === 'p')!;
  const config = { name: 'p', runner: 'local' as const, path: p.path!, sensitive: p.sensitive };
  assert.throws(() => manager.updateProject('p', { ...config, profiles: { session: 'nope' } }), /no session profile named "nope"/);
  assert.deepEqual(manager.updateProject('p', { ...config, profiles: { session: 'slim' } }).profiles, { manager: null, session: 'slim' });
  const s = await manager.start('p');
  assert.equal(store.getSession(s.id)!.profile, 'slim');
  assert.deepEqual(manager.profileNames(), ['full', 'slim']);
});

test("a manager's start_session with a profile name starts the session with it; an unknown name comes back as a clear refusal", async () => {
  const { store, manager } = managerWith({});
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager: p', parentId: null, permissionMode: 'default', role: 'manager' });
  // Through the manager's own tool handlers, as a manager session calls them.
  const management = (manager as unknown as { management: { startSession(id: string, a: { task: string; profile?: string }): Promise<string> } }).management;
  // The folder is missing, so the start ends at once and is reported as failed; the profile it got is stored first.
  await management.startSession('mgr', { task: 'look at the docs', profile: 'slim' }).catch(() => {});
  const started = store.childSessions('mgr');
  assert.equal(started.length, 1);
  assert.equal(started[0]!.profile, 'slim');
  await assert.rejects(management.startSession('mgr', { task: 'x', profile: 'nope' }), /no session profile named "nope"\. Known: full, slim\./);
  assert.equal(store.childSessions('mgr').length, 1, 'nothing started for the unknown name');
});

test('a resumed session gets the profile it was started with; one taken out of the config since stops the resume', async () => {
  const { store, manager } = managerWith({ defaultProfiles: { session: 'slim' } });
  // The folder is missing, so the session ends at once; as if Claude Code had got far enough to be resumed.
  const s = await manager.start('p');
  store.updateSession(s.id, { status: 'ended', claudeSessionId: 'claude-1' });
  await manager.resume(s.id);
  const live = (manager as unknown as { live: Map<string, { profile: Profile | undefined }> }).live;
  assert.deepEqual(live.get(s.id)!.profile, ProfileSetting.parse({ mcpServers: 'none', plugins: 'none' }), "slim's options, as the config defines them");
  assert.equal(store.getSession(s.id)!.profile, 'slim');

  // The same session after a restart with slim gone from the config.
  store.updateSession(s.id, { status: 'ended' });
  const { manager: without } = managerWith({ profiles: {} }, store);
  await assert.rejects(without.resume(s.id), (e: Error) => e instanceof UserError
    && e.message === 'There is no session profile named "slim". Known: full. The session was started with it.');
  assert.equal(store.getSession(s.id)!.profile, 'slim', 'the stored profile is left as it was');
});

/** A session in a project folder whose Claude settings name plugins a, b and c, logged in with its own config folder. */
function sessionOn(
  profile: Profile | undefined, role: 'session' | 'manager' = 'session',
  extra: { model?: string; defaultModel?: string; resume?: string; fileSettings?: Record<string, unknown>; permissionMode?: PermissionMode; pluginsOff?: string[]; skills?: SessionSkills } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-profiles-'));
  const configDir = path.join(root, 'config');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'a@m': true } }));
  fs.writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'b@m': [] } }));
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'c@m': true } }));
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
  const info = store.createSession({ id: 's', project: 'p', runner: 'local', title: 'Worker', parentId: null, permissionMode: extra.permissionMode ?? 'default', role });
  const session = new Session({
    info, store, publish: () => {}, userName: 'Simon', management, profile, pluginsOff: extra.pluginsOff, skills: extra.skills,
    model: extra.model, defaultModel: extra.defaultModel, resume: extra.resume,
    runner: new LocalRunner({ name: 'p', runner: 'local', path: project } as LocalProjectConfig),
    account: { name: 'own', env: { CLAUDE_CONFIG_DIR: configDir } },
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
  });
  // What start() and resume read from the settings file, set directly.
  (session as unknown as { fileSettings?: Record<string, unknown> }).fileSettings = extra.fileSettings;
  const options = () => session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  return { project, options, store, cleanup: () => removeTemp(root) };
}

// Every session's settings also deny Ledung's data folder (#104); these tests point it at a folder of their own.
function withDataDir<T>(run: (dataDir: string) => Promise<T>): Promise<T> {
  const own = process.env.LEDUNG_DATA_DIR;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-boundary-data-'));
  process.env.LEDUNG_DATA_DIR = dataDir;
  return run(dataDir).finally(() => {
    if (own === undefined) delete process.env.LEDUNG_DATA_DIR;
    else process.env.LEDUNG_DATA_DIR = own;
    removeTemp(dataDir);
  });
}

/** The settings' deny rules include reading and editing everything in the data folder. */
function deniesDataDir(settings: unknown, dataDir: string): void {
  const deny = (settings as { permissions?: { deny?: string[] } }).permissions?.deny ?? [];
  const name = path.basename(dataDir);
  for (const tool of ['Read', 'Edit']) {
    assert.ok(deny.some((r) => r.startsWith(`${tool}(/`) && r.endsWith(`/${name}/**)`)), `${tool} of the data folder is denied`);
  }
}

test("a session's Claude Code options carry its profile's, with Ledung's tool server added last", async () => {
  const s = sessionOn(ProfileSetting.parse({
    mcpServers: { docs: { command: 'docs-mcp' } }, plugins: ['a@m'], disallowedTools: ['Workflow'], userSettings: false,
  }));
  try {
    await withDataDir(async (dataDir) => {
      const o = await s.options();
      assert.equal(o.strictMcpConfig, true);
      assert.deepEqual(Object.keys(o.mcpServers ?? {}), ['docs', LEDUNG_SERVER], "the profile's server, then Ledung's");
      // b and c are named in the session's settings and not kept; a is kept. Beside them only Ledung's boundary (#104).
      const settings = o.settings as Record<string, unknown>;
      assert.deepEqual(settings.enabledPlugins, { 'b@m': false, 'c@m': false });
      assert.deepEqual(Object.keys(settings).filter((k) => !['permissions', 'sandbox'].includes(k)), ['enabledPlugins']);
      deniesDataDir(settings, dataDir);
      assert.deepEqual(o.disallowedTools, ['Workflow']);
      assert.deepEqual(o.settingSources, ['project', 'local']);
      // Ledung's own options are still there beside the profile's.
      assert.equal(o.cwd, s.project);
      assert.equal(o.permissionMode, 'default');
    });
  } finally {
    s.cleanup();
  }
});

test("the config's pluginsOff reach a session's settings on full and on slim alike (issue #265)", async () => {
  // b@m is installed in sessionOn's login folder; ts@m is not, so it is skipped (#298 decision 7).
  for (const [profile, off] of [[profileByName('full', {}), { 'b@m': false }], [slim, { 'a@m': false, 'b@m': false, 'c@m': false }]] as const) {
    const s = sessionOn(profile, 'session', { pluginsOff: ['b@m', 'ts@m'] });
    try {
      await withDataDir(async () => {
        assert.deepEqual(((await s.options()).settings as { enabledPlugins?: unknown }).enabledPlugins, off);
      });
    } finally {
      s.cleanup();
    }
  }
});

test("the skill picker's off skills reach a session's settings beside the settings file's own (#300); a skill no longer there is left out", async () => {
  const s = sessionOn(slim, 'session', {
    fileSettings: { skillOverrides: { mine: 'name-only' } },
    // ssh-box is ticked off but has gone from the computer: nothing is written for it.
    skills: { role: 'session', defaults: { session: { on: ['notes'] } }, project: { session: { off: ['ssh-box'] } } },
  });
  try {
    const skills = path.join(path.dirname(s.project), 'config', 'skills');
    for (const name of ['notes', 'blocket', 'travel']) {
      fs.mkdirSync(path.join(skills, name), { recursive: true });
      fs.writeFileSync(path.join(skills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill.\n---\n`);
    }
    fs.mkdirSync(path.join(skills, 'synced', 'acct', 'docx'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'synced', 'acct', 'docx', 'SKILL.md'), '---\ndescription: Word.\n---\n');
    await withDataDir(async () => {
      const settings = (await s.options()).settings as { skillOverrides?: unknown; enabledPlugins?: unknown };
      // Sessions' new skills are off: everything but notes, which Settings turns on.
      assert.deepEqual(settings.skillOverrides, { mine: 'name-only', blocket: 'off', docx: 'off', travel: 'off' });
      assert.deepEqual(settings.enabledPlugins, { 'a@m': false, 'b@m': false, 'c@m': false }, 'the profile still turns the plugins off');
    });
  } finally {
    s.cleanup();
  }
});

test("a session without skill choices (a chat) keeps every skill: no skillOverrides are written (#300)", async () => {
  const s = sessionOn(slim);
  try {
    const skills = path.join(path.dirname(s.project), 'config', 'skills', 'blocket');
    fs.mkdirSync(skills, { recursive: true });
    fs.writeFileSync(path.join(skills, 'SKILL.md'), '---\ndescription: x\n---\n');
    await withDataDir(async () => {
      assert.equal(((await s.options()).settings as { skillOverrides?: unknown }).skillOverrides, undefined);
    });
  } finally {
    s.cleanup();
  }
});

test("a session on full, or with no profile, gets none of a profile's options and only Ledung's own server", async () => {
  for (const profile of [profileByName('full', {}), undefined]) {
    const s = sessionOn(profile);
    try {
      await withDataDir(async (dataDir) => {
        const o = await s.options();
        for (const key of ['strictMcpConfig', 'disallowedTools', 'settingSources'] as const) assert.equal(o[key], undefined, key);
        // Settings hold only Ledung's boundary (#104), nothing from a profile.
        assert.deepEqual(Object.keys(o.settings as object).filter((k) => !['permissions', 'sandbox'].includes(k)), []);
        assert.deepEqual(Object.keys((o.settings as { permissions: object }).permissions), ['deny']);
        deniesDataDir(o.settings, dataDir);
        assert.deepEqual(Object.keys(o.mcpServers ?? {}), [LEDUNG_SERVER]);
      });
    } finally {
      s.cleanup();
    }
  }
});

test("a manager's options, profile and all, raise Claude Code's tool server limit for its instructions; a session's stay at the default (#32)", async () => {
  const own = process.env[MCP_LIMIT_ENV];
  delete process.env[MCP_LIMIT_ENV];
  try {
    for (const role of ['manager', 'session'] as const) {
      const s = sessionOn(ProfileSetting.parse({ mcpServers: 'none', plugins: 'none' }), role);
      try {
        const env = (await s.options()).env ?? {};
        const limit = Number(env[MCP_LIMIT_ENV]);
        if (role === 'manager') assert.ok(limit > MCP_INSTRUCTIONS_LIMIT, `a manager's limit is ${limit}`);
        else assert.equal(limit, MCP_INSTRUCTIONS_LIMIT);
        // The account's login is still the one the session gets.
        assert.equal(env.CLAUDE_CONFIG_DIR, path.dirname(s.project) + path.sep + 'config');
      } finally {
        s.cleanup();
      }
    }
  } finally {
    if (own !== undefined) process.env[MCP_LIMIT_ENV] = own;
  }
});

test("in a real session the managers' project tools are always the user's, in auto and accept-edits and under a grant (#37)", async () => {
  type Hook = (input: unknown) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;
  for (const mode of ['auto', 'acceptEdits'] as const) {
    const s = sessionOn(undefined, 'manager', { permissionMode: mode });
    try {
      const o = await s.options();
      assert.equal(o.permissionMode, mode);
      const hook = o.hooks!.PreToolUse![0]!.hooks[0] as unknown as Hook;
      const asked = await hook({ tool_name: `mcp__${LEDUNG_SERVER}__add_project`, tool_input: {} });
      assert.equal(asked.hookSpecificOutput?.permissionDecision, 'ask', mode);
      // Control: a Ledung tool that only reads is let through.
      assert.deepEqual(await hook({ tool_name: `mcp__${LEDUNG_SERVER}__list_projects`, tool_input: {} }), {}, mode);

      // A grant from the user that covers the tool doesn't allow it: the prompt goes to the user, as sensitive.
      const tool = `mcp__${LEDUNG_SERVER}__start_manager`;
      s.store.addGrant('s', tool, undefined, 'user');
      const abort = new AbortController();
      const result = o.canUseTool!(tool, { project: 'q', message: 'hi' }, { signal: abort.signal, toolUseID: 't1' } as never);
      const [p, ...more] = s.store.pendingPermissions();
      assert.equal(more.length, 0);
      assert.equal(p?.toolName, tool);
      assert.equal(p?.addressedTo, 'user');
      assert.ok(p?.sensitive, 'the permission is sensitive');
      abort.abort();
      assert.notEqual((await result)?.behavior, 'allow');
      // Control: the same kind of grant does allow an ordinary tool.
      s.store.addGrant('s', 'mcp__other__tool', undefined, 'user');
      const other = await o.canUseTool!('mcp__other__tool', {}, { signal: new AbortController().signal, toolUseID: 't2' } as never);
      assert.equal(other?.behavior, 'allow');
    } finally {
      s.cleanup();
    }
  }
});

test('settingsFile: relative paths inside the project folder only, on either system', () => {
  for (const ok of ['.claude/lean-settings.json', 'lean.json', '.claude\\lean.json', 'a/../b.json']) assert.equal(settingsFileProblem(ok), null, ok);
  for (const bad of ['/etc/settings.json', 'C:\\x\\s.json', 'C:s.json', '\\\\server\\share\\s.json']) assert.match(settingsFileProblem(bad)!, /must be relative/, bad);
  for (const bad of ['../s.json', '..', '.claude/../../s.json', '..\\s.json']) assert.match(settingsFileProblem(bad)!, /must stay inside/, bad);
  assert.match(settingsFileProblem('.')!, /is a folder/);
  assert.equal(settingsFilePath('.claude\\lean.json'), '.claude/lean.json');
  assert.throws(() => parseConfig({ profiles: { lean: { settingsFile: '../outside.json' } } }), /profiles\.lean\.settingsFile: "\.\.\/outside\.json" must stay inside/);
  assert.equal(parseConfig({ profiles: { lean: { settingsFile: '.claude/lean.json' } } }).profiles.lean!.settingsFile, '.claude/lean.json');
});

test("settingsFile: its contents go in as the session's settings, merged with the profile's plugins (the profile's choice wins)", () => {
  const file = { model: 'claude-haiku-5-5', claudeMdExcludes: ['**/rules/x.md'], enabledPlugins: { 'a@m': true, 'z@m': true } };
  const lean = ProfileSetting.parse({ plugins: 'none', settingsFile: 'lean.json' });
  assert.deepEqual(profileOptions(lean, ['a@m'], file).settings,
    { model: 'claude-haiku-5-5', claudeMdExcludes: ['**/rules/x.md'], enabledPlugins: { 'a@m': false, 'z@m': true } });
  assert.deepEqual(file.enabledPlugins, { 'a@m': true, 'z@m': true }, "the file's settings are not changed");
  assert.deepEqual(profileOptions(ProfileSetting.parse({ settingsFile: 'lean.json' }), ['a@m'], { model: 'x' }).settings, { model: 'x' });
});

test("settingsFile: the model is chosen explicit > the file's > the project's default > none, on a start and on a resume alike", async () => {
  const lean = ProfileSetting.parse({ settingsFile: 'lean.json' });
  const cases: [string, { model?: string; defaultModel?: string; fileSettings?: Record<string, unknown> }, string | undefined][] = [
    ['explicit beats the file and the project', { model: 'e', defaultModel: 'p', fileSettings: { model: 'f' } }, 'e'],
    ['the file beats the project', { defaultModel: 'p', fileSettings: { model: 'f' } }, undefined],
    ['the project, when the file names none', { defaultModel: 'p', fileSettings: { effortLevel: 'low' } }, 'p'],
    ['none at all', { fileSettings: {} }, undefined],
  ];
  for (const resume of [undefined, 'claude-session-1']) {
    for (const [name, extra, expected] of cases) {
      const s = sessionOn(lean, 'session', { ...extra, resume });
      try {
        const o = await s.options();
        assert.equal(o.model, expected, `${name}${resume ? ' (resume)' : ''}`);
        if (extra.fileSettings?.model) assert.equal((o.settings as { model?: string }).model, 'f', 'the file still carries its model');
      } finally {
        s.cleanup();
      }
    }
  }
  const noFile = sessionOn(undefined, 'session', { defaultModel: 'p' });
  try {
    assert.equal((await noFile.options()).model, 'p', 'no settings file: the project default as before');
  } finally {
    noFile.cleanup();
  }
});

test("manager's model: a manager gets explicit > the file's > the project's manager model > the project's model; a session ignores the manager model", async () => {
  const lean = ProfileSetting.parse({ settingsFile: 'lean.json' });
  const both = { model: 'p', managerModel: 'm' };
  assert.equal(defaultModelFor(both, 'manager'), 'm');
  assert.equal(defaultModelFor(both, 'session'), 'p');
  assert.equal(defaultModelFor({ model: 'p' }, 'manager'), 'p', 'empty: the same as its sessions');
  assert.equal(defaultModelFor({ model: 'p', managerModel: ' ' }, 'manager'), 'p');
  assert.equal(defaultModelFor({ managerModel: 'm' }, 'session'), undefined, "no project model: nothing, so the project's Claude settings decide");
  assert.equal(defaultModelFor({ managerModel: 'm' }, 'manager'), 'm', 'the manager model still applies without a project model');
  assert.equal(defaultModelFor({}, 'manager'), undefined);
  assert.equal(defaultModelFor({ model: ' ' }, 'session'), undefined, 'blank counts as empty');
  const cases: [string, 'manager' | 'session', { model?: string; fileSettings?: Record<string, unknown> }, string | undefined][] = [
    ['a manager: its own model first', 'manager', { model: 'e', fileSettings: { model: 'f' } }, 'e'],
    ["a manager: the file's before the project's", 'manager', { fileSettings: { model: 'f' } }, undefined],
    ["a manager: the project's manager model", 'manager', { fileSettings: {} }, 'm'],
    ["a session: the project's model", 'session', { fileSettings: {} }, 'p'],
  ];
  // The project's model left empty ("inherit"): the manager is still pinned, sessions get no model option.
  const inherit = { managerModel: 'm' };
  const inheritCases: typeof cases = [
    ['inherit, a manager: its own model first', 'manager', { model: 'e', fileSettings: {} }, 'e'],
    ["inherit, a manager: the file's before the manager model", 'manager', { fileSettings: { model: 'f' } }, undefined],
    ["inherit, a manager: the project's manager model", 'manager', { fileSettings: {} }, 'm'],
    ['inherit, a session: its own model', 'session', { model: 'e', fileSettings: {} }, 'e'],
    ['inherit, a session: no model option at all', 'session', { fileSettings: {} }, undefined],
  ];
  for (const resume of [undefined, 'claude-session-1']) {
    for (const [project, list] of [[both, cases], [inherit, inheritCases]] as const) for (const [name, role, extra, expected] of list) {
      const s = sessionOn(lean, role, { ...extra, defaultModel: defaultModelFor(project, role), resume });
      try {
        assert.equal((await s.options()).model, expected, `${name}${resume ? ' (resume)' : ''}`);
      } finally {
        s.cleanup();
      }
    }
  }
  // Without a profile settings file too: the session passes no model, the manager its own.
  for (const role of ['session', 'manager'] as const) {
    const s = sessionOn(undefined, role, { defaultModel: defaultModelFor(inherit, role) });
    try {
      assert.equal((await s.options()).model, role === 'manager' ? 'm' : undefined, role);
    } finally {
      s.cleanup();
    }
  }
});

test('settingsFile: a missing file, bad JSON or a non-object is a clear error naming the file', () => {
  assert.throws(() => parseSettingsFile('.claude/lean.json', null), /settings file \.claude\/lean\.json was not found in the project folder/);
  assert.throws(() => parseSettingsFile('lean.json', '{ nope'), /settings file lean\.json is not valid JSON/);
  assert.throws(() => parseSettingsFile('lean.json', '[]'), /lean\.json must hold a JSON object/);
  assert.deepEqual(parseSettingsFile('lean.json', '{"model":"m"}'), { model: 'm' });
});

test("settingsFile: the local runner reads it from the project folder; a session whose file is missing ends at its start, saying which file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-profiles-file-'));
  try {
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'lean.json'), '{"model":"m"}');
    const runner = new LocalRunner({ name: 'p', runner: 'local', path: root } as LocalProjectConfig);
    assert.equal(await runner.readProjectFile('.claude/lean.json'), '{"model":"m"}');
    assert.equal(await runner.readProjectFile('.claude/other.json'), null);

    const { store, manager } = managerWith({
      profiles: { lean: { settingsFile: '.claude/missing.json' } },
      projects: [{ name: 'p', runner: 'local', path: root }],
    });
    const s = await manager.start('p', undefined, { profile: 'lean' });
    const ended = store.getSession(s.id)!;
    assert.equal(ended.status, 'ended');
    assert.equal(ended.endReason, "The profile's settings file .claude/missing.json was not found in the project folder.");
  } finally {
    removeTemp(root);
  }
});
