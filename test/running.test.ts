// The launchers' open-or-start check (issue #415): a Ledung that already runs on this data folder gets its page
// opened instead of a second Ledung, which would touch its database and session hosts before failing on the busy
// port (issue #418). The release launcher and the npm command run for real here, against a stand-in Ledung: a
// server that answers /running the way Ledung does, with HMAC-SHA256 of the nonce keyed by its own token. The token
// itself must never reach the port (review of PR #432, Important 1).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DEFAULT_PORT } from '../src/config.ts';
import { appDir } from '../src/platform/paths.ts';
import { answersSignIn, configuredPort, NOT_RUNNING_CODE, openIfRunning, savedToken } from '../src/platform/running.ts';
import { LAUNCHER } from '../src/update/launcher.ts';
import { removeTemp } from './temp.ts';
import { freePort } from './free-port.ts';

const TOKEN = 'c'.repeat(64);
let base: string;
let stand: http.Server;
let port: number;
let hits = 0;
/** Every request the stand-in got, so a test can show the token never went out. */
const seen: string[] = [];

before(async () => {
  fs.mkdirSync(path.join(appDir(), '.test'), { recursive: true });
  base = fs.mkdtempSync(path.join(appDir(), '.test', 'running-'));
  port = await freePort();
  stand = http.createServer((req, res) => {
    hits++;
    seen.push(req.url!);
    const url = new URL(req.url!, 'http://x');
    const nonce = url.searchParams.get('nonce');
    if (url.pathname !== '/running' || !nonce) return void res.writeHead(404).end();
    const proof = crypto.createHmac('sha256', TOKEN).update(`ledung-running:${nonce}`).digest('hex');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ proof }));
  });
  await new Promise<void>((resolve) => stand.listen(port, '127.0.0.1', resolve));
});

after(async () => {
  await new Promise((resolve) => stand.close(resolve));
  removeTemp(base);
});

/** A data folder with a sign-in token and a config naming the port. */
function dataFolder(name: string, opts: { token?: string | null; port?: number }): { data: string; config: string } {
  const data = path.join(base, name);
  fs.mkdirSync(data, { recursive: true });
  if (opts.token) fs.writeFileSync(path.join(data, 'auth-token'), opts.token);
  const config = path.join(data, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ port: opts.port ?? port }));
  return { data, config };
}

test('the port is the config\'s, the default when it names none, and unknown when it is unreadable', () => {
  const dir = path.join(base, 'ports');
  fs.mkdirSync(dir);
  const file = (name: string, text: string) => {
    fs.writeFileSync(path.join(dir, name), text);
    return path.join(dir, name);
  };
  assert.equal(configuredPort(file('a.json', '{"port": 4396}')), 4396);
  assert.equal(configuredPort(file('b.json', '{}')), DEFAULT_PORT);
  assert.equal(configuredPort(path.join(dir, 'missing.json')), DEFAULT_PORT);
  assert.equal(configuredPort(file('c.json', '{ not json')), null);
  assert.equal(configuredPort(file('d.json', '{"port": "4317"}')), null);
});

test('the token is read, never made', () => {
  const { data } = dataFolder('token-none', { token: null });
  assert.equal(savedToken(data), null);
  assert.equal(fs.existsSync(path.join(data, 'auth-token')), false);
  assert.equal(savedToken(dataFolder('token-bad', { token: 'short' }).data), null);
  assert.equal(savedToken(dataFolder('token-ok', { token: `${TOKEN}\n` }).data), TOKEN);
});

test('only a Ledung that takes this data folder\'s token counts as running', async () => {
  assert.equal(await answersSignIn(port, TOKEN), true);
  assert.equal(await answersSignIn(port, 'd'.repeat(64)), false, 'another data folder\'s Ledung');
  assert.equal(await answersSignIn(await freePort(), TOKEN), false, 'nothing on the port');
  assert.ok(seen.length > 0 && seen.every((u) => !u.includes(TOKEN) && !u.includes('d'.repeat(64))), seen.join('\n'));
});

test('another program on the port counts as not running and never gets the token', async () => {
  const got: string[] = [];
  // Answers everything with 200 and a page or a made-up proof, as a dev server or a squatter might.
  const squatter = http.createServer((req, res) => {
    got.push(`${req.url} ${JSON.stringify(req.headers)}`);
    if (req.url?.startsWith('/running')) res.writeHead(200).end(JSON.stringify({ proof: 'f'.repeat(64) }));
    else res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>');
  });
  const squat = await freePort();
  await new Promise<void>((resolve) => squatter.listen(squat, '127.0.0.1', resolve));
  try {
    const opened: string[] = [];
    const folder = dataFolder('squatted', { token: TOKEN, port: squat });
    assert.equal(await openIfRunning({ configFile: folder.config, dataDir: folder.data, open: true, openUrl: (u) => void opened.push(u) }), false);
    assert.deepEqual(opened, []);
    assert.ok(got.length > 0, 'the check reached the squatter');
    assert.ok(got.every((r) => !r.includes(TOKEN)), got.join('\n'));
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }
});

