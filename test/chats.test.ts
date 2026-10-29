// Chats (issue #211): a Claude Code session with no project, workflow or manager, in a folder chosen when
// it starts. Decisions: Martin 18:14 on question #293 (design A, defaults 2–7), 18:19 on question #297
// (Auto by default, the computer's own login, Claude Code's model, the full profile, Remote Control off).
// Claude Code is never started here: the local runner's prepare refuses, so a started chat ends at once
// after every check of Ledung's has run, as a session in a missing folder does in the lockdown tests.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { CHATS } from '../src/shared/protocol.ts';
import { LATER_SUGGESTIONS, SUGGESTIONS } from '../src/shared/sensitive-suggestions.ts';
import { rulePath } from '../src/sessions/boundary.ts';
import { hostsDir, listHostRecords } from '../src/host/client.ts';
import { pipePath } from '../src/host/protocol.ts';
import { sessionChanges } from '../src/sessions/changes.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const NO_CLAUDE = 'no Claude Code in tests';

const prepare = LocalRunner.prototype.prepare;
LocalRunner.prototype.prepare = async function () { throw new Error(NO_CLAUDE); };

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-chats-')));
const home = path.join(base, 'home');
// The home folder is the test's own (os.homedir reads these), so AppData and Library below are never the real ones.
process.env.USERPROFILE = home;
process.env.HOME = home;
// Ledung's data folder (host records, and what the file viewer must never show) is the test's own too, in that home.
process.env.LEDUNG_DATA_DIR = path.join(home, 'ledung-data');
fs.mkdirSync(process.env.LEDUNG_DATA_DIR, { recursive: true });
const locked = path.join(home, 'locked');
const open = path.join(home, 'open');
const outside = path.join(base, 'outside');
for (const d of [path.join(home, 'AppData', 'Roaming'), path.join(home, 'Library'), path.join(locked, 'sub'), path.join(open, '.github'), path.join(home, '.ssh'), path.join(home, 'notes'), outside]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, 'notes', 'todo.md'), '# todo');
fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'secret');
fs.writeFileSync(path.join(home, '.bashrc'), 'export TOKEN=x');
fs.writeFileSync(path.join(open, '.github', 'ci.yml'), 'on: push');
fs.writeFileSync(path.join(outside, 'x.txt'), 'x');
fs.writeFileSync(path.join(home, 'AppData', 'Roaming', 'token.txt'), 'secret');
fs.writeFileSync(path.join(home, 'Library', 'cookies.txt'), 'secret');
// A link out of the folders the page may browse: a junction on Windows (no admin rights needed).
fs.symlinkSync(outside, path.join(home, 'escape'), 'junction');
/** Every Ledung a test made, let go of before the folder goes, so nothing of theirs still holds a file in it (#268). */
const made: SessionManager[] = [];
after(() => {
  LocalRunner.prototype.prepare = prepare;
  for (const manager of made) manager.detachAll();
  removeTemp(base);
});

const SEED = String.raw`\bmy-seed\b`;
const GLOBAL = String.raw`\bglobal-rule\b`;
const GIT_PUSH = SUGGESTIONS.find((s) => s.name.startsWith('Pushing to main'))!.pattern;

function ledung(chats: object = { folder: home, sensitive: { commandPatterns: [SEED] } }, store = new Store(openDatabase(':memory:'))) {
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    userName: 'Simon', browseRoots: [home], sensitive: { commandPatterns: [GLOBAL] }, chats,
    workflow: { folder: base, managerFile: 'LEAD.md', sessionFile: 'WORKER.md', projectConfig: 'docs/config.md' },
    projects: [
      { name: 'locked', runner: 'local', path: locked, lockdown: { level: 'A' } },
      { name: 'open', runner: 'local', path: open },
    ],
  }), store, () => {}));
  made.push(manager);
  type Live = {
    workflow: unknown; runner: { cwd: string };
    claudeOptions(h: object): Promise<{ settings?: { permissions?: { deny?: string[] } }; hooks?: { PreToolUse?: { hooks: ((i: object, id: string) => Promise<Record<string, unknown>>)[] }[] } }>;
    onPermission(tool: string, input: Record<string, unknown>, opts: { signal: AbortSignal }): Promise<unknown>;
  };
  const live = (id: string) => (manager as unknown as { live: Map<string, Live> }).live.get(id)!;
  /** What Ledung's PreToolUse check says about a Bash command in this session. */
  const hook = async (id: string, command: string) => {
    const o = await live(id).claudeOptions({ onLine: () => {}, onStderr: () => {} });
    const out = await o.hooks!.PreToolUse![0]!.hooks[0]!({ tool_name: 'Bash', tool_input: { command } }, 'tu-1');
    return (out.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision ?? null;
  };
  return { store, manager, live, hook };
}

