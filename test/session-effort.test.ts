// Effort level (issue #202): start_session's effort and the project's default reach Claude Code as its own effort
// option, are kept for a resume as the model is, and an unknown level is refused with the levels there are. Claude
// Code doesn't refuse a level a model lacks, so the session says which level it got from what Claude Code's tool-call
// hook reports. The query is a stand-in for the SDK's Query (applyFlagSettings); the levels asserted are the issue's
// five: low, medium, high, xhigh, max.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { applyPatch, changedFields, parsePatch, settingsView } from '../src/projects/settings-tools.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { Management } from '../src/sessions/management.ts';
import { defaultEffortFor, SessionManager, UserError } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { EFFORT_LEVELS, effortLevel, type EffortLevel, type ProjectInfo } from '../src/shared/protocol.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { effortChoices, effortShown, projectEffort } from '../web/src/sidebarMenu.ts';
import { emptySettings, settingsOf, toApi } from '../web/src/projects/projectSettings.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-effort-')));
const home = path.join(base, 'home');
const folder = path.join(home, 'proj');
// The home and data folders are the test's own, so no real host record or AppData is ever read.
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.LEDUNG_DATA_DIR = path.join(home, 'ledung-data');
fs.mkdirSync(process.env.LEDUNG_DATA_DIR, { recursive: true });
fs.mkdirSync(folder, { recursive: true });
const prepare = LocalRunner.prototype.prepare;
const made: SessionManager[] = [];
after(() => {
  LocalRunner.prototype.prepare = prepare;
  for (const manager of made) manager.detachAll();
  try {
    removeTemp(base);
  } catch {
    // Left in the temp folder.
  }
});

const THE_FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
const handlers = { onLine: () => {}, onStderr: () => {} };
type Hook = (input: object, id: string, o: object) => Promise<unknown>;

/** A Session whose query records what it was launched with and each flag-settings call, failing when told to. */
async function running(opts: { effort?: EffortLevel; defaultEffort?: EffortLevel; fail?: boolean; start?: boolean; attachTo?: string; reported?: EffortLevel; settingsFile?: string } = {}) {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 'Worker', parentId: null, permissionMode: 'default', role: 'session', requestedEffort: opts.effort ?? null });
  // What Claude Code reported before a Ledung restart, as the store kept it.
  if (opts.reported) store.updateSession('s1', { effort: opts.reported });
  const info = store.getSession('s1')!;
  const flags: unknown[] = [];
  const stream = {
    accountInfo: async () => ({}),
    applyFlagSettings: async (settings: unknown) => {
      if (opts.fail) throw new Error('Claude Code said no');
      flags.push(settings);
    },
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }),
  };
  const events: string[] = [];
  const launched: Record<string, unknown>[] = [];
  const s = new Session({
    info, store, publish: (e) => events.push(e.type), userName: 'Simon', effort: opts.effort, defaultEffort: opts.defaultEffort, attachTo: opts.attachTo,
    ...(opts.settingsFile ? { profile: { settingsFile: opts.settingsFile, mcpServers: 'all', plugins: 'all', disallowedTools: [], userSettings: true } as never } : {}),
    management: new Proxy({}, { get: (_, k) => (k === 'questionTiers' ? () => [] : () => undefined) }) as never,
    runner: new LocalRunner({ name: 'p', runner: 'local', path: base } as never),
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    query: ((args: { options: Record<string, unknown> }) => { launched.push(args.options); return stream; }) as never,
  });
  if (opts.start !== false) await s.start();
  /** Claude Code's tool-call hook as it reports the effort of the turn; `effort` left out: a model without levels. */
  const toolCall = async (input: { effort?: { level: string }; agent_id?: string }) => {
    const hook = (await s.claudeOptions(handlers)).hooks!.PreToolUse![0]!.hooks[0]! as unknown as Hook;
    await hook({ tool_name: 'mcp__ledung__ask_user', tool_input: {}, ...input }, 'tu-1', { signal: new AbortController().signal });
  };
  /** Claude Code's end-of-turn hook, which carries the turn's effort too. */
  const turnEnd = async (input: { effort?: { level: string }; agent_id?: string }) => {
    const hook = (await s.claudeOptions(handlers)).hooks!.Stop![0]!.hooks[0]! as unknown as Hook;
    await hook({ hook_event_name: 'Stop', stop_hook_active: false, ...input }, 'stop-1', { signal: new AbortController().signal });
  };
  return { s, store, flags, events, launched, toolCall, turnEnd };
}

