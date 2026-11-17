// Finding this computer's running Ledung, the way the `ledung` command does (src/platform/running.ts, issue #415):
// the config gives the port, the data folder gives the sign-in token, and the `/running` proof says the program on
// the port is the Ledung that holds that token. The token is never sent: another program on the port, or a Ledung
// with another data folder, counts as not running and learns nothing.
//
// A mirror, not an import: src/platform/running.ts pulls in the core's config and its dependencies, which the root
// `npm install` brings, and desktop/ installs only its own (issue #358, open point 2). test/desktop.test.ts checks
// this proof against the core's, so the two can't drift apart. No Electron here, so the root tests can run it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/** The core's default port (src/config.ts DEFAULT_PORT). */
export const DEFAULT_PORT = 4317;

/** The data folder, as src/platform/paths.ts userDataDir() finds it; only read here, never made. */
export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.LEDUNG_DATA_DIR) return path.resolve(env.LEDUNG_DATA_DIR);
  const home = os.homedir();
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Ledung');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Ledung');
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'ledung');
}

/**
 * The config files a running Ledung may have read, in the order they are tried. LEDUNG_CONFIG when set, alone, as the
 * core does. Otherwise the npm package's config in the data folder (src/config.ts configPath), then the one the
 * release launcher points at (current.json, scripts/release.ts), since this app runs from a clone and can't tell
 * which of the two started the Ledung that runs.
 */
export function configFiles(env: NodeJS.ProcessEnv = process.env, dir = dataDir(env)): string[] {
  if (env.LEDUNG_CONFIG) return [path.resolve(env.LEDUNG_CONFIG)];
  const files = [path.join(dir, 'ledung.config.json')];
  try {
    const pointed = (JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')) as { config?: unknown }).config;
    if (typeof pointed === 'string' && !files.includes(path.resolve(pointed))) files.push(path.resolve(pointed));
  } catch {
    // No release launcher on this computer.
  }
  return files;
}

/** The port a config names, the default when it names none, null when it can't be read (as configuredPort). */
export function configuredPort(file: string): number | null {
  try {
    if (!fs.existsSync(file)) return DEFAULT_PORT;
    const port = (JSON.parse(fs.readFileSync(file, 'utf8')) as { port?: unknown }).port;
    return port === undefined ? DEFAULT_PORT : typeof port === 'number' && Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

/** The ports to try: each config's, once each, in order. */
export function candidatePorts(files: string[]): number[] {
  const ports: number[] = [];
  for (const file of files) {
    const port = configuredPort(file);
    if (port !== null && !ports.includes(port)) ports.push(port);
  }
  return ports;
}

/** The data folder's sign-in token, if it has one (as savedToken). */
export function savedToken(dir: string): string | null {
  try {
    const token = fs.readFileSync(path.join(dir, 'auth-token'), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** What a Ledung with this token answers on `/running` for a nonce (as runningProof). */
export function runningProof(token: string, nonce: string): string {
  return crypto.createHmac('sha256', token).update(`ledung-running:${nonce}`).digest('hex');
}

/** Whether the Ledung holding this token answers on the port, without sending the token (as answersSignIn). */
export function answersSignIn(port: number, token: string, timeoutMs = 5000): Promise<boolean> {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expected = Buffer.from(runningProof(token, nonce));
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/running?nonce=${nonce}`, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 1024) req.destroy();
      });
      res.on('end', () => {
        let proof: unknown = null;
        try {
          proof = (JSON.parse(body) as { proof?: unknown }).proof;
        } catch {
          // Not Ledung's answer: not running.
        }
        const given = Buffer.from(typeof proof === 'string' ? proof : '');
        resolve(res.statusCode === 200 && given.length === expected.length && crypto.timingSafeEqual(given, expected));
      });
      res.on('close', () => resolve(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

export type Found = { running: true; port: number; token: string } | { running: false; ports: number[]; reason: string };

/** This computer's running Ledung: its port and token, or which ports were tried and why none counted. */
export async function findRunning(env: NodeJS.ProcessEnv = process.env, timeoutMs?: number): Promise<Found> {
  const dir = dataDir(env);
  const ports = candidatePorts(configFiles(env, dir));
  const token = savedToken(dir);
  if (token === null) return { running: false, ports, reason: `No sign-in token in ${dir}: Ledung has not run with this data folder.` };
  if (ports.length === 0) return { running: false, ports, reason: 'The config could not be read.' };
  for (const port of ports) {
    if (await answersSignIn(port, token, timeoutMs)) return { running: true, port, token };
  }
  return { running: false, ports, reason: `Nothing answered as this computer's Ledung on port ${ports.join(' or ')}.` };
}
