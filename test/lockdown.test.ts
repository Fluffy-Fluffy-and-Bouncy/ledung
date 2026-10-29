// Project lockdown (issue #109): off by default; a locked project is closed to other projects' managers,
// its folders are its own, and only the user opens it up again.
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
import { parseConfig, parseProject } from '../src/config.ts';
import { lockdownOf, opensUp, othersSettings, withOthersSettings, NO_LOCKDOWN } from '../src/projects/lockdown.ts';
import { rulePath } from '../src/sessions/boundary.ts';
import type { ProjectInfo } from '../src/shared/protocol.ts';
import { FakeBackend, FakeBoard } from '../src/board/fake.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const info = (name: string, level: 'off' | 'A' = 'off', managerId: string | null = null): ProjectInfo => ({
  name, runner: 'local', where: `/home/${name}`, path: `/home/${name}`, account: null, model: 'haiku', managerModel: null, permissionMode: 'auto', managerGrant: null,
  projectToolsUnasked: false, sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] }, devShipCommand: null, tickets: null, questionTiers: [],
  extraFolders: [], profiles: { manager: null, session: null }, skills: {}, workflow: null, managerId, createdAt: 0, colours: { manager: null, sessions: 'same' },
  lockdown: { level, board: false, remoteControl: false },
});

/** Two projects, each with a running manager: "island" (lockdown as given) and "mainland". */
function setup(level: 'off' | 'A') {
  const store = new Store(openDatabase(':memory:'));
  const projects = [info('island', level, 'mgr-i'), info('mainland', 'off', 'mgr-m'), info('third', 'off', 'mgr-t')];
  const stopped: string[] = [];
  const ensured: string[] = [];
  const resumed: string[] = [];
  const m = new Management({
    store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async (id) => void resumed.push(id),
    startSession: async () => { throw new Error('not used'); },
    stopSession: async (id) => void stopped.push(id),
    archiveSession: () => {}, projectNames: () => projects.map((p) => p.name),
    decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {}, projects: () => projects,
    addProject: () => { throw new Error('not used'); },
    createProject: async () => { throw new Error('not used'); },
    ensureManager: async (project) => {
      ensured.push(project);
      return projects.find((p) => p.name === project)!.managerId!;
    },
    handoffProblem: () => null, shotPath: (_id, f) => f,
  });
  for (const [id, project] of [['mgr-i', 'island'], ['mgr-m', 'mainland'], ['mgr-t', 'third']] as const) {
    store.createSession({ id, project, runner: 'local', title: `Manager: ${project}`, parentId: null, permissionMode: 'default', role: 'manager' });
    store.updateSession(id, { status: 'idle' });
  }
  const inbox = (id: string) => store.undeliveredInbox(id).map((i) => i.text);
  return { m, store, projects, stopped, ensured, resumed, inbox };
}

test('lockdown is off unless set, and nothing changes for a project with it off', async () => {
  assert.deepEqual(lockdownOf(parseProject({ name: 'p', runner: 'local', path: '/p' })), NO_LOCKDOWN);
  assert.deepEqual(lockdownOf(parseProject({ name: 'p', runner: 'local', path: '/p', lockdown: {} })), NO_LOCKDOWN, 'a block with no level is off');
  assert.equal(othersSettings([]), null, 'nothing locked: no settings added to anyone');
  const plain = { permissions: { deny: ['Read(//x)'] } };
  assert.equal(withOthersSettings(plain, null), plain, 'and the session settings are passed on untouched');

  // Every cross-project call works as before.
  const { m, inbox, stopped, ensured } = setup('off');
  const managers = m.listManagers('mgr-m');
  assert.match(managers, /"Manager: island" \(mgr-i\) for island: idle/);
  assert.match(m.listProjects('mgr-m'), /"island": \/home\/island; model haiku, mode auto; manager "Manager: island" \(mgr-i\) idle/);
  assert.equal(await m.messageManager('mgr-m', 'mgr-i', 'hello'), 'Sent to manager "Manager: island".');
  assert.equal(await m.messageManager('mgr-m', 'mgr-i', 'and again'), 'Sent to manager "Manager: island".', 'any number of messages');
  assert.deepEqual(inbox('mgr-i'), ['Message from manager "Manager: mainland" (mgr-m):\n\nhello', 'Message from manager "Manager: mainland" (mgr-m):\n\nand again']);
  await m.startManager('mgr-m', 'island', 'start');
  await m.stopManager('mgr-m', 'island');
  assert.deepEqual(ensured, ['island']);
  assert.deepEqual(stopped, ['mgr-i']);
  // A message from an unlocked project carries no reply note.
  await m.messageManager('mgr-i', 'mgr-m', 'back');
  assert.deepEqual(inbox('mgr-m'), ['Message from manager "Manager: island" (mgr-i):\n\nback']);
});

