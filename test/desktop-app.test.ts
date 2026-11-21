// The desktop app from the npm package (issue #407, src/platform/desktop-app.ts and desktop/made.ts): where the made app
// lives, when it is made again, the code and settings it is given, when `ledung` may open it ("desktopApp": false,
// Ledung question #585), and what a failed make does (one line, then the browser). Downloading Electron and the Mac's
// plutil and codesign steps are checked by hand against a packed build (the PR's test plan): they need the network and
// a 121 MB download, and the 'all' make is never reached here.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  AFTER_APP_ARG, afterApp, APP_ID, APP_ONLY_ARG, installedVersion, MADE_CONFIG, madeConfigFor, readMadeConfig, readStartUpdate, reloadRestarts, restartBrings,
  START_HIDDEN_FILE, START_UPDATE_RETRY_MS, updateAtStart, WRITE_SHORTCUT_ARG, type MadeConfig,
} from '../desktop/made.ts';
import { findOnPath, restartCommand, runStart, startCommand } from '../desktop/start.ts';
import {
  ADD_COMMAND, APP_SHORTCUT, appManifest, backgroundArgs, codeIntoKept, desktopAppOff, desktopAppState, desktopAvailability, electronPackage,
  ensureApp, madeApp, madePaths, NO_APP, noticeFile, offersApp, openChoice, openDesktop, openMadeApp, trayOpen, progressPrinter, readStamp, setExeDetails, waitForExit, whatToMake, writeAppCode,
  writeAppShortcut, type Availability, type MadePaths, type OpenSteps, type Stamp,
} from '../src/platform/desktop-app.ts';
import { icoFromPng } from '../src/platform/icons.ts';
import { appDir } from '../src/platform/paths.ts';
import { removeAppShortcut, Shortcuts } from '../src/platform/shortcuts.ts';
import { parseConfig, SETTING_RELOAD } from '../src/config.ts';
import { listenOk } from './free-port.ts';
import { removeTemp } from './temp.ts';

let base: string;
before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-desktop-app-'));
  // The EXERCISED trace of a make goes to the data folder: this test's own, also when run outside npm test.
  process.env.LEDUNG_DATA_DIR = path.join(base, 'data-dir');
});
after(() => removeTemp(base));

const config: MadeConfig = { node: '/usr/bin/node', cli: '/pkg/dist/cli.js', env: {} };
const stamp = (over: Partial<Stamp> = {}): Stamp => ({ electron: '45.4.1', platform: 'darwin', arch: 'arm64', ledung: '1.2', config, ...over });

/** A folder like an installed package: dist/desktop/ with the app's files, and Electron's package.json when `electron`. */
function fakePackage(name: string, electron: string | null): string {
  const app = path.join(base, name);
  fs.mkdirSync(path.join(app, 'dist', 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'ledung', version: '1.2', type: 'module' }));
  for (const file of ['main.js', 'preload.cjs', 'not-running.html', 'icon-512.png']) fs.writeFileSync(path.join(app, 'dist', 'desktop', file), file);
  if (electron) {
    fs.mkdirSync(path.join(app, 'node_modules', 'electron'), { recursive: true });
    fs.writeFileSync(path.join(app, 'node_modules', 'electron', 'package.json'), JSON.stringify({ name: 'electron', version: electron }));
  }
  return app;
}

test('the made app has one fixed place in the data folder, per system', () => {
  const data = path.join(base, 'data');
  const mac = madePaths(data, 'darwin');
  assert.equal(mac.bundle, path.join(data, 'desktop', 'Ledung.app'));
  assert.equal(mac.exe, path.join(mac.bundle, 'Contents', 'MacOS', 'Electron'));
  assert.equal(mac.code, path.join(mac.bundle, 'Contents', 'Resources', 'app'));
  const win = madePaths(data, 'win32');
  assert.equal(win.exe, path.join(data, 'desktop', 'Ledung', 'Ledung.exe'));
  assert.equal(win.code, path.join(data, 'desktop', 'Ledung', 'resources', 'app'));
  const linux = madePaths(data, 'linux');
  assert.equal(linux.exe, path.join(data, 'desktop', 'ledung', 'ledung'));
  for (const p of [mac, win, linux]) {
    assert.equal(p.stamp, path.join(data, 'desktop', 'stamp.json'));
    assert.ok(!path.relative(p.root, p.work).startsWith('..'), 'the making folder is inside desktop/, so it is cleared with it');
  }
});

test('the app is made again for a new Electron or system, its code only for a new Ledung or Node, nothing when all match', () => {
  assert.equal(whatToMake(stamp(), stamp(), true), 'nothing');
  assert.equal(whatToMake(null, stamp(), true), 'all', 'no stamp');
  assert.equal(whatToMake(stamp(), stamp(), false), 'all', 'the app was removed');
  assert.equal(whatToMake(stamp({ electron: '45.3.3' }), stamp(), true), 'all');
  assert.equal(whatToMake(stamp({ arch: 'x64' }), stamp(), true), 'all');
  assert.equal(whatToMake(stamp({ platform: 'linux' }), stamp(), true), 'all');
  assert.equal(whatToMake(stamp({ ledung: '1.1' }), stamp(), true), 'code');
  assert.equal(whatToMake(stamp({ config: { ...config, node: '/old/node' } }), stamp(), true), 'code');
  assert.equal(whatToMake(stamp({ config: { ...config, env: { LEDUNG_DATA_DIR: '/t' } } }), stamp(), true), 'code');
  const file = path.join(base, 'stamp.json');
  fs.writeFileSync(file, JSON.stringify(stamp()));
  assert.deepEqual(readStamp(file), stamp());
  fs.writeFileSync(file, '{ broken');
  assert.equal(readStamp(file), null);
  assert.equal(readStamp(path.join(base, 'no-stamp.json')), null);
});

test('the app is offered only from the npm package with Electron installed, on a system with a display', () => {
  const full = fakePackage('full', '45.4.1');
  const display = { DISPLAY: ':0' };
  const ok = desktopAvailability({ app: full, packaged: true, env: display, platform: 'linux' });
  assert.deepEqual(ok, { ok: true, electron: { dir: fs.realpathSync(path.join(full, 'node_modules', 'electron')), version: '45.4.1' }, source: path.join(full, 'dist', 'desktop') });
  assert.equal(desktopAvailability({ app: full, packaged: true, env: {}, platform: 'darwin' }).ok, true, 'the Mac needs no DISPLAY');
  const reason = (a: ReturnType<typeof desktopAvailability>) => (a.ok ? '' : a.reason);
  assert.match(reason(desktopAvailability({ app: full, packaged: false, env: display, platform: 'linux' })), /clone/);
  assert.match(reason(desktopAvailability({ app: full, packaged: true, env: {}, platform: 'linux' })), /no display/);
  assert.equal(desktopAvailability({ app: full, packaged: true, env: { WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux' }).ok, true);
  assert.match(reason(desktopAvailability({ app: full, packaged: true, env: display, platform: 'freebsd' })), /not made for freebsd/);
  const without = fakePackage('without', null);
  assert.equal(electronPackage(without), null);
  assert.equal(reason(desktopAvailability({ app: without, packaged: true, env: display, platform: 'linux' })), `The desktop app is not installed: Electron's package is missing (its optional install failed or was left out). To add it, ${ADD_COMMAND}.`);
  const noCode = fakePackage('no-code', '45.4.1');
  fs.rmSync(path.join(noCode, 'dist', 'desktop'), { recursive: true });
  assert.match(reason(desktopAvailability({ app: noCode, packaged: true, env: display, platform: 'linux' })), /no desktop app/);
});

test('"desktopApp": false in the config keeps `ledung` on the browser; anything else leaves the app on (Ledung question #585)', () => {
  const file = path.join(base, 'switch.json');
  const off = (body: string | null) => {
    if (body === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, body);
    return desktopAppOff(file);
  };
  assert.equal(off('{"desktopApp": false}'), true);
  assert.equal(off('{"desktopApp": true}'), false);
  assert.equal(off('{"port": 4397}'), false);
  assert.equal(off('{ broken'), false);
  assert.equal(off(null), false);
  // The config itself knows the setting: on by default, applied without a restart (the command reads it each run).
  assert.equal(parseConfig({}).desktopApp, true);
  assert.equal(parseConfig({ desktopApp: false }).desktopApp, false);
  assert.equal(SETTING_RELOAD.desktopApp, 'live');
});

test("the app's code is the package's dist/desktop, a package.json naming it Ledung, and the made config; old files go", () => {
  const source = path.join(fakePackage('code-src', null), 'dist', 'desktop');
  const code = path.join(base, 'made', 'resources', 'app');
  fs.mkdirSync(code, { recursive: true });
  fs.writeFileSync(path.join(code, 'stale.js'), 'old');
  const made = madeConfigFor('/n/node', '/p/dist/cli.js', { LEDUNG_DATA_DIR: '/t/data' });
  writeAppCode(code, source, '1.2', made);
  assert.deepEqual(fs.readdirSync(code).sort(), ['icon-512.png', MADE_CONFIG, 'main.js', 'not-running.html', 'package.json', 'preload.cjs'].sort());
  const manifest = JSON.parse(fs.readFileSync(path.join(code, 'package.json'), 'utf8'));
  assert.deepEqual(manifest, appManifest('1.2'));
  assert.equal(manifest.productName, 'Ledung', "Electron's app name: the Mac menu, Linux's window class");
  assert.equal(manifest.main, 'main.js');
  assert.deepEqual(readMadeConfig(code), made);
});

test('the made config carries the Node, the command and only LEDUNG_CONFIG and LEDUNG_DATA_DIR; a bad file is none', () => {
  const made = madeConfigFor('/n/node', '/p/cli.js', { LEDUNG_CONFIG: 'rel/config.json', LEDUNG_DATA_DIR: '', LEDUNG_PORT: '1', PATH: '/usr/bin' });
  assert.deepEqual(made, { node: '/n/node', cli: '/p/cli.js', env: { LEDUNG_CONFIG: path.resolve('rel/config.json') } });
  assert.deepEqual(madeConfigFor('/n/node', '/p/cli.js', {}).env, {}, 'a Ledung on the usual folders passes nothing on');
  const dir = path.join(base, 'made-config');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(readMadeConfig(dir), null, 'a clone run has none');
  fs.writeFileSync(path.join(dir, MADE_CONFIG), JSON.stringify({ node: '/n', cli: '/c', env: { LEDUNG_DATA_DIR: '/d', PATH: '/x', LEDUNG_CONFIG: 3 } }));
  assert.deepEqual(readMadeConfig(dir), { node: '/n', cli: '/c', env: { LEDUNG_DATA_DIR: '/d' } }, 'only the two settings, only as text');
  fs.writeFileSync(path.join(dir, MADE_CONFIG), JSON.stringify({ node: '/n' }));
  assert.equal(readMadeConfig(dir), null);
  assert.equal(APP_ID, 'org.ledung.app');
});

test("the made app's Start runs the Node and command that made it, with no PATH at all, as from Finder or the Start menu", async () => {
  const dir = path.join(base, 'finder');
  fs.mkdirSync(dir, { recursive: true });
  const cli = path.join(dir, 'cli.mjs');
  fs.writeFileSync(cli, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(`${cli}.out`)}, JSON.stringify(process.argv.slice(2)));\n`);
  const made: MadeConfig = { node: process.execPath, cli, env: {} };
  const cmd = startCommand({}, made);
  assert.deepEqual(cmd, { command: process.execPath, args: [cli, '--no-open'] });
  assert.deepEqual(await runStart(cmd, {}), { ok: true }, 'an empty environment: no PATH to find `ledung` on');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${cli}.out`, 'utf8')), ['--no-open']);
  // That Node gone (upgraded, moved): the command on PATH, as before; the test setting still comes first.
  assert.deepEqual(startCommand({}, { ...made, node: path.join(dir, 'no-node') }), { command: 'ledung', args: ['--no-open'] });
  assert.deepEqual(startCommand({ LEDUNG_DESKTOP_START: cli }, made), { command: 'node', args: [cli, '--no-open'] });
});

