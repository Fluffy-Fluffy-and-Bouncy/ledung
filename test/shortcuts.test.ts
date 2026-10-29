// Shortcuts that start Ledung (issue #415): the icon files, the Windows .lnk and the macOS Ledung.app, made and
// taken away only in folders inside .test/, never on the real Desktop, Start menu or Applications; the first-run
// question's answer is kept; a Ledung with its own data folder keeps its shortcuts in it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { icnsFromPngs, icoFromPng, pngSize } from '../src/platform/icons.ts';
import { ASKED_KEY, BUNDLE_ID, ENV_FILE, envFileText, iconFiles, launchTarget, powershell, Shortcuts, type ShortcutsOptions } from '../src/platform/shortcuts.ts';
import { appDir } from '../src/platform/paths.ts';
import { removeTemp } from './temp.ts';

let base: string;
const icons = iconFiles(appDir());
const png256 = () => fs.readFileSync(icons.png256);
const png512 = () => fs.readFileSync(icons.png512);

before(() => {
  fs.mkdirSync(path.join(appDir(), '.test'), { recursive: true });
  base = fs.mkdtempSync(path.join(appDir(), '.test', 'shortcuts-'));
});

after(() => removeTemp(base));

function memoryMeta() {
  const values = new Map<string, string>();
  return { values, get: (k: string) => values.get(k) ?? null, set: (k: string, v: string) => void values.set(k, v) };
}

/**
 * Runs fn with LEDUNG_DATA_DIR and LEDUNG_CONFIG as given (undefined: unset), then puts back what was there: what
 * launchTarget() and the default places see must not depend on how the tests were started (#435).
 */
function withLedungEnv<T>(values: { LEDUNG_DATA_DIR?: string; LEDUNG_CONFIG?: string }, fn: () => T): T {
  const names = ['LEDUNG_DATA_DIR', 'LEDUNG_CONFIG'] as const;
  const saved = names.map((name) => process.env[name]);
  const put = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  for (const name of names) put(name, values[name]);
  const restore = () => names.forEach((name, i) => put(name, saved[i]));
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (e) {
    restore();
    throw e;
  }
}

/** Shortcuts whose places are folders of this test's own. */
function shortcuts(name: string, platform: NodeJS.Platform, extra: Partial<ShortcutsOptions> = {}) {
  const root = path.join(base, name);
  const folders = { desktop: path.join(root, 'Desktop'), 'start-menu': path.join(root, 'Programs'), applications: path.join(root, 'Applications') };
  const meta = memoryMeta();
  const s = new Shortcuts({
    launch: { node: process.execPath, script: path.join(root, 'data', 'launcher.mjs') },
    iconDir: path.join(root, 'data'), icons, meta, platform, folders: async () => folders, ...extra,
  });
  return { s, meta, folders, root };
}

test('the icons are the page icon at 256 and 512 pixels', () => {
  assert.deepEqual(pngSize(png256()), { width: 256, height: 256 });
  assert.deepEqual(pngSize(png512()), { width: 512, height: 512 });
});

test('an .ico wraps the 256-pixel PNG behind a one-image directory', () => {
  const png = png256();
  const ico = icoFromPng(png);
  // ICONDIR: reserved 0, type 1 (icon), one image; ICONDIRENTRY: 256 written as 0, 1 plane, 32 bits, size, offset 22.
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 1]);
  assert.deepEqual([ico[6], ico[7], ico.readUInt16LE(10), ico.readUInt16LE(12)], [0, 0, 1, 32]);
  assert.equal(ico.readUInt32LE(14), png.length);
  assert.equal(ico.readUInt32LE(18), 22);
  assert.ok(ico.subarray(22).equals(png));
  assert.throws(() => icoFromPng(png512()), /at most 256 pixels/);
  assert.throws(() => icoFromPng(Buffer.from('not a png')), /Not a PNG/);
});

