// Is Claude Code signed in (issue #333)? On start and when an account is added Ledung asks Claude Code's
// own `claude auth status`, which spends no tokens; signed out, the page's banner and a session start say
// how to sign in, and a check that can't run refuses nothing. The answers below are what Claude Code
// 2.1.304 printed on 2026-10-27: signed in with an account (exit 0), with an empty login folder (exit 1).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkContainerSignIn, checkSignIn, containerSignInHelp, readAuthStatus, sdkClaudeBinary, signInHelp, type RunCommand, type SignIn, type SignInContext } from '../src/accounts/signin.ts';
import { parseConfig } from '../src/config.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const SIGNED_IN = '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "apiProvider": "firstParty",\n  "subscriptionType": "max"\n}\n';
const SIGNED_OUT = '{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty"\n}\n';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-signin-')));
// Ledung's data folder (account tokens) is the test's own.
process.env.LEDUNG_DATA_DIR = path.join(base, 'data');
fs.mkdirSync(process.env.LEDUNG_DATA_DIR, { recursive: true });
const made: SessionManager[] = [];
after(() => {
  for (const m of made) m.detachAll();
  removeTemp(base);
});

test("Claude Code's answer: signed in, signed out, and no answer", () => {
  assert.deepEqual({ ...readAuthStatus({ code: 0, stdout: SIGNED_IN }), checkedAt: 0 }, { state: 'in', method: 'claude.ai', detail: null, checkedAt: 0 });
  assert.deepEqual({ ...readAuthStatus({ code: 1, stdout: SIGNED_OUT }), checkedAt: 0 }, { state: 'out', method: null, detail: null, checkedAt: 0 });
  // An older Claude Code without the command prints its usage, not JSON: unknown, never signed out.
  assert.equal(readAuthStatus({ code: 1, stdout: "error: unknown command 'auth'" }).state, 'unknown');
  assert.equal(readAuthStatus({ code: 0, stdout: '{"apiProvider":"firstParty"}' }).state, 'unknown');
  const failed = readAuthStatus({ code: null, stdout: '', error: 'Claude Code did not answer within 15 s' });
  assert.equal(failed.state, 'unknown');
  assert.equal(failed.detail, 'Claude Code did not answer within 15 s');
});

test('the check runs auth status with the session environment, and a check that fails is unknown', async () => {
  const calls: { command: string; args: string[]; env: Record<string, string> }[] = [];
  const answer = (r: Awaited<ReturnType<RunCommand>>): RunCommand => async (command, args, env) => {
    calls.push({ command, args, env });
    return r;
  };
  const env = { CLAUDE_CONFIG_DIR: '/x' };
  assert.equal((await checkSignIn(env, { binary: '/sdk/claude', run: answer({ code: 0, stdout: SIGNED_IN }) })).state, 'in');
  assert.deepEqual(calls[0], { command: '/sdk/claude', args: ['auth', 'status', '--json'], env });
  assert.equal((await checkSignIn(env, { binary: '/sdk/claude', run: answer({ code: 1, stdout: SIGNED_OUT }) })).state, 'out');
  const timedOut = await checkSignIn(env, { binary: '/sdk/claude', run: answer({ code: null, stdout: '', error: 'Claude Code did not answer within 15 s' }) });
  assert.equal(timedOut.state, 'unknown');
  const missing = await checkSignIn(env, { binary: null, run: answer({ code: 0, stdout: SIGNED_IN }) });
  assert.equal(missing.state, 'unknown', 'no Claude Code installed for this platform');
  assert.match(missing.detail ?? '', /not installed/);
  assert.equal(calls.length, 3, 'nothing is run without a binary');
  // A session's start: its settings go before the command, which has no option of its own for them.
  const where = { cwd: '/project', settings: { apiKeyHelper: 'get-key' } };
  let ran: unknown[] = [];
  await checkSignIn(env, { binary: '/sdk/claude', where, run: async (...a) => { ran = a; return { code: 0, stdout: SIGNED_IN }; } });
  assert.deepEqual(ran, ['/sdk/claude', ['--settings', '{"apiKeyHelper":"get-key"}', 'auth', 'status', '--json'], env, 15000, '/project']);
});

test("the SDK's own Claude Code answers: an empty login folder is signed out, a token signs it in", async () => {
  const binary = sdkClaudeBinary();
  assert.ok(binary && fs.existsSync(binary), `the SDK's Claude Code is installed (${binary})`);
  // No login of the computer's reaches it: its own empty folder, and no token or key in the environment.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|ANTHROPIC)_/.test(k)) env[k] = v;
  env.CLAUDE_CONFIG_DIR = path.join(base, 'empty-login');
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
  const out = await checkSignIn(env);
  assert.equal(out.state, 'out', JSON.stringify(out));
  const token = await checkSignIn({ ...env, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-not-a-real-token-for-tests' });
  assert.deepEqual([token.state, token.method], ['in', 'oauth_token']);

  // A project's own settings sign its sessions in (review of #333, point 3): asked in that folder, it is
  // signed in, and so is a session given the same key in the settings Ledung passes.
  const project = path.join(base, 'helper-project');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ apiKeyHelper: 'echo sk-ant-api03-not-real' }));
  const inProject = await checkSignIn(env, { where: { cwd: project } });
  assert.deepEqual([inProject.state, inProject.method], ['in', 'api_key_helper'], JSON.stringify(inProject));
  const withSettings = await checkSignIn(env, { where: { cwd: base, settings: { apiKeyHelper: 'echo sk-ant-api03-not-real' } } });
  assert.deepEqual([withSettings.state, withSettings.method], ['in', 'api_key_helper'], JSON.stringify(withSettings));
  assert.equal((await checkSignIn(env, { where: { cwd: base } })).state, 'out', 'elsewhere, without them, it is not');
});

