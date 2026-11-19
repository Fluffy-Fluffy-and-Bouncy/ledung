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
import { APP_ID, MADE_CONFIG, type MadeConfig } from '../../desktop/made.ts';
import { startEnv } from '../../desktop/start.ts';
import { exercisedLine } from './exercised.ts';
import { icnsFromPngs } from './icons.ts';
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
 * install (Ledung question #584), so a missing package is mostly a failed optional install or a local one without it.
 */
export const ADD_COMMAND = 'install Ledung again as you did (npm install -g ledung, or ledung@dev for dev builds)';

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
 * Whether the config switches the app off for `ledung` ("desktopApp": false, Martin 2026-11-19, Ledung question #584),
 * read straight from the file as the port is (running.ts configuredPort): a config that can't be read leaves it on.
 */
export function desktopAppOff(configFile: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(configFile, 'utf8')) as { desktopApp?: unknown }).desktopApp === false;
  } catch {
    return false;
  }
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
  return unzipped;
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
        if (hadOld) fs.renameSync(old, paths.bundle);
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
    return { made, paths };
  } finally {
    fs.rmSync(paths.work, { recursive: true, force: true });
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
 * app` (`fallback` false) only says why. Returns the command's exit code.
 */
export async function openDesktop(o: { make: Omit<MakeOptions, 'print'>; fallback: boolean; steps: OpenSteps }): Promise<number> {
  let line: string;
  try {
    const { made, paths } = await o.steps.ensure({
      ...o.make,
      print: (text) => {
        o.steps.print(text);
        // Ledung itself already runs: stopping this wait leaves it running, and "ledung --browser" opens its page
        // (self-check finding 4). A stopped make leaves its folder, which the next make removes first.
        if (o.fallback) o.steps.print('Ledung is already running: to use the browser instead, press Ctrl+C and run "ledung --browser".');
      },
    });
    if (made !== 'nothing') {
      exercisedLine(`EXERCISED #407 desktop app ${made === 'all' ? 'made' : 'code rewritten'} in the data folder`);
      o.steps.print(made === 'all' ? `Made the desktop app: ${paths.bundle}` : 'Brought the desktop app up to date.');
    }
    const failed = await o.steps.open(paths);
    if (failed === null) return 0;
    line = failed;
  } catch (e) {
    line = `The desktop app could not be made: ${(e as Error).message.split('\n')[0]}`;
  }
  if (!o.fallback) {
    o.steps.print(line);
    return 1;
  }
  o.steps.print(`${line.replace(/[.\s]*$/, '.')} Opening Ledung in the browser instead.`);
  o.steps.browser();
  return 0;
}