test('other managers see a locked project by name only and can not message, start or stop it', async () => {
  const { m, inbox, stopped, ensured } = setup('A');
  const managers = m.listManagers('mgr-m');
  assert.match(managers, /^- island: locked; its manager can't be reached from other projects$/m);
  assert.doesNotMatch(managers, /mgr-i|Manager: island/, 'no id or title');
  assert.match(managers, /"Manager: third" \(mgr-t\)/, 'unlocked ones as before');
  const projects = m.listProjects('mgr-m');
  assert.match(projects, /^- "island": locked$/m);
  assert.doesNotMatch(projects, /\/home\/island|mgr-i/, 'no folder, settings or manager');

  await assert.rejects(m.messageManager('mgr-m', 'mgr-i', 'hello'), /The project "island" is locked: managers of other projects can't message it/);
  await assert.rejects(m.startManager('mgr-m', 'island', 'start'), /"island" is locked: managers of other projects can't start or stop its manager\. Simon can, in the page/);
  await assert.rejects(m.stopManager('mgr-m', 'island'), /can't start or stop its manager/);
  assert.deepEqual(inbox('mgr-i'), [], 'nothing reached it');
  assert.deepEqual(stopped, []);
  assert.deepEqual(ensured, []);

  // Its own manager keeps its view of its own project.
  assert.match(m.listProjects('mgr-i'), /"island" \(yours\): \/home\/island/);
});

test("a locked project's manager may write out, and gets one reply per message, marked as a reply", async () => {
  const { m, inbox } = setup('A');
  await m.messageManager('mgr-i', 'mgr-m', 'first');
  await m.messageManager('mgr-i', 'mgr-m', 'second');
  const got = inbox('mgr-m');
  assert.equal(got.length, 2);
  assert.match(got[0]!, /^Message from manager "Manager: island" \(mgr-i\):\n\nfirst\n\n\(Ledung: the project "island" is locked\. You can answer this message once, with message_manager to mgr-i/);

  assert.equal(await m.messageManager('mgr-m', 'mgr-i', 'answer one'), 'Reply sent to manager "Manager: island".');
  assert.equal(await m.messageManager('mgr-m', 'mgr-i', 'answer two'), 'Reply sent to manager "Manager: island".');
  await assert.rejects(m.messageManager('mgr-m', 'mgr-i', 'a third'), /is locked/, 'two messages, two replies');
  assert.deepEqual(inbox('mgr-i'), [
    'Reply from manager "Manager: mainland" (mgr-m) of mainland, to your message:\n\nanswer one',
    'Reply from manager "Manager: mainland" (mgr-m) of mainland, to your message:\n\nanswer two',
  ]);
  // The reply is the one it wrote to: a third manager has none.
  await assert.rejects(m.messageManager('mgr-t', 'mgr-i', 'me too'), /is locked/);
  // start_manager from the locked project messages that manager too, so it may answer.
  await m.startManager('mgr-i', 'third', 'please');
  assert.equal(await m.messageManager('mgr-t', 'mgr-i', 'done'), 'Reply sent to manager "Manager: island".');
});

test("a reply to a locked project's manager that has ended isn't sent, kept or started, and can still be sent once it runs (issue #46)", async () => {
  const { m, store, resumed, ensured, inbox } = setup('A');
  await m.messageManager('mgr-i', 'mgr-m', 'question');
  store.updateSession('mgr-i', { status: 'ended' });
  await assert.rejects(m.messageManager('mgr-m', 'mgr-i', 'answer'), /Manager "Manager: island" is not running, so your reply was not sent\. Simon can start it, in the page\./);
  assert.deepEqual(resumed, [], 'not resumed');
  assert.deepEqual(ensured, [], 'not started');
  assert.deepEqual(inbox('mgr-i'), [], 'nothing kept');
  store.updateSession('mgr-i', { status: 'idle' });
  assert.equal(await m.messageManager('mgr-m', 'mgr-i', 'answer'), 'Reply sent to manager "Manager: island".');
});

test('only lowering the level or letting the board or Remote Control in opens a project up', () => {
  const a = { level: 'A' as const, board: false, remoteControl: false };
  assert.equal(opensUp(NO_LOCKDOWN, a), false, 'turning it on: anyone');
  assert.equal(opensUp(a, NO_LOCKDOWN), true, 'turning it off');
  assert.equal(opensUp({ ...a, level: 'B' }, a), true, 'down a level');
  assert.equal(opensUp(a, { ...a, board: true }), true);
  assert.equal(opensUp(a, { ...a, remoteControl: true }), true);
  assert.equal(opensUp({ ...a, board: true }, a), false, 'closing the board again');
  assert.equal(opensUp(a, a), false);
});

test('while a project is locked, other sessions get its folders denied: file tools everywhere, the sandbox on macOS and Linux', () => {
  const mac = othersSettings(['/work/island', '/work/island-wt'], 'darwin')!;
  assert.deepEqual(mac.permissions.deny.slice(0, 4), ['Read(//work/island)', 'Read(//work/island/**)', 'Edit(//work/island)', 'Edit(//work/island/**)']);
  assert.ok(mac.permissions.deny.includes('Edit(//work/island-wt/**)'));
  // Enforced: no unsandboxed retry, and no sandbox auto-allow, so prompting stays as it was.
  assert.deepEqual({ ...mac.sandbox, filesystem: undefined }, {
    enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, filesystem: undefined,
  });
  assert.ok(mac.sandbox!.filesystem.denyRead.includes('/work/island'));
  assert.ok(mac.sandbox!.filesystem.denyWrite.includes('/work/island-wt'));

  const win = othersSettings(['C:\\work\\island'], 'win32')!;
  assert.equal(win.sandbox, undefined, 'native Windows has no sandbox: file tools only');
  assert.deepEqual(win.permissions.deny, ['Read(//c/work/island)', 'Read(//c/work/island/**)', 'Edit(//c/work/island)', 'Edit(//c/work/island/**)']);

  // Added to what the session's settings already hold, nothing dropped.
  const merged = withOthersSettings({ model: 'x', permissions: { deny: ['Read(//data)'], allow: ['Bash(ls)'] }, sandbox: { filesystem: { denyRead: ['/data'] } } }, mac)!;
  assert.equal(merged.model, 'x');
  const perms = merged.permissions as { deny: string[]; allow: string[] };
  assert.equal(perms.deny[0], 'Read(//data)');
  assert.ok(perms.deny.includes('Read(//work/island/**)'));
  assert.deepEqual(perms.allow, ['Bash(ls)']);
  const sandbox = merged.sandbox as { enabled: boolean; filesystem: { denyRead: string[] } };
  assert.equal(sandbox.enabled, true);
  assert.equal(sandbox.filesystem.denyRead[0], '/data');
  assert.ok(sandbox.filesystem.denyRead.includes('/work/island'));
});

/** A Ledung's session manager over real folders: island, island-wt (its worktrees), a workspace above it, and others. */
function ledung() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-lockdown-')));
  for (const d of ['work/island/sub', 'work/island-wt', 'work/mainland', 'work/fresh', 'work/inside-attempt']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const at = (d: string) => path.join(root, d);
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ browseRoots: [root], projects: [] }), store, () => {}));
  manager.addProject({ name: 'island', runner: 'local', path: at('work/island'), extraFolders: [at('work/island-wt')] } as never);
  manager.addProject({ name: 'mainland', runner: 'local', path: at('work/mainland') } as never);
  return { root, at, manager, store };
}

test("a locked project's folders are its own; level B is refused on Windows", async () => {
  const { at, manager } = ledung();
  const lockA = { name: 'island', runner: 'local', path: at('work/island'), extraFolders: [at('work/island-wt')], lockdown: { level: 'A' } };
  // Built in part 2 of #109; native Windows + level B is held by Martin (19:12, "Hold that one").
  if (process.platform === 'win32') {
    assert.throws(() => manager.updateProject('island', { ...lockA, lockdown: { level: 'B' } } as never), /level B \(nearly air-gapped\) is not available on Windows/);
    assert.equal(manager.projects().find((p) => p.name === 'island')!.lockdown.level, 'off', 'refused, not stored as A');
  }

  // Off: another project may share its folders, as today.
  manager.addProject({ name: 'before-lock', runner: 'local', path: at('work/island/sub') } as never);
  assert.throws(() => manager.updateProject('island', lockA as never), /"before-lock" has .*sub inside this project's folder/);
  manager.updateProject('before-lock', { name: 'before-lock', runner: 'local', path: at('work/island/sub'), lockdown: { level: 'A' } } as never);
  assert.equal(manager.projects().find((p) => p.name === 'before-lock')!.lockdown.level, 'A', 'a project inside another, unlocked one may lock itself');
  await manager.removeProject('before-lock');

  manager.updateProject('island', lockA as never);
  assert.equal(manager.projects().find((p) => p.name === 'island')!.lockdown.level, 'A');
  assert.throws(() => manager.addProject({ name: 'nested', runner: 'local', path: at('work/island/sub') } as never), /inside the locked project "island"/);
  assert.throws(() => manager.addProject({ name: 'worktree', runner: 'local', path: at('work/island-wt') } as never), /inside the locked project "island"/, 'its extra folders too');
  assert.throws(() => manager.updateProject('mainland', { name: 'mainland', runner: 'local', path: at('work/mainland'), extraFolders: [at('work/island')] } as never), /inside the locked project/);
  // A folder above it, such as a workspace, stays allowed; its sessions are denied the locked folders.
  manager.addProject({ name: 'workspace', runner: 'local', path: at('work') } as never);
  // A folder that is no part of the island is fine.
  manager.addProject({ name: 'fresh', runner: 'local', path: at('work/fresh') } as never);
});

test('turning lockdown off or down, letting the board in, or removing a locked project opens it up', () => {
  const { at, manager } = ledung();
  const base = { name: 'island', runner: 'local', path: at('work/island') };
  assert.equal(manager.lockdownOpensUp('island', { ...base, lockdown: { level: 'A' } }), false, 'locking needs no page');
  manager.updateProject('island', { ...base, lockdown: { level: 'A' } } as never);
  assert.equal(manager.lockdownOpensUp('island', base), true, 'off');
  assert.equal(manager.lockdownOpensUp('island', { ...base, lockdown: { level: 'A', board: true } }), true);
  assert.equal(manager.lockdownOpensUp('island', { ...base, lockdown: { level: 'A' }, model: 'opus' }), false, 'other settings as before');
  assert.equal(manager.lockdownOpensUp('island', null), true, 'removing it');
  assert.equal(manager.lockdownOpensUp('mainland', null), false, 'removing an unlocked one: as before');
});

test('a manager adding a project can lock it', () => {
  const { m, projects } = setup('off');
  const added: unknown[] = [];
  (m as unknown as { ctx: { addProject: (c: unknown) => ProjectInfo } }).ctx.addProject = (c) => {
    added.push(c);
    return { ...info('new'), where: '/x' };
  };
  void m.addProject('mgr-m', { name: 'new', folder: '/x', lockdown: 'A' });
  void m.addProject('mgr-m', { name: 'new2', folder: '/y', lockdown: 'off' });
  void m.addProject('mgr-m', { name: 'new3', folder: '/z' });
  assert.deepEqual(added.map((c) => (c as { lockdown?: unknown }).lockdown), [{ level: 'A' }, undefined, undefined]);
  assert.equal(projects.length, 3);
});

test("a session can't be started in a locked project's folder from a project above it", async () => {
  const { at, manager, store } = ledung();
  manager.addProject({ name: 'workspace', runner: 'local', path: at('work') } as never);
  manager.updateProject('island', { name: 'island', runner: 'local', path: at('work/island'), lockdown: { level: 'A' } } as never);
  // An unknown profile is refused right after the folder check, so without the check this fails fast
  // instead of starting Claude Code.
  await assert.rejects(manager.start('workspace', undefined, { cwd: at('work/island/sub'), profile: 'no-such-profile' }), /inside the locked project "island"/);
  await assert.rejects(manager.start('workspace', undefined, { cwd: at('work/fresh'), profile: 'no-such-profile' }), /no-such-profile/, 'a folder of its own gets past the check');
  assert.equal(store.listSessions().length, 0, 'refused before anything started');
});

/** A real Session under a manager; only the SDK's query is a stand-in, which ends when closed (as remote-control.test.ts). */
async function sessionUnderManager() {
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
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager: p', parentId: null, permissionMode: 'default', role: 'manager' });
  const make = async (id: string) => {
    const info = store.createSession({ id, project: 'p', runner: 'local', title: `Worker ${id}`, parentId: 'mgr', permissionMode: 'default', role: 'session' });
    let end: ((m: IteratorResult<unknown>) => void) | null = null;
    const stream = {
      close: () => end?.({ value: undefined, done: true }),
      accountInfo: async () => ({}),
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>((r) => { end = r; }) }),
    };
    const session = new Session({
      info, store, publish: () => {}, userName: 'Simon', management,
      runner: { cwd: '.', prepare: async () => {}, currentBranch: async () => null } as never,
      gate: { mayStart: () => true, started: () => {}, ended: () => {} },
      query: (() => stream) as never,
    });
    await session.start();
    return session;
  };
  return { store, make };
}

