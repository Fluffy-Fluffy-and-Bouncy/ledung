// Finding Claude Code where a friend had it (#455): the Claude desktop app's own copy, WinGet, and a PATH an
// installer changed while Ledung ran; every place it looked is shown; and Check again always answers. A
// computer is played by an in-memory Lookup, so Windows and macOS are both checked everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chooseClaude, desktopAppFolders, forgetVersions, INSTALL_LINK, installCommand, regValue, searchInstalled, type Lookup } from '../src/runners/claude-program.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { parseConfig } from '../src/config.ts';
import { checkAgainNote } from '../web/src/claudeProgram.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const BUNDLED_WIN = 'C:\\led\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe';
const BUNDLED_MAC = '/opt/ledung/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude';
const ROAMING = 'C:\\Users\\sam\\AppData\\Roaming';
const LOCAL = 'C:\\Users\\sam\\AppData\\Local';
/** Where the desktop app kept its Claude Code on Windows, as seen on 2026-11-01 (version 2.1.49). */
const APP_DIR = `${ROAMING}\\Claude\\claude-code`;

/** A computer with these files and `--version` answers; folders are what the files' paths imply. */
function computer(opts: { platform: NodeJS.Platform; files: string[]; versions?: Record<string, string>; env?: Record<string, string>; freshPath?: string | null }): Lookup & { asked: string[] } {
  const p = opts.platform === 'win32' ? path.win32 : path.posix;
  const bundled = opts.platform === 'win32' ? BUNDLED_WIN : BUNDLED_MAC;
  const files = new Set([...opts.files, bundled]);
  const asked: string[] = [];
  return {
    asked,
    platform: opts.platform,
    env: opts.env ?? (opts.platform === 'win32' ? { Path: 'C:\\Windows', APPDATA: ROAMING, LOCALAPPDATA: LOCAL } : { PATH: '/usr/bin' }),
    home: opts.platform === 'win32' ? 'C:\\Users\\sam' : '/Users/sam',
    stat: (f) => (files.has(f) ? { size: 1, mtimeMs: 1 } : null),
    readText: () => null,
    realpath: (f) => f,
    versionText: async (f) => { asked.push(f); return opts.versions?.[f] ?? null; },
    listDir: (dir) => [...new Set([...files].filter((f) => f.startsWith(dir + p.sep)).map((f) => f.slice(dir.length + 1).split(p.sep)[0]!))],
    ...(opts.freshPath !== undefined ? { freshPath: async () => opts.freshPath ?? null } : {}),
    bundled,
    required: '2.1.295',
  };
}

test('with only the desktop app, its own Claude Code is run when new enough: the newest of its versions (Windows)', async () => {
  forgetVersions();
  const old = `${APP_DIR}\\2.1.49\\claude.exe`;
  const fresh = `${APP_DIR}\\2.1.300\\claude.exe`;
  const look = computer({ platform: 'win32', files: [old, fresh], versions: { [old]: '2.1.49 (Claude Code)', [fresh]: '2.1.300 (Claude Code)' } });
  const c = await chooseClaude('installed', look);
  assert.equal(c.problem, null);
  assert.deepEqual(c.program, { kind: 'installed', path: fresh, version: '2.1.300', app: true });
  assert.ok(!look.asked.includes(old), 'the older version folder is not run');
});