test('an .icns holds the 256 and 512 PNGs as ic08 and ic09', () => {
  const [a, b] = [png256(), png512()];
  const icns = icnsFromPngs([a, b]);
  assert.equal(icns.toString('latin1', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  assert.equal(icns.toString('latin1', 8, 12), 'ic08');
  assert.equal(icns.readUInt32BE(12), 8 + a.length);
  const second = 8 + 8 + a.length;
  assert.equal(icns.toString('latin1', second, second + 4), 'ic09');
  assert.equal(icns.readUInt32BE(second + 4), 8 + b.length);
});

test('shortcuts run the release launcher from a release, else the npm command or the source command', () => withLedungEnv({}, () => {
  const data = path.join(base, 'target-data');
  const release = path.join(data, 'app', '20261029-120000');
  fs.mkdirSync(release, { recursive: true });
  // A release folder without the launcher next to it is not a release start.
  assert.equal(launchTarget(data, release, false).script, path.join(release, 'src', 'cli.ts'));
  fs.writeFileSync(path.join(data, 'launcher.mjs'), '');
  assert.deepEqual(launchTarget(data, release, false), { node: process.execPath, script: path.join(data, 'launcher.mjs') });
  const pkg = path.join(base, 'node_modules', 'ledung');
  assert.equal(launchTarget(data, pkg, true).script, path.join(pkg, 'dist', 'cli.js'));
  assert.equal(launchTarget(data, appDir(), false).script, path.join(appDir(), 'src', 'cli.ts'));
}));

test('on Linux there are no shortcuts, and the page says why', async () => {
  const { s } = shortcuts('linux', 'linux');
  const view = await s.view();
  assert.equal(view.available, false);
  assert.match(view.reason!, /Windows and macOS/);
  assert.deepEqual(view.places, []);
  await assert.rejects(s.act('add'), /Windows and macOS/);
});

test('No to the first-run question is kept and makes nothing', async () => {
  const { s, meta, root } = shortcuts('decline', 'darwin');
  assert.equal((await s.view()).asked, false);
  const view = await s.act('decline');
  assert.equal(view.asked, true);
  assert.equal(meta.values.get(ASKED_KEY), 'declined');
  assert.ok(view.places.every((p) => !p.present));
  assert.equal(fs.existsSync(root), false, 'no folder was made');
});

test('macOS: Add makes Ledung.app with the icon, opening a running Ledung or starting one in Terminal; Remove takes it away', async () => {
  const { s, meta, folders } = shortcuts('mac', 'darwin');
  const view = await s.act('add');
  const app = path.join(folders.applications, 'Ledung.app');
  assert.deepEqual(view.places.map((p) => [p.id, p.file, p.present]), [['applications', app, true]]);
  assert.equal(meta.values.get(ASKED_KEY), 'added');
  const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
  assert.match(plist, new RegExp(`<key>CFBundleIdentifier</key><string>${BUNDLE_ID.replace(/\./g, '\\.')}</string>`));
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>Ledung<\/string>/);
  assert.ok(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'Ledung.icns')).equals(icnsFromPngs([png256(), png512()])));
  const run = fs.readFileSync(path.join(app, 'Contents', 'MacOS', 'Ledung'), 'utf8');
  assert.ok(run.startsWith('#!/bin/sh\n'));
  // Node where it was when the app was made, else the one the login shell finds (Mac check of PR #432, note 2).
  assert.ok(run.includes(`NODE='${process.execPath}'\n[ -x "$NODE" ] || NODE=$("\${SHELL:-/bin/zsh}" -lic 'command -v node'`), run);
  assert.ok(run.includes(`"$NODE" '${path.join(path.dirname(folders.applications), 'data', 'launcher.mjs')}' --open-only && exit 0`), run);
  assert.match(run, /exec open -a Terminal "\$\(dirname "\$0"\)\/\.\.\/Resources\/start\.command"/);
  assert.ok(!run.includes('--env-file'), 'a Ledung on the usual folders carries no settings');
  const start = fs.readFileSync(path.join(app, 'Contents', 'Resources', 'start.command'), 'utf8');
  assert.ok(start.includes(`NODE='${process.execPath}'\n[ -x "$NODE" ] || NODE=node\nexec "$NODE" '`), start);
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(path.join(app, 'Contents', 'MacOS', 'Ledung')).mode & 0o100, 'the app script is executable');
    assert.ok(fs.statSync(path.join(app, 'Contents', 'Resources', 'start.command')).mode & 0o100, 'start.command is executable');
  }
  const removed = await s.act('remove');
  assert.equal(fs.existsSync(app), false);
  assert.equal(removed.places[0]!.present, false);
  assert.equal(removed.asked, true, 'Remove leaves the question answered');
});

