// The page and API must refuse anyone but Simon's own browser (issue #4).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { parseConfig } from '../src/config.ts';
import { LedungServer } from '../src/server/server.ts';
import { securityHeaders } from '../src/server/security.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { FakeBackend, FakeBoard } from '../src/board/fake.ts';
import type { RepoDirectory } from '../src/board/repos.ts';
import { BoardError } from '../src/board/types.ts';
import { Updater } from '../src/update/updater.ts';
import { CHATS } from '../src/shared/protocol.ts';
import { FakePasskey } from './fake-passkey.ts';
import { RelayAdmin } from '../src/remote/admin.ts';
import { RemoteLink } from '../src/remote/link.ts';
import { iconFiles, Shortcuts } from '../src/platform/shortcuts.ts';
import { appDir } from '../src/platform/paths.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';

// A port the system says is free right now; a random pick could hit a running Ledung's port.
const PORT = await freePort();
const TOKEN = 'a'.repeat(64);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const COOKIE = `ledung_auth=${TOKEN}`;
// The name a relay delivers requests for (issue #160, docs/steps/relay.md step 3); the cases above use 127.0.0.1.
const PUBLIC = 'ledung.example.test';
const PUBLIC_ORIGIN = `https://${PUBLIC}`;
// Moves the server's clock for pairing codes, passkey challenges and unlocks (the 30-minute unlock).
let clockShift = 0;
let server: LedungServer;
let webRoot: string;
let projectRoot: string;
// The board cache (board attachments) and the manager, for the board attachment route.
let boardCache: string;
let sessions: SessionManager;
const questionAbout: Record<string, number> = {};
let managerQuestion = 0;
let paneStore: Store;
/** The folders Settings' Open folder was asked to show (issue #414); nothing is opened for real. */
const openedFolders: string[] = [];
let relayDir: string;
// Settings → Shortcuts (issue #415): made in a folder inside .test/, never on the real Desktop or Applications.
let shortcutDir: string;
let shortcuts: Shortcuts;
// A repo directory that records what the page asks it to create (the picker's one GitHub write).
const created: string[] = [];
const directory: RepoDirectory = {
  choices: async () => ({ repos: [{ repo: 'me/a', private: true }, { repo: 'org/board', private: false }], truncated: false, fetchedAt: 0 }),
  owners: async () => [{ login: 'me', kind: 'user' }, { login: 'acme', kind: 'org' }],
  create: async (owner, name) => {
    if (name === 'taken') throw new BoardError('access', `${owner}/taken already exists.`);
    created.push(`${owner}/${name}`);
    return { repo: `${owner}/${name}`, private: true };
  },
};

before(async () => {
  webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-web-'));
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
  const store = new Store(openDatabase(':memory:'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-proj-'));
  fs.writeFileSync(path.join(projectRoot, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  fs.writeFileSync(path.join(projectRoot, 'a.svg'), '<svg/>');
  fs.writeFileSync(path.join(path.dirname(projectRoot), 'ledung-secret.png'), 'x');
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port: PORT, projects: [{ name: 'p', runner: 'local', path: projectRoot }], board: { repo: 'org/board' }, browseRoots: [os.homedir(), os.tmpdir()] }) /* the temp folder is outside the home on macOS and Linux (#233) */, store, () => {}));
  boardCache = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-board-cache-'));
  manager.attachBoards(() => new FakeBackend(new FakeBoard(), 'me'), directory, boardCache);
  sessions = manager;
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default', role: 'session' });
  // A sensitive request and an ordinary one, no longer live, and a question about each (#104): a request
  // that gets past the page check then fails in the manager, with nothing started or decided.
  for (const [id, sensitive] of [['perm-sensitive', 'command matches /deploy/'], ['perm-plain', null]] as const) {
    store.createPermission({ id, sessionId: 's1', toolName: 'Bash', input: { command: 'x' }, title: null, reason: null, sensitive });
    const q = store.createQuestion({ sessionId: 's1', question: 'allow?', options: null, addressedTo: 'user', aboutRequest: id });
    store.withdrawQuestion(q.id, 'test');
    questionAbout[id] = q.id;
  }
  // A manager and a question it asked, no longer open (#104 review, finding F1).
  store.createSession({ id: 'm1', project: 'p', runner: 'local', title: 'lead', parentId: null, permissionMode: 'default', role: 'manager' });
  const mq = store.createQuestion({ sessionId: 'm1', question: 'merge #1?', options: null, addressedTo: 'user' });
  store.withdrawQuestion(mq.id, 'test');
  managerQuestion = mq.id;
  // A session with its own folder inside the project (start_session's cwd, decision of 2026-10-14).
  fs.mkdirSync(path.join(projectRoot, 'wt'));
  fs.writeFileSync(path.join(projectRoot, 'wt', 'b.png'), fs.readFileSync(path.join(projectRoot, 'a.png')));
  fs.writeFileSync(path.join(projectRoot, 'wt', 'notes.md'), '# in wt');
  store.createSession({ id: 's2', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default', role: 'session', workDir: path.join(projectRoot, 'wt') });
  // A worker under m1 that moved itself into a worktree with EnterWorktree, as workers do (the Files pane, issue #225).
  const fixX = path.join(projectRoot, '.claude', 'worktrees', 'fix-x');
  fs.mkdirSync(path.join(fixX, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixX, 'src', 'mine.ts'), 'export const mine = 1;\n');
  store.createSession({ id: 'w1', project: 'p', runner: 'local', title: 'fix-x', parentId: 'm1', permissionMode: 'default', role: 'session' });
  store.addMessage('w1', 'sdk', { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_w1', name: 'EnterWorktree', input: { name: 'fix-x' } }] } });
  store.addMessage('w1', 'sdk', { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_w1', content: `Created worktree at ${fixX} on branch worktree-fix-x.` }] } });
  paneStore = store;
  // An updater for a Ledung that is not a release: a request that gets past the guard is refused, and nothing runs (#100).
  const updater = new Updater({ appDir: projectRoot, dataDir: projectRoot, configPath: path.join(projectRoot, 'config.json'), onRestart: () => { throw new Error('must not restart'); } });
  // Settings → Relay and Join (issue #237), with their files in a temp folder; nothing may reach a relay or Cloudflare.
  relayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-relay-admin-'));
  const offline = (async (url: string | URL | Request) => { throw new Error(`must not reach ${String(url)}`); }) as typeof fetch;
  const relayAdmin = new RelayAdmin({ dir: relayDir, onComputers: () => {}, fetch: offline, log: () => {} });
  fs.mkdirSync(path.join(appDir(), '.test'), { recursive: true });
  shortcutDir = fs.mkdtempSync(path.join(appDir(), '.test', 'shortcuts-security-'));
  shortcuts = new Shortcuts({
    launch: { node: process.execPath, script: path.join(shortcutDir, 'launcher.mjs') }, iconDir: shortcutDir, icons: iconFiles(appDir()), platform: 'darwin',
    meta: { get: (k) => store.getMeta(k), set: (k, v) => store.setMeta(k, v) }, folders: async () => ({ applications: path.join(shortcutDir, 'Applications') }),
  });
  server = new LedungServer({ port: PORT, token: TOKEN, store, manager, webRoot, updater, publicName: PUBLIC, relayAdmin, shortcuts, now: () => Date.now() + clockShift, openFolder: (f) => openedFolders.push(f) });
  server.attachRemote(new RemoteLink({ server, dir: relayDir, configured: { relay: 'wss://relay.example.test', name: 'pc', publicName: PUBLIC, secret: 's', tls: 'optional' }, fetch: offline, log: () => {} }));
  await server.listen();
});

after(async () => {
  await server.close();
  removeTemp(webRoot);
  removeTemp(relayDir);
  removeTemp(shortcutDir);
  removeTemp(projectRoot);
  fs.rmSync(path.join(path.dirname(projectRoot), 'ledung-secret.png'), { force: true });
});

function request(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method: opts.method ?? 'GET', path: opts.path, headers: { host: `127.0.0.1:${PORT}`, ...opts.headers } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** Project p as Ledung has it now. Its sensitive lists go with every settings change, as the page sends them: one left
 * out empties them, which needs the open page (issue #107). */
const projectP = async () => (JSON.parse((await request({ path: '/api/projects', headers: { cookie: COOKIE } })).body) as Record<string, unknown>[]).find((p) => p.name === 'p')!;
const pSensitive = async () => ({ sensitive: (await projectP()).sensitive });

test('refuses requests that name another host (DNS rebinding)', async () => {
  const res = await request({ path: '/api/state', headers: { host: 'evil.example:80', cookie: COOKIE } });
  assert.equal(res.status, 403);
});

test('refuses the API without the sign-in cookie', async () => {
  assert.equal((await request({ path: '/api/state' })).status, 401);
  assert.equal((await request({ path: '/api/state', headers: { cookie: 'ledung_auth=' + 'b'.repeat(64) } })).status, 401);
});

test('the page itself needs sign-in', async () => {
  assert.equal((await request({ path: '/' })).status, 401);
  assert.equal((await request({ path: '/', headers: { cookie: COOKIE } })).status, 200);
});

test('a wrong sign-in link sets no cookie; the right one does', async () => {
  const wrong = await request({ path: '/login?token=' + 'b'.repeat(64) });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.headers['set-cookie'], undefined);
  const right = await request({ path: `/login?token=${TOKEN}` });
  assert.equal(right.status, 302);
  assert.match(String(right.headers['set-cookie']), /ledung_auth=a{64}; HttpOnly; SameSite=Strict/);
});

test('reads work with the cookie', async () => {
  const res = await request({ path: '/api/state', headers: { cookie: COOKIE } });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).type, 'hello');
});

test('changes need Ledung\'s own origin, even with the cookie', async () => {
  const body = JSON.stringify({ behavior: 'allow' });
  const headers = { cookie: COOKIE, 'content-type': 'application/json' };
  assert.equal((await request({ method: 'POST', path: '/api/permissions/x', headers, body })).status, 403);
  assert.equal((await request({ method: 'POST', path: '/api/permissions/x', headers: { ...headers, origin: 'https://evil.example' }, body })).status, 403);
  // Right origin: passes the guard, then fails because the request does not exist.
  const ok = await request({ method: 'POST', path: '/api/permissions/x', headers: { ...headers, origin: ORIGIN }, body });
  assert.equal(ok.status, 400);
  assert.match(JSON.parse(ok.body).error, /No such permission request/);
});

test("archiving needs the sign-in and Ledung's own origin, like every change", async () => {
  for (const route of ['archive', 'unarchive']) {
    const p = `/api/sessions/x/${route}`;
    assert.equal((await request({ method: 'POST', path: p, body: '{}' })).status, 401);
    assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE }, body: '{}' })).status, 403);
    assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: 'https://evil.example' }, body: '{}' })).status, 403);
    const ok = await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: ORIGIN }, body: '{}' });
    assert.equal(ok.status, 400);
    assert.match(JSON.parse(ok.body).error, /No such session/);
  }
});

test("the sign-in banner's Check again needs the sign-in and Ledung's own origin, like every change (issue #333)", async () => {
  const p = '/api/signin-check';
  // Check again asks about the computer's own login: an answer of the test's own, never the real login (#347).
  sessions.checkSignInWith = async () => ({ state: 'in', method: 'claude.ai', detail: null, checkedAt: 0 });
  assert.equal((await request({ method: 'POST', path: p, body: '{}' })).status, 401);
  assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE }, body: '{}' })).status, 403);
  assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const ok = await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: ORIGIN }, body: '{}' });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).type, 'accounts');
});

test("project name colours need the sign-in and Ledung's own origin, like every change (issue #83)", async () => {
  const p = '/api/projects/p/colours';
  const body = JSON.stringify({ manager: 'teal', sessions: 'same' });
  assert.equal((await request({ method: 'POST', path: p, body })).status, 401);
  assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE }, body })).status, 403);
  assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: 'https://evil.example' }, body })).status, 403);
  // Only palette colours: a value that could carry CSS is refused.
  const bad = await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ manager: 'red;}body{display:none' }) });
  assert.equal(bad.status, 400);
  const ok = await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: ORIGIN, 'content-type': 'application/json' }, body });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body).colours, { manager: 'teal', sessions: 'same' });
});

test("the chats' name colour needs the sign-in and Ledung's own origin, like a project's (issue #222)", async () => {
  const p = '/api/chats-colour';
  const body = JSON.stringify({ colour: 'pink' });
  assert.equal((await request({ method: 'POST', path: p, body })).status, 401);
  assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE }, body })).status, 403);
  assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: 'https://evil.example' }, body })).status, 403);
  // Only palette colours: a value that could carry CSS is refused.
  const bad = await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ colour: 'red;}body{display:none' }) });
  assert.equal(bad.status, 400);
  const ok = await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: ORIGIN, 'content-type': 'application/json' }, body });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).colour, 'pink');
  assert.equal(JSON.parse((await request({ path: '/api/chats', headers: { cookie: COOKIE } })).body).colour, 'pink', "returned in the chats' settings");
  const none = await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ colour: null }) });
  assert.equal(JSON.parse(none.body).colour, null);
});

test("renaming a session needs the sign-in and Ledung's own origin, like every change (issue #223)", async () => {
  const p = '/api/sessions/s2/rename';
  const body = JSON.stringify({ title: 'Renamed' });
  assert.equal((await request({ method: 'POST', path: p, body })).status, 401);
  assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE }, body })).status, 403);
  assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: 'https://evil.example' }, body })).status, 403);
  const empty = await change(p, { title: ' ' });
  assert.equal(empty.status, 400);
  assert.match(errorOf(empty), /cannot be empty/);
  const ok = await change(p, { title: 'Renamed' });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).title, 'Renamed');
  assert.equal((await change(p, { title: 't' })).status, 200, 'its name put back for the other tests');
});

test("the sidebar order needs the sign-in and Ledung's own origin, like every change (issue #88)", async () => {
  for (const [p, body] of [['/api/projects-order', { names: ['p'] }], ['/api/sessions-order', { ids: ['s1'] }]] as const) {
    const json = JSON.stringify(body);
    assert.equal((await request({ method: 'POST', path: p, body: json })).status, 401);
    assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE }, body: json })).status, 403);
    assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: 'https://evil.example' }, body: json })).status, 403);
    const ok = await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: ORIGIN, 'content-type': 'application/json' }, body: json });
    assert.equal(ok.status, 200);
  }
  // Not a way to reach another project's sessions: an id that isn't one is refused.
  const bad = await request({ method: 'POST', path: '/api/sessions-order', headers: { cookie: COOKIE, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['../x'] }) });
  assert.equal(bad.status, 400);
});

