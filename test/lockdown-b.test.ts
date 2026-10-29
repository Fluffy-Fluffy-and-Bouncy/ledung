// Project lockdown level B, nearly air-gapped (issue #109, part 2): nothing reaches in and nothing
// reaches out. Its manager loses the tools that reach other managers and projects, its sessions launch
// with the airgap profile and a short environment, and a container project's container is checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Management } from '../src/sessions/management.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { parseConfig } from '../src/config.ts';
import { instructions, ledungToolServer, type ManagerHandlers, type ToolHandlers } from '../src/sessions/tools.ts';
import { airgapEnvironment, airgapTempFolder, containerProblem, levelProblem, lockdownOf, makeAirgapTempFolder, NO_LOCKDOWN, opensUp, versionProblem } from '../src/projects/lockdown.ts';
import { DockerRunner } from '../src/runners/docker-runner.ts';
import { userDataDir } from '../src/platform/paths.ts';
import type { ProjectInfo } from '../src/shared/protocol.ts';
import { FakeBackend, FakeBoard } from '../src/board/fake.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

type Level = 'off' | 'A' | 'B';
/** Level B can't be set on native Windows (held by Martin, 2026-10-15 19:12), so tests that set it run elsewhere. */
const notOnWindows = { skip: process.platform === 'win32' ? 'level B is not offered on native Windows' : false };

test('level B is offered everywhere but native Windows, where it stays held', () => {
  const b = { ...NO_LOCKDOWN, level: 'B' as const };
  assert.match(levelProblem(b, 'win32')!, /level B \(nearly air-gapped\) is not available on Windows/);
  assert.equal(levelProblem(b, 'darwin'), null);
  assert.equal(levelProblem(b, 'linux'), null);
  assert.equal(levelProblem({ ...NO_LOCKDOWN, level: 'A' }, 'win32'), null, 'level A as before');
});

test('at level B, letting a host or a Docker network in opens the project up; taking one out does not', () => {
  const b = { ...NO_LOCKDOWN, level: 'B' as const, network: ['registry.npmjs.org'] };
  assert.equal(opensUp(b, { ...b, network: ['registry.npmjs.org', 'evil.example'] }), true, 'a host let in');
  assert.equal(opensUp(b, { ...b, network: [] }), false, 'a host taken out');
  assert.equal(opensUp(b, { ...b, dockerNetwork: 'island-net' }), true, 'a network marked');
  assert.equal(opensUp({ ...b, dockerNetwork: 'island-net' }, { ...b, dockerNetwork: 'other' }), true, 'another network marked');
  assert.equal(opensUp({ ...b, dockerNetwork: 'island-net' }, b), false, 'the mark taken away');
  assert.equal(opensUp({ ...NO_LOCKDOWN, level: 'A' }, { ...NO_LOCKDOWN, level: 'B' }), false, 'A to B with nothing let in: anyone');
  assert.equal(opensUp(b, { ...b, level: 'A' }), true, 'B down to A');
});