test("a session stopped only to restart it with new lockdown settings doesn't tell its manager; an ordinary stop does", async () => {
  const { store, make } = await sessionUnderManager();
  await (await make('w1')).stop('Ledung restarted this session to apply lockdown settings; its conversation is kept.', { restart: true });
  assert.equal(store.getSession('w1')!.status, 'ended');
  assert.deepEqual(store.undeliveredInbox('mgr').map((i) => i.text), [], 'nothing for the manager');
  await (await make('w2')).stop('Stopped.');
  assert.deepEqual(store.undeliveredInbox('mgr').map((i) => i.text), ['Ledung: session "Worker w2" (w2) ended: Stopped.'], 'as before');
});

// Through Ledung's own session manager, so the rule that closes the board is the real one (test review, finding 3).
test('the board is off for a locked project unless the user let it in', () => {
  const { at, manager } = ledung();
  const boards = manager.attachBoards(() => new FakeBackend(new FakeBoard(), 'me'));
  for (const p of ['island', 'mainland']) boards.setProjectSetting(p, { enabled: true, repo: 'org/board', allow: ['me'], channels: [], frontDesk: false });
  const island = (lockdown?: object) => ({ name: 'island', runner: 'local', path: at('work/island'), extraFolders: [at('work/island-wt')], ...(lockdown ? { lockdown } : {}) }) as never;
  assert.equal(boards.availableFor('island'), true, 'unlocked: as before');
  manager.updateProject('island', island({ level: 'A' }));
  assert.equal(boards.availableFor('island'), false, 'locked: off');
  assert.equal(boards.availableFor('mainland'), true, 'other projects: as before');
  manager.updateProject('island', island({ level: 'A', board: true }));
  assert.equal(boards.availableFor('island'), true, 'locked, with the board let in');
});