const notes = (store: Store, id = 's1') => store.listMessages(id, { limit: 50 }).filter((m) => m.kind === 'event').map((m) => String(m.data.text));

test('the levels are the five Claude Code has, and a level is taken by its name whatever its case', () => {
  assert.deepEqual([...EFFORT_LEVELS], THE_FIVE);
  assert.equal(effortLevel(' High '), 'high');
  assert.equal(effortLevel('xhigh'), 'xhigh');
  assert.equal(effortLevel('ultra'), null);
  assert.equal(effortLevel(3), null);
  assert.equal(effortLevel(''), null);
});

test("a session's own effort reaches Claude Code as its effort option; none asked for leaves the option out", async () => {
  const own = await running({ effort: 'high' });
  assert.equal(own.launched.length, 1);
  assert.equal(own.launched[0]!.effort, 'high');
  const none = await running();
  assert.equal('effort' in none.launched[0]!, false, "nothing passed: Claude Code's own default, as before");
});

test("the project's default is used when the session names none, and loses to the session's own", async () => {
  assert.equal((await running({ defaultEffort: 'medium' })).launched[0]!.effort, 'medium');
  assert.equal((await running({ effort: 'max', defaultEffort: 'medium' })).launched[0]!.effort, 'max');
});

test("the project's default is left out when the profile's settings file names an effort; the session's own still wins", async () => {
  const withFile = async (effort?: EffortLevel) => {
    const r = await running({ effort, defaultEffort: 'medium', start: false });
    (r.s as unknown as { fileSettings: Record<string, unknown> }).fileSettings = { effortLevel: 'low' };
    return (await r.s.claudeOptions(handlers)) as unknown as Record<string, unknown>;
  };
  assert.equal('effort' in (await withFile()), false, "the file's own level decides");
  assert.equal((await withFile('high')).effort, 'high');
});

test("a manager has its own default effort; empty: the same as its sessions; none: nothing, so Claude Code's own", () => {
  const both = { effort: 'medium', managerEffort: 'xhigh' } as const;
  assert.equal(defaultEffortFor(both, 'manager'), 'xhigh');
  assert.equal(defaultEffortFor(both, 'session'), 'medium');
  assert.equal(defaultEffortFor({ effort: 'medium' }, 'manager'), 'medium');
  assert.equal(defaultEffortFor({ managerEffort: 'xhigh' }, 'session'), undefined);
  assert.equal(defaultEffortFor({}, 'manager'), undefined);
});

test('the session says which level it got: the one it asked for', async () => {
  const { store, toolCall } = await running({ effort: 'high' });
  assert.equal(store.getSession('s1')!.effort, null, 'not known before Claude Code says');
  await toolCall({ effort: { level: 'high' } });
  assert.equal(store.getSession('s1')!.effort, 'high');
  assert.deepEqual(notes(store).filter((t) => t.startsWith('Effort')), ['Effort: runs with high.']);
  await toolCall({ effort: { level: 'high' } });
  assert.equal(notes(store).filter((t) => t.startsWith('Effort')).length, 1, 'said once, not on every tool call');
});

test('a level its model lacks does not fail the start: it says the level Claude Code stepped down to', async () => {
  const { store, toolCall } = await running({ effort: 'max' });
  assert.equal(store.getSession('s1')!.status === 'ended', false, 'started');
  await toolCall({ effort: { level: 'high' } });
  assert.equal(store.getSession('s1')!.effort, 'high');
  assert.ok(notes(store).includes('Effort: asked for max; Claude Code runs this model with high.'), notes(store).join(' | '));
});

test('a model with no effort levels: the session runs, and says it runs without one', async () => {
  const { store, toolCall } = await running({ effort: 'high' });
  await toolCall({});
  assert.equal(store.getSession('s1')!.effort, null);
  assert.ok(notes(store).some((t) => t.startsWith('Effort: asked for high; Claude Code reports no effort level for this model')), notes(store).join(' | '));
});