test("a desktop app copy older than Ledung needs: the banner names it, its version, and the command to install Claude Code", async () => {
  forgetVersions();
  // The layout and version seen on this machine's desktop app (2026-11-01).
  const copy = `${APP_DIR}\\2.1.49\\claude.exe`;
  const c = await chooseClaude('installed', computer({ platform: 'win32', files: [copy], versions: { [copy]: '2.1.49 (Claude Code)' } }));
  assert.equal(c.program, null);
  assert.deepEqual(c.installed, { kind: 'installed', path: copy, version: '2.1.49', app: true });
  assert.equal(c.problem, `Ledung runs your Claude Code, and the only one on this computer is the Claude desktop app's own copy, 2.1.49 at ${copy}; Ledung needs 2.1.295 or newer. The app keeps that copy for itself: install Claude Code (\`irm https://claude.ai/install.ps1 | iex\`, or see ${INSTALL_LINK}), then press Check again.`);
  assert.doesNotMatch(c.problem!, /isn't installed/);
  assert.equal(installCommand('darwin'), 'curl -fsSL https://claude.ai/install.sh | bash');
});

test('the desktop app copy is looked for in the Microsoft Store package and in the Mac app\'s data folder', async () => {
  forgetVersions();
  const store = `${LOCAL}\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude-code\\2.1.300\\claude.exe`;
  const win = computer({ platform: 'win32', files: [store], versions: { [store]: '2.1.300 (Claude Code)' } });
  assert.deepEqual(desktopAppFolders(win), [APP_DIR, `${LOCAL}\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude-code`]);
  assert.equal((await chooseClaude('installed', win)).program?.path, store);
  const mac = '/Users/sam/Library/Application Support/Claude/claude-code/2.1.300/claude';
  const c = await chooseClaude('installed', computer({ platform: 'darwin', files: [mac], versions: { [mac]: '2.1.300 (Claude Code)' } }));
  assert.deepEqual(c.program, { kind: 'installed', path: mac, version: '2.1.300', app: true });
});

test("a Claude Code of the user's own comes before the desktop app's copy", async () => {
  forgetVersions();
  const mine = 'C:\\Users\\sam\\.local\\bin\\claude.exe';
  const copy = `${APP_DIR}\\2.1.400\\claude.exe`;
  const c = await chooseClaude('installed', computer({ platform: 'win32', files: [mine, copy], versions: { [mine]: '2.1.300 (Claude Code)', [copy]: '2.1.400 (Claude Code)' } }));
  assert.deepEqual(c.program, { kind: 'installed', path: mine, version: '2.1.300' });
});

test("the desktop app's own program, also named claude.exe, is never run, even on the PATH", async () => {
  forgetVersions();
  const appDir = `${LOCAL}\\AnthropicClaude\\app-1.1.4173`;
  const look = computer({ platform: 'win32', files: [`${appDir}\\claude.exe`], env: { Path: appDir, APPDATA: ROAMING, LOCALAPPDATA: LOCAL } });
  const c = await chooseClaude('installed', look);
  assert.equal(c.installed, null);
  assert.deepEqual(look.asked, [BUNDLED_WIN], '--version would open its window: only the SDK copy was asked');
});

test('a WinGet install is found by its link, off the PATH', async () => {
  forgetVersions();
  const link = `${LOCAL}\\Microsoft\\WinGet\\Links\\claude.exe`;
  assert.equal(searchInstalled(computer({ platform: 'win32', files: [link] })).program, link);
  const machine = 'C:\\Program Files\\WinGet\\Links\\claude.exe';
  assert.equal(searchInstalled(computer({ platform: 'win32', files: [machine] })).program, machine);
});

test('every place looked is listed, in order: the PATH, the installers\' places, the desktop app\'s folders', async () => {
  forgetVersions();
  const c = await chooseClaude('installed', computer({ platform: 'win32', files: [] }));
  assert.deepEqual(c.looked, [
    'C:\\Windows\\claude.exe', 'C:\\Windows\\claude.cmd',
    'C:\\Users\\sam\\.local\\bin\\claude.exe', `${ROAMING}\\npm\\claude.cmd`,
    `${LOCAL}\\Microsoft\\WinGet\\Links\\claude.exe`, 'C:\\Program Files\\WinGet\\Links\\claude.exe',
    `${APP_DIR}\\<version>\\claude.exe`,
  ]);
  const mac = await chooseClaude('installed', computer({ platform: 'darwin', files: [] }));
  assert.equal(mac.looked?.at(-1), '/Users/sam/Library/Application Support/Claude/claude-code/<version>/claude');
  assert.equal(mac.looked?.[0], '/usr/bin/claude');
});

test('installed while Ledung runs: a PATH the installer changed since is read again and the new claude found', async () => {
  forgetVersions();
  const dir = 'D:\\tools\\claude';
  const exe = `${dir}\\claude.exe`;
  const look = computer({ platform: 'win32', files: [exe], versions: { [exe]: '2.1.300 (Claude Code)' }, freshPath: `C:\\Windows;${dir}` });
  const c = await chooseClaude('installed', look);
  assert.deepEqual(c.program, { kind: 'installed', path: exe, version: '2.1.300' });
  assert.ok(c.looked?.includes(exe), 'the new folder is listed too');
  assert.equal(c.looked?.filter((l) => l === 'C:\\Windows\\claude.exe').length, 1, 'each place once');
  // Not read when the PATH Ledung has already finds one.
  let read = 0;
  const mine = 'C:\\Users\\sam\\.local\\bin\\claude.exe';
  const found = { ...computer({ platform: 'win32', files: [mine], versions: { [mine]: '2.1.300 (Claude Code)' } }), freshPath: async () => { read++; return null; } };
  await chooseClaude('installed', found);
  assert.equal(read, 0);
});

test("the registry's Path is read as reg query prints it, with %NAME% filled in", () => {
  const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Tools\r\n\r\n';
  assert.equal(regValue(out, 'Path', { USERPROFILE: 'C:\\Users\\sam' }), 'C:\\Users\\sam\\.local\\bin;C:\\Tools');
  assert.equal(regValue('    Path    REG_SZ    C:\\A', 'path', {}), 'C:\\A');
  assert.equal(regValue('ERROR: The system was unable to find the specified registry key or value.', 'Path', {}), null);
  assert.equal(regValue('    Path    REG_SZ    %NOPE%\\x', 'Path', {}), '%NOPE%\\x', 'an unknown name stays as written');
});

test('Check again always answers: the time and "still the same" when nothing changed, nothing once the problem went', () => {
  assert.equal(checkAgainNote(true, new Date(2026, 10, 1, 21, 40, 5)), 'Checked again at 21:40:05: still the same.');
  assert.equal(checkAgainNote(true, new Date(2026, 10, 1, 9, 3, 0)), 'Checked again at 09:03:00: still the same.');
  assert.equal(checkAgainNote(false, new Date()), null);
});

test("the page gets where Ledung looked with the Claude Code problem, and nothing once it is fine", async () => {
  const missing = process.platform === 'win32' ? 'C:\\nowhere\\claude.exe' : '/nowhere/claude';
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', claudeExecutable: missing }), new Store(openDatabase(':memory:')), () => {}));
  manager.checkSignInWith = async () => ({ state: 'in', method: null, detail: null, checkedAt: 1 });
  await manager.checkSignIns();
  assert.deepEqual(manager.accountsEvent().claudeLooked, [missing]);
  const fine = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', claudeExecutable: 'bundled' }), new Store(openDatabase(':memory:')), () => {}));
  fine.checkSignInWith = async () => ({ state: 'in', method: null, detail: null, checkedAt: 1 });
  await fine.checkSignIns();
  assert.deepEqual(fine.accountsEvent().claudeLooked, []);
});