test('a chat starts with no project: in the default folder, Auto, the full profile, Claude Code\'s own model, no manager', async () => {
  const { manager, store, live } = ledung();
  const chat = await manager.startChat({});
  assert.equal(chat.project, CHATS);
  assert.equal(chat.role, 'session');
  assert.equal(chat.parentId, null);
  assert.equal(chat.workDir, home);
  assert.equal(chat.permissionMode, 'auto', 'Auto by default (question #297)');
  assert.equal(chat.profile, 'full');
  assert.equal(chat.requestedModel, null, "no model given: Claude Code's own default");
  assert.equal(chat.account, null, "the computer's own login");
  assert.equal(live(chat.id).runner.cwd, home, 'Claude Code would run in the chat folder');
  // It got as far as starting Claude Code: every check of Ledung's passed.
  assert.match(store.getSession(chat.id)!.endReason ?? '', new RegExp(NO_CLAUDE));
  assert.equal(live(chat.id).workflow, null, 'no workflow, though one is configured');
  assert.ok(!manager.projects().some((p) => p.name === CHATS), 'a chat is not a project');

  const chosen = await manager.startChat({ folder: open, model: 'haiku', permissionMode: 'default', profile: 'full' });
  assert.equal(chosen.workDir, open);
  assert.equal(chosen.requestedModel, 'haiku');
  assert.equal(chosen.permissionMode, 'default');
  await assert.rejects(manager.startChat({ permissionMode: 'bypassPermissions' as never }), /permission mode/);
  await assert.rejects(manager.startChat({ profile: 'nope' }), /no session profile named "nope"/);
});

test("the chats' name colour (#222): one for all chats, only from the palette, and kept over a restart", () => {
  const { manager, store } = ledung();
  assert.equal(manager.chats().colour, null, 'no colour until one is chosen');
  assert.throws(() => manager.setChatsColour('red;}body{display:none'), /not one of the name colours/);
  assert.throws(() => manager.setChatsColour('#ff0000'), /not one of the name colours/);
  assert.equal(manager.chats().colour, null, 'a refused colour changes nothing');
  assert.equal(manager.setChatsColour('teal').colour, 'teal');
  // Restart Ledung: a new manager on the same database.
  assert.equal(ledung(undefined, store).manager.chats().colour, 'teal');
  assert.equal(manager.setChatsColour(null).colour, null, 'back to no colour');
  assert.equal(ledung(undefined, store).manager.chats().colour, null);
});

test('with no default folder in the config, a chat starts in the home folder', async () => {
  const { manager } = ledung({});
  assert.equal(manager.chats().folder, path.resolve(os.homedir()));
});

test("a chat's folder must be one the page may browse, and not inside a locked project; nothing is made when refused", async () => {
  const { manager, store } = ledung();
  await assert.rejects(manager.startChat({ folder: outside }), /outside the folders/);
  await assert.rejects(manager.startChat({ folder: path.join(open, '..', '..', 'outside') }), /outside the folders/);
  await assert.rejects(manager.startChat({ folder: path.join(home, 'escape') }), /outside the folders/, 'a junction is followed');
  await assert.rejects(manager.startChat({ folder: path.join(home, 'missing') }), /does not exist/);
  await assert.rejects(manager.startChat({ folder: path.join(home, 'notes', 'todo.md') }), /not a folder/);
  await assert.rejects(manager.startChat({ folder: locked }), /inside the locked project "locked"/);
  await assert.rejects(manager.startChat({ folder: path.join(locked, 'sub') }), /inside the locked project "locked"/);
  assert.equal(store.listSessions().length, 0);
  // A relative folder is taken from the default folder.
  assert.equal((await manager.startChat({ folder: 'notes' })).workDir, path.join(home, 'notes'));
});

