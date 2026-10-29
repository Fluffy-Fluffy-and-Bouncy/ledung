// Accounts (projects and accounts, P3; issue #342): an account is only a sign-in folder, on this computer and in
// each container its projects run in; conversations, skills and settings stay in the Claude Code folder every
// session shares. Ledung keeps no sign-in token.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { AccountStore, canonicalContainerFolder, SIGN_IN_ENV } from '../src/accounts/store.ts';
import { checkSignIn, runCommand, sdkClaudeBinary, type LoginPlace, type SignIn } from '../src/accounts/signin.ts';
import { keychainEntry, removeSignIn, type RunInput } from '../src/accounts/signin-store.ts';
import { DockerRunner } from '../src/runners/docker-runner.ts';
import { parseConfig, type DockerProjectConfig } from '../src/config.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-accounts-')));
// Ledung's data folder is the test's own: the accounts' default sign-in folders are in it.
process.env.LEDUNG_DATA_DIR = path.join(base, 'data');
fs.mkdirSync(process.env.LEDUNG_DATA_DIR, { recursive: true });
const made: SessionManager[] = [];
after(() => {
  for (const m of made) m.detachAll();
  removeTemp(base);
});

let n = 0;
function setup() {
  const dir = path.join(base, `store-${n++}`);
  const store = new Store(openDatabase(':memory:'));
  return { dir, store, accounts: new AccountStore(store.database, dir) };
}

/** A token account as Ledung kept one before #342: a row of kind "token" and the token in its own file. */
const SIGNED_IN: SignIn = { state: 'in', method: 'claude.ai', detail: null, checkedAt: 0 };
const SIGNED_OUT: SignIn = { state: 'out', method: null, detail: null, checkedAt: 0 };

/** The environment of a real Claude Code with no login of the computer's: no token or key, its own home. */
function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|ANTHROPIC)_/.test(k)) env[k] = v;
  fs.mkdirSync(home, { recursive: true });
  return { ...env, HOME: home, USERPROFILE: home };
}