test('Windows: a full path to node.exe is a program; a bare name still is not', () => {
  const dir = path.join(base, 'win');
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'node.exe');
  const bare = path.join(dir, 'ledung');
  fs.writeFileSync(exe, '');
  fs.writeFileSync(bare, '');
  const env = { PATHEXT: '.COM;.EXE;.CMD' };
  assert.equal(findOnPath(exe, env, 'win32'), exe);
  assert.equal(findOnPath(bare, env, 'win32'), null);
  // An environment with no PATHEXT at all (the made app's Start from nothing, self-check finding 1): Windows' default.
  assert.equal(findOnPath(exe, {}, 'win32'), exe);
  assert.equal(findOnPath(bare, {}, 'win32'), null);
});

/** A made app in `data` as an earlier make left it, without a real Electron: the bundle's program and a stamp. */
function madeEarlier(data: string, platform: NodeJS.Platform, earlier: Stamp): MadePaths {
  const paths = madePaths(data, platform);
  fs.mkdirSync(path.dirname(paths.exe), { recursive: true });
  fs.writeFileSync(paths.exe, 'electron');
  fs.mkdirSync(paths.code, { recursive: true });
  fs.writeFileSync(path.join(paths.code, 'main.js'), 'old code');
  fs.writeFileSync(paths.stamp, JSON.stringify(earlier));
  return paths;
}

test('a new Ledung rewrites only the app code and the stamp; the same Ledung touches nothing', async () => {
  const pkg = fakePackage('update', '45.4.1');
  const electron = electronPackage(pkg)!;
  const data = path.join(base, 'update-data');
  const want = { electron: '45.4.1', platform: 'linux', arch: 'x64', ledung: '1.2', config } satisfies Stamp;
  const paths = madeEarlier(data, 'linux', { ...want, ledung: '1.1' });
  const lines: string[] = [];
  const opts = { dataDir: data, electron, source: path.join(pkg, 'dist', 'desktop'), ledungVersion: '1.2', config, platform: 'linux' as const, arch: 'x64', print: (l: string) => lines.push(l) };
  assert.equal((await ensureApp(opts)).made, 'code');
  assert.equal(fs.readFileSync(path.join(paths.code, 'main.js'), 'utf8'), 'main.js', 'the new code');
  assert.equal(fs.readFileSync(paths.exe, 'utf8'), 'electron', 'Electron itself untouched');
  assert.deepEqual(readStamp(paths.stamp), want);
  assert.deepEqual(lines, [], 'no download was announced');
  assert.equal(fs.existsSync(paths.work), false, 'the making folder is gone');
  fs.writeFileSync(path.join(paths.code, 'main.js'), 'kept');
  assert.equal((await ensureApp(opts)).made, 'nothing');
  assert.equal(fs.readFileSync(path.join(paths.code, 'main.js'), 'utf8'), 'kept');
});

/** Steps that record what happened instead of making, opening or starting a browser. */
function steps(over: Partial<OpenSteps> = {}): OpenSteps & { lines: string[]; browsers: number } {
  const rec = {
    lines: [] as string[],
    browsers: 0,
    ensure: async () => ({ made: 'nothing' as const, paths: madePaths(base, 'darwin') }),
    open: async () => null,
    browser: () => { rec.browsers++; },
    print: (line: string) => { rec.lines.push(line); },
    ...over,
  };
  return rec;
}

const make = () => ({ dataDir: base, electron: { dir: base, version: '45.4.1' }, source: base, ledungVersion: '1.2', config });

test('a made and opened app is all `ledung` does: no browser, exit 0', async () => {
  const s = steps();
  assert.equal(await openDesktop({ make: make(), fallback: true, steps: s }), 0);
  assert.equal(s.browsers, 0);
  assert.deepEqual(s.lines, []);
});

test('a failed download says so in one line and opens the browser instead; `ledung app` only says why (issue #407)', async () => {
  const failing = () => steps({
    ensure: async (o) => {
      o.print?.('Making the desktop app, once: downloading Electron 45.4.1');
      throw new Error('fetch failed\n    at node:internal/deps/undici');
    },
  });
  const s = failing();
  assert.equal(await openDesktop({ make: make(), fallback: true, steps: s }), 0);
  assert.equal(s.browsers, 1);
  assert.deepEqual(s.lines, [
    'Making the desktop app, once: downloading Electron 45.4.1',
    'Ledung is already running: to use the browser instead, press Ctrl+C and run "ledung --browser".',
    'The desktop app could not be made: fetch failed. Opening Ledung in the browser instead.',
  ]);
  const app = failing();
  assert.equal(await openDesktop({ make: make(), fallback: false, steps: app }), 1);
  assert.equal(app.browsers, 0);
  assert.equal(app.lines.at(-1), 'The desktop app could not be made: fetch failed');
  assert.ok(!app.lines.some((l) => l.includes('--browser')), '`ledung app` offers no browser');
});

test('the Ctrl+C hint comes once, right after the line announcing the download, not after later lines', async () => {
  // Test review of PR #411, round 2, Minor 1: a full make on Windows can print a second line (a shortcut not written).
  const s = steps({
    ensure: async (o) => {
      o.print?.('Making the desktop app, once: downloading Electron 45.4.1');
      o.print?.("The desktop app's Start-menu shortcut was not written: it exited with code 1.");
      return { made: 'all', paths: madePaths(base, 'win32') };
    },
  });
  assert.equal(await openDesktop({ make: make(), fallback: true, steps: s }), 0);
  const hint = 'Ledung is already running: to use the browser instead, press Ctrl+C and run "ledung --browser".';
  assert.equal(s.lines.filter((l) => l === hint).length, 1);
  assert.deepEqual(s.lines.slice(0, 3), ['Making the desktop app, once: downloading Electron 45.4.1', hint, "The desktop app's Start-menu shortcut was not written: it exited with code 1."]);
});

test('an app that was made but would not open: its line, then the browser', async () => {
  const s = steps({ ensure: async () => ({ made: 'all', paths: madePaths(base, 'darwin') }), open: async () => 'Could not open the desktop app: open exited with code 1.' });
  assert.equal(await openDesktop({ make: make(), fallback: true, steps: s }), 0);
  assert.equal(s.browsers, 1);
  assert.deepEqual(s.lines, [
    `Made the desktop app: ${madePaths(base, 'darwin').bundle}`,
    'Could not open the desktop app: open exited with code 1. Opening Ledung in the browser instead.',
  ]);
});

test('download progress: one line rewritten in a terminal, a line each quarter in a log', () => {
  let tty = '';
  const t = progressPrinter((x) => { tty += x; }, true);
  for (const p of [0, 0.004, 0.5, 0.5, 1]) t(p);
  assert.equal(tty, '\r  0%\r  50%\r  100%\n');
  let log = '';
  const l = progressPrinter((x) => { log += x; }, false);
  for (let i = 0; i <= 100; i++) l(i / 100);
  assert.equal(log, '  0%\n  25%\n  50%\n  75%\n  100%\n');
});

// What `ledung` opens (test review of PR #411, finding 1): the command line and the switch, as a table.

test('`ledung` opens the app by default, --open-only too; --browser, --foreground and "desktopApp": false the browser; --no-open nothing', () => {
  const rows: [string[], boolean, { tryApp: boolean; appCommand: boolean; noOpen: boolean; passthrough: string[] }][] = [
    [[], false, { tryApp: true, appCommand: false, noOpen: false, passthrough: [] }],
    [['--browser'], false, { tryApp: false, appCommand: false, noOpen: false, passthrough: [] }],
    // The Mac's Ledung.app opens a running Ledung with --open-only: the app, as the other shortcuts (#409, which asks
    // for this change; it was the browser under #407).
    [['--open-only'], false, { tryApp: true, appCommand: false, noOpen: false, passthrough: [] }],
    [['--open-only'], true, { tryApp: false, appCommand: false, noOpen: false, passthrough: [] }],
    [['--open-only', '--browser'], false, { tryApp: false, appCommand: false, noOpen: false, passthrough: [] }],
    [['--foreground'], false, { tryApp: false, appCommand: false, noOpen: false, passthrough: [] }],
    [[], true, { tryApp: false, appCommand: false, noOpen: false, passthrough: [] }],
    [['--no-open'], false, { tryApp: false, appCommand: false, noOpen: true, passthrough: ['--no-open'] }],
    [['app'], false, { tryApp: true, appCommand: true, noOpen: false, passthrough: [] }],
    [['app'], true, { tryApp: true, appCommand: true, noOpen: false, passthrough: [] }],
    [['app', '--browser'], false, { tryApp: true, appCommand: true, noOpen: false, passthrough: [] }],
    [['app', '--no-open'], false, { tryApp: false, appCommand: true, noOpen: true, passthrough: ['--no-open'] }],
    [['--no-open', '--foreground'], false, { tryApp: false, appCommand: false, noOpen: true, passthrough: ['--no-open'] }],
  ];
  for (const [args, off, want] of rows) assert.deepEqual(openChoice(args, off), want, `${args.join(' ') || '(none)'}${off ? ', switch off' : ''}`);
});