test('responses forbid embedding in other pages', async () => {
  const res = await request({ path: '/api/state', headers: { cookie: COOKIE } });
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/);
});

test("pictures load only from this page, plus the board's picture host when a board is set up", async () => {
  assert.match(securityHeaders(4317)['Content-Security-Policy']!, /img-src 'self' data:(;|$)/);
  // This test server has boards attached, so a people list may show pictures from GitHub and nowhere else.
  const res = await request({ path: '/api/state', headers: { cookie: COOKIE } });
  assert.match(String(res.headers['content-security-policy']), /img-src 'self' data: https:\/\/avatars\.githubusercontent\.com;/);
});

test('project images need the sign-in and this host, and are served as PNG or JPEG only', async () => {
  const url = '/api/sessions/s1/image?path=a.png';
  assert.equal((await request({ path: url })).status, 401);
  assert.equal((await request({ path: url, headers: { host: 'evil.example:80', cookie: COOKIE } })).status, 403);
  const ok = await request({ path: url, headers: { cookie: COOKIE } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  for (const bad of ['a.svg', '../ledung-secret.png', encodeURIComponent('..\ledung-secret.png'), 'missing.png']) {
    const res = await request({ path: `/api/sessions/s1/image?path=${bad}`, headers: { cookie: COOKIE } });
    assert.equal(res.status, 400, bad);
    assert.match(res.headers['content-type'] ?? '', /json/);
  }
  assert.equal((await request({ path: '/api/sessions/nope/image?path=a.png', headers: { cookie: COOKIE } })).status, 400);
});

test("a session with its own folder reads files only from that folder, behind the same sign-in", async () => {
  assert.equal((await request({ path: '/api/sessions/s2/file?path=notes.md' })).status, 401);
  const ok = await request({ path: '/api/sessions/s2/file?path=notes.md', headers: { cookie: COOKIE } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).content, '# in wt');
  assert.equal((await request({ path: '/api/sessions/s2/image?path=b.png', headers: { cookie: COOKIE } })).status, 200);
  // The project folder around it is outside the session's folder.
  for (const bad of ['../a.png', encodeURIComponent(path.join(projectRoot, 'a.png'))]) {
    assert.equal((await request({ path: `/api/sessions/s2/image?path=${bad}`, headers: { cookie: COOKIE } })).status, 400, bad);
  }
});

test("a project's extra folders change only through its settings: sign-in and Ledung's own origin, like every change", async () => {
  const folder = path.dirname(projectRoot);
  const sensitive = await pSensitive();
  const body = JSON.stringify({ name: 'p', runner: 'local', path: projectRoot, extraFolders: [folder], ...sensitive });
  const headers = { 'content-type': 'application/json' };
  assert.equal((await request({ method: 'POST', path: '/api/projects/p', headers, body })).status, 401);
  assert.equal((await request({ method: 'POST', path: '/api/projects/p', headers: { ...headers, cookie: COOKIE }, body })).status, 403);
  assert.equal((await request({ method: 'POST', path: '/api/projects/p', headers: { ...headers, cookie: COOKIE, origin: 'http://evil.example' }, body })).status, 403);
  const ok = await request({ method: 'POST', path: '/api/projects/p', headers: { ...headers, cookie: COOKIE, origin: ORIGIN }, body });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body).extraFolders, [folder]);
  const relative = await request({ method: 'POST', path: '/api/projects/p', headers: { ...headers, cookie: COOKIE, origin: ORIGIN }, body: JSON.stringify({ name: 'p', runner: 'local', path: projectRoot, extraFolders: ['wt'], ...sensitive }) });
  assert.equal(relative.status, 400);
  const back = await request({ method: 'POST', path: '/api/projects/p', headers: { ...headers, cookie: COOKIE, origin: ORIGIN }, body: JSON.stringify({ name: 'p', runner: 'local', path: projectRoot, ...sensitive }) });
  assert.deepEqual(JSON.parse(back.body).extraFolders, []);
});

function connect(headers: Record<string, string>): Promise<'open' | 'refused'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers });
    ws.on('message', () => {
      ws.close();
      resolve('open');
    });
    ws.on('error', () => resolve('refused'));
    ws.on('unexpected-response', () => resolve('refused'));
  });
}

test('the live connection needs both the cookie and Ledung\'s own origin', async () => {
  assert.equal(await connect({ origin: ORIGIN }), 'refused');
  assert.equal(await connect({ cookie: COOKIE, origin: 'https://evil.example' }), 'refused');
  assert.equal(await connect({ cookie: COOKIE }), 'refused');
  assert.equal(await connect({ cookie: COOKIE, origin: ORIGIN }), 'open');
});

test('restarting is refused when Ledung was not started by the launcher', async () => {
  const res = await request({
    method: 'POST', path: '/api/restart', body: '{}',
    headers: { cookie: COOKIE, origin: ORIGIN, 'content-type': 'application/json' },
  });
  assert.equal(res.status, 404);
  const hello = JSON.parse((await request({ path: '/api/state', headers: { cookie: COOKIE } })).body);
  assert.equal(hello.canRestart, false);
});

test("checking and updating need the sign-in and Ledung's own origin, like every change (#100)", async () => {
  assert.equal((await request({ path: '/api/update' })).status, 401);
  const status = await request({ path: '/api/update', headers: { cookie: COOKIE } });
  assert.equal(status.status, 200);
  assert.equal(JSON.parse(status.body).available, false);
  for (const route of ['update-check', 'update']) {
    const p = `/api/${route}`;
    assert.equal((await request({ method: 'POST', path: p, body: '{}' })).status, 401);
    assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE }, body: '{}' })).status, 403);
    assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: 'https://evil.example' }, body: '{}' })).status, 403);
    // Right origin: passes the guard, then this Ledung (not a release) has nothing to update.
    const ok = await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: ORIGIN }, body: '{}' });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).available, false);
    assert.equal(JSON.parse(ok.body).steps.length, 0, 'no step ran');
  }
});

test('names on the local network are accepted only when Ledung is opened to it', async () => {
  const { Guard } = await import('../src/server/security.ts');
  const req = (host: string, origin?: string) => ({ headers: { host, origin } }) as any;
  const closed = new Guard(TOKEN, 4317);
  assert.equal(closed.hostAllowed(req('192.168.1.20:4317')), false);
  const open = new Guard(TOKEN, 4317, ['192.168.1.20', 'Desktop-PC']);
  assert.equal(open.hostAllowed(req('192.168.1.20:4317')), true);
  assert.equal(open.hostAllowed(req('desktop-pc:4317')), true);
  assert.equal(open.originAllowed(req('192.168.1.20:4317', 'http://192.168.1.20:4317')), true);
  assert.equal(open.hostAllowed(req('192.168.1.99:4317')), false);
  assert.equal(open.originAllowed(req('192.168.1.20:4317', 'http://evil.example')), false);
});

test('without LAN sign-in, only the network names skip sign-in; this computer still needs it', async () => {
  const { Guard } = await import('../src/server/security.ts');
  const req = (host: string, cookie?: string) => ({ headers: { host, cookie } }) as any;
  const open = new Guard(TOKEN, 4317, ['192.168.1.20'], true);
  assert.equal(open.mayUse(req('192.168.1.20:4317')), true);
  assert.equal(open.mayUse(req('127.0.0.1:4317')), false);
  assert.equal(open.mayUse(req('127.0.0.1:4317', COOKIE)), true);
  const closed = new Guard(TOKEN, 4317, ['192.168.1.20'], false);
  assert.equal(closed.mayUse(req('192.168.1.20:4317')), false);
});

test("the board's routes need the sign-in, and changes Ledung's own origin (message board, per project)", async () => {
  const people = '/api/board-projects/p/people';
  assert.equal((await request({ path: '/api/board' })).status, 401);
  assert.equal((await request({ path: people })).status, 401);
  assert.equal((await request({ path: '/api/board', headers: { host: 'evil.example:80', cookie: COOKIE } })).status, 403);
  assert.equal((await request({ path: people, headers: { host: 'evil.example:80', cookie: COOKIE } })).status, 403);
  const status = await request({ path: '/api/board', headers: { cookie: COOKIE } });
  assert.equal(status.status, 200);
  assert.equal(JSON.parse(status.body).configured, false, 'no project names a repo yet');
  assert.match(JSON.parse((await request({ path: people, headers: { cookie: COOKIE } })).body).error, /names no board repo yet/);

  const json = { 'content-type': 'application/json' };
  const p = '/api/board-projects/p';
  const b = JSON.stringify({ enabled: true, repo: 'org/board', allow: ['alice'], channels: ['#ops'], frontDesk: true });
  assert.equal((await request({ method: 'POST', path: p, headers: json, body: b })).status, 401);
  assert.equal((await request({ method: 'POST', path: p, headers: { ...json, cookie: COOKIE }, body: b })).status, 403);
  assert.equal((await request({ method: 'POST', path: p, headers: { ...json, cookie: COOKIE, origin: 'https://evil.example' }, body: b })).status, 403);
  assert.equal((await request({ method: 'POST', path: p, headers: { ...json, cookie: COOKIE, host: 'evil.example:80', origin: ORIGIN }, body: b })).status, 403);
  assert.equal((await request({ method: 'POST', path: p, headers: { ...json, cookie: COOKIE, origin: ORIGIN }, body: b })).status, 200);
  const after = JSON.parse((await request({ path: '/api/board', headers: { cookie: COOKIE } })).body);
  assert.deepEqual(after.projects.p, { enabled: true, repo: 'org/board', allow: ['alice'], channels: ['#ops'], ignored: [] });
  assert.deepEqual(after.boards.map((x: { repo: string; frontDesk: string }) => [x.repo, x.frontDesk]), [['org/board', 'p']]);
  assert.equal(JSON.parse((await request({ path: people, headers: { cookie: COOKIE } })).body).source, 'none');

  // Bad input is refused with the reason; the old app-wide routes are gone.
  const bad = async (path: string, body: unknown) => request({ method: 'POST', path, headers: { ...json, cookie: COOKIE, origin: ORIGIN }, body: JSON.stringify(body) });
  const good = { enabled: true, repo: 'org/board', allow: ['alice'], channels: [], frontDesk: false };
  assert.match(JSON.parse((await bad(p, { ...good, allow: ['not a login'] })).body).error, /is not a login/);
  assert.match(JSON.parse((await bad(p, { ...good, repo: 'no slash' })).body).error, /is not a repo/);
  assert.equal((await bad(p, { ...good, allow: 'alice' })).status, 400);
  assert.equal((await bad(p, { enabled: true })).status, 400);
  assert.match(JSON.parse((await bad('/api/board-projects/nope', good)).body).error, /no project named "nope"/);
  assert.equal((await bad('/api/board/allow', { logins: ['alice'] })).status, 404);
  assert.equal((await bad('/api/board/front-desk', { project: 'p' })).status, 404);
  assert.equal((await request({ path: '/api/board/people', headers: { cookie: COOKIE } })).status, 404);
});

test('the repo picker routes need the sign-in; creating a repo is a POST from the page with an explicit confirm', async () => {
  const list = '/api/board-projects/p/repos';
  const create = '/api/board-repos';
  const json = { 'content-type': 'application/json' };
  const body = JSON.stringify({ owner: 'me', name: 'p-board', confirm: true });
  // Reading: signed in, Ledung's own host.
  for (const path of [list, '/api/board-owners']) {
    assert.equal((await request({ path })).status, 401, path);
    assert.equal((await request({ path, headers: { host: 'evil.example:80', cookie: COOKIE } })).status, 403, path);
  }
  const choices = JSON.parse((await request({ path: list, headers: { cookie: COOKIE } })).body);
  assert.deepEqual(choices.repos.map((r: { repo: string }) => r.repo), ['me/a', 'org/board']);
  assert.equal(choices.error, null);
  assert.deepEqual(JSON.parse((await request({ path: '/api/board-owners', headers: { cookie: COOKIE } })).body).owners.map((o: { login: string }) => o.login), ['me', 'acme']);
  // Creating: no sign-in, a foreign origin or host, the wrong method, or no confirm creates nothing.
  assert.equal((await request({ method: 'POST', path: create, headers: json, body })).status, 401);
  assert.equal((await request({ method: 'POST', path: create, headers: { ...json, cookie: COOKIE }, body })).status, 403);
  assert.equal((await request({ method: 'POST', path: create, headers: { ...json, cookie: COOKIE, origin: 'https://evil.example' }, body })).status, 403);
  assert.equal((await request({ method: 'POST', path: create, headers: { ...json, cookie: COOKIE, host: 'evil.example:80', origin: ORIGIN }, body })).status, 403);
  assert.equal((await request({ path: create, headers: { cookie: COOKIE } })).status, 404, 'a GET creates nothing');
  const post = (b: unknown) => request({ method: 'POST', path: create, headers: { ...json, cookie: COOKIE, origin: ORIGIN }, body: JSON.stringify(b) });
  assert.equal((await post({ owner: 'me', name: 'p-board' })).status, 400, 'no confirm');
  assert.equal((await post({ owner: 'me', name: 'p-board', confirm: 'yes' })).status, 400, 'confirm must be true');
  assert.equal((await post({ owner: 5, name: 'x', confirm: true })).status, 400);
  assert.deepEqual(created, []);
  const made = await post({ owner: 'me', name: 'p-board', confirm: true });
  assert.equal(made.status, 200);
  assert.deepEqual(JSON.parse(made.body), { repo: 'me/p-board', private: true });
  assert.deepEqual(created, ['me/p-board']);
  const taken = await post({ owner: 'me', name: 'taken', confirm: true });
  assert.equal(taken.status, 400);
  assert.match(JSON.parse(taken.body).error, /already exists/);
  // The picker lists boards other projects use, not the asking project's own.
  assert.deepEqual(JSON.parse((await request({ path: list, headers: { cookie: COOKIE } })).body).used, []);
});

