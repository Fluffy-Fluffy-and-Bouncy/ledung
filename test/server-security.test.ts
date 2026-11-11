// The page and API must refuse anyone but Simon's own browser (issue #4).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
import { stopRunning } from '../src/platform/background.ts';
import { WAIT_MS } from './limits.ts';
import { Secrets } from '../src/secrets/secrets.ts';
import { runCappedBytes } from '../src/sessions/git-read.ts';
import { containerFailure } from '../src/sessions/container-files.ts';
import { ChatImages, MAX_CHAT_IMAGE_BYTES } from '../src/sessions/chat-images.ts';

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
// This run's own temp folder, holding projectRoot and the files "outside the project" next to it, so two runs at once never share
// them and one run's cleanup can't delete another's (issue #137).
let runRoot: string;
let projectRoot: string;
// The board cache (board attachments) and the manager, for the board attachment route.
let boardCache: string;
let chatImagesDir: string;
let sessions: SessionManager;
const questionAbout: Record<string, number> = {};
let refusalQuestion = 0;
let keepQuestion = 0;
/** Ledung's question to confirm a proposed order, and a manager's question carrying an order's exact command (#105). */
let confirmQuestion = 0;
let orderCommandQuestion = 0;
let managerQuestion = 0;
let paneStore: Store;
/** The folders Settings' Open folder was asked to show (issue #414); nothing is opened for real. */
const openedFolders: string[] = [];
/** When set, Open folder fails with these words (issue #83). */
let openFolderFails: string | null = null;
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
  runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-security-'));
  projectRoot = fs.mkdtempSync(path.join(runRoot, 'ledung-proj-'));
  fs.writeFileSync(path.join(projectRoot, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  fs.writeFileSync(path.join(projectRoot, 'a.svg'), '<svg/>');
  fs.writeFileSync(path.join(path.dirname(projectRoot), 'ledung-secret.png'), 'x');
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port: PORT, projects: [{ name: 'p', runner: 'local', path: projectRoot }], board: { repo: 'org/board' }, browseRoots: [os.homedir(), os.tmpdir()] }) /* the temp folder is outside the home on macOS and Linux (#233) */, store, () => {}));
  // Images sent with messages (issue #128), in a temp folder, never the real data folder.
  chatImagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-chat-images-'));
  manager.attachChatImages(new ChatImages(chatImagesDir));
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
  // A call the auto mode classifier refused, and Ledung's question about it, no longer open (issue #104).
  const rq = store.createQuestion({ sessionId: 's1', question: 'refused', options: ['Allow once', 'Deny'], addressedTo: 'user', details: { refusal: { toolName: 'Bash', input: { command: 'x' }, reason: 'r', toolUseId: 't' } } });
  store.withdrawQuestion(rq.id, 'test');
  refusalQuestion = rq.id;
  // An order's keep-it question at the end of away, no longer open (issue #105): Keep puts the order back in force.
  const kq = store.createQuestion({ sessionId: 's1', question: 'keep?', options: ['Keep it', 'Drop it'], addressedTo: 'user', details: { order: { orderId: 1 } } });
  store.withdrawQuestion(kq.id, 'test');
  keepQuestion = kq.id;
  // A proposed order's confirm question, and an ask_user question carrying an order's exact command (Ledung question
  // #1290 "a"): either answer puts an order in force.
  const cq = store.createQuestion({ sessionId: 's1', question: 'confirm?', options: ['Confirm order', 'Cancel order'], addressedTo: 'user', details: { order: { orderId: 2, confirm: true } } });
  store.withdrawQuestion(cq.id, 'test');
  confirmQuestion = cq.id;
  const oq = store.createQuestion({ sessionId: 's1', question: 'deploy?', options: ['Yes', 'No'], addressedTo: 'user', details: { orderCommand: { command: 'scripts/deploy.sh', match: 'exact', confirm: 'Yes' } } });
  store.withdrawQuestion(oq.id, 'test');
  orderCommandQuestion = oq.id;
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
  server = new LedungServer({ port: PORT, token: TOKEN, store, manager, webRoot, updater, publicName: PUBLIC, relayAdmin, shortcuts, now: () => Date.now() + clockShift, openFolder: async (f) => {
    openedFolders.push(f);
    if (openFolderFails) throw new Error(openFolderFails);
  } });
  server.attachRemote(new RemoteLink({ server, dir: relayDir, configured: { relay: 'wss://relay.example.test', name: 'pc', publicName: PUBLIC, secret: 's', tls: 'optional' }, fetch: offline, log: () => {} }));
  await server.listen();
});

after(async () => {
  await server.close();
  removeTemp(webRoot);
  removeTemp(relayDir);
  removeTemp(shortcutDir);
  removeTemp(runRoot);
  removeTemp(chatImagesDir);
});

function request(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }) {
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
  // A sign-in of its own, never the install token (Project-Ledung#476).
  const set = String(right.headers['set-cookie']);
  assert.match(set, /^ledung_auth=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000$/);
  assert.ok(!set.includes(TOKEN), 'the install token never goes out in a cookie');
  const cookie = set.split(';')[0]!;
  assert.equal((await request({ path: '/api/state', headers: { cookie } })).status, 200, 'the sign-in cookie signs in');
  // Each sign-in link opened gives a different sign-in.
  const again = String((await request({ path: `/login?token=${TOKEN}` })).headers['set-cookie']).split(';')[0]!;
  assert.notEqual(again, cookie);
  assert.equal((await request({ path: '/api/state', headers: { cookie: again } })).status, 200);
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

test("the sidebar menu's Change model needs the sign-in and Ledung's own origin, and takes only the offered models", async () => {
  const p = '/api/sessions/s2/model';
  const body = JSON.stringify({ model: 'opus' });
  assert.equal((await request({ method: 'POST', path: p, body })).status, 401);
  assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE }, body })).status, 403);
  assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: 'https://evil.example' }, body })).status, 403);
  assert.equal((await change(p, {})).status, 400, 'no model named is no choice, not a reset');
  assert.equal((await change(p, { model: 'claude-anything' })).status, 400);
  const ok = await change(p, { model: 'opus' });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).requestedModel, 'opus');
  assert.equal(JSON.parse((await change(p, { model: null })).body).requestedModel, null, "the project's default again, for the other tests");
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