// The tray's Open and "Open in the Ledung app" (#409): the running Ledung opens the app made here, never makes one.

/** A made app in a fresh data folder: its program and stamp, as ensureApp leaves them. */
function madeHere(name: string, platform: NodeJS.Platform = 'linux'): { data: string; paths: MadePaths } {
  const data = path.join(base, name);
  const paths = madePaths(data, platform);
  fs.mkdirSync(path.dirname(paths.exe), { recursive: true });
  fs.writeFileSync(paths.exe, 'electron');
  fs.writeFileSync(paths.stamp, JSON.stringify(stamp({ platform })));
  return { data, paths };
}

test('the running Ledung opens the made app, and says why not when it is off, not the package, not made or fails', async () => {
  const { data, paths } = madeHere('open-made');
  const opened: MadePaths[] = [];
  const open = async (p: MadePaths) => { opened.push(p); return null; };
  // Made, on, the package: opened, at the made app's own paths.
  assert.equal(await openMadeApp({ dataDir: data, off: false, packaged: true, platform: 'linux', open }), null);
  assert.deepEqual(opened, [paths]);
  assert.deepEqual(madeApp(data, 'linux'), paths);
  // "desktopApp": false, or a clone: the browser, the app not touched.
  assert.equal(await openMadeApp({ dataDir: data, off: true, packaged: true, platform: 'linux', open }), NO_APP);
  assert.equal(await openMadeApp({ dataDir: data, off: false, packaged: false, platform: 'linux', open }), NO_APP);
  assert.equal(opened.length, 1);
  // The app could not be opened: its line goes back to the caller, which opens the browser.
  const why = 'Could not open the desktop app: open exited with code 1.';
  assert.equal(await openMadeApp({ dataDir: data, off: false, packaged: true, platform: 'linux', open: async () => why }), why);
});

// The tray's Open (#409, code review of PR #432): with Electron's package here it opens the app, making it first when
// it isn't made, as `ledung` does; the browser without the package or with "desktopApp": false.

const AVAILABLE: Availability = { ok: true, electron: { dir: '', version: '45.4.1' }, source: '/pkg/dist/desktop' };
const trayMake = (data: string) => async () => ({ ...make(), dataDir: data });

test("the tray's Open makes the app when none is made, then opens it; no browser, no terminal hint", async () => {
  const data = path.join(base, 'tray-make');
  const made = madePaths(data, 'darwin');
  const ensured: string[] = [];
  const opened: MadePaths[] = [];
  const s = steps({
    ensure: async (o) => { ensured.push(o.dataDir); o.print?.('Making the desktop app, once: downloading Electron 45.4.1'); return { made: 'all', paths: made }; },
    open: async (p) => { opened.push(p); return null; },
  });
  await trayOpen({ dataDir: path.join(base, 'tray-data'), told: new Set(), off: false, desktop: { ...AVAILABLE, electron: { dir: base, version: '45.4.1' } }, make: trayMake(data), steps: s });
  assert.deepEqual(ensured, [data], 'made in the data folder it was given');
  assert.deepEqual(opened, [made], 'the made app opened');
  assert.equal(s.browsers, 0);
  assert.ok(s.lines.includes(`Made the desktop app: ${made.bundle}`), s.lines.join('\n'));
  assert.equal(s.lines.some((l) => /Ctrl\+C/.test(l)), false, 'no one is at a terminal for the tray');
  // Premise: `ledung` itself, at a terminal, does print that hint after the same announcement.
  const t = steps({ ensure: s.ensure, open: async () => null });
  await openDesktop({ make: { ...make(), dataDir: data }, fallback: true, steps: t });
  assert.equal(t.lines.some((l) => /Ctrl\+C/.test(l)), true, t.lines.join('\n'));
});

test("the tray's Open gives the browser with \"desktopApp\": false or no Electron package, and touches no app", async () => {
  for (const [off, desktop] of [[true, AVAILABLE], [false, { ok: false, reason: 'Run from a clone' }]] as const) {
    let ensured = 0;
    const s = steps({ ensure: async () => { ensured++; return { made: 'nothing', paths: madePaths(base, 'darwin') }; } });
    await trayOpen({ dataDir: path.join(base, 'tray-data'), told: new Set(), off, desktop, make: trayMake(path.join(base, 'tray-off')), steps: s });
    assert.equal(s.browsers, 1, `off ${off}, ${desktop.ok}`);
    assert.equal(ensured, 0);
  }
  // Premise: on, with the package, the same steps make and open the app instead.
  let ensured = 0;
  const s = steps({ ensure: async () => { ensured++; return { made: 'nothing', paths: madePaths(base, 'darwin') }; } });
  await trayOpen({ dataDir: path.join(base, 'tray-data'), told: new Set(), off: false, desktop: { ...AVAILABLE, electron: { dir: base, version: '45.4.1' } }, make: trayMake(path.join(base, 'tray-on')), steps: s });
  assert.equal(ensured, 1);
  assert.equal(s.browsers, 0);
});

test("the tray's Open: a failed make or open says why in one line and opens the browser", async () => {
  const desktop: Availability = { ...AVAILABLE, electron: { dir: base, version: '45.4.1' } };
  const failedMake = steps({ ensure: async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); } });
  await trayOpen({ dataDir: path.join(base, 'tray-data'), told: new Set(), off: false, desktop, make: trayMake(path.join(base, 'tray-fail-make')), steps: failedMake });
  assert.equal(failedMake.browsers, 1);
  assert.ok(failedMake.lines.includes('The desktop app could not be made: getaddrinfo ENOTFOUND github.com. Opening Ledung in the browser instead.'), failedMake.lines.join('\n'));
  const failedOpen = steps({ open: async () => 'Could not open the desktop app: open exited with code 1.' });
  await trayOpen({ dataDir: path.join(base, 'tray-data'), told: new Set(), off: false, desktop, make: trayMake(path.join(base, 'tray-fail-open')), steps: failedOpen });
  assert.equal(failedOpen.browsers, 1);
  assert.ok(failedOpen.lines.includes('Could not open the desktop app: open exited with code 1. Opening Ledung in the browser instead.'), failedOpen.lines.join('\n'));
  const noConfig = steps();
  await trayOpen({ dataDir: path.join(base, 'tray-data'), told: new Set(), off: false, desktop, make: async () => { throw new Error('no Start menu'); }, steps: noConfig });
  assert.equal(noConfig.browsers, 1);
  assert.deepEqual(noConfig.lines, ['The desktop app could not be made: no Start menu. Opening Ledung in the browser instead.']);
});

// #434: on Windows the tray's Open gave the browser with no word anywhere when the app was not available, so the cause
// could not be told. Every fallback now says why: once in the log, and once on the page the browser opens. Nothing new
// is imported, so this file also loads on the code before the fix (the revert check); the tray's line is in
// desktop/tray-notice.txt in the data folder, apart from `ledung`'s notice.txt, which lasts until the app opens.
const trayNotice = (dataDir: string) => path.join(dataDir, 'desktop', 'tray-notice.txt');
const hello = (dataDir: string) => desktopAppState({ dataDir, ledungVersion: '1.2', platform: 'win32', takeTrayNotice: true } as Parameters<typeof desktopAppState>[0]);

test("the tray's Open says why it gives the browser: once in the log, and once on the page; an opened app says nothing", async () => {
  const data = path.join(base, 'tray-why');
  const without = fakePackage('tray-without', null);
  const desktop = desktopAvailability({ app: without, packaged: true, env: {}, platform: 'win32' });
  assert.equal(desktop.ok, false, 'premise: no Electron package, no app');
  const why = `The desktop app is not installed: Electron's package is missing (its optional install failed or was left out). To add it, ${ADD_COMMAND}.`;
  const told = new Set<string>();
  const s = steps();
  await trayOpen({ dataDir: data, told, off: false, desktop, make: trayMake(data), steps: s });
  assert.equal(s.browsers, 1);
  assert.deepEqual(s.lines, [`${why} Opening Ledung in the browser instead.`]);
  assert.equal(fs.readFileSync(trayNotice(data), 'utf8'), `${why} Ledung opened in the browser instead.\n`);
  // The page the browser opens gets it in hello; the next page does not, so a reload or Dismiss doesn't bring it back.
  assert.deepEqual(hello(data), { stale: false, notice: `${why} Ledung opened in the browser instead.` });
  assert.equal(hello(data), null, 'given once');
  assert.equal(fs.existsSync(noticeFile(data)), false, "`ledung`'s own notice is not used");
  // A second click: the browser again with its line for the page, but not logged again in this run.
  await trayOpen({ dataDir: data, told, off: false, desktop, make: trayMake(data), steps: s });
  assert.equal(s.browsers, 2);
  assert.equal(s.lines.length, 1, s.lines.join('\n'));
  assert.equal(hello(data)?.notice, `${why} Ledung opened in the browser instead.`);
  // A make that throws leaves its reason for the page too, and one with no message still says something.
  const thrown = path.join(base, 'tray-why-thrown');
  await trayOpen({ dataDir: thrown, told, off: false, desktop: AVAILABLE, make: async () => { throw new Error('no Node'); }, steps: steps() });
  assert.equal(fs.readFileSync(trayNotice(thrown), 'utf8'), 'The desktop app could not be made: no Node. Ledung opened in the browser instead.\n');
  const empty = steps();
  await trayOpen({ dataDir: thrown, told, off: false, desktop: AVAILABLE, make: async () => { throw new Error(''); }, steps: empty });
  assert.deepEqual(empty.lines, ['The desktop app could not be made: no reason given. Opening Ledung in the browser instead.']);
  // "desktopApp": false is the person's own choice: logged once per run, nothing for the page, and a reason left from
  // before it was switched off is taken away.
  const off = path.join(base, 'tray-why-off');
  await trayOpen({ dataDir: off, told: new Set(), off: false, desktop, make: trayMake(off), steps: steps() });
  assert.equal(fs.existsSync(trayNotice(off)), true, 'premise: a reason left from before');
  const o = steps();
  const offTold = new Set<string>();
  await trayOpen({ dataDir: off, told: offTold, off: true, desktop: AVAILABLE, make: trayMake(off), steps: o });
  await trayOpen({ dataDir: off, told: offTold, off: true, desktop: AVAILABLE, make: trayMake(off), steps: o });
  assert.equal(o.browsers, 2);
  assert.deepEqual(o.lines, ['The tray opens Ledung in the browser: "desktopApp" is false in the config.']);
  assert.equal(fs.existsSync(trayNotice(off)), false);
  assert.equal(hello(off), null);
  // A clone (no data folder given for the page): logged, the browser, but nothing left in the folder for the npm
  // package's page to show later. The same click with the folder given leaves it (the premise above).
  const clone = path.join(base, 'tray-why-clone');
  const fromClone = steps();
  const cloneReason = desktopAvailability({ app: without, packaged: false, env: {}, platform: 'win32' });
  await trayOpen({ dataDir: null, told: new Set(), off: false, desktop: cloneReason, make: trayMake(clone), steps: fromClone });
  assert.equal(fromClone.browsers, 1);
  assert.equal(fromClone.lines.length, 1);
  assert.match(fromClone.lines[0]!, /clone/);
  assert.equal(fs.existsSync(path.join(clone, 'desktop')), false);
  // The app opened: no line, no browser, and the reason from before is gone.
  await trayOpen({ dataDir: data, told, off: false, desktop, make: trayMake(data), steps: steps() });
  assert.equal(fs.existsSync(trayNotice(data)), true, 'premise: a reason left from before');
  const opened = steps();
  await trayOpen({ dataDir: data, told: new Set(), off: false, desktop: { ...AVAILABLE, electron: { dir: base, version: '45.4.1' } }, make: trayMake(data), steps: opened });
  assert.equal(opened.browsers, 0);
  assert.deepEqual(opened.lines, []);
  assert.equal(fs.existsSync(trayNotice(data)), false);
});

