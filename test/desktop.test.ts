// The desktop app's attach check (issue #358, desktop/attach.ts): it finds the running Ledung the way the `ledung`
// command does, and its mirror of the `/running` proof stays the core's. Its start (issue #362, desktop/start.ts): what
// it runs, with which environment, and the one line a failed start gives. Neither file has Electron in it, so these
// run with the root tests; the window itself is checked by the probe and by hand (desktop/README.md).
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
import { findOnPath, runStart, START_SCRIPT_ENV, startCommand, startEnv } from '../desktop/start.ts';
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

// Start Ledung (issue #362). The real `ledung` command is never run here: a test start is a script of the test's own.

test('Start runs the installed `ledung --no-open`; the test setting runs a script with Node instead', () => {
  assert.deepEqual(startCommand({}), { command: 'ledung', args: ['--no-open'] });
  const file = path.join(base, 'wt', 'src', 'cli.ts');
  assert.deepEqual(startCommand({ [START_SCRIPT_ENV]: file }), { command: 'node', args: [file, '--no-open'] });
  assert.deepEqual(startCommand({ [START_SCRIPT_ENV]: 'wt/src/cli.ts' }).args, [path.resolve('wt/src/cli.ts'), '--no-open'], 'a relative path is made absolute');
});

test("the start's environment has no ELECTRON_*, no npm_* and none of npm's additions; the rest stays", () => {
  const npmBins = ['/c/desktop/node_modules/.bin', '/c/node_modules/.bin', '/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin'];
  const env = startEnv({
    ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', npm_lifecycle_event: 'start', npm_config_user_agent: 'npm/11',
    NPM_CONFIG_PREFIX: '/p', INIT_CWD: '/c/desktop', NODE: '/usr/bin/node', COLOR: '0', [START_SCRIPT_ENV]: '/wt/src/cli.ts',
    HOME: '/home/me', LEDUNG_CONFIG: '/t/config.json', LEDUNG_DATA_DIR: '/t/data', EDITOR: 'nano', NODE_OPTIONS: '--x',
    PATH: [...npmBins, '/opt/homebrew/bin', '/usr/bin', '/my/node_modules/.binaries'].join(':'),
  }, 'darwin');
  assert.deepEqual(env, {
    HOME: '/home/me', LEDUNG_CONFIG: '/t/config.json', LEDUNG_DATA_DIR: '/t/data', EDITOR: 'nano', NODE_OPTIONS: '--x',
    PATH: '/opt/homebrew/bin:/usr/bin:/my/node_modules/.binaries',
  });

  const win = startEnv({ Path: 'C:\\c\\desktop\\node_modules\\.bin;C:\\Program Files\\nodejs;', Electron_Run_As_Node: '1', SystemRoot: 'C:\\Windows' }, 'win32');
  assert.deepEqual(win, { Path: 'C:\\Program Files\\nodejs', SystemRoot: 'C:\\Windows' }, 'Windows: Path by any spelling, split on ;');
});