test('running: the page opens signed in; not running, or no token yet: nothing opens', async () => {
  const opened: string[] = [];
  const openUrl = (url: string) => void opened.push(url);
  const running = dataFolder('open-running', { token: TOKEN });
  assert.equal(await openIfRunning({ configFile: running.config, dataDir: running.data, open: true, openUrl }), true);
  assert.deepEqual(opened, [`http://127.0.0.1:${port}/login?token=${TOKEN}`]);
  assert.equal(await openIfRunning({ configFile: running.config, dataDir: running.data, open: false, openUrl }), true, '--no-open: running, nothing opened');
  assert.equal(opened.length, 1);
  const other = dataFolder('open-other', { token: 'e'.repeat(64) });
  assert.equal(await openIfRunning({ configFile: other.config, dataDir: other.data, open: true, openUrl }), false);
  const first = dataFolder('open-first', { token: null });
  assert.equal(await openIfRunning({ configFile: first.config, dataDir: first.data, open: true, openUrl }), false);
  assert.equal(opened.length, 1);
});

/**
 * Runs a launcher with the data folder and config set, as Ledung.cmd, the npm command or a shortcut would, and no
 * other LEDUNG_* setting: one the tests were started with (Update Ledung's are the running Ledung's real data folder
 * and config) would send the launcher to that Ledung's config (#435).
 */
function runLauncher(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; ms: number }> {
  const started = Date.now();
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LEDUNG_')));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: { ...own, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, ms: Date.now() - started });
    });
  });
}

/** The release launcher as a release writes it, in a data folder with current.json pointing at this source. */
function releaseLauncher(name: string, opts: { token?: string | null; port?: number }): { file: string; data: string; config: string } {
  const folder = dataFolder(name, opts);
  fs.writeFileSync(path.join(folder.data, 'launcher.mjs'), LAUNCHER);
  fs.writeFileSync(path.join(folder.data, 'current.json'), JSON.stringify({ dir: appDir(), config: folder.config }));
  return { file: path.join(folder.data, 'launcher.mjs'), ...folder };
}

test('the release launcher opens a running Ledung\'s page and starts nothing', async () => {
  const l = releaseLauncher('release-running', { token: TOKEN });
  const before = hits;
  const r = await runLauncher([l.file, '--no-open'], { LEDUNG_DATA_DIR: l.data });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`Ledung is already running at http://127\\.0\\.0\\.1:${port}`));
  assert.ok(hits > before, 'it asked the running Ledung');
  // A Ledung that started would have opened the database and a hosts folder in the data folder.
  assert.equal(fs.existsSync(path.join(l.data, 'ledung.db')), false, r.out);
  assert.equal(fs.existsSync(path.join(l.data, 'hosts')), false, r.out);
});

test('--open-only exits 3 when no Ledung runs, starting nothing (the macOS app then opens Terminal)', async () => {
  const l = releaseLauncher('release-none', { token: TOKEN, port: await freePort() });
  const r = await runLauncher([l.file, '--open-only'], { LEDUNG_DATA_DIR: l.data });
  assert.equal(r.code, NOT_RUNNING_CODE, r.out);
  assert.equal(fs.existsSync(path.join(l.data, 'ledung.db')), false, r.out);
});

test('the npm command opens a running Ledung\'s page and starts nothing; --open-only exits 3 when none runs', async () => {
  const running = dataFolder('cli-running', { token: TOKEN });
  const cli = path.join(appDir(), 'src', 'cli.ts');
  const r = await runLauncher([cli, '--no-open'], { LEDUNG_DATA_DIR: running.data, LEDUNG_CONFIG: running.config });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Ledung is already running/);
  assert.equal(fs.existsSync(path.join(running.data, 'ledung.db')), false, r.out);
  const none = dataFolder('cli-none', { token: TOKEN, port: await freePort() });
  const n = await runLauncher([cli, '--open-only'], { LEDUNG_DATA_DIR: none.data, LEDUNG_CONFIG: none.config });
  assert.equal(n.code, NOT_RUNNING_CODE, n.out);
  assert.equal(fs.existsSync(path.join(none.data, 'ledung.db')), false, n.out);
});
