// The desktop app from the npm package (#407; Martin, 2026-11-19, Ledung questions #572, #575 and #577): the package
// carries the app's code in dist/desktop/ and Electron as an optional dependency. Electron's npm package downloads no
// binary at install, so the first time `ledung` opens the app it downloads Electron's binary, with Electron's own
// downloader and checksums, and makes a "Ledung" app from it in one fixed folder in the data folder: Ledung.app on the
// Mac, Ledung\Ledung.exe on Windows, ledung/ledung on Linux. A fixed place keeps a Dock or taskbar pin and the Mac's
// notification permission pointing at the same app. A stamp next to it records what it was made from; a new Electron
// makes it again, a new Ledung (or another Node) only writes its code again. Unsigned: no signing, notarisation or
// installer for now (#572); the Mac app is signed ad hoc, as Electron's own is (issue #407, finding 3).
//
// Never in a postinstall: this runs as the person, in their data folder, works with --ignore-scripts and never makes
// `npm install` slow or fail. Electron's download cache goes in the making folder and is removed with it.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dockIconLayout } from '../../desktop/dock-icon.ts';
import { APP_ID, MADE_CONFIG, START_HIDDEN_FILE, WRITE_SHORTCUT_ARG, type MadeConfig } from '../../desktop/made.ts';
import { startEnv } from '../../desktop/start.ts';
import type { DesktopAppInfo } from '../shared/protocol.ts';
import { exercisedLine } from './exercised.ts';
import { icnsFromPngs, icoFromPng } from './icons.ts';
import { appDir, PACKAGED } from './paths.ts';

/** Where the made app and its stamp live, inside the data folder. */
export interface MadePaths {
  /** <data folder>/desktop. */
  root: string;
  /** What is replaced as a whole when Electron changes: Ledung.app, or the Ledung (ledung) folder. */
  bundle: string;
  /** The program that runs. */
  exe: string;
  /** The app's own code: main.js, its files and the made config. */
  code: string;
  /** What the app was made from. */
  stamp: string;
  /** The folder the app is made in before it takes the bundle's place; removed after. */
  work: string;
}

export function madePaths(dataDir: string, platform: NodeJS.Platform = process.platform): MadePaths {
  const root = path.join(dataDir, 'desktop');
  const common = { root, stamp: path.join(root, 'stamp.json'), work: path.join(root, '.making') };
  if (platform === 'darwin') {
    const bundle = path.join(root, 'Ledung.app');
    // The executable keeps Electron's name: Electron finds its helper apps ("Electron Helper") by it, and renaming
    // those is left out (issue #407, out of scope).
    return { ...common, bundle, exe: path.join(bundle, 'Contents', 'MacOS', 'Electron'), code: path.join(bundle, 'Contents', 'Resources', 'app') };
  }
  const bundle = path.join(root, platform === 'win32' ? 'Ledung' : 'ledung');
  return { ...common, bundle, exe: path.join(bundle, platform === 'win32' ? 'Ledung.exe' : 'ledung'), code: path.join(bundle, 'resources', 'app') };
}

/** Electron's npm package where this Ledung is installed: its folder and version. */
export interface ElectronPackage {
  dir: string;
  version: string;
}

