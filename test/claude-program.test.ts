// Which Claude Code sessions run (issue #341): the user's installed one, found on the PATH or where its
// installers put it, at least the version the Agent SDK was built against; otherwise none, and sessions are
// refused with how to install or update it. The SDK's own copy only when the config says "bundled". A computer
// is played by an in-memory Lookup, so Windows, macOS and Linux are all checked everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atLeast, chooseClaude, commandFor, findInstalled, forgetVersions, INSTALL_LINK, parseVersion, programVersion, shimTarget, type Lookup } from '../src/runners/claude-program.ts';
import { checkSignIn, type RunCommand } from '../src/accounts/signin.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Session } from '../src/sessions/session.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { problemParts, runningPrograms } from '../web/src/claudeProgram.ts';
import { parseConfig } from '../src/config.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const BUNDLED_WIN = 'C:\\led\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe';
const BUNDLED_NIX = '/opt/ledung/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude';

/** A computer with these files (path → contents), links (path → target) and `--version` answers (path → text). */
function computer(opts: {
  platform: NodeJS.Platform;
  files: Record<string, string>;
  links?: Record<string, string>;
  versions?: Record<string, string>;
  env?: Record<string, string>;
  bundled?: string | null;
  required?: string | null;
}): Lookup & { asked: string[] } {
  const asked: string[] = [];
  const real = (f: string) => opts.links?.[f] ?? f;
  return {
    asked,
    platform: opts.platform,
    env: opts.env ?? {},
    home: opts.platform === 'win32' ? 'C:\\Users\\sam' : '/home/sam',
    stat: (f) => (real(f) in opts.files ? { size: opts.files[real(f)]!.length, mtimeMs: 1 } : null),
    readText: (f) => opts.files[real(f)] ?? null,
    realpath: real,
    versionText: async (p) => { asked.push(p); return opts.versions?.[p] ?? null; },
    bundled: opts.bundled === undefined ? (opts.platform === 'win32' ? BUNDLED_WIN : BUNDLED_NIX) : opts.bundled,
    required: opts.required === undefined ? '2.1.295' : opts.required,
  };
}

const withBundled = (platform: NodeJS.Platform, files: Record<string, string>) => ({ ...files, [platform === 'win32' ? BUNDLED_WIN : BUNDLED_NIX]: 'bin' });

test('claude --version is read as x.y.z, and versions compare by number', () => {
  // As Claude Code prints it (2.1.304 and the SDK's 2.1.295, 2026-10-27).
  assert.equal(parseVersion('2.1.304 (Claude Code)\n'), '2.1.304');
  assert.equal(parseVersion('Unknown option --version'), null);
  assert.equal(parseVersion(''), null);
  assert.ok(atLeast('2.1.295', '2.1.295'));
  assert.ok(atLeast('2.1.304', '2.1.295'));
  assert.ok(atLeast('2.10.0', '2.9.999'), 'by number, not as text');
  assert.ok(atLeast('3.0.0', '2.1.295'));
  assert.ok(!atLeast('2.1.294', '2.1.295'));
  assert.ok(!atLeast('1.99.999', '2.0.0'));
});

test('the installed claude on the PATH is chosen when it is new enough (Windows)', async () => {
  forgetVersions();
  const mine = 'C:\\Users\\sam\\.local\\bin\\claude.exe';
  const look = computer({ platform: 'win32', files: withBundled('win32', { [mine]: 'bin' }), versions: { [mine]: '2.1.304 (Claude Code)', [BUNDLED_WIN]: '2.1.295 (Claude Code)' }, env: { Path: 'C:\\Windows;C:\\Users\\sam\\.local\\bin' } });
  const c = await chooseClaude('installed', look);
  assert.deepEqual(c.program, { kind: 'installed', path: mine, version: '2.1.304' });
  assert.equal(c.problem, null);
  assert.equal(c.required, '2.1.295');
  assert.deepEqual(c.bundled, { kind: 'bundled', path: BUNDLED_WIN, version: '2.1.295' });
});