test("a second click on the tray's Open while the app is being made waits for that make instead of starting another", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let ensured = 0;
  let opened = 0;
  const s = steps({
    ensure: async () => { ensured++; await gate; return { made: 'all', paths: madePaths(base, 'darwin') }; },
    open: async () => { opened++; return null; },
  });
  const o = { dataDir: path.join(base, 'tray-data'), told: new Set<string>(), off: false, desktop: { ...AVAILABLE, electron: { dir: base, version: '45.4.1' } } as Availability, make: trayMake(path.join(base, 'tray-twice')), steps: s };
  const first = trayOpen(o);
  const second = trayOpen(o);
  release();
  await Promise.all([first, second]);
  assert.equal(ensured, 1, 'one make');
  assert.equal(opened, 1);
  // Done: the next click makes (here: checks) again.
  await trayOpen(o);
  assert.equal(ensured, 2);
});

test('the page offers the app only for the npm package, with the switch on and an app made here', () => {
  const { data } = madeHere('offers-made');
  assert.equal(offersApp({ dataDir: data, off: false, packaged: true, platform: 'linux' }), true);
  assert.equal(offersApp({ dataDir: data, off: true, packaged: true, platform: 'linux' }), false, '"desktopApp": false');
  assert.equal(offersApp({ dataDir: data, off: false, packaged: false, platform: 'linux' }), false, 'a clone');
  assert.equal(offersApp({ dataDir: path.join(base, 'offers-none'), off: false, packaged: true, platform: 'linux' }), false, 'none made');
});

test('no app is opened where none is made whole: no stamp, no program, nothing at all', async () => {
  const opened: MadePaths[] = [];
  const open = async (p: MadePaths) => { opened.push(p); return null; };
  const none = path.join(base, 'open-none');
  assert.equal(madeApp(none, 'linux'), null);
  assert.equal(await openMadeApp({ dataDir: none, off: false, packaged: true, platform: 'linux', open }), NO_APP);
  // A make that stopped half-way: the program without its stamp, or the stamp without its program.
  const noStamp = madeHere('open-no-stamp');
  fs.rmSync(noStamp.paths.stamp);
  assert.equal(await openMadeApp({ dataDir: noStamp.data, off: false, packaged: true, platform: 'linux', open }), NO_APP);
  const noExe = madeHere('open-no-exe');
  fs.rmSync(noExe.paths.exe);
  assert.equal(await openMadeApp({ dataDir: noExe.data, off: false, packaged: true, platform: 'linux', open }), NO_APP);
  assert.equal(opened.length, 0);
  // Premise: the same probe on a whole app opens it.
  const whole = madeHere('open-whole');
  assert.equal(await openMadeApp({ dataDir: whole.data, off: false, packaged: true, platform: 'linux', open }), null);
  assert.deepEqual(opened, [whole.paths]);
});

test('the started Ledung opens no browser of its own only when the app opens; --no-open stays as given', () => {
  assert.deepEqual(backgroundArgs(openChoice([], false), true), ['--no-open'], 'the app opens: the core opens no browser');
  assert.deepEqual(backgroundArgs(openChoice([], false), false), [], 'no app here: the core opens the browser, as before');
  assert.deepEqual(backgroundArgs(openChoice(['--browser'], false), false), []);
  // With the app ready all the same (test review of PR #411, round 2, Minor 2): --no-open is passed on once, not twice.
  assert.deepEqual(backgroundArgs(openChoice(['--no-open'], false), true), ['--no-open'], 'once, not twice');
  assert.deepEqual(backgroundArgs(openChoice(['app', '--no-open'], false), true), ['--no-open']);
});

// The real make's failure path (test review of PR #411, finding 2): the fake Electron has no downloader, so the
// download fails at once, offline, after the real announcement.

test('a make whose download fails says what it was making, leaves no making folder and keeps an earlier app as it was', async () => {
  const pkg = fakePackage('fails', '45.4.1');
  const electron = electronPackage(pkg)!;
  const opts = (data: string, lines: string[]) => ({ dataDir: data, electron, source: path.join(pkg, 'dist', 'desktop'), ledungVersion: '1.2', config, platform: 'linux' as const, arch: 'x64', print: (l: string) => lines.push(l) });

  const fresh = path.join(base, 'fails-fresh');
  const freshLines: string[] = [];
  await assert.rejects(ensureApp(opts(fresh, freshLines)), /@electron\/get/);
  assert.equal(freshLines.length, 1);
  assert.match(freshLines[0]!, /^Making the desktop app, once: downloading Electron 45\.4\.1 for linux-x64 into /);
  const paths = madePaths(fresh, 'linux');
  assert.equal(fs.existsSync(paths.work), false, 'no making folder left');
  assert.equal(fs.existsSync(paths.bundle), false, 'nothing half-made in its place');
  assert.equal(fs.existsSync(paths.stamp), false);

  const data = path.join(base, 'fails-earlier');
  const earlier = { electron: '45.3.3', platform: 'linux', arch: 'x64', ledung: '1.1', config } satisfies Stamp;
  const old = madeEarlier(data, 'linux', earlier);
  const lines: string[] = [];
  await assert.rejects(ensureApp(opts(data, lines)));
  assert.match(lines[0] ?? '', /^Making the desktop app, once: downloading Electron 45\.4\.1/);
  assert.equal(fs.readFileSync(old.exe, 'utf8'), 'electron', 'the earlier app is untouched');
  assert.equal(fs.readFileSync(path.join(old.code, 'main.js'), 'utf8'), 'old code');
  assert.deepEqual(readStamp(old.stamp), earlier, 'and its stamp still says what it is');
  assert.equal(fs.existsSync(old.work), false);
});

// Windows (Martin, 2026-11-19, Ledung question #587: "b — Both now").

test("Ledung.exe's file details say Ledung, in every language they had, and its icon is Ledung's", async () => {
  const { NtExecutable, NtExecutableResource, Resource } = await import('resedit');
  // A small Windows program with Electron's kind of details, made here: no Electron download in a test.
  const exe = NtExecutable.createEmpty();
  const res = NtExecutableResource.from(exe);
  const info = Resource.VersionInfo.create({ lang: 1033, fixedInfo: {}, strings: [{ lang: 1033, codepage: 1200, values: { FileDescription: 'Electron', ProductName: 'Electron', CompanyName: 'GitHub, Inc.', OriginalFilename: 'electron.exe' } }] });
  info.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  const file = path.join(base, 'Ledung.exe');
  fs.writeFileSync(file, Buffer.from(exe.generate()));

  await setExeDetails(file, icoFromPng(fs.readFileSync(path.join(appDir(), 'web', 'public', 'icon-256.png'))));

  const after = NtExecutableResource.from(NtExecutable.from(fs.readFileSync(file)));
  const [read] = Resource.VersionInfo.fromEntries(after.entries);
  const values = read!.getStringValues({ lang: 1033, codepage: 1200 });
  assert.equal(values.FileDescription, 'Ledung', "Task Manager's name");
  assert.equal(values.ProductName, 'Ledung');
  assert.equal(values.OriginalFilename, 'Ledung.exe');
  assert.equal(values.CompanyName, 'GitHub, Inc.', 'what is not Ledung\'s to say is kept');
  const groups = Resource.IconGroupEntry.fromEntries(after.entries);
  assert.equal(groups.length, 1, 'one icon');
  assert.equal(groups[0]!.icons[0]!.width, 0, '256 px, written as 0 in an icon group');
});

