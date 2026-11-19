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