test("the Board view's routes are read-only and need the sign-in and Ledung's own host", async () => {
  const list = '/api/board-threads';
  const one = '/api/board-thread?repo=org%2Fboard&id=1';
  for (const path of [list, one]) {
    assert.equal((await request({ path })).status, 401, path);
    assert.equal((await request({ path, headers: { host: 'evil.example:80', cookie: COOKIE } })).status, 403, path);
  }
  // Project p names org/board (set here too, so the test stands alone); the board exists but holds no thread yet.
  const setup = JSON.stringify({ enabled: true, repo: 'org/board', allow: ['alice'], channels: [], frontDesk: false });
  assert.equal((await request({ method: 'POST', path: '/api/board-projects/p', headers: { 'content-type': 'application/json', cookie: COOKIE, origin: ORIGIN }, body: setup })).status, 200);
  const threads = await request({ path: list, headers: { cookie: COOKIE } });
  assert.equal(threads.status, 200);
  assert.deepEqual(JSON.parse(threads.body), { threads: [], truncated: false });
  const thread = JSON.parse((await request({ path: one, headers: { cookie: COOKIE } })).body);
  assert.equal(thread.missing, true);
  assert.deepEqual(thread.posts, []);
  // Bad or foreign input is refused with the reason.
  const get = async (path: string) => request({ path, headers: { cookie: COOKIE } });
  assert.equal((await get('/api/board-thread')).status, 400);
  assert.equal((await get('/api/board-thread?repo=org%2Fboard')).status, 400);
  const foreign = await get('/api/board-thread?repo=other%2Frepo&id=1');
  assert.equal(foreign.status, 400);
  assert.match(JSON.parse(foreign.body).error, /No project here uses the board/);
  // Nothing here changes anything: every other method is unknown, with or without the page's origin.
  const json = { 'content-type': 'application/json' };
  for (const path of [list, one]) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await request({ method, path, headers: { ...json, cookie: COOKIE, origin: ORIGIN }, body: method === 'DELETE' ? undefined : '{}' })).status, 404, `${method} ${path}`);
    }
  }
});

// Issue #104: the sign-in token is a file on this computer; a script that read it has the cookie and can
// send the Origin header. Deciding something sensitive also needs the key only the live page gets.
function livePage(): Promise<{ key: string; close(): void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: COOKIE, origin: ORIGIN } });
    ws.once('message', (data) => {
      const hello = JSON.parse(String(data));
      resolve({ key: hello.pageKey, close: () => ws.close() });
    });
    ws.on('error', reject);
  });
}

const change = (path: string, body: unknown, extra: Record<string, string> = {}) =>
  request({ method: 'POST', path, headers: { cookie: COOKIE, origin: ORIGIN, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
const errorOf = (res: { body: string }) => JSON.parse(res.body).error as string;

test('deciding a sensitive request needs the live page, not just the cookie', async () => {
  const allow = { behavior: 'allow' };
  const refused = await change('/api/permissions/perm-sensitive', allow);
  assert.equal(refused.status, 403);
  assert.match(errorOf(refused), /open page/);
  assert.equal((await change('/api/permissions/perm-sensitive', allow, { 'x-ledung-page': 'b'.repeat(64) })).status, 403, 'a made-up key');
  // An ordinary request needs only the cookie, as before: it gets past the check to the manager.
  const plain = await change('/api/permissions/perm-plain', allow);
  assert.equal(plain.status, 400);
  assert.match(errorOf(plain), /no longer waiting/);

  const page = await livePage();
  assert.match(page.key, /^[0-9a-f]{64}$/);
  const passed = await change('/api/permissions/perm-sensitive', allow, { 'x-ledung-page': page.key });
  assert.equal(passed.status, 400, 'with the key it reaches the manager');
  assert.match(errorOf(passed), /no longer waiting/);
  page.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await change('/api/permissions/perm-sensitive', allow, { 'x-ledung-page': page.key })).status, 403, 'the key dies with its connection');
});

test('answering a question about a sensitive request needs the live page', async () => {
  const answer = { answer: 'yes' };
  assert.equal((await change(`/api/questions/${questionAbout['perm-sensitive']}/answer`, answer)).status, 403);
  const plain = await change(`/api/questions/${questionAbout['perm-plain']}/answer`, answer);
  assert.equal(plain.status, 400);
  assert.match(errorOf(plain), /no longer open/);
  const page = await livePage();
  const passed = await change(`/api/questions/${questionAbout['perm-sensitive']}/answer`, answer, { 'x-ledung-page': page.key });
  page.close();
  assert.equal(passed.status, 400);
  assert.match(errorOf(passed), /no longer open/);
});

test('away mode, which lets sensitive merges through, needs the live page', async () => {
  assert.equal((await change('/api/away', { until: 'never' })).status, 403);
  const page = await livePage();
  const passed = await change('/api/away', { until: 'never' }, { 'x-ledung-page': page.key });
  page.close();
  assert.equal(passed.status, 400);
  assert.match(errorOf(passed), /HH:MM/);
});

test('setting or lifting a usage stop needs the live page, so a session cannot free itself (#278)', async () => {
  assert.equal((await change('/api/usage-stops', { account: 'default', kind: 'seven_day', percent: 500 })).status, 403);
  assert.equal((await change('/api/usage-lift', { account: 'default', kind: 'seven_day' })).status, 403);
  const page = await livePage();
  const set = await change('/api/usage-stops', { account: 'default', kind: 'seven_day', percent: 500 }, { 'x-ledung-page': page.key });
  const lift = await change('/api/usage-lift', { account: 'default', kind: 'seven_day' }, { 'x-ledung-page': page.key });
  page.close();
  assert.equal(set.status, 400);
  assert.match(errorOf(set), /1 to 100/);
  assert.equal(lift.status, 400);
  assert.match(errorOf(lift), /not holding/);
});

test('saving macros needs the live page, so a session cannot put words in the person\'s chips (#410)', async () => {
  const body = { macros: [{ id: 'm-1', name: 'Go', text: 'Go.', send: true, key: null, chip: false, project: null }] };
  assert.equal((await change('/api/macros', body)).status, 403);
  const page = await livePage();
  const passed = await change('/api/macros', body, { 'x-ledung-page': page.key });
  page.close();
  assert.equal(passed.status, 400);
  assert.match(errorOf(passed), /neither a chip nor a keybind/);
});

test('the page key is never in GET state, also while a page is open', async () => {
  const page = await livePage();
  try {
    assert.match(page.key, /^[0-9a-f]{64}$/, 'a live key exists that could leak');
    const res = await request({ path: '/api/state', headers: { cookie: COOKIE } });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).pageKey, undefined);
    assert.ok(!res.body.includes(page.key));
  } finally {
    page.close();
  }
});

// A manager's merge is allowed without a prompt when the user's own words name it (mergeOnAnswer): a typed
// message, a task or an answer to the manager's question. So every way those reach a manager needs the
// page too (#104 review, finding F1). Each case: refused without the key, past the check with it (the
// request then fails in the manager, so nothing starts or is sent).
function managerWords(): { name: string; path: string; body: unknown; then: RegExp }[] {
  return [
    { name: 'a message to a manager', path: '/api/sessions/m1/messages', body: { text: ' ' }, then: /empty/ },
    { name: "an answer to a manager's question", path: `/api/questions/${managerQuestion}/answer`, body: { answer: 'merge #1' }, then: /no longer open/ },
    { name: "a message to a project's manager", path: '/api/projects/p/manager', body: { text: ' ' }, then: /empty/ },
    { name: 'a new manager with a first message', path: '/api/sessions', body: { project: 'nope', role: 'manager', text: 'merge #1' }, then: /no project named/ },
    { name: "a new project's task", path: '/api/projects-new', body: { parent: projectRoot, github: false, task: 'merge #1', settings: { name: 'p' } }, then: /already a project/ },
  ];
}

test("words that reach a manager as the user's own need the live page", async () => {
  const cases = managerWords();
  for (const c of cases) {
    const refused = await change(c.path, c.body);
    assert.equal(refused.status, 403, c.name);
    assert.match(errorOf(refused), /open page/, c.name);
  }
  const page = await livePage();
  try {
    for (const c of cases) {
      const passed = await change(c.path, c.body, { 'x-ledung-page': page.key });
      assert.equal(passed.status, 400, c.name);
      assert.match(errorOf(passed), c.then, c.name);
    }
  } finally {
    page.close();
  }
});

// Issue #109: anyone may lock a project; turning it off or down, or letting the board in, is the user's
// alone, from the open page, like a sensitive call.
test('opening a locked project up needs the live page; locking it needs only the cookie', async () => {
  const sensitive = await pSensitive();
  const settings = (lockdown?: unknown) => ({ name: 'p', runner: 'local', path: projectRoot, ...sensitive, ...(lockdown ? { lockdown } : {}) });
  const locked = await change('/api/projects/p', settings({ level: 'A' }));
  assert.equal(locked.status, 200, 'locking: the cookie is enough');
  assert.equal(JSON.parse(locked.body).lockdown.level, 'A');
  try {
    for (const [name, body] of [['off', settings()], ['board let in', settings({ level: 'A', board: true })]] as const) {
      const refused = await change('/api/projects/p', body);
      assert.equal(refused.status, 403, name);
      assert.match(errorOf(refused), /open page/, name);
    }
    assert.equal((await change('/api/projects/p/remove', {})).status, 403, 'removing a locked project ends its lockdown too');
    assert.equal((await change('/api/projects/p', { ...settings({ level: 'A' }), model: 'haiku' })).status, 200, 'other changes as before');
  } finally {
    const page = await livePage();
    const opened = await change('/api/projects/p', settings(), { 'x-ledung-page': page.key });
    page.close();
    assert.equal(opened.status, 200);
    assert.equal(JSON.parse(opened.body).lockdown.level, 'off');
  }
});

test('words to an ordinary session still need only the cookie', async () => {
  const message = await change('/api/sessions/s1/messages', { text: ' ' });
  assert.equal(message.status, 400);
  assert.match(errorOf(message), /empty/);
  const start = await change('/api/sessions', { project: 'nope', role: 'session', text: 'hello' });
  assert.equal(start.status, 400);
  assert.match(errorOf(start), /no project named/);
});

// Issue #178: a reconnecting page asks only for what came after the last message it shows.
test('the message history pages forward from a message, with the cookie', async () => {
  const store = (sessions as unknown as { store: Store }).store;
  const [a, b] = ['before', 'missed'].map((text) => store.addMessage('s2', 'user', { text }));
  const after = (cookie?: string) => request({ path: `/api/sessions/s2/messages?limit=500&after=${a!.id}`, headers: cookie ? { cookie } : {} });
  assert.equal((await after()).status, 401);
  const res = await after(COOKIE);
  assert.equal(res.status, 200);
  assert.deepEqual((JSON.parse(res.body) as { id: number }[]).map((m) => m.id), [b!.id]);
});

// Issue #116: renaming a project is the user's alone, from the open page; the cookie alone is not enough.
test('renaming a project needs the live page', async () => {
  const names = async () => (JSON.parse((await request({ path: '/api/projects', headers: { cookie: COOKIE } })).body) as { name: string }[]).map((p) => p.name);
  const refused = await change('/api/projects/p/rename', { name: 'renamed' });
  assert.equal(refused.status, 403);
  assert.match(errorOf(refused), /open page/);
  assert.deepEqual(await names(), ['p'], 'nothing changed');
  const page = await livePage();
  try {
    const invalid = await change('/api/projects/p/rename', { name: '../evil' }, { 'x-ledung-page': page.key });
    assert.equal(invalid.status, 400, 'with the key it reaches the manager, which refuses a bad name');
    assert.match(errorOf(invalid), /letters, digits/);
    assert.deepEqual(await names(), ['p']);
  } finally {
    page.close();
  }
});