test("a chat in a folder above a locked project gets that project's folders denied, like every other project's session", async () => {
  const { manager, live } = ledung();
  const chat = await manager.startChat({});
  const deny = (await live(chat.id).claudeOptions({ onLine: () => {}, onStderr: () => {} })).settings?.permissions?.deny ?? [];
  assert.ok(deny.includes(`Read(${rulePath(locked)})`));
  assert.ok(deny.includes(`Edit(${rulePath(locked)}/**)`));
});

test("a chat's prompts go to the user, and its sensitive list is asked in every mode", async () => {
  const { manager, store, live, hook } = ledung();
  const chat = await manager.startChat({});
  assert.equal(chat.permissionMode, 'auto');
  void live(chat.id).onPermission('Bash', { command: 'git push origin main' }, { signal: new AbortController().signal });
  const p = store.pendingPermissions().at(-1)!;
  assert.equal(p.addressedTo, 'user', 'no manager: to the user');
  assert.ok(p.sensitive, 'marked sensitive');
  // The suggestions, the config's chats seeds and the config's global patterns: asked, whatever the mode.
  assert.equal(await hook(chat.id, 'git push origin main'), 'ask');
  assert.equal(await hook(chat.id, 'my-seed --now'), 'ask');
  assert.equal(await hook(chat.id, 'global-rule'), 'ask');
  assert.equal(await hook(chat.id, 'ls'), null);
});

test('"!" in a chat (#212) is checked against the chats\' sensitive list, and refused while its folder holds a locked project (review round 2, finding 2)', async () => {
  const { manager } = ledung();
  const chat = await manager.startChat({ folder: 'notes' });
  assert.equal(manager.shellCheck(chat.id, 'git push origin main').refused, null);
  assert.ok(manager.shellCheck(chat.id, 'git push origin main').rule, 'a suggestion in the chats list');
  assert.ok(manager.shellCheck(chat.id, 'my-seed --now').rule, "the config's chats seed");
  assert.ok(manager.shellCheck(chat.id, 'global-rule').rule, "the config's global patterns");
  assert.deepEqual(manager.shellCheck(chat.id, 'ls'), { rule: null, refused: null });
  // The home folder holds the locked project: refused with #212's message, as for a project's session.
  const wide = await manager.startChat({});
  assert.match(manager.shellCheck(wide.id, 'ls').refused ?? '', /while "locked" is locked/);
  await assert.rejects(manager.runShell(wide.id, 'ls', true), /while "locked" is locked/);
});

test('the chats list starts with the suggestions; changes apply to new chats, and the config seeds always stay', async () => {
  const { manager, hook } = ledung();
  const info = manager.chats();
  assert.equal(info.sensitive.commandPatterns.length, SUGGESTIONS.filter((s) => s.kind === 'command').length);
  assert.deepEqual(info.fromConfig.commandPatterns, [SEED]);
  const without = { ...info.sensitive, commandPatterns: info.sensitive.commandPatterns.filter((c) => c !== GIT_PUSH) };
  assert.equal(manager.chatsLoosen({ sensitive: without }), true, 'a pattern removed loosens');
  assert.equal(manager.chatsLoosen({ sensitive: { ...info.sensitive, commandPatterns: [...info.sensitive.commandPatterns, 'x'] } }), false, 'one added does not');
  assert.equal(manager.chatsLoosen({ sensitive: 'nonsense' }), true, 'a malformed body never counts as harmless');
  assert.throws(() => manager.updateChats({ sensitive: { commandPatterns: ['('], pathPatterns: [], mcpTools: [] } }), /not a valid regular expression/);
  manager.updateChats({ sensitive: without });
  assert.deepEqual(manager.chats().sensitive.commandPatterns, without.commandPatterns);
  const chat = await manager.startChat({});
  assert.equal(await hook(chat.id, 'git push origin main'), null, 'taken out of the list');
  assert.equal(await hook(chat.id, 'my-seed'), 'ask', 'a config seed is not in the editable list, so it stays');
});

