// `ledung account token <name>` (issue #85): a long-lived token goes into Claude Code's own store from the user's own
// terminal, never through Ledung's server or page, and the page can tell how an account is signed in. Every token
// here is made up. No test reaches the real Keychain: the real command runs only where it stops before the store, or
// with stand-ins alone on its PATH (no-real-signin-store.test.ts holds the rest to that).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleCore } from '../scripts/build-package.ts';
import { readSignIn, signInKind, tokenCommand, type SignIn } from '../src/accounts/signin.ts';
import { keychainEntry, localStore, signInRecord, CREDENTIALS, type RunInput } from '../src/accounts/signin-store.ts';
import { AccountStore } from '../src/accounts/store.ts';
import { accountCommand, applyKeys, cleanToken, folderOnlyEnv, readHidden, type TokenCommandDeps } from '../src/accounts/token-command.ts';
import { parseConfig } from '../src/config.ts';
import { appDir } from '../src/platform/paths.ts';
import { sdkClaudeVersion } from '../src/runners/claude-program.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { HANG_MS } from './limits.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { signedInWith } from '../web/src/projects/signedInWith.ts';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-token-')));
process.env.LEDUNG_DATA_DIR = path.join(base, 'data');
fs.mkdirSync(process.env.LEDUNG_DATA_DIR, { recursive: true });
const made: SessionManager[] = [];
after(() => {
  for (const m of made) m.detachAll();
  removeTemp(base);
});

const FAKE = `sk-ant-oat01-${'x'.repeat(60)}_FAKE-for-tests`;
const TOKEN_SIGN_IN: SignIn = { state: 'in', method: 'claude.ai', kind: 'token', detail: null, checkedAt: 0 };

/** The command with everything around it replaced; `lines` is what it said. */
function deps(over: Partial<TokenCommandDeps> = {}) {
  const lines: string[] = [];
  const stored: { folder: string; record: string }[] = [];
  const all: TokenCommandDeps = {
    findAccount: async () => ({ folder: '/accounts/work' }),
    readToken: async () => FAKE,
    store: { hasSignIn: async () => false, put: async (folder, record) => void stored.push({ folder, record }) },
    check: async () => TOKEN_SIGN_IN,
    print: (line) => void lines.push(line),
    ...over,
  };
  return { all, lines, stored };
}

// The JSON below is what Claude Code 2.1.316 printed on 2026-11-02, without the fields that say who it is; for a token,
// a made-up one in a throwaway folder's Keychain entry.
test('how an account is signed in is told from what claude auth status prints, for each kind (probe of 2026-11-02)', () => {
  const said = (json: object, code = 0) => readSignIn({ code, stdout: JSON.stringify(json) });
  assert.equal(said({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }).kind, 'login');
  assert.equal(said({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: null }).kind, 'token');
  assert.equal(said({ loggedIn: true, authMethod: 'oauth_token' }).kind, 'token');
  assert.equal(said({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }).kind, 'key');
  assert.equal(said({ loggedIn: false, authMethod: 'none' }, 1).kind, undefined);
  // A Claude Code that leaves the field out can't be told apart: not called a token.
  assert.equal(signInKind('claude.ai', undefined), null);
  assert.equal(signInKind('something new', null), null);
});