/** Electron's package as the package's own dependencies resolve it; null when it is not installed (--omit=optional). */
export function electronPackage(app = appDir()): ElectronPackage | null {
  try {
    const file = createRequire(path.join(app, 'package.json')).resolve('electron/package.json');
    const version = (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? { dir: path.dirname(file), version } : null;
  } catch {
    return null;
  }
}

/**
 * What brings Electron's package back: installing Ledung again the way it was installed (self-check finding 3: a fixed
 * `npm install -g ledung` would move a dev install to the public release). npm ignores --omit=optional for a global
 * install (Ledung question #585), so a missing package is mostly a failed optional install or a local one without it.
 */
export const ADD_COMMAND = 'install Ledung again as you did: npm install -g ledung, or npm install -g ledung@dev for dev builds';

export type Availability =
  | { ok: true; electron: ElectronPackage; source: string }
  | { ok: false; reason: string };

/**
 * Whether this Ledung can open the desktop app, and why not when it can't. Only the npm package carries the app's
 * bundled code; a clone runs it from desktop/ (desktop/README.md). Linux with no display gets the browser route.
 */
export function desktopAvailability(opts: { app?: string; packaged?: boolean; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): Availability {
  const app = opts.app ?? appDir();
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (!(opts.packaged ?? PACKAGED)) return { ok: false, reason: 'Run from a clone, the desktop app runs from desktop/ there: npm install, then npm start in that folder.' };
  if (!['darwin', 'win32', 'linux'].includes(platform)) return { ok: false, reason: `The desktop app is not made for ${platform}.` };
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return { ok: false, reason: 'There is no display here (DISPLAY and WAYLAND_DISPLAY are not set).' };
  const source = path.join(app, 'dist', 'desktop');
  if (!fs.existsSync(path.join(source, 'main.js'))) return { ok: false, reason: 'This Ledung package has no desktop app.' };
  const electron = electronPackage(app);
  if (!electron) return { ok: false, reason: `The desktop app is not installed: Electron's package is missing (its optional install failed or was left out). To add it, ${ADD_COMMAND}.` };
  return { ok: true, electron, source };
}

/**
 * Whether the config switches the app off for `ledung` ("desktopApp": false, Martin 2026-11-19, Ledung question #585),
 * read straight from the file as the port is (running.ts configuredPort): a config that can't be read leaves it on.
 */
export function desktopAppOff(configFile: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(configFile, 'utf8')) as { desktopApp?: unknown }).desktopApp === false;
  } catch {
    return false;
  }
}

/** What `ledung` was asked to open: the command line's part of it, before anyone looks for the app. */
export interface OpenChoice {
  /** `ledung app`: the app or a reason, never the browser. */
  appCommand: boolean;
  /** --no-open: nothing opens, not even for `ledung app`. */
  noOpen: boolean;
  /** Whether to look for the app at all; when it is there, it opens instead of the browser. */
  tryApp: boolean;
  /** The arguments the started Ledung gets: the command's own (--browser, --open-only, --foreground, `app`) taken out. */
  passthrough: string[];
}

/**
 * What `ledung` opens (#407, Martin 2026-11-19, Ledung questions #577 and #585), from its arguments and the config's
 * "desktopApp" switch. The app by default, --open-only included: the Mac's Ledung.app opens a running Ledung with it,
 * and the shortcuts open the app (#409). The browser for --browser, "desktopApp": false and --foreground (development,
 * where the core opens it itself). `ledung app` insists on the app whatever the switch says. --no-open opens nothing,
 * `ledung app` included: the app's own Start Ledung and the sign-in start run it (self-check finding 2).
 */
export function openChoice(args: string[], desktopOff: boolean): OpenChoice {
  const own = ['--open-only', '--foreground', '--browser'];
  let passthrough = args.filter((a) => !own.includes(a));
  const appCommand = passthrough[0] === 'app';
  if (appCommand) passthrough = passthrough.slice(1);
  const noOpen = passthrough.includes('--no-open');
  const browserOnly = ['--foreground', '--browser'];
  const tryApp = !noOpen && (appCommand || !(desktopOff || browserOnly.some((a) => args.includes(a))));
  return { appCommand, noOpen, tryApp, passthrough };
}

/** The started Ledung's arguments: with the app to open, it opens no browser of its own (--no-open). */
export function backgroundArgs(choice: OpenChoice, appReady: boolean): string[] {
  return [...choice.passthrough, ...(appReady && !choice.noOpen ? ['--no-open'] : [])];
}

/** What the made app was made from: a new Electron makes it again, anything else only rewrites its code. */
export interface Stamp {
  electron: string;
  platform: string;
  arch: string;
  ledung: string;
  config: MadeConfig;
}

export function readStamp(file: string): Stamp | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Stamp;
    return typeof s.electron === 'string' && typeof s.ledung === 'string' ? s : null;
  } catch {
    return null;
  }
}