test("a subagent's tool call says the subagent's effort, not the session's; and none asked for says nothing", async () => {
  const sub = await running({ effort: 'high' });
  await sub.toolCall({ effort: { level: 'low' }, agent_id: 'a1' });
  assert.equal(sub.store.getSession('s1')!.effort, null);
  assert.equal(notes(sub.store).filter((t) => t.startsWith('Effort')).length, 0);
  // The same probe finds the line when the call is the session's own.
  await sub.toolCall({ effort: { level: 'high' } });
  assert.equal(notes(sub.store).filter((t) => t.startsWith('Effort')).length, 1);
  const quiet = await running();
  await quiet.toolCall({ effort: { level: 'medium' } });
  assert.equal(quiet.store.getSession('s1')!.effort, 'medium', 'its info still shows what it runs with');
  assert.equal(notes(quiet.store).filter((t) => t.startsWith('Effort')).length, 0);
});

test('a turn with no tool call still says the level, at its end: on the info and once in the history', async () => {
  const { store, turnEnd, toolCall } = await running({ effort: 'high' });
  assert.equal(store.getSession('s1')!.effort, null, 'not known before Claude Code says');
  await turnEnd({ effort: { level: 'high' } });
  assert.equal(store.getSession('s1')!.effort, 'high');
  assert.deepEqual(notes(store).filter((t) => t.startsWith('Effort')), ['Effort: runs with high.']);
  // Said once: neither the next turn's end nor a later tool call with the same level repeats it.
  await turnEnd({ effort: { level: 'high' } });
  await toolCall({ effort: { level: 'high' } });
  assert.equal(notes(store).filter((t) => t.startsWith('Effort')).length, 1);
  // A turn's end that names no level leaves the known one alone; a stepped-down one is said as such.
  await turnEnd({});
  assert.equal(store.getSession('s1')!.effort, 'high');
  const down = await running({ effort: 'max' });
  await down.turnEnd({ effort: { level: 'high' } });
  assert.deepEqual(notes(down.store).filter((t) => t.startsWith('Effort')), ['Effort: asked for max; Claude Code runs this model with high.']);
});

test('a change made mid-turn may first report the old level; the line follows when the new one is reported', async () => {
  const { s, store, toolCall, turnEnd } = await running({ effort: 'high' });
  await toolCall({ effort: { level: 'high' } });
  await s.setEffort('low', 'user');
  await toolCall({ effort: { level: 'high' } });
  await turnEnd({ effort: { level: 'high' } });
  await toolCall({ effort: { level: 'low' } });
  await toolCall({ effort: { level: 'low' } });
  assert.deepEqual(notes(store).filter((t) => t.startsWith('Effort: ')), [
    'Effort: runs with high.',
    'Effort: asked for low; Claude Code runs this model with high.',
    'Effort: runs with low.',
  ]);
  assert.equal(store.getSession('s1')!.effort, 'low');
});

test("reconnected with a profile settings file, what was asked can't be told: only the level is said", async () => {
  // The file may name its own effort, which is not read again on a reconnect; the project's default must not be called asked.
  const filed = await running({ defaultEffort: 'medium', attachTo: 'pipe-of-a-running-host', settingsFile: '.claude/lean.json', start: false });
  await filed.toolCall({ effort: { level: 'low' } });
  assert.deepEqual(notes(filed.store).filter((t) => t.startsWith('Effort')), ['Effort: runs with low.']);
  // Without a settings file the default is what was asked, and a different level is said as such.
  const plain = await running({ defaultEffort: 'medium', attachTo: 'pipe-of-a-running-host', start: false });
  await plain.toolCall({ effort: { level: 'low' } });
  assert.deepEqual(notes(plain.store).filter((t) => t.startsWith('Effort')), ['Effort: asked for medium; Claude Code runs this model with low.']);
});

test('a session reconnected after a Ledung restart does not say its level again, but its info still follows Claude Code', async () => {
  const again = await running({ effort: 'max', attachTo: 'pipe-of-a-running-host', reported: 'high', start: false });
  await again.toolCall({ effort: { level: 'high' } });
  assert.equal(again.store.getSession('s1')!.effort, 'high');
  assert.equal(notes(again.store).filter((t) => t.startsWith('Effort')).length, 0, 'it reported before the restart and said it then');
  // Reconnected before its first tool call, it still owes the line: the same probe finds it.
  const early = await running({ effort: 'high', attachTo: 'pipe-of-a-running-host', start: false });
  await early.toolCall({ effort: { level: 'high' } });
  assert.deepEqual(notes(early.store).filter((t) => t.startsWith('Effort')), ['Effort: runs with high.']);
});