test('an account is its sign-in folder only: kept once, without a trailing separator, and in containers its own', () => {
  const { dir, accounts } = setup();
  const view = accounts.add({ name: 'personal' });
  assert.equal(view.configDir, path.join(dir, 'personal'));
  assert.ok(fs.statSync(view.configDir).isDirectory(), 'the folder is made');
  // Only the sign-in: no CLAUDE_CONFIG_DIR, so a session keeps the Claude Code folder every session has.
  assert.deepEqual(accounts.envFor('personal'), { [SIGN_IN_ENV]: path.join(dir, 'personal') });
  assert.deepEqual(accounts.envFor('personal', 'docker'), { [SIGN_IN_ENV]: '~/.ledung-accounts/personal' });
  assert.deepEqual(accounts.envFor(null), {});
  // macOS names the Keychain entry from the path exactly as written, so "dir/" would be another login (#342).
  const chosen = accounts.add({ name: 'work', configDir: `${path.join(base, 'logins', 'work')}${path.sep}`, containerDir: '/mnt/logins/work/' });
  assert.equal(chosen.configDir, path.join(base, 'logins', 'work'));
  assert.equal(chosen.containerDir, '/mnt/logins/work');
  assert.deepEqual(accounts.envFor('work', 'docker'), { [SIGN_IN_ENV]: '/mnt/logins/work' });
  for (const bad of ['relative/x', '/a b', "/a'b", '/a/$HOME', '~/../x', '/a\\b']) assert.equal(canonicalContainerFolder(bad), null, bad);
  assert.throws(() => accounts.add({ name: 'c', containerDir: 'logins' }), /folder in containers/);
  assert.throws(() => accounts.add({ name: 'default' }), /not "default"/);
  assert.throws(() => accounts.add({ name: '../x' }), /short name/);
  assert.throws(() => accounts.add({ name: 'personal' }), /already/);
  accounts.remove('personal');
  assert.throws(() => accounts.envFor('personal'), /doesn't exist/);
  assert.ok(fs.existsSync(path.join(dir, 'personal')), 'its folder stays: it is the user\'s');
});

test('the real Claude Code: one shared Claude Code folder, a sign-in folder per account, each its own plan', async () => {
  const binary = sdkClaudeBinary();
  assert.ok(binary && fs.existsSync(binary), `the SDK's Claude Code is installed (${binary})`);
  const root = path.join(base, 'shared-real');
  const shared = path.join(root, 'claude');
  fs.mkdirSync(shared, { recursive: true });
  const env = { ...cleanEnv(path.join(root, 'home')), CLAUDE_CONFIG_DIR: shared };
  for (const [name, plan] of [['a', 'max'], ['b', 'pro']] as const) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-oat01-fake-${name}`, refreshToken: 'sk-ant-ort01-fake', expiresAt: 4102444800000, scopes: ['user:inference'], subscriptionType: plan } }));
  }
  // Claude Code's own answer, as JSON: which plan, and which Claude Code folder it used.
  const status = async (folder: string) => JSON.parse((await runCommand(binary, ['auth', 'status', '--json'], { ...env, [SIGN_IN_ENV]: folder }, 30000)).stdout) as { loggedIn: boolean; subscriptionType?: string; configDirectory: string };
  const a = await status(path.join(root, 'a'));
  const b = await status(path.join(root, 'b'));
  assert.deepEqual([a.loggedIn, a.subscriptionType, b.loggedIn, b.subscriptionType], [true, 'max', true, 'pro']);
  assert.equal(path.resolve(a.configDirectory), path.resolve(shared), 'the same Claude Code folder for both');
  assert.equal(path.resolve(b.configDirectory), path.resolve(shared));
  assert.equal((await checkSignIn({ ...env, [SIGN_IN_ENV]: path.join(root, 'none') })).state, 'out', 'an empty sign-in folder is signed out');
});

function ledung(store: Store, projects: object[]) {
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects }), store, () => {}));
  made.push(manager);
  return manager;
}

test("a container session gets its account's sign-in folder, set inside the container, and its Claude Code folder stays the container user's own", () => {
  const { accounts } = setup();
  accounts.add({ name: 'box' });
  const runner = new DockerRunner({ name: 'c', runner: 'docker', container: 'devbox', user: 'dev', pathInContainer: '/work' } as DockerProjectConfig, 's1');
  const spec = runner.launchSpec({ command: 'claude', args: ['--print'], env: { PATH: '/x', ...accounts.envFor('box', 'docker') } } as never);
  assert.ok(!spec.args.some((a) => a.startsWith(`${SIGN_IN_ENV}=`)), 'not by -e: "~" is the container user\'s home');
  assert.ok(!spec.args.some((a) => a.includes('CLAUDE_CONFIG_DIR')));
  assert.match(spec.args.find((a) => a.includes('exec claude'))!, /CLAUDE_SECURESTORAGE_CONFIG_DIR="\$HOME\/\.ledung-accounts\/box"; export CLAUDE_SECURESTORAGE_CONFIG_DIR; exec claude/);
});

test('removing an account signs each of its folders out with Claude Code', async () => {
  const store = new Store(openDatabase(':memory:'));
  const dir = path.join(process.env.LEDUNG_DATA_DIR!, 'accounts');
  fs.mkdirSync(path.join(dir, 'gone'), { recursive: true });
  store.database.prepare('INSERT INTO accounts (name, kind, config_dir, created_at) VALUES (?, ?, ?, ?)').run('gone', 'folder', path.join(dir, 'gone'), 1);
  const manager = ledung(store, []);
  const signedOut: LoginPlace[] = [];
  manager.signOutWith = async (p) => void signedOut.push(p);
  await manager.removeAccount('gone');
  assert.deepEqual(signedOut, [{ kind: 'local', folder: path.join(dir, 'gone') }]);
  assert.ok(fs.existsSync(path.join(dir, 'gone')), 'the folder stays');
});

test('removing an account signs out the containers its projects ran in, after they left it (I2)', async () => {
  const store = new Store(openDatabase(':memory:'));
  const manager = ledung(store, [{ name: 'c', runner: 'docker', container: 'devbox', user: 'dev', pathInContainer: '/work' }]);
  // Adding an account checks its sign-in at once: answers of the test's own first (#347).
  manager.checkContainerSignInWith = async () => SIGNED_IN;
  manager.checkSignInWith = async () => SIGNED_IN;
  manager.addAccount({ name: 'box' });
  manager.updateProject('c', { name: 'c', runner: 'docker', container: 'devbox', user: 'dev', pathInContainer: '/work', account: 'box' } as never);
  await manager.checkSignIns(['box']);
  manager.updateProject('c', { name: 'c', runner: 'docker', container: 'devbox', user: 'dev', pathInContainer: '/work' } as never);
  const signedOut: LoginPlace[] = [];
  manager.signOutWith = async (p) => void signedOut.push(p);
  const result = await manager.removeAccount('box');
  assert.deepEqual(signedOut.map((p) => p.kind === 'docker' ? `${p.container}:${p.user}:${p.folder}` : 'local'), ['local', 'devbox:dev:~/.ledung-accounts/box']);
  assert.deepEqual(result.skipped, []);
});

test("an account can't use the computer's own login folder or another account's, and one that does is not signed out (I3)", async () => {
  const { accounts } = setup();
  assert.throws(() => accounts.add({ name: 'mine', configDir: path.join(os.homedir(), '.claude') }), /this computer's own Claude Code login folder/);
  accounts.add({ name: 'first', containerDir: '/mnt/logins/shared' });
  assert.throws(() => accounts.add({ name: 'second', configDir: accounts.get('first')!.configDir }), /account "first"/);
  assert.throws(() => accounts.add({ name: 'third', containerDir: '/mnt/logins/shared/' }), /in containers of the account "first"/);
  assert.throws(() => accounts.add({ name: 'fourth', containerDir: '~/.claude' }), /container user's own/);
  if (process.platform === 'win32') {
    assert.throws(() => accounts.add({ name: 'fifth', configDir: accounts.get('first')!.configDir.toUpperCase() }), /account "first"/, 'Windows ignores case');
  }

  // An account from before #342 on the computer's own folder: removing it leaves that login alone.
  const store = new Store(openDatabase(':memory:'));
  store.database.prepare('INSERT INTO accounts (name, kind, config_dir, created_at) VALUES (?, ?, ?, ?)').run('old', 'folder', path.join(os.homedir(), '.claude'), 1);
  const manager = ledung(store, []);
  const signedOut: LoginPlace[] = [];
  manager.signOutWith = async (p) => void signedOut.push(p);
  const result = await manager.removeAccount('old');
  assert.deepEqual(signedOut, [], "the computer's own login is not signed out");
  assert.match(result.skipped.join(), /this computer's own Claude Code login folder/);
});

test('a folder in containers is letters, digits and . _ / + - only, so the shown command runs nothing else (M1)', () => {
  for (const bad of ['/a;rm -rf x', '/a&b', '/a|b', '/a(b)', '/a*', '/a>b', '~', '/']) assert.equal(canonicalContainerFolder(bad), null, bad);
  for (const good of ['~/.ledung-accounts/work', '/mnt/logins/work-2', '/a/b_c.d+e']) assert.equal(canonicalContainerFolder(good), good);
});

// --- Review of #342, round 2 ----------------------------------------------------------------------------------

test("a container whose Claude Code answers for an empty sign-in folder is not trusted: its session start is refused (R2-I1)", async () => {
  // It ignores the sign-in folder and answers with a login of its own, so a session would run on another login.
  const manager = ledung(new Store(openDatabase(':memory:')), []);
  // Adding an account checks its sign-in on this computer too: an answer of the test's own (#347).
  manager.checkSignInWith = async () => SIGNED_OUT;
  manager.addAccount({ name: 'box' });
  manager.checkContainerSignInWith = async () => SIGNED_IN;
  const refused = await manager.containerSignInRefusal('box', { container: 'old' });
  assert.ok(refused && 'refuse' in refused && /doesn't keep sign-ins per folder/.test(refused.refuse), JSON.stringify(refused));
});

test('the real Claude Code with a login of the computer\'s own: an empty sign-in folder is still signed out (R2-I1)', async () => {
  const binary = sdkClaudeBinary();
  assert.ok(binary && fs.existsSync(binary), `the SDK's Claude Code is installed (${binary})`);
  const root = path.join(base, 'fallback-real');
  const shared = path.join(root, 'claude');
  fs.mkdirSync(shared, { recursive: true });
  // The computer's own login, in the Claude Code folder every session shares.
  fs.writeFileSync(path.join(shared, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fake-own', refreshToken: null, expiresAt: null, scopes: ['user:inference'], subscriptionType: 'team' } }));
  const env = { ...cleanEnv(path.join(root, 'home')), CLAUDE_CONFIG_DIR: shared };
  assert.equal((await checkSignIn(env)).state, 'in', "the computer's own login is there");
  fs.mkdirSync(path.join(root, 'empty'));
  assert.equal((await checkSignIn({ ...env, [SIGN_IN_ENV]: path.join(root, 'empty') })).state, 'out', 'an empty sign-in folder does not fall back to it');
});

test('the Keychain entry on macOS is the one Claude Code reads for the folder', () => {
  // The name from Claude Code's code: "Claude Code-credentials-" and the first 8 hex of sha256 of the path as written.
  const folder = '/Users/m/.ledung/accounts/work';
  assert.deepEqual(keychainEntry(folder, 'm'), { service: 'Claude Code-credentials-' + crypto.createHash('sha256').update(folder).digest('hex').slice(0, 8), account: 'm' });
  assert.notDeepEqual(keychainEntry(`${folder}/`, 'm'), keychainEntry(folder, 'm'), 'named from the path exactly as written');
});

test("removing an account removes only its own sign-in: not the other accounts', not the computer's, not the shared details (R2-M4)", async () => {
  const root = path.join(base, 'remove');
  for (const f of ['a', 'b', 'shared']) fs.mkdirSync(path.join(root, f), { recursive: true });
  for (const f of ['a', 'b', 'shared']) fs.writeFileSync(path.join(root, f, '.credentials.json'), f);
  fs.writeFileSync(path.join(root, 'shared', '.claude.json'), '{"oauthAccount":{"emailAddress":"own@example.com"}}');
  await removeSignIn({ kind: 'local', folder: path.join(root, 'a') }, 'win32');
  assert.deepEqual(fs.readdirSync(path.join(root, 'a')), []);
  assert.equal(fs.readFileSync(path.join(root, 'b', '.credentials.json'), 'utf8'), 'b');
  assert.equal(fs.readFileSync(path.join(root, 'shared', '.credentials.json'), 'utf8'), 'shared');
  assert.match(fs.readFileSync(path.join(root, 'shared', '.claude.json'), 'utf8'), /own@example\.com/);
  // On macOS its own Keychain entry, asked for by name, never read; in a container its own file.
  const calls: string[][] = [];
  const run: RunInput = async (_c, args) => {
    calls.push(args);
    return { stdout: '' };
  };
  await removeSignIn({ kind: 'local', folder: '/x/a' }, 'darwin', run);
  assert.deepEqual(calls[0], ['delete-generic-password', '-a', keychainEntry('/x/a').account, '-s', keychainEntry('/x/a').service]);
  await removeSignIn({ kind: 'docker', container: 'box', user: 'dev', folder: '~/.ledung-accounts/a' }, 'linux', run);
  assert.deepEqual(calls[1], ['exec', '-u', 'dev', 'box', 'sh', '-c', 'rm -f "$HOME/.ledung-accounts/a"/.credentials.json']);
});
