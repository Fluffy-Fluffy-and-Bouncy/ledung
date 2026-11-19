// The desktop app from the npm package (issue #407, src/platform/desktop-app.ts and desktop/made.ts): where the made app
// lives, when it is made again, the code and settings it is given, when `ledung` may open it ("desktopApp": false,
// Ledung question #584), and what a failed make does (one line, then the browser). Downloading Electron and the Mac's
// plutil and codesign steps are checked by hand against a packed build (the PR's test plan): they need the network and
// a 121 MB download, and the 'all' make is never reached here.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ID, MADE_CONFIG, madeConfigFor, readMadeConfig, type MadeConfig } from '../desktop/made.ts';
import { findOnPath, runStart, startCommand } from '../desktop/start.ts';
import {
  ADD_COMMAND, appManifest, desktopAppOff, desktopAvailability, electronPackage, ensureApp, madePaths, openDesktop, progressPrinter,
  readStamp, whatToMake, writeAppCode, type MadePaths, type OpenSteps, type Stamp,
} from '../src/platform/desktop-app.ts';
import { parseConfig, SETTING_RELOAD } from '../src/config.ts';
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
  assert.equal(reason(desktopAvailability({ app: without, packaged: true, env: display, platform: 'linux' })), `The desktop app is not installed (Ledung was installed without optional dependencies). Add it with: ${ADD_COMMAND}`);
  const noCode = fakePackage('no-code', '45.4.1');
  fs.rmSync(path.join(noCode, 'dist', 'desktop'), { recursive: true });
  assert.match(reason(desktopAvailability({ app: noCode, packaged: true, env: display, platform: 'linux' })), /no desktop app/);
});

test('"desktopApp": false in the config keeps `ledung` on the browser; anything else leaves the app on (Ledung question #584)', () => {
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
    'To use the browser instead, press Ctrl+C now, or run "ledung --browser" next time.',
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
