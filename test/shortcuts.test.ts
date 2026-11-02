// Shortcuts that start Ledung (issue #415): the icon files, the Windows .lnk and the macOS Ledung.app, made and
// taken away only in folders inside .test/, never on the real Desktop, Start menu or Applications; the first-run
// question's answer is kept; a Ledung with its own data folder keeps its shortcuts in it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { icnsFromPngs, icoFromPng, pngSize } from '../src/platform/icons.ts';
import { AGENT_LABEL, ASKED_KEY, BUNDLE_ID, desktopArg, ENV_FILE, envFileText, iconFiles, launchTarget, powershell, Shortcuts, STARTER_FILE, starterText, type ShortcutsOptions } from '../src/platform/shortcuts.ts';
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

test('macOS: Add makes Ledung.app with the icon, opening a running Ledung or starting one in the background; Remove takes it away', async () => {
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
  // No Terminal window since #456: the release launcher starts in the background, its output in the data folder's log.
  const log = path.join(path.dirname(folders.applications), 'data', 'ledung.log');
  assert.ok(run.includes(`\nLEDUNG_LOG_FILE='${log}' nohup "$NODE" '${path.join(path.dirname(folders.applications), 'data', 'launcher.mjs')}' >> '${log}' 2>&1 &\n`), run);
  assert.ok(!run.includes('Terminal'), run);
  // A start gets the login shell's PATH (#464); opening a running Ledung's page doesn't wait for it.
  assert.ok(run.indexOf('LEDUNG_START_PATH=login') > run.indexOf('--open-only && exit 0'), run);
  assert.ok(run.indexOf('\nexport PATH LEDUNG_START_PATH\n') < run.indexOf('nohup'), run);
  assert.equal(fs.existsSync(path.join(app, 'Contents', 'Resources', 'start.command')), false);
  assert.ok(!run.includes('--env-file'), 'a Ledung on the usual folders carries no settings');
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(path.join(app, 'Contents', 'MacOS', 'Ledung')).mode & 0o100, 'the app script is executable');
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
  // The background start carries them too (#456).
  assert.ok(run.includes(`nohup "$NODE" '--env-file=${envFile}' '`), run);
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

/** Windows Script Host, which the .lnk files run so that no console window opens (#456). */
const wscript = () => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');

test('Windows: Add makes Ledung.lnk on the Desktop and in the Start menu, starting with no window, with the icon; Remove takes them away', { skip: process.platform !== 'win32' && 'makes real Windows shortcuts' }, async () => {
  const { s, meta, folders, root } = shortcuts('windows', 'win32');
  const view = await s.act('add');
  const desktop = path.join(folders.desktop, 'Ledung.lnk');
  const programs = path.join(folders['start-menu'], 'Ledung.lnk');
  assert.deepEqual(view.places.map((p) => [p.id, p.file, p.present]), [['desktop', desktop, true], ['start-menu', programs, true]]);
  assert.equal(meta.values.get(ASKED_KEY), 'added');
  const ico = path.join(root, 'data', 'Ledung.ico');
  assert.ok(fs.readFileSync(ico).equals(icoFromPng(png256())));
  const starter = path.join(root, 'data', STARTER_FILE);
  for (const file of [desktop, programs]) {
    const link = readLink(file);
    // Not Node itself, which always gets a console window: the start script, run by Windows Script Host (#456).
    assert.equal(String(link.target).toLowerCase(), wscript().toLowerCase());
    assert.equal(link.arguments, `"//Nologo" "${starter}"`);
    assert.equal(String(link.icon).toLowerCase(), `${ico},0`.toLowerCase());
  }
  // The release launcher runs where it is started, so the script sends its output to the log through cmd.exe.
  const text = fs.readFileSync(starter, 'utf8');
  assert.ok(text.includes(JSON.stringify(`cmd.exe /d /s /c "set "LEDUNG_LOG_FILE=${path.join(root, 'data', 'ledung.log')}"&& "${process.execPath}" "${path.join(root, 'data', 'launcher.mjs')}"`)), text);
  assert.ok(text.includes(JSON.stringify(` >> "${path.join(root, 'data', 'ledung.log')}" 2>&1"`)), text);
  assert.ok(text.includes(', 0, false);'), 'window style 0: hidden');
  const removed = await s.act('remove');
  assert.ok(removed.places.every((p) => !p.present));
  assert.equal(fs.existsSync(desktop) || fs.existsSync(programs) || fs.existsSync(ico) || fs.existsSync(starter), false);
});

/** Runs a start script as the .lnk does and waits for the file the started program writes. */
async function runStarter(starter: string, args: string[], waitFor: string): Promise<string> {
  const child = spawn(wscript(), ['//Nologo', starter, ...args], { windowsHide: true, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100; i++) {
      if (fs.existsSync(waitFor) && fs.statSync(waitFor).size > 0) return fs.readFileSync(waitFor, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${waitFor} never came`);
  } finally {
    child.kill();
  }
}

test('Windows: the start script runs the command it names, with its own arguments; the release launcher\'s output goes to the log', { skip: process.platform !== 'win32' && 'Windows Script Host' }, async () => {
  // The `ledung` command (anything but launcher.mjs) goes to the background itself: the script runs it as it is.
  const root = path.join(base, 'starter-Åsa');
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const seen = path.join(root, 'seen.json');
  const command = path.join(root, 'cli.mjs');
  fs.writeFileSync(command, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));`);
  const direct = new Shortcuts({ launch: { node: process.execPath, script: command }, iconDir: data, icons, meta: memoryMeta(), platform: 'win32', folders: async () => ({ startup: path.join(root, 'Startup') }) });
  await direct.act('sign-in-on');
  assert.deepEqual(JSON.parse(await runStarter(path.join(data, STARTER_FILE), ['--no-open'], seen)), ['--no-open']);

  // The release launcher: what it prints lands in ledung.log in the data folder, and it is told so, for Settings → Log.
  const launcher = path.join(data, 'launcher.mjs');
  fs.writeFileSync(launcher, "console.log('launcher says ' + process.argv.slice(2).join(' ') + ' log ' + process.env.LEDUNG_LOG_FILE);");
  const release = new Shortcuts({ launch: { node: process.execPath, script: launcher }, iconDir: data, icons, meta: memoryMeta(), platform: 'win32', folders: async () => ({ startup: path.join(root, 'Startup') }) });
  await release.act('sign-in-on');
  const log = await runStarter(path.join(data, STARTER_FILE), ['--no-open'], path.join(data, 'ledung.log'));
  assert.equal(log.trim(), `launcher says --no-open log ${path.join(data, 'ledung.log')}`);
  await release.act('sign-in-off');
});

test('Windows: a Ledung with its own data folder and config passes them to Node through the .lnk', { skip: process.platform !== 'win32' && 'makes real Windows shortcuts' }, async () => {
  const root = path.join(base, 'windows-carry');
  const env = { LEDUNG_DATA_DIR: path.join(root, 'data dir'), LEDUNG_CONFIG: path.join(root, 'config.json') };
  const script = path.join(root, 'data', 'launcher.mjs');
  const { s, folders } = shortcuts('windows-carry', 'win32', { launch: { node: process.execPath, script, env } });
  await s.act('add');
  const envFile = path.join(root, 'data', ENV_FILE);
  // The .lnk runs the start script (#456), which passes the env file to Node.
  assert.equal(readLink(path.join(folders.desktop, 'Ledung.lnk')).arguments, `"//Nologo" "${path.join(root, 'data', STARTER_FILE)}"`);
  assert.ok(fs.readFileSync(path.join(root, 'data', STARTER_FILE), 'utf8').includes(JSON.stringify(`"${process.execPath}" "--env-file=${envFile}" "${script}"`).slice(1, -1)));
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

// Start Ledung when I sign in (issue #456; Martin, 2026-11-01 21:41, Ledung question #1149): off until switched on,
// per user, and only in this test's own folders, never the real Startup folder, LaunchAgents or autostart.

test('the start at sign-in is off until switched on, and Off takes its file away', async () => {
  const root = path.join(base, 'sign-in-mac');
  const s = new Shortcuts({ launch: { node: process.execPath, script: path.join(root, 'data', 'launcher.mjs') }, iconDir: path.join(root, 'data'), icons, meta: memoryMeta(), platform: 'darwin', folders: async () => ({ applications: path.join(root, 'Applications'), startup: path.join(root, 'LaunchAgents') }) });
  const before = await s.view();
  assert.deepEqual(before.signIn, { available: true, reason: null, label: 'Start Ledung when I log in to this Mac', on: false, file: path.join(root, 'LaunchAgents', `${AGENT_LABEL}.plist`) });
  assert.equal(fs.existsSync(path.join(root, 'LaunchAgents')), false, 'nothing is written until asked');
  assert.equal((await s.act('sign-in-on')).signIn.on, true);
  assert.equal((await s.act('sign-in-off')).signIn.on, false);
  assert.equal(fs.existsSync(path.join(root, 'LaunchAgents', `${AGENT_LABEL}.plist`)), false);
});

test('macOS: the LaunchAgent runs Ledung at login in the foreground under launchd, without its page, output to the log', async () => {
  const root = path.join(base, 'agent');
  const folders = async () => ({ startup: path.join(root, 'LaunchAgents') });
  const data = path.join(root, 'data');
  const plist = path.join(root, 'LaunchAgents', `${AGENT_LABEL}.plist`);
  // The `ledung` command gets --foreground: launchd keeps it, so it must not go to the background and exit.
  const cli = path.join(root, 'pkg', 'dist', 'cli.js');
  await new Shortcuts({ launch: { node: '/usr/local/bin/node', script: cli }, iconDir: data, icons, meta: memoryMeta(), platform: 'darwin', folders }).act('sign-in-on');
  let text = fs.readFileSync(plist, 'utf8');
  assert.ok(text.includes(`<key>Label</key><string>${AGENT_LABEL}</string>`), text);
  // Through sh, with Ledung.app's Node lookup: a Node upgrade must not stop it silently (Mac check of PR #11, note 2).
  let [shell, flag, script] = agentArgs(text);
  assert.deepEqual([shell, flag], ['/bin/sh', '-c']);
  // After the login shell's PATH (#464).
  assert.ok(script!.includes(`\nNODE='/usr/local/bin/node'\n[ -x "$NODE" ] || NODE=$("\${SHELL:-/bin/zsh}" -lic 'command -v node'`), script);
  assert.ok(script!.endsWith(`\nexec "$NODE" '${cli}' '--foreground' '--no-open'`), script);
  assert.ok(text.includes('<key>RunAtLoad</key><true/>'), text);
  assert.ok(!text.includes('KeepAlive'), 'Stop Ledung stops it until the next login');
  assert.ok(text.includes(`<key>StandardOutPath</key><string>${path.join(data, 'ledung.log')}</string>`), text);
  // Settings → Log then says its output is in the log (review of PR #11, Minor 1).
  assert.ok(text.includes(`<key>EnvironmentVariables</key>\n  <dict>\n    <key>LEDUNG_LOG_FILE</key><string>${path.join(data, 'ledung.log')}</string>\n  </dict>`), text);
  // The release launcher runs where it is started already.
  const launcher = path.join(data, 'launcher.mjs');
  await new Shortcuts({ launch: { node: '/usr/local/bin/node', script: launcher }, iconDir: data, icons, meta: memoryMeta(), platform: 'darwin', folders }).act('sign-in-on');
  text = fs.readFileSync(plist, 'utf8');
  [, , script] = agentArgs(text);
  assert.ok(script!.endsWith(`\nexec "$NODE" '${launcher}' '--no-open'`), script);
});

/** The LaunchAgent's ProgramArguments, as launchd reads them. */
function agentArgs(plist: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)![1]!;
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

test('macOS: the LaunchAgent finds Node through the login shell when Node has moved, and says so in the log when it cannot', { skip: process.platform === 'win32' && 'runs /bin/sh' }, async () => {
  const root = path.join(base, 'agent-node');
  const data = path.join(root, 'data');
  const cli = path.join(root, 'cli.mjs');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(cli, "console.log('started ' + process.argv.slice(2).join(' '));");
  // Node where it was is gone; the login shell (a stand-in that answers `command -v node`) knows where it is now.
  await new Shortcuts({ launch: { node: path.join(root, 'old', 'node'), script: cli }, iconDir: data, icons, meta: memoryMeta(), platform: 'darwin', folders: async () => ({ startup: path.join(root, 'LaunchAgents') }) }).act('sign-in-on');
  const [shell, flag, script] = agentArgs(fs.readFileSync(path.join(root, 'LaunchAgents', `${AGENT_LABEL}.plist`), 'utf8'));
  const login = path.join(root, 'login-shell');
  fs.writeFileSync(login, `#!/bin/sh\necho '${process.execPath}'\n`, { mode: 0o755 });
  const env = { PATH: '/usr/bin:/bin', SHELL: login };
  assert.equal(execFileSync(shell!, [flag!, script!], { env }).toString().trim(), 'started --foreground --no-open');
  // No Node at all: a line in the log (launchd's StandardErrorPath), not a silent failure.
  fs.writeFileSync(login, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.throws(() => execFileSync(shell!, [flag!, script!], { env, stdio: 'pipe' }), (e: { stderr: Buffer }) => /Ledung cannot find Node\.js/.test(e.stderr.toString()));
});

test('Linux: the start at sign-in is an autostart entry; shortcuts stay unavailable', async () => {
  const root = path.join(base, 'autostart');
  const s = new Shortcuts({ launch: { node: '/usr/bin/node', script: '/opt/ledung 1/dist/cli.js' }, iconDir: path.join(root, 'data'), icons, meta: memoryMeta(), platform: 'linux', folders: async () => ({ startup: path.join(root, 'autostart') }) });
  const view = await s.act('sign-in-on');
  assert.equal(view.available, false);
  assert.equal(view.signIn.label, 'Start Ledung when I log in');
  const entry = fs.readFileSync(path.join(root, 'autostart', `${AGENT_LABEL}.desktop`), 'utf8');
  assert.ok(entry.startsWith('[Desktop Entry]\nType=Application\nName=Ledung\n'), entry);
  // Through sh for the login shell's PATH (#464), then Node with Ledung's arguments.
  const [shell, flag, script] = execArgs(entry);
  assert.deepEqual([shell, flag], ['/bin/sh', '-c']);
  assert.ok(script!.includes("; NODE='/usr/bin/node'; "), script);
  assert.ok(script!.endsWith(`; exec "$NODE" '/opt/ledung 1/dist/cli.js' '--no-open'`), script);
  assert.ok(entry.includes('\nTerminal=false\n'), entry);
});

/** A .desktop file's Exec arguments, as the desktop reads them: % and the file's backslashes first, then the quoting. */
function execArgs(entry: string): string[] {
  const line = /^Exec=(.*)$/m.exec(entry)![1]!.replace(/%%/g, '%').replace(/\\\\/g, '\\');
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, '$1'));
}

/** The sign-in start's sh script for a stand-in Ledung that prints the PATH it got and how it was set (#464). */
async function signInRun(name: string, platform: 'darwin' | 'linux'): Promise<{ args: string[]; root: string }> {
  const root = path.join(base, name);
  const data = path.join(root, 'data');
  const cli = path.join(root, 'cli.mjs');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(cli, 'console.log(JSON.stringify({ path: process.env.PATH, how: process.env.LEDUNG_START_PATH }));');
  await new Shortcuts({ launch: { node: process.execPath, script: cli }, iconDir: data, icons, meta: memoryMeta(), platform, folders: async () => ({ startup: path.join(root, 'start') }) }).act('sign-in-on');
  const text = fs.readFileSync(path.join(root, 'start', `${AGENT_LABEL}.${platform === 'darwin' ? 'plist' : 'desktop'}`), 'utf8');
  return { args: platform === 'darwin' ? agentArgs(text) : execArgs(text), root };
}

/** The PATH Ledung gets: the one given, with Node's own folder added when it isn't on it. */
function withNode(pathList: string): string {
  const dir = path.dirname(process.execPath);
  return pathList.split(':').includes(dir) ? pathList : `${pathList}:${dir}`;
}

/** launchd's PATH for an agent. */
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

for (const platform of ['darwin', 'linux'] as const) {
  test(`${platform}: the start at sign-in runs Ledung with the login shell's PATH, not the bare one it is started with (#464)`, { skip: process.platform === 'win32' && 'runs /bin/sh' }, async () => {
    const { args: [shell, flag, script], root } = await signInRun(`login-path-${platform}`, platform);
    assert.equal(shell, '/bin/sh');
    // A stand-in login shell: its profile prints a line of its own, and its PATH has the folder npm, gh and the
    // sessions' tools live in; it runs the command it is given the way zsh -lic does.
    const tools = path.join(root, 'homebrew bin');
    const login = path.join(root, 'login-shell');
    fs.writeFileSync(login, `#!/bin/sh\necho 'Welcome back'\nPATH='${tools}:/usr/bin:/bin' exec /bin/sh -c "$2"\n`, { mode: 0o755 });
    const out = execFileSync(shell!, [flag!, script!], { env: { PATH: BARE_PATH, SHELL: login, HOME: root } }).toString();
    assert.deepEqual(JSON.parse(out), { path: withNode(`${tools}:/usr/bin:/bin`), how: 'login' });
    // A login shell that fails: the PATH it was started with, plus Node's folder for npm's `#!/usr/bin/env node`.
    fs.writeFileSync(login, '#!/bin/sh\necho broken profile >&2\nexit 1\n', { mode: 0o755 });
    const fallback = execFileSync(shell!, [flag!, script!], { env: { PATH: BARE_PATH, SHELL: login, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    assert.deepEqual(JSON.parse(fallback), { path: withNode(BARE_PATH), how: 'fallback' });
  });
}

test("macOS: a login shell that never answers doesn't stop the start at sign-in: Ledung starts on launchd's PATH after about ten seconds (#464)", { skip: process.platform === 'win32' && 'runs /bin/sh' }, async () => {
  const { args: [shell, flag, script], root } = await signInRun('login-path-hangs', 'darwin');
  const login = path.join(root, 'login-shell');
  fs.writeFileSync(login, '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
  const started = Date.now();
  const result = spawnSync(shell!, [flag!, script!], { env: { PATH: BARE_PATH, SHELL: login, HOME: root }, timeout: 40_000 });
  const seconds = (Date.now() - started) / 1000;
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(JSON.parse(result.stdout.toString()), { path: withNode(BARE_PATH), how: 'fallback' });
  assert.ok(seconds >= 7 && seconds < 30, `started after ${seconds} s`);
  // Stopped quietly: sh's "Terminated" notice would go to the log.
  assert.equal(result.stderr.toString(), '');
});

test('an Exec argument escapes quotes, $, backquotes and backslashes, and doubles %', () => {
  // Quoting first (a\"b, \$HOME, a\\b), then the file's string escape doubles every backslash once more.
  assert.equal(desktopArg('a"b'), '"a\\\\"b"');
  assert.equal(desktopArg('$HOME'), '"\\\\$HOME"');
  assert.equal(desktopArg('a\\b'), '"a\\\\\\\\b"');
  assert.equal(desktopArg('100%'), '"100%%"');
  assert.equal(desktopArg('/plain/path'), '"/plain/path"');
});

test('the icons and the start at sign-in share the env file: each keeps it while the other is on', async () => {
  const root = path.join(base, 'shared');
  const data = path.join(root, 'data');
  const folders = async () => ({ applications: path.join(root, 'Applications'), startup: path.join(root, 'LaunchAgents') });
  const s = new Shortcuts({ launch: { node: process.execPath, script: path.join(data, 'launcher.mjs'), env: { LEDUNG_DATA_DIR: data } }, iconDir: data, icons, meta: memoryMeta(), platform: 'darwin', folders });
  await s.act('add');
  await s.act('sign-in-on');
  await s.act('remove');
  assert.ok(fs.existsSync(path.join(data, ENV_FILE)), 'the start at sign-in still needs the env file');
  await s.act('sign-in-off');
  assert.equal(fs.existsSync(path.join(data, ENV_FILE)), false);
});

test('a Ledung with its own data folder keeps its start at sign-in in it too', async () => {
  const data = path.join(base, 'own-startup');
  await withLedungEnv({ LEDUNG_DATA_DIR: data }, async () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const view = await new Shortcuts({ launch: { node: process.execPath, script: 'x' }, iconDir: data, icons, meta: memoryMeta(), platform }).view();
      assert.ok(view.signIn.file?.startsWith(path.join(data, 'shortcuts') + path.sep), `${platform}: ${view.signIn.file}`);
    }
  });
});

test('the start script escapes everything outside ASCII, which Windows Script Host would read in the code page', () => {
  const text = starterText('"C:\\Users\\Åsa\\node.exe" "x"', '');
  assert.ok(text.includes('"\\"C:\\\\Users\\\\\\u00c5sa\\\\node.exe\\" \\"x\\""'), text);
  assert.ok(!/[^\x00-\x7e]/.test(text), 'ASCII only');
});

test('Windows: On puts a shortcut in the Startup folder, starting with no window and without the page', { skip: process.platform !== 'win32' && 'makes real Windows shortcuts' }, async () => {
  const root = path.join(base, 'startup-windows');
  const data = path.join(root, 'data');
  const s = new Shortcuts({ launch: { node: process.execPath, script: path.join(root, 'pkg', 'dist', 'cli.js') }, iconDir: data, icons, meta: memoryMeta(), platform: 'win32', folders: async () => ({ desktop: path.join(root, 'Desktop'), 'start-menu': path.join(root, 'Programs'), startup: path.join(root, 'Startup') }) });
  const file = path.join(root, 'Startup', 'Ledung at sign-in.lnk');
  const view = await s.act('sign-in-on');
  assert.deepEqual(view.signIn, { available: true, reason: null, label: 'Start Ledung when I sign in to Windows', on: true, file });
  const link = readLink(file);
  assert.equal(String(link.target).toLowerCase(), wscript().toLowerCase());
  assert.equal(link.arguments, `"//Nologo" "${path.join(data, STARTER_FILE)}" "--no-open"`);
  assert.ok(view.places.every((p) => !p.present), 'no icon is added with it');
  const off = await s.act('sign-in-off');
  assert.equal(off.signIn.on, false);
  assert.equal(fs.existsSync(file) || fs.existsSync(path.join(data, STARTER_FILE)), false);
});

// Found in the loopback run: a Startup folder can hold a Ledung.lnk the person made to start Ledung their own way.
test("a Ledung.lnk of the person's own in the Startup folder is not counted as on, and Off leaves it", async () => {
  const root = path.join(base, 'startup-own');
  const own = path.join(root, 'Startup', 'Ledung.lnk');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, 'their own');
  const s = new Shortcuts({ launch: { node: process.execPath, script: 'x' }, iconDir: path.join(root, 'data'), icons, meta: memoryMeta(), platform: 'win32', folders: async () => ({ startup: path.join(root, 'Startup') }) });
  assert.equal((await s.view()).signIn.on, false);
  await s.act('sign-in-off');
  assert.equal(fs.readFileSync(own, 'utf8'), 'their own');
});