test('the help says how to sign in for each kind of account', () => {
  assert.match(signInHelp({ name: 'default', kind: 'default' }), /`claude`.*`\/login`.*`ANTHROPIC_API_KEY`/);
  // A sign-in folder's sign-in is a command to paste, in the shell's own way of setting the sign-in folder (#342).
  assert.match(signInHelp({ name: 'home', kind: 'folder', configDir: 'C:\\logins\\home' }, 'win32'), /"home".*PowerShell.*`\$env:CLAUDE_SECURESTORAGE_CONFIG_DIR="C:\\logins\\home"; claude`.*`\/login`/);
  assert.match(signInHelp({ name: 'home', kind: 'folder', configDir: '/logins/home' }, 'darwin'), /"home".*`CLAUDE_SECURESTORAGE_CONFIG_DIR="\/logins\/home" claude`.*`\/login`/);
  assert.match(signInHelp({ name: 'home', kind: 'folder', configDir: '/logins/home' }, 'linux'), /`CLAUDE_SECURESTORAGE_CONFIG_DIR="\/logins\/home" claude`/);
  // No other way in: Ledung never points at a token, not even one of the user's own (#342).
  assert.ok(!signInHelp({ name: 'home', kind: 'folder', configDir: '/logins/home' }, 'linux').includes('CLAUDE_CODE_OAUTH_TOKEN'));
  // In a container: Claude Code's /login there, in the account's folder in the container user's home.
  const inBox = containerSignInHelp('work', { container: 'devbox', user: 'dev' }, '~/.ledung-accounts/work');
  assert.match(inBox, /"work".*inside the container "devbox".*`docker exec -it -u dev devbox sh -c 'CLAUDE_SECURESTORAGE_CONFIG_DIR=\$HOME\/\.ledung-accounts\/work exec claude'`.*`\/login`/);
  assert.ok(!inBox.includes('"$HOME'), 'no double quotes in the command: PowerShell 5.1 drops them');
});

function ledung(projects: object[] = []) {
  const folder = path.join(base, `project-${made.length}`);
  fs.mkdirSync(folder);
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects: [{ name: 'p', runner: 'local', path: folder }, ...projects] }), new Store(openDatabase(':memory:')), () => {}));
  made.push(manager);
  const seen: Record<string, string>[] = [];
  const places: (SignInContext | undefined)[] = [];
  let answer: SignIn['state'] | Error = 'in';
  manager.checkSignInWith = async (env, where) => {
    seen.push(env);
    places.push(where);
    if (answer instanceof Error) throw answer;
    return { state: answer, method: answer === 'in' ? 'claude.ai' : null, detail: null, checkedAt: Date.now() };
  };
  return { manager, folder, seen, places, answer: (a: typeof answer) => { answer = a; } };
}

test('signed out: the banner says how, and a session start explains it instead of starting', async () => {
  const { manager, folder, seen, places, answer } = ledung();
  answer('out');
  await manager.checkSignIns();
  assert.ok(places.length === 1 && places[0] === undefined, "the banner's check is about the account, not a project");
  assert.deepEqual(manager.accountsEvent().signedOut?.map((s) => s.account), ['default']);
  assert.match(manager.signedOut()[0]!.help, /`claude`.*`\/login`/);
  assert.ok(seen.every((env) => !Object.keys(env).some((k) => k.startsWith('LEDUNG_'))), "Ledung's own settings never reach the check");

  const session = await manager.start('p');
  const ended = manager.sessions().find((s) => s.id === session.id)!;
  assert.equal(ended.status, 'ended');
  assert.match(ended.endReason ?? '', /not signed in.*`\/login`/);
  assert.equal(places.at(-1)?.cwd, folder, "the start's check is asked in the session's folder");
  assert.deepEqual(places.at(-1)?.settings, {}, 'with the settings it gets: none here');

  // Signed in where the session runs (a project's own key): the start goes on. Its answer is the
  // project's, so the account's banner stays until Check again.
  answer('in');
  assert.equal(await manager.signInRefusal('default', { cwd: folder }), null);
  assert.deepEqual(manager.signedOut().map((s) => s.account), ['default']);
  await manager.checkSignIns();
  assert.deepEqual(manager.signedOut(), []);
});