test('a level B manager gets only its own-session tools and ask_user; its instructions keep away mode', () => {
  const handlers = (airgap: boolean): ToolHandlers => ({
    userName: 'Simon', role: 'manager', asksWhom: 'Simon', ask: () => { throw new Error('not called'); }, withdraw: () => '',
    manager: new Proxy({}, { get: () => () => '' }) as ManagerHandlers,
    board: { post: async () => '', read: async () => '', threads: () => '' },
    airgap,
  });
  const tools = (h: ToolHandlers) => Object.keys((ledungToolServer(h).instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
  const open = tools(handlers(false));
  const closed = tools(handlers(true));
  const reaching = ['add_project', 'board_post', 'board_read', 'board_threads', 'create_project', 'list_managers', 'list_projects', 'message_manager', 'start_manager', 'stop_manager',
    // Settings' page-only actions (issue #263), as the other tools that reach beyond the project.
    'invite_computer', 'link_code', 'link_computer', 'relay_address', 'relay_admin_key', 'settings_status',
    // Projects' workflow settings (issue #306).
    'project_settings', 'set_project_settings',
    // Publishing usage (issue #376).
    'usage_publish'];
  for (const t of reaching) assert.ok(open.includes(t), `${t} is there without lockdown`);
  assert.deepEqual(closed, open.filter((t) => !reaching.includes(t)), 'exactly those are gone');
  for (const t of ['ask_user', 'start_session', 'read_session', 'send_message', 'decide_permission', 'answer_question', 'away_log']) assert.ok(closed.includes(t), t);

  const text = instructions(handlers(true));
  assert.match(text, /lockdown level B, nearly air-gapped: you have no tools for other managers, other projects or the board/);
  assert.doesNotMatch(text, /list_managers|message_manager|list_projects|board_post/);
  // Away mode is kept for its own sensitive commands (Martin, 2026-10-15 19:12: "keep").
  assert.match(text, /Away mode: while Simon is away/);
});

function info(name: string, level: Level, managerId: string): ProjectInfo {
  return {
    name, runner: 'local', where: `/home/${name}`, path: `/home/${name}`, account: null, model: 'haiku', managerModel: null, permissionMode: 'auto', managerGrant: null,
    projectToolsUnasked: false, sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] }, devShipCommand: null, tickets: null, questionTiers: [],
    extraFolders: [], profiles: { manager: null, session: null }, skills: {}, workflow: null, managerId, createdAt: 0, colours: { manager: null, sessions: 'same' },
    lockdown: { level, board: false, remoteControl: false },
  };
}

/** Managers for "island" (at the given level) and "mainland"; only Ledung's own checks, no sessions. */
function managers(level: Level) {
  const store = new Store(openDatabase(':memory:'));
  const projects = [info('island', level, 'mgr-i'), info('mainland', 'off', 'mgr-m')];
  const added: unknown[] = [];
  const ensured: string[] = [];
  const m = new Management({
    store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async () => {},
    startSession: async () => { throw new Error('not used'); },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => projects.map((p) => p.name), decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {}, projects: () => projects,
    addProject: (c) => {
      added.push(c);
      return { ...info('new', 'off', 'x'), where: '/x' };
    },
    createProject: async () => { throw new Error('not used'); },
    ensureManager: async (project) => {
      ensured.push(project);
      return projects.find((p) => p.name === project)!.managerId!;
    },
    handoffProblem: () => null, shotPath: (_id, f) => f,
  });
  for (const [id, project] of [['mgr-i', 'island'], ['mgr-m', 'mainland']] as const) {
    store.createSession({ id, project, runner: 'local', title: `Manager: ${project}`, parentId: null, permissionMode: 'default', role: 'manager' });
    store.updateSession(id, { status: 'idle' });
  }
  return { m, store, projects, added, ensured, inbox: (id: string) => store.undeliveredInbox(id).map((i) => i.text) };
}