// Issue #107: the project settings that loosen the sensitive gate are the user's alone, from the open page, like a
// sensitive decision (#104); every other change, and every tightening, still works with the cookie (its Done bullet).
const plainSettings = (extra: Record<string, unknown> = {}) => ({ name: 'p', runner: 'local', path: projectRoot, sensitive: { commandPatterns: ['deploy'], pathPatterns: ['secrets/'], mcpTools: ['mcp__prod__run'] }, ...extra });
const gateLoosening = (): [string, string, Record<string, unknown>][] => [
  ['a command pattern removed', '/api/projects/p', plainSettings({ sensitive: { commandPatterns: [], pathPatterns: ['secrets/'], mcpTools: ['mcp__prod__run'] } })],
  ['a path pattern removed', '/api/projects/p', plainSettings({ sensitive: { commandPatterns: ['deploy'], pathPatterns: [], mcpTools: ['mcp__prod__run'] } })],
  ['an MCP tool removed', '/api/projects/p', plainSettings({ sensitive: { commandPatterns: ['deploy'], pathPatterns: ['secrets/'], mcpTools: [] } })],
  ['the sensitive lists left out', '/api/projects/p', { name: 'p', runner: 'local', path: projectRoot }],
  ["a manager's grant", '/api/projects/p', plainSettings({ managerGrant: 'may merge anything' })],
  ['project tools unasked', '/api/projects/p', plainSettings({ projectToolsUnasked: true })],
  // Issue #306: a manager that may change projects' settings.
  ["projects' settings tools", '/api/projects/p', plainSettings({ projectSettingsTools: true })],
  ["a new project's settings tools", '/api/projects', { name: 'q', runner: 'local', path: path.join(projectRoot, 'nope'), projectSettingsTools: true }],
  ['a dev ship command', '/api/projects/p', plainSettings({ devShipCommand: '.*' })],
  ["a new project's grant", '/api/projects', { name: 'q', runner: 'local', path: path.join(projectRoot, 'nope'), managerGrant: 'may merge anything' }],
  ["a new project's unasked tools", '/api/projects', { name: 'q', runner: 'local', path: path.join(projectRoot, 'nope'), projectToolsUnasked: true }],
  ["a created project's dev ship command", '/api/projects-new', { parent: projectRoot, github: false, settings: { name: 'p', devShipCommand: '.*' } }],
];
/** Past the check: saved, or refused by the manager afterwards (no such folder, the name taken), so nothing new is made. */
const pastCheck = (name: string, res: { status: number; body: string }) => {
  assert.ok(res.status === 200 || res.status === 400, `${name}: ${res.body}`);
  if (res.status === 400) assert.match(errorOf(res), /doesn't exist|already a project/, name);
};
/** Sets project p's settings from the open page, whatever they loosen. */
const setP = async (body: unknown) => {
  const page = await livePage();
  try {
    const res = await change('/api/projects/p', body, { 'x-ledung-page': page.key });
    assert.equal(res.status, 200, res.body);
  } finally {
    page.close();
  }
};
/** p as the other tests have it (its sensitive lists are Ledung's suggestions), to put back afterwards. */
const bareP = async () => ({ name: 'p', runner: 'local', path: projectRoot, sensitive: (await projectP()).sensitive });

test('project settings that loosen the sensitive gate need the live page; other changes need only the cookie (issue #107)', async () => {
  const bare = await bareP();
  await setP(plainSettings());
  try {
    const before = JSON.stringify(await projectP());
    for (const [name, p, body] of gateLoosening()) {
      const refused = await change(p, body);
      assert.equal(refused.status, 403, `${name}: ${refused.body}`);
      assert.match(errorOf(refused), /open page/, name);
    }
    assert.equal(JSON.stringify(await projectP()), before, 'nothing changed');
    // Other settings and more patterns (tightening): the cookie, as before.
    assert.equal((await change('/api/projects/p', plainSettings({ model: 'haiku' }))).status, 200, 'a model');
    const added = plainSettings({ sensitive: { commandPatterns: ['deploy', 'kubectl'], pathPatterns: ['secrets/'], mcpTools: ['mcp__prod__run'] } });
    assert.equal((await change('/api/projects/p', added)).status, 200, 'a pattern added');
    const plainNew = await change('/api/projects', { name: 'q', runner: 'local', path: path.join(projectRoot, 'nope') });
    assert.equal(plainNew.status, 400, 'a plain new project gets past the check');
    assert.match(errorOf(plainNew), /doesn't exist/);

    const page = await livePage();
    try {
      for (const [name, p, body] of gateLoosening()) {
        pastCheck(name, await change(p, body, { 'x-ledung-page': page.key }));
        if (p === '/api/projects/p') assert.equal((await change(p, plainSettings())).status, 200, `${name} taken back with the cookie`);
      }
      const granted = await change('/api/projects/p', plainSettings({ managerGrant: 'may merge anything', projectToolsUnasked: true }), { 'x-ledung-page': page.key });
      assert.equal(granted.status, 200);
      assert.equal(JSON.parse(granted.body).managerGrant, 'may merge anything', 'saved with the key');
      // Keeping what it has is no loosening.
      assert.equal((await change('/api/projects/p', plainSettings({ managerGrant: 'may merge anything', projectToolsUnasked: true, model: 'haiku' }))).status, 200, 'the same grant');
    } finally {
      page.close();
    }
  } finally {
    await setP(bare);
  }
});

test("board attachment images need the sign-in and this host, come only from a used board's cache, and can't leave it", async () => {
  sessions.boards!.setProjectSetting('p', { enabled: true, repo: 'org/board', allow: ['alice'], channels: [], frontDesk: false });
  const dir = path.join(boardCache, 'org', 'board', '7');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'aaaaaaaaaaaa-shot.png'), fs.readFileSync(path.join(projectRoot, 'a.png')));
  fs.writeFileSync(path.join(dir, 'bbbbbbbbbbbb-x.svg'), '<svg/>');
  fs.writeFileSync(path.join(boardCache, 'org', 'secret.png'), fs.readFileSync(path.join(projectRoot, 'a.png')));
  fs.mkdirSync(path.join(boardCache, 'other', 'repo', '1'), { recursive: true });
  fs.writeFileSync(path.join(boardCache, 'other', 'repo', '1', 'cccccccccccc-y.png'), fs.readFileSync(path.join(projectRoot, 'a.png')));
  const url = (file: string) => `/api/board-attachment?file=${encodeURIComponent(file)}`;
  const good = url('board:org/board/7/aaaaaaaaaaaa-shot.png');
  assert.equal((await request({ path: good })).status, 401);
  assert.equal((await request({ path: good, headers: { host: 'evil.example:80', cookie: COOKIE } })).status, 403);
  const ok = await request({ path: good, headers: { cookie: COOKIE } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  for (const bad of [
    'board:org/board/7/bbbbbbbbbbbb-x.svg', 'board:org/board/../secret.png', 'board:org/board/7/../../secret.png', 'board:org/board/7%2F..%2F..%2Fsecret.png',
    'board:../../x/7/a.png', 'board:other/repo/1/cccccccccccc-y.png', 'org/board/7/aaaaaaaaaaaa-shot.png', `board:org/board/${path.join(projectRoot, 'a.png')}`, '',
  ]) {
    const res = await request({ path: url(bad), headers: { cookie: COOKIE } });
    assert.equal(res.status, 400, bad);
    assert.match(res.headers['content-type'] ?? '', /json/);
  }
  // Read-only: no other method.
  const post = await request({ method: 'POST', path: good, headers: { cookie: COOKIE, origin: ORIGIN } });
  assert.notEqual(post.status, 200);
});

test("ask_user screenshots take a board attachment from a manager's own project's board, and from nobody else", () => {
  // The same wiring ask_user uses (Management's shotPath); 's1' is a worker session of project p, 'm1' its manager.
  const shot = (id: string, file: string) => (sessions as unknown as { management: { screenshots(id: string, s: { file: string; look_for: string }[], q: null): { path: string }[] } })
    .management.screenshots(id, [{ file, look_for: 'x' }], null);
  assert.equal(shot('m1', 'board:org/board/7/aaaaaaaaaaaa-shot.png')[0]!.path, 'board:org/board/7/aaaaaaaaaaaa-shot.png');
  assert.throws(() => shot('s1', 'board:org/board/7/aaaaaaaaaaaa-shot.png'), /Only a manager/);
  assert.throws(() => shot('m1', 'board:other/repo/1/cccccccccccc-y.png'), /No project here uses the board "other\/repo"/);
  assert.throws(() => shot('m1', 'board:org/board/7/../../secret.png'), /inside the project/);
});

test("a review's text files need the sign-in and this host, and come only as the review names them, checked again (docs/steps/pr-review.md)", async () => {
  const store = (sessions as unknown as { store: Store }).store;
  fs.writeFileSync(path.join(projectRoot, 'run.log'), 'step 1 ok\nstep 2 ok\n');
  fs.writeFileSync(path.join(projectRoot, 'later.log'), 'text for now');
  fs.writeFileSync(path.join(boardCache, 'org', 'board', '7', 'dddddddddddd-2.txt'), 'from the board');
  // Stored as asked, plus entries no check would have let in, as if the database were changed behind Ledung's back.
  const q = store.createQuestion({
    sessionId: 'm1', question: 'review', options: null, addressedTo: 'user',
    details: {
      title: 'T', tier: 'Process',
      review: {
        solving: 's', done: 'd', evidence: [
          { file: 'a.png', caption: 'image', kind: 'image' },
          { file: 'run.log', caption: 'log', kind: 'text' },
          { file: 'board:org/board/7/dddddddddddd-2.txt', caption: 'board log', kind: 'text' },
          { file: '../ledung-secret.png', caption: 'outside', kind: 'text' },
          { file: 'a.svg', caption: 'not a text kind', kind: 'text' },
          { file: 'later.log', caption: 'changed after asking', kind: 'text' },
          { file: 'board:org/board/7/../../secret.png', caption: 'outside the repo', kind: 'text' },
        ],
      },
    },
  });
  const url = (n: string | number) => `/api/questions/${q.id}/evidence/${n}`;
  assert.equal((await request({ path: url(1) })).status, 401);
  assert.equal((await request({ path: url(1), headers: { host: 'evil.example:80', cookie: COOKIE } })).status, 403);
  const ok = await request({ path: url(1), headers: { cookie: COOKIE } });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { file: 'run.log', content: 'step 1 ok\nstep 2 ok\n' });
  assert.equal(JSON.parse((await request({ path: url(2), headers: { cookie: COOKIE } })).body).content, 'from the board');
  fs.writeFileSync(path.join(projectRoot, 'later.log'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  for (const bad of [0, 3, 4, 5, 6, 7, 99, -1, 'x', '1.5']) {
    const res = await request({ path: url(bad), headers: { cookie: COOKIE } });
    assert.equal(res.status, 400, String(bad));
    assert.match(res.headers['content-type'] ?? '', /json/);
  }
  // Only a review's files: an ordinary question has none.
  assert.equal((await request({ path: `/api/questions/${managerQuestion}/evidence/0`, headers: { cookie: COOKIE } })).status, 400);
  // Read-only: no other method.
  assert.notEqual((await request({ method: 'POST', path: url(1), headers: { cookie: COOKIE, origin: ORIGIN } })).status, 200);
});

test("a review's evidence takes a board attachment from a manager's own project's board, text too, and from nobody else", () => {
  const ev = (id: string, file: string) => (sessions as unknown as { management: { reviewEvidence(id: string, e: { file: string; caption: string }[]): { file: string; kind?: string }[] } })
    .management.reviewEvidence(id, [{ file, caption: 'x' }]);
  assert.deepEqual(ev('m1', 'board:org/board/7/dddddddddddd-2.txt')[0], { file: 'board:org/board/7/dddddddddddd-2.txt', caption: 'x', kind: 'text' });
  fs.copyFileSync(path.join(projectRoot, 'a.png'), path.join(boardCache, 'org', 'board', '7', 'eeeeeeeeeeee-1.png'));
  assert.equal(ev('m1', 'board:org/board/7/eeeeeeeeeeee-1.png')[0]!.kind, 'image');
  // Not the form a received post's file has: refused, though board images take it (review finding 3).
  assert.throws(() => ev('m1', 'board:org/board/7/aaaaaaaaaaaa-shot.png'), /Only a file received with a board post/);
  assert.equal(ev('s1', 'run.log')[0]!.kind, 'text');
  assert.throws(() => ev('s1', 'board:org/board/7/dddddddddddd-2.txt'), /Only a manager/);
  assert.throws(() => ev('m1', 'board:other/repo/1/cccccccccccc-y.png'), /No project here uses the board "other\/repo"/);
  assert.throws(() => ev('m1', 'board:org/board/7/../../secret.png'), /Only a file received with a board post/);
  // A held post's copy waits in outbox/ for the user's approval: never evidence (review finding 3).
  fs.mkdirSync(path.join(boardCache, 'org', 'board', 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(boardCache, 'org', 'board', 'outbox', '0123456789ab-1.txt'), 'held');
  assert.throws(() => ev('m1', 'board:org/board/outbox/0123456789ab-1.txt'), /Only a file received with a board post/);
  assert.throws(() => ev('s1', '../ledung-secret.png'), /Evidence 1 \(\.\.\/ledung-secret\.png\) can't be attached: Only files inside the project folder/);
  assert.throws(() => ev('s1', 'a.svg'), /only PNG and JPEG images and \.txt, \.log or \.md text files/);
});

// Issue #160, docs/steps/relay.md steps 3-5: the public name a relay delivers to 127.0.0.1. Only a live paired
// device signs in there, and what needs the page key there also needs that device's passkey for that very request.
const pub = (opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) =>
  request({ ...opts, headers: { host: PUBLIC, ...opts.headers } });

/** Pairs a device the way a phone does: a code from Settings here, the form on the public name. */
async function pairDevice(name = 'Phone'): Promise<{ cookie: string; id: string }> {
  const page = await livePage();
  const made = await change('/api/devices-pair', {}, { 'x-ledung-page': page.key });
  page.close();
  assert.equal(made.status, 200, made.body);
  const code = new URL(JSON.parse(made.body).url).pathname.slice('/p/'.length);
  const done = await pub({
    method: 'POST', path: '/pair', body: new URLSearchParams({ code, name }).toString(),
    headers: { origin: PUBLIC_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(done.status, 303, done.body);
  const value = /__Host-ledung_device=([0-9a-f]{64})/.exec(String(done.headers['set-cookie']))![1]!;
  return { cookie: `__Host-ledung_device=${value}`, id: server.devices.byCookie(value)!.id };
}

/** The open page on the public name, as a paired device; also tells when Ledung closes it. */
function publicPage(cookie: string): Promise<{ key: string; close(): void; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { host: PUBLIC, cookie, origin: PUBLIC_ORIGIN } });
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    ws.once('message', (data) => resolve({ key: JSON.parse(String(data)).pageKey, close: () => ws.close(), closed }));
    ws.on('error', reject);
  });
}

const pubChange = (path: string, body: unknown, cookie: string, extra: Record<string, string> = {}) =>
  pub({ method: 'POST', path, headers: { cookie, origin: PUBLIC_ORIGIN, 'content-type': 'application/json', ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });

/** The first thing the live connection sends: its hello. */
function helloOf(headers: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers });
    ws.once('message', (data) => {
      ws.close();
      resolve(JSON.parse(String(data)));
    });
    ws.on('error', reject);
  });
}

test('the page is told it came through the public name only when it did: the remote frame (issue #232)', async () => {
  const { cookie } = await pairDevice('Frame phone');
  assert.equal((await helloOf({ cookie: COOKIE, origin: ORIGIN })).throughPublicName, false, 'on the computer itself');
  assert.equal((await helloOf({ host: PUBLIC, cookie, origin: PUBLIC_ORIGIN })).throughPublicName, true, 'through the public name');
  assert.equal(JSON.parse((await request({ path: '/api/state', headers: { cookie: COOKIE } })).body).throughPublicName, false);
  assert.equal(JSON.parse((await pub({ path: '/api/state', headers: { cookie } })).body).throughPublicName, true);
});

test('the public name is a host only when configured, and only spelled exactly', async () => {
  const { Guard } = await import('../src/server/security.ts');
  const req = (host: string) => ({ headers: { host } }) as any;
  assert.equal(new Guard(TOKEN, 4317).hostAllowed(req(PUBLIC)), false, 'not configured');
  const g = new Guard(TOKEN, 4317, [], false, { publicName: PUBLIC, device: () => null });
  assert.equal(g.hostAllowed(req(PUBLIC)), true);
  assert.equal(g.hostAllowed(req(PUBLIC.toUpperCase())), true, 'host names are case-insensitive');
  for (const lookalike of [`${PUBLIC}:4317`, `${PUBLIC}:443`, `evil.${PUBLIC}`, `${PUBLIC}.evil.example`, '*.example.test', 'example.test', `${PUBLIC}.`]) {
    assert.equal(g.hostAllowed(req(lookalike)), false, lookalike);
  }
  // Through the server: a lookalike is an unknown host, whatever cookie it brings.
  assert.equal((await request({ path: '/api/state', headers: { host: `evil.${PUBLIC}`, cookie: COOKIE } })).status, 403);
});

test('a connection through the relay tunnel is the public name\'s whatever Host it claims (Martin, #160, question #219)', async () => {
  const { Guard } = await import('../src/server/security.ts');
  const socket = {};
  const req = (host: string, s: object = {}) => ({ headers: { host, cookie: COOKIE, origin: ORIGIN }, socket: s }) as any;
  const g = new Guard(TOKEN, 4317, [], false, { publicName: PUBLIC, device: () => null });
  g.markTunnel(socket);
  for (const host of ['127.0.0.1:4317', 'localhost:4317', PUBLIC, 'anything.example']) {
    assert.equal(g.isPublic(req(host, socket)), true, host);
    // So the install's cookie and a local Origin count for nothing there; only a paired device would.
    assert.equal(g.signedIn(req(host, socket)), false, host);
    assert.equal(g.mayUse(req(host, socket)), false, host);
    assert.equal(g.originAllowed(req(host, socket)), false, host);
  }
  // The same request on an unmarked connection is local, as before.
  assert.equal(g.isPublic(req('127.0.0.1:4317')), false);
  assert.equal(g.mayUse(req('127.0.0.1:4317')), true);
  // A tunnel connection to a Ledung with no public name is allowed as nothing.
  const none = new Guard(TOKEN, 4317);
  none.markTunnel(socket);
  assert.equal(none.hostAllowed(req('127.0.0.1:4317', socket)), false);
  assert.equal(none.mayUse(req('127.0.0.1:4317', socket)), false);
  assert.equal(none.originAllowed(req('127.0.0.1:4317', socket)), false);
});

test('a config publicName is one exact DNS name', () => {
  const remote = (publicName: string) => parseConfig({ remote: { relay: 'wss://relay.example.test', name: 'pc', publicName, secret: 's' } });
  assert.equal(remote('PC.Example.test').remote?.publicName, 'pc.example.test');
  for (const bad of ['*.example.test', 'https://pc.example.test', 'pc.example.test:443', '127.0.0.1', 'localhost', 'pc', 'pc.example.test/x', '']) {
    assert.throws(() => remote(bad), /publicName/, bad);
  }
  assert.equal(parseConfig({}).remote, undefined);
});

test('through the public name only https://<name> is its own origin, and locally never that one', async () => {
  const { Guard } = await import('../src/server/security.ts');
  const req = (host: string, origin: string) => ({ headers: { host, origin } }) as any;
  const g = new Guard(TOKEN, 4317, [], false, { publicName: PUBLIC, device: () => null });
  assert.equal(g.originAllowed(req(PUBLIC, PUBLIC_ORIGIN)), true);
  assert.equal(g.originAllowed(req(PUBLIC, `http://${PUBLIC}`)), false, 'not https');
  assert.equal(g.originAllowed(req(PUBLIC, `https://${PUBLIC}:4317`)), false);
  assert.equal(g.originAllowed(req(PUBLIC, 'http://127.0.0.1:4317')), false, "the local page's origin");
  assert.equal(g.originAllowed(req('127.0.0.1:4317', PUBLIC_ORIGIN)), false, 'the public origin on the local name');
  assert.equal(g.originAllowed(req('127.0.0.1:4317', 'http://127.0.0.1:4317')), true, 'locally as before');
});

test('the public name is never a local-network name: "lanSignIn": false does not open it', async () => {
  const { Guard } = await import('../src/server/security.ts');
  const req = (host: string) => ({ headers: { host } }) as any;
  const open = new Guard(TOKEN, 4317, ['192.168.1.20', PUBLIC], true, { publicName: PUBLIC, device: () => null });
  assert.equal(open.mayUse(req('192.168.1.20:4317')), true, 'the network name, as before');
  assert.equal(open.mayUse(req(PUBLIC)), false);
  assert.equal(open.mayUse(req(`${PUBLIC}:4317`)), false);
  assert.equal(open.hostAllowed(req(`${PUBLIC}:4317`)), false, 'not answered to as a network name either');
});

test("the guard's own sign-in check refuses the token through the public name, for any caller (test review m1)", async () => {
  const { Guard } = await import('../src/server/security.ts');
  const req = (host: string) => ({ headers: { host, cookie: COOKIE } }) as any;
  const g = new Guard(TOKEN, 4317, [], false, { publicName: PUBLIC, device: () => null });
  assert.equal(g.signedIn(req(PUBLIC)), false);
  assert.equal(g.signedIn(req('127.0.0.1:4317')), true, 'locally as before');
});

test('the install token signs in nowhere through the public name: not its cookie, not its link', async () => {
  assert.equal((await pub({ path: '/api/state', headers: { cookie: COOKIE } })).status, 401);
  assert.equal((await pub({ path: '/', headers: { cookie: COOKIE } })).status, 401);
  const link = await pub({ path: `/login?token=${TOKEN}` });
  assert.equal(link.status, 403);
  assert.equal(link.headers['set-cookie'], undefined);
  assert.equal((await pub({ path: '/api/state' })).status, 401);
  // The live connection too.
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { host: PUBLIC, cookie: COOKIE, origin: PUBLIC_ORIGIN } });
    ws.on('open', resolve);
    ws.on('error', reject);
  }), /403/);
  // Locally the token works as before.
  assert.equal((await request({ path: `/login?token=${TOKEN}` })).status, 302);
});

