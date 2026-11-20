// The made app's own settings (#407): the npm package's `ledung` command makes a "Ledung" app from Electron's binary in
// the data folder (src/platform/desktop-app.ts) and writes this file next to the app's main.js. It says which Node and
// which `ledung` command made it, so Start Ledung runs them and needs no `ledung` on PATH (an app opened from Finder or
// the Start menu has no terminal's PATH), and which LEDUNG_* settings that command had, so the app finds the same
// Ledung however it is opened. A clone run (`npm start` here) has no such file and works as before. No Electron in this
// file, so the root tests run it (test/desktop.test.ts).
import fs from 'node:fs';
import path from 'node:path';

/** The file's name, in the made app's code folder next to main.js. */
export const MADE_CONFIG = 'ledung-app.json';

/** The made app's id: the Mac's bundle id and the Windows AppUserModelID (not org.ledung.launcher, the shortcut's). */
export const APP_ID = 'org.ledung.app';

/**
 * Windows (#587): the core starts the app it has just made once with `--ledung-write-shortcut=<file>`; the app writes
 * its Start-menu shortcut there, carrying APP_ID so notifications say "Ledung", and quits. Electron's own shortcut
 * writer is the one that can set the id.
 */
export const WRITE_SHORTCUT_ARG = '--ledung-write-shortcut';

/**
 * Updating Ledung (#408): the app restarts its window to take the new version's code by running the `ledung` that made
 * it with `--after-app=<its pid>`, then quitting. That command waits for it to end, writes the new code into it (or
 * makes it again for a new Electron) and opens it, as `ledung` does.
 */
export const AFTER_APP_ARG = '--after-app';

/**
 * Left in the data folder's desktop/ by an app that restarts while no window is visible (#408): the new one starts
 * hidden too. A restart that ends in the browser removes it.
 */
export const START_HIDDEN_FILE = '.start-hidden';

/**
 * The app's process id from `--after-app=<pid>` in a command line, and the arguments without it; null when it is not
 * there or not a process id.
 */
export function afterApp(args: string[]): { pid: number | null; rest: string[] } {
  const given = args.find((a) => a.startsWith(`${AFTER_APP_ARG}=`));
  const rest = args.filter((a) => a !== given);
  const pid = given === undefined ? NaN : Number(given.slice(AFTER_APP_ARG.length + 1));
  return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, rest };
}

/** The LEDUNG_* settings the made app takes over from the command that made it: they pick which Ledung it shows. */
export const PASSED_SETTINGS = ['LEDUNG_CONFIG', 'LEDUNG_DATA_DIR'] as const;

export interface MadeConfig {
  /** The Node that ran `ledung` when the app was made. */
  node: string;
  /** The `ledung` command's script (the package's dist/cli.js). */
  cli: string;
  /** LEDUNG_CONFIG and LEDUNG_DATA_DIR when the command had them; empty for a Ledung on the usual folders. */
  env: Partial<Record<(typeof PASSED_SETTINGS)[number], string>>;
}

/** The made app's settings in `dir`, or null for a clone run or a file that can't be read as one. */
export function readMadeConfig(dir: string): MadeConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, MADE_CONFIG), 'utf8')) as Record<string, unknown>;
    if (typeof raw.node !== 'string' || typeof raw.cli !== 'string') return null;
    const env: MadeConfig['env'] = {};
    const given = (raw.env ?? {}) as Record<string, unknown>;
    for (const name of PASSED_SETTINGS) if (typeof given[name] === 'string' && given[name] !== '') env[name] = given[name];
    return { node: raw.node, cli: raw.cli, env };
  } catch {
    return null;
  }
}

/** The settings to write for the command running now: its Node, its script and its LEDUNG_CONFIG and LEDUNG_DATA_DIR. */
export function madeConfigFor(node: string, cli: string, env: NodeJS.ProcessEnv): MadeConfig {
  const passed: MadeConfig['env'] = {};
  for (const name of PASSED_SETTINGS) {
    const value = env[name];
    if (value) passed[name] = path.resolve(value);
  }
  return { node, cli, env: passed };
}

/**
 * Started from a shortcut, a taskbar or Dock pin, Launchpad or Finder (#455), an app runs the code it was last written
 * with, and only `ledung` and the tray's Open rewrite that after an npm update. So the app compares its own version
 * with the installed package's at start and, when they differ, restarts as an update does (#408) before any window
 * shows. With this the `ledung` that made it opens only the app: the core is left as it is, running or not.
 */
export const APP_ONLY_ARG = '--app-only';

/**
 * Left in the data folder's desktop/ by an app that restarted at start to take the installed version (#455), holding
 * that version. If the restart could not bring it (a failed download, a package mid-update), the app that opens
 * after it runs its own code instead of restarting again, so a failure never becomes a loop; ten minutes later a start
 * tries again.
 */
export const START_UPDATE_FILE = '.start-update';
export const START_UPDATE_RETRY_MS = 10 * 60_000;

/**
 * The version of the Ledung installed where `cli` is: the package.json nearest above it, the one that command's own
 * version comes from (src/platform/paths.ts appDir). Null when it can't be read: the package is gone or being replaced.
 */
export function installedVersion(cli: string): string | null {
  let dir = path.dirname(cli);
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      try {
        const version = (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown }).version;
        return typeof version === 'string' && version !== '' ? version : null;
      } catch {
        return null;
      }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The start restart last tried (START_UPDATE_FILE): the version it was for and when; null when there is none. */
export function readStartUpdate(file: string): { version: string; at: number } | null {
  try {
    const version = fs.readFileSync(file, 'utf8').trim();
    return version === '' ? null : { version, at: fs.statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Whether an app starting with its own version `own` restarts first to take the installed one (#455): only when the
 * installed version can be read and differs (a downgrade too: the app runs what is installed), and not when a restart
 * for that same version was tried in the last ten minutes and still left the app on `own`.
 */
export function updateAtStart(o: { own: string; installed: string | null; tried: { version: string; at: number } | null; now: number }): boolean {
  if (o.installed === null || o.installed === o.own) return false;
  return !(o.tried !== null && o.tried.version === o.installed && o.now - o.tried.at < START_UPDATE_RETRY_MS);
}

/**
 * Whether restarting for an update (#408) can bring anything: the `ledung` that made the app has another version than
 * the app's own. Not when they are the same, as when the running Ledung is another install of another version (two
 * Node versions, each with its own global `ledung`): the restart would write the same code again and the app, told
 * once more it is out of date, would restart over and over (PR #425, review Minor 2).
 */
export function restartBrings(own: string, installed: string | null): boolean {
  return installed !== null && installed !== own;
}