test('a chat resumes in the folder it started in, checked again', async () => {
  const { manager, store, live } = ledung();
  const chat = await manager.startChat({ folder: open });
  store.updateSession(chat.id, { claudeSessionId: 'abc', status: 'ended' });
  const resumed = await manager.resume(chat.id);
  assert.equal(resumed.project, CHATS);
  assert.equal(live(chat.id).runner.cwd, open);
  assert.match(store.getSession(chat.id)!.endReason ?? '', new RegExp(NO_CLAUDE), 'it got as far as starting Claude Code');
  // Locked since: its folder is now inside a locked project, so it is refused before anything runs.
  store.createSession({ id: 'old', project: CHATS, runner: 'local', title: 't', parentId: null, permissionMode: 'auto', workDir: path.join(locked, 'sub') });
  store.updateSession('old', { claudeSessionId: 'def', status: 'ended' });
  await assert.rejects(manager.resume('old'), /inside the locked project "locked"/);
  assert.equal(store.getSession('old')!.status, 'ended');
});

test('the file viewer shows a chat its own folder only, and nothing in a dot-folder or dot-file', async () => {
  const { manager } = ledung();
  const chat = await manager.startChat({});
  assert.equal(manager.readFile(chat.id, 'notes/todo.md').content, '# todo');
  assert.throws(() => manager.readFile(chat.id, '.ssh/id_ed25519'), /hidden/);
  assert.throws(() => manager.readFile(chat.id, path.join(home, '.ssh', 'id_ed25519')), /hidden/);
  assert.throws(() => manager.readFile(chat.id, '.bashrc'), /hidden/);
  assert.throws(() => manager.readFile(chat.id, 'escape/x.txt'), /inside the/);
  assert.throws(() => manager.readFile(chat.id, '../outside/x.txt'), /inside the/);
  // Started inside a dot-folder: its plain-named files are still hidden.
  const inSsh = await manager.startChat({ folder: '.ssh' });
  assert.throws(() => manager.readFile(inSsh.id, 'id_ed25519'), /hidden/);
  // AppData (any case) and Library under the home folder, and Ledung's own data folder, also through a link (question #317).
  assert.throws(() => manager.readFile(chat.id, 'AppData/Roaming/token.txt'), /not shown/);
  // On a case-insensitive filesystem (Windows, and macOS's APFS default) the lowercase path is AppData itself
  // and is refused; elsewhere it names nothing.
  const caseInsensitive = fs.existsSync(path.join(home, 'appdata'));
  assert.throws(() => manager.readFile(chat.id, 'appdata/Roaming/token.txt'), caseInsensitive ? /not shown/ : /no file/);
  assert.throws(() => manager.readFile(chat.id, 'Library/cookies.txt'), /not shown/);
  const inAppData = await manager.startChat({ folder: 'AppData/Roaming' });
  assert.throws(() => manager.readFile(inAppData.id, 'token.txt'), /not shown/, 'a chat started inside it');
  fs.writeFileSync(path.join(process.env.LEDUNG_DATA_DIR!, 'auth-token'), 'secret');
  fs.symlinkSync(process.env.LEDUNG_DATA_DIR!, path.join(home, 'notes', 'data-link'), 'junction');
  assert.throws(() => manager.readFile(chat.id, 'notes/data-link/auth-token'), /not shown/, "Ledung's data folder through a link");
  // A project's session is unchanged: its dot-folders are shown as before.
  const session = await manager.start('open');
  assert.equal(manager.readFile(session.id, '.github/ci.yml').content, 'on: push');
});