/** What has to be done: nothing, the app's code only, or all of it from a new download. */
export function whatToMake(stamp: Stamp | null, want: Stamp, bundleThere: boolean): 'nothing' | 'code' | 'all' {
  if (!stamp || !bundleThere || stamp.electron !== want.electron || stamp.platform !== want.platform || stamp.arch !== want.arch) return 'all';
  return stamp.ledung === want.ledung && JSON.stringify(stamp.config) === JSON.stringify(want.config) ? 'nothing' : 'code';
}

/** The made app's package.json: its name "Ledung" is the app's name in Electron (the Mac's menu, Linux's window class). */
export function appManifest(version: string): Record<string, unknown> {
  return { name: 'ledung-app', productName: 'Ledung', version, private: true, type: 'module', main: 'main.js', desktopName: 'ledung.desktop' };
}

const run = (file: string, args: string[]) => new Promise<void>((resolve, reject) => {
  execFile(file, args, { windowsHide: true }, (error, _stdout, stderr) => (error ? reject(new Error(`${path.basename(file)} ${args[0] ?? ''} failed: ${stderr.trim() || error.message}`)) : resolve()));
});

/** Downloads Electron's zip for this system with Electron's own downloader and checksums; returns the zip's path. */
async function downloadElectron(electron: ElectronPackage, platform: string, arch: string, cacheRoot: string, progress: (percent: number) => void): Promise<string> {
  const req = createRequire(path.join(electron.dir, 'package.json'));
  const get = (await import(pathToFileURL(req.resolve('@electron/get')).href)) as {
    downloadArtifact(details: Record<string, unknown>): Promise<string>;
  };
  const checksums = JSON.parse(fs.readFileSync(path.join(electron.dir, 'checksums.json'), 'utf8')) as Record<string, string>;
  return get.downloadArtifact({
    version: electron.version,
    artifactName: 'electron',
    platform,
    arch,
    checksums,
    cacheRoot,
    tempDirectory: cacheRoot,
    downloadOptions: { quiet: true, getProgressCallback: async (p: { percent: number }) => progress(p.percent) },
  });
}

/** Unzips with Electron's own extractor, as its install script does (it keeps the Mac app's links). */
async function extractZip(electron: ElectronPackage, zip: string, dir: string): Promise<void> {
  const req = createRequire(path.join(electron.dir, 'package.json'));
  const { extract } = (await import(pathToFileURL(req.resolve('@electron-internal/extract-zip')).href)) as {
    extract(zip: string, opts: { dir: string }): Promise<void>;
  };
  await extract(zip, { dir });
}

/** The Mac icon (#404): icon-512.png shrunk to Apple's grid with a clear margin round it, at 512 and 256 px, by sips. */
async function macIcns(png: string, work: string): Promise<Buffer> {
  const { body } = dockIconLayout(512);
  const small = path.join(work, 'icon-body.png');
  const big = path.join(work, 'icon-512.png');
  const half = path.join(work, 'icon-256.png');
  await run('/usr/bin/sips', ['-z', String(body), String(body), png, '--out', small]);
  await run('/usr/bin/sips', ['-p', '512', '512', small, '--out', big]);
  await run('/usr/bin/sips', ['-z', '256', '256', big, '--out', half]);
  return icnsFromPngs([fs.readFileSync(half), fs.readFileSync(big)]);
}