test("the app's Start-menu shortcut is written by the just-made app, run once with its own argument; a failure is one reason", async () => {
  const dir = path.join(base, 'shortcut-run');
  fs.mkdirSync(dir, { recursive: true });
  // A stand-in for Ledung.exe: a script that records its arguments, then exits as told.
  const fake = (name: string, code: number) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\necho "$@" > "${file}.args"\nexit ${code}\n`, { mode: 0o755 });
    return file;
  };
  const paths = { ...madePaths(path.join(base, 'shortcut-data'), 'win32'), exe: fake('ok', 0) };
  fs.mkdirSync(path.join(paths.root, '.shortcut-profile'), { recursive: true });
  const lnk = path.join(dir, 'Start menu', APP_SHORTCUT);
  if (process.platform !== 'win32') {
    assert.equal(await writeAppShortcut(paths, lnk), null);
    assert.equal(fs.readFileSync(`${paths.exe}.args`, 'utf8').trim(), `${WRITE_SHORTCUT_ARG}=${lnk}`);
    assert.equal(fs.existsSync(path.join(paths.root, '.shortcut-profile')), false, 'its throwaway profile is removed');
    assert.equal(await writeAppShortcut({ ...paths, exe: fake('fails', 3) }, lnk), 'it exited with code 3');
  }
  assert.match((await writeAppShortcut({ ...paths, exe: path.join(dir, 'missing.exe') }, lnk)) ?? '', /ENOENT/);
  // Its own folder in Programs, named Ledung: not the launcher's Ledung.lnk beside it.
  assert.equal(path.basename(APP_SHORTCUT), 'Ledung.lnk');
  assert.notEqual(path.dirname(APP_SHORTCUT), '.');
});

test("Settings' Remove takes the app's Start-menu shortcut too, and its folder only when nothing else is in it", async () => {
  const startMenu = path.join(base, 'remove-app', 'Programs');
  const lnk = path.join(startMenu, APP_SHORTCUT);
  fs.mkdirSync(path.dirname(lnk), { recursive: true });
  fs.writeFileSync(lnk, 'lnk');
  const launcher = path.join(startMenu, 'Ledung.lnk');
  fs.writeFileSync(launcher, 'lnk');
  const s = new Shortcuts({
    launch: { node: process.execPath, script: 'x' }, iconDir: path.join(base, 'remove-app', 'data'),
    icons: { png256: path.join(appDir(), 'web', 'public', 'icon-256.png'), png512: path.join(appDir(), 'web', 'public', 'icon-512.png') },
    meta: { get: () => null, set: () => {} }, platform: 'win32', folders: async () => ({ 'start-menu': startMenu, startup: path.join(base, 'remove-app', 'Startup') }),
  });
  await s.act('remove');
  assert.equal(fs.existsSync(lnk), false);
  assert.equal(fs.existsSync(path.dirname(lnk)), false, 'its empty folder too');
  assert.equal(fs.existsSync(launcher), false, 'the launcher shortcut, as before');
  // A folder with something else in it stays.
  fs.mkdirSync(path.dirname(lnk), { recursive: true });
  fs.writeFileSync(lnk, 'lnk');
  fs.writeFileSync(path.join(path.dirname(lnk), 'mine.txt'), 'x');
  removeAppShortcut(startMenu);
  assert.equal(fs.existsSync(lnk), false);
  assert.equal(fs.existsSync(path.join(path.dirname(lnk), 'mine.txt')), true);
});

// The real download (test review of PR #411): Electron's own downloader and its checksums, against a server of the
// test's own that hands out a file that is not Electron. No network: ELECTRON_MIRROR points it here.

test("a download whose file fails Electron's checksum: progress was shown, the make stops with that reason, nothing is left", async (t) => {
  const electron = electronPackage(appDir());
  if (!electron) return t.skip('Electron is not installed here (optional dependencies left out)');
  const body = Buffer.alloc(64 * 1024, 7);
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': body.length });
    res.end(body);
  });
  const port = await listenOk(server);
  const mirror = process.env.ELECTRON_MIRROR;
  process.env.ELECTRON_MIRROR = `http://127.0.0.1:${port}/`;
  try {
    const data = path.join(base, 'checksum');
    const lines: string[] = [];
    const progress: number[] = [];
    await assert.rejects(
      ensureApp({ dataDir: data, electron, source: path.join(fakePackage('checksum-src', null), 'dist', 'desktop'), ledungVersion: '1.2', config, platform: 'linux', arch: 'x64', print: (l) => lines.push(l), progress: (p) => progress.push(p) }),
      /checksum|sha256|integrity/i,
    );
    const version = electron.version.replace(/\./g, '\\.');
    assert.equal(asked.length, 1, 'the zip was asked for once');
    assert.match(asked[0]!, new RegExp(`electron-v${version}-linux-x64\\.zip$`));
    assert.match(lines[0] ?? '', new RegExp(`^Making the desktop app, once: downloading Electron ${version} for linux-x64`));
    assert.ok(progress.length > 0 && progress.at(-1) === 1, `progress reached the end: ${progress.join(',')}`);
    const paths = madePaths(data, 'linux');
    assert.equal(fs.existsSync(paths.work), false, 'no making folder, download cache included');
    assert.equal(fs.existsSync(paths.bundle), false);
  } finally {
    if (mirror === undefined) delete process.env.ELECTRON_MIRROR;
    else process.env.ELECTRON_MIRROR = mirror;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Settings lists the desktop app's Start-menu entry with no launcher shortcut there, and Remove takes it (code review of PR #411, round 2)", async () => {
  const root = path.join(base, 'entry-only');
  const startMenu = path.join(root, 'Programs');
  const lnk = path.join(startMenu, APP_SHORTCUT);
  const s = new Shortcuts({
    launch: { node: process.execPath, script: 'x' }, iconDir: path.join(root, 'data'),
    icons: { png256: path.join(appDir(), 'web', 'public', 'icon-256.png'), png512: path.join(appDir(), 'web', 'public', 'icon-512.png') },
    meta: { get: () => null, set: () => {} }, platform: 'win32', folders: async () => ({ desktop: path.join(root, 'Desktop'), 'start-menu': startMenu, startup: path.join(root, 'Startup') }),
  });
  assert.deepEqual((await s.view()).appEntry, { label: 'Desktop app in the Start menu', file: lnk, present: false });
  fs.mkdirSync(path.dirname(lnk), { recursive: true });
  fs.writeFileSync(lnk, 'lnk');
  const before = await s.view();
  assert.equal(before.appEntry?.present, true);
  assert.deepEqual(before.places.filter((p) => p.present), [], 'no launcher shortcut: an npm-only install');
  const after = await s.act('remove');
  assert.equal(fs.existsSync(lnk), false);
  assert.equal(after.appEntry?.present, false);
  // Not on the Mac: it has no such entry.
  const mac = new Shortcuts({ launch: { node: process.execPath, script: 'x' }, iconDir: path.join(root, 'mac'), icons: { png256: '', png512: '' }, meta: { get: () => null, set: () => {} }, platform: 'darwin', folders: async () => ({ applications: path.join(root, 'Applications') }) });
  assert.equal((await mac.view()).appEntry, null);
});

// Updating Ledung with the app open (#408, Martin 2026-11-19, Ledung questions #577 and #593): the core tells the page
// the app is out of date, the app restarts through the `ledung` that made it, which writes the new code (or keeps the
// app it has when a new Electron can't be downloaded) and opens it; a browser fallback leaves its line for the page.

test('the page is told the app is out of date after an update, and never after a restart alone (#408)', () => {
  const data = path.join(base, 'state-data');
  const now = { electron: '45.4.1', platform: 'linux', arch: 'x64', ledung: '1.2', config } satisfies Stamp;
  const state = (ledung: string) => desktopAppState({ dataDir: data, ledungVersion: ledung, platform: 'linux' });
  assert.equal(state('1.2'), null, 'no app made here: nothing to say');
  madeEarlier(data, 'linux', now);
  assert.deepEqual(state('1.2'), { stale: false, notice: null }, 'Restart Ledung alone: the same version, nothing to restart');
  assert.deepEqual(state('1.3'), { stale: true, notice: null }, 'Update Ledung: a new version, the window restarts');
  // The stamp is read at each ask: the restarted app's new stamp ends it.
  fs.writeFileSync(madePaths(data, 'linux').stamp, JSON.stringify({ ...now, ledung: '1.3' }));
  assert.deepEqual(state('1.3'), { stale: false, notice: null });
  fs.writeFileSync(noticeFile(data), 'The desktop app could not be made: offline. Ledung opened in the browser instead.\n');
  assert.deepEqual(state('1.3'), { stale: false, notice: 'The desktop app could not be made: offline. Ledung opened in the browser instead.' });
  const none = path.join(base, 'state-none');
  fs.mkdirSync(path.dirname(noticeFile(none)), { recursive: true });
  fs.writeFileSync(noticeFile(none), 'why\n');
  assert.deepEqual(desktopAppState({ dataDir: none, ledungVersion: '1.2', platform: 'linux' }), { stale: false, notice: 'why' }, 'a notice with no app made yet');
});

test('a new Electron that cannot be downloaded: the same major keeps the app with the new code and tries again next start; another major keeps nothing', async () => {
  const pkg = fakePackage('kept', '45.4.1');
  const electron = electronPackage(pkg)!;
  const opts = (data: string) => ({ dataDir: data, electron, source: path.join(pkg, 'dist', 'desktop'), ledungVersion: '1.3', config, platform: 'linux' as const, arch: 'x64' });

  const same = path.join(base, 'kept-same');
  const paths = madeEarlier(same, 'linux', { electron: '45.3.3', platform: 'linux', arch: 'x64', ledung: '1.2', config });
  assert.deepEqual(await codeIntoKept(opts(same)), { paths, electron: '45.3.3' });
  assert.equal(fs.readFileSync(path.join(paths.code, 'main.js'), 'utf8'), 'main.js', 'the new Ledung code');
  assert.equal(fs.readFileSync(paths.exe, 'utf8'), 'electron', 'on the Electron it had');
  const stamp = readStamp(paths.stamp)!;
  assert.deepEqual({ electron: stamp.electron, ledung: stamp.ledung }, { electron: '45.3.3', ledung: '1.3' });
  assert.equal(whatToMake(stamp, { ...stamp, electron: '45.4.1' }, true), 'all', 'the next start downloads again');
  // The kept app has the new Ledung: the page is not told to restart it again, which offline would loop (self-check
  // finding 3). The same app before the code went in was out of date: the check is the version, not a constant.
  assert.equal(desktopAppState({ dataDir: same, ledungVersion: '1.3', platform: 'linux' })?.stale, false);
  assert.equal(desktopAppState({ dataDir: same, ledungVersion: '1.4', platform: 'linux' })?.stale, true);

  const other = path.join(base, 'kept-other');
  const earlier = { electron: '44.9.0', platform: 'linux', arch: 'x64', ledung: '1.2', config } satisfies Stamp;
  const old = madeEarlier(other, 'linux', earlier);
  assert.equal(await codeIntoKept(opts(other)), null);
  assert.equal(fs.readFileSync(path.join(old.code, 'main.js'), 'utf8'), 'old code', 'another major: the app is left as it was');
  assert.deepEqual(readStamp(old.stamp), earlier);

  const otherArch = path.join(base, 'kept-arch');
  madeEarlier(otherArch, 'linux', { electron: '45.3.3', platform: 'linux', arch: 'arm64', ledung: '1.2', config });
  assert.equal(await codeIntoKept(opts(otherArch)), null, 'an app for another system is not kept');
  assert.equal(await codeIntoKept(opts(path.join(base, 'kept-none'))), null, 'no app made: nothing to keep');
});

test('a failed make with a kept app opens that app, saying why, with no browser; without one the browser, and its line for the page (#408)', async () => {
  const data = path.join(base, 'open-kept');
  const failing = (keep: OpenSteps['keep']) => steps({
    ensure: async (o) => {
      o.print?.('Making the desktop app, once: downloading Electron 46.0.0');
      throw new Error('fetch failed\n    at node:internal/deps/undici');
    },
    keep,
  });
  const m = { ...make(), dataDir: data, electron: { dir: base, version: '46.0.0' } };
  let opened: MadePaths | null = null;
  const kept = failing(async () => ({ paths: madePaths(data, 'linux'), electron: '45.4.1' }));
  kept.open = async (p) => { opened = p; return null; };
  assert.equal(await openDesktop({ make: m, fallback: true, steps: kept, restarted: true }), 0);
  assert.equal(kept.browsers, 0);
  assert.deepEqual(opened, madePaths(data, 'linux'));
  assert.ok(kept.lines.includes('Electron 46.0.0 could not be downloaded (fetch failed): the desktop app runs on Electron 45.4.1 with the new Ledung until the next start tries again.'), kept.lines.join('\n'));
  assert.ok(!kept.lines.some((l) => l.includes('Ctrl+C')), 'a restart the app asked for: no one is at a terminal');

  const lost = failing(async () => null);
  // A hidden app's restart left its marker (desktop/main.ts); ending in the browser takes it away, so the app's next
  // start by hand shows its window (self-check finding 2). The kept app's run above opened the app and left it.
  const marker = path.join(data, 'desktop', START_HIDDEN_FILE);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, '');
  assert.equal(await openDesktop({ make: m, fallback: true, steps: kept, restarted: true }), 0);
  assert.equal(fs.existsSync(marker), true, 'an app that opened: its marker is the new app\'s to read');
  assert.equal(await openDesktop({ make: m, fallback: true, steps: lost, restarted: true }), 0);
  assert.equal(fs.existsSync(marker), false, 'the browser opened: no marker left');
  assert.equal(lost.browsers, 1);
  assert.equal(lost.lines.at(-1), 'The desktop app could not be made: fetch failed. Opening Ledung in the browser instead.');
  const notice = 'The desktop app could not be made: fetch failed. Ledung opened in the browser instead; the next start of the app tries again.';
  assert.equal(desktopAppState({ dataDir: data, ledungVersion: '1.2', platform: 'linux' })?.notice, notice, 'the page shows the line');

  // The next start that opens the app takes the line away.
  assert.equal(await openDesktop({ make: m, fallback: true, steps: steps() }), 0);
  assert.equal(fs.existsSync(noticeFile(data)), false);
});