test("Ledung refuses a level B manager every call that reaches out, even one launched before the change", async () => {
  const { m, added, ensured, inbox } = managers('B');
  const refused = /"island" is in lockdown level B \(nearly air-gapped\): its manager can't reach other managers or projects/;
  assert.throws(() => m.listManagers('mgr-i'), refused);
  assert.throws(() => m.listProjects('mgr-i'), refused);
  await assert.rejects(m.messageManager('mgr-i', 'mgr-m', 'hello'), refused);
  await assert.rejects(m.addProject('mgr-i', { name: 'new', folder: '/x' }), refused);
  await assert.rejects(m.createProject('mgr-i', { name: 'new' }), refused);
  await assert.rejects(m.startManager('mgr-i', 'mainland', 'go'), refused);
  await assert.rejects(m.stopManager('mgr-i', 'mainland'), refused);
  assert.deepEqual(inbox('mgr-m'), [], 'nothing reached the other manager');
  assert.deepEqual(added, []);
  assert.deepEqual(ensured, []);
  // And from outside, as at level A: its name only, and no message in.
  assert.match(m.listManagers('mgr-m'), /^- island: locked/m);
  await assert.rejects(m.messageManager('mgr-m', 'mgr-i', 'hi'), /"island" is in lockdown level B \(nearly air-gapped\): managers of other projects can't message it/);
  assert.deepEqual(inbox('mgr-i'), []);

  // The same calls at level A reach out as before (part 1).
  const a = managers('A');
  assert.match(a.m.listManagers('mgr-i'), /"Manager: mainland" \(mgr-m\)/);
  await a.m.addProject('mgr-i', { name: 'new', folder: '/x' });
  assert.equal(a.added.length, 1);
});

test('a reply allowance from level A gives nothing once the project is at level B', async () => {
  const { m, projects, inbox } = managers('A');
  await m.messageManager('mgr-i', 'mgr-m', 'question');
  projects[0]!.lockdown = { level: 'B', board: false, remoteControl: false };
  await assert.rejects(m.messageManager('mgr-m', 'mgr-i', 'answer'), /lockdown level B/);
  assert.deepEqual(inbox('mgr-i'), []);
});

/** A Ledung whose project folders don't exist, so sessions end at once without Claude Code; marked running again. */
function liveLedung(extraConfig: object = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-lockdown-b-')));
  const at = (d: string) => path.join(root, 'missing', d);
  const store = new Store(openDatabase(':memory:'));
  const projects = ['island', 'mainland'].map((name) => ({ name, runner: 'local', path: at(name) }));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects, ...extraConfig }), store, () => {}));
  const running = async (project: string, role: 'session' | 'manager' = 'session', profile?: string) => {
    const s = await manager.start(project, undefined, { role, profile });
    store.updateSession(s.id, { status: 'running' });
    return s.id;
  };
  const config = (name: string, extra: object = {}) => ({ name, runner: 'local', path: at(name), ...extra }) as never;
  type Opts = {
    settings?: Record<string, unknown> & { permissions?: Record<string, unknown> & { deny?: string[] }; sandbox?: Record<string, unknown> & { network?: Record<string, unknown>; filesystem?: Record<string, string[]> } };
    env?: Record<string, string>; strictMcpConfig?: boolean; settingSources?: string[]; disallowedTools?: string[]; mcpServers?: Record<string, unknown>;
    hooks?: { PreToolUse?: { hooks: ((input: unknown, id: string) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>)[] }[] };
  };
  const live = (id: string) => (manager as unknown as { live: Map<string, { claudeOptions(h: object): Promise<Opts> }> }).live.get(id)!;
  const options = (id: string) => live(id).claudeOptions({ onLine: () => {}, onStderr: () => {} });
  return { manager, store, running, config, at, options, live };
}