/** Turns the unzipped Electron in `unzipped` into Ledung's app; returns the folder that becomes the bundle. */
async function shapeApp(unzipped: string, source: string, work: string, platform: NodeJS.Platform): Promise<string> {
  if (platform === 'darwin') {
    const bundle = path.join(unzipped, 'Electron.app');
    const plist = path.join(bundle, 'Contents', 'Info.plist');
    // The names the menu, the Dock, Cmd-Tab and Notifications show (#405), and an id of the app's own.
    for (const [key, value] of [['CFBundleName', 'Ledung'], ['CFBundleDisplayName', 'Ledung'], ['CFBundleIdentifier', APP_ID]]) {
      await run('/usr/bin/plutil', ['-replace', key!, '-string', value!, plist]);
    }
    fs.writeFileSync(path.join(bundle, 'Contents', 'Resources', 'electron.icns'), await macIcns(path.join(source, 'icon-512.png'), work));
    fs.rmSync(path.join(bundle, 'Contents', 'Resources', 'default_app.asar'), { force: true });
    return bundle;
  }
  const exe = platform === 'win32' ? ['electron.exe', 'Ledung.exe'] : ['electron', 'ledung'];
  fs.renameSync(path.join(unzipped, exe[0]!), path.join(unzipped, exe[1]!));
  fs.rmSync(path.join(unzipped, 'resources', 'default_app.asar'), { force: true });
  if (platform === 'win32') await setExeDetails(path.join(unzipped, exe[1]!), icoFromPng(fs.readFileSync(path.join(source, 'icon-256.png'))));
  return unzipped;
}

/** The names Windows shows for the program: Task Manager's is FileDescription (Martin, 2026-11-19, Ledung question #587). */
export const EXE_STRINGS = { FileDescription: 'Ledung', ProductName: 'Ledung', InternalName: 'Ledung', OriginalFilename: 'Ledung.exe' } as const;

/**
 * Rewrites Ledung.exe's file details and icon (#587 "b — Both now"), so Task Manager and the file's properties say
 * Ledung instead of Electron. resedit, an optional dependency like Electron, is plain JavaScript with no program of its
 * own; rcedit was dropped for npm's takedown notice on every version. Electron's own signature goes with the edit: the
 * app is unsigned anyway (#572), and it is made on this computer, so it carries no download mark for SmartScreen.
 */
export async function setExeDetails(file: string, ico: Buffer): Promise<void> {
  const { NtExecutable, NtExecutableResource, Resource, Data } = await import('resedit');
  const exe = NtExecutable.from(fs.readFileSync(file), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  const info = Resource.VersionInfo.fromEntries(res.entries)[0] ?? Resource.VersionInfo.createEmpty();
  const languages = info.getAllLanguagesForStringValues();
  for (const language of languages.length ? languages : [{ lang: 1033, codepage: 1200 }]) info.setStringValues(language, EXE_STRINGS);
  info.outputToResourceEntries(res.entries);
  const group = Resource.IconGroupEntry.fromEntries(res.entries)[0];
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, group?.id ?? 1, group?.lang ?? 1033, Data.IconFile.from(ico).icons.map((i) => i.data));
  res.outputResource(exe);
  fs.writeFileSync(file, Buffer.from(exe.generate()));
}

/**
 * The made app's Start-menu shortcut inside the Start menu's Programs folder (#587): in a folder of its own, so it is
 * named "Ledung" without taking the launcher shortcut's Ledung.lnk. Windows names the app's notifications after it.
 * Settings → Shortcuts → Remove deletes it (shortcuts.ts).
 */
export const APP_SHORTCUT = path.join('Ledung app', 'Ledung.lnk');

/**
 * Starts the just-made Windows app once to write its Start-menu shortcut (desktop/made.ts WRITE_SHORTCUT_ARG) and waits
 * for it; null when written, else what went wrong. Its throwaway profile is removed after.
 */
export function writeAppShortcut(paths: MadePaths, file: string, timeoutMs = 30_000): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (failed: string | null) => {
      clearTimeout(timer);
      fs.rmSync(path.join(paths.root, '.shortcut-profile'), { recursive: true, force: true });
      resolve(failed);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(paths.exe, [`${WRITE_SHORTCUT_ARG}=${file}`], { stdio: 'ignore', windowsHide: true, env: startEnv(process.env, 'win32') });
    } catch (e) {
      resolve((e as Error).message);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(`it did not finish within ${timeoutMs / 1000} s`);
    }, timeoutMs);
    child.on('error', (e) => done(e.message));
    child.on('exit', (code) => done(code === 0 ? null : `it exited with code ${code}`));
  });
}