// A Safari web app of the page is also called Ledung.app (Mac check of PR #432, note 3): it is not "added", Add
// doesn't write into it, and Remove leaves it.
test("macOS: a Ledung.app that isn't the one Ledung made is not counted, not written into, and not removed", async () => {
  const { s, folders } = shortcuts('mac-other', 'darwin');
  const other = path.join(folders.applications, 'Ledung.app', 'Contents');
  fs.mkdirSync(other, { recursive: true });
  const plist = '<plist><dict><key>CFBundleIdentifier</key><string>com.apple.Safari.WebApp.X</string></dict></plist>';
  fs.writeFileSync(path.join(other, 'Info.plist'), plist);
  assert.equal((await s.view()).places[0]!.present, false);
  await assert.rejects(s.act('add'), /already a Ledung\.app .* that Ledung didn't make/);
  assert.equal(fs.readFileSync(path.join(other, 'Info.plist'), 'utf8'), plist);
  assert.deepEqual(fs.readdirSync(other), ['Info.plist'], 'nothing written into it');
  const removed = await s.act('remove');
  assert.equal(removed.places[0]!.present, false);
  assert.equal(fs.readFileSync(path.join(other, 'Info.plist'), 'utf8'), plist);
});

// A shortcut made by a Ledung started with LEDUNG_DATA_DIR / LEDUNG_CONFIG opens or starts that Ledung, not the
// default one (Mac check of PR #432, note 1).
test('a Ledung started with its own data folder and config passes them on to its shortcuts', async () => {
  const data = path.join(base, 'carry-data');
  withLedungEnv({ LEDUNG_DATA_DIR: data, LEDUNG_CONFIG: path.join(base, 'carry.json') }, () => {
    assert.deepEqual(launchTarget(data, appDir(), false).env, { LEDUNG_DATA_DIR: path.resolve(data), LEDUNG_CONFIG: path.resolve(base, 'carry.json') });
  });
  const env = { LEDUNG_DATA_DIR: path.join(base, 'carry-data'), LEDUNG_CONFIG: path.join(base, 'carry.json') };
  const { s, folders } = shortcuts('mac-carry', 'darwin', { launch: { node: process.execPath, script: path.join(base, 'mac-carry', 'data', 'launcher.mjs'), env } });
  await s.act('add');
  const envFile = path.join(path.dirname(folders.applications), 'data', ENV_FILE);
  const run = fs.readFileSync(path.join(folders.applications, 'Ledung.app', 'Contents', 'MacOS', 'Ledung'), 'utf8');
  assert.ok(run.includes(`"$NODE" '--env-file=${envFile}' '`), run);
  const start = fs.readFileSync(path.join(folders.applications, 'Ledung.app', 'Contents', 'Resources', 'start.command'), 'utf8');
  assert.ok(start.includes(`exec "$NODE" '--env-file=${envFile}' '`), start);
  assert.deepEqual(nodeSees(envFile), env);
  await s.act('remove');
  assert.equal(fs.existsSync(envFile), false, 'Remove takes the env file away');
});

/** LEDUNG_DATA_DIR and LEDUNG_CONFIG as Node itself reads them from an env file. */
function nodeSees(envFile: string): Record<string, string> {
  const out = execFileSync(process.execPath, [`--env-file=${envFile}`, '-e', 'console.log(JSON.stringify({ LEDUNG_DATA_DIR: process.env.LEDUNG_DATA_DIR, LEDUNG_CONFIG: process.env.LEDUNG_CONFIG }))'], { env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' } }).toString();
  return JSON.parse(out);
}

test("the env file keeps paths as they are: backslashes, spaces, Å, # and '", () => {
  const dir = path.join(base, 'env-text');
  fs.mkdirSync(dir, { recursive: true });
  const env = { LEDUNG_DATA_DIR: 'C:\\Users\\Åsa Ström\\new\\data #1', LEDUNG_CONFIG: "/Users/o'brien/Ledung config.json" };
  fs.writeFileSync(path.join(dir, ENV_FILE), envFileText(env));
  assert.deepEqual(nodeSees(path.join(dir, ENV_FILE)), env);
  assert.throws(() => envFileText({ LEDUNG_CONFIG: "it's `odd`" }), /can't be passed to a shortcut/);
});

test('a Ledung with its own data folder keeps its shortcuts in it, never on the real Desktop', async () => {
  const data = path.join(base, 'own-data');
  await withLedungEnv({ LEDUNG_DATA_DIR: data }, async () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const s = new Shortcuts({ launch: { node: process.execPath, script: 'x' }, iconDir: data, icons, meta: memoryMeta(), platform });
      const view = await s.view();
      assert.ok(view.places.length > 0, platform);
      for (const p of view.places) assert.ok(p.file.startsWith(path.join(data, 'shortcuts') + path.sep), `${platform}: ${p.file}`);
    }
  });
});

/** A .lnk's fields, read back by Windows itself. */
function readLink(file: string): Record<string, string | number> {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); @{ target = $s.TargetPath; arguments = $s.Arguments; icon = $s.IconLocation; window = $s.WindowStyle; workdir = $s.WorkingDirectory } | ConvertTo-Json -Compress'],
  { env: { ...process.env, LNK: file }, windowsHide: true }).toString();
  return JSON.parse(out);
}