test('the same version as the SDK is new enough', async () => {
  forgetVersions();
  const mine = '/usr/local/bin/claude';
  const look = computer({ platform: 'darwin', files: withBundled('darwin', { [mine]: 'bin' }), versions: { [mine]: '2.1.295 (Claude Code)' }, env: { PATH: '/usr/bin:/usr/local/bin' } });
  assert.equal((await chooseClaude('installed', look)).program?.kind, 'installed');
});

test('without claude on the PATH, the native installer\'s ~/.local/bin and Homebrew are looked in (macOS, Linux)', async () => {
  forgetVersions();
  const local = '/home/sam/.local/bin/claude';
  const look = computer({ platform: 'linux', files: withBundled('linux', { [local]: 'bin' }), versions: { [local]: '2.1.300 (Claude Code)' }, env: { PATH: '/usr/bin' } });
  assert.equal(findInstalled(look), local);
  const brew = '/opt/homebrew/bin/claude';
  const mac = computer({ platform: 'darwin', files: withBundled('darwin', { [brew]: 'bin' }), env: { PATH: '/usr/bin' } });
  assert.equal(findInstalled(mac), brew);
  const win = computer({ platform: 'win32', files: withBundled('win32', { 'C:\\Users\\sam\\.local\\bin\\claude.exe': 'bin' }), env: {} });
  assert.equal(findInstalled(win), 'C:\\Users\\sam\\.local\\bin\\claude.exe');
});

test('an npm install is run through the program its shim or link names', async () => {
  forgetVersions();
  // Windows: npm's claude.cmd names the package's program relative to its own folder.
  const shim = 'C:\\Users\\sam\\AppData\\Roaming\\npm\\claude.cmd';
  const cli = 'C:\\Users\\sam\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
  const shimText = '@ECHO off\r\nSET dp0=%~dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  const win = computer({ platform: 'win32', files: withBundled('win32', { [shim]: shimText, [cli]: 'js' }), env: { Path: 'C:\\Users\\sam\\AppData\\Roaming\\npm', APPDATA: 'C:\\Users\\sam\\AppData\\Roaming' } });
  assert.equal(shimTarget(shim, win), cli);
  assert.equal(findInstalled(win), cli);
  // A shim naming nothing that exists isn't taken.
  const broken = computer({ platform: 'win32', files: withBundled('win32', { [shim]: shimText }), env: { Path: 'C:\\Users\\sam\\AppData\\Roaming\\npm' } });
  assert.equal(findInstalled(broken), null);
  // macOS and Linux: npm's bin is a link to the package's JavaScript file, which runs with Node.
  const link = '/usr/local/bin/claude';
  const js = '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js';
  const nix = computer({ platform: 'linux', files: withBundled('linux', { [js]: 'js' }), links: { [link]: js }, env: { PATH: '/usr/local/bin' } });
  assert.equal(findInstalled(nix), js);
  assert.deepEqual(commandFor(js), { command: process.execPath, args: [js] });
  assert.deepEqual(commandFor('/usr/local/bin/claude'), { command: '/usr/local/bin/claude', args: [] });
});

test("Ledung's own copy is never taken for the user's, even on a PATH an npm script set", async () => {
  forgetVersions();
  const binLink = '/opt/ledung/node_modules/.bin/claude';
  const look = computer({ platform: 'linux', files: withBundled('linux', {}), links: { [binLink]: BUNDLED_NIX }, env: { PATH: '/opt/ledung/node_modules/.bin:/usr/bin' } });
  assert.equal(findInstalled(look), null);
  const c = await chooseClaude('installed', look);
  assert.equal(c.program, null, 'nor run in its place');
});

test('no installed Claude Code: nothing to run, and the problem says where to install it from', async () => {
  forgetVersions();
  const look = computer({ platform: 'win32', files: withBundled('win32', {}), versions: { [BUNDLED_WIN]: '2.1.295 (Claude Code)' }, env: { Path: 'C:\\Windows' } });
  const c = await chooseClaude('installed', look);
  assert.equal(c.program, null, 'the bundled copy is not run in its place');
  assert.equal(c.installed, null);
  assert.equal(c.problem, `Ledung runs your Claude Code, and it isn't installed on this computer. Install it from ${INSTALL_LINK}, then press Check again.`);
  assert.equal(INSTALL_LINK, 'https://code.claude.com/docs/en/setup');
});

