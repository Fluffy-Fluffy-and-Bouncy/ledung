// Issue #116: a project can be renamed from its settings in the page. Everything stored under its name
// moves with it, a running session keeps running, a taken or invalid name changes nothing, and no
// manager tool can do it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { ProjectStore } from '../src/projects/store.ts';
import { BoardStore } from '../src/board/store.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { parseConfig } from '../src/config.ts';
import { ledungToolServer, type ManagerHandlers } from '../src/sessions/tools.ts';
import { readFilter, renameInFilter, writeFilter } from '../web/src/waitingLists.ts';
import type { ServerEvent } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const NO_SENSITIVE = { commandPatterns: [], pathPatterns: [], mcpTools: [] };

/** A project "web" with a manager, a session under it, a question, usage, a turn record and board records; and a project "api". */
function seeded(db = openDatabase(':memory:')) {
  const store = new Store(db);
  const projects = new ProjectStore(db);
  projects.add({ name: 'web', runner: 'local', path: 'C:/p/web', model: 'haiku', sensitive: NO_SENSITIVE });
  projects.add({ name: 'api', runner: 'local', path: 'C:/p/api', sensitive: NO_SENSITIVE });
  store.createSession({ id: 'mgr', project: 'web', runner: 'local', title: 'Manager: web', parentId: null, permissionMode: 'default', role: 'manager' });
  store.createSession({ id: 's1', project: 'web', runner: 'local', title: 'Fix the cart', parentId: 'mgr', permissionMode: 'default' });
  store.createSession({ id: 'other', project: 'api', runner: 'local', title: 'Manager: api', parentId: null, permissionMode: 'default', role: 'manager' });
  projects.setManager('web', 'mgr');
  projects.setColours('web', { manager: 'teal', sessions: 'same' });
  projects.setOrder(['api', 'web']);
  const open = store.createQuestion({ sessionId: 's1', question: 'Which branch?', options: null, addressedTo: 'mgr' });
  const answered = store.createQuestion({ sessionId: 'mgr', question: 'Merge it?', options: null, addressedTo: 'user' });
  store.answerQuestion(answered.id, 'yes', 'user');
  store.addUsage({
    sessionId: 's1', messageId: 'm1', at: 1, model: 'haiku', input: 1, cacheWrite: 0, cacheRead: 0, output: 1, thinking: null, cost: null,
    project: 'web', role: 'session', team: 'mgr', subagent: null, branch: null, trigger: 'user', machine: 'pc',
  });
  store.addTurnResource({
    sessionId: 's1', project: 'web', role: 'session', model: 'haiku', trigger: 'user', startedAt: 1, durationMs: 1, cpuSeconds: 0, samples: 1,
    avgCores: 0, peakCores: 0, peakMem: 0, commands: [],
  });
  const board = new BoardStore(db);
  board.setProjectSetting('web', { enabled: true, repo: 'org/board', allow: ['friend'], channels: [] });
  board.setFrontDesk('org/board', 'web');
  const repo = board.repo('org/board');
  repo.addPost({ id: 'p1', threadId: 't1', author: 'me', viaLedung: true, fromProject: 'web', recipients: ['@friend'], text: 'hi', at: 1, receivedAt: 1, direction: 'out', status: 'sent' });
  repo.addDelivery('p1', 'web', 'wake', 1, false);
  repo.addOutbox({ project: 'web', managerId: 'mgr', threadId: null, title: 't', recipients: ['@friend'], text: 'x', attachments: [], createdAt: 1 });
  return { db, store, projects, board, open, answered };
}

/** How many rows of each project-keyed column still name this project. */
function rowsNaming(db: ReturnType<typeof openDatabase>, name: string): Record<string, number> {
  const count = (sql: string) => (db.prepare(sql).get(name) as { n: number }).n;
  return {
    sessions: count('SELECT count(*) AS n FROM sessions WHERE project = ?'),
    usage: count('SELECT count(*) AS n FROM usage WHERE project = ?'),
    // Moved by the database's own triggers when usage moves (#362), not by a line in ProjectStore.rename.
    usageDaily: count('SELECT count(*) AS n FROM usage_daily WHERE project = ?'),
    turns: count('SELECT count(*) AS n FROM turn_resources WHERE project = ?'),
    boardSetting: count('SELECT count(*) AS n FROM board_projects WHERE name = ?'),
    frontDesk: count('SELECT count(*) AS n FROM board_boards WHERE front_desk = ?'),
    deliveries: count('SELECT count(*) AS n FROM board_deliveries WHERE project = ?'),
    posts: count('SELECT count(*) AS n FROM board_posts WHERE from_project = ?'),
    outbox: count('SELECT count(*) AS n FROM board_outbox WHERE project = ?'),
  };
}