test('a running session changes effort through Claude Code, keeps it for a resume and says so in its history', async () => {
  const { s, store, flags, events, toolCall } = await running({ effort: 'low' });
  await s.setEffort('xhigh', 'user');
  assert.deepEqual(flags, [{ effortLevel: 'xhigh' }]);
  assert.equal(store.getSession('s1')!.requestedEffort, 'xhigh', 'what a resume starts with');
  assert.ok(notes(store).some((t) => t.includes('Effort set to xhigh by Simon; it applies from the next reply')));
  assert.ok(events.includes('session'), 'the page hears of it');
  await toolCall({ effort: { level: 'xhigh' } });
  assert.ok(notes(store).includes('Effort: runs with xhigh.'), 'the new level is confirmed once Claude Code reports it');
});

test("back to the project's default: named outright when there is one, else it waits for the resume", async () => {
  const named = await running({ effort: 'high', defaultEffort: 'medium' });
  await named.s.setEffort(null, 'user');
  assert.deepEqual(named.flags, [{ effortLevel: 'medium' }]);
  assert.equal(named.store.getSession('s1')!.requestedEffort, null);
  const unnamed = await running({ effort: 'high' });
  await unnamed.s.setEffort(null, 'user');
  assert.deepEqual(unnamed.flags, [], "clearing the flag would be the model's own default, not the project's settings");
  assert.ok(notes(unnamed.store).some((t) => t.includes('applies when the session is resumed')));
});

test('a session still starting is launched with the effort chosen meanwhile; a refused change keeps the stored one', async () => {
  const early = await running({ start: false });
  await early.s.setEffort('max', 'user');
  assert.deepEqual(early.flags, []);
  await early.s.start();
  assert.equal(early.launched[0]!.effort, 'max');
  const refused = await running({ effort: 'low', fail: true });
  await assert.rejects(refused.s.setEffort('high', 'user'), /Claude Code said no/);
  assert.equal(refused.store.getSession('s1')!.requestedEffort, 'low');
});

/** A Ledung with one project, whose Claude Code never starts: a session ends at once, as in the chats tests. */
function ledung(project: object = {}, store = new Store(openDatabase(':memory:'))) {
  LocalRunner.prototype.prepare = async function () { throw new Error('no Claude Code in tests'); };
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    userName: 'Simon', browseRoots: [home], chats: { folder: home },
    projects: [{ name: 'proj', runner: 'local', path: folder, ...project }],
  }), store, () => {}));
  made.push(manager);
  const live = (id: string) => (manager as unknown as { live: Map<string, { claudeOptions(h: object): Promise<Record<string, unknown>> }> }).live.get(id)!;
  const launchEffort = async (id: string) => (await live(id).claudeOptions(handlers)).effort;
  return { manager, store, launchEffort };
}

test('a resumed session keeps the effort it was started with, as it keeps its model', async () => {
  const { manager, store, launchEffort } = ledung({ effort: 'medium' });
  const s = await manager.start('proj', undefined, { effort: 'XHigh', model: 'haiku' });
  assert.equal(s.requestedEffort, 'xhigh');
  assert.equal(await launchEffort(s.id), 'xhigh');
  store.updateSession(s.id, { claudeSessionId: 'abc', status: 'ended' });
  await manager.resume(s.id);
  assert.equal(store.getSession(s.id)!.requestedEffort, 'xhigh');
  assert.equal(await launchEffort(s.id), 'xhigh', 'the new Claude Code process is given it again');
  // A new manager on the same database (a Ledung restart) resumes it with the same.
  const again = ledung({ effort: 'medium' }, store);
  store.updateSession(s.id, { status: 'ended' });
  await again.manager.resume(s.id);
  assert.equal(await again.launchEffort(s.id), 'xhigh');
});

test("a project's default effort is used by a session that names none, and by its manager unless it has its own", async () => {
  const { manager, launchEffort } = ledung({ effort: 'medium', managerEffort: 'max' });
  const plain = await manager.start('proj');
  assert.equal(plain.requestedEffort, null);
  assert.equal(await launchEffort(plain.id), 'medium');
  const lead = await manager.start('proj', undefined, { role: 'manager' });
  assert.equal(await launchEffort(lead.id), 'max');
  const none = ledung();
  const bare = await none.manager.start('proj');
  assert.equal(await none.launchEffort(bare.id), undefined, "no default: Claude Code's own, as today");
  assert.equal(manager.projects().find((p) => p.name === 'proj')!.effort, 'medium', 'the page is told the default');
});