test('Windows: Add makes Ledung.lnk on the Desktop and in the Start menu, minimised, with the icon; Remove takes them away', { skip: process.platform !== 'win32' && 'makes real Windows shortcuts' }, async () => {
  const { s, meta, folders, root } = shortcuts('windows', 'win32');
  const view = await s.act('add');
  const desktop = path.join(folders.desktop, 'Ledung.lnk');
  const programs = path.join(folders['start-menu'], 'Ledung.lnk');
  assert.deepEqual(view.places.map((p) => [p.id, p.file, p.present]), [['desktop', desktop, true], ['start-menu', programs, true]]);
  assert.equal(meta.values.get(ASKED_KEY), 'added');
  const ico = path.join(root, 'data', 'Ledung.ico');
  assert.ok(fs.readFileSync(ico).equals(icoFromPng(png256())));
  for (const file of [desktop, programs]) {
    const link = readLink(file);
    assert.equal(String(link.target).toLowerCase(), process.execPath.toLowerCase());
    assert.equal(link.arguments, `"${path.join(root, 'data', 'launcher.mjs')}"`);
    // 7: minimised (SW_SHOWMINNOACTIVE), so Ledung's console sits in the taskbar.
    assert.equal(link.window, 7);
    assert.equal(String(link.icon).toLowerCase(), `${ico},0`.toLowerCase());
  }
  const removed = await s.act('remove');
  assert.ok(removed.places.every((p) => !p.present));
  assert.equal(fs.existsSync(desktop) || fs.existsSync(programs) || fs.existsSync(ico), false);
});

test('Windows: a Ledung with its own data folder and config passes them to Node through the .lnk', { skip: process.platform !== 'win32' && 'makes real Windows shortcuts' }, async () => {
  const root = path.join(base, 'windows-carry');
  const env = { LEDUNG_DATA_DIR: path.join(root, 'data dir'), LEDUNG_CONFIG: path.join(root, 'config.json') };
  const script = path.join(root, 'data', 'launcher.mjs');
  const { s, folders } = shortcuts('windows-carry', 'win32', { launch: { node: process.execPath, script, env } });
  await s.act('add');
  const envFile = path.join(root, 'data', ENV_FILE);
  assert.equal(readLink(path.join(folders.desktop, 'Ledung.lnk')).arguments, `"--env-file=${envFile}" "${script}"`);
  assert.deepEqual(nodeSees(envFile), env);
  await s.act('remove');
  assert.equal(fs.existsSync(envFile), false);
});

// The Desktop and Start menu paths come back from PowerShell: a profile like C:\Users\Åsa must survive the pipe, or
// Add writes somewhere that is not the Desktop (review of PR #432, Important 2).
test('Windows: a path with Å, ö or 中 comes back from PowerShell as it is', { skip: process.platform !== 'win32' && 'Windows PowerShell' }, async () => {
  const value = 'C:\\Users\\Åsa Ström\\OneDrive - 中文\\Skrivbord';
  const out = await powershell('$env:SHORTCUT_TEST | ConvertTo-Json -Compress', { SHORTCUT_TEST: value });
  assert.equal(JSON.parse(out), value);
});