// The Files pane (issue #225) gives a chat the viewer's chat rules above (question #317), through the manager.
test("a chat's Files pane keeps the viewer's chat rules: no settings folders, nothing under a dot-folder, no dot-files in Changes", async () => {
  const { manager } = ledung();
  const chat = await manager.startChat({});
  assert.ok((await manager.listFolder(chat.id, 'session', '')).entries.some((e) => e.name === 'notes'));
  await assert.rejects(manager.listFolder(chat.id, 'session', 'AppData'), /settings and sign-ins/);
  await assert.rejects(manager.listFolder(chat.id, 'session', 'Library'), /settings and sign-ins/);
  const inAppData = await manager.startChat({ folder: 'AppData/Roaming' });
  await assert.rejects(manager.listFolder(inAppData.id, 'session', ''), /settings and sign-ins/, 'a chat started inside it');
  const inSsh = await manager.startChat({ folder: '.ssh' });
  await assert.rejects(manager.listFolder(inSsh.id, 'session', ''), /Hidden/, 'a chat started inside a dot-folder');

  // A branch that changes a.txt and a dot-folder's file: the chat's Changes leave the dot-folder out.
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).status, 0, `git ${args.join(' ')}`);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.test');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  git('switch', '-q', '-c', 'work');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.mkdirSync(path.join(repo, '.secret'));
  fs.writeFileSync(path.join(repo, '.secret', 'x.txt'), 'token\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'two');
  // The positive branch: the diff itself has both files, so the chat's lack of one is the filter's doing.
  assert.deepEqual((await sessionChanges(repo)).files.map((f) => f.path).sort(), ['.secret/x.txt', 'a.txt']);
  const inRepo = await manager.startChat({ folder: 'repo' });
  assert.deepEqual((await manager.changes(inRepo.id)).files.map((f) => f.path), ['a.txt']);
});

test('chats are ordered and archived among themselves; removing or renaming a project leaves them alone', async () => {
  const { manager, store } = ledung();
  const a = await manager.startChat({});
  const b = await manager.startChat({});
  const s = await manager.start('open');
  manager.setSessionOrder([b.id, a.id]);
  assert.ok(store.getSession(b.id)!.position! < store.getSession(a.id)!.position!);
  assert.throws(() => manager.setSessionOrder([a.id, s.id]), /within their own project/);
  assert.ok(manager.archive(a.id).archivedAt);
  manager.renameProject('open', 'opened');
  await manager.removeProject('opened');
  assert.deepEqual(store.listSessions().filter((x) => x.project === CHATS).map((x) => x.id).sort(), [a.id, b.id].sort());
  // No way in through the project routes: a chat is started with startChat only.
  await assert.rejects(manager.start(CHATS), /no project named/);
});

test('a later batch of suggestions reaches a chats list saved before it, once, as it reaches projects (#213)', () => {
  const { store, manager } = ledung();
  const batch = LATER_SUGGESTIONS[0]!;
  const before = manager.chats().sensitive;
  assert.ok(batch.commandPatterns.every((p) => before.commandPatterns.includes(p)), 'a list never saved has every suggestion');
  // Saved before the batch existed: without its patterns, and the batch not yet applied here.
  manager.updateChats({ sensitive: { ...before, commandPatterns: before.commandPatterns.filter((p) => !batch.commandPatterns.includes(p)) } });
  store.database.prepare('DELETE FROM meta WHERE key = ?').run(`chats-${batch.key}`);
  const config = (manager as unknown as { config: object }).config;
  const again = () => refuseRealSignInStores(new SessionManager(config as never, store, () => {}));
  assert.ok(batch.commandPatterns.every((p) => again().chats().sensitive.commandPatterns.includes(p)), 'added on the next start');
  // Deleted afterwards: it stays deleted.
  const now = again();
  now.updateChats({ sensitive: { ...now.chats().sensitive, commandPatterns: now.chats().sensitive.commandPatterns.filter((p) => p !== batch.commandPatterns[0]) } });
  assert.ok(!again().chats().sensitive.commandPatterns.includes(batch.commandPatterns[0]!));
});

test("after Restart Ledung a chat's running host is attached to again, not dropped as a session of no project", async () => {
  const { manager, store } = ledung();
  const id = `chat-reattach-${process.pid}`;
  store.createSession({ id, project: CHATS, runner: 'local', title: 'a chat', parentId: null, permissionMode: 'auto', workDir: home, profile: 'full' });
  store.updateSession(id, { status: 'idle', claudeSessionId: 'abc' });
  // A host that is still there: its record, and a pipe that answers (and hangs up, so nothing more happens).
  const pipe = pipePath(id);
  const host = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => host.listen(pipe, resolve));
  fs.writeFileSync(path.join(hostsDir(), `${id}.json`), JSON.stringify({ sessionId: id, pipe, hostPid: process.pid, startedAt: Date.now() }));
  try {
    const attached = await manager.attachRunningHosts();
    assert.deepEqual(attached, [id], 'attached to');
    assert.ok(listHostRecords().some((r) => r.sessionId === id), 'its host record is kept');
  } finally {
    manager.detachAll();
    await new Promise((resolve) => host.close(resolve));
  }
});