const ALL_OF_WEB = { sessions: 2, usage: 1, usageDaily: 1, turns: 1, boardSetting: 1, frontDesk: 1, deliveries: 1, posts: 1, outbox: 1 };
const NONE = { sessions: 0, usage: 0, usageDaily: 0, turns: 0, boardSetting: 0, frontDesk: 0, deliveries: 0, posts: 0, outbox: 0 };

test('a rename moves everything stored under the name, and keeps settings, folder, manager, colours and place', () => {
  const { db, store, projects, board, open, answered } = seeded();
  const renamed = projects.rename('web', 'Project Web');
  assert.equal(renamed.config.name, 'Project Web');
  assert.equal(renamed.config.runner === 'local' && renamed.config.path, 'C:/p/web', 'the folder is not moved');
  assert.equal(renamed.config.model, 'haiku');
  assert.equal(renamed.managerId, 'mgr');
  assert.deepEqual(renamed.colours, { manager: 'teal', sessions: 'same' });
  assert.equal(projects.get('web'), undefined);
  assert.deepEqual(projects.list().map((p) => p.config.name), ['api', 'Project Web'], 'its place in the order');
  assert.deepEqual(rowsNaming(db, 'web'), NONE);
  assert.deepEqual(rowsNaming(db, 'Project Web'), ALL_OF_WEB);
  // Its manager's default title follows; a title someone chose would not (the session's stays).
  assert.equal(store.getSession('mgr')!.title, 'Manager: Project Web');
  assert.equal(store.getSession('s1')!.title, 'Fix the cart');
  // Questions hang off its sessions: open and answered ones stay attached, unchanged.
  assert.equal(store.getQuestion(open.id)!.status, 'open');
  assert.equal(store.getQuestion(answered.id)!.answer, 'yes');
  assert.equal(store.getSession(store.getQuestion(open.id)!.sessionId)!.project, 'Project Web');
  assert.equal(board.projectSetting('Project Web').repo, 'org/board');
  assert.equal(board.frontDesk('org/board'), 'Project Web');
  // The other project is untouched.
  assert.equal(store.getSession('other')!.project, 'api');
  assert.equal(store.getSession('other')!.title, 'Manager: api');
});

// A column added later that holds a project's name must be moved by rename too: this fails until it is
// listed here and in ProjectStore.rename.
test('every column that holds a project name is one rename moves', () => {
  const db = openDatabase(':memory:');
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name);
  const found = tables.flatMap((t) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[])
    .filter((c) => c.name === 'project' || c.name.endsWith('_project') || c.name === 'front_desk' || (c.name === 'name' && /project/.test(t)))
    .map((c) => `${t}.${c.name}`)).sort();
  assert.deepEqual(found, [
    'board_boards.front_desk', 'board_deliveries.project', 'board_outbox.project', 'board_posts.from_project', 'board_projects.name',
    'projects.name', 'sessions.project', 'turn_resources.project', 'usage.project', 'usage_daily.project',
  ]);
});

test('a taken name, a name the rules refuse, or an unknown project changes nothing', () => {
  const { db, store, projects } = seeded();
  assert.throws(() => projects.rename('web', 'api'), /already a project named "api"/);
  assert.throws(() => projects.rename('web', '../evil'), /letters, digits/);
  assert.throws(() => projects.rename('web', ''), /letters, digits/);
  assert.throws(() => projects.rename('web', 'x'.repeat(49)), /letters, digits/);
  assert.throws(() => projects.rename('nope', 'new'), /no project named "nope"/);
  assert.deepEqual(projects.list().map((p) => p.config.name), ['api', 'web']);
  assert.deepEqual(rowsNaming(db, 'web'), ALL_OF_WEB);
  assert.equal(store.getSession('mgr')!.title, 'Manager: web');
  // The same name again is no change at all.
  assert.equal(projects.rename('web', 'web').config.name, 'web');
});

