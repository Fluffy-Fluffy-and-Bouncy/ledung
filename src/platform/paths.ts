// Where Ledung keeps its data on each platform. Everything that needs a data path asks here.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'Ledung';

/** A LEDUNG_<name> setting from the environment. */
export function envSetting(name: string): string | undefined {
  return process.env[`LEDUNG_${name}`];
}

function platformDataDir(): string {
  return process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME)
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', APP_NAME)
      : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), APP_NAME.toLowerCase());
}

/** The platform's usual place for application data. LEDUNG_DATA_DIR overrides it (used by tests). */
export function userDataDir(): string {
  const override = envSetting('DATA_DIR');
  const dir = override ? path.resolve(override) : platformDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The relay's encryption keys and certificate (docs/steps/relay-e2e.md 3a): tls.key and tls.crt, later the ACME
 * account. In the data folder so they survive releases and never sit in the config, a release or the repository;
 * private to this user (0700 on macOS and Linux; on Windows the profile's own permissions, as for auth-token).
 */
export function remoteDir(): string {
  const dir = path.join(userDataDir(), 'remote');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// This file is src/platform/paths.ts in a clone or a release, and part of dist/main.js or
// dist/host.js in the npm package, where the code is bundled into plain JavaScript (#105: Node does
// not strip types under node_modules).
const here = fileURLToPath(import.meta.url);

/** True when Ledung runs from the npm package (bundled JavaScript), not from TypeScript source. */
export const PACKAGED = !here.endsWith('.ts');

/** The folder Ledung runs from: the nearest one above this file holding package.json. */
export function appDir(): string {
  let dir = path.dirname(here);
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`No package.json above ${here}.`);
    dir = up;
  }
  return dir;
}

/** The script a session host runs: the bundled one in the npm package, the source otherwise. */
export function hostEntry(packaged = PACKAGED): string {
  return packaged ? path.join(appDir(), 'dist', 'host.js') : path.join(appDir(), 'src', 'host', 'host.ts');
}

/** The version in the package.json Ledung runs from. */
export function appVersion(): string {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(appDir(), 'package.json'), 'utf8')).version;
    return typeof v === 'string' ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}