test("a start that would work is not refused: the project's own settings sign it in (review of #333, point 3)", async () => {
  // The real check, with no login of the computer's: an empty login folder, no token or key.
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC)_/.test(k)) delete process.env[k];
  process.env.CLAUDE_CONFIG_DIR = path.join(base, 'empty-login-2');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  const { manager, folder } = ledung();
  manager.checkSignInWith = (env, where) => checkSignIn(env, { where });
  const plain = await manager.signInRefusal('default', { cwd: folder });
  assert.ok(plain && 'refuse' in plain && /not signed in/.test(plain.refuse), 'a plain project is refused');
  fs.mkdirSync(path.join(folder, '.claude'));
  fs.writeFileSync(path.join(folder, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo sk-ant-api03-not-real' }));
  assert.equal(await manager.signInRefusal('default', { cwd: folder }), null, 'its own apiKeyHelper signs it in');
  fs.rmSync(path.join(folder, '.claude'), { recursive: true });
  assert.equal(await manager.signInRefusal('default', { cwd: folder, settings: { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-not-real' } } }), null, 'so does a key in the settings Ledung gives it');
});

test('a check that fails refuses nothing and shows no banner: the start goes on with a warning', async () => {
  const { manager, answer } = ledung();
  answer(new Error('spawn EACCES'));
  await manager.checkSignIns();
  assert.deepEqual(manager.signedOut(), []);
  assert.deepEqual(await manager.signInRefusal('default', { cwd: base }), { warn: 'Ledung could not check that Claude Code is signed in (spawn EACCES); starting anyway.' });
  answer('unknown');
  const unsure = await manager.signInRefusal('default', { cwd: base });
  assert.ok(unsure && 'warn' in unsure, 'warned, not refused');
  assert.deepEqual(manager.signedOut(), []);
});

test("an added account is checked with its own login; the computer's own only while something uses it", async () => {
  const { manager, seen, answer } = ledung();
  answer('out');
  const added = manager.addAccount({ name: 'work' });
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.at(-1)?.CLAUDE_SECURESTORAGE_CONFIG_DIR, added.configDir, 'checked when added, with its own sign-in folder');
  assert.equal(seen.at(-1)?.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'with no token');
  assert.deepEqual(manager.signedOut().map((s) => s.account), ['work']);
  assert.match(manager.signedOut()[0]!.help, /"work".*`\/login`/);

  await manager.checkSignIns();
  assert.deepEqual(manager.signedOut().map((s) => s.account), ['default', 'work']);
  // Chats and Add project on the account, and the project moved to it: nothing uses the computer's login.
  manager.setAccountChoices({ chats: 'work', newProjects: 'work' });
  assert.deepEqual(manager.signedOut().map((s) => s.account), ['default', 'work'], 'project p still has no account');
  await manager.removeProject('p');
  assert.deepEqual(manager.signedOut().map((s) => s.account), ['work']);
});

test("a container's sign-in is asked of Claude Code in the container, about the account's folder there (#342)", async () => {
  let ran: unknown[] = [];
  const found = await checkContainerSignIn({ container: 'devbox', user: 'dev' }, '~/.ledung-accounts/work', { run: async (...a) => { ran = a; return { code: 1, stdout: SIGNED_OUT }; } });
  assert.equal(found.state, 'out');
  assert.equal(ran[0], 'docker');
  assert.deepEqual((ran[1] as string[]).slice(0, 6), ['exec', '-u', 'dev', 'devbox', 'sh', '-c']);
  // The container's own token and key are left out, so the answer is about the folder.
  assert.equal((ran[1] as string[])[6], 'CLAUDE_SECURESTORAGE_CONFIG_DIR="$HOME/.ledung-accounts/work" exec env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN claude auth status --json');
  const stopped = await checkContainerSignIn({ container: 'devbox' }, '/logins/work', { run: async () => ({ code: 1, stdout: '' }) });
  assert.equal(stopped.state, 'unknown', 'a stopped container refuses nothing');
});

test('a container project may use a login-folder account, and its start is refused when the folder there is signed out', async () => {
  const { manager } = ledung([{ name: 'c', runner: 'docker', container: 'devbox', pathInContainer: '/work' }]);
  manager.addAccount({ name: 'box' });
  manager.updateProject('c', { name: 'c', runner: 'docker', container: 'devbox', pathInContainer: '/work', account: 'box' } as never);
  manager.checkContainerSignInWith = async () => ({ state: 'out', method: null, detail: null, checkedAt: 0 });
  const refused = await manager.containerSignInRefusal('box', { container: 'devbox' });
  assert.ok(refused && 'refuse' in refused && /inside the container "devbox"/.test(refused.refuse), JSON.stringify(refused));
  // Signed in there; a new, empty sign-in folder is not (a Claude Code that keeps sign-ins per folder, R2-I1).
  manager.checkContainerSignInWith = async (_place, folder) => folder === null ? { state: 'out', method: null, detail: null, checkedAt: 0 } : { state: 'in', method: 'claude.ai', detail: null, checkedAt: 0 };
  assert.equal(await manager.containerSignInRefusal('box', { container: 'devbox' }), null);
});