test("a removed project's name can be taken; the renamed project's own board setting wins", () => {
  const { db, projects, board } = seeded();
  projects.add({ name: 'old', runner: 'local', path: 'C:/p/old', sensitive: NO_SENSITIVE });
  board.setProjectSetting('old', { enabled: false, repo: 'org/elsewhere', allow: [], channels: [] });
  projects.remove('old');
  projects.rename('web', 'old');
  assert.equal(projects.get('old')!.managerId, 'mgr');
  assert.equal(board.projectSetting('old').repo, 'org/board');
  assert.equal((db.prepare('SELECT count(*) AS n FROM projects WHERE name = ?').get('old') as { n: number }).n, 1);
});

test('the rename survives a restart: the database read afresh has the new name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-rename-'));
  try {
    const file = path.join(dir, 'ledung.db');
    const first = seeded(openDatabase(file));
    first.projects.rename('web', 'Project Web');
    first.db.close();
    const db = openDatabase(file);
    const projects = new ProjectStore(db);
    assert.deepEqual(projects.list().map((p) => p.config.name), ['api', 'Project Web']);
    assert.equal(projects.get('Project Web')!.managerId, 'mgr');
    assert.deepEqual(rowsNaming(db, 'Project Web'), ALL_OF_WEB);
    db.close();
  } finally {
    removeTemp(dir);
  }
});

test('a project that came from the config file does not come back under its old name after a rename', () => {
  const projects = new ProjectStore(openDatabase(':memory:'));
  const listed = [{ name: 'web', runner: 'local' as const, path: 'C:/p/web', sensitive: NO_SENSITIVE }];
  assert.deepEqual(projects.importFromConfig(listed), ['web']);
  projects.rename('web', 'Project Web');
  assert.deepEqual(projects.importFromConfig(listed), []);
  assert.deepEqual(projects.list().map((p) => p.config.name), ['Project Web']);
});

test('a project with a running session is renamed without stopping it; the page hears of the new name', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-rename-live-')));
  const at = (d: string) => path.join(root, 'missing', d);
  const store = new Store(openDatabase(':memory:'));
  const events: ServerEvent[] = [];
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects: ['web', 'api'].map((name) => ({ name, runner: 'local', path: at(name) })) }), store, (e) => events.push(e)));
  const mgr = await manager.start('web', undefined, { role: 'manager' });
  const s = await manager.start('web', undefined, { parentId: mgr.id, title: 'Worker' });
  store.updateSession(s.id, { status: 'running' });
  const q = store.createQuestion({ sessionId: s.id, question: 'Which branch?', options: null, addressedTo: mgr.id });
  events.length = 0;

  assert.throws(() => manager.renameProject('web', 'api'), /already a project named "api"/);
  assert.throws(() => manager.renameProject('web', 42), /new name/);
  assert.equal(events.length, 0, 'a refused rename tells the page nothing');

  const info = manager.renameProject('web', ' Project Web ');
  assert.equal(info.name, 'Project Web', 'spaces around the name are trimmed');
  assert.equal(info.managerId, mgr.id);
  assert.deepEqual(manager.projects().map((p) => p.name), ['Project Web', 'api']);
  const byId = new Map(manager.sessions().map((x) => [x.id, x]));
  assert.equal(byId.get(s.id)!.project, 'Project Web');
  assert.equal(byId.get(s.id)!.status, 'running', 'not cut off');
  assert.equal(byId.get(mgr.id)!.title, 'Manager: Project Web');
  assert.equal(manager.questions().find((x) => x.id === q.id)!.status, 'open');
  // Sessions keep working under the new name: a new one starts there, and the old name is gone.
  assert.equal((await manager.start('Project Web', undefined, { parentId: mgr.id })).project, 'Project Web');
  await assert.rejects(manager.start('web'), /no project named "web"/);
  // The page is told: the project list, and each of its sessions with the new name.
  const projectsEvent = events.find((e) => e.type === 'projects');
  assert.ok(projectsEvent && projectsEvent.type === 'projects' && projectsEvent.projects.some((p) => p.name === 'Project Web'));
  const told = events.flatMap((e) => (e.type === 'session' ? [e.session] : [])).filter((x) => x.id === s.id || x.id === mgr.id);
  assert.deepEqual(new Set(told.map((x) => x.project)), new Set(['Project Web']));
  assert.deepEqual(new Set(told.map((x) => x.id)), new Set([s.id, mgr.id]));
});