test("a level B session launches with the airgap profile; a level A one, and other projects', as before", notOnWindows, async () => {
  process.env.LEDUNG_B_TEST_SECRET = 'should-not-pass';
  try {
    const { manager, running, config, at, options } = liveLedung({
      profiles: { lean: { mcpServers: { mine: { command: 'my-server' } }, disallowedTools: ['NotebookEdit'] } },
    });
    manager.updateProject('island', config('island', { lockdown: { level: 'A' } }));
    const a = await options(await running('island', 'session', 'lean'));
    assert.equal(a.settings?.permissions?.blockReadsOutsideWorkingDirectories, undefined, 'level A: no airgap');
    assert.ok(a.mcpServers?.mine, "level A keeps the profile's MCP server");
    assert.equal(a.env?.LEDUNG_B_TEST_SECRET, 'should-not-pass', "level A keeps Ledung's environment");

    manager.updateProject('island', config('island', { lockdown: { level: 'B', network: ['registry.npmjs.org'] } }));
    const sessionId = await running('island', 'session', 'lean');
    const b = await options(sessionId);
    const s = b.settings!;
    assert.equal(s.permissions!.blockReadsOutsideWorkingDirectories, true, 'no file-tool reads outside its folders');
    assert.equal(s.permissions!.disableBypassPermissionsMode, 'disable');
    assert.ok(s.permissions!.deny!.includes('WebFetch') && s.permissions!.deny!.includes('WebSearch'));
    assert.ok(s.permissions!.deny!.some((d) => d.startsWith('Edit(') && d.includes(path.join(at('island'), '.claude', 'settings.local.json'))), "can't loosen its next launch");
    assert.equal(s.disableClaudeAiConnectors, true);
    assert.equal(s.disableAllHooks, true);
    assert.equal(s.enableAllProjectMcpServers, false);
    // The data folder stays denied (#104) under the airgap.
    assert.ok(s.permissions!.deny!.some((d) => d.startsWith('Read(') && d.includes(userDataDir())));
    if (process.platform !== 'win32') {
      assert.deepEqual(
        { ...s.sandbox, network: undefined, filesystem: undefined },
        { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, excludedCommands: [], network: undefined, filesystem: undefined },
      );
      assert.deepEqual(s.sandbox!.network, { allowedDomains: ['registry.npmjs.org'], strictAllowlist: true, allowAllUnixSockets: false, allowUnixSockets: [], allowLocalBinding: false });
      // Shell reads: Claude Code's block walls home, /Users and /Volumes; the airgap adds the shared temp
      // places and lets back only its own folders and its own temp folder (review round 1, test finding 1).
      const shared = process.platform === 'darwin' ? ['/private/tmp', '/private/var/tmp', '/private/var/folders'] : ['/tmp', '/var/tmp', '/home'];
      for (const d of shared) assert.ok(s.sandbox!.filesystem!.denyRead!.includes(d), `${d} walled`);
      const tmp = airgapTempFolder(sessionId);
      assert.deepEqual([...s.sandbox!.filesystem!.allowRead!].sort(), [at('island'), tmp].sort(), 'only its folder and its own temp folder');
      assert.deepEqual(s.sandbox!.filesystem!.allowWrite, []);
      assert.equal(b.env?.CLAUDE_CODE_TMPDIR, tmp, "Claude Code's temp folder is its own");
      assert.equal(b.env?.TMPDIR, tmp);
      assert.ok(s.sandbox!.filesystem!.denyRead!.includes(userDataDir()), 'the data folder, for shell commands too');
    }
    // The airgap profile, not the one it was started with.
    assert.equal(b.strictMcpConfig, true);
    assert.deepEqual(Object.keys(b.mcpServers ?? {}), ['ledung'], "only Ledung's own server");
    assert.deepEqual(b.settingSources, ['project', 'local'], "not the user's settings");
    for (const t of ['WebFetch', 'WebSearch', 'RemoteTrigger', 'SendMessage', 'ListAgents', 'PushNotification']) assert.ok(b.disallowedTools!.includes(t), t);
    assert.ok(!b.disallowedTools!.includes('NotebookEdit'), "the started profile's list is replaced, not added to");
    // Only what Claude Code and a shell need of Ledung's environment.
    assert.equal(b.env?.LEDUNG_B_TEST_SECRET, undefined);
    assert.equal(b.env?.PATH, process.env.PATH);

    // Another project's session is kept out of the island as at level A, and gets no airgap itself.
    const other = await options(await running('mainland'));
    assert.equal(other.settings?.permissions?.blockReadsOutsideWorkingDirectories, undefined);
    assert.ok(other.settings?.permissions?.deny?.some((d) => d.startsWith('Read(') && d.includes(at('island'))));
    assert.equal(other.env?.LEDUNG_B_TEST_SECRET, 'should-not-pass');
  } finally {
    delete process.env.LEDUNG_B_TEST_SECRET;
  }
});

test('a level B session may not start a subagent in the cloud; a local one is let through to the usual checks', notOnWindows, async () => {
  const { manager, running, config, options } = liveLedung();
  manager.updateProject('island', config('island', { lockdown: { level: 'B' } }));
  const hook = (await options(await running('island'))).hooks!.PreToolUse![0]!.hooks[0]!;
  const remote = await hook({ tool_name: 'Agent', tool_input: { prompt: 'x', isolation: 'remote' } }, 't1');
  assert.equal(remote.hookSpecificOutput?.permissionDecision, 'deny');
  const local = await hook({ tool_name: 'Agent', tool_input: { prompt: 'x', isolation: 'worktree' } }, 't2');
  assert.notEqual(local.hookSpecificOutput?.permissionDecision, 'deny');

  const free = await options(await running('mainland'));
  const freeHook = free.hooks!.PreToolUse![0]!.hooks[0]!;
  assert.notEqual((await freeHook({ tool_name: 'Agent', tool_input: { prompt: 'x', isolation: 'remote' } }, 't3')).hookSpecificOutput?.permissionDecision, 'deny', 'unlocked: as before');
});