test('a host that fails to reattach after Restart Ledung is reported on its session and the others still attach (review of PR #441)', async () => {
  const { manager, store } = ledung();
  const bad = `chat-bad-reattach-${process.pid}`;
  const good = `chat-good-reattach-${process.pid}`;
  for (const id of [bad, good]) {
    store.createSession({ id, project: CHATS, runner: 'local', title: id, parentId: null, permissionMode: 'auto', workDir: home, profile: 'full' });
    store.updateSession(id, { status: 'idle', claudeSessionId: id });
  }
  const hosts = [bad, good].map((sessionId) => {
    const pipe = pipePath(sessionId);
    fs.writeFileSync(path.join(hostsDir(), `${sessionId}.json`), JSON.stringify({ sessionId, pipe, hostPid: process.pid, startedAt: Date.now() }));
    return { pipe, server: net.createServer((socket) => socket.destroy()) };
  });
  for (const h of hosts) await new Promise<void>((resolve) => h.server.listen(h.pipe, resolve));
  // The SDK's own error when it is given no program and has no copy of its own, as in an npm install.
  const start = Session.prototype.start;
  Session.prototype.start = function (this: Session) {
    return this.id === bad ? Promise.reject(new Error('Native CLI binary for darwin-arm64 not found.')) : start.call(this);
  };
  try {
    assert.deepEqual(await manager.attachRunningHosts(), [good], 'Ledung goes on and attaches the other');
    const info = store.getSession(bad)!;
    assert.equal(info.status, 'ended');
    assert.match(info.endReason ?? '', /^Could not reconnect after Restart Ledung: Native CLI binary/);
    assert.ok(store.allMessages(bad).some((m) => m.kind === 'event' && /Could not reconnect/.test((m.data as { text: string }).text)));
    assert.ok(!(manager as unknown as { live: Map<string, unknown> }).live.has(bad), 'not left as a live session');
  } finally {
    Session.prototype.start = start;
    manager.detachAll();
    for (const h of hosts) await new Promise((resolve) => h.server.close(resolve));
  }
});

test('a new chat not yet spoken to is still waiting for its first message after Restart Ledung, not working (#226)', async () => {
  const { manager, store } = ledung();
  const id = `chat-new-reattach-${process.pid}`;
  // As startChat leaves it: created, Claude Code up, no message sent.
  store.createSession({ id, project: CHATS, runner: 'local', title: 'New chat', parentId: null, permissionMode: 'auto', workDir: home, profile: 'full' });
  assert.equal(store.getSession(id)!.status, 'starting', 'a new session starts waiting for its first message');
  // Beside it, one waiting for an answer: the rule does turn that one to running (its host re-sends the prompt),
  // so the same probe shows a flip where one is due (test review of PR #227).
  const asking = `chat-asking-reattach-${process.pid}`;
  store.createSession({ id: asking, project: CHATS, runner: 'local', title: 'a chat that asks', parentId: null, permissionMode: 'auto', workDir: home, profile: 'full' });
  store.updateSession(asking, { status: 'waiting', claudeSessionId: 'def' });
  const hosts = [id, asking].map((sessionId) => {
    const pipe = pipePath(sessionId);
    fs.writeFileSync(path.join(hostsDir(), `${sessionId}.json`), JSON.stringify({ sessionId, pipe, hostPid: process.pid, startedAt: Date.now() }));
    return { pipe, server: net.createServer((socket) => socket.destroy()) };
  });
  for (const h of hosts) await new Promise<void>((resolve) => h.server.listen(h.pipe, resolve));
  try {
    assert.deepEqual((await manager.attachRunningHosts()).sort(), [asking, id].sort(), 'both attached to');
    assert.equal(store.getSession(id)!.status, 'starting', 'shown as Ready with the idle ship, not as thinking');
    assert.equal(store.getSession(asking)!.status, 'running', 'a session waiting for an answer is reattached as running');
  } finally {
    manager.detachAll();
    for (const h of hosts) await new Promise((resolve) => h.server.close(resolve));
  }
});