test('a token is taken only as `claude setup-token` gives one, line ends from a wrapped paste dropped', () => {
  assert.equal(cleanToken(`${FAKE}\n`), FAKE);
  assert.equal(cleanToken(`  ${FAKE.slice(0, 30)}\n${FAKE.slice(30)}\r\n`), FAKE);
  assert.equal(cleanToken(`${FAKE.slice(0, 30)}\n    ${FAKE.slice(30)}`), FAKE);
  for (const bad of ['', 'hello', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz', 'sk-ant-oat01-short', `${FAKE}"; rm -rf`, `${FAKE} and more`, `${FAKE}\n\nStore this token safely`, `${FAKE}\nStore this token safely`, `${FAKE}${FAKE}`, `${FAKE}\n${FAKE}`, `${FAKE}\r${FAKE}`, `${FAKE}\n    ${FAKE}`]) assert.equal(cleanToken(bad), null, bad);
});

test('hidden typing: Enter ends it, a line end inside a paste does not, backspace and Ctrl+C work, arrows are ignored', () => {
  assert.deepEqual(applyKeys('', 'abc\r'), { held: 'abc', done: 'enter' });
  // Kept for cleanToken to judge, which is where a wrap is told from text after the token.
  assert.deepEqual(applyKeys('', 'abc\ndef'), { held: 'abc\ndef', done: null });
  assert.equal(cleanToken(applyKeys('', `${FAKE.slice(0, 30)}\n${FAKE.slice(30)}\r`).held), FAKE);
  assert.equal(cleanToken(applyKeys('', `${FAKE}\n\nStore\r`).held), null);
  // The same with CR, which is what a terminal in raw mode sends for Enter and so for a paste's line ends.
  assert.deepEqual(applyKeys('', 'abc\rdef'), { held: 'abc\rdef', done: null });
  assert.equal(cleanToken(applyKeys('', `${FAKE.slice(0, 30)}\r${FAKE.slice(30)}\r`).held), FAKE);
  assert.equal(cleanToken(applyKeys('', `${FAKE}\r\rStore\r`).held), null);
  assert.deepEqual(applyKeys('abc', '\x7f\x7fz'), { held: 'az', done: null });
  assert.deepEqual(applyKeys('abc', '\x03'), { held: '', done: 'stop' });
  assert.deepEqual(applyKeys('abc', '\x1b[A\x1b[D'), { held: 'abc', done: null });
  assert.deepEqual(applyKeys('abc', '\x04'), { held: 'abc', done: 'enter' });
});

test('the terminal is put in raw mode, so nothing is echoed, and always back', async () => {
  const input = Object.assign(new EventEmitter(), { modes: [] as boolean[], setRawMode(on: boolean) { this.modes.push(on); }, resume() {}, pause() {} });
  const reading = readHidden(input as never);
  input.emit('data', Buffer.from(FAKE));
  input.emit('data', Buffer.from('\r'));
  assert.equal(await reading, FAKE);
  assert.deepEqual(input.modes, [true, false]);
  const stopped = readHidden(input as never);
  input.emit('data', Buffer.from('\x03'));
  assert.equal(await stopped, null);
  assert.deepEqual(input.modes, [true, false, true, false]);
});

test('the record stored is the shape Claude Code gives such a token: no refresh token, no expiry, no plan', async () => {
  const d = deps();
  assert.equal(await accountCommand(['token', 'work'], d.all), 0);
  assert.equal(d.stored.length, 1);
  assert.equal(d.stored[0]!.folder, '/accounts/work');
  assert.deepEqual(JSON.parse(d.stored[0]!.record), { claudeAiOauth: { accessToken: FAKE, refreshToken: null, expiresAt: null, scopes: ['user:inference'], subscriptionType: null, rateLimitTier: null } });
  assert.ok(d.lines.some((l) => /signed in with a long-lived token/.test(l)), d.lines.join('\n'));
});

test('the command never says the token, however it ends', async () => {
  const ends: Partial<TokenCommandDeps>[] = [
    {},
    { check: async () => ({ state: 'out', method: null, detail: null, checkedAt: 0 }) },
    { check: async () => ({ state: 'unknown', method: null, detail: 'no Claude Code', checkedAt: 0 }) },
    { store: { hasSignIn: async () => true, put: async () => { throw new Error('the Keychain could not be written'); } } },
  ];
  for (const over of ends) {
    const d = deps(over);
    await accountCommand(['token', 'work'], d.all);
    assert.ok(d.lines.length, 'it says something');
    assert.ok(!d.lines.join('\n').includes(FAKE.slice(13)), d.lines.join('\n'));
  }
});

test('a store that fails, or stopping at the prompt, is a failure that says so and stores nothing', async () => {
  const failed = deps({ store: { hasSignIn: async () => true, put: async () => { throw new Error('the Keychain could not be written'); } }, check: async () => { throw new Error('asked after a failed store'); } });
  assert.equal(await accountCommand(['token', 'work'], failed.all), 1);
  assert.match(failed.lines.join('\n'), /could not be stored.*Nothing was changed/);
  assert.doesNotMatch(failed.lines.join('\n'), /is in Claude Code's sign-in/);
  assert.deepEqual(failed.stored, []);
  const stopped = deps({ readToken: async () => null });
  assert.equal(await accountCommand(['token', 'work'], stopped.all), 1);
  assert.match(stopped.lines.join('\n'), /Stopped/);
  assert.deepEqual(stopped.stored, []);
});

test('text after the token is refused, not glued on and stored', async () => {
  for (const pasted of [`${FAKE} and more`, `${FAKE}\n\nStore this token safely`]) {
    const d = deps({ readToken: async () => pasted });
    assert.equal(await accountCommand(['token', 'work'], d.all), 1);
    assert.deepEqual(d.stored, []);
    assert.match(d.lines.join('\n'), /not a long-lived token.*Nothing was changed/);
    assert.ok(!d.lines.join('\n').includes(FAKE.slice(13)), d.lines.join('\n'));
  }
});

test('a token on the command line is refused, not stored and not repeated', async () => {
  const d = deps();
  assert.equal(await accountCommand(['token', 'work', FAKE], d.all), 2);
  assert.deepEqual(d.stored, []);
  assert.ok(!d.lines.join('\n').includes(FAKE));
});

test('wrong use: no name, another word, a name that is no account', async () => {
  for (const args of [[], ['token'], ['list'], ['token', 'not a name']]) assert.equal(await accountCommand(args, deps().all), 2, args.join(' '));
  const d = deps({ findAccount: async () => ({ names: ['home', 'work'] }), readToken: async () => { throw new Error('asked for a token for no account'); } });
  assert.equal(await accountCommand(['token', 'nope'], d.all), 1);
  assert.match(d.lines.join('\n'), /no account named "nope".*home, work/);
});

test('it says plainly when it did not work: not signed in, still a /login, another login, or Claude Code not there', async () => {
  const answers: [SignIn, RegExp][] = [
    [{ state: 'out', method: null, detail: null, checkedAt: 0 }, /did NOT work.*not signed in/],
    // The write didn't take and the old sign-in still answers: "signed in" alone would have called that a success.
    [{ state: 'in', method: 'claude.ai', kind: 'login', detail: null, checkedAt: 0 }, /did NOT work.*\/login/],
    // A key in Claude Code's shared settings answers for any folder.
    [{ state: 'in', method: 'api_key', kind: 'key', detail: null, checkedAt: 0 }, /did NOT work.*api_key/],
    [{ state: 'unknown', method: null, detail: 'no Claude Code to ask', checkedAt: 0 }, /could not be asked.*no Claude Code to ask/],
  ];
  for (const [answer, says] of answers) {
    const d = deps({ check: async () => answer });
    assert.equal(await accountCommand(['token', 'work'], d.all), 1);
    assert.match(d.lines.join('\n'), says);
  }
});

test('an account signed in already: the sign-in is replaced, and it says so', async () => {
  const stored: string[] = [];
  const d = deps({ store: { hasSignIn: async () => true, put: async (_folder, record) => void stored.push(record) } });
  assert.equal(await accountCommand(['token', 'work'], d.all), 0);
  assert.deepEqual(stored, [signInRecord(FAKE)]);
  assert.match(d.lines.join('\n'), /in place of the sign-in that was there/);
});

test('Claude Code is asked about the folder alone: a token or key in the terminal could answer for it', () => {
  const env = folderOnlyEnv({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'x', ANTHROPIC_API_KEY: 'y', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/other', LEDUNG_DATA_DIR: '/d', CLAUDE_CONFIG_DIR: '/shared' }, '/accounts/work');
  assert.deepEqual(env, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/shared', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/accounts/work' });
});

test('the Keychain: the record on standard input as hex, never on a command line, replacing the entry that is there', async () => {
  const calls: { command: string; args: string[]; input: string | null }[] = [];
  const run: RunInput = async (command, args, input) => {
    calls.push({ command, args, input });
    return { stdout: '' };
  };
  const store = localStore('darwin', run);
  const record = signInRecord(FAKE);
  await store.put('/accounts/work', record);
  const { service, account } = keychainEntry('/accounts/work');
  assert.deepEqual(calls[0]!.args, ['-i']);
  assert.equal(calls[0]!.command, 'security');
  assert.equal(calls[0]!.input, `add-generic-password -U -a "${account}" -s "${service}" -X ${Buffer.from(record).toString('hex')}\n`);
  assert.ok(!calls[0]!.args.join(' ').includes(FAKE));
});

test('the Keychain: asked only whether an entry is there, and what `security` says of a failure stays out', async () => {
  const fails = (code: number): RunInput => async () => { throw Object.assign(new Error('secret output'), { code, stderr: 'secret output' }); };
  assert.equal(await localStore('darwin', fails(44)).hasSignIn('/accounts/work'), false);
  // The whole text to the end: `security`'s own words, which the fake puts in its error, would show after it.
  await assert.rejects(localStore('darwin', fails(36)).hasSignIn('/accounts/work'), /^Error: the Keychain could not be read; if it is locked, `security unlock-keychain` unlocks it$/);
  await assert.rejects(localStore('darwin', fails(1)).put('/accounts/work', '{}'), /^Error: the Keychain could not be written; if it is locked, `security unlock-keychain` unlocks it$/);
  const asked: string[][] = [];
  await localStore('darwin', async (_c, args) => { asked.push(args); return { stdout: '' }; }).hasSignIn('/accounts/work');
  assert.ok(!asked[0]!.includes('-w'), 'without -w it prints no secret');
});

test('the credentials file: made whole, readable only by the user, replacing the one that is there, no temporary left', async () => {
  const folder = path.join(base, 'file-store');
  const store = localStore('win32');
  assert.equal(await store.hasSignIn(folder), false);
  await store.put(folder, signInRecord(FAKE));
  assert.equal(await store.hasSignIn(folder), true);
  await store.put(folder, signInRecord(`${FAKE}2`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, CREDENTIALS), 'utf8')).claudeAiOauth.accessToken, `${FAKE}2`);
  assert.deepEqual(fs.readdirSync(folder), [CREDENTIALS]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(folder, CREDENTIALS)).mode & 0o777, 0o600);
});

test('the command the page shows: ledung from the package, the copy\'s own cli.ts otherwise, and a data folder of its own', () => {
  assert.equal(tokenCommand('work', { packaged: true, appDir: '/app' }), 'ledung account token work');
  assert.equal(tokenCommand('work', { packaged: false, appDir: path.join(path.sep, 'app') }), `node "${path.join(path.sep, 'app', 'src', 'cli.ts')}" account token work`);
  assert.equal(tokenCommand('work', { packaged: true, appDir: '/app', dataDir: '/d' }), 'LEDUNG_DATA_DIR="/d" ledung account token work');
  assert.equal(tokenCommand('work', { packaged: true, appDir: '/app', dataDir: 'C:\\d', platform: 'win32' }), '$env:LEDUNG_DATA_DIR="C:\\d"; ledung account token work');
});

test('the page gets, with each account, how it is signed in and the commands; adding one answers with them too', async () => {
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port: 4397 }), store, () => {}));
  made.push(manager);
  manager.checkSignInWith = async () => TOKEN_SIGN_IN;
  const added = manager.addAccount({ name: 'work' });
  assert.match(added.tokenCommand!, /account token work$/);
  assert.ok(added.loginCommand!.includes(added.configDir));
  await manager.checkSignIns();
  const event = manager.accountsEvent();
  assert.equal(event.accounts[0]!.signInKind, 'token');
  assert.equal(event.defaultIdentity?.signInKind, 'token');
});

