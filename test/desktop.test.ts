// The desktop app's attach check (issue #358, desktop/attach.ts): it finds the running Ledung the way the `ledung`
// command does, and its mirror of the `/running` proof stays the core's. desktop/attach.ts has no Electron in it, so
// these run with the root tests; the window itself is checked by hand (desktop/README.md).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  candidatePorts, configFiles, configuredPort as appConfiguredPort, dataDir, DEFAULT_PORT as APP_DEFAULT_PORT, findRunning,
  runningProof as appProof, savedToken as appSavedToken,
} from '../desktop/attach.ts';
import { DEFAULT_PORT } from '../src/config.ts';
import { configuredPort, runningProof, savedToken as coreSavedToken } from '../src/platform/running.ts';
import { listenOk } from './free-port.ts';
import { removeTemp } from './temp.ts';

let base: string;
before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-desktop-'));
});
after(() => removeTemp(base));

/** A data folder with a token, and a config naming the port. */
function install(name: string, port: number): { env: NodeJS.ProcessEnv; token: string } {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dir, 'data', 'auth-token'), token);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port }));
  return { env: { LEDUNG_CONFIG: path.join(dir, 'config.json'), LEDUNG_DATA_DIR: path.join(dir, 'data') }, token };
}

/** A server on a free port that answers `/running` as `answer` says; the core's own proof is the real Ledung's. */
async function listener(answer: (nonce: string) => { status: number; body: string }) {
  const server = http.createServer((req, res) => {
    const nonce = new URL(req.url ?? '/', 'http://x').searchParams.get('nonce') ?? '';
    const { status, body } = answer(nonce);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  const port = await listenOk(server);
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("the app's proof is the core's, for any token and nonce", () => {
  for (let i = 0; i < 20; i++) {
    const token = crypto.randomBytes(32).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');
    assert.equal(appProof(token, nonce), runningProof(token, nonce));
  }
  assert.equal(APP_DEFAULT_PORT, DEFAULT_PORT);
});

test("the app reads a config's port and a data folder's token as the core does", () => {
  const dir = path.join(base, 'same');
  fs.mkdirSync(dir, { recursive: true });
  const configs: Record<string, string | null> = { none: null, empty: '{}', port: '{"port":4398}', text: '{"port":"4398"}', broken: '{ not json', float: '{"port":43.5}' };
  for (const [name, body] of Object.entries(configs)) {
    const file = path.join(dir, `${name}.json`);
    if (body !== null) fs.writeFileSync(file, body);
    assert.equal(appConfiguredPort(file), configuredPort(file), name);
  }
  assert.equal(appConfiguredPort(path.join(dir, 'port.json')), 4398, 'a port is read at all');
  const tokens: Record<string, string | null> = { missing: null, good: `${'a1'.repeat(32)}\n`, short: 'abc', upper: 'A1'.repeat(32) };
  for (const [name, body] of Object.entries(tokens)) {
    const data = path.join(dir, `data-${name}`);
    fs.mkdirSync(data, { recursive: true });
    if (body !== null) fs.writeFileSync(path.join(data, 'auth-token'), body);
    assert.equal(appSavedToken(data), coreSavedToken(data), name);
  }
  assert.equal(appSavedToken(path.join(dir, 'data-good')), 'a1'.repeat(32), 'a token is read at all');
});

test('the Ledung holding the data folder\'s token is found on its port; another program there counts as not running', async () => {
  let token = '';
  let impostor = false;
  // The real Ledung's answer is the core's own proof; an impostor answers 200 with a proof made from another token.
  const server = await listener((nonce) => ({
    status: 200,
    body: JSON.stringify({ proof: runningProof(impostor ? 'f'.repeat(64) : token, nonce) }),
  }));
  try {
    const installed = install('found', server.port);
    token = installed.token;
    assert.deepEqual(await findRunning(installed.env, 2000), { running: true, port: server.port, token });

    impostor = true;
    const found = await findRunning(installed.env, 2000);
    assert.equal(found.running, false);
    assert.match(!found.running ? found.reason : '', new RegExp(`Nothing answered as this computer's Ledung on port ${server.port}`));
  } finally {
    await server.close();
  }
});

test('an old Ledung that serves its page on /running, or nothing on the port, counts as not running', async () => {
  const page = await listener(() => ({ status: 200, body: '<!doctype html><title>Project Ledung</title>' }));
  const installed = install('page', page.port);
  try {
    assert.equal((await findRunning(installed.env, 2000)).running, false);
  } finally {
    await page.close();
  }
  // The port is free now: nothing answers.
  const found = await findRunning(installed.env, 2000);
  assert.deepEqual(found.running ? null : found.ports, [page.port]);
});

test('a data folder with no token: not running, and the reason says so', async () => {
  const dir = path.join(base, 'fresh');
  fs.mkdirSync(dir, { recursive: true });
  const found = await findRunning({ LEDUNG_DATA_DIR: dir, LEDUNG_CONFIG: path.join(dir, 'none.json') }, 500);
  assert.equal(found.running, false);
  assert.match(!found.running ? found.reason : '', /No sign-in token/);
});

test("without LEDUNG_DATA_DIR the app's data folder is the core's, on this system (test review of PR #366, finding 3)", () => {
  // In a child with its home and the platform's data settings in a temp folder, so the core's userDataDir() makes its
  // folder there, never in the person's real data folder.
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_DATA_HOME: path.join(home, 'xdg') };
  delete env.LEDUNG_DATA_DIR;
  const url = (file: string) => JSON.stringify(pathToFileURL(path.join(import.meta.dirname, '..', file)).href);
  const script = `const { userDataDir } = await import(${url('src/platform/paths.ts')}); const { dataDir } = await import(${url('desktop/attach.ts')});
    console.log(JSON.stringify({ core: userDataDir(), app: dataDir() }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const { core, app } = JSON.parse(run.stdout) as { core: string; app: string };
  assert.ok(core.startsWith(home), `the core's folder is in the temp home: ${core}`);
  assert.equal(app, core);
});

test('LEDUNG_CONFIG and LEDUNG_DATA_DIR are read like the core reads them', () => {
  const dir = path.join(base, 'paths');
  assert.equal(dataDir({ LEDUNG_DATA_DIR: dir }), path.resolve(dir));
  assert.deepEqual(configFiles({ LEDUNG_CONFIG: 'some/config.json', LEDUNG_DATA_DIR: dir }), [path.resolve('some/config.json')]);
});

test("without LEDUNG_CONFIG: the npm package's config, then the release launcher's, each port once, the default for none", () => {
  const dir = path.join(base, 'both');
  fs.mkdirSync(dir, { recursive: true });
  assert.deepEqual(configFiles({}, dir), [path.join(dir, 'ledung.config.json')]);
  assert.deepEqual(candidatePorts(configFiles({}, dir)), [DEFAULT_PORT], 'no config file: the default port');

  const releaseConfig = path.join(base, 'clone', 'ledung.config.local.json');
  fs.mkdirSync(path.dirname(releaseConfig), { recursive: true });
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ dir: '/x', config: releaseConfig }));
  fs.writeFileSync(path.join(dir, 'ledung.config.json'), JSON.stringify({ port: 4400 }));
  fs.writeFileSync(releaseConfig, JSON.stringify({ port: 4401 }));
  assert.deepEqual(configFiles({}, dir), [path.join(dir, 'ledung.config.json'), releaseConfig]);
  assert.deepEqual(candidatePorts(configFiles({}, dir)), [4400, 4401]);

  fs.writeFileSync(releaseConfig, JSON.stringify({ port: 4400 }));
  assert.deepEqual(candidatePorts(configFiles({}, dir)), [4400]);
  fs.writeFileSync(releaseConfig, '{ not json');
  assert.deepEqual(candidatePorts(configFiles({}, dir)), [4400], 'a config that cannot be read gives no port');
});