test("the app's restart runs the Node and `ledung` that made it with --after-app=<its pid>; a clone run or a gone command has none", () => {
  const node = process.execPath;
  const cli = fileURLToPath(import.meta.url);
  assert.deepEqual(restartCommand({ node, cli, env: {} }, 4242), { command: node, args: [cli, `${AFTER_APP_ARG}=4242`] });
  assert.equal(restartCommand(null, 4242), null, 'a clone run');
  assert.equal(restartCommand({ node: path.join(base, 'gone-node'), cli, env: {} }, 4242), null, 'its Node is gone');
  assert.deepEqual(afterApp(['--after-app=4242', '--no-open']), { pid: 4242, rest: ['--no-open'] });
  assert.deepEqual(afterApp(['--no-open']), { pid: null, rest: ['--no-open'] });
  for (const bad of ['--after-app=', '--after-app=x', '--after-app=-3', '--after-app=1.5']) assert.deepEqual(afterApp([bad]), { pid: null, rest: [] }, bad);
});

test('the restart waits for the old app to have quit, and gives up after its time', async () => {
  let checks = 0;
  assert.equal(await waitForExit(1, 5_000, () => ++checks < 3), true);
  assert.equal(checks, 3, 'asked until it had gone');
  assert.equal(await waitForExit(1, 250, () => true), false, 'still running after the time');
  // The real check: this process runs, one that has exited does not.
  assert.equal(await waitForExit(process.pid, 150), false);
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(await waitForExit(child.pid!, 2_000), true);
});

test("the preload gives a made app's page restartForUpdate, which sends its message; a clone run's page has none", () => {
  const source = fs.readFileSync(path.join(appDir(), 'desktop', 'preload.cjs'), 'utf8');
  const load = (argv: string[]) => {
    let exposed: Record<string, (...a: unknown[]) => void> = {};
    const sent: unknown[][] = [];
    const electron = { contextBridge: { exposeInMainWorld: (_name: string, api: typeof exposed) => { exposed = api; } }, ipcRenderer: { send: (...a: unknown[]) => sent.push(a) } };
    vm.runInNewContext(source, { require: (m: string) => (m === 'electron' ? electron : null), process: { argv } });
    return { exposed, sent };
  };
  const made = load(['electron', '--ledung-made-app']);
  assert.deepEqual(Object.keys(made.exposed).sort(), ['newWindow', 'restartForUpdate', 'showWindow']);
  made.exposed.restartForUpdate!(true);
  made.exposed.restartForUpdate!();
  made.exposed.restartForUpdate!('yes');
  assert.deepEqual(made.sent, [['ledung-desktop:restart-for-update', true], ['ledung-desktop:restart-for-update', false], ['ledung-desktop:restart-for-update', false]]);
  assert.deepEqual(Object.keys(load(['electron']).exposed).sort(), ['newWindow', 'showWindow']);
});

// #455: an app opened from a shortcut, a taskbar or Dock pin, Launchpad or Finder never went through `ledung`, so after
// an npm update it ran the old version's code. At start it now compares its own version with the installed package's.
test('an app started out of date restarts first, once per installed version in ten minutes; an up-to-date one never does (#455)', () => {
  const now = 1_000_000_000;
  // The usual start: the app's code is the installed version's.
  assert.equal(updateAtStart({ own: '3.17.0', installed: '3.17.0', tried: null, now }), false);
  // After `npm install -g` the installed package is newer than the app's code: restart to take it.
  assert.equal(updateAtStart({ own: '3.16.0', installed: '3.17.0', tried: null, now }), true);
  // A downgrade too: the app runs what is installed.
  assert.equal(updateAtStart({ own: '3.17.0', installed: '3.16.0', tried: null, now }), true);
  // The installed package can't be read (uninstalled, mid-update): the app runs what it has.
  assert.equal(updateAtStart({ own: '3.16.0', installed: null, tried: null, now }), false);
  // A restart for 3.17.0 was tried a minute ago and the app is still 3.16.0: no second restart, so no loop.
  assert.equal(updateAtStart({ own: '3.16.0', installed: '3.17.0', tried: { version: '3.17.0', at: now - 60_000 }, now }), false);
  // Just inside the ten minutes still holds; at ten minutes the next start tries again.
  assert.equal(START_UPDATE_RETRY_MS, 10 * 60_000);
  assert.equal(updateAtStart({ own: '3.16.0', installed: '3.17.0', tried: { version: '3.17.0', at: now - (10 * 60_000 - 1) }, now }), false);
  assert.equal(updateAtStart({ own: '3.16.0', installed: '3.17.0', tried: { version: '3.17.0', at: now - 10 * 60_000 }, now }), true);
  // A note for another version says nothing about this one: 3.18.0 came since.
  assert.equal(updateAtStart({ own: '3.16.0', installed: '3.18.0', tried: { version: '3.17.0', at: now - 60_000 }, now }), true);
});

test("the installed version is the package.json nearest above the made app's `ledung` script, as that command's own is (#455)", () => {
  const pkg = path.join(base, 'installed-455');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ledung', version: '3.17.0' }));
  const cli = path.join(pkg, 'dist', 'cli.js');
  fs.writeFileSync(cli, '');
  assert.equal(installedVersion(cli), '3.17.0');
  // An update replaces package.json: the next start reads the new one.
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ledung', version: '3.18.0' }));
  assert.equal(installedVersion(cli), '3.18.0');
  // Half written during an update, or with no version: unknown, never a guess.
  fs.writeFileSync(path.join(pkg, 'package.json'), '{ "name": "led');
  assert.equal(installedVersion(cli), null);
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ledung' }));
  assert.equal(installedVersion(cli), null);
  // This clone's own command reads the same file the core's version comes from.
  const own = (JSON.parse(fs.readFileSync(path.join(appDir(), 'package.json'), 'utf8')) as { version: string }).version;
  assert.equal(installedVersion(path.join(appDir(), 'src', 'cli.ts')), own);
});

test("the start restart's note gives back the version it was for and when, and nothing when it isn't there (#455)", () => {
  const file = path.join(base, 'start-update-455');
  assert.equal(readStartUpdate(file), null, 'no note');
  fs.writeFileSync(file, '3.17.0\n');
  const at = fs.statSync(file).mtimeMs;
  assert.deepEqual(readStartUpdate(file), { version: '3.17.0', at });
  fs.writeFileSync(file, '');
  assert.equal(readStartUpdate(file), null, 'an empty note');
});