/**
 * A Ledung whose project folders don't exist, so a started session ends at once without Claude Code;
 * the test marks it running again, so the restart check sees a live session (test review, finding 1).
 */
function liveLedung() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-lockdown-live-')));
  const at = (d: string) => path.join(root, 'missing', d);
  const store = new Store(openDatabase(':memory:'));
  const projects = ['island', 'mainland', 'extra'].map((name) => ({ name, runner: 'local', path: at(name) }));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects }), store, () => {}));
  // Not idle, so the restart waits for it and the test can see it waiting.
  const running = async (project: string, role: 'session' | 'manager' = 'session') => {
    const s = await manager.start(project, undefined, { role });
    store.updateSession(s.id, { status: 'running' });
    return s.id;
  };
  const config = (name: string, extra: object = {}) => ({ name, runner: 'local', path: at(name), ...extra }) as never;
  const live = (id: string) => (manager as unknown as { live: Map<string, { claudeOptions(h: object): Promise<{ settings?: { permissions?: { deny?: string[] }; sandbox?: { enabled?: boolean } } }> }> }).live.get(id)!;
  return { manager, store, running, config, at, live };
}

test("with nothing locked, no save, removal or Restart Ledung restarts a session; locking restarts exactly the ones it changes", async () => {
  const { manager, store, running, config } = liveLedung();
  const worker = await running('mainland');
  const islandWorker = await running('island');
  const islandManager = await running('island', 'manager');
  // A session launched before lockdown existed has no record of its launch settings.
  store.database.prepare('DELETE FROM meta WHERE key = ?').run(`lockdown-launch:${worker}`);
  manager.updateProject('island', config('island', { model: 'haiku' }));
  assert.deepEqual(manager.waitingRelaunch(), [], 'a save');
  await manager.removeProject('extra');
  assert.deepEqual(manager.waitingRelaunch(), [], 'a removal');
  manager.relaunchChanged();
  assert.deepEqual(manager.waitingRelaunch(), [], 'as after Restart Ledung');

  manager.updateProject('island', config('island', { lockdown: { level: 'A' } }));
  // The other project's session gets the denied folder; the locked project's manager loses the board and
  // Remote Control; its plain session launches with nothing different, so it is left alone.
  assert.deepEqual(manager.waitingRelaunch().sort(), [worker, islandManager].sort());
  assert.ok(!manager.waitingRelaunch().includes(islandWorker));
});