test('a sign-in Ledung can\'t classify reads plain "Signed in", never "Not signed in" (Martin, 2026-11-02, question #519)', async () => {
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port: 4397 }), store, () => {}));
  made.push(manager);
  manager.checkSignInWith = async () => readSignIn({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'something new' }) });
  manager.addAccount({ name: 'work' });
  await manager.checkSignIns();
  const event = manager.accountsEvent();
  assert.equal(event.accounts[0]!.signInKind, 'other');
  assert.equal(event.defaultIdentity?.signInKind, 'other');
  assert.equal(signedInWith(event.accounts[0]!.signInKind), 'Signed in');
  assert.equal(signedInWith('token'), 'Signed in with a long-lived token');
  assert.equal(signedInWith(null), 'Not signed in, or not checked yet');
});

test('an account not checked yet, or signed out, is not called signed in', async () => {
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port: 4397 }), store, () => {}));
  made.push(manager);
  manager.checkSignInWith = async () => ({ state: 'out', method: null, detail: null, checkedAt: 0 });
  manager.addAccount({ name: 'work' });
  await manager.checkSignIns();
  assert.equal(manager.accountsEvent().accounts[0]!.signInKind, null);
  assert.equal(manager.accountsEvent().defaultIdentity, null);
  manager.checkSignInWith = async () => ({ state: 'unknown', method: null, detail: 'no answer', checkedAt: 0 });
  await manager.checkSignIns();
  assert.equal(manager.accountsEvent().accounts[0]!.signInKind, null);
});