// review-116 m1: the page sends the new name and the other settings together, so a refused setting
// leaves the old name and nothing else is half saved.
test('a rename with settings is one change: refused settings leave the old name, accepted ones are saved', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-rename-settings-')));
  const at = (d: string) => path.join(root, 'missing', d);
  const store = new Store(openDatabase(':memory:'));
  const events: ServerEvent[] = [];
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects: [{ name: 'web', runner: 'local', path: at('web'), model: 'haiku' }] }), store, (e) => events.push(e)));
  const settings = (extra: object) => ({ name: 'Project Web', runner: 'local', path: at('web'), ...extra }) as never;

  assert.throws(() => manager.renameProject('web', 'Project Web', settings({ model: 'opus', account: 'nobody' })), /no account named "nobody"/);
  assert.deepEqual(manager.projects().map((p) => [p.name, p.model]), [['web', 'haiku']], 'the old name and the old settings');
  assert.equal(events.length, 0, 'the page is told nothing');

  const info = manager.renameProject('web', 'Project Web', settings({ model: 'opus' }));
  assert.equal(info.name, 'Project Web');
  assert.equal(info.model, 'opus');
  assert.deepEqual(manager.projects().map((p) => [p.name, p.model]), [['Project Web', 'opus']]);
});

// review-116 round 2: refused settings are refused before anything is written, so a removed project whose
// name was asked for keeps its record and its sessions.
test("refused settings on a rename to a removed project's name touch nothing of that removed project", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-rename-removed-')));
  const at = (d: string) => path.join(root, 'missing', d);
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects: ['web', 'gone'].map((name) => ({ name, runner: 'local', path: at(name) })) }), store, () => {}));
  const old = await manager.start('gone');
  store.updateSession(old.id, { status: 'ended' });
  await manager.removeProject('gone');
  const removedRows = () => store.database.prepare(`SELECT count(*) AS n FROM projects WHERE name = 'gone' AND removed_at IS NOT NULL`).get() as { n: number };

  assert.throws(() => manager.renameProject('web', 'gone', { name: 'gone', runner: 'local', path: at('web'), account: 'nobody' } as never), /no account named "nobody"/);
  assert.deepEqual(manager.projects().map((p) => p.name), ['web']);
  assert.equal(store.getSession(old.id)!.project, 'gone', "the removed project's session stays its own");
  assert.equal(removedRows().n, 1, "the removed project's record is kept");
});

test('no manager tool renames a project', () => {
  const tools = ledungToolServer({
    userName: 'Simon', role: 'manager', asksWhom: 'Simon', ask: () => { throw new Error('not called'); }, withdraw: () => '',
    manager: new Proxy({}, { get: () => () => '' }) as ManagerHandlers,
  }).instance as unknown as { _registeredTools: Record<string, unknown> };
  const names = Object.keys(tools._registeredTools);
  assert.ok(names.includes('add_project'), 'the project tools are there');
  assert.deepEqual(names.filter((n) => /rename/.test(n)), []);
});

test("this browser's Waiting for you filter follows the new name", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  writeFilter(storage, { mode: 'all', one: 'web', hidden: ['web', 'api'] });
  renameInFilter(storage, 'web', 'Project Web');
  assert.deepEqual(readFilter(storage), { mode: 'all', one: 'Project Web', hidden: ['Project Web', 'api'] });
  // A filter that doesn't name the project is left as it is, and nothing is written when there was none.
  renameInFilter(storage, 'other', 'Other');
  assert.deepEqual(readFilter(storage), { mode: 'all', one: 'Project Web', hidden: ['Project Web', 'api'] });
  const empty = new Map<string, string>();
  renameInFilter({ getItem: (k) => empty.get(k) ?? null, setItem: (k, v) => void empty.set(k, v) }, 'web', 'x');
  assert.equal(empty.size, 0);
});