test("a session of another project launches with the locked folder denied; with nothing locked its settings are as before", async () => {
  const { manager, running, config, at, live } = liveLedung();
  // Deny rules name the folder in Claude Code's form (//c/… on Windows, issue #127), not as a plain path.
  const island = rulePath(at('island'));
  const handlers = { onLine: () => {}, onStderr: () => {} };
  const before = await live(await running('mainland')).claudeOptions(handlers);
  assert.ok(!before.settings?.permissions?.deny?.some((d) => d.includes(island)), 'nothing locked: no deny rule for it');
  assert.equal(before.settings?.sandbox?.enabled, undefined, 'and no sandbox switched on');

  manager.updateProject('island', config('island', { lockdown: { level: 'A' } }));
  const after = await live(await running('mainland')).claudeOptions(handlers);
  const deny = after.settings?.permissions?.deny ?? [];
  assert.ok(deny.some((d) => d === `Read(${island})`), 'Read denied');
  assert.ok(deny.some((d) => d === `Edit(${island})`), 'Edit denied');
  if (process.platform !== 'win32') assert.equal(after.settings?.sandbox?.enabled, true, 'shell in the sandbox');
  const own = await live(await running('island')).claudeOptions(handlers);
  assert.ok(!own.settings?.permissions?.deny?.some((d) => d.includes(island)), 'the locked project keeps its own folder');
});