/** Writes the app's code: the package's dist/desktop files, its package.json and the made config. */
export function writeAppCode(code: string, source: string, version: string, config: MadeConfig): void {
  fs.rmSync(code, { recursive: true, force: true });
  fs.cpSync(source, code, { recursive: true });
  fs.writeFileSync(path.join(code, 'package.json'), `${JSON.stringify(appManifest(version), null, 2)}\n`);
  fs.writeFileSync(path.join(code, MADE_CONFIG), `${JSON.stringify(config, null, 2)}\n`);
}

export interface MakeOptions {
  dataDir: string;
  electron: ElectronPackage;
  /** The package's dist/desktop. */
  source: string;
  ledungVersion: string;
  config: MadeConfig;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Download progress, 0 to 1. */
  progress?: (percent: number) => void;
  /** One line before the download, saying what comes. */
  print?: (line: string) => void;
  /** Windows: the Start menu's Programs folder, where a full make writes the app's shortcut (#587). */
  startMenu?: string;
}

/**
 * Makes the app, or brings its code up to date, when the stamp says so; returns what was done. The new app is made in
 * the making folder and takes the old one's place only when it is whole, so a failed download leaves the old app as
 * it was. Throws with one line when something fails.
 */
export async function ensureApp(o: MakeOptions): Promise<{ made: 'nothing' | 'code' | 'all'; paths: MadePaths }> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const paths = madePaths(o.dataDir, platform);
  const want: Stamp = { electron: o.electron.version, platform, arch, ledung: o.ledungVersion, config: o.config };
  const made = whatToMake(readStamp(paths.stamp), want, fs.existsSync(paths.exe));
  if (made === 'nothing') return { made, paths };
  fs.mkdirSync(paths.root, { recursive: true });
  fs.rmSync(paths.work, { recursive: true, force: true });
  fs.mkdirSync(paths.work, { recursive: true });
  try {
    if (made === 'all') {
      o.print?.(`Making the desktop app, once: downloading Electron ${o.electron.version} for ${platform}-${arch} into ${paths.root}`);
      const cache = path.join(paths.work, 'cache');
      fs.mkdirSync(cache, { recursive: true });
      const zip = await downloadElectron(o.electron, platform, arch, cache, o.progress ?? (() => {}));
      const unzipped = path.join(paths.work, 'unzipped');
      await extractZip(o.electron, zip, unzipped);
      // Electron's download cache is not kept: about 121 MB a version, and the made app is what is used.
      fs.rmSync(path.join(paths.work, 'cache'), { recursive: true, force: true });
      const bundle = await shapeApp(unzipped, o.source, paths.work, platform);
      writeAppCode(path.join(bundle, path.relative(paths.bundle, paths.code)), o.source, o.ledungVersion, o.config);
      if (platform === 'darwin') await run('/usr/bin/codesign', ['--force', '--deep', '-s', '-', bundle]);
      // The old app is moved aside in one step, not deleted in place: on Windows a running one can't be moved, and the
      // make stops with the old app whole instead of half deleted.
      const old = `${paths.bundle}.old`;
      fs.rmSync(old, { recursive: true, force: true });
      const hadOld = fs.existsSync(paths.bundle);
      if (hadOld) fs.renameSync(paths.bundle, old);
      try {
        fs.renameSync(bundle, paths.bundle);
      } catch (e) {
        // The new app could not take its place: the old one goes back, with its stamp still saying what it is
        // (self-check finding 5).
        try {
          if (hadOld) fs.renameSync(old, paths.bundle);
        } catch {
          // The swap's own error is the one worth showing; the old app stays in .old.
        }
        throw e;
      }
      fs.rmSync(paths.stamp, { force: true });
      try {
        fs.rmSync(old, { recursive: true, force: true });
      } catch {
        // Left for the next make, which removes it first.
      }
    } else {
      writeAppCode(paths.code, o.source, o.ledungVersion, o.config);
      // The app's code is inside the Mac app's signed contents: sign it again (0.5 s, issue #407 finding 4).
      if (platform === 'darwin') await run('/usr/bin/codesign', ['--force', '--deep', '-s', '-', paths.bundle]);
    }
    fs.writeFileSync(paths.stamp, `${JSON.stringify(want, null, 2)}\n`);
    // Windows: the Start-menu shortcut, written when the app is made (#587); a code rewrite leaves it as it is, so one
    // Settings removed stays removed until Electron changes. Not writing it does not stop the app opening.
    if (made === 'all' && platform === 'win32' && o.startMenu) {
      const failed = await writeAppShortcut(paths, path.join(o.startMenu, APP_SHORTCUT));
      if (failed) o.print?.(`The desktop app's Start-menu shortcut was not written: ${failed}.`);
    }
    return { made, paths };
  } finally {
    fs.rmSync(paths.work, { recursive: true, force: true });
  }
}