test('an installed Claude Code older than the SDK needs is not run, and the problem says to update it', async () => {
  forgetVersions();
  const mine = '/home/sam/.local/bin/claude';
  const look = computer({ platform: 'linux', files: withBundled('linux', { [mine]: 'bin' }), versions: { [mine]: '2.1.200 (Claude Code)' }, env: { PATH: '/home/sam/.local/bin' } });
  const c = await chooseClaude('installed', look);
  assert.equal(c.program, null);
  assert.deepEqual(c.installed, { kind: 'installed', path: mine, version: '2.1.200' });
  assert.equal(c.problem, 'Ledung runs your Claude Code, and yours is 2.1.200; Ledung needs 2.1.295 or newer. Update it (`claude update`), then press Check again.');
});

test("an installed Claude Code whose version can't be read is not run either", async () => {
  forgetVersions();
  const mine = '/home/sam/.local/bin/claude';
  const look = computer({ platform: 'linux', files: withBundled('linux', { [mine]: 'bin' }), versions: { [mine]: 'error: something' }, env: { PATH: '/home/sam/.local/bin' } });
  const c = await chooseClaude('installed', look);
  assert.equal(c.program, null);
  assert.match(c.problem ?? '', /couldn't be read\. Update it \(`claude update`\)/);
});

test('a path in the setting is run when it is new enough, and refused like an installed one when not', async () => {
  forgetVersions();
  const given = 'D:\\tools\\claude.exe';
  const ok = computer({ platform: 'win32', files: withBundled('win32', { [given]: 'bin' }), versions: { [given]: '2.1.310 (Claude Code)' } });
  assert.deepEqual((await chooseClaude(given, ok)).program, { kind: 'path', path: given, version: '2.1.310' });
  forgetVersions();
  const old = computer({ platform: 'win32', files: withBundled('win32', { [given]: 'bin' }), versions: { [given]: '2.0.1 (Claude Code)' } });
  const c = await chooseClaude(given, old);
  assert.equal(c.program, null);
  assert.match(c.problem ?? '', /yours is 2\.0\.1; Ledung needs 2\.1\.295 or newer/);
  const missing = await chooseClaude(given, computer({ platform: 'win32', files: withBundled('win32', {}) }));
  assert.equal(missing.program, null);
  assert.match(missing.problem ?? '', /there is none at D:\\tools\\claude\.exe \(the config's "claudeExecutable"\)/);
});

test(`"bundled", set in the config, runs the SDK's copy without looking for another`, async () => {
  forgetVersions();
  const mine = '/usr/local/bin/claude';
  const look = computer({ platform: 'linux', files: withBundled('linux', { [mine]: 'bin' }), versions: { [mine]: '2.1.400 (Claude Code)', [BUNDLED_NIX]: '2.1.295 (Claude Code)' }, env: { PATH: '/usr/local/bin' } });
  const c = await chooseClaude('bundled', look);
  assert.deepEqual(c.program, { kind: 'bundled', path: BUNDLED_NIX, version: '2.1.295' });
  assert.equal(c.problem, null);
  assert.ok(!look.asked.includes(mine));
  const none = await chooseClaude('bundled', computer({ platform: 'linux', files: {}, bundled: null }));
  assert.equal(none.program, null);
  assert.match(none.problem ?? '', /no Claude Code of its own/);
});

test('"bundled" in an npm install says the package has no copy and to install Claude Code and set "installed" (#421)', async () => {
  forgetVersions();
  // The npm package's shrinkwrap leaves the SDK's per-platform copies out, so none is found.
  const c = await chooseClaude('bundled', { ...computer({ platform: 'darwin', files: {}, bundled: null }), packaged: true });
  assert.equal(c.program, null);
  assert.match(c.problem ?? '', /^Ledung installed from npm has no Claude Code of its own/);
  assert.match(c.problem ?? '', /Install Claude Code from https:\/\/code\.claude\.com\/docs\/en\/setup, then set "claudeExecutable" back to "installed"/);
  assert.doesNotMatch(c.problem ?? '', /for darwin-/);
});

test('a version is read once per file, and again once the file changes (an update)', async () => {
  forgetVersions();
  const mine = '/usr/local/bin/claude';
  const files: Record<string, string> = { [mine]: 'bin' };
  const versions: Record<string, string> = { [mine]: '2.1.300 (Claude Code)' };
  const look = computer({ platform: 'linux', files, versions });
  assert.equal(await programVersion(mine, look), '2.1.300');
  assert.equal(await programVersion(mine, look), '2.1.300');
  assert.equal(look.asked.length, 1);
  files[mine] = 'newer bin';
  versions[mine] = '2.1.310 (Claude Code)';
  assert.equal(await programVersion(mine, look), '2.1.310');
  assert.equal(look.asked.length, 2);
});

test('the sign-in check runs a JavaScript Claude Code with Node', async () => {
  let ran: string[] = [];
  const run: RunCommand = async (command, args) => { ran = [command, ...args]; return { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' }; };
  await checkSignIn({}, { binary: '/x/cli.js', run });
  assert.deepEqual(ran, [process.execPath, '/x/cli.js', 'auth', 'status', '--json']);
  await checkSignIn({}, { binary: '/x/claude', run });
  assert.deepEqual(ran, ['/x/claude', 'auth', 'status', '--json']);
});

/** Starts a session on a runner that chooses `choice`, and returns what the SDK was given and what was recorded. */
async function startWith(choice: Awaited<ReturnType<typeof chooseClaude>> | undefined, airgap = false, attach?: { program: { kind: 'installed' | 'bundled' | 'path'; path: string } | null; queryError?: Error }) {
  const store = new Store(openDatabase(':memory:'));
  let info = store.createSession({ id: 's', project: 'p', runner: 'local', title: 'S', parentId: null, permissionMode: 'default', role: 'session' });
  if (attach) {
    store.updateSession('s', { status: 'idle', claudeProgram: attach.program });
    info = store.getSession('s')!;
  }
  let given: { pathToClaudeCodeExecutable?: string } | null = null;
  const stream = { close: () => {}, accountInfo: async () => ({}), [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }) };
  // As LocalRunner: the version is the chosen program's, none without one.
  const runner = { cwd: '.', prepare: async () => {}, claudeVersion: async () => (choice ? choice.program?.version ?? null : '2.1.304'), currentBranch: async () => null, ...(choice ? { claudeProgram: async () => choice } : {}) };
  const session = new Session({
    info, store, publish: () => {}, userName: 'Simon',
    management: { managerOf: () => null, questionTiers: () => [] } as never,
    runner: runner as never,
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    query: ((q: { options: { pathToClaudeCodeExecutable?: string } }) => {
      if (attach?.queryError) throw attach.queryError;
      given = q.options;
      return stream;
    }) as never,
    airgap: airgap ? { network: [], folders: [], sandbox: false } : null,
    ...(attach ? { attachTo: 'pipe-of-a-running-host' } : {}),
  });
  let threw: Error | null = null;
  await session.start().catch((e: Error) => { threw = e; });
  if (threw && !attach?.queryError) throw threw;
  const events = store.allMessages('s').filter((m) => m.kind === 'event').map((m) => (m.data as { text: string }).text);
  return { given: given as { pathToClaudeCodeExecutable?: string } | null, session: store.getSession('s')!, events, threw: threw as Error | null };
}

const MINE = 'C:\\Users\\sam\\.local\\bin\\claude.exe';
/** What this setting chooses on a Windows computer with `installed` as the user's Claude Code version (none: not installed). */
async function choice(setting: string, installed: string | null) {
  forgetVersions();
  const files = withBundled('win32', installed ? { [MINE]: 'bin' } : {});
  return chooseClaude(setting, computer({ platform: 'win32', files, versions: { [MINE]: `${installed} (Claude Code)`, [BUNDLED_WIN]: '2.1.295 (Claude Code)' }, env: { Path: 'C:\\Users\\sam\\.local\\bin' } }));
}

test('a session starts the installed Claude Code, and records which one', async () => {
  const r = await startWith(await choice('installed', '2.1.304'));
  assert.equal(r.given?.pathToClaudeCodeExecutable, MINE);
  assert.deepEqual(r.session.claudeProgram, { kind: 'installed', path: MINE });
  assert.notEqual(r.session.status, 'ended');
});

test('a session start is refused when Claude Code is not installed, with how to install it', async () => {
  const r = await startWith(await choice('installed', null));
  assert.equal(r.given, null, 'Claude Code never started, the bundled copy neither');
  assert.equal(r.session.status, 'ended');
  assert.match(r.session.endReason ?? '', /isn't installed on this computer\. Install it from https:\/\/code\.claude\.com\/docs\/en\/setup/);
  assert.ok(r.events.some((e) => /^Could not start: Ledung runs your Claude Code/.test(e)));
});

test('a session start is refused when the installed Claude Code is too old, with how to update it', async () => {
  const r = await startWith(await choice('installed', '2.1.200'));
  assert.equal(r.given, null);
  assert.equal(r.session.status, 'ended');
  assert.match(r.session.endReason ?? '', /yours is 2\.1\.200; Ledung needs 2\.1\.295 or newer\. Update it \(`claude update`\)/);
});

test(`with "bundled" in the config, a session runs the SDK's own copy`, async () => {
  const r = await startWith(await choice('bundled', null));
  assert.equal(r.given?.pathToClaudeCodeExecutable, undefined, 'the SDK starts its own copy');
  assert.deepEqual(r.session.claudeProgram, { kind: 'bundled', path: BUNDLED_WIN });
  assert.notEqual(r.session.status, 'ended');
});

test('a container session names no program: the container runs its own claude', async () => {
  const r = await startWith(undefined);
  // Named only for the SDK, which looks for a copy of its own without one and has none in an npm install
  // (review of PR #441); the container's launch runs `claude` whatever the name.
  assert.equal(r.given?.pathToClaudeCodeExecutable, 'claude');
  assert.equal(r.session.claudeProgram, null);
});

// Review of PR #441: without a path the SDK looks for its own copy of Claude Code, which an npm install
// doesn't have, so reattaching after Restart Ledung threw and Ledung exited on start.
test('a session reattached after Restart Ledung gives the SDK the program its host runs, never no path', async () => {
  const r = await startWith(await choice('installed', '2.1.304'), false, { program: { kind: 'installed', path: MINE } });
  assert.equal(r.given?.pathToClaudeCodeExecutable, MINE, 'the program it was started with');
  assert.notEqual(r.session.status, 'ended');
  assert.ok(r.events.includes('Ledung restarted; reconnected to the running session.'));
  // Started before Ledung recorded its program: still a path.
  const old = await startWith(await choice('installed', '2.1.304'), false, { program: null });
  assert.equal(old.given?.pathToClaudeCodeExecutable, 'claude');
});

test('a reattach whose query fails never says it reconnected (review of PR #441, round 2)', async () => {
  // The SDK's own error when it has no program to run, thrown from the real start, not a stub of it.
  const r = await startWith(await choice('installed', '2.1.304'), false, { program: { kind: 'installed', path: MINE }, queryError: new Error('Native CLI binary for darwin-arm64 not found.') });
  assert.match(r.threw?.message ?? '', /Native CLI binary/, 'the error reaches the manager, which reports it');
  assert.ok(!r.events.some((e) => /reconnected/.test(e)), r.events.join(' | '));
});

test("Settings lists each running session with the program it was started with", () => {
  const base = { title: 'T', project: 'p', claudeVersion: '2.1.304' };
  const rows = runningPrograms([
    { ...base, id: 'a', status: 'idle', runner: 'local', claudeProgram: { kind: 'installed', path: '/home/sam/.local/bin/claude' } },
    { ...base, id: 'b', status: 'running', runner: 'local', claudeProgram: { kind: 'bundled', path: BUNDLED_NIX } },
    { ...base, id: 'c', status: 'idle', runner: 'docker', claudeProgram: null },
    { ...base, id: 'd', status: 'idle', runner: 'local', claudeProgram: null },
    { ...base, id: 'e', status: 'ended', runner: 'local', claudeProgram: { kind: 'installed', path: '/x' } },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.runs, r.path]), [
    ['a', 'your installed Claude Code', '/home/sam/.local/bin/claude'],
    ['b', 'the copy that came with Ledung', BUNDLED_NIX],
    ['c', "the container's own", null],
    ['d', 'not recorded (started before Ledung recorded it)', null],
  ]);
});

test(`the config's "claudeExecutable" is installed by default, bundled, or a full path`, () => {
  assert.equal(parseConfig({}).claudeExecutable, 'installed');
  assert.equal(parseConfig({ claudeExecutable: 'bundled' }).claudeExecutable, 'bundled');
  const full = process.platform === 'win32' ? 'C:\\tools\\claude.exe' : '/opt/claude/bin/claude';
  assert.equal(parseConfig({ claudeExecutable: full }).claudeExecutable, full);
  assert.throws(() => parseConfig({ claudeExecutable: 'claude' }), /claudeExecutable is "installed", "bundled" or a full path/);
});

test(`the page's banner says when Claude Code is missing, and goes once it is fine`, async () => {
  const events: unknown[] = [];
  const missing = process.platform === 'win32' ? 'C:\\nowhere\\claude.exe' : '/nowhere/claude';
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', claudeExecutable: missing }), new Store(openDatabase(':memory:')), (e) => events.push(e)));
  manager.checkSignInWith = async () => ({ state: 'in', method: null, detail: null, checkedAt: 1 });
  await manager.checkSignIns();
  assert.match(manager.accountsEvent().claudeProblem ?? '', /Ledung runs your Claude Code, and there is none at .*nowhere/);
  assert.ok(events.some((e) => (e as { type: string; claudeProblem?: string }).type === 'accounts' && !!(e as { claudeProblem?: string }).claudeProblem), 'the page is told');
  const fine = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', claudeExecutable: 'bundled' }), new Store(openDatabase(':memory:')), () => {}));
  fine.checkSignInWith = async () => ({ state: 'in', method: null, detail: null, checkedAt: 1 });
  await fine.checkSignIns();
  assert.equal(fine.accountsEvent().claudeProblem, null);
});

test(`a problem's text shows its command as code and its address as a link`, () => {
  assert.deepEqual(problemParts('Install it from https://code.claude.com/docs/en/setup, then press Check again.'), [
    { kind: 'text', text: 'Install it from ' }, { kind: 'link', text: 'https://code.claude.com/docs/en/setup' }, { kind: 'text', text: ', then press Check again.' },
  ]);
  assert.deepEqual(problemParts('Update it (`claude update`), then.'), [
    { kind: 'text', text: 'Update it (' }, { kind: 'code', text: 'claude update' }, { kind: 'text', text: '), then.' },
  ]);
});

test(`at lockdown level B, a missing Claude Code is refused with how to install it, not with the airgap's version text`, async () => {
  const r = await startWith(await choice('installed', null), true);
  assert.equal(r.given, null);
  assert.equal(r.session.status, 'ended');
  assert.match(r.session.endReason ?? '', /isn't installed on this computer\. Install it from https:\/\/code\.claude\.com\/docs\/en\/setup/);
});

test("when the SDK's own version can't be read, no installed Claude Code is run unchecked", async () => {
  forgetVersions();
  const mine = '/usr/local/bin/claude';
  const look = computer({ platform: 'linux', files: withBundled('linux', { [mine]: 'bin' }), versions: { [mine]: '2.1.304 (Claude Code)' }, env: { PATH: '/usr/local/bin' }, required: null });
  const c = await chooseClaude('installed', look);
  assert.equal(c.program, null);
  assert.match(c.problem ?? '', /could not read which Claude Code version its Agent SDK needs/);
});