test('an unknown effort is refused with the levels there are, and nothing starts', async () => {
  const { manager, store } = ledung();
  const refusal = (e: Error) => e instanceof UserError && e.message === 'Unknown effort "ultra". Choose low, medium, high, xhigh, max.';
  await assert.rejects(manager.start('proj', undefined, { effort: 'ultra' }), refusal);
  await assert.rejects(manager.startChat({ effort: 'ultra' }), refusal);
  // New chat's call passes what the page sent: a value that is no level's name is refused too, never dropped.
  await assert.rejects(manager.startChat({ effort: 5 }), (e: Error) => e instanceof UserError && e.message === 'Unknown effort 5. Choose low, medium, high, xhigh, max.');
  assert.equal(store.listSessions().length, 0, 'no session was made');
  // The same calls with a real level do start one.
  assert.equal((await manager.start('proj', undefined, { effort: 'low' })).requestedEffort, 'low');
  assert.equal((await manager.startChat({ effort: 'max' })).requestedEffort, 'max');
  assert.equal(store.listSessions().length, 2);
});

test("the sidebar menu's Effort on an ended session is kept for its resume; only the levels or null are taken", async () => {
  const { manager, store } = ledung();
  const chat = await manager.startChat({});
  assert.equal(store.getSession(chat.id)!.status, 'ended');
  assert.equal((await manager.setEffort(chat.id, 'high')).requestedEffort, 'high');
  assert.ok(notes(store, chat.id).some((t) => t.includes('Effort set to high by Simon; it applies when the session is resumed')));
  assert.equal((await manager.setEffort(chat.id, null)).requestedEffort, null);
  await assert.rejects(manager.setEffort(chat.id, 'ultra'), /Unknown effort "ultra"\. Choose low, medium, high, xhigh, max\./);
  await assert.rejects(manager.setEffort(chat.id, 42), /Choose low, medium, high, xhigh, max/);
  await assert.rejects(manager.setEffort('nope', 'high'), /No such session/);
  assert.equal(store.getSession(chat.id)!.requestedEffort, null);
});

/** A manager's tools with the starts and added projects recorded. */
function tools() {
  const store = new Store(openDatabase(':memory:'));
  const started: { effort?: string }[] = [];
  const added: Record<string, unknown>[] = [];
  const project = (name: string) => ({ name, where: `/home/${name}` }) as ProjectInfo;
  const m = new Management({
    store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async () => {},
    startSession: async (p, _task, opts) => {
      started.push({ effort: opts.effort });
      return store.createSession({ id: `w${started.length}`, project: p, runner: 'local', title: 'worker', parentId: opts.parentId, permissionMode: 'default' });
    },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p'], decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {}, handoffProblem: () => null, shotPath: (_id, file) => file,
    projects: () => [],
    addProject: (config) => { added.push(config as never); return project(config.name); },
    createProject: async (o) => { added.push(o.settings as never); return { project: project(o.settings.name), warning: null, githubUrl: null }; },
    ensureManager: async () => { throw new Error('not used'); },
  });
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager', parentId: null, permissionMode: 'default', role: 'manager' });
  return { m, store, started, added };
}

test("start_session passes the manager's effort on, and refuses an unknown one with the levels before anything starts", async () => {
  const { m, started } = tools();
  await m.startSession('mgr', { task: 'review the docs', effort: 'high' });
  await m.startSession('mgr', { task: 'fix the bug' });
  assert.deepEqual(started, [{ effort: 'high' }, { effort: undefined }]);
  await assert.rejects(m.startSession('mgr', { task: 'think hard', effort: 'ultra' }), /Unknown effort "ultra"\. Choose low, medium, high, xhigh, max\./);
  assert.equal(started.length, 2, 'the refused one started nothing');
});

test('add_project and create_project take a default effort, and refuse an unknown one with the levels', async () => {
  const { m, added } = tools();
  await m.addProject('mgr', { name: 'Web', folder: '/home/web', effort: 'High' });
  await m.createProject('mgr', { name: 'New', effort: 'low' } as never);
  await m.addProject('mgr', { name: 'Plain', folder: '/home/plain' });
  assert.deepEqual(added.map((c) => c.effort), ['high', 'low', undefined]);
  await assert.rejects(m.addProject('mgr', { name: 'Bad', folder: '/home/bad', effort: 'ultra' }), /Unknown effort "ultra"\. Choose low, medium, high, xhigh, max\./);
  assert.equal(added.length, 3, 'the refused one added nothing');
});