/** An Electron version's major: 45 of 45.4.1. Electron's majors are what change its API; its minors and patches don't. */
export const electronMajor = (version: string): string => version.split('.')[0] ?? version;

/**
 * Updating Ledung (#408, Martin 2026-11-19, Ledung question #577): a new Electron the app's binary can't be downloaded
 * for yet (offline) leaves the app it has. On the same Electron major that app takes the new Ledung's code, and its
 * stamp keeps its own Electron, so the next start downloads again; on another major it is left as it was (null) and the
 * browser opens. Null too with no app made here, or one for another system. Returns the app and its Electron.
 */
export async function codeIntoKept(o: MakeOptions): Promise<{ paths: MadePaths; electron: string } | null> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const paths = madePaths(o.dataDir, platform);
  const kept = readStamp(paths.stamp);
  if (!kept || !fs.existsSync(paths.exe) || kept.platform !== platform || kept.arch !== arch) return null;
  if (electronMajor(kept.electron) !== electronMajor(o.electron.version)) return null;
  writeAppCode(paths.code, o.source, o.ledungVersion, o.config);
  if (platform === 'darwin') await run('/usr/bin/codesign', ['--force', '--deep', '-s', '-', paths.bundle]);
  const stamp: Stamp = { electron: kept.electron, platform, arch, ledung: o.ledungVersion, config: o.config };
  fs.writeFileSync(paths.stamp, `${JSON.stringify(stamp, null, 2)}\n`);
  return { paths, electron: kept.electron };
}

/**
 * The line the page shows when the app could not be opened and the browser opened instead (#408: "the browser opens,
 * with one line saying why"): after an update no terminal shows it. Written by the fallback, removed when the app opens.
 */
export const noticeFile = (dataDir: string): string => path.join(dataDir, 'desktop', 'notice.txt');

/**
 * The made app against the running Ledung, read from its stamp at each ask: a restart without an update (#408: "Restart
 * Ledung alone never remakes or restarts the app") finds them the same, and the restarted app's stamp is the new one.
 * Only Ledung's version counts, not Electron's: an app kept on its old Electron after a failed download (codeIntoKept)
 * has the new Ledung, and counting it out of date would restart it again and again while offline (self-check finding
 * 3). A new Electron comes with a new Ledung version, so the update's restart makes it; a failed one is tried again at
 * the next start. The made config (its Node, its command) does not count either: `ledung` rewrites it when it changes.
 */
export function desktopAppState(o: { dataDir: string; ledungVersion: string; platform?: NodeJS.Platform }): DesktopAppInfo | null {
  const paths = madePaths(o.dataDir, o.platform ?? process.platform);
  const stamp = readStamp(paths.stamp);
  let notice: string | null = null;
  try {
    notice = fs.readFileSync(noticeFile(o.dataDir), 'utf8').trim() || null;
  } catch {
    // None.
  }
  const made = stamp !== null && fs.existsSync(paths.exe);
  if (!made && notice === null) return null;
  const stale = made && stamp.ledung !== o.ledungVersion;
  return { stale, notice };
}