/** A script the test start runs: writes its arguments and environment next to itself, then does what `body` says. */
function startScript(name: string, body: string): string {
  const file = path.join(base, 'start', `${name}.mjs`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(`${file}.out`)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n${body}\n`);
  return file;
}

test('a start that returns 0 is ok, and the command got the clean environment and --no-open', async () => {
  const file = startScript('ok', 'process.exit(0);');
  const env = startEnv({ ...process.env, ELECTRON_RUN_AS_NODE: '1', npm_lifecycle_event: 'start', LEDUNG_CONFIG: '/t/config.json', [START_SCRIPT_ENV]: file });
  assert.deepEqual(await runStart(startCommand({ [START_SCRIPT_ENV]: file }), env), { ok: true });
  const got = JSON.parse(fs.readFileSync(`${file}.out`, 'utf8')) as { argv: string[]; env: Record<string, string> };
  assert.deepEqual(got.argv, ['--no-open']);
  assert.deepEqual(Object.keys(got.env).filter((n) => /^(ELECTRON_|npm_)/i.test(n)), [], 'no ELECTRON_* and no npm_* in the started process');
  assert.equal(got.env.LEDUNG_CONFIG, '/t/config.json', 'the started process does see the variables that were passed on');
});

test('a start that fails gives one line: the exit code and the last thing the command said', async () => {
  const file = startScript('fails', "console.log('Starting...'); console.error('Ledung stopped while starting (exit code 1).\\nError: listen EADDRINUSE 127.0.0.1:4397\\n    at Server.setupListenHandle (node:net:1940:16)\\n\\nNode.js v24.11.0'); process.exit(2);");
  const result = await runStart(startCommand({ [START_SCRIPT_ENV]: file }), startEnv());
  assert.deepEqual(result, { ok: false, line: '"node fails.mjs --no-open" exited with code 2: Error: listen EADDRINUSE 127.0.0.1:4397' });
});

test('a start command that is not installed gives one line saying so, and nothing throws', async () => {
  const result = await runStart({ command: 'ledung-desktop-test-no-such-command', args: ['--no-open'] }, startEnv());
  assert.equal(result.ok, false);
  assert.match((result as { line: string }).line, /^Could not start Ledung: the "ledung-desktop-test-no-such-command" command was not found\./);
});

test('the command is looked up on PATH as a shell would: a runnable file, by PATHEXT on Windows; none gives null', () => {
  const bin = path.join(base, 'path bin');
  const other = path.join(base, 'other');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ledung'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(other, 'ledung'), 'not runnable', { mode: 0o644 });
  fs.writeFileSync(path.join(bin, 'ledung.cmd'), '@echo off\r\n');
  if (process.platform !== 'win32') {
    assert.equal(findOnPath('ledung', { PATH: [other, bin].join(':') }, 'darwin'), path.join(bin, 'ledung'), 'the runnable one, past one that is not');
    assert.equal(findOnPath('ledung', { PATH: other }, 'darwin'), null, 'a file that is not runnable is not the command');
  }
  assert.equal(findOnPath('ledung', { Path: [other, bin].join(';'), PathExt: '.COM;.EXE;.CMD' }, 'win32'), path.join(bin, 'ledung.cmd'), 'Windows: ledung.cmd by PATHEXT, a bare file skipped');
  assert.equal(findOnPath('ledung', { Path: `"${bin}"`, PATHEXT: '.CMD' }, 'win32'), path.join(bin, 'ledung.cmd'), 'Windows: a quoted Path entry');
  assert.equal(findOnPath('ledung', { PATH: '' }, process.platform), null, 'an empty PATH finds nothing');
  assert.equal(findOnPath('ledung-desktop-test-no-such-command', startEnv(), process.platform), null);
});

/**
 * A start script that leaves a process behind holding the start's output pipes, as the background Ledung does on
 * Windows through ledung.cmd and cmd (#385), then does what `body` says. The process left behind writes its pid to
 * `<file>.pid` and lives 30 s unless the test stops it.
 */
function leavesHolder(name: string, body: string): { file: string; pidFile: string } {
  const pidFile = path.join(base, 'start', `${name}.pid`);
  const holder = `setTimeout(() => {}, 30000);`;
  const file = startScript(name, `import { spawn } from 'node:child_process';\nconst held = spawn(process.execPath, ['-e', ${JSON.stringify(holder)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });\nheld.unref();\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(held.pid));\n${body}`);
  return { file, pidFile };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopHolder(pidFile: string): void {
  try {
    process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
  } catch {
    // Already gone.
  }
}

test('a start that returns 0 while a process it left still holds its output is ok at once, not at the time limit (#385)', async () => {
  const { file, pidFile } = leavesHolder('holds-ok', "console.log('Ledung is running.'); process.exit(0);");
  try {
    const began = Date.now();
    const result = await runStart(startCommand({ [START_SCRIPT_ENV]: file }), startEnv(), 10_000);
    const took = Date.now() - began;
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(alive(pid), 'the process left behind, which holds the output pipes, still runs: their close has not come');
    assert.deepEqual(result, { ok: true });
    assert.ok(took < 5_000, `finished on the exit, not at the 10 s limit (took ${took} ms)`);
  } finally {
    stopHolder(pidFile);
  }
});

test('a start that fails while a process it left still holds its output still gives its error line (#385)', async () => {
  const { file, pidFile } = leavesHolder('holds-fails', "console.error('Error: listen EADDRINUSE 127.0.0.1:4397'); process.exit(2);");
  try {
    const result = await runStart(startCommand({ [START_SCRIPT_ENV]: file }), startEnv(), 10_000);
    assert.ok(alive(Number(fs.readFileSync(pidFile, 'utf8'))), 'the process left behind still runs');
    assert.deepEqual(result, { ok: false, line: '"node holds-fails.mjs --no-open" exited with code 2: Error: listen EADDRINUSE 127.0.0.1:4397' });
  } finally {
    stopHolder(pidFile);
  }
});

test('a start that does not return in time is given up on, with one line', async () => {
  const file = startScript('hangs', 'setTimeout(() => {}, 1000);');
  const result = await runStart(startCommand({ [START_SCRIPT_ENV]: file }), startEnv(), 300);
  assert.deepEqual(result, { ok: false, line: '"node hangs.mjs --no-open" did not finish within 0.3 s.' });
});