test("a project's config takes the two efforts and refuses an unknown level", () => {
  const config = (extra: object) => parseConfig({ userName: 'Simon', projects: [{ name: 'proj', runner: 'local', path: folder, ...extra }] }).projects[0]!;
  assert.equal(config({ effort: 'xhigh', managerEffort: 'max' }).effort, 'xhigh');
  assert.equal(config({ effort: 'xhigh', managerEffort: 'max' }).managerEffort, 'max');
  assert.equal(config({}).effort, undefined);
  assert.throws(() => config({ effort: 'ultra' }), /effort/);
});

test('set_project_settings changes and clears the default efforts, and refuses an unknown level naming the valid ones', () => {
  const before = parseConfig({ userName: 'Simon', projects: [{ name: 'proj', runner: 'local', path: folder, managerEffort: 'max' }] }).projects[0]!;
  const parsed = parsePatch({ project: 'proj', effort: 'high', managerEffort: null });
  assert.ok('patch' in parsed);
  const after = applyPatch(before, parsed.patch) as typeof before;
  assert.equal(after.effort, 'high');
  assert.equal('managerEffort' in after, false, 'null clears it');
  assert.deepEqual(changedFields(before, after), ['effort', 'managerEffort']);
  assert.equal(settingsView(after, []).effort, 'high');
  assert.equal(settingsView(after, []).managerEffort, null);
  const bad = parsePatch({ project: 'proj', effort: 'ultra' });
  assert.ok('problem' in bad);
  for (const level of THE_FIVE) assert.ok(bad.problem.includes(level), `${level} in: ${bad.problem}`);
});

test('the store keeps the effort asked for and the one it runs with (a new migration)', () => {
  const store = new Store(openDatabase(':memory:'));
  const s = store.createSession({ id: 'a', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default', requestedEffort: 'xhigh' });
  assert.equal(s.requestedEffort, 'xhigh');
  assert.equal(s.effort, null);
  store.updateSession('a', { effort: 'high', requestedEffort: null });
  assert.equal(store.getSession('a')!.effort, 'high');
  assert.equal(store.getSession('a')!.requestedEffort, null);
  const plain = store.createSession({ id: 'b', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default' });
  assert.equal(plain.requestedEffort, null);
});

test('the page: the efforts offered, what a session shows, and the project form', () => {
  assert.deepEqual(effortChoices().map((c) => c.effort), [null, ...THE_FIVE], "the project's default first, then the five");
  assert.equal(projectEffort({ effort: 'medium', managerEffort: 'max' }, 'manager'), 'max');
  assert.equal(projectEffort({ effort: 'medium', managerEffort: null }, 'manager'), 'medium');
  assert.equal(projectEffort({ effort: 'medium', managerEffort: 'max' }, 'session'), 'medium');
  assert.equal(projectEffort(undefined, 'session'), null);
  // What it runs with once Claude Code has said, until then what was asked, marked so; nothing when there is nothing.
  assert.equal(effortShown({ effort: 'high', requestedEffort: 'max' }, null)!.text, 'effort high');
  assert.equal(effortShown({ effort: null, requestedEffort: 'max' }, 'low')!.text, 'effort max (asked)');
  assert.equal(effortShown({ effort: null, requestedEffort: null }, 'low')!.text, 'effort low (asked)');
  assert.equal(effortShown({ effort: null, requestedEffort: null }, null), null);
  // The form: empty is the default and is left out of what is saved.
  const sent = toApi({ ...emptySettings('Demo'), effort: 'high', managerEffort: 'xhigh' }, null);
  assert.equal(sent.effort, 'high');
  assert.equal(sent.managerEffort, 'xhigh');
  const empty = toApi(emptySettings('Demo'), null);
  assert.equal('effort' in empty, false);
  assert.equal('managerEffort' in empty, false);
  const shown = settingsOf({ ...BASE_PROJECT, effort: 'low', managerEffort: null });
  assert.equal(shown.effort, 'low');
  assert.equal(shown.managerEffort, '');
});

const BASE_PROJECT = {
  name: 'Demo', runner: 'local', where: '/home/demo', account: null, model: null, managerModel: null, permissionMode: null, managerGrant: null, projectToolsUnasked: false,
  profiles: { manager: null, session: null }, skills: {}, sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] }, devShipCommand: null, tickets: null,
  questionTiers: [], extraFolders: [], workflow: null, lockdown: { level: 'off', board: false, remoteControl: false }, managerId: null, createdAt: 0,
} as unknown as ProjectInfo;