/** The app made on this computer, when there is one to open: its stamp and its program are both there (#409). */
export function madeApp(dataDir: string, platform: NodeJS.Platform = process.platform): MadePaths | null {
  const paths = madePaths(dataDir, platform);
  return readStamp(paths.stamp) !== null && fs.existsSync(paths.exe) ? paths : null;
}

/** Said when there is no app to open, so the caller opens the browser: no line to show for it, it is the usual case. */
export const NO_APP = 'No desktop app is made on this computer.';

let openedTraced = false;

/**
 * Opens the app made on this computer from the running Ledung (#409): the tray's Open and the page's "Open in the Ledung
 * app". Null when it opened; else why not, and the caller opens the browser. Only an app that is made already: the
 * running Ledung has no terminal to show a 120 MB download in, so making it stays with `ledung` and the shortcuts. Not
 * with "desktopApp": false, and not from a clone, which has no made app of its own (main.ts, as for desktopAppState).
 * An app on an older Ledung opens too: its page restarts it into the update (#408).
 */
export async function openMadeApp(o: { dataDir: string; off: boolean; packaged?: boolean; platform?: NodeJS.Platform; open?: (paths: MadePaths) => Promise<string | null> }): Promise<string | null> {
  if (o.off || !(o.packaged ?? PACKAGED)) return NO_APP;
  const platform = o.platform ?? process.platform;
  const paths = madeApp(o.dataDir, platform);
  if (!paths) return NO_APP;
  // The running Ledung's own settings stay with it: the app's Start Ledung would otherwise pass them on (#456, #408).
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['LEDUNG_LAUNCHER', 'LEDUNG_LOG_FILE'].includes(name.toUpperCase())));
  const failed = await (o.open ?? ((p) => openApp(p, platform, env)))(paths);
  if (failed === null && !openedTraced) {
    openedTraced = true;
    exercisedLine('EXERCISED #409 the running Ledung opened the made desktop app');
  }
  return failed;
}

/**
 * Waits for the app that asked for its restart (#408) to have ended: a new one started before would find the old one's
 * single-instance lock, hand it the start and quit. True when it ended in time.
 */
export async function waitForExit(pid: number, timeoutMs = 15_000, isRunning: (pid: number) => boolean = processRuns): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isRunning(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it runs, as someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Opens the made app, detached, with a clean environment (no ELECTRON_* or npm_*: desktop/start.ts). The Mac's through
 * `open`, so it is a proper app with its own Dock entry. An app that runs already shows its window (one app per
 * computer, desktop/main.ts). Resolves with null when it started, or the line saying why not.
 */
export function openApp(paths: MadePaths, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return new Promise((resolve) => {
    const [file, args] = platform === 'darwin' ? ['/usr/bin/open', [paths.bundle]] : [paths.exe, []];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, env: startEnv(env, platform) });
    } catch (e) {
      resolve(`Could not open the desktop app: ${(e as Error).message}`);
      return;
    }
    child.on('error', (e) => resolve(`Could not open the desktop app: ${e.message}`));
    // `open` returns at once, and its exit code says whether the app opened: waited for. The app itself is let go.
    if (platform === 'darwin') child.on('exit', (code) => resolve(code === 0 ? null : `Could not open the desktop app: open exited with code ${code}.`));
    else {
      child.on('spawn', () => resolve(null));
      child.unref();
    }
  });
}

/** What opening the app does, besides the defaults; tests replace them. */
export interface OpenSteps {
  ensure: (o: MakeOptions) => Promise<{ made: 'nothing' | 'code' | 'all'; paths: MadePaths }>;
  /** A failed make keeps the app there when it can (#408): codeIntoKept. Left out: nothing is kept. */
  keep?: (o: MakeOptions) => Promise<{ paths: MadePaths; electron: string } | null>;
  open: (paths: MadePaths) => Promise<string | null>;
  /** Opens Ledung's page in the browser, signed in: the fallback. */
  browser: () => void;
  print: (line: string) => void;
}