/** A data folder with Ledung's own database and these accounts. */
function dataWith(name: string, accounts: string[]): string {
  const data = path.join(base, name);
  fs.mkdirSync(data, { recursive: true });
  const db = openDatabase(path.join(data, 'ledung.db'));
  const store = new AccountStore(db, path.join(data, 'accounts'));
  for (const a of accounts) store.add({ name: a });
  db.close();
  return data;
}

let packaged: Promise<string> | null = null;

/** The command as the package has it, made once: package.json above dist/, the dependencies where npm would install them. */
function bundledCommand(): Promise<string> {
  packaged ??= (async () => {
    const pkg = path.join(base, 'pkg');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ledung', version: '9.8.7', type: 'module' }));
    fs.symlinkSync(path.join(appDir(), 'node_modules'), path.join(pkg, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await bundleCore(appDir(), path.join(pkg, 'dist'));
    return path.join(pkg, 'dist', 'cli.js');
  })();
  return packaged;
}

test('the real command, from source and from the bundle, finds accounts in Ledung\'s database without starting Ledung', async () => {
  const data = dataWith('real-command', ['home', 'work']);
  for (const entry of [path.join(appDir(), 'src', 'cli.ts'), await bundledCommand()]) {
    // A name that is no account stops before the token and the store.
    const r = spawnSync(process.execPath, [entry, 'account', 'token', 'nope'], { env: { ...process.env, LEDUNG_DATA_DIR: data }, encoding: 'utf8', input: FAKE });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /no account named "nope".*Its accounts: home, work/);
    assert.doesNotMatch(r.stderr, /Warning/);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(FAKE));
    const used = spawnSync(process.execPath, [entry, 'account'], { env: { ...process.env, LEDUNG_DATA_DIR: data }, encoding: 'utf8' });
    assert.equal(used.status, 2);
  }
});

