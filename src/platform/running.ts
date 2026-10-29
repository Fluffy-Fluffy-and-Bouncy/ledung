// The launchers' open-or-start check (issue #415): a Ledung that already runs on this data folder gets its page
// opened, signed in, instead of a second Ledung that fails on the busy port. Run before anything is started: a
// second Ledung touches the running one's database and session hosts before it gets to the port (issue #418).
// Used by the npm `ledung` command (src/cli.ts), the release launcher (scripts/release.ts) and the shortcuts
// Settings makes (src/platform/shortcuts.ts).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DEFAULT_PORT } from '../config.ts';
import { openBrowser } from './open-browser.ts';
import { userDataDir } from './paths.ts';

/** Exit code of `--open-only` when no Ledung runs: the caller starts one (the macOS app's Terminal window). */
export const NOT_RUNNING_CODE = 3;

/** The port the config names, or the default; null when the config can't be read (the start then says why). */
export function configuredPort(configFile: string): number | null {
  try {
    if (!fs.existsSync(configFile)) return DEFAULT_PORT;
    const port = (JSON.parse(fs.readFileSync(configFile, 'utf8')) as { port?: unknown }).port;
    return port === undefined ? DEFAULT_PORT : typeof port === 'number' && Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

/** The sign-in token of this data folder's Ledung, if it has one; never makes one (that is Ledung's own start). */
export function savedToken(dataDir = userDataDir()): string | null {
  try {
    const token = fs.readFileSync(path.join(dataDir, 'auth-token'), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** The nonce `/running` takes: 32 hex characters, picked anew by each check. */
export const NONCE = /^[0-9a-f]{32}$/;

/** What a Ledung with this token answers on `/running` for a nonce: proof it holds the token, without sending it. */
export function runningProof(token: string, nonce: string): string {
  return crypto.createHmac('sha256', token).update(`ledung-running:${nonce}`).digest('hex');
}

/**
 * Whether this data folder's Ledung answers on the port. The token is never sent: the listener must answer a fresh
 * nonce with the proof only that token gives (review of PR #432, Important 1), so another program on the port, or a
 * Ledung with another data folder, counts as not running and learns nothing. 5 s, so a Ledung busy just after its
 * start is not taken for none (Minor 1); nothing on the port is refused at once.
 */
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
          // Not Ledung's answer (an older Ledung serves its page here): not running.
        }
        const given = Buffer.from(typeof proof === 'string' ? proof : '');
        resolve(res.statusCode === 200 && given.length === expected.length && crypto.timingSafeEqual(given, expected));
      });
      // Cut off (too long, or the timeout mid-answer): no end comes. After an end this changes nothing.
      res.on('close', () => resolve(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/**
 * If this data folder's Ledung already runs, opens its page signed in (unless `open` is false) and returns true;
 * otherwise false, and the caller starts Ledung.
 */
export async function openIfRunning(opts: { configFile: string; open: boolean; dataDir?: string; openUrl?: (url: string) => void }): Promise<boolean> {
  const port = configuredPort(opts.configFile);
  const token = savedToken(opts.dataDir);
  if (port === null || token === null || !(await answersSignIn(port, token))) return false;
  console.log(`Ledung is already running at http://127.0.0.1:${port}${opts.open ? '; opening its page.' : '.'}`);
  if (opts.open) (opts.openUrl ?? openBrowser)(`http://127.0.0.1:${port}/login?token=${token}`);
  return true;
}
