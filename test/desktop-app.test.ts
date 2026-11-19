// The desktop app from the npm package (issue #407, src/platform/desktop-app.ts and desktop/made.ts): where the made app
// lives, when it is made again, the code and settings it is given, when `ledung` may open it ("desktopApp": false,
// Ledung question #585), and what a failed make does (one line, then the browser). Downloading Electron and the Mac's
// plutil and codesign steps are checked by hand against a packed build (the PR's test plan): they need the network and
// a 121 MB download, and the 'all' make is never reached here.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { APP_ID, MADE_CONFIG, madeConfigFor, readMadeConfig, WRITE_SHORTCUT_ARG, type MadeConfig } from '../desktop/made.ts';
import { findOnPath, runStart, startCommand } from '../desktop/start.ts';
import {
  ADD_COMMAND, APP_SHORTCUT, appManifest, backgroundArgs, desktopAppOff, desktopAvailability, electronPackage, ensureApp, madePaths,
  openChoice, openDesktop, progressPrinter, readStamp, setExeDetails, whatToMake, writeAppCode, writeAppShortcut, type MadePaths,
  type OpenSteps, type Stamp,
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

test('`ledung` opens the app by default; --browser, --open-only, --foreground and "desktopApp": false the browser; --no-open nothing', () => {
  const rows: [string[], boolean, { tryApp: boolean; appCommand: boolean; noOpen: boolean; passthrough: string[] }][] = [
    [[], false, { tryApp: true, appCommand: false, noOpen: false, passthrough: [] }],
    [['--browser'], false, { tryApp: false, appCommand: false, noOpen: false, passthrough: [] }],
    [['--open-only'], false, { tryApp: false, appCommand: false, noOpen: false, passthrough: [] }],
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

test('the started Ledung opens no browser of its own only when the app opens; --no-open stays as given', () => {
  assert.deepEqual(backgroundArgs(openChoice([], false), true), ['--no-open'], 'the app opens: the core opens no browser');
  assert.deepEqual(backgroundArgs(openChoice([], false), false), [], 'no app here: the core opens the browser, as before');
  assert.deepEqual(backgroundArgs(openChoice(['--browser'], false), false), []);
  assert.deepEqual(backgroundArgs(openChoice(['--no-open'], false), false), ['--no-open'], 'once, not twice');
  assert.deepEqual(backgroundArgs(openChoice(['app', '--no-open'], false), false), ['--no-open']);
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