test("the start restart runs the made app's `ledung` with --app-only; the update's restart stays as it was (#455)", () => {
  const node = process.execPath;
  const cli = fileURLToPath(import.meta.url);
  assert.equal(APP_ONLY_ARG, '--app-only');
  assert.deepEqual(restartCommand({ node, cli, env: {} }, 4242, true), { command: node, args: [cli, `${AFTER_APP_ARG}=4242`, '--app-only'] });
  assert.deepEqual(restartCommand({ node, cli, env: {} }, 4242, false), { command: node, args: [cli, `${AFTER_APP_ARG}=4242`] });
  assert.equal(restartCommand(null, 4242, true), null, 'a clone run never restarts');
});

test('a restart for an update goes only when the `ledung` that made the app has another version (PR #425 review, Minor 2)', () => {
  // Updated: the made app's command is the new version, the app still the old one.
  assert.equal(restartBrings('3.16.0', '3.17.0'), true);
  // Two installs: the running Ledung is 3.17.0 from another Node, but the app's own command is 3.16.0, the app's own
  // version. A restart would write 3.16.0 again and be told again it is out of date: it does not go.
  assert.equal(restartBrings('3.16.0', '3.16.0'), false);
  // That command's package can't be read: nothing is known to come of it.
  assert.equal(restartBrings('3.16.0', null), false);
});

test('`ledung --after-app=<pid> --app-only` starts Ledung when none runs, then opens the app; a running one is left as it is (#477)', async () => {
  // Martin's try on Windows (#477, 2026-11-21): the app started from the Start menu after an npm update "opened this
  // window without the server running". The start's restart now starts Ledung first when none runs, and still opens
  // the app whatever comes of bringing it up to date: a clone has no made app, so here it says so and exits 1.
  const run = async (name: string, args: string[], setup: (data: string, config: string) => void) => {
    const data = path.join(base, name);
    fs.mkdirSync(data, { recursive: true });
    const config = path.join(data, 'config.json');
    setup(data, config);
    const child = spawn(process.execPath, [path.join(appDir(), 'src', 'cli.ts'), ...args], {
      env: { ...process.env, LEDUNG_CONFIG: config, LEDUNG_DATA_DIR: data },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    const code = await new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
    return { code, out, log: path.join(data, 'ledung.log') };
  };
  // A pid no process has: the wait for the app to quit ends at once.
  const gone = 2 ** 30;
  const refused = (_data: string, config: string) => fs.writeFileSync(config, '{ not json');

  // The restart an update makes (#408) starts Ledung when none runs, as it did: its log shows the start.
  const plain = await run('after-app-plain-455', [`${AFTER_APP_ARG}=${gone}`, '--no-open'], refused);
  assert.equal(fs.existsSync(plain.log), true, plain.out);
  assert.match(fs.readFileSync(plain.log, 'utf8'), /Ledung starting in the background/);

  // None running: a config the core refuses at once, so the Ledung it starts stops by itself and nothing is left
  // running. Its log shows the background start, and the start comes before the app is looked for.
  const notRunning = await run('after-app-only-477', [`${AFTER_APP_ARG}=${gone}`, APP_ONLY_ARG], refused);
  assert.equal(fs.existsSync(notRunning.log), true, notRunning.out);
  assert.match(fs.readFileSync(notRunning.log, 'utf8'), /Ledung starting in the background/);
  const stopped = notRunning.out.indexOf('Ledung stopped while starting');
  assert.ok(stopped >= 0 && stopped < notRunning.out.indexOf(NO_APP), notRunning.out);
  assert.equal(notRunning.code, 1, notRunning.out);

  // Already running (a stand-in that proves it holds this data folder's token): no second start, no log, and the app
  // is opened as before.
  const ledung = await standInLedung();
  try {
    const running = await run('after-app-only-running-477', [`${AFTER_APP_ARG}=${gone}`, APP_ONLY_ARG], (data, config) => {
      fs.writeFileSync(config, JSON.stringify({ port: ledung.port }));
      fs.writeFileSync(path.join(data, 'auth-token'), TOKEN_455);
    });
    assert.ok(running.out.includes(`Ledung is already running at http://127.0.0.1:${ledung.port}.`), running.out);
    assert.equal(fs.existsSync(running.log), false, running.out);
    assert.ok(running.out.includes(NO_APP), running.out);
    assert.equal(running.code, 1, running.out);
  } finally {
    await ledung.close();
  }
});

test("⌘R, Reload and Force Reload restart an app whose code is not the installed version's into it; up to date they reload the page (#455)", () => {
  // Martin, 2026-11-20 12:20: "when we press reload, why doesnt we reload with the new code?" After an update the
  // installed package is newer than the app's own code: a reload restarts the window into it.
  assert.equal(reloadRestarts('reload', '3.16.0', '3.17.0'), true);
  assert.equal(reloadRestarts('forceReload', '3.16.0', '3.17.0'), true);
  // Up to date, or nothing known about the install: the page reloads as before.
  assert.equal(reloadRestarts('reload', '3.17.0', '3.17.0'), false);
  assert.equal(reloadRestarts('forceReload', '3.17.0', '3.17.0'), false);
  assert.equal(reloadRestarts('reload', '3.16.0', null), false);
  // The View menu's other commands never restart, out of date or not.
  for (const other of ['devTools', 'resetZoom', 'zoomIn', 'zoomOut']) assert.equal(reloadRestarts(other, '3.16.0', '3.17.0'), false, other);
});

/**
 * A stand-in for Electron, for running the app's real main.ts outside it (test review of PR #459, rounds 1 and 2). It
 * prints what the app did as `EVENT <name>` lines:
 * - `window` when the app sets its menu, the first step of opening its window; without STAND_IN_ACTION it then exits;
 * - `quit` when it quits; the quit runs the app's before-quit and will-quit handlers as Electron does, so the restart
 *   command is really started;
 * - `page-reload` and `page-reload-ignoring-cache` when the window's page reloads, and `done` when an action is over.
 * With STAND_IN_ACTION it goes on: a stand-in window attaches to the Ledung the config names, and once its page loads
 * the action runs: `reload` and `forceReload` click the View menu's item, `banner` sends the page's update message
 * with `now` (the banner's Restart window, #408), `second` is a second start of the app (Electron's second-instance)
 * while its window is hidden, as closing it leaves it (#479), `second-shown` the same with the window in sight, and `hidden-update` the page's update message without
 * `now` while that window is hidden (#408's restart by itself).
 */
const ELECTRON_STAND_IN = `
const handlers = {};
const ipc = {};
const event = (name) => process.stdout.write('EVENT ' + name + '\\n');
const action = process.env.STAND_IN_ACTION || '';
// Anything else the app touches: callable, constructible, every property another such thing.
const any = () => new Proxy(function () {}, {
  get: (_t, key) => (key === 'then' || typeof key === 'symbol' ? undefined : any()),
  apply: () => any(),
  construct: () => any(),
});
const withRest = (o) => new Proxy(o, { get: (t, key) => (key in t ? t[key] : key === 'then' || typeof key === 'symbol' ? undefined : any()) });
let template = [];
const made = [];
function act(w) {
  if (action === 'reload' || action === 'forceReload') {
    const label = action === 'reload' ? 'Reload' : 'Force Reload';
    const item = template.flatMap((m) => m.submenu ?? []).find((i) => i.label === label);
    item.click(item, undefined);
  } else if (action === 'banner') {
    for (const fn of ipc['ledung-desktop:restart-for-update'] ?? []) fn({ sender: w.webContents, senderFrame: { parent: null, url: w.shown } }, true);
  } else if (action === 'hidden-update') {
    for (const fn of ipc['ledung-desktop:restart-for-update'] ?? []) fn({ sender: w.webContents, senderFrame: { parent: null, url: w.shown } }, false);
  } else if (action === 'second' || action === 'second-shown') {
    for (const fn of handlers['second-instance'] ?? []) fn({}, [], '');
  }
  setTimeout(() => { event('done'); process.exit(0); }, 600);
}
export class BrowserWindow {
  constructor() {
    // Set before the proxy: a missing field would read as one of its truthy stand-ins.
    this.acted = false;
    this.shown = null;
    const self = withRest(this);
    this.webContents = withRest({
      reload: () => event('page-reload'),
      reloadIgnoringCache: () => event('page-reload-ignoring-cache'),
      on: () => {},
    });
    made.push(self);
    return self;
  }
  static fromWebContents(c) { return made.find((w) => w.webContents === c) ?? null; }
  isDestroyed() { return false; }
  isVisible() { return action !== 'second' && action !== 'hidden-update'; }
  show() { event('show'); }
  focus() {}
  isMinimized() { return false; }
  isFullScreen() { return false; }
  on() {}
  loadFile() { return Promise.resolve(); }
  loadURL(url) {
    // The page of the Ledung it attached to: the action runs once, then.
    this.shown = url;
    if (action && !this.acted) { this.acted = true; setTimeout(() => act(this), 50); }
    return Promise.resolve();
  }
}
export const app = withRest({
  getVersion: () => process.env.STAND_IN_VERSION,
  on: (name, fn) => { (handlers[name] ??= []).push(fn); },
  whenReady: () => Promise.resolve(),
  // Ready for a second start, so its showWindow shows: the other actions keep the app as it was before #479's test.
  isReady: () => action.startsWith('second'),
  requestSingleInstanceLock: () => true,
  quit: () => {
    event('quit');
    for (const name of ['before-quit', 'will-quit']) for (const fn of handlers[name] ?? []) fn({ preventDefault() {} });
    setTimeout(() => process.exit(0), 300);
  },
  exit: (code) => process.exit(code),
});
export const Menu = withRest({
  buildFromTemplate: (t) => { template = t; return any(); },
  setApplicationMenu: () => { event('window'); if (!action) process.exit(0); },
});
export const ipcMain = withRest({ on: (name, fn) => { (ipc[name] ??= []).push(fn); } });
// One signed-out partition: the app signs it in with the token cookie and goes on.
const partition = withRest({ cookies: withRest({ get: async () => [], set: async () => {} }), fetch: async () => null });
export const session = withRest({ fromPartition: () => partition });
export const clipboard = any();
export const dialog = any();
export const nativeImage = any();
export const shell = any();
export const WebContentsView = any();
`;

const TOKEN_455 = 'd'.repeat(64);

/**
 * The real desktop/main.ts, bundled as the package bundles it (scripts/build-package.ts) with the stand-in for
 * Electron, in a made app's folder whose `ledung` is a script that writes down how it was run. Its config names
 * `ledungPort`, the Ledung an action attaches to. `start` runs it once.
 */
async function appHarness(name: string, ledungPort: number) {
  const { build } = await import('esbuild');
  const root = path.join(base, name);
  const appCode = path.join(root, 'app');
  fs.mkdirSync(appCode, { recursive: true });
  const standIn = path.join(root, 'electron-stand-in.mjs');
  fs.writeFileSync(standIn, ELECTRON_STAND_IN);
  await build({
    entryPoints: [path.join(appDir(), 'desktop', 'main.ts')],
    outfile: path.join(appCode, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    logLevel: 'error',
    plugins: [{ name: 'electron-stand-in', setup: (b) => b.onResolve({ filter: /^electron$/ }, () => ({ path: standIn })) }],
  });
  const pkg = path.join(root, 'installed');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  const cli = path.join(pkg, 'dist', 'cli.js');
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'auth-token'), TOKEN_455);
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ port: ledungPort }));
  const ran = path.join(root, 'cli-ran.json');
  fs.writeFileSync(cli, `require('node:fs').writeFileSync(${JSON.stringify(ran)}, JSON.stringify(process.argv.slice(2)));\n`);
  fs.writeFileSync(path.join(appCode, MADE_CONFIG), JSON.stringify({ node: process.execPath, cli, env: { LEDUNG_DATA_DIR: data, LEDUNG_CONFIG: config } }));
  const note = path.join(data, 'desktop', '.start-update');
  const start = async (own: string, installed: string, action = '') => {
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ledung', version: installed }));
    fs.rmSync(ran, { force: true });
    const env: NodeJS.ProcessEnv = { ...process.env, STAND_IN_VERSION: own, STAND_IN_ACTION: action };
    delete env.LEDUNG_DATA_DIR;
    delete env.LEDUNG_CONFIG;
    const child = spawn(process.execPath, [path.join(appCode, 'main.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    const events = out.split('\n').filter((l) => l.startsWith('EVENT ')).map((l) => l.slice(6));
    // The restart command is detached: give it a moment to have written down how it ran.
    for (let i = 0; i < 50 && events.includes('quit') && !fs.existsSync(ran); i++) await new Promise((r) => setTimeout(r, 100));
    const args = fs.existsSync(ran) ? (JSON.parse(fs.readFileSync(ran, 'utf8')) as string[]) : null;
    return { events, args, pid: child.pid, out };
  };
  return { start, note };
}

/** A stand-in Ledung on a port of its own: it answers /running as Ledung does (desktop/attach.ts runningProof). */
async function standInLedung(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const nonce = new URL(req.url!, 'http://x').searchParams.get('nonce');
    if (!nonce) return void res.writeHead(404).end();
    const proof = crypto.createHmac('sha256', TOKEN_455).update(`ledung-running:${nonce}`).digest('hex');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ proof }));
  });
  const port = await listenOk(server);
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test("the app's own start (desktop/main.ts) restarts it into the installed version before any window, once per version (#455)", async () => {
  // No action: it never gets as far as looking for a Ledung, so the port is never asked.
  const { start, note } = await appHarness('main-start-455', 1);

  // Out of date after an update: it quits before any window and runs the made app's `ledung` in app-only mode with
  // its own pid, and notes the version it restarts for.
  const old = await start('1.0.0', '2.0.0');
  assert.deepEqual(old.events, ['quit'], old.out);
  assert.deepEqual(old.args, [`${AFTER_APP_ARG}=${old.pid}`, APP_ONLY_ARG], old.out);
  assert.equal(fs.readFileSync(note, 'utf8').trim(), '2.0.0');

  // Started again still out of date for that same version (the restart could not bring it): it opens on its own
  // code, no second restart, so no loop.
  const again = await start('1.0.0', '2.0.0');
  assert.deepEqual(again.events, ['window'], again.out);
  assert.equal(again.args, null, 'no restart command ran');
  assert.equal(fs.existsSync(note), true, 'the note stays until the app is up to date');

  // Up to date: it opens as before, no restart, and the note goes.
  const current = await start('2.0.0', '2.0.0');
  assert.deepEqual(current.events, ['window'], current.out);
  assert.equal(current.args, null, 'no restart command ran');
  assert.equal(fs.existsSync(note), false);
});