test("a chat's handoff for clear_self, its place in the monitor and the lockdown restart check all find its settings", async () => {
  const { manager, store } = ledung();
  const chat = await manager.startChat({});
  const internals = manager as unknown as { handoffProblem(id: string, file: string): string | null; targets(): { id: string; kind: string }[] };
  // clear_self's handoff: a fresh file inside the chat's folder is accepted, one outside it refused.
  fs.writeFileSync(path.join(home, 'notes', 'handoff.md'), 'what is left');
  assert.equal(internals.handoffProblem(chat.id, 'notes/handoff.md'), null);
  assert.match(internals.handoffProblem(chat.id, '../outside/x.txt') ?? '', /inside the project folder/);
  // Running: measured like any local session, and restarted with new settings when a project is locked.
  store.updateSession(chat.id, { status: 'running' });
  assert.deepEqual(internals.targets().filter((t) => t.id === chat.id), [{ id: chat.id, kind: 'local' }]);
  manager.updateProject('open', { name: 'open', runner: 'local', path: open, lockdown: { level: 'A' } } as never);
  assert.ok(manager.waitingRelaunch().includes(chat.id), 'it takes the newly locked folders at its next free moment');
});

test('the account for chats and for new projects (issue #283): chosen in Settings, kept, set back to default', async () => {
  const { manager, store, live } = ledung();
  assert.deepEqual(manager.accountsEvent().choices, { chats: null, newProjects: null }, 'the computer\'s own login until one is chosen');
  // Adding an account checks its sign-in: an answer of the test's own, never the installed Claude Code's (#347).
  manager.checkSignInWith = async () => ({ state: 'in', method: 'claude.ai', detail: null, checkedAt: 0 });
  const account = manager.addAccount({ name: 'max20', kind: 'folder' });
  assert.throws(() => manager.setAccountChoices({ chats: 'nope' }), /no account named "nope"/);
  manager.setAccountChoices({ chats: 'max20', newProjects: 'max20' });
  const chat = await manager.startChat({});
  assert.equal(chat.account, 'max20', 'the header shows the account it runs on');
  const own = (live(chat.id) as unknown as { account: { name: string; env: Record<string, string> } | null }).account;
  assert.deepEqual(own, { name: 'max20', env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: account.configDir } }, 'Claude Code gets that account\'s sign-in (#342)');
  assert.throws(() => manager.removeAccount('max20'), /chosen for chats and new projects/, 'nothing quietly falls back to default');
  // Kept by this Ledung across a restart: a new manager on the same database.
  assert.deepEqual(ledung(undefined, store).manager.accountsEvent().choices, { chats: 'max20', newProjects: 'max20' });
  // Set back to default, by an empty choice or by its name; the chat already started keeps its account.
  manager.setAccountChoices({ chats: '', newProjects: 'default' });
  assert.deepEqual(manager.accountChoices(), { chats: null, newProjects: null });
  assert.equal(store.getSession(chat.id)!.account, 'max20');
  assert.equal((await manager.startChat({})).account, null);
  // Until it restarts: resumed, it takes the chats' choice now, default (review of #287).
  store.updateSession(chat.id, { claudeSessionId: 'abc', status: 'ended' });
  await manager.resume(chat.id);
  assert.equal(store.getSession(chat.id)!.account, null);
  assert.equal((live(chat.id) as unknown as { account: unknown }).account, null, 'Claude Code gets the computer\'s own login');
  // A refused half of a choice leaves the other unsaved too.
  assert.throws(() => manager.setAccountChoices({ chats: 'max20', newProjects: 'nope' }), /no account named "nope"/);
  assert.deepEqual(manager.accountChoices(), { chats: null, newProjects: null });
  // Signed out in a store of the test's own, never the real one: on macOS that is the login Keychain (#347).
  const signedOut: string[] = [];
  manager.signOutWith = async (p) => void signedOut.push(p.folder);
  await manager.removeAccount('max20');
  assert.deepEqual(signedOut, [account.configDir]);
});