/**
 * Stand-ins for `security` and `claude`, for a PATH with nothing else on it, so the real Keychain and Claude Code can't
 * be reached. Each notes what it was given in `log`. The stand-in `security` has no entry yet, and the stand-in `claude`
 * answers as the probe of 2026-11-02 saw a token only when asked about `folder`.
 */
function standIns(name: string, folder: string): { dir: string; log: string } {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.jsonl');
  const note = `import fs from 'node:fs';\nconst note = (what) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(what) + '\\n');\nconst args = process.argv.slice(2);\n`;
  fs.writeFileSync(path.join(dir, 'claude.mjs'), `${note}
if (args[0] === '--version') { console.log(${JSON.stringify(`${sdkClaudeVersion()} (Claude Code)`)}); process.exit(0); }
const asked = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
note({ program: 'claude', args, asked, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, key: process.env.ANTHROPIC_API_KEY ?? null });
const here = asked === ${JSON.stringify(folder)};
console.log(JSON.stringify(here ? { loggedIn: true, authMethod: 'claude.ai', subscriptionType: null } : { loggedIn: false, authMethod: 'none' }));
process.exit(here ? 0 : 1);
`);
  fs.writeFileSync(path.join(dir, 'security.mjs'), `${note}
note({ program: 'security', args, input: fs.readFileSync(0, 'utf8') });
process.exit(args[0] === 'find-generic-password' ? 44 : 0);
`);
  if (process.platform === 'win32') {
    // The file store needs no `security`; an npm shim is how Ledung finds a JavaScript `claude` on Windows.
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '@"%~dp0\\claude.mjs" %*\r\n');
  } else {
    fs.symlinkSync(path.join(dir, 'claude.mjs'), path.join(dir, 'claude'));
    fs.writeFileSync(path.join(dir, 'security'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(dir, 'security.mjs'))} "$@"\n`, { mode: 0o755 });
  }
  return { dir, log };
}

test('the real command past the lookup, from source and from the bundle: the record reaches the store on standard input, and Claude Code is asked about the account\'s folder alone', async () => {
  const data = dataWith('past-lookup', ['work']);
  const folder = path.join(data, 'accounts', 'work');
  assert.ok(fs.statSync(folder).isDirectory());
  const { dir, log } = standIns('stand-ins', folder);
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  Object.assign(env, { PATH: dir, HOME: dir, LEDUNG_DATA_DIR: data, LEDUNG_CONFIG: path.join(data, 'no-config.json'), CLAUDE_CODE_OAUTH_TOKEN: 'the-terminals-own', ANTHROPIC_API_KEY: 'the-terminals-own' });
  const record = signInRecord(FAKE);
  const hex = Buffer.from(record).toString('hex');
  for (const entry of [path.join(appDir(), 'src', 'cli.ts'), await bundledCommand()]) {
    fs.rmSync(log, { force: true });
    const r = spawnSync(process.execPath, [entry, 'account', 'token', 'work'], { env, encoding: 'utf8', input: `${FAKE}\n`, timeout: HANG_MS });
    const said = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, said);
    assert.match(r.stdout, /Claude Code sees it/);
    assert.ok(!said.includes(FAKE.slice(13)) && !said.includes(hex), said);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { program: string; args: string[]; input?: string; asked?: string; token?: string | null; key?: string | null });
    assert.deepEqual(calls.at(-1), { program: 'claude', args: ['auth', 'status', '--json'], asked: folder, token: null, key: null });
    if (process.platform === 'darwin') {
      const { service, account } = keychainEntry(folder);
      assert.deepEqual(calls.slice(0, -1), [
        { program: 'security', args: ['find-generic-password', '-a', account, '-s', service], input: '' },
        { program: 'security', args: ['-i'], input: `add-generic-password -U -a "${account}" -s "${service}" -X ${hex}\n` },
      ]);
    } else {
      const file = path.join(folder, CREDENTIALS);
      assert.equal(fs.readFileSync(file, 'utf8'), record);
      fs.rmSync(file);
    }
  }
});

test('a Ledung with no database yet: told to add the account, not an error', () => {
  const data = path.join(base, 'empty');
  const r = spawnSync(process.execPath, [path.join(appDir(), 'src', 'cli.ts'), 'account', 'token', 'work'], { env: { ...process.env, LEDUNG_DATA_DIR: data }, encoding: 'utf8', input: FAKE });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /no account named "work".*Add it under Settings/);
});

test('only the command reaches the token code: nothing the server, the page or a session runs writes a sign-in', () => {
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? (e.name === 'dist' ? [] : files(full)) : /\.tsx?$/.test(e.name) ? [full] : [];
  });
  const users = (pattern: RegExp) => [...files(path.join(appDir(), 'src')), ...files(path.join(appDir(), 'web', 'src'))]
    .filter((f) => pattern.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(appDir(), f).split(path.sep).join('/')).sort();
  assert.deepEqual(users(/\b(localStore|signInRecord)\b/), ['src/accounts/signin-store.ts', 'src/accounts/token-command.ts']);
  assert.deepEqual(users(/token-command\.ts'/), ['src/cli.ts']);
});