test("the app's View → Reload and Force Reload (desktop/main.ts) restart an out-of-date app into the installed version, app only; up to date they reload the page (#455)", async () => {
  // Martin, 2026-11-20 12:20: "when we press reload, why doesnt we reload with the new code?" (test review of PR #459
  // round 2, finding 1). Out of date here: a start restart for 2.0.0 was just tried (its note is fresh), so the app
  // opened on its own 1.0.0 code and showed the page; then the person reloads.
  const ledung = await standInLedung();
  try {
    const { start, note } = await appHarness('main-reload-455', ledung.port);
    for (const [action, pageEvent] of [['reload', 'page-reload'], ['forceReload', 'page-reload-ignoring-cache']] as const) {
      fs.mkdirSync(path.dirname(note), { recursive: true });
      fs.writeFileSync(note, '2.0.0\n');
      const old = await start('1.0.0', '2.0.0', action);
      assert.ok(old.events.includes('quit'), `${action}: ${old.out}`);
      assert.ok(!old.events.includes(pageEvent), `${action}: the page alone must not reload: ${old.out}`);
      // App only: the reload's restart never starts Ledung.
      assert.deepEqual(old.args, [`${AFTER_APP_ARG}=${old.pid}`, APP_ONLY_ARG], `${action}: ${old.out}`);

      // Up to date: the page reloads, no restart.
      const current = await start('2.0.0', '2.0.0', action);
      assert.deepEqual(current.events, ['window', pageEvent, 'done'], `${action}: ${current.out}`);
      assert.equal(current.args, null, `${action}: no restart command ran`);
    }
  } finally {
    await ledung.close();
  }
});

test("a second start of an app running out of date with no window in sight (desktop/main.ts) restarts it into the installed version, shown, app only; in sight or up to date it only shows the window (#479)", async () => {
  // Martin, 2026-11-21 18:09 (#477's play check): after an npm update a Start-menu start opened the app with its update
  // banner to press. Closing the app's window hides it, so the old app was still running and the start only showed it.
  const ledung = await standInLedung();
  try {
    const { start, note } = await appHarness('main-second-479', ledung.port);
    const desktopDir = path.dirname(note);
    const hiddenMarker = path.join(desktopDir, START_HIDDEN_FILE);
    const restartLog = path.join(desktopDir, 'restart.log');
    const trace = path.join(path.dirname(desktopDir), 'exercised.log');
    const traced = () => (fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter((l) => l.includes('EXERCISED #479')).length : 0);

    // Out of date (it opened on its own code: the start restart for 2.0.0 was just tried), its window hidden, and
    // started again: it quits and runs its `ledung` in app-only mode, which starts Ledung when none runs (#477).
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.writeFileSync(note, '2.0.0\n');
    const old = await start('1.0.0', '2.0.0', 'second');
    assert.ok(old.events.includes('quit'), old.out);
    assert.ok(!old.events.includes('show'), `the old window is not shown: ${old.out}`);
    assert.deepEqual(old.args, [`${AFTER_APP_ARG}=${old.pid}`, APP_ONLY_ARG], old.out);
    // Its trace, once the quit was sure: one line.
    assert.equal(traced(), 1, 'one EXERCISED #479 line for the restart');
    // The person started it: it comes back shown, although its window was hidden when the restart began.
    assert.equal(fs.existsSync(hiddenMarker), false, 'a restart for a start must not come back hidden');
    // restart.log says when, which app and which restart.
    const logged = fs.readFileSync(restartLog, 'utf8').trim().split('\n').at(-1) ?? '';
    assert.match(logged, new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\S+Z restarting the app ${old.pid} \\(app only\\)$`), logged);

    // The probe's positive branch: the same hidden window restarting by itself for an update (#408) does leave the
    // marker, so its absence above is the start's doing, not a probe that finds nothing.
    fs.writeFileSync(note, '2.0.0\n');
    const hidden = await start('1.0.0', '2.0.0', 'hidden-update');
    assert.deepEqual(hidden.args, [`${AFTER_APP_ARG}=${hidden.pid}`], hidden.out);
    assert.equal(fs.existsSync(hiddenMarker), true, 'a hidden restart for an update comes back hidden');
    fs.rmSync(hiddenMarker, { force: true });

    // Out of date with its window in sight, in use: the start shows it and the page keeps its banner (Martin, #593:
    // "ask when in front"), no restart.
    fs.writeFileSync(note, '2.0.0\n');
    const inUse = await start('1.0.0', '2.0.0', 'second-shown');
    assert.deepEqual(inUse.events, ['window', 'show', 'done'], inUse.out);
    assert.equal(inUse.args, null, 'no restart command ran');
    assert.equal(traced(), 1, 'no EXERCISED #479 line without a restart');

    // Up to date: a second start only shows the window, no restart.
    const current = await start('2.0.0', '2.0.0', 'second');
    assert.deepEqual(current.events, ['window', 'show', 'done'], current.out);
    assert.equal(current.args, null, 'no restart command ran');
  } finally {
    await ledung.close();
  }
});

test("the banner's Restart window (desktop/main.ts) restarts through the app's `ledung` only when that one has another version (PR #425 review, Minor 2)", async () => {
  // Test review of PR #459 round 2, finding 2: the gate in the app itself, not only the helper.
  const ledung = await standInLedung();
  try {
    const { start, note } = await appHarness('main-banner-455', ledung.port);
    // The app's `ledung` is another version (an update; the start restart for it was just tried, its note fresh): the
    // banner's restart goes, as the update's restart does (#408), without --app-only.
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, '2.0.0\n');
    const other = await start('1.0.0', '2.0.0', 'banner');
    assert.ok(other.events.includes('quit'), other.out);
    assert.deepEqual(other.args, [`${AFTER_APP_ARG}=${other.pid}`], other.out);

    // Two installs: the running Ledung says the app is out of date, but the app's own `ledung` has the app's version.
    // A restart would bring the same code back: none goes.
    const same = await start('1.0.0', '1.0.0', 'banner');
    assert.deepEqual(same.events, ['window', 'done'], same.out);
    assert.equal(same.args, null, 'no restart command ran');
  } finally {
    await ledung.close();
  }
});