/** Download progress for a terminal: one line rewritten in place, or a line each quarter when the output is a file. */
export function progressPrinter(write: (text: string) => void, tty: boolean): (percent: number) => void {
  let shown = -1;
  return (percent) => {
    const whole = Math.floor(Math.max(0, Math.min(1, percent)) * 100);
    if (tty) {
      if (whole === shown) return;
      shown = whole;
      write(`\r  ${whole}%${whole === 100 ? '\n' : ''}`);
    } else if (shown < 0 || Math.floor(whole / 25) > Math.floor(shown / 25)) {
      shown = whole;
      write(`  ${whole}%\n`);
    }
  };
}

/**
 * Opens the desktop app for `ledung`, making it first when needed. When it can't be made or opened, one line says why
 * and the browser opens instead (issue #407: "A failed download opens the browser and says so in one line"); `ledung
 * app` (`fallback` false) only says why. A make that failed keeps the app there when it can (#408, `steps.keep`). A
 * browser fallback's line is also left for the page (noticeFile), since after an update no terminal shows it; an app
 * that opens removes it. `restarted`: the app asked for this, to finish an update (#408). Returns the exit code.
 */
export async function openDesktop(o: { make: Omit<MakeOptions, 'print'>; fallback: boolean; steps: OpenSteps; restarted?: boolean }): Promise<number> {
  let line: string;
  let hinted = false;
  const print = (text: string) => {
    o.steps.print(text);
    // Ledung itself already runs: stopping this wait leaves it running, and "ledung --browser" opens its page
    // (self-check finding 4). A stopped make leaves its folder, which the next make removes first.
    // Once, after the line announcing the download; later lines (a shortcut not written) come without it. Not for a
    // restart the app asked for: no one is at a terminal for it.
    if (o.fallback && !hinted && !o.restarted) o.steps.print('Ledung is already running: to use the browser instead, press Ctrl+C and run "ledung --browser".');
    hinted = true;
  };
  const notice = noticeFile(o.make.dataDir);
  try {
    let found: { made: 'nothing' | 'code' | 'all'; paths: MadePaths };
    try {
      found = await o.steps.ensure({ ...o.make, print });
    } catch (e) {
      const kept = await o.steps.keep?.({ ...o.make, print }).catch(() => null);
      if (!kept) throw e;
      o.steps.print(`Electron ${o.make.electron.version} could not be downloaded (${firstLine(e)}): the desktop app runs on Electron ${kept.electron} with the new Ledung until the next start tries again.`);
      found = { made: 'code', paths: kept.paths };
    }
    const { made, paths } = found;
    if (made !== 'nothing') {
      exercisedLine(`EXERCISED #407 desktop app ${made === 'all' ? 'made' : 'code rewritten'} in the data folder`);
      o.steps.print(made === 'all' ? `Made the desktop app: ${paths.bundle}` : 'Brought the desktop app up to date.');
    }
    const failed = await o.steps.open(paths);
    if (failed === null) {
      if (o.restarted) exercisedLine(`EXERCISED #408 desktop app restarted to finish an update (${made})`);
      fs.rmSync(notice, { force: true });
      return 0;
    }
    line = failed;
  } catch (e) {
    line = `The desktop app could not be made: ${firstLine(e)}`;
  }
  if (!o.fallback) {
    o.steps.print(line);
    return 1;
  }
  const why = line.replace(/[.\s]*$/, '.');
  o.steps.print(`${why} Opening Ledung in the browser instead.`);
  try {
    fs.mkdirSync(path.dirname(notice), { recursive: true });
    fs.writeFileSync(notice, `${why} Ledung opened in the browser instead; the next start of the app tries again.\n`);
    // A hidden app's restart that ended here: the app's next start, by hand, shows its window (desktop/main.ts,
    // self-check finding 2).
    fs.rmSync(path.join(path.dirname(notice), START_HIDDEN_FILE), { force: true });
  } catch {
    // The terminal has the line; only the page misses it.
  }
  o.steps.browser();
  return 0;
}

/** An error's first line: a download's message can carry a stack. */
const firstLine = (e: unknown): string => (e as Error).message.split('\n')[0] ?? '';