test('images for a message (issue #128): uploaded with the sign-in and Ledung\'s own origin, PNG, JPEG, GIF or WebP only, within the size', async () => {
  const png = fs.readFileSync(path.join(projectRoot, 'a.png'));
  const upload = (headers: Record<string, string>, body: Buffer = png) =>
    request({ method: 'POST', path: '/api/sessions/s1/images', headers: { 'content-length': String(body.length), ...headers }, body });
  const good = { cookie: COOKIE, origin: ORIGIN, 'content-type': 'image/png' };
  assert.equal((await upload({ origin: ORIGIN, 'content-type': 'image/png' })).status, 401);
  assert.equal((await upload({ cookie: COOKIE, 'content-type': 'image/png' })).status, 403, 'no Origin');
  assert.equal((await upload({ ...good, origin: 'http://evil.example' })).status, 403, 'another origin');
  assert.equal((await upload({ ...good, host: 'evil.example:80' })).status, 403, 'another host');
  // SVG is refused by its type and by its bytes; so is anything that isn't one of the four.
  assert.equal((await upload({ ...good, 'content-type': 'image/svg+xml' }, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status, 415);
  assert.equal((await upload({ ...good, 'content-type': 'text/html' }, Buffer.from('<html></html>'))).status, 415);
  const svgAsPng = await upload(good, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  assert.equal(svgAsPng.status, 400);
  assert.match(JSON.parse(svgAsPng.body).error, /PNG, JPEG, GIF and WebP/);
  assert.equal((await upload(good, Buffer.alloc(0))).status, 400, 'empty');
  // Too large: refused by its declared length before it is read, and by what arrives.
  const big = Buffer.concat([png, Buffer.alloc(MAX_CHAT_IMAGE_BYTES)]);
  assert.equal((await upload(good, big)).status, 413);
  // With no length given (chunked), what arrives is counted.
  const chunked = await request({ method: 'POST', path: '/api/sessions/s1/images', headers: good, body: big }).catch((e: Error) => ({ status: 0, error: e.message }));
  assert.ok(chunked.status === 413 || chunked.status === 0, `refused while it arrives: ${JSON.stringify(chunked).slice(0, 200)}`);
  const kept = path.join(chatImagesDir, 's1');
  assert.equal(fs.existsSync(kept) ? fs.readdirSync(kept).length : 0, 0, 'nothing kept of what was refused');
  assert.throws(() => new ChatImages(chatImagesDir).save('s1', big), /too large/);
  assert.equal((await request({ method: 'POST', path: '/api/sessions/nope/images', headers: good, body: png })).status, 400, 'no such session');

  const ok = await upload(good);
  assert.equal(ok.status, 200);
  const { id } = JSON.parse(ok.body) as { id: string };
  assert.match(id, /^[0-9a-f]{32}\.png$/);
  // Served only to a signed-in page on this host, as an image that is never sniffed as anything else.
  const url = `/api/sessions/s1/sent-images/${id}`;
  assert.equal((await request({ path: url })).status, 401);
  assert.equal((await request({ path: url, headers: { host: 'evil.example:80', cookie: COOKIE } })).status, 403);
  const shown = await request({ path: url, headers: { cookie: COOKIE } });
  assert.equal(shown.status, 200);
  assert.equal(shown.headers['content-type'], 'image/png');
  assert.equal(shown.headers['x-content-type-options'], 'nosniff');
  // Only Ledung's own names, and only of that session: never a path.
  for (const bad of [encodeURIComponent('../s1/' + id), encodeURIComponent('..\\x.png'), 'a.svg', '0'.repeat(32) + '.png', '0'.repeat(32) + '.svg']) {
    const res = await request({ path: `/api/sessions/s1/sent-images/${bad}`, headers: { cookie: COOKIE } });
    assert.equal(res.status, 400, bad);
    assert.match(res.headers['content-type'] ?? '', /json/);
  }
  assert.equal((await request({ path: `/api/sessions/s2/sent-images/${id}`, headers: { cookie: COOKIE } })).status, 400, 'another session');
  // ".." as the session is taken out by the URL itself, which leaves no such route.
  assert.equal((await request({ path: `/api/sessions/%2e%2e/sent-images/${id}`, headers: { cookie: COOKIE } })).status, 404);
  assert.equal((await request({ path: `/api/sessions/${encodeURIComponent('s1/..')}/sent-images/${id}`, headers: { cookie: COOKIE } })).status, 400);
  // A message names only this session's images, and no more than ten.
  const send = (images: unknown) => request({ method: 'POST', path: '/api/sessions/s2/messages', headers: { cookie: COOKIE, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi', images }) });
  assert.equal((await send([id])).status, 400, "s1's image named in s2");
  assert.equal((await send(['../../ledung.db'])).status, 400);
  assert.equal((await send('x')).status, 400);
  assert.equal((await send(Array(11).fill(id))).status, 400);
  // A manager's images need the open page, like its messages (#104 review, finding F1).
  assert.equal((await request({ method: 'POST', path: '/api/sessions/m1/images', headers: good, body: png })).status, 403);
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

/** Sends a request head as written, so no client tidies its path first; resolves with the reply's status line, empty
 * when no reply came within two seconds. */
function rawRequest(head: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let reply = '';
    const socket = net.connect(PORT, '127.0.0.1', () => socket.write(head));
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('data', (c) => (reply += c));
    socket.on('close', () => resolve(reply.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

// Paths `new URL` can't parse against Ledung's address (Project-Ledung#467).
const BAD_PATHS = ['//..%2f.env', '//[', '//%'];

test("a request path that doesn't parse is refused with a 400 before any other check, and logs nothing (Project-Ledung#467)", async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  for (const bad of BAD_PATHS) {
    for (const headers of [`Host: 127.0.0.1:${PORT}\r\nCookie: ${COOKIE}`, 'Host: evil.example:80']) {
      assert.match(await rawRequest(`GET ${bad} HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 400 /, `${bad} with ${headers}`);
    }
  }
  assert.equal(logged.mock.callCount(), 0);
  assert.equal((await request({ path: '/api/state', headers: { cookie: COOKIE } })).status, 200);
});

test("a live-connection request whose path doesn't parse is refused, and Ledung keeps serving (Project-Ledung#467)", async () => {
  const upgrade = 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==';
  for (const bad of BAD_PATHS) {
    for (const headers of [`Host: 127.0.0.1:${PORT}\r\nCookie: ${COOKIE}\r\nOrigin: ${ORIGIN}`, 'Host: evil.example:80']) {
      assert.match(await rawRequest(`GET ${bad} HTTP/1.1\r\n${headers}\r\n${upgrade}\r\n\r\n`), /^HTTP\/1\.1 400 /, `${bad} with ${headers}`);
    }
  }
  assert.equal((await request({ path: '/api/state', headers: { cookie: COOKIE } })).status, 200);
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

test("choosing the update channel needs the sign-in and Ledung's own origin, and takes only public or dev (#461)", async () => {
  const p = '/api/update-channel';
  const body = JSON.stringify({ channel: 'dev' });
  assert.equal((await request({ method: 'POST', path: p, body })).status, 401);
  assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE }, body })).status, 403);
  assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: 'https://evil.example' }, body })).status, 403);
  const json = { cookie: COOKIE, origin: ORIGIN, 'content-type': 'application/json' };
  const bad = await request({ method: 'POST', path: p, headers: json, body: JSON.stringify({ channel: 'latest' }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body, /public or dev/);
  // Past the guard; the channel itself is then the updater's to keep.
  assert.ok(![401, 403].includes((await request({ method: 'POST', path: p, headers: json, body })).status));
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

// Project-Ledung#476: the sign-in cookie is a sign-in of its own, kept here only as a hash, and revocable.
test('sign-ins are random, kept as hashes, last through a restart, end when revoked or unused for a year', async () => {
  const { Guard, MAX_SIGN_INS } = await import('../src/server/security.ts');
  const held = { saved: null as string | null };
  const store = { get: () => held.saved, set: (v: string) => { held.saved = v; } };
  let now = 1_000_000;
  const req = (cookie?: string) => ({ headers: { host: '127.0.0.1:4317', cookie } }) as any;
  const guard = new Guard(TOKEN, 4317, [], false, null, () => now);
  guard.useSignInStore(store);
  const set = guard.signInCookie();
  const value = /^ledung_auth=([0-9a-f]{64});/.exec(set)![1]!;
  assert.notEqual(value, TOKEN);
  assert.equal(guard.signedIn(req(`ledung_auth=${value}`)), true);
  assert.equal(guard.signedIn(req(`ledung_auth=${'c'.repeat(64)}`)), false, 'a made-up value is no sign-in');
  assert.equal(guard.signedIn(req()), false);
  // Kept as a hash: the store never holds the cookie's value.
  assert.ok(held.saved && !held.saved.includes(value), 'only the hash is stored');
  assert.ok(held.saved.includes(crypto.createHash('sha256').update(value).digest('hex')));
  // A restart: a new guard on the same store still knows it.
  const restarted = new Guard(TOKEN, 4317, [], false, null, () => now);
  restarted.useSignInStore(store);
  assert.equal(restarted.signedIn(req(`ledung_auth=${value}`)), true);
  // Revoked: that one ends, another stays; then every one.
  const other = /^ledung_auth=([0-9a-f]{64});/.exec(restarted.signInCookie())![1]!;
  assert.equal(restarted.revokeSignIns(value), 1);
  assert.equal(restarted.signedIn(req(`ledung_auth=${value}`)), false);
  assert.equal(restarted.signedIn(req(`ledung_auth=${other}`)), true);
  assert.equal(restarted.revokeSignIns(), 1);
  assert.equal(restarted.signedIn(req(`ledung_auth=${other}`)), false);
  // Unused for over a year (the cookie's own Max-Age): it ends; used within it, it stays.
  const kept = /^ledung_auth=([0-9a-f]{64});/.exec(restarted.signInCookie())![1]!;
  const idle = /^ledung_auth=([0-9a-f]{64});/.exec(restarted.signInCookie())![1]!;
  now += 200 * 86_400_000;
  assert.equal(restarted.signedIn(req(`ledung_auth=${kept}`)), true);
  now += 200 * 86_400_000;
  assert.equal(restarted.signedIn(req(`ledung_auth=${kept}`)), true, 'used 200 days ago: still live');
  assert.equal(restarted.signedIn(req(`ledung_auth=${idle}`)), false, 'unused for 400 days: ended');
  // At most MAX_SIGN_INS are kept; the least recently used goes first.
  for (let i = 0; i < MAX_SIGN_INS; i++) { now += 1; restarted.signInCookie(); }
  assert.equal(restarted.signInCount(), MAX_SIGN_INS);
  assert.equal(restarted.signedIn(req(`ledung_auth=${kept}`)), false, 'the oldest went');
  // The install token's cookie never counts through the public name, nor does a sign-in.
  const pub = new Guard(TOKEN, 4317, [], false, { publicName: PUBLIC, device: () => null }, () => now);
  const pubValue = /^ledung_auth=([0-9a-f]{64});/.exec(pub.signInCookie())![1]!;
  const viaPublic = (cookie: string) => ({ headers: { host: PUBLIC, cookie } }) as any;
  assert.equal(pub.signedIn(viaPublic(`ledung_auth=${pubValue}`)), false);
  assert.equal(pub.signedIn(viaPublic(COOKIE)), false);
  assert.equal(pub.signedIn(req(`ledung_auth=${pubValue}`)), true, 'the same sign-in counts locally');
});

test('a browser still holding the old token cookie stays signed in, and a page load swaps it for a sign-in', async () => {
  const page = await request({ path: '/', headers: { cookie: COOKIE } });
  assert.equal(page.status, 200);
  const set = String(page.headers['set-cookie']);
  assert.match(set, /^ledung_auth=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000$/, 'the same name and path, so it replaces the old one');
  assert.ok(!set.includes(TOKEN), 'the swap never sends the token back');
  const cookie = set.split(';')[0]!;
  assert.equal((await request({ path: '/api/state', headers: { cookie } })).status, 200);
  // A page load with the new sign-in gets no further cookie; the swap is for the old cookie only.
  const next = await request({ path: '/', headers: { cookie } });
  assert.equal(next.status, 200);
  assert.equal(next.headers['set-cookie'], undefined);
  // An API call with the old cookie (a script, the launcher's stop) still works and is not handed sign-ins to pile up.
  const api = await request({ path: '/api/state', headers: { cookie: COOKIE } });
  assert.equal(api.status, 200);
  assert.equal(api.headers['set-cookie'], undefined);
  // Nothing swaps without a cookie that is the token.
  const none = await request({ path: '/', headers: { cookie: `ledung_auth=${'b'.repeat(64)}` } });
  assert.equal(none.status, 401);
  assert.equal(none.headers['set-cookie'], undefined);
});

test('API reads that do work need Ledung\'s own page; plain reads are unchanged (one route per kind)', async () => {
  const { PLAIN_READS } = await import('../src/server/server.ts');
  // One route per kind of work: GitHub, docker, claude, git or files through the session's runner, the relay.
  const work = {
    github: '/api/board-owners', docker: '/api/containers', claude: '/api/claude-code',
    runner: '/api/sessions/s1/tree', relay: '/api/relay-computers',
  };
  const elsewhere: Record<string, string>[] = [
    { origin: 'http://127.0.0.1:1' }, // another port of this computer
    { origin: 'https://evil.example' },
    { 'sec-fetch-site': 'same-site' }, // another port: the same site to a browser, so SameSite lets it through
    { 'sec-fetch-site': 'cross-site' },
    { origin: ORIGIN, 'sec-fetch-site': 'same-site' }, // both are asked
  ];
  for (const [kind, p] of Object.entries(work)) {
    for (const h of elsewhere) {
      const res = await request({ path: p, headers: { cookie: COOKIE, ...h } });
      assert.equal(res.status, 403, `${kind} ${p} with ${JSON.stringify(h)}`);
      assert.match(res.body, /Ledung's own page/);
    }
  }
  // The positive branch on the same check: Ledung's own page, the address bar, and a client that is no browser pass it.
  for (const h of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }, {}] as Record<string, string>[]) {
    assert.equal((await request({ path: work.github, headers: { cookie: COOKIE, ...h } })).status, 200, `github with ${JSON.stringify(h)}`);
    assert.equal((await request({ path: work.runner, headers: { cookie: COOKIE, ...h } })).status, 200, `runner with ${JSON.stringify(h)}`);
  }
  // Still the sign-in first: a request from the page without one is not signed in.
  assert.equal((await request({ path: work.github, headers: { 'sec-fetch-site': 'same-origin' } })).status, 401);
  // Plain reads answer as before, whoever asks (a browser shows another site nothing: no CORS header).
  for (const p of ['/api/state', '/api/projects', '/api/board-threads']) {
    for (const h of elsewhere) {
      const res = await request({ path: p, headers: { cookie: COOKIE, ...h } });
      assert.equal(res.status, 200, `${p} with ${JSON.stringify(h)}`);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    }
  }
  // Every work route above is outside the plain reads, and the kinds named in the issue stay so.
  for (const route of ['GET board-owners', 'GET board-projects/:id/people', 'GET board-projects/:id/repos', 'GET usage-publish-repos', 'GET usage-shared',
    'GET containers', 'GET browse-container', 'GET skills', 'GET workflows', 'GET claude-code', 'GET sessions/:id/mcp', 'GET sessions/:id/changes',
    'GET sessions/:id/tree', 'GET sessions/:id/file', 'GET sessions/:id/image', 'GET relay-computers', 'GET relay-owners', 'GET shortcuts']) {
    assert.equal(PLAIN_READS.has(route), false, `${route} does work`);
  }
});

test('every plain read names a GET route the server has', async () => {
  const { PLAIN_READS } = await import('../src/server/server.ts');
  const source = fs.readFileSync(path.join(appDir(), 'src', 'server', 'server.ts'), 'utf8');
  const cases = new Set([...source.matchAll(/case '(GET [^']+)'/g)].map((m) => m[1]!));
  // The three image routes are answered before the switch; their keys are the ones apiRoute gives.
  for (const route of ['GET sessions/:id/image', 'GET sessions/:id/sent-images/:id', 'GET board-attachment']) cases.add(route);
  assert.ok(cases.size > 40, 'the GET routes were found');
  for (const route of PLAIN_READS) assert.ok(cases.has(route), `${route} is a route`);
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
  // The close reaches the server when it does (#463: a fixed 200 ms was a speed check): asked until the key is gone.
  let after = 0;
  for (const end = Date.now() + WAIT_MS; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    if ((after = (await change('/api/permissions/perm-sensitive', allow, { 'x-ledung-page': page.key })).status) !== 400) break;
  }
  assert.equal(after, 403, 'the key dies with its connection');
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

test("answering Ledung's question about a refused call, whose Allow once lets the call through, needs the live page (issue #104)", async () => {
  const answer = { answer: 'Allow once' };
  assert.equal((await change(`/api/questions/${refusalQuestion}/answer`, answer)).status, 403);
  // Another question of the same ordinary session needs only the cookie, as before.
  const plain = await change(`/api/questions/${questionAbout['perm-plain']}/answer`, answer);
  assert.equal(plain.status, 400);
  assert.match(errorOf(plain), /no longer open/);
  const page = await livePage();
  const passed = await change(`/api/questions/${refusalQuestion}/answer`, answer, { 'x-ledung-page': page.key });
  page.close();
  assert.equal(passed.status, 400);
  assert.match(errorOf(passed), /no longer open/);
});

test("answering an order's keep-it question, whose Keep puts the order back in force, needs the live page (issue #105)", async () => {
  const answer = { answer: 'Keep it' };
  assert.equal((await change(`/api/questions/${keepQuestion}/answer`, answer)).status, 403);
  // So do a proposed order's confirm and a question that carries an order's exact command (Ledung question #1290 "a").
  assert.equal((await change(`/api/questions/${confirmQuestion}/answer`, { answer: 'Confirm order' })).status, 403);
  assert.equal((await change(`/api/questions/${orderCommandQuestion}/answer`, { answer: 'Yes' })).status, 403);
  // Another question of the same ordinary session needs only the cookie, as before.
  const plain = await change(`/api/questions/${questionAbout['perm-plain']}/answer`, answer);
  assert.equal(plain.status, 400);
  assert.match(errorOf(plain), /no longer open/);
  const page = await livePage();
  const passed = await change(`/api/questions/${keepQuestion}/answer`, answer, { 'x-ledung-page': page.key });
  page.close();
  assert.equal(passed.status, 400);
  assert.match(errorOf(passed), /no longer open/);
});

test('cancelling an order only takes a permission away: the cookie and the origin, as every change (issue #105)', async () => {
  const noCookie = await request({ method: 'POST', path: '/api/orders/999/cancel', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noCookie.status, 401);
  const unknown = await change('/api/orders/999/cancel', {});
  assert.equal(unknown.status, 400);
  assert.match(errorOf(unknown), /no order #999/);
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
  // Part 3f: the command Ledung runs in each new worktree (final review of part 3, finding 1).
  ['a worktree setup command', '/api/projects/p', plainSettings({ worktreeSetup: 'npm ci' })],
  ["a new project's worktree setup command", '/api/projects', { name: 'q', runner: 'local', path: path.join(projectRoot, 'nope'), worktreeSetup: 'npm ci' }],
  ["a created project's worktree setup command", '/api/projects-new', { parent: projectRoot, github: false, settings: { name: 'p', worktreeSetup: 'npm ci' } }],
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

// Files from a manager on a linked computer (issue #158): the page shows a copy only through the session it was sent to,
// with the sign-in and this host, read-only; another session's handle, a path or a made-up handle is refused.
test('ledung#158: a file from a linked computer is shown only through the manager it was sent to, by its handle, never by a path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-linked-files-security-'));
  try {
    sessions.linkedFilesDir = () => dir;
    const png = fs.readFileSync(path.join(projectRoot, 'a.png'));
    const sha = crypto.createHash('sha256').update(png).digest('hex');
    const id = sessions.linkedFiles.receive('link-1', { to: 'm1', name: 'shot.png', kind: 'png', size: png.length, sha }, png);
    const [file] = sessions.linkedFiles.claim('link-1', 'm1', [id]);
    const url = (session: string, p: string) => `/api/sessions/${session}/image?path=${encodeURIComponent(p)}`;
    const good = url('m1', file!.handle);
    assert.equal((await request({ path: good })).status, 401);
    assert.equal((await request({ path: good, headers: { host: 'evil.example:80', cookie: COOKIE } })).status, 403);
    const ok = await request({ path: good, headers: { cookie: COOKIE } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'image/png');
    assert.equal(ok.body, png.toString());
    for (const [session, bad] of [
      ['s1', file!.handle], ['m1', 'linked:../../link-1/x.png'], ['m1', `linked:${id}`], ['m1', path.join(dir, 'link-1', `${id}.png`)], ['m1', `linked:${'0'.repeat(16)}/shot.png`],
    ] as const) {
      const res = await request({ path: url(session, bad), headers: { cookie: COOKIE } });
      assert.equal(res.status, 400, `${session} ${bad}`);
    }
    // ask_user's screenshots take it from that manager only (the same wiring as the board's, above).
    const shot = (sid: string, f: string) => (sessions as unknown as { management: { screenshots(id: string, s: { file: string; look_for: string }[], q: null): { path: string }[] } })
      .management.screenshots(sid, [{ file: f, look_for: 'x' }], null);
    assert.equal(shot('m1', file!.handle)[0]!.path, file!.handle);
    assert.throws(() => shot('s1', file!.handle), /no file shot\.png from a linked computer/);
    const post = await request({ method: 'POST', path: good, headers: { cookie: COOKIE, origin: ORIGIN } });
    assert.notEqual(post.status, 200);
  } finally {
    removeTemp(dir);
  }
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
const pub = (opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }) =>
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
    // The file manager couldn't be started: the page is told why and where, not ok (issue #83).
    openFolderFails = 'No application knows how to open it';
    const failed = await change(p, {}, { 'x-ledung-page': page.key });
    openFolderFails = null;
    assert.equal(failed.status, 400, failed.body);
    assert.equal(errorOf(failed), `Couldn't open ${folder}: No application knows how to open it`);
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
  // New chat's account (issue #119): a name it knows, refused before anything starts; never a token in the answer.
  const unknown = await change('/api/chats-new', { account: 'no-such-account' });
  assert.equal(unknown.status, 400);
  assert.match(errorOf(unknown), /no account named "no-such-account"/);
  assert.match(errorOf(await change('/api/chats-new', { account: { token: 'x' } })), /chosen by its name/);
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

test('through the public name an image for a message needs the device unlocked, like any change (issue #128)', async () => {
  const d = await deviceWithPasskey();
  const png = fs.readFileSync(path.join(projectRoot, 'a.png'));
  const upload = () => pub({ method: 'POST', path: '/api/sessions/s1/images', headers: { cookie: d.cookie, origin: PUBLIC_ORIGIN, 'content-type': 'image/png', ...d.withKey }, body: png });
  try {
    assert.match(errorOf(await upload()), /locked/);
    assert.equal((await pubChange('/api/device-unlock', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/device-unlock', '{}') })).status, 200);
    assert.equal((await upload()).status, 200);
  } finally {
    d.page.close();
  }
});

// Locked secrets (issue #468): a value goes into a session's commands, so locking one (and changing where it
// reaches) has the "!" command's rules; the list is a read and never carries a value; removing is a plain change.
test('locking a secret needs the sign-in, this host, Ledung\'s own origin and the live page; nothing that comes back holds the value', async () => {
  sessions.attachSecrets(Secrets.memory(), path.join(os.tmpdir(), 'ledung-secrets-security-test'));
  const lock = '/api/sessions/s1/secrets';
  const value = 'hunter2-security-test';
  const body = { name: 'db-password', value, lifetime: 'session' };
  const json = { 'content-type': 'application/json' };
  assert.equal((await request({ method: 'POST', path: lock, headers: { cookie: COOKIE, origin: ORIGIN, host: 'evil.example', ...json }, body: JSON.stringify(body) })).status, 403, 'another host');
  assert.equal((await request({ method: 'POST', path: lock, headers: { origin: ORIGIN, ...json }, body: JSON.stringify(body) })).status, 401, 'no sign-in');
  assert.equal((await request({ method: 'POST', path: lock, headers: { cookie: COOKIE, origin: 'http://evil.example', ...json }, body: JSON.stringify(body) })).status, 403, 'another origin');
  const noPage = await change(lock, body);
  assert.equal(noPage.status, 403, 'the cookie alone: a script that read the token locks nothing into a session');
  assert.match(errorOf(noPage), /open page/);
  assert.equal((await change(lock, body, { 'x-ledung-page': 'b'.repeat(64) })).status, 403, 'a made-up key');
  const page = await livePage();
  try {
    const locked = await change(lock, body, { 'x-ledung-page': page.key });
    assert.equal(locked.status, 200, locked.body);
    assert.ok(!locked.body.includes(value));
    const id = JSON.parse(locked.body).id as string;
    // Renaming or a new lifetime: the same rules.
    assert.equal((await change('/api/sessions/s1/secret-edit', { secret: id, lifetime: 'project' })).status, 403, 'edit: the cookie alone');
    assert.equal((await change('/api/sessions/s1/secret-edit', { secret: id, name: 'db-pass' }, { 'x-ledung-page': page.key })).status, 200);
    // The list: the sign-in and this host, and no value.
    assert.equal((await request({ path: lock })).status, 401);
    assert.equal((await request({ path: lock, headers: { cookie: COOKIE, host: 'evil.example' } })).status, 403);
    const list = await request({ path: lock, headers: { cookie: COOKIE } });
    assert.equal(list.status, 200);
    assert.deepEqual(JSON.parse(list.body).map((s: { name: string }) => s.name), ['db-pass']);
    assert.ok(!list.body.includes(value));
    // Removing is always safe: the sign-in and the origin.
    const remove = '/api/sessions/s1/secret-remove';
    assert.equal((await request({ method: 'POST', path: remove, headers: { origin: ORIGIN, ...json }, body: JSON.stringify({ secret: id }) })).status, 401, 'remove: no sign-in');
    assert.equal((await request({ method: 'POST', path: remove, headers: { cookie: COOKIE, origin: 'http://evil.example', ...json }, body: JSON.stringify({ secret: id }) })).status, 403, 'remove: another origin');
    assert.equal((await change(remove, { secret: id })).status, 200);
    assert.equal(JSON.parse((await request({ path: lock, headers: { cookie: COOKIE } })).body).length, 0);
  } finally {
    page.close();
  }
});

test('through the public name each secret is locked with the passkey, for exactly that value, and a locked device is refused', async () => {
  const d = await deviceWithPasskey('Secrets phone');
  const lock = '/api/sessions/nope/secrets';
  const body = JSON.stringify({ name: 'pw', value: 'from-the-phone-1', lifetime: 'once' });
  try {
    assert.match(errorOf(await pubChange(lock, body, d.cookie, d.withKey)), /locked/, 'locked');
    assert.match(errorOf(await pubChange(lock, body, d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign(lock, body) })), /locked/, 'locked, even with a signature');
    assert.equal((await pubChange('/api/device-unlock', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/device-unlock', '{}') })).status, 200);
    assert.match(errorOf(await pubChange(lock, body, d.cookie, d.withKey)), /needs your passkey/, 'unlocked is not enough');
    const other = JSON.stringify({ name: 'pw', value: 'another-value-2', lifetime: 'project' });
    assert.match(errorOf(await pubChange(lock, other, d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign(lock, body) })), /something else/, 'a signature for another value');
    const passed = await pubChange(lock, body, d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign(lock, body) });
    assert.equal(passed.status, 400, passed.body);
    assert.match(errorOf(passed), /No such session/);
  } finally {
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
  // Issue #161: an owner's monthly cap.
  ['/api/relay-owners/x/cap', { cap: 1 }],
];
const RELAY_READS = ['/api/remote-link', '/api/relay-admin', '/api/relay-computers', '/api/relay-owners'];

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

// Stop Ledung (issue #456): Settings' button and `ledung stop`. Only from this computer, which can start it again; the
// sign-in cookie and Ledung's own Origin as for every change.
test('Stop Ledung is refused through the public name, even to a paired device, unlocked and signing (issue #456)', async () => {
  const d = await deviceWithPasskey('Stopping phone');
  try {
    assert.equal((await pubChange('/api/device-unlock', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/device-unlock', '{}') })).status, 200);
    const res = await pubChange('/api/stop', '{}', d.cookie, { ...d.withKey, 'x-ledung-passkey': await d.sign('/api/stop', '{}') });
    assert.equal(res.status, 403, res.body);
    assert.match(errorOf(res), /Ledung is stopped in Settings on the computer Ledung runs on/);
  } finally {
    d.page.close();
  }
});

test('Stop Ledung needs the sign-in and the origin, and stops only from this computer (issue #456)', async (t) => {
  const stopPort = await freePort();
  let stops = 0;
  const ip = networkAddress();
  const stopping = new LedungServer({ port: stopPort, token: TOKEN, store: paneStore, manager: sessions, webRoot, onStop: () => { stops++; }, lanBind: ip ?? undefined, lanNames: ip ? [ip] : [] });
  await stopping.listen();
  try {
    const at = (address: string, headers: Record<string, string>) => requestAt(address, stopPort, { method: 'POST', path: '/api/stop', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
    const origin = `http://127.0.0.1:${stopPort}`;
    assert.equal((await at('127.0.0.1', { origin })).status, 401, 'no sign-in');
    assert.equal((await at('127.0.0.1', { cookie: COOKIE })).status, 403, 'no origin');
    assert.equal((await at('127.0.0.1', { cookie: COOKIE, origin: 'https://evil.example' })).status, 403, 'another origin');
    if (ip) {
      // Signed in from another computer on the network: it could stop Ledung but never start it again.
      const lan = await at(ip, { cookie: COOKIE, origin: `http://${ip}:${stopPort}` });
      assert.equal(lan.status, 403, lan.body);
      assert.match(errorOf(lan), /Ledung is stopped on the computer it runs on/);
    } else t.diagnostic('no network address: the local network case was not run');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(stops, 0);
    const ok = await at('127.0.0.1', { cookie: COOKIE, origin });
    assert.equal(ok.status, 200, ok.body);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(stops, 1, 'stopped once, after the answer');
  } finally {
    await stopping.close();
  }
  // Without a stop handler, as the main test server: there is nothing to stop.
  const none = await change('/api/stop', {});
  assert.equal(none.status, 404, none.body);
});

test('`ledung stop` proves it is Ledung, sends the sign-in, and waits until Ledung is gone (issue #456)', async () => {
  const stopPort = await freePort();
  const dir = fs.mkdtempSync(path.join(appDir(), '.test', 'stop-'));
  let stopping: LedungServer | null = null;
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: stopPort }));
    const data = path.join(dir, 'data');
    fs.mkdirSync(data);
    const lines: string[] = [];
    const opts = { configFile: path.join(dir, 'config.json'), dataDir: data, print: (l: string) => lines.push(l), stoppedMs: 10_000 };
    // No token, and nothing on the port: not running, exit 3, and nothing sent.
    assert.equal(await stopRunning(opts), 3);
    fs.writeFileSync(path.join(data, 'auth-token'), TOKEN);
    stopping = new LedungServer({ port: stopPort, token: TOKEN, store: paneStore, manager: sessions, webRoot, onStop: () => void stopping?.close() });
    await stopping.listen();
    assert.equal(await stopRunning(opts), 0);
    assert.deepEqual(lines, ['Ledung is not running.', 'Stopping Ledung and its sessions...', 'Ledung stopped.']);
    assert.equal(await stopRunning(opts), 3, 'gone');
  } finally {
    // Closed already when the stop worked; a failed one must not keep the test run open.
    await stopping?.close().catch(() => {});
    removeTemp(dir);
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

// The workflow page (issue #310): a project's flow, read-only, behind the sign-in and Host check like the file viewer,
// and only from inside the project folder.
test("a project's flow needs the sign-in and Ledung's own Host, is read-only, and never reads outside the project", async (t) => {
  const folder = path.join(projectRoot, '.ledung', 'workflow');
  fs.mkdirSync(path.join(folder, 'briefs'), { recursive: true });
  t.after(() => fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true }));
  const flow = { version: 1, blocks: [{ id: 'a', kind: 'work', title: 'A', brief: 'briefs/a.md', outcomes: [{ word: 'Next', to: 'b' }] }, { id: 'b', kind: 'work', title: 'B', brief: 'briefs/out.md' }] };
  fs.writeFileSync(path.join(folder, 'flow.json'), JSON.stringify(flow));
  fs.writeFileSync(path.join(folder, 'briefs', 'a.md'), '# A brief');
  fs.writeFileSync(path.join(path.dirname(projectRoot), 'ledung-secret.md'), 'SECRET');
  t.after(() => fs.rmSync(path.join(path.dirname(projectRoot), 'ledung-secret.md'), { force: true }));
  let linked = true;
  try {
    fs.symlinkSync(path.join(path.dirname(projectRoot), 'ledung-secret.md'), path.join(folder, 'briefs', 'out.md'));
  } catch {
    linked = false;
  }
  const p = '/api/projects/p/flow';
  assert.equal((await request({ path: p })).status, 401);
  assert.equal((await request({ path: p, headers: { host: 'evil.example:80', cookie: COOKIE } })).status, 403);
  // A change without Ledung's own origin is refused before anything (the builder's save, issue #311, is tested below).
  assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE }, body: '{}' })).status, 403);
  assert.equal((await request({ method: 'POST', path: p, headers: { cookie: COOKIE, origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const ok = await request({ path: p, headers: { cookie: COOKIE, origin: 'https://evil.example' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['access-control-allow-origin'], undefined, 'no other site may read it');
  const view = JSON.parse(ok.body);
  assert.equal(view.source.kind, 'project');
  assert.deepEqual(view.texts, { 'briefs/a.md': '# A brief' });
  assert.equal(ok.body.includes('SECRET'), false);
  if (linked) assert.deepEqual(view.problems, [{ at: 'briefs/out.md', message: "can't be read: Only files inside the project folder can be shown." }]);
  // A path in flow.json that climbs out is refused by the format itself; nothing is read for it.
  fs.writeFileSync(path.join(folder, 'flow.json'), JSON.stringify({ ...flow, blocks: [{ id: 'a', kind: 'work', title: 'A', brief: '../../../ledung-secret.md' }] }));
  const climb = await request({ path: p, headers: { cookie: COOKIE } });
  assert.equal(JSON.parse(climb.body).flow, null);
  assert.equal(climb.body.includes('SECRET'), false);
  assert.match(JSON.parse(climb.body).problems[0].at, /^blocks\.a\.brief$/);
  const nope = await request({ path: '/api/projects/nope/flow', headers: { cookie: COOKIE } });
  assert.equal(nope.status, 400);
  assert.match(JSON.parse(nope.body).error, /no project named "nope"/);
  // Its runs (workflow part 3c): read like the flow, behind the sign-in and the Host check.
  const runs = '/api/projects/p/runs';
  assert.equal((await request({ path: runs })).status, 401);
  assert.equal((await request({ path: runs, headers: { host: 'evil.example:80', cookie: COOKIE } })).status, 403);
  const listed = await request({ path: runs, headers: { cookie: COOKIE } });
  assert.equal(listed.status, 200);
  assert.deepEqual(JSON.parse(listed.body), []);
  assert.equal((await request({ path: '/api/projects/nope/runs', headers: { cookie: COOKIE } })).status, 400);
  // A proposed workflow change (part 3e), for its review page: the same checks.
  assert.equal((await request({ path: '/api/projects/p/proposals/1' })).status, 401);
  assert.equal((await request({ path: '/api/projects/p/proposals/1', headers: { host: 'evil.example:80', cookie: COOKIE } })).status, 403);
  assert.equal((await request({ path: '/api/projects/p/proposals/1', headers: { cookie: COOKIE } })).status, 400);
});

// The builder saves (issue #311, part 2, design decision 4): a change like any other (sign-in, Host, Origin, and through
// the public name an unlocked device), only into the project's own .ledung/workflow, only the files the format knows,
// within the limits, never through a link, and each replacing the version the page read.
test("the builder's save needs the sign-in, Ledung's own Host and Origin, and writes only the format's files inside the project's own workflow folder", async (t) => {
  const folder = path.join(projectRoot, '.ledung', 'workflow');
  t.after(() => fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true }));
  fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
  const p = '/api/projects/p/flow';
  const flow = JSON.stringify({ version: 1, manager: 'manager.md', blocks: [{ id: 'a', kind: 'work', title: 'A', runs: 'manager', brief: 'briefs/a.md' }] });
  const files = [{ path: 'briefs/a.md', text: '# A', base: null }, { path: 'manager.md', text: '# Manager', base: null }, { path: 'flow.json', text: flow, base: null }];
  const body = JSON.stringify({ files });
  const json = { 'content-type': 'application/json' };
  // Refused before anything is written: no sign-in, another Host, no or another Origin.
  assert.equal((await request({ method: 'POST', path: p, headers: { ...json, origin: ORIGIN }, body })).status, 401);
  assert.equal((await request({ method: 'POST', path: p, headers: { ...json, cookie: COOKIE, origin: ORIGIN, host: 'evil.example:80' }, body })).status, 403);
  assert.equal((await request({ method: 'POST', path: p, headers: { ...json, cookie: COOKIE }, body })).status, 403);
  assert.equal((await request({ method: 'POST', path: p, headers: { ...json, cookie: COOKIE, origin: 'https://evil.example' }, body })).status, 403);
  assert.equal(fs.existsSync(folder), false, 'nothing was written');
  // Through the public name a paired device that isn't unlocked can't save either.
  const d = await deviceWithPasskey('Builder phone');
  try {
    const locked = await pubChange(p, body, d.cookie, d.withKey);
    assert.equal(locked.status, 403, locked.body);
    assert.match(errorOf(locked), /locked/);
  } finally {
    d.page.close();
  }
  assert.equal(fs.existsSync(folder), false, 'nothing was written');

  // Only from the open page: a script with the sign-in token alone can't rewrite what a manager follows (review, #104 F1).
  const noPage = await change(p, { files });
  assert.equal(noPage.status, 403, noPage.body);
  assert.match(errorOf(noPage), /open page/);
  assert.equal(fs.existsSync(folder), false, 'nothing was written');
  const page = await livePage();
  t.after(() => page.close());
  const save = (b: unknown) => change(p, b, { 'x-ledung-page': page.key });

  // Saved: the files are in the project's own folder, and the answer is the workflow as it now reads.
  const saved = await save({ files });
  assert.equal(saved.status, 200, saved.body);
  const view = JSON.parse(saved.body);
  assert.deepEqual(view.texts, { 'briefs/a.md': '# A', 'manager.md': '# Manager' });
  assert.equal(view.raw, flow);
  assert.equal(view.saveTo, folder);
  assert.equal(fs.readFileSync(path.join(folder, 'flow.json'), 'utf8'), flow);

  // Only the files the format knows, and only inside the workflow folder.
  for (const bad of ['../../outside.md', '../flow.json', 'briefs/../../../ledung-escaped.md', '/etc/x.md', 'C:/x.md', 'briefs\\x.md', 'briefs/sub/x.md', 'notes.txt', 'briefs/x.txt', 'overlays/.hidden.md', 'secrets/x.md', 'flow.json/x.md', 'roles/x.md', 'manager.md/x.md', 'briefs/manager.md/x.md', 'Manager.md', '../manager.md']) {
    const res = await save({ files: [{ path: bad, text: 'x', base: null }] });
    assert.equal(res.status, 400, bad);
    assert.match(errorOf(res), /not a file the workflow's format has/, bad);
  }
  assert.equal(fs.existsSync(path.join(projectRoot, 'outside.md')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(projectRoot), 'ledung-escaped.md')), false);
  // Sizes: one text, all of them, the request; and a flow.json that would be no flow at all.
  assert.match(errorOf(await save({ files: [{ path: 'briefs/big.md', text: 'x'.repeat(256 * 1024 + 1), base: null }] })), /larger than the 256 KB/);
  const many = Array.from({ length: 20 }, (_, i) => ({ path: `briefs/b${i}.md`, text: 'x'.repeat(250 * 1024), base: null }));
  assert.match(errorOf(await save({ files: many })), /Together the files are larger than the 4 MB/);
  // Past the body limit the request is refused while it comes in: a 413, or the connection cut before the answer.
  const huge = await request({ method: 'POST', path: p, headers: { ...json, cookie: COOKIE, origin: ORIGIN, 'x-ledung-page': page.key, connection: 'close' }, body: JSON.stringify({ files: [{ path: 'rules.md', text: 'x'.repeat(7 * 1024 * 1024), base: null }] }) }).catch((e: NodeJS.ErrnoException) => ({ status: e.code }));
  assert.ok(huge.status === 413 || huge.status === 'ECONNRESET' || huge.status === 'EPIPE', String(huge.status));
  assert.equal(fs.existsSync(path.join(folder, 'rules.md')), false);
  assert.match(errorOf(await save({ files: [{ path: 'flow.json', text: '{"version":1,"blocks":[]}', base: view.versions['flow.json'] }] })), /would not be a flow/);
  assert.match(errorOf(await save({ files: [] })), /nothing to save/);
  assert.match(errorOf(await save({ files: [{ path: 'rules.md', text: 'a', base: null }, { path: 'rules.md', text: 'b', base: null }] })), /given twice/);
  assert.equal(fs.readdirSync(path.join(folder, 'briefs')).join(), 'a.md', 'none of those was written');

  // Each file replaces the version the page read: a stale or made-up version, or a new file that is there already, is refused.
  assert.match(errorOf(await save({ files: [{ path: 'briefs/a.md', text: '# B', base: '0000000000000000' }] })), /has changed since the page read the workflow/);
  assert.match(errorOf(await save({ files: [{ path: 'briefs/a.md', text: '# B', base: null }] })), /already in the workflow folder/);
  assert.match(errorOf(await save({ files: [{ path: 'briefs/a.md', text: '# B', base: 'not a version' }] })), /which version it replaces/);
  assert.equal(fs.readFileSync(path.join(folder, 'briefs', 'a.md'), 'utf8'), '# A');
  const again = await save({ files: [{ path: 'briefs/a.md', text: '# B', base: view.versions['briefs/a.md'] }] });
  assert.equal(again.status, 200, again.body);
  assert.equal(fs.readFileSync(path.join(folder, 'briefs', 'a.md'), 'utf8'), '# B');

  // Never through a link: the workflow folder that is a link (a junction on Windows) to somewhere else is not written to.
  const outside = path.join(path.dirname(projectRoot), `ledung-builder-outside-${process.pid}`);
  fs.mkdirSync(outside, { recursive: true });
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
  fs.mkdirSync(path.join(projectRoot, '.ledung'));
  fs.symlinkSync(outside, folder, 'junction');
  const viaLink = await save({ files: [{ path: 'rules.md', text: 'CHANGED', base: null }] });
  assert.equal(viaLink.status, 400, viaLink.body);
  assert.match(errorOf(viaLink), /\.ledung\/workflow is a link/);
  assert.equal(fs.existsSync(path.join(outside, 'rules.md')), false);
  fs.rmSync(folder, { recursive: true, force: true });
});

// Saves are one at a time per project (security review of PR #89, finding 2): two started together from the same
// version can't both pass the version check, so the second never silently overwrites the first.
test("two saves of a project's workflow from the same version: the first is saved, the second refused", async (t) => {
  t.after(() => fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true }));
  fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
  const flow = JSON.stringify({ version: 1, blocks: [{ id: 'a', kind: 'work', title: 'A', runs: 'manager', brief: 'briefs/a.md' }] });
  await sessions.saveFlow('p', [{ path: 'briefs/a.md', text: '# A', base: null }, { path: 'flow.json', text: flow, base: null }]);
  const base = (await sessions.flowView('p')).versions['briefs/a.md'];
  assert.ok(base, 'the brief has a version');
  const [one, two] = await Promise.allSettled([
    sessions.saveFlow('p', [{ path: 'briefs/a.md', text: '# One', base }]),
    sessions.saveFlow('p', [{ path: 'briefs/a.md', text: '# Two', base }]),
  ]);
  assert.equal(one.status, 'fulfilled', one.status === 'rejected' ? String(one.reason) : '');
  assert.equal(two.status, 'rejected');
  assert.match(String((two as PromiseRejectedResult).reason), /has changed since the page read the workflow/);
  assert.equal(fs.readFileSync(path.join(projectRoot, '.ledung', 'workflow', 'briefs', 'a.md'), 'utf8'), '# One');
});

// A project whose folder is also a shared workflow's (ledung#109): its flow is the one every project following that
// workflow runs, so the builder must not save it from this project's page; #311's rule, "never into a shared workflow's
// folder", holds by the back door too. The same folder, a link to it, and a workflow folder linked into the project's.
test("a project whose folder is a shared workflow's, or links to it, shows that flow read-only and its save is refused; an ordinary project's save still works", async (t) => {
  // The EXERCISED line goes to a data folder of the test's own, never the real one.
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-109-data-'));
  const savedData = process.env.LEDUNG_DATA_DIR;
  process.env.LEDUNG_DATA_DIR = data;
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-109-shared-'));
  const linkToProject = path.join(os.tmpdir(), `ledung-109-link-${process.pid}`);
  const before = sessions.currentConfig;
  t.after(() => {
    sessions.applyConfig(before, []);
    if (savedData === undefined) delete process.env.LEDUNG_DATA_DIR;
    else process.env.LEDUNG_DATA_DIR = savedData;
    fs.rmSync(linkToProject, { recursive: true, force: true });
    fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
    removeTemp(shared);
    removeTemp(data);
  });
  fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
  const sharedFlow = JSON.stringify({ version: 1, title: 'Shared', blocks: [{ id: 'a', kind: 'work', title: 'A', runs: 'manager' }] });
  fs.mkdirSync(path.join(shared, '.ledung', 'workflow'), { recursive: true });
  fs.writeFileSync(path.join(shared, '.ledung', 'workflow', 'flow.json'), sharedFlow);
  // Project p follows the first workflow (it names none), so this one.
  const useWorkflow = (folder: string) => sessions.applyConfig({ ...before, workflows: [{ name: 'proc', folder, managerFile: 'lead.md', sessionFile: 'worker.md', projectConfig: 'LEAD.md' }] }, []);
  const p = '/api/projects/p/flow';
  const page = await livePage();
  t.after(() => page.close());
  const save = (b: unknown) => change(p, b, { 'x-ledung-page': page.key });
  const view = async () => JSON.parse((await request({ path: p, headers: { cookie: COOKIE } })).body);
  const own = path.join(projectRoot, '.ledung', 'workflow');
  const flow = (title: string) => JSON.stringify({ version: 1, title, blocks: [{ id: 'a', kind: 'work', title: 'A', runs: 'manager' }] });

  // An ordinary project that follows the workflow: its own folder is where Save goes, and the save is written there.
  useWorkflow(shared);
  const ordinary = await view();
  assert.equal(ordinary.saveTo, own);
  assert.equal(ordinary.readOnly, undefined);
  assert.equal(ordinary.source.kind, 'workflow', 'it shows the shared flow until it has one of its own');
  const ok = await save({ files: [{ path: 'flow.json', text: flow('Own'), base: null }] });
  assert.equal(ok.status, 200, ok.body);
  const ownVersion = JSON.parse(ok.body).versions['flow.json'];
  assert.equal(fs.readFileSync(path.join(own, 'flow.json'), 'utf8'), flow('Own'));
  assert.equal(fs.readFileSync(path.join(shared, '.ledung', 'workflow', 'flow.json'), 'utf8'), sharedFlow, 'the shared flow is untouched');

  // The project's folder is the workflow's folder: by its own path, through a link (a junction on Windows) to it, and
  // with the workflow's .ledung/workflow a link to the project's.
  fs.symlinkSync(projectRoot, linkToProject, 'junction');
  const flowLink = path.join(shared, '.ledung', 'workflow');
  for (const [how, folder, setUp] of [
    ['the same folder', projectRoot, () => {}],
    ['a link to it', linkToProject, () => {}],
    ["the workflow's flow folder linked to the project's", shared, () => {
      fs.rmSync(flowLink, { recursive: true, force: true });
      fs.symlinkSync(own, flowLink, 'junction');
    }],
  ] as const) {
    setUp();
    useWorkflow(folder);
    // The back door first: a save straight to the route, with the version it replaces, is refused with the reason.
    const refused = await save({ files: [{ path: 'flow.json', text: flow('Changed'), base: ownVersion }] });
    assert.equal(refused.status, 400, `${how}: ${refused.body}`);
    assert.match(errorOf(refused), /folder is the shared workflow "proc"'s folder/, how);
    assert.equal(fs.readFileSync(path.join(own, 'flow.json'), 'utf8'), flow('Own'), `${how}: nothing was written`);
    // The front door: the page is offered nowhere to save, and is told why.
    const shown = await view();
    assert.equal(shown.saveTo, null, how);
    assert.match(shown.readOnly, /folder is the shared workflow "proc"'s folder/, how);
    assert.equal(shown.source.kind, 'workflow', how);
    assert.equal(shown.source.workflow, 'proc', how);
    assert.equal(shown.flow.title, 'Own', `${how}: the flow in the folder is still shown`);
  }
});

// The same before either side has a flow folder (review of PR #116): a workflow's repository with no drawn flow yet,
// added as a project, is how #109 was found; its first Save must not create the flow every follower would then run.
test("a project whose folder is a shared workflow's, before either has a flow folder: the first save is refused and creates nothing", async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-109-data-'));
  const savedData = process.env.LEDUNG_DATA_DIR;
  process.env.LEDUNG_DATA_DIR = data;
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-109-shared-'));
  const linkToProject = path.join(os.tmpdir(), `ledung-109-link2-${process.pid}`);
  const before = sessions.currentConfig;
  t.after(() => {
    sessions.applyConfig(before, []);
    if (savedData === undefined) delete process.env.LEDUNG_DATA_DIR;
    else process.env.LEDUNG_DATA_DIR = savedData;
    fs.rmSync(linkToProject, { recursive: true, force: true });
    fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
    removeTemp(shared);
    removeTemp(data);
  });
  fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
  fs.symlinkSync(projectRoot, linkToProject, 'junction');
  const useWorkflow = (folder: string) => sessions.applyConfig({ ...before, workflows: [{ name: 'proc', folder, managerFile: 'lead.md', sessionFile: 'worker.md', projectConfig: 'LEAD.md' }] }, []);
  const p = '/api/projects/p/flow';
  const page = await livePage();
  t.after(() => page.close());
  const save = (b: unknown) => change(p, b, { 'x-ledung-page': page.key });
  const view = async () => JSON.parse((await request({ path: p, headers: { cookie: COOKIE } })).body);
  const own = path.join(projectRoot, '.ledung', 'workflow');
  const files = [{ path: 'flow.json', text: JSON.stringify({ version: 1, title: 'First', blocks: [{ id: 'a', kind: 'work', title: 'A', runs: 'manager' }] }), base: null }];

  for (const [how, folder] of [['the same folder', projectRoot], ['a link to it', linkToProject]] as const) {
    useWorkflow(folder);
    const refused = await save({ files });
    assert.equal(refused.status, 400, `${how}: ${refused.body}`);
    assert.match(errorOf(refused), /folder is the shared workflow "proc"'s folder/, how);
    assert.equal(fs.existsSync(path.join(projectRoot, '.ledung')), false, `${how}: no flow folder was made`);
    const shown = await view();
    assert.equal(shown.source, null, how);
    assert.equal(shown.saveTo, null, how);
    assert.match(shown.readOnly, /folder is the shared workflow "proc"'s folder/, how);
  }

  // The other way round (code review of PR #116): a workflow's folder linked into the project's, where the flow folder
  // the link leads to isn't there yet. The project's first save would make it, and with it the workflow's live flow.
  const sharedLinked = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-109-linked-'));
  const sharedDangling = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-109-dangling-'));
  t.after(() => {
    removeTemp(sharedLinked);
    removeTemp(sharedDangling);
  });
  fs.mkdirSync(path.join(projectRoot, '.ledung'));
  fs.symlinkSync(path.join(projectRoot, '.ledung'), path.join(sharedLinked, '.ledung'), 'junction');
  fs.mkdirSync(path.join(sharedDangling, '.ledung'));
  fs.symlinkSync(own, path.join(sharedDangling, '.ledung', 'workflow'), 'junction');
  for (const [how, folder] of [["the workflow's .ledung linked to the project's", sharedLinked], ["the workflow's flow folder linked to the project's, not made yet", sharedDangling]] as const) {
    useWorkflow(folder);
    const refused = await save({ files });
    assert.equal(refused.status, 400, `${how}: ${refused.body}`);
    assert.match(errorOf(refused), /folder is the shared workflow "proc"'s folder/, how);
    assert.equal(fs.existsSync(own), false, `${how}: no flow folder was made`);
    assert.equal((await view()).saveTo, null, how);
  }

  // The positive branch: following a workflow elsewhere, the same first save makes the project's own flow folder.
  useWorkflow(shared);
  const ok = await save({ files });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(fs.existsSync(path.join(own, 'flow.json')), true, 'the probe sees a flow folder that was made');
  assert.equal(fs.existsSync(path.join(shared, '.ledung')), false, 'nothing went into the shared folder');
});

// A shared workflow's flow folder linked to a folder inside the project's (review round 2 of PR #116): the project's
// flows/flow.json or briefs/rules.md is then the workflow's live flow.json or rules.md, so its save must be refused too,
// whether that inner folder exists yet or not.
test("a project whose flow folder holds a shared workflow's, through a link to a folder inside it: its save is refused", async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-109-data-'));
  const savedData = process.env.LEDUNG_DATA_DIR;
  process.env.LEDUNG_DATA_DIR = data;
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-109-inner-'));
  const before = sessions.currentConfig;
  t.after(() => {
    sessions.applyConfig(before, []);
    if (savedData === undefined) delete process.env.LEDUNG_DATA_DIR;
    else process.env.LEDUNG_DATA_DIR = savedData;
    fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
    removeTemp(shared);
    removeTemp(data);
  });
  fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
  const useWorkflow = (folder: string) => sessions.applyConfig({ ...before, workflows: [{ name: 'proc', folder, managerFile: 'lead.md', sessionFile: 'worker.md', projectConfig: 'LEAD.md' }] }, []);
  const p = '/api/projects/p/flow';
  const page = await livePage();
  t.after(() => page.close());
  const save = (b: unknown) => change(p, b, { 'x-ledung-page': page.key });
  const own = path.join(projectRoot, '.ledung', 'workflow');
  const flow = JSON.stringify({ version: 1, title: 'Inner', blocks: [{ id: 'a', kind: 'work', title: 'A', runs: 'manager' }] });
  const sharedFlowFolder = path.join(shared, '.ledung', 'workflow');
  fs.mkdirSync(path.join(shared, '.ledung'));

  // The positive branch first: the shared flow folder is a folder of its own, and the project's save is written.
  fs.mkdirSync(sharedFlowFolder);
  useWorkflow(shared);
  const ok = await save({ files: [{ path: 'flows/flow.json', text: flow, base: null }] });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(fs.readFileSync(path.join(own, 'flows', 'flow.json'), 'utf8'), flow, 'the probe sees a file that was written');
  fs.rmSync(path.join(own, 'flows'), { recursive: true, force: true });
  fs.rmSync(sharedFlowFolder, { recursive: true, force: true });

  for (const [how, inner, file, make] of [
    ['linked to flows/, which is there', 'flows', 'flows/flow.json', true],
    ['linked to flows/, not made yet', 'flows', 'flows/flow.json', false],
    ['linked to briefs/, not made yet', 'briefs', 'briefs/rules.md', false],
  ] as const) {
    fs.rmSync(sharedFlowFolder, { recursive: true, force: true });
    fs.rmSync(path.join(own, inner), { recursive: true, force: true });
    if (make) fs.mkdirSync(path.join(own, inner), { recursive: true });
    fs.symlinkSync(path.join(own, inner), sharedFlowFolder, 'junction');
    useWorkflow(shared);
    const refused = await save({ files: [{ path: file, text: file.endsWith('.json') ? flow : '# Rules', base: null }] });
    assert.equal(refused.status, 400, `${how}: ${refused.body}`);
    assert.match(errorOf(refused), /shared workflow "proc"/, how);
    assert.equal(fs.existsSync(path.join(own, ...file.split('/'))), false, `${how}: nothing was written`);
    const shown = JSON.parse((await request({ path: p, headers: { cookie: COOKIE } })).body);
    assert.equal(shown.saveTo, null, how);
    assert.match(shown.readOnly, /shared workflow "proc"/, how);
  }
});

// A link inside a shared workflow's flow folder into the project's (review round 3 of PR #116; Martin, 2026-11-03 12:43,
// Ledung question #1314): its briefs/ or flows/, or one file, linked to the project's makes the project's file the
// workflow's too, so the project's save of that file is refused, whether the project's file or folder exists yet or not.
test("a project whose flow files a shared workflow's flow folder links to from inside: the save of those files is refused", async (t) => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-109-links-'));
  const before = sessions.currentConfig;
  t.after(() => {
    sessions.applyConfig(before, []);
    fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
    removeTemp(shared);
  });
  fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
  sessions.applyConfig({ ...before, workflows: [{ name: 'proc', folder: shared, managerFile: 'lead.md', sessionFile: 'worker.md', projectConfig: 'LEAD.md' }] }, []);
  const p = '/api/projects/p/flow';
  const page = await livePage();
  t.after(() => page.close());
  const save = (b: unknown) => change(p, b, { 'x-ledung-page': page.key });
  const own = path.join(projectRoot, '.ledung', 'workflow');
  const flow = JSON.stringify({ version: 1, title: 'Links', blocks: [{ id: 'a', kind: 'work', title: 'A', runs: 'manager' }] });
  const theirs = path.join(shared, '.ledung', 'workflow');
  fs.mkdirSync(theirs, { recursive: true });
  const textOf = (file: string) => (file.endsWith('.json') ? flow : '# Brief');

  // The positive branch first: the shared folder's briefs/ and flows/ are folders of its own, and the project's save of
  // the same names is written.
  fs.mkdirSync(path.join(theirs, 'briefs'));
  fs.mkdirSync(path.join(theirs, 'flows'));
  const ok = await save({ files: [{ path: 'briefs/x.md', text: '# Brief', base: null }, { path: 'flows/extra.json', text: flow, base: null }] });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(fs.readFileSync(path.join(own, 'briefs', 'x.md'), 'utf8'), '# Brief', 'the probe sees a file that was written');
  assert.equal(fs.existsSync(path.join(theirs, 'briefs', 'x.md')), false, 'nothing went into the shared folder');

  const cases: [string, string, () => void][] = [
    ["the shared briefs/ linked to the project's, which is there", 'briefs/x.md', () => {
      fs.mkdirSync(path.join(own, 'briefs'), { recursive: true });
      fs.symlinkSync(path.join(own, 'briefs'), path.join(theirs, 'briefs'), 'junction');
    }],
    ["the shared flows/ linked to the project's, not made yet", 'flows/extra.json', () => {
      fs.symlinkSync(path.join(own, 'flows'), path.join(theirs, 'flows'), 'junction');
    }],
    ["the shared overlays/ linked to the project's, with no project flow folder yet", 'overlays/rules.md', () => {
      fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
      fs.symlinkSync(path.join(own, 'overlays'), path.join(theirs, 'overlays'), 'junction');
    }],
  ];
  // One file linked (a symlink, which only some accounts on Windows may make): the shared flow.json is the project's.
  try {
    fs.symlinkSync(path.join(shared, 'probe-target'), path.join(shared, 'probe-link'), 'file');
    fs.rmSync(path.join(shared, 'probe-link'));
    cases.push(["the shared flow.json linked to the project's, not made yet", 'flow.json', () => {
      fs.symlinkSync(path.join(own, 'flow.json'), path.join(theirs, 'flow.json'), 'file');
    }]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
    t.diagnostic('file symlinks need another account here: the one-file case is left out');
  }
  for (const [how, file, link] of cases) {
    fs.rmSync(path.join(own, 'briefs', 'x.md'), { force: true });
    fs.rmSync(path.join(own, 'flows'), { recursive: true, force: true });
    for (const f of ['briefs', 'flows', 'overlays', 'flow.json']) fs.rmSync(path.join(theirs, f), { recursive: true, force: true });
    link();
    const refused = await save({ files: [{ path: file, text: textOf(file), base: null }] });
    assert.equal(refused.status, 400, `${how}: ${refused.body}`);
    assert.match(errorOf(refused), /shared workflow "proc"/, how);
    assert.equal(fs.existsSync(path.join(own, ...file.split('/'))), false, `${how}: nothing was written`);
  }
});

// Review round 4 of PR #116 (Martin, 2026-11-03 13:00, Ledung question #1318): a shared flow may name a brief anywhere
// in its folder, so a link on the way to one (docs/, a folder deep in briefs/) counts as much as briefs/ itself; and a
// flow a save deletes is checked as a file it writes is, since the deletion would take away the workflow's live flow.
test("a project whose flow files a shared flow's named briefs lead to, or a flow it deletes: the save is refused", async (t) => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-109-named-'));
  const before = sessions.currentConfig;
  t.after(() => {
    sessions.applyConfig(before, []);
    fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
    removeTemp(shared);
  });
  fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
  sessions.applyConfig({ ...before, workflows: [{ name: 'proc', folder: shared, managerFile: 'lead.md', sessionFile: 'worker.md', projectConfig: 'LEAD.md' }] }, []);
  const p = '/api/projects/p/flow';
  const page = await livePage();
  t.after(() => page.close());
  const save = (b: unknown) => change(p, b, { 'x-ledung-page': page.key });
  const own = path.join(projectRoot, '.ledung', 'workflow');
  const theirs = path.join(shared, '.ledung', 'workflow');
  const naming = (brief: string) => JSON.stringify({ version: 1, title: 'Named', blocks: [{ id: 'a', kind: 'work', title: 'A', runs: 'manager', brief }] });
  const reset = () => {
    fs.rmSync(path.join(projectRoot, '.ledung'), { recursive: true, force: true });
    fs.rmSync(theirs, { recursive: true, force: true });
    fs.mkdirSync(path.join(own, 'briefs'), { recursive: true });
    fs.mkdirSync(theirs, { recursive: true });
  };

  // Named by the shared flow.json at docs/x.md, and by a shared flows/side.json deep in briefs/: each folder on the way a
  // real one first (the save is written), then a link to the project's briefs/ (refused, nothing written).
  for (const [how, flowFile, brief, linkAt] of [
    ['flow.json names docs/x.md', 'flow.json', 'docs/x.md', 'docs'],
    ['flows/side.json names briefs/a/b/x.md', 'flows/side.json', 'briefs/a/b/x.md', 'briefs/a/b'],
  ] as const) {
    reset();
    fs.mkdirSync(path.join(theirs, 'flows'));
    fs.writeFileSync(path.join(theirs, ...flowFile.split('/')), naming(brief));
    fs.mkdirSync(path.join(theirs, ...linkAt.split('/')), { recursive: true });
    const ok = await save({ files: [{ path: 'briefs/x.md', text: '# Brief', base: null }] });
    assert.equal(ok.status, 200, `${how}, a real folder: ${ok.body}`);
    assert.equal(fs.readFileSync(path.join(own, 'briefs', 'x.md'), 'utf8'), '# Brief', `${how}: the probe sees a file that was written`);

    fs.rmSync(path.join(own, 'briefs', 'x.md'));
    fs.rmSync(path.join(theirs, ...linkAt.split('/')), { recursive: true });
    fs.symlinkSync(path.join(own, 'briefs'), path.join(theirs, ...linkAt.split('/')), 'junction');
    const refused = await save({ files: [{ path: 'briefs/x.md', text: '# Brief', base: null }] });
    assert.equal(refused.status, 400, `${how}, a link: ${refused.body}`);
    assert.match(errorOf(refused), /shared workflow "proc"/, how);
    assert.equal(fs.existsSync(path.join(own, 'briefs', 'x.md')), false, `${how}: nothing was written`);
  }

  // ledung#111: a "folder:" brief is in the workflow's own folder, beside .ledung/workflow, so a link on the way to it
  // there (process/) counts as much: a real folder first (the save is written), then a link to the project's briefs/.
  reset();
  const process111 = path.join(shared, 'process');
  t.after(() => fs.rmSync(process111, { recursive: true, force: true }));
  fs.writeFileSync(path.join(theirs, 'flow.json'), naming('folder:process/x.md'));
  fs.mkdirSync(process111);
  const ok111 = await save({ files: [{ path: 'briefs/x.md', text: '# Brief', base: null }] });
  assert.equal(ok111.status, 200, `folder:process/x.md, a real folder: ${ok111.body}`);
  assert.equal(fs.readFileSync(path.join(own, 'briefs', 'x.md'), 'utf8'), '# Brief', 'folder:process/x.md: the probe sees a file that was written');
  fs.rmSync(path.join(own, 'briefs', 'x.md'));
  fs.rmSync(process111, { recursive: true });
  fs.symlinkSync(path.join(own, 'briefs'), process111, 'junction');
  const refused111 = await save({ files: [{ path: 'briefs/x.md', text: '# Brief', base: null }] });
  assert.equal(refused111.status, 400, `folder:process/x.md, a link: ${refused111.body}`);
  assert.match(errorOf(refused111), /shared workflow "proc"/, 'folder:process/x.md');
  assert.equal(fs.existsSync(path.join(own, 'briefs', 'x.md')), false, 'folder:process/x.md: nothing was written');
  fs.rmSync(process111, { recursive: true, force: true });

  // A brief no flow names, only listed (test review round 5): the shared briefs/j.md is what Ledung's lister lists, so a
  // link there into the project's briefs/ counts as much as a named one. A junction (on Windows its entry is not a
  // folder, so the lister lists it) runs on every account; a file link only where file links can be made.
  const forms: [string, () => void, () => void][] = [
    ["briefs/j.md, listed, a junction to the project's briefs/",
      () => fs.mkdirSync(path.join(theirs, 'briefs', 'j.md')),
      () => fs.symlinkSync(path.join(own, 'briefs'), path.join(theirs, 'briefs', 'j.md'), 'junction')],
  ];
  try {
    fs.symlinkSync(path.join(shared, 'probe-target'), path.join(shared, 'probe-link'), 'file');
    fs.rmSync(path.join(shared, 'probe-link'));
    forms.push(["briefs/j.md, listed, a file link to the project's briefs/x.md",
      () => fs.writeFileSync(path.join(theirs, 'briefs', 'j.md'), '# Theirs'),
      () => fs.symlinkSync(path.join(own, 'briefs', 'x.md'), path.join(theirs, 'briefs', 'j.md'), 'file')]);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
    t.diagnostic('file symlinks need another account here: the listed file-link case is left out');
  }
  for (const [how, real, link] of forms) {
    reset();
    fs.mkdirSync(path.join(theirs, 'briefs'));
    real();
    const ok = await save({ files: [{ path: 'briefs/x.md', text: '# Brief', base: null }] });
    assert.equal(ok.status, 200, `${how}, a real one: ${ok.body}`);
    assert.equal(fs.readFileSync(path.join(own, 'briefs', 'x.md'), 'utf8'), '# Brief', `${how}: the probe sees a file that was written`);

    fs.rmSync(path.join(own, 'briefs', 'x.md'));
    fs.rmSync(path.join(theirs, 'briefs', 'j.md'), { recursive: true });
    link();
    const refused = await save({ files: [{ path: 'briefs/x.md', text: '# Brief', base: null }] });
    assert.equal(refused.status, 400, `${how}, a link: ${refused.body}`);
    assert.match(errorOf(refused), /shared workflow "proc"/, how);
    assert.equal(fs.existsSync(path.join(own, 'briefs', 'x.md')), false, `${how}: nothing was written`);
  }

  // A flow deleted (code review round 3 and test review round 4): with the shared flows/ a folder of its own the deletion
  // goes through; with it linked to the project's flows/, the project's flows/extra.json is the workflow's, and stays.
  const extra = JSON.stringify({ version: 1, title: 'Extra', blocks: [{ id: 'a', kind: 'work', title: 'A', runs: 'manager' }] });
  const extraFile = path.join(own, 'flows', 'extra.json');
  for (const linked of [false, true]) {
    reset();
    fs.mkdirSync(path.join(own, 'flows'));
    fs.writeFileSync(extraFile, extra);
    if (linked) fs.symlinkSync(path.join(own, 'flows'), path.join(theirs, 'flows'), 'junction');
    else fs.mkdirSync(path.join(theirs, 'flows'));
    const removed = await save({ files: [{ path: 'flows/extra.json', remove: true, base: crypto.createHash('sha256').update(extra, 'utf8').digest('hex').slice(0, 16) }] });
    if (!linked) {
      assert.equal(removed.status, 200, `the deletion, no link: ${removed.body}`);
      assert.equal(fs.existsSync(extraFile), false, 'the probe sees a flow that was deleted');
    } else {
      assert.equal(removed.status, 400, `the deletion, linked: ${removed.body}`);
      assert.match(errorOf(removed), /shared workflow "proc"/);
      assert.equal(fs.readFileSync(extraFile, 'utf8'), extra, "the workflow's flow is still there");
    }
  }
});

// Part 3f and ledung#110: starting a queued run past its limit and taking a project back to its shared flow are the
// person's, from the open page: the sign-in cookie and Origin alone are refused, before anything happens.
test('start anyway, stop and back to shared need the open page', async () => {
  for (const p of ['/api/projects/p/runs/run-1/start', '/api/projects/p/runs/run-1/stop', '/api/projects/p/flow/back-to-shared']) {
    assert.equal((await request({ method: 'POST', path: p, headers: { origin: ORIGIN } })).status, 401, p);
    const refused = await change(p, {});
    assert.equal(refused.status, 403, p);
    assert.match(errorOf(refused), /Only Ledung's open page can do this/);
  }
});

// The sidebar's Workflow row (2026-11-04; final review of part 3, finding 7): which projects have a flow is read behind
// the sign-in and the Host check, like every other read.
test('GET /api/workflows needs the sign-in and a known Host', async () => {
  assert.equal((await request({ path: '/api/workflows' })).status, 401);
  assert.equal((await request({ path: '/api/workflows', headers: { cookie: 'ledung_auth=' + 'b'.repeat(64) } })).status, 401);
  assert.equal((await request({ path: '/api/workflows', headers: { host: 'evil.example:80', cookie: COOKIE } })).status, 403);
  const res = await request({ path: '/api/workflows', headers: { cookie: COOKIE } });
  assert.equal(res.status, 200, res.body);
  assert.equal(typeof JSON.parse(res.body), 'object');
});

// A container project's files (issue #122): through a fake runner that runs the container's scripts in a local sh
// (as test/files.test.ts does), behind the sign-in, inside the project folder, only the approved types, a locked
// project's folder in the same container shut, and the copies kept for questions only to their own project.
const hasSh = spawnSync('sh', ['-c', 'readlink -f . && head -c 1 /dev/null'], { windowsHide: true }).status === 0;
test("a container project's files: signed in, inside its folder, the approved types, a locked project's folder shut, copies per project", { skip: !hasSh && 'no sh with readlink here' }, async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-ct-sec-')));
  const posix = (p: string) => (process.platform === 'win32' ? p.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`) : p).replaceAll('\\', '/');
  const app = path.join(dir, 'app');
  fs.mkdirSync(path.join(app, 'locked'), { recursive: true });
  fs.writeFileSync(path.join(app, 'notes.md'), '# In the container\n');
  fs.writeFileSync(path.join(app, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]));
  fs.writeFileSync(path.join(app, 'main.ts'), 'export {};\n');
  fs.writeFileSync(path.join(app, 'big.txt'), 'x'.repeat(3 * 1024 * 1024));
  fs.writeFileSync(path.join(app, 'locked', 'plan.md'), '# locked\n');
  fs.writeFileSync(path.join(dir, 'outside.md'), '# outside\n');
  const before = { exec: sessions.containerExecFor, copies: sessions.containerCopiesDir };
  sessions.containerExecFor = () => (script, args, opts) => runCappedBytes('sh', ['-c', script, 'sh', ...args], opts);
  sessions.containerCopiesDir = () => path.join(dir, 'copies');
  const added: string[] = [];
  const add = async (body: Record<string, unknown>) => {
    const res = await change('/api/projects', body);
    assert.equal(res.status, 200, res.body);
    added.push(String(body.name));
  };
  const get = (p: string) => request({ path: p, headers: { cookie: COOKIE } });
  try {
    await add({ name: 'ct', runner: 'docker', container: 'ledung-test-ct', pathInContainer: posix(app) });
    await add({ name: 'ct-other', runner: 'docker', container: 'ledung-test-ct2', pathInContainer: posix(app) });
    paneStore.createSession({ id: 'ct1', project: 'ct', runner: 'docker', title: 't', parentId: null, permissionMode: 'default', role: 'session' });
    paneStore.createSession({ id: 'ct2', project: 'ct-other', runner: 'docker', title: 't', parentId: null, permissionMode: 'default', role: 'session' });

    assert.equal((await request({ path: '/api/sessions/ct1/file?path=notes.md' })).status, 401);
    assert.equal(JSON.parse((await get('/api/sessions/ct1/file?path=notes.md')).body).content, '# In the container\n');
    const image = await get('/api/sessions/ct1/image?path=shot.png');
    assert.equal(image.status, 200);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.deepEqual(JSON.parse((await get('/api/sessions/ct1/folders')).body).folders.map((f: { path: string }) => f.path), [posix(app)]);
    assert.deepEqual(JSON.parse((await get('/api/sessions/ct1/tree?in=session')).body).entries.map((e: { name: string }) => e.name), ['locked', 'big.txt', 'main.ts', 'notes.md', 'shot.png']);
    for (const [bad, why] of [['../outside.md', /inside the project/], [encodeURIComponent(`${posix(dir)}/outside.md`), /inside the project/], ['main.ts', /only \.md/], ['big.txt', /too large/]] as const) {
      const res = await get(`/api/sessions/ct1/file?path=${bad}`);
      assert.equal(res.status, 400, bad);
      assert.match(errorOf(res), why, bad);
    }
    assert.equal((await get('/api/sessions/ct1/image?path=notes.md')).status, 400, 'a text file is no image');
    try {
      fs.symlinkSync(path.join(dir, 'outside.md'), path.join(app, 'out.md'));
      assert.match(errorOf(await get('/api/sessions/ct1/file?path=out.md')), /inside the project/, 'a link out');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
      t.diagnostic('this machine does not allow file links: the link case was not run');
    }

    // Another project, locked, in the same container: its folder inside this one stays shut (issue #109).
    await add({ name: 'ct-locked', runner: 'docker', container: 'ledung-test-ct', pathInContainer: `${posix(app)}/locked`, lockdown: { level: 'A' } });
    assert.match(errorOf(await get('/api/sessions/ct1/file?path=locked/plan.md')), /locked project/);
    assert.equal((await get('/api/sessions/ct1/tree?in=session&path=locked')).status, 400);
    assert.ok(!JSON.parse((await get('/api/sessions/ct1/tree?in=session')).body).entries.some((e: { name: string }) => e.name === 'locked'));

    // A screenshot kept when asked: shown by its name to its own project's sessions, never to another project's.
    const keep = (sessions as unknown as { keepContainerFiles(id: string, f: { file: string; as: 'shot' | 'evidence' }[]): Promise<string[]> }).keepContainerFiles.bind(sessions);
    const [shot, notes] = await keep('ct1', [{ file: 'shot.png', as: 'shot' }, { file: 'notes.md', as: 'evidence' }]);
    assert.match(shot!, /^container:[0-9a-f]{32}\/shot\.png$/);
    assert.match(notes!, /^container:[0-9a-f]{32}\/notes\.md$/);
    await assert.rejects(keep('ct1', [{ file: 'notes.md', as: 'shot' }]), /Screenshot 1 \(notes\.md\) can't be attached: notes\.md is not a PNG or JPEG image\. Nothing was asked\./);
    await assert.rejects(keep('ct1', [{ file: 'locked/plan.md', as: 'evidence' }]), /locked project/);
    fs.writeFileSync(path.join(app, 'shot.png'), 'changed since');
    assert.equal((await get(`/api/sessions/ct1/image?path=${encodeURIComponent(shot!)}`)).status, 200, 'the copy, not the file now');
    assert.equal((await get(`/api/sessions/ct2/image?path=${encodeURIComponent(shot!)}`)).status, 400, "another project's session");
    assert.equal((await get(`/api/sessions/s1/image?path=${encodeURIComponent(shot!)}`)).status, 400, 'a local project');
    assert.equal((await request({ path: `/api/sessions/ct1/image?path=${encodeURIComponent(shot!)}` })).status, 401);

    // A stopped container is said plainly.
    sessions.containerExecFor = () => async (_s, _a, opts) => ({ failed: containerFailure('ledung-test-ct', 'Error response from daemon: container x is not running', false, opts.timeoutMs) });
    assert.match(errorOf(await get('/api/sessions/ct1/file?path=notes.md')), /The container "ledung-test-ct" is not running/);
    assert.equal((await get(`/api/sessions/ct1/image?path=${encodeURIComponent(shot!)}`)).status, 200, 'a kept copy without the container');
  } finally {
    sessions.containerExecFor = before.exec;
    sessions.containerCopiesDir = before.copies;
    const page = await livePage();
    for (const name of added.reverse()) await change(`/api/projects/${name}/remove`, {}, { 'x-ledung-page': page.key });
    page.close();
    removeTemp(dir);
  }
});