test("going from level A to B restarts the project's own sessions; the other projects' are left alone", notOnWindows, async () => {
  const { manager, running, config } = liveLedung();
  manager.updateProject('island', config('island', { lockdown: { level: 'A' } }));
  const worker = await running('mainland');
  const islandWorker = await running('island');
  const islandManager = await running('island', 'manager');
  manager.relaunchChanged();
  assert.deepEqual(manager.waitingRelaunch(), [], 'launched with level A: nothing to do');
  manager.updateProject('island', config('island', { lockdown: { level: 'B' } }));
  assert.deepEqual(manager.waitingRelaunch().sort(), [islandWorker, islandManager].sort());
  assert.ok(!manager.waitingRelaunch().includes(worker));
});

test('the board is always off at level B, even with the board ticked', notOnWindows, () => {
  const { manager, config } = liveLedung();
  const boards = manager.attachBoards(() => new FakeBackend(new FakeBoard(), 'me'));
  boards.setProjectSetting('island', { enabled: true, repo: 'org/board', allow: ['me'], channels: [], frontDesk: false });
  manager.updateProject('island', config('island', { lockdown: { level: 'A', board: true } }));
  assert.equal(boards.availableFor('island'), true, 'level A with the board let in');
  manager.updateProject('island', config('island', { lockdown: { level: 'B', board: true } }));
  assert.equal(boards.availableFor('island'), false);
});

test('level B needs a Claude Code new enough for its settings, and refuses to start on an older one', async () => {
  assert.equal(versionProblem('2.1.295'), null);
  assert.equal(versionProblem('2.1.300 (Claude Code)'), null);
  assert.equal(versionProblem('2.2.0'), null);
  assert.equal(versionProblem('3.0.0'), null);
  assert.match(versionProblem('2.1.294')!, /needs Claude Code 2\.1\.295 or newer, and this is 2\.1\.294/);
  assert.match(versionProblem('2.0.999')!, /this is 2\.0\.999/);
  assert.match(versionProblem(null)!, /its version couldn't be read/);

  const start = async (version: string | null, airgap: boolean) => {
    const store = new Store(openDatabase(':memory:'));
    const info = store.createSession({ id: 's', project: 'p', runner: 'local', title: 'S', parentId: null, permissionMode: 'default', role: 'session' });
    let opened = false;
    const stream = { close: () => {}, accountInfo: async () => ({}), [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }) };
    const session = new Session({
      info, store, publish: () => {}, userName: 'Simon',
      management: { managerOf: () => null, questionTiers: () => [] } as never,
      runner: { cwd: '.', prepare: async () => {}, claudeVersion: async () => version, currentBranch: async () => null } as never,
      gate: { mayStart: () => true, started: () => {}, ended: () => {} },
      query: (() => { opened = true; return stream; }) as never,
      // Its sandbox's private temp folder can't be made on native Windows, where level B is held (issue #127);
      // the version is asked before it, so the refusals are checked everywhere.
      airgap: airgap ? { network: [], folders: [], sandbox: process.platform !== 'win32' } : null,
    });
    await session.start();
    return { status: store.getSession('s')!.status, reason: store.getSession('s')!.endReason, opened };
  };
  const old = await start('2.1.200', true);
  assert.equal(old.status, 'ended');
  assert.match(old.reason ?? '', /needs Claude Code 2\.1\.295 or newer/);
  assert.equal(old.opened, false, 'Claude Code never started');
  assert.equal((await start(null, true)).opened, false, 'an unknown version is refused too');
  assert.equal((await start('2.1.295', true)).opened, true);
  assert.equal((await start('2.1.200', false)).opened, true, 'without level B the version is not asked');
});