test("the page's live connection may use wss on the public name", async () => {
  const csp = String((await request({ path: '/api/state', headers: { cookie: COOKIE } })).headers['content-security-policy']);
  const name = PUBLIC.replaceAll('.', '\\.');
  assert.match(csp, new RegExp(`connect-src [^;]*wss://${name}`));
  assert.doesNotMatch(csp, new RegExp(` ws://${name}`));
  assert.doesNotMatch(securityHeaders(4317)['Content-Security-Policy']!, /wss:/, 'none without a public name');
});

test('pairing: a code made on this computer from the open page, used once on the public name, sets a Secure device cookie', async () => {
  // Making a code needs the open page: a device can allow sensitive calls once it has its passkey.
  assert.equal((await change('/api/devices-pair', {})).status, 403);
  const page = await livePage();
  const made = await change('/api/devices-pair', {}, { 'x-ledung-page': page.key });
  page.close();
  const { url, expiresAt } = JSON.parse(made.body);
  // The short link the QR code carries (#194): /p/ and 20 letters and digits.
  assert.match(url, new RegExp(`^https://${PUBLIC.replaceAll('.', '\\.')}/p/[0-9a-z]{20}$`));
  assert.ok(expiresAt > Date.now() + 9 * 60_000 && expiresAt <= Date.now() + 10 * 60_000);
  const code = new URL(url).pathname.slice('/p/'.length);
  // /p/ and /pair exist only on the public name; their GET shows the form and uses nothing up.
  assert.equal((await request({ path: `/p/${code}` })).status, 404);
  assert.equal((await request({ path: `/pair?code=${code}` })).status, 404);
  assert.equal((await pub({ path: '/pair?code=wrong' })).status, 403);
  assert.equal((await pub({ path: '/p/wrong' })).status, 403);
  assert.equal((await pub({ method: 'POST', path: `/p/${code}`, headers: { origin: PUBLIC_ORIGIN } })).status, 405);
  // The QR code carries the link in capitals, so the phone opens /P/<CODE>.
  for (const path of [`/p/${code}`, `/P/${code.toUpperCase()}`, `/pair?code=${code}`]) {
    assert.equal((await pub({ path })).status, 200, path);
  }
  const form = await pub({ path: `/P/${code.toUpperCase()}` });
  assert.equal(form.status, 200);
  assert.match(form.body, /<form method="post" action="\/pair">/);
  // Under the usual no-referrer a browser posts the form with "Origin: null", which the check refuses
  // (seen in Chrome, PR #164 round 2): the form's page lets its own origin go along.
  assert.equal(form.headers['referrer-policy'], 'same-origin');
  // The phone posts the code as its form holds it, in capitals here.
  const formCode = /name="code" value="([^"]+)"/.exec(form.body)![1]!;
  assert.equal(formCode, code.toUpperCase());
  const post = (headers: Record<string, string>, c = formCode) =>
    pub({ method: 'POST', path: '/pair', body: new URLSearchParams({ code: c, name: 'My phone' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  assert.equal((await post({})).status, 403, 'no origin');
  assert.equal((await post({ origin: `http://${PUBLIC}` })).status, 403, 'not https');
  assert.equal((await post({ origin: PUBLIC_ORIGIN }, 'x'.repeat(20))).status, 403, 'a wrong code');
  const done = await post({ origin: PUBLIC_ORIGIN });
  assert.equal(done.status, 303);
  assert.equal(done.headers.location, '/#/settings');
  assert.match(String(done.headers['set-cookie']), /^__Host-ledung_device=[0-9a-f]{64}; Secure; HttpOnly; SameSite=Strict; Path=\//);
  assert.equal((await post({ origin: PUBLIC_ORIGIN })).status, 403, 'used once');
  const cookie = /^(__Host-ledung_device=[0-9a-f]{64})/.exec(String(done.headers['set-cookie']))![1]!;
  // The device is in through the public name, and nowhere else: locally its cookie is not a sign-in.
  assert.equal((await pub({ path: '/api/state', headers: { cookie } })).status, 200);
  assert.equal((await pub({ path: '/', headers: { cookie } })).status, 200);
  assert.equal((await request({ path: '/api/state', headers: { cookie } })).status, 401);
  const me = JSON.parse((await pub({ path: '/api/device', headers: { cookie } })).body);
  assert.equal(me.remote, true);
  assert.equal(me.device.name, 'My phone');
  assert.equal(me.mayAddPasskey, true);
  assert.deepEqual(JSON.parse((await request({ path: '/api/device', headers: { cookie: COOKIE } })).body), { remote: false });
});

test('devices are listed, paired and revoked only on this computer; a revoked device is out at once, open page and all', async () => {
  const { cookie, id } = await pairDevice('To revoke');
  assert.equal((await pub({ path: '/api/devices', headers: { cookie } })).status, 403);
  assert.equal((await pubChange('/api/devices-pair', {}, cookie)).status, 403);
  assert.equal((await pubChange(`/api/devices/${id}/revoke`, {}, cookie)).status, 403);
  const list = JSON.parse((await request({ path: '/api/devices', headers: { cookie: COOKIE } })).body);
  assert.equal(list.publicName, PUBLIC);
  assert.ok(list.devices.some((d: { id: string; name: string }) => d.id === id && d.name === 'To revoke'));
  assert.equal(JSON.stringify(list).includes(cookie.split('=')[1]!), false, 'no cookie in the list');

  const page = await publicPage(cookie);
  assert.equal((await change(`/api/devices/${id}/revoke`, {}, { origin: 'https://evil.example' })).status, 403, 'a change, like every change');
  assert.equal((await change(`/api/devices/${id}/revoke`, {})).status, 200);
  assert.equal(await page.closed, 1008, 'its live connection is closed');
  assert.equal((await pub({ path: '/api/state', headers: { cookie } })).status, 401);
  assert.equal((await change(`/api/devices/${id}/revoke`, {})).status, 400, 'already revoked');
});

test("through the public name a page-key action needs this device's passkey, signing exactly that request", async () => {
  const { cookie, id } = await pairDevice();
  const page = await publicPage(cookie);
  const withKey = { 'x-ledung-page': page.key };
  const allow = JSON.stringify({ behavior: 'allow' });
  const path = '/api/permissions/perm-sensitive';
  // A device without a passkey only looks: even an ordinary request is refused (Martin, 2026-10-17 12:54).
  const plain = await pubChange('/api/permissions/perm-plain', allow, cookie);
  assert.equal(plain.status, 403);
  assert.match(errorOf(plain), /no passkey/);
  // No page key, a local page's key, or the right key with no passkey: refused.
  assert.equal((await pubChange(path, allow, cookie)).status, 403);
  const local = await livePage();
  assert.equal((await pubChange(path, allow, cookie, { 'x-ledung-page': local.key })).status, 403, "a local page's key");
  local.close();
  assert.match(errorOf(await pubChange(path, allow, cookie, withKey)), /no passkey/);

  // Set up the passkey, from this device's open page.
  const key = new FakePasskey(PUBLIC);
  assert.equal((await pubChange('/api/passkey-options', {}, cookie)).status, 403, 'needs the open page');
  const options = JSON.parse((await pubChange('/api/passkey-options', {}, cookie, withKey)).body);
  const registered = await pubChange('/api/passkey', { response: key.register(options) }, cookie, withKey);
  assert.equal(registered.status, 200, registered.body);
  assert.equal(JSON.parse(registered.body).passkey, true);
  assert.equal((await pubChange('/api/passkey-options', {}, cookie, withKey)).status, 403, 'only one passkey');

  const challenge = async (body: string, p = path) => JSON.parse((await pubChange('/api/passkey-challenge', { method: 'POST', path: p, body }, cookie)).body);
  // A signature for allowing this request does not deny it, nor allow another one.
  const forAllow = await challenge(allow);
  const denied = await pubChange(path, JSON.stringify({ behavior: 'deny' }), cookie, { ...withKey, 'x-ledung-passkey': key.header(forAllow) });
  assert.equal(denied.status, 403);
  assert.match(errorOf(denied), /something else/);
  const forOther = await challenge(allow, '/api/permissions/perm-other');
  assert.match(errorOf(await pubChange(path, allow, cookie, { ...withKey, 'x-ledung-passkey': key.header(forOther) })), /something else/);
  // No user verification: refused.
  assert.equal((await pubChange(path, allow, cookie, { ...withKey, 'x-ledung-passkey': key.header(await challenge(allow), { noUserVerification: true }) })).status, 403);
  // The right one gets past every check to the manager, once.
  const good = key.header(await challenge(allow));
  const passed = await pubChange(path, allow, cookie, { ...withKey, 'x-ledung-passkey': good });
  assert.equal(passed.status, 400, passed.body);
  assert.match(errorOf(passed), /no longer waiting/);
  assert.match(errorOf(await pubChange(path, allow, cookie, { ...withKey, 'x-ledung-passkey': good })), /already used/);

  // Words to a manager: bound to their hash, like a decision.
  const forWords = await challenge(JSON.stringify({ text: 'merge #1' }), '/api/sessions/m1/messages');
  const otherWords = await pubChange('/api/sessions/m1/messages', JSON.stringify({ text: 'merge #2' }), cookie, { ...withKey, 'x-ledung-passkey': key.header(forWords) });
  assert.equal(otherWords.status, 403);
  assert.match(errorOf(otherWords), /something else/);
  // An answer to a manager's question, signed for exactly its words, gets through to the manager (withdrawn,
  // so it ends there with nothing started); without the passkey it does not (test review m2).
  const answerPath = `/api/questions/${managerQuestion}/answer`;
  const answer = JSON.stringify({ answer: 'yes, merge' });
  assert.match(errorOf(await pubChange(answerPath, answer, cookie, withKey)), /locked/);
  const answered = await pubChange(answerPath, answer, cookie, { ...withKey, 'x-ledung-passkey': key.header(await challenge(answer, answerPath)) });
  assert.equal(answered.status, 400, answered.body);
  assert.match(errorOf(answered), /no longer open/);
  // Another device's page key with this device's passkey: refused.
  const other = await pairDevice('Other');
  const otherPage = await publicPage(other.cookie);
  assert.equal((await pubChange(path, allow, cookie, { 'x-ledung-page': otherPage.key, 'x-ledung-passkey': key.header(await challenge(allow)) })).status, 403);
  otherPage.close();
  page.close();
  assert.equal(server.devices.get(id)?.credentialId, key.credentialId);
});

/** A paired device with its passkey set up and its page open (locked: nothing unlocked it yet). */
async function deviceWithPasskey(name = 'Phone') {
  const { cookie, id } = await pairDevice(name);
  const page = await publicPage(cookie);
  const withKey = { 'x-ledung-page': page.key };
  const key = new FakePasskey(PUBLIC);
  const options = JSON.parse((await pubChange('/api/passkey-options', {}, cookie, withKey)).body);
  assert.equal((await pubChange('/api/passkey', { response: key.register(options) }, cookie, withKey)).status, 200);
  /** The passkey header for exactly this request. */
  const sign = async (p: string, body: string) =>
    key.header(JSON.parse((await pubChange('/api/passkey-challenge', { method: 'POST', path: p, body }, cookie)).body));
  return { cookie, id, page, withKey, key, sign };
}

/** Every change route of the API, read from the server's source, so a route added later is covered too. */
function changeRoutes(): string[] {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'server', 'server.ts'), 'utf8');
  return [...source.matchAll(/case '(POST|PUT|PATCH|DELETE) ([^']+)'/g)].map((m) => `${m[1]} /api/${m[2]!.replaceAll(':id', 'nope')}`);
}

test('computers are linked and unlinked only on this computer: a paired device, unlocked and signing, is refused (#245 step 1)', async () => {
  const d = await deviceWithPasskey('Linking phone');
  try {
    assert.equal((await pubChange('/api/device-unlock', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/device-unlock', '{}') })).status, 200);
    // Unlocked, with the page key and a signature for each request: everything but being on this computer.
    const here = /Computers are linked and unlinked in Settings on the computer Ledung runs on/;
    const list = await pub({ path: '/api/links', headers: { cookie: d.cookie } });
    assert.equal(list.status, 403, list.body);
    assert.match(errorOf(list), here);
    for (const [p, body] of [['/api/links-code', '{}'], ['/api/links-join', JSON.stringify({ code: 'mac.l.example.com/abcdefghijklmnopqrstuvwx', name: 'Mac' })], ['/api/links/some-link/remove', '{}']] as const) {
      const res = await pubChange(p, body, d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign(p, body) });
      assert.equal(res.status, 403, `${p}: ${res.body}`);
      assert.match(errorOf(res), here, p);
    }
  } finally {
    d.page.close();
  }
});

test("an account's folder opens only on this computer, from its open page (issue #414)", async () => {
  // An account straight in the database: adding it through the manager would check its sign-in with Claude Code.
  const folder = path.join(projectRoot, 'account-work');
  paneStore.database.prepare('INSERT INTO accounts (name, kind, config_dir, created_at) VALUES (?, ?, ?, ?)').run('work', 'folder', folder, Date.now());
  const p = '/api/accounts/work/open-folder';
  // The cookie alone, as a script that read the sign-in token has it: refused, nothing opened.
  const noPage = await change(p, {});
  assert.equal(noPage.status, 403, noPage.body);
  assert.deepEqual(openedFolders, []);
  // A paired device, unlocked and signing: everything but being on this computer.
  const d = await deviceWithPasskey('Folder phone');
  try {
    assert.equal((await pubChange('/api/device-unlock', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/device-unlock', '{}') })).status, 200);
    const remote = await pubChange(p, '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign(p, '{}') });
    assert.equal(remote.status, 403, remote.body);
    assert.match(errorOf(remote), /Folders are opened in Settings on the computer Ledung runs on/);
    assert.deepEqual(openedFolders, []);
  } finally {
    d.page.close();
  }
  // This computer's open page: the account's own folder, made again since it was not there.
  const page = await livePage();
  try {
    const ok = await change(p, {}, { 'x-ledung-page': page.key });
    assert.equal(ok.status, 200, ok.body);
    assert.deepEqual(openedFolders, [folder]);
    assert.ok(fs.statSync(folder).isDirectory());
    assert.equal((await change('/api/accounts/nobody/open-folder', {}, { 'x-ledung-page': page.key })).status, 400);
    assert.deepEqual(openedFolders, [folder]);
  } finally {
    page.close();
    paneStore.database.prepare('DELETE FROM accounts WHERE name = ?').run('work');
  }
});

test('through the public name a device is read-only until its passkey unlocks it, for 30 minutes (Martin, 2026-10-17 12:54)', async () => {
  // Martin, 2026-10-17 12:54: "C but unlocks 30min" — the decision's figure, not the code's own constant.
  const UNLOCK_MS = 30 * 60 * 1000;
  const d = await deviceWithPasskey();
  // Logging out (issue #241) only takes rights away, so it is open while locked too; so is the link that sets the
  // passkey up in a window of its own (issue #241), as setting it up here is.
  const open = new Set(['/api/device-unlock', '/api/passkey-challenge', '/api/passkey-options', '/api/passkey', '/api/device-logout', '/api/passkey-enrol-link']);
  const routes = changeRoutes().filter((r) => !open.has(r.split(' ')[1]!));
  assert.ok(routes.length >= 30, `found ${routes.length} change routes: the source was read`);
  // A copied cookie, page and all, without the unlock: every change route refuses before doing anything.
  for (const route of routes) {
    const [method, p] = route.split(' ') as [string, string];
    const res = await pub({ method, path: p, headers: { cookie: d.cookie, origin: PUBLIC_ORIGIN, 'content-type': 'application/json', ...d.withKey }, body: method === 'DELETE' ? undefined : '{}' });
    assert.equal(res.status, 403, `${route}: ${res.body}`);
    assert.match(errorOf(res), /locked/, route);
  }
  // Reads still work, and the page sees the lock.
  assert.equal(JSON.parse((await pub({ path: '/api/device', headers: { cookie: d.cookie } })).body).unlockedUntil, null);
  // A made-up signature does not get past the lock either.
  assert.equal((await pubChange('/api/permissions/perm-plain', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': 'bm9wZQ' })).status, 403);

  // Unlocking needs the page and a signature for the unlock itself.
  assert.match(errorOf(await pubChange('/api/device-unlock', '{}', d.cookie, d.withKey)), /needs your passkey/);
  assert.equal((await pubChange('/api/device-unlock', '{}', d.cookie, { 'x-ledung-passkey': await d.sign('/api/device-unlock', '{}') })).status, 403, 'no page key');
  assert.match(errorOf(await pubChange('/api/device-unlock', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/away', '{}') })), /something else/);
  const unlocked = await pubChange('/api/device-unlock', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/device-unlock', '{}') });
  assert.equal(unlocked.status, 200, unlocked.body);
  const until = JSON.parse(unlocked.body).unlockedUntil;
  assert.ok(Math.abs(until - (Date.now() + UNLOCK_MS)) < 5000);
  assert.equal(JSON.parse((await pub({ path: '/api/device', headers: { cookie: d.cookie } })).body).unlockedUntil, until);

  // Unlocked: ordinary changes go through to the manager.
  const plain = await pubChange('/api/permissions/perm-plain', JSON.stringify({ behavior: 'allow' }), d.cookie);
  assert.equal(plain.status, 400);
  assert.match(errorOf(plain), /no longer waiting/);
  assert.notEqual((await pubChange('/api/sessions/nope/pause', '{}', d.cookie)).status, 403);
  // Sensitive decisions are still signed one by one; words to a manager are covered by the unlock (issue #192).
  const allow = JSON.stringify({ behavior: 'allow' });
  assert.match(errorOf(await pubChange('/api/permissions/perm-sensitive', allow, d.cookie, d.withKey)), /needs your passkey/);
  const answerPath = `/api/questions/${managerQuestion}/answer`;
  assert.match(errorOf(await pubChange(answerPath, JSON.stringify({ answer: 'merge' }), d.cookie, d.withKey)), /no longer open/);
  const signed = await pubChange('/api/permissions/perm-sensitive', allow, d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/permissions/perm-sensitive', allow) });
  assert.match(errorOf(signed), /no longer waiting/);
  // The unlock is this device's: another paired device stays locked.
  const other = await deviceWithPasskey('Other');
  assert.match(errorOf(await pubChange('/api/permissions/perm-plain', allow, other.cookie)), /locked/);
  other.page.close();

  // After 30 minutes it is locked again.
  try {
    clockShift = UNLOCK_MS;
    assert.match(errorOf(await pubChange('/api/permissions/perm-plain', allow, d.cookie)), /locked/);
    assert.equal(JSON.parse((await pub({ path: '/api/device', headers: { cookie: d.cookie } })).body).unlockedUntil, null);
  } finally {
    clockShift = 0;
  }

  // Revoking clears the unlock.
  const again = await pubChange('/api/device-unlock', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/device-unlock', '{}') });
  assert.equal(again.status, 200);
  assert.equal((await change(`/api/devices/${d.id}/revoke`, {})).status, 200);
  assert.equal((server as unknown as { passkeys: { unlockedUntil(id: string): number | null } }).passkeys.unlockedUntil(d.id), null);
  d.page.close();
});

// Martin, 2026-10-18 10:41 (Ledung question #268): "c — Unlock covers everything a manager receives, merge words
// included", accepting "Anyone holding your unlocked phone could have a PR merged for up to 30 minutes."
test('through the public name the 30-minute unlock covers words to a manager, with the page key and no signature each (issue #192)', async () => {
  const UNLOCK_MS = 30 * 60 * 1000;
  const d = await deviceWithPasskey();
  const cases = managerWords();
  // Locked: refused as locked, so the page unlocks once and sends again.
  for (const c of cases) assert.match(errorOf(await pubChange(c.path, JSON.stringify(c.body), d.cookie, d.withKey)), /locked/, c.name);
  assert.equal((await pubChange('/api/device-unlock', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/device-unlock', '{}') })).status, 200);

  // Unlocked: each goes through on the page key alone, and again (two messages, one unlock).
  for (const round of [1, 2]) {
    for (const c of cases) {
      const passed = await pubChange(c.path, JSON.stringify(c.body), d.cookie, d.withKey);
      assert.equal(passed.status, 400, `${c.name}, round ${round}: ${passed.body}`);
      assert.match(errorOf(passed), c.then, c.name);
    }
  }
  // The page key is still needed: none, a local page's or another device's is refused.
  const local = await livePage();
  const other = await deviceWithPasskey('Other');
  try {
    for (const c of cases) {
      for (const [what, headers] of [['no page key', {}], ["a local page's key", { 'x-ledung-page': local.key }], ["another device's key", other.withKey]] as const) {
        const refused = await pubChange(c.path, JSON.stringify(c.body), d.cookie, headers);
        assert.equal(refused.status, 403, `${c.name}, ${what}`);
        assert.match(errorOf(refused), /open page/, `${c.name}, ${what}`);
      }
    }
  } finally {
    local.close();
    other.page.close();
  }

  // Still signed one by one while unlocked: a sensitive decision, an answer about one, and what opens Ledung up.
  const signedOnly: [string, string, string][] = [
    ['a sensitive decision', '/api/permissions/perm-sensitive', JSON.stringify({ behavior: 'allow' })],
    ['an answer about a sensitive request', `/api/questions/${questionAbout['perm-sensitive']}/answer`, JSON.stringify({ answer: 'yes' })],
    ['away mode', '/api/away', JSON.stringify({ until: 'never' })],
    ['a rename', '/api/projects/p/rename', JSON.stringify({ name: 'renamed' })],
    ['the unlock itself', '/api/device-unlock', '{}'],
  ];
  const sensitive = await pSensitive();
  const settings = (lockdown?: unknown) => ({ name: 'p', runner: 'local', path: projectRoot, ...sensitive, ...(lockdown ? { lockdown } : {}) });
  assert.equal((await change('/api/projects/p', settings({ level: 'A' }))).status, 200);
  try {
    signedOnly.push(['opening a locked project up', '/api/projects/p', JSON.stringify(settings())], ['removing a locked project', '/api/projects/p/remove', '{}']);
    for (const [name, p, body] of signedOnly) assert.match(errorOf(await pubChange(p, body, d.cookie, d.withKey)), /needs your passkey/, name);
  } finally {
    const page = await livePage();
    const opened = await change('/api/projects/p', settings(), { 'x-ledung-page': page.key });
    page.close();
    assert.equal(JSON.parse(opened.body).lockdown.level, 'off');
  }

  // After 30 minutes words to a manager are refused as locked again.
  try {
    clockShift = UNLOCK_MS;
    for (const c of cases) assert.match(errorOf(await pubChange(c.path, JSON.stringify(c.body), d.cookie, d.withKey)), /locked/, c.name);
  } finally {
    clockShift = 0;
  }
  d.page.close();
});

test('locally nothing changes: the page key alone still decides a sensitive request, and no passkey is asked', async () => {
  const page = await livePage();
  const passed = await change('/api/permissions/perm-sensitive', { behavior: 'allow' }, { 'x-ledung-page': page.key });
  page.close();
  assert.equal(passed.status, 400);
  assert.match(errorOf(passed), /no longer waiting/);
  assert.equal((await change('/api/passkey-challenge', { method: 'POST', path: '/api/away', body: '{}' })).status, 404, 'no device here');
});

test('through the public name a project setting that loosens the sensitive gate is signed for itself, even unlocked (issue #107)', async () => {
  const bare = await bareP();
  await setP(plainSettings());
  const d = await deviceWithPasskey();
  try {
    assert.equal((await pubChange('/api/device-unlock', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/device-unlock', '{}') })).status, 200);
    // Unlocked, other settings go through on the page key alone, like every ordinary change.
    assert.equal((await pubChange('/api/projects/p', plainSettings({ model: 'haiku' }), d.cookie, d.withKey)).status, 200);
    for (const [name, p, body] of gateLoosening()) {
      const text = JSON.stringify(body);
      assert.match(errorOf(await pubChange(p, text, d.cookie, d.withKey)), /needs your passkey/, name);
      // A signature for other settings does not do.
      const forOther = await d.sign(p, JSON.stringify(plainSettings({ model: 'other' })));
      assert.match(errorOf(await pubChange(p, text, d.cookie, { ...d.withKey, 'x-ledung-passkey': forOther })), /something else/, name);
      pastCheck(name, await pubChange(p, text, d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign(p, text) }));
      if (p === '/api/projects/p') assert.equal((await change(p, plainSettings())).status, 200, `${name} taken back`);
    }
  } finally {
    d.page.close();
    await setP(bare);
  }
});

test("chats' settings: taking a pattern out needs the live page, adding one the cookie; starting a chat needs the sign-in and Ledung's own origin (issue #211)", async () => {
  assert.equal((await request({ path: '/api/chats' })).status, 401, 'reading them needs the cookie');
  assert.equal((await request({ method: 'POST', path: '/api/chats', headers: { cookie: COOKIE, 'content-type': 'application/json' }, body: '{}' })).status, 403, 'changing them needs the origin');
  const chats = JSON.parse((await request({ path: '/api/chats', headers: { cookie: COOKIE } })).body) as { sensitive: { commandPatterns: string[]; pathPatterns: string[]; mcpTools: string[] } };
  assert.ok(chats.sensitive.commandPatterns.length, 'they start with the suggestions');
  const fewer = { sensitive: { ...chats.sensitive, commandPatterns: chats.sensitive.commandPatterns.slice(1) } };
  const refused = await change('/api/chats', fewer);
  assert.equal(refused.status, 403, refused.body);
  assert.match(errorOf(refused), /open page/);
  const more = { sensitive: { ...chats.sensitive, commandPatterns: [...chats.sensitive.commandPatterns, String.raw`\bmine\b`] } };
  assert.equal((await change('/api/chats', more)).status, 200, 'a pattern added: the cookie');
  const page = await livePage();
  try {
    assert.equal((await change('/api/chats', { sensitive: chats.sensitive }, { 'x-ledung-page': page.key })).status, 200, 'taken out again from the open page');
  } finally {
    page.close();
  }
  const start = JSON.stringify({ folder: path.join(projectRoot, 'no-such-folder') });
  assert.equal((await request({ method: 'POST', path: '/api/chats-new', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: start })).status, 401, 'no cookie');
  assert.equal((await request({ method: 'POST', path: '/api/chats-new', headers: { cookie: COOKIE, 'content-type': 'application/json' }, body: start })).status, 403, 'no origin');
  const past = await change('/api/chats-new', JSON.parse(start));
  assert.equal(past.status, 400, 'past the guard, refused by the folder check');
  assert.match(errorOf(past), /does not exist/);
  // A chat is never started through the project route.
  assert.match(errorOf(await change('/api/sessions', { project: CHATS })), /no project named/);
});

// A "!" command runs a command on this computer (issue #212, decision 2 of Martin, 2026-10-18 18:09): the open page,
// and through the public name an unlocked device and a passkey signature for each command.
test('a "!" command needs the sign-in, this host, Ledung\'s own origin and the live page', async () => {
  const run = '/api/sessions/nope/shell';
  const body = { command: 'echo hi', confirmed: false };
  assert.equal((await request({ method: 'POST', path: run, headers: { cookie: COOKIE, origin: ORIGIN, host: 'evil.example', 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 403, 'another host');
  assert.equal((await request({ method: 'POST', path: run, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 401, 'no sign-in');
  assert.equal((await request({ method: 'POST', path: run, headers: { cookie: COOKIE, origin: 'http://evil.example', 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 403, 'another origin');
  const noPage = await change(run, body);
  assert.equal(noPage.status, 403, 'the cookie alone: a script that read the token runs nothing');
  assert.match(errorOf(noPage), /open page/);
  assert.equal((await change(run, body, { 'x-ledung-page': 'b'.repeat(64) })).status, 403, 'a made-up key');
  const page = await livePage();
  const passed = await change(run, body, { 'x-ledung-page': page.key });
  page.close();
  assert.equal(passed.status, 400, 'with the key it reaches the manager');
  assert.match(errorOf(passed), /No such session/);
  // Stop needs the sign-in and Ledung's own origin, like every change; stopping is always safe, so no page key.
  const stop = '/api/sessions/nope/shell-stop';
  assert.equal((await request({ method: 'POST', path: stop, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' })).status, 401, 'stop: no sign-in');
  assert.equal((await request({ method: 'POST', path: stop, headers: { cookie: COOKIE, origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403, 'stop: another origin');
  const stopped = await change(stop, {});
  assert.equal(stopped.status, 400, 'stop: with the cookie it reaches the manager');
  assert.match(errorOf(stopped), /not running/);
  // The check before it is a read: the sign-in and this host, nothing else.
  assert.equal((await request({ path: '/api/sessions/nope/shell-check?command=ls' })).status, 401);
  assert.equal((await request({ path: '/api/sessions/nope/shell-check?command=ls', headers: { cookie: COOKIE, host: 'evil.example' } })).status, 403);
});

test('through the public name each "!" command is signed with the passkey, for exactly that command, and a locked device is refused', async () => {
  const UNLOCK_MS = 30 * 60 * 1000;
  const d = await deviceWithPasskey();
  const run = '/api/sessions/nope/shell';
  const body = JSON.stringify({ command: 'echo hi', confirmed: false });
  try {
    assert.match(errorOf(await pubChange(run, body, d.cookie, d.withKey)), /locked/, 'locked');
    assert.match(errorOf(await pubChange(run, body, d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign(run, body) })), /locked/, 'locked, even with a signature');
    assert.equal((await pubChange('/api/device-unlock', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/device-unlock', '{}') })).status, 200);
    // Unlocked is not enough: each command is signed on its own.
    assert.match(errorOf(await pubChange(run, body, d.cookie, d.withKey)), /needs your passkey/);
    const other = JSON.stringify({ command: 'rm -rf ~', confirmed: true });
    assert.match(errorOf(await pubChange(run, other, d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign(run, body) })), /something else/, 'a signature for another command');
    assert.equal((await pubChange(run, body, d.cookie, { 'x-ledung-passkey': await d.sign(run, body) })).status, 403, 'no page key');
    const signed = await d.sign(run, body);
    const passed = await pubChange(run, body, d.cookie, { ...d.withKey, 'x-ledung-passkey': signed });
    assert.equal(passed.status, 400, passed.body);
    assert.match(errorOf(passed), /No such session/);
    assert.match(errorOf(await pubChange(run, body, d.cookie, { ...d.withKey, 'x-ledung-passkey': signed })), /already used/, 'once');
    // Once the unlock has run out, a signed command is refused as locked again.
    clockShift = UNLOCK_MS;
    assert.match(errorOf(await pubChange(run, body, d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign(run, body) })), /locked/);
  } finally {
    clockShift = 0;
    d.page.close();
  }
});

// The Files pane (issue #225, a test feature): every read behind the sign-in and Host check, the tree and the
// file viewer only inside the session's folders, and line comments are the user's words like any change.
const PANE_READS = ['/api/sessions/w1/folders', '/api/sessions/w1/tree?in=session', '/api/sessions/w1/tree?in=project', '/api/sessions/w1/changes', '/api/sessions/w1/file?in=session&path=src/mine.ts'];

test("the Files pane's reads need the sign-in and this host", async () => {
  for (const p of PANE_READS) {
    assert.equal((await request({ path: p })).status, 401, `${p} without the cookie`);
    assert.equal((await request({ path: p, headers: { host: 'evil.example:80', cookie: COOKIE } })).status, 403, `${p} for another host`);
    assert.equal((await request({ path: p, headers: { cookie: COOKIE } })).status, 200, `${p} with the cookie`);
  }
});

test("the Files pane finds the worktree a worker entered itself, and lists it and the project folder with the viewer's rules", async () => {
  const get = async (p: string) => {
    const r = await request({ path: p, headers: { cookie: COOKIE } });
    return { status: r.status, body: JSON.parse(r.body) };
  };
  const folders = (await get('/api/sessions/w1/folders')).body.folders as { key: string; path: string }[];
  assert.deepEqual(folders.map((f) => f.key), ['session', 'project']);
  assert.equal(fs.realpathSync(folders[0]!.path), fs.realpathSync(path.join(projectRoot, '.claude', 'worktrees', 'fix-x')));
  assert.deepEqual((await get('/api/sessions/w1/tree?in=session')).body.entries.map((e: { name: string }) => e.name), ['src']);
  assert.equal((await get('/api/sessions/w1/file?in=session&path=src/mine.ts')).body.content, 'export const mine = 1;\n');
  const project = (await get('/api/sessions/w1/tree?in=project')).body.entries.map((e: { name: string }) => e.name) as string[];
  assert.ok(project.includes('a.png') && !project.includes('.claude'), project.join(', '));
  for (const bad of ['..', encodeURIComponent(path.dirname(projectRoot)), '.claude', 'wt/..%2F..%2F..']) {
    assert.equal((await get(`/api/sessions/w1/tree?in=project&path=${bad}`)).status, 400, bad);
  }
  // A session that has not moved has one folder; one that left its worktree is back in the project folder.
  assert.deepEqual((await get('/api/sessions/s1/folders')).body.folders.map((f: { key: string }) => f.key), ['session']);
  paneStore.addMessage('w1', 'sdk', { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_w1b', name: 'ExitWorktree', input: { action: 'keep' } }] } });
  assert.deepEqual((await get('/api/sessions/w1/folders')).body.folders.map((f: { key: string }) => f.key), ['session']);
});

test("the Files pane takes a worker's worktree only inside what its project allows: one it names elsewhere is ignored", async () => {
  // The folder comes from the worker's own EnterWorktree call, so it is the worker's word: here, the folder above the project.
  const above = path.dirname(projectRoot);
  paneStore.createSession({ id: 'w2', project: 'p', runner: 'local', title: 'fix-out', parentId: 'm1', permissionMode: 'default', role: 'session' });
  paneStore.addMessage('w2', 'sdk', { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_w2', name: 'EnterWorktree', input: { path: above } }] } });
  paneStore.addMessage('w2', 'sdk', { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_w2', content: `Switched to worktree at ${above} on branch x.` }] } });
  const get = async (p: string) => JSON.parse((await request({ path: p, headers: { cookie: COOKIE } })).body);
  const folders = (await get('/api/sessions/w2/folders')).folders as { key: string; path: string }[];
  assert.deepEqual(folders.map((f) => f.key), ['session'], 'no second folder');
  assert.equal(fs.realpathSync(folders[0]!.path), fs.realpathSync(projectRoot), 'the project folder, not the one it named');
  const names = (await get('/api/sessions/w2/tree?in=session')).entries.map((e: { name: string }) => e.name) as string[];
  assert.ok(names.includes('a.png') && !names.includes('ledung-secret.png'), names.join(', '));
  const read = await request({ path: '/api/sessions/w2/file?in=session&path=ledung-secret.png', headers: { cookie: COOKIE } });
  assert.notEqual(read.status, 200, 'the folder above is not read');
});

test("the Files pane keeps a locked project's folder shut to a project above it, as its sessions are (issue #109)", async () => {
  const inner = path.join(projectRoot, 'inner');
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(inner, 'secret.md'), 'locked');
  const added = await change('/api/projects', { name: 'inner', runner: 'local', path: inner, lockdown: { level: 'A' } });
  assert.equal(added.status, 200, added.body);
  try {
    const list = await request({ path: '/api/sessions/w1/tree?in=project', headers: { cookie: COOKIE } });
    assert.ok(!JSON.parse(list.body).entries.some((e: { name: string }) => e.name === 'inner'), 'not listed');
    assert.equal((await request({ path: '/api/sessions/w1/tree?in=project&path=inner', headers: { cookie: COOKIE } })).status, 400, 'not opened');
    assert.equal((await request({ path: '/api/sessions/w1/file?in=project&path=inner/secret.md', headers: { cookie: COOKIE } })).status, 400, 'not read');
  } finally {
    const page = await livePage();
    const removed = await change('/api/projects/inner/remove', {}, { 'x-ledung-page': page.key });
    page.close();
    assert.equal(removed.status, 200, removed.body);
  }
});

test("line comments need Ledung's own origin, and to a manager the live page, like the user's other words", async () => {
  const comments = [{ path: 'src/mine.ts', line: 1, side: 'new', lineText: 'export const mine = 1;', commit: 'abcdef1', body: 'Why one?' }];
  const noOrigin = await request({ method: 'POST', path: '/api/sessions/w1/line-comments', headers: { cookie: COOKIE, 'content-type': 'application/json' }, body: JSON.stringify({ comments }) });
  assert.equal(noOrigin.status, 403);
  // w1's manager m1 gets them: the cookie alone is not enough.
  const refused = await change('/api/sessions/w1/line-comments', { comments: [] });
  assert.equal(refused.status, 403);
  assert.match(errorOf(refused), /open page/);
  const page = await livePage();
  try {
    const passed = await change('/api/sessions/w1/line-comments', { comments: [] }, { 'x-ledung-page': page.key });
    assert.equal(passed.status, 400);
    assert.match(errorOf(passed), /no line comments/);
  } finally {
    page.close();
  }
  // A session with no manager gets them itself, as an ordinary message: the cookie is enough.
  const own = await change('/api/sessions/s1/line-comments', { comments: [] });
  assert.equal(own.status, 400);
  assert.match(errorOf(own), /no line comments/);
});

test("line comments with no review open reach the worker's manager, as the user's words with the formatted list", async () => {
  // m1 stands in as live, so the message is handed to it instead of resuming Claude Code.
  const internals = sessions as unknown as { live: Map<string, unknown>; config: { userName: string } };
  const sent: string[] = [];
  internals.live.set('m1', { info: paneStore.getSession('m1')!, send: (text: string) => sent.push(text) });
  const comments = [{ path: 'src/mine.ts', line: 1, side: 'new', lineText: 'export const mine = 1;', commit: 'abcdef1234', body: 'Why one?' }];
  const page = await livePage();
  try {
    const r = await change('/api/sessions/w1/line-comments', { comments, text: 'Two points.' }, { 'x-ledung-page': page.key });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(JSON.parse(r.body), { sentTo: 'm1', reviewId: null });
  } finally {
    page.close();
    internals.live.delete('m1');
  }
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.startsWith(`${internals.config.userName}'s line comments on the changes of your session "fix-x".`), sent[0]);
  assert.match(sent[0]!, /Two points\.\n\n1 line comment on fix-x at abcdef1:\n1\. src\/mine\.ts:1 {2}\+ /);
  assert.match(sent[0]!, /\n {3}Why one\?$/);
});

// Issue #237: Join with a code, Leave this relay and Settings → Relay. Every route is this computer's alone, every
// change needs the open page, and the admin key and the Cloudflare token never reach the page.
const RELAY_CHANGES: [string, unknown][] = [
  ['/api/remote-join', { code: 'relay.example.test/ABCD-ABCD-ABCD-ABCD-ABCD-ABCD-ABCD' }],
  ['/api/remote-leave', {}],
  ['/api/relay-admin', { relay: 'wss://relay.example.test' }],
  ['/api/relay-admin-key', {}],
  ['/api/relay-invite', { owner: 'Friend' }],
  ['/api/relay-invites/x/revoke', {}],
  ['/api/relay-computers/x/approve', {}],
  ['/api/relay-computers/x/added', {}],
];
const RELAY_READS = ['/api/remote-link', '/api/relay-admin', '/api/relay-computers'];

test('the relay routes refuse without the sign-in cookie, without Ledung\'s Origin and without the open page (issue #237)', async () => {
  const before = fs.existsSync(path.join(relayDir, 'relay-admin.json')) ? fs.readFileSync(path.join(relayDir, 'relay-admin.json'), 'utf8') : null;
  const json = { 'content-type': 'application/json' };
  for (const [route, body] of RELAY_CHANGES) {
    const text = JSON.stringify(body);
    assert.equal((await request({ method: 'POST', path: route, headers: json, body: text })).status, 401, `${route}: no cookie`);
    assert.equal((await request({ method: 'POST', path: route, headers: { ...json, cookie: COOKIE }, body: text })).status, 403, `${route}: no Origin`);
    assert.equal((await request({ method: 'POST', path: route, headers: { ...json, cookie: COOKIE, origin: 'https://evil.example' }, body: text })).status, 403, `${route}: another Origin`);
    const noPage = await change(route, body);
    assert.equal(noPage.status, 403, `${route}: cookie and Origin, but no open page`);
    assert.match(errorOf(noPage), /open page/, route);
    assert.equal((await request({ method: 'POST', path: route, headers: { ...json, host: `evil.example:${PORT}`, cookie: COOKIE, origin: ORIGIN }, body: text })).status, 403, `${route}: unknown Host`);
  }
  for (const route of RELAY_READS) {
    assert.equal((await request({ path: route })).status, 401, `${route}: no cookie`);
    assert.equal((await request({ path: route, headers: { host: `evil.example:${PORT}`, cookie: COOKIE } })).status, 403, `${route}: unknown Host`);
  }
  const after = fs.existsSync(path.join(relayDir, 'relay-admin.json')) ? fs.readFileSync(path.join(relayDir, 'relay-admin.json'), 'utf8') : null;
  assert.equal(after, before, 'no refused request made or changed the admin settings');
});

test('the relay routes are refused through the public name, even to a paired device (issue #237)', async () => {
  const { cookie } = await pairDevice('Relay phone');
  for (const route of RELAY_READS) assert.equal((await pub({ path: route, headers: { cookie } })).status, 403, route);
  for (const [route, body] of RELAY_CHANGES) {
    const res = await pubChange(route, body, cookie);
    assert.equal(res.status, 403, `${route}: ${res.body}`);
  }
});

test('the page never receives the relay admin key or the Cloudflare token (issue #237)', async () => {
  const page = await livePage();
  const withKey = { 'x-ledung-page': page.key };
  const token = 'cf-token-that-must-stay-here-0123456789';
  assert.equal((await change('/api/relay-admin', { relay: 'wss://relay.example.test', cloudflareToken: token }, withKey)).status, 200);
  const made = await change('/api/relay-admin-key', {}, withKey);
  assert.equal(made.status, 200, made.body);
  page.close();
  const saved = JSON.parse(fs.readFileSync(path.join(relayDir, 'relay-admin.json'), 'utf8'));
  assert.equal(saved.cloudflareToken, token, 'kept in the data folder');
  assert.ok(typeof saved.adminKey === 'string' && saved.adminKey.length >= 43, 'a 256-bit key');
  const keySha256 = crypto.createHash('sha256').update(saved.adminKey, 'utf8').digest('hex');
  const view = JSON.parse((await request({ path: '/api/relay-admin', headers: { cookie: COOKIE } })).body);
  assert.deepEqual(view, { relay: 'wss://relay.example.test', keySha256, tokenSet: true });
  const answers = [
    made.body,
    JSON.stringify(view),
    (await request({ path: '/api/state', headers: { cookie: COOKIE } })).body,
    JSON.stringify(await helloOf({ cookie: COOKIE, origin: ORIGIN })),
    (await request({ path: '/api/remote-link', headers: { cookie: COOKIE } })).body,
  ];
  for (const body of answers) {
    assert.equal(body.includes(token), false, 'no Cloudflare token');
    assert.equal(body.includes(saved.adminKey), false, 'no admin key');
  }
});

test('a relay set in the config file can\'t be joined over or left from the page (issue #237)', async () => {
  const page = await livePage();
  const withKey = { 'x-ledung-page': page.key };
  const join = await change('/api/remote-join', { code: 'relay.example.test/ABCD-ABCD-ABCD-ABCD-ABCD-ABCD-ABCD' }, withKey);
  assert.equal(join.status, 400);
  assert.match(errorOf(join), /config file/);
  const leave = await change('/api/remote-leave', {}, withKey);
  assert.equal(leave.status, 400);
  assert.match(errorOf(leave), /config file/);
  page.close();
  assert.deepEqual(JSON.parse((await request({ path: '/api/remote-link', headers: { cookie: COOKIE } })).body), { source: 'config', publicName: PUBLIC });
});

// Issue #263: a manager's Settings action runs on the user's own words only when they were given on this computer
// (Martin's b on question #447). The routes mark it; through the public name, unlocked, words still reach the
// manager but are not marked, so the action's prompt comes, signed on the phone.
test('typed words and answers to a manager are marked as given here only on this computer (#263)', async () => {
  const seen: { text: string; here: unknown }[] = [];
  type Spied = (...a: unknown[]) => Promise<unknown>;
  const s = sessions as unknown as { send: Spied; answerQuestion: Spied; messageManager: Spied; start: Spied };
  const { send, answerQuestion, messageManager, start } = s;
  s.send = async (_id, text, here) => { seen.push({ text: String(text), here }); };
  s.answerQuestion = async (_id, answer, here) => { seen.push({ text: String(answer), here }); return {}; };
  s.messageManager = async (_p, text, here) => { seen.push({ text: String(text), here }); return {}; };
  s.start = async (_p, text, opts) => { seen.push({ text: String(text), here: (opts as { here?: boolean }).here }); return {}; };
  const all = (pathFor: (c: string) => string) => [
    ['/api/sessions/m1/messages', { text: 'make an admin key' }],
    [`/api/questions/${managerQuestion}/answer`, { answer: 'Yes' }],
    ['/api/projects/p/manager', { text: 'invite Anna' }],
    ['/api/sessions', { project: 'p', role: 'manager', text: 'new link code' }],
  ].map(([p, body]) => [pathFor(p as string), body] as const);
  const expected = (here: boolean) => ['make an admin key', 'Yes', 'invite Anna', 'new link code'].map((text) => ({ text, here }));
  const d = await deviceWithPasskey('Words phone');
  const page = await livePage();
  try {
    for (const [p, body] of all((x) => x)) assert.equal((await change(p, body, { 'x-ledung-page': page.key })).status, 200, p);
    assert.deepEqual(seen.splice(0), expected(true), 'on this computer');
    assert.equal((await pubChange('/api/device-unlock', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/device-unlock', '{}') })).status, 200);
    for (const [p, body] of all((x) => x)) assert.equal((await pubChange(p, JSON.stringify(body), d.cookie, d.withKey)).status, 200, p);
    assert.deepEqual(seen, expected(false), 'through the public name');
  } finally {
    Object.assign(s, { send, answerQuestion, messageManager, start });
    page.close();
    d.page.close();
  }
});

test("a manager's Settings tools run the routes' own code and never hand the session the admin key (#263)", async () => {
  const m = (sessions as unknown as { management: { relayAdminKey(id: string): string; settingsStatus(id: string): string; linkCode(id: string): string } }).management;
  const made = m.relayAdminKey('m1');
  const saved = JSON.parse(fs.readFileSync(path.join(relayDir, 'relay-admin.json'), 'utf8'));
  const keySha256 = crypto.createHash('sha256').update(saved.adminKey, 'utf8').digest('hex');
  assert.ok(made.includes(keySha256), 'the hash, as Settings shows it');
  const status = m.settingsStatus('m1');
  for (const out of [made, status]) {
    assert.equal(out.includes(saved.adminKey), false, 'no admin key');
    if (saved.cloudflareToken) assert.equal(out.includes(saved.cloudflareToken), false, 'no Cloudflare token');
  }
  assert.equal(JSON.parse((await request({ path: '/api/relay-admin', headers: { cookie: COOKIE } })).body).keySha256, keySha256, "the page's Settings shows the same key");
  // Linking needs end to end, as the page's button does.
  assert.throws(() => m.linkCode('m1'), /end-to-end/);
});

test('shortcuts on this computer need the sign-in, and adding or removing them needs the open page (issue #415)', async () => {
  const app = path.join(shortcutDir, 'Applications', 'Ledung.app');
  assert.equal((await request({ path: '/api/shortcuts' })).status, 401);
  const view = await request({ path: '/api/shortcuts', headers: { cookie: COOKIE } });
  assert.equal(view.status, 200);
  assert.equal(JSON.parse(view.body).asked, false);
  const body = { action: 'add' };
  assert.equal((await request({ method: 'POST', path: '/api/shortcuts', headers: { cookie: COOKIE, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 403, 'no origin');
  // A script with the token file has the cookie and can send the Origin: it still can't write outside the data folder.
  const refused = await change('/api/shortcuts', body);
  assert.equal(refused.status, 403);
  assert.match(errorOf(refused), /open page/);
  assert.equal(fs.existsSync(app), false);
  const page = await livePage();
  try {
    const wrong = await change('/api/shortcuts', { action: 'anything' }, { 'x-ledung-page': page.key });
    assert.equal(wrong.status, 400);
    assert.match(errorOf(wrong), /add, remove or decline/);
    const added = await change('/api/shortcuts', body, { 'x-ledung-page': page.key });
    assert.equal(added.status, 200, added.body);
    assert.ok(fs.existsSync(path.join(app, 'Contents', 'Info.plist')));
    assert.equal(JSON.parse(added.body).asked, true);
    const removed = await change('/api/shortcuts', { action: 'remove' }, { 'x-ledung-page': page.key });
    assert.equal(removed.status, 200, removed.body);
    assert.equal(fs.existsSync(app), false);
  } finally {
    page.close();
  }
});

test('shortcuts are made only on this computer: a paired device, unlocked and signing, is refused (issue #415)', async () => {
  const d = await deviceWithPasskey('Shortcut phone');
  try {
    assert.equal((await pubChange('/api/device-unlock', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/device-unlock', '{}') })).status, 200);
    const here = /Shortcuts are made in Settings on the computer Ledung runs on/;
    const view = await pub({ path: '/api/shortcuts', headers: { cookie: d.cookie } });
    assert.equal(view.status, 403, view.body);
    assert.match(errorOf(view), here);
    const body = JSON.stringify({ action: 'add' });
    const res = await pubChange('/api/shortcuts', body, d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/shortcuts', body) });
    assert.equal(res.status, 403, res.body);
    assert.match(errorOf(res), here);
    assert.equal(fs.existsSync(path.join(shortcutDir, 'Applications', 'Ledung.app')), false);
  } finally {
    d.page.close();
  }
});

/** One of this computer's own network addresses (IPv4, not loopback), or null when it has none. */
function networkAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

function requestAt(address: string, port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: address, port, method: opts.method ?? 'GET', path: opts.path, headers: { host: `${address}:${port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

// "lan" and "lanSignIn" let a browser on another computer sign in and open a page of its own; it still must not write
// Ledung.lnk or Ledung.app on this computer (test review of PR #432, finding 1).
test('shortcuts are made only on this computer: a signed-in page on the local network is refused (issue #415)', async (t) => {
  const ip = networkAddress();
  if (!ip) return t.skip('this computer has no network address to come from');
  const lanPort = await freePort();
  const lan = new LedungServer({ port: lanPort, token: TOKEN, store: paneStore, manager: sessions, webRoot, shortcuts, lanBind: ip, lanNames: [ip] });
  await lan.listen();
  try {
    const here = /Shortcuts are made in Settings on the computer Ledung runs on/;
    // The same server from this computer: the guard lets it through (and the POST then wants the open page).
    const local = await requestAt('127.0.0.1', lanPort, { path: '/api/shortcuts', headers: { cookie: COOKIE } });
    assert.equal(local.status, 200, local.body);
    const body = JSON.stringify({ action: 'add' });
    const post = (address: string) => requestAt(address, lanPort, { method: 'POST', path: '/api/shortcuts', headers: { cookie: COOKIE, origin: `http://${address}:${lanPort}`, 'content-type': 'application/json' }, body });
    const localPost = await post('127.0.0.1');
    assert.equal(localPost.status, 403, localPost.body);
    assert.match(errorOf(localPost), /open page/);
    // From this computer's network address, as another computer on the network would come.
    const view = await requestAt(ip, lanPort, { path: '/api/shortcuts', headers: { cookie: COOKIE } });
    assert.equal(view.status, 403, view.body);
    assert.match(errorOf(view), here);
    const res = await post(ip);
    assert.equal(res.status, 403, res.body);
    assert.match(errorOf(res), here);
    assert.equal((await requestAt(ip, lanPort, { path: `/running?nonce=${'0'.repeat(32)}` })).status, 404, 'the open-or-start check answers only this computer');
    assert.equal(fs.existsSync(path.join(shortcutDir, 'Applications', 'Ledung.app')), false);
  } finally {
    await lan.close();
  }
});

// The launchers' open-or-start check (review of PR #432, Important 1): Ledung proves it holds the token for the
// launcher's nonce, so the launcher never sends the token to another program on the port.
test('/running answers the proof of the token without the token, and only on this computer (issue #415)', async () => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const res = await request({ path: `/running?nonce=${nonce}` });
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).proof, crypto.createHmac('sha256', TOKEN).update(`ledung-running:${nonce}`).digest('hex'));
  assert.ok(!res.body.includes(TOKEN) && !JSON.stringify(res.headers).includes(TOKEN), 'no token in the answer');
  assert.equal((await request({ path: '/running?nonce=short' })).status, 400);
  assert.equal((await request({ path: '/running' })).status, 400);
  assert.equal((await request({ method: 'POST', path: `/running?nonce=${nonce}`, headers: { origin: ORIGIN } })).status, 405);
  assert.equal((await pub({ path: `/running?nonce=${nonce}` })).status, 404, 'through the public name');
});