test("the local runner names the Claude Code the Agent SDK starts", async () => {
  const { LocalRunner } = await import('../src/runners/local-runner.ts');
  const sdk = JSON.parse(fs.readFileSync(path.join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')) as { claudeCodeVersion: string };
  assert.equal(await new LocalRunner({ name: 'p', runner: 'local', path: '.' } as never).claudeVersion(), sdk.claudeCodeVersion);
});

test("a level B session keeps only a shell's and Claude Code's environment", () => {
  const env = airgapEnvironment({
    PATH: '/bin', HOME: '/h', LANG: 'sv_SE.UTF-8', LC_ALL: 'C', TMPDIR: '/t', CLAUDE_CONFIG_DIR: '/c', HTTPS_PROXY: 'http://p',
    GH_TOKEN: 'x', SSH_AUTH_SOCK: '/s', AWS_SECRET_ACCESS_KEY: 'x', OPENAI_API_KEY: 'x', LEDUNG_CONFIG: '/l',
  });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CONFIG_DIR', 'HOME', 'HTTPS_PROXY', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']);
});

test("a level B container may mount only the project folder, never the Docker socket, and sit only on its marked network", () => {
  const ok = { Mounts: [{ Source: '/host/p', Destination: '/work/p' }], HostConfig: { NetworkMode: 'island-net' }, NetworkSettings: { Networks: { 'island-net': {} } } };
  const o = { container: 'c', folder: '/work/p', network: 'island-net' };
  assert.equal(containerProblem([ok], o), null);
  assert.equal(containerProblem([{ ...ok, Mounts: [{ Source: '/host/p/sub', Destination: '/work/p/sub' }] }], o), null, 'inside the folder');
  assert.match(containerProblem([{ ...ok, Mounts: [...ok.Mounts, { Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }] }], o)!, /has the Docker socket mounted/);
  assert.match(containerProblem([{ ...ok, Mounts: [{ Source: '/Users/me', Destination: '/home/me' }] }], o)!, /mounts \/Users\/me at \/home\/me, outside the project folder \/work\/p/);
  assert.match(containerProblem([{ ...ok, Mounts: [{ Source: '/host', Destination: '/work' }] }], o)!, /outside the project folder/, 'a folder above it');
  assert.match(containerProblem([{ ...ok, HostConfig: { NetworkMode: 'bridge' }, NetworkSettings: { Networks: { bridge: {} } } }], o)!, /network "bridge", which isn't marked as this project's island network \("island-net"\)/);
  assert.match(containerProblem([ok], { ...o, network: null })!, /"island-net", which isn't marked .*\(none is marked\)/);
  assert.match(containerProblem([{ ...ok, HostConfig: { NetworkMode: 'host' }, NetworkSettings: { Networks: { host: {} } } }], o)!, /"host"/);
  assert.equal(containerProblem([{ ...ok, HostConfig: { NetworkMode: 'none' }, NetworkSettings: { Networks: { none: {} } } }], { ...o, network: null }), null, 'no network at all');
});

// Review round 1, finding 1: a host or a network saved while the project is at level A must not come
// along into level B without the page.
test('hosts and a Docker network saved at level A count for nothing; moving to B with them opens it up', () => {
  const stagedA = lockdownOf({ lockdown: { level: 'A', network: ['evil.example'], dockerNetwork: 'bridge' } });
  assert.deepEqual([stagedA.network, stagedA.dockerNetwork], [[], null], 'dropped below level B');
  const b = lockdownOf({ lockdown: { level: 'B', network: ['evil.example'], dockerNetwork: 'bridge' } });
  assert.equal(opensUp(NO_LOCKDOWN, stagedA), false, 'locking at A: anyone');
  assert.equal(opensUp(stagedA, b), true, 'A to B with the staged host and network: the page');
  assert.equal(opensUp(lockdownOf({ lockdown: { level: 'A' } }), lockdownOf({ lockdown: { level: 'B' } })), false, 'A to B with nothing let in: anyone');

  // Through Ledung's own check the server asks: two cookie-only saves don't get there.
  const { manager, config } = liveLedung();
  manager.updateProject('island', config('island', { lockdown: { level: 'A', network: ['evil.example'], dockerNetwork: 'bridge' } }));
  assert.equal(manager.lockdownOpensUp('island', config('island', { lockdown: { level: 'B', network: ['evil.example'], dockerNetwork: 'bridge' } }) as never), true);
});

test("a level B session's temp folder is private to it; one that isn't a private folder of this user's is refused", { skip: process.platform === 'win32' }, () => {
  const id = `t${Date.now()}`;
  const folder = airgapTempFolder(id);
  assert.match(folder, /^\/tmp\/lb-t\d{7}$/, 'short: Claude Code makes sockets inside it');
  try {
    const made = makeAirgapTempFolder(folder);
    assert.equal(fs.statSync(made).mode & 0o777, 0o700);
    assert.equal(makeAirgapTempFolder(folder), made, 'made again at the next start');
    fs.chmodSync(folder, 0o755);
    assert.throws(() => makeAirgapTempFolder(folder), /isn't a private folder of this user's/);
  } finally {
    removeTemp(folder);
  }
});

/** A `docker` on PATH that answers as a running container would, with this inspect record and Claude Code version. */
function fakeDocker(inspect: object, version: string): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-fake-docker-'));
  fs.writeFileSync(path.join(dir, 'inspect.json'), JSON.stringify([inspect]));
  fs.writeFileSync(path.join(dir, 'docker'), [
    '#!/bin/sh',
    'case "$*" in',
    '  "inspect -f {{.State.Running}} "*) echo true ;;',
    `  "inspect "*) cat '${path.join(dir, 'inspect.json')}' ;;`,
    `  *"claude --version"*) echo '${version}' ;;`,
    '  "exec "*) exit 0 ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n'), { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before}`;
  return () => {
    process.env.PATH = before;
    removeTemp(dir);
  };
}

// Review round 1, test finding 2: the check stops the start itself, not only in its decision function.
test('a level B container start is refused by the container check and the version check; a clean one passes', { skip: process.platform === 'win32' }, async () => {
  const project = (level: Level) => ({ name: 'boxed', runner: 'docker', container: 'box', pathInContainer: '/work/p', lockdown: { level, dockerNetwork: 'island-net' } }) as never;
  const clean = { Mounts: [{ Source: '/host/p', Destination: '/work/p' }], HostConfig: { NetworkMode: 'island-net' }, NetworkSettings: { Networks: { 'island-net': {} } } };
  const socket = { ...clean, Mounts: [...clean.Mounts, { Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }] };
  let restore = fakeDocker(socket, '2.1.295 (Claude Code)');
  try {
    await assert.rejects(new DockerRunner(project('B'), 's1').prepare(), /has the Docker socket mounted/);
    await new DockerRunner(project('A'), 's1').prepare();
  } finally {
    restore();
  }
  restore = fakeDocker(clean, '2.1.200 (Claude Code)');
  try {
    await new DockerRunner(project('B'), 's1').prepare();
    assert.equal(await new DockerRunner(project('B'), 's1').claudeVersion(), '2.1.200 (Claude Code)');
    assert.match(versionProblem(await new DockerRunner(project('B'), 's1').claudeVersion())!, /this is 2\.1\.200/);
  } finally {
    restore();
  }
});

test('a level B container session gets the airgap without the sandbox: the container is its wall', { skip: process.platform === 'win32' }, async () => {
  const { manager, store, options } = liveLedung();
  manager.addProject({ name: 'boxed', runner: 'docker', container: 'box', pathInContainer: '/work/p', lockdown: { level: 'B' } } as never);
  // A container with the Docker socket mounted: the start is refused at once, so no Claude Code runs.
  const restore = fakeDocker({ Mounts: [{ Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock' }], HostConfig: { NetworkMode: 'none' } }, '2.1.295');
  try {
    const s = await manager.start('boxed', undefined, { role: 'session' });
    assert.match(store.getSession(s.id)!.endReason ?? '', /has the Docker socket mounted/, 'the start was refused');
    store.updateSession(s.id, { status: 'running' });
    // The fake answers the plugin-settings read too, so no real docker is asked.
    const o = await options(s.id);
    assert.equal(o.settings?.permissions?.blockReadsOutsideWorkingDirectories, true, 'the airgap');
    assert.equal(o.settings?.sandbox?.network, undefined, 'no sandbox network rules');
    assert.notEqual(o.settings?.sandbox?.enabled, true, 'no sandbox switched on');
    assert.equal(o.env?.CLAUDE_CODE_TMPDIR, undefined, 'no temp folder of its own on this computer');
  } finally {
    restore();
  }
});
