// The desktop app's attach check (issue #358, desktop/attach.ts): it finds the running Ledung the way the `ledung`
// command does, and its mirror of the `/running` proof stays the core's. Its start (issue #362, desktop/start.ts): what
// it runs, with which environment, and the one line a failed start gives. Its zoom keys (issue #389, desktop/keys.ts).
// The Mac Dock icon's margin (issue #404, desktop/dock-icon.ts). Its windows and its menu (issue #414,
// desktop/windows.ts and desktop/menu.ts).
// None of these files has Electron in it, so these run with the root tests; the window itself is checked by the probe
// and by hand (desktop/README.md).
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
import { DOCK_ICON_BODY, dockIconLayout, padBitmap } from '../desktop/dock-icon.ts';
import { FindSession, findLabel, MAX_FIND_TEXT } from '../desktop/find.ts';
import { findKey, zoomed, zoomKey, ZOOM_STEP, type FindKeyInput, type KeyInput } from '../desktop/keys.ts';
import { FIND_ACCELERATOR, menuTemplate, NEW_WINDOW_ACCELERATOR, type MenuEntry } from '../desktop/menu.ts';
import { findOnPath, runStart, START_SCRIPT_ENV, startCommand, startEnv } from '../desktop/start.ts';
import { WindowList } from '../desktop/windows.ts';
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

// Zoom keys (issue #389). Martin, 2026-11-19 01:10 on #384, on Windows with a Swedish keyboard: "ctrl + doesnt work. nor
// does ctrl + mousewheel". There "+" is a key of its own, which the DOM reports as key "+" with no Shift; on a US
// keyboard "+" is Shift and "=", key "+" with Shift or "=" without (the UI Events KeyboardEvent key values).

const key = (k: string, mods: Partial<Omit<KeyInput, 'key'>> = {}): KeyInput => ({ type: 'keyDown', key: k, control: true, alt: false, meta: false, ...mods });

test('Ctrl and "+" zooms in on Windows and Linux, whatever the layout; so does Ctrl and "=", as in a browser', () => {
  for (const platform of ['win32', 'linux'] as const) {
    assert.equal(zoomKey(key('+'), platform), 'in', `${platform}: the Swedish "+" key, or the number pad's`);
    assert.equal(zoomKey(key('='), platform), 'in', `${platform}: the US "=" key without Shift`);
  }
});

test('anything else is not a zoom key: no Ctrl, Ctrl+Alt (AltGr), the Windows key, a key let go, other keys, and the Mac', () => {
  assert.equal(zoomKey(key('+', { control: false }), 'win32'), null, 'a plain "+" types');
  assert.equal(zoomKey(key('+', { alt: true }), 'win32'), null, 'Ctrl+Alt is AltGr on Windows, which types');
  assert.equal(zoomKey(key('+', { meta: true }), 'win32'), null);
  assert.equal(zoomKey(key('+', { type: 'keyUp' }), 'win32'), null, 'once per press: the key going down');
  for (const other of ['-', '0', 'w', 'o', 'Add', 'Plus']) assert.equal(zoomKey(key(other), 'win32'), null, other);
  assert.equal(zoomKey(key('+'), 'darwin'), null, 'the Mac keeps its menu\'s keys (#389: "The Mac is unchanged")');
});

test("each zoom step is half a level, the View menu's own step, in and out", () => {
  assert.equal(ZOOM_STEP, 0.5);
  assert.equal(zoomed(0, 'in'), 0.5);
  assert.equal(zoomed(0.5, 'out'), 0);
  assert.equal(zoomed(-1, 'out'), -1.5);
});

// Apple's icon grid: the body is 824 of 1024 px, 100 px clear on each side (#404). At the page's 512 px that halves.
test("the Dock icon's body and margin follow Apple's grid: 824 of 1024 px, 412 of 512", () => {
  assert.equal(DOCK_ICON_BODY, 824 / 1024);
  assert.deepEqual(dockIconLayout(1024), { body: 824, margin: 100 });
  assert.deepEqual(dockIconLayout(512), { body: 412, margin: 50 });
});

test('padding centres the body on a clear canvas, every pixel kept as given', () => {
  // A 2 px body on a 4 px canvas: one clear pixel round it. Each body pixel has its own four bytes, so a pixel
  // landing in the wrong place, or bytes reordered, shows.
  const body = Uint8Array.from([1, 2, 3, 255, 5, 6, 7, 254, 9, 10, 11, 253, 13, 14, 15, 252]);
  const out = padBitmap(body, 2, 4);
  assert.equal(out.length, 4 * 4 * 4);
  const px = (x: number, y: number) => [...out.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
  assert.deepEqual(px(1, 1), [1, 2, 3, 255]);
  assert.deepEqual(px(2, 1), [5, 6, 7, 254]);
  assert.deepEqual(px(1, 2), [9, 10, 11, 253]);
  assert.deepEqual(px(2, 2), [13, 14, 15, 252]);
  // Everything else is clear: alpha 0, and every byte 0.
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      if (x >= 1 && x <= 2 && y >= 1 && y <= 2) continue;
      assert.deepEqual(px(x, y), [0, 0, 0, 0], `pixel ${x},${y} is in the margin`);
    }
  }
});

test('padding refuses a bitmap of the wrong size and a body larger than the canvas', () => {
  assert.throws(() => padBitmap(new Uint8Array(15), 2, 4), /not 15/);
  assert.throws(() => padBitmap(new Uint8Array(16), 2, 1), /does not fit/);
});

test('the window list: each window opened is the latest; focus makes one the latest; closing one leaves the others (#414)', () => {
  const list = new WindowList<string>();
  assert.equal(list.latest(), null, 'none open');
  list.add('a');
  list.add('b');
  list.add('c');
  assert.deepEqual(list.all(), ['a', 'b', 'c']);
  assert.equal(list.latest(), 'c', 'the window opened last');
  list.focused('a');
  assert.equal(list.latest(), 'a', 'a window focused comes last');
  assert.deepEqual(list.all(), ['b', 'c', 'a']);
  list.remove('a');
  assert.deepEqual(list.all(), ['b', 'c'], 'the others stay, in their order');
  assert.equal(list.latest(), 'c', 'the latest is the one used before the closed one');
  list.focused('a');
  assert.deepEqual(list.all(), ['b', 'c'], 'focus on a closed window adds nothing');
  list.add('c');
  assert.equal(list.size, 2, 'a window is in the list once');
});

test('closing hides only the last window; with more open, any closes for real (#414, #359)', () => {
  const list = new WindowList<string>();
  list.add('a');
  assert.equal(list.closeHides('a'), true, 'the one window hides, as before');
  list.add('b');
  assert.equal(list.closeHides('a'), false, 'one of two closes');
  assert.equal(list.closeHides('b'), false, 'either of two closes');
  assert.equal(list.closeHides('x'), true, 'a window not in the list never closes by this rule');
  list.remove('a');
  assert.equal(list.closeHides('b'), true, 'the one left hides again');
  list.remove('b');
  assert.equal(list.closeHides('b'), true, 'none left: hides');
});

/** Every item of a menu template's menus, with the top menu each sits in. */
function menuItems<W>(template: MenuEntry<W>[]): Array<MenuEntry<W> & { menu: string | undefined }> {
  return template.flatMap((top) => (top.submenu ?? []).map((item) => ({ ...item, menu: top.label })));
}

test('File → New Window is on ⌘N on the Mac and Ctrl+N on Windows and Linux, and opens a window (#414)', () => {
  // Electron's CmdOrCtrl is ⌘ on the Mac and Ctrl elsewhere.
  assert.equal(NEW_WINDOW_ACCELERATOR, 'CmdOrCtrl+N');
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    let opened = 0;
    const template = menuTemplate<string>(platform, { newWindow: () => opened++, closeWindow: () => {}, toolCalls: () => {}, find: () => {}, page: () => {}, quit: () => {} });
    const items = menuItems(template).filter((i) => i.id === 'new-window');
    assert.equal(items.length, 1, `${platform}: one New Window item`);
    const item = items[0]!;
    assert.equal(item.menu, 'File', `${platform}: in the File menu`);
    assert.equal(item.label, 'New Window', platform);
    assert.equal(item.accelerator, 'CmdOrCtrl+N', platform);
    assert.equal(template.find((t) => t.label === 'File')!.submenu![0]!.id, 'new-window', `${platform}: first in File, as in other apps`);
    item.click!(undefined, undefined);
    assert.equal(opened, 1, `${platform}: the item opens a window`);
  }
});

test("the menu's other keys stay: Close Window, Quit per system, ⌘O on the Mac only; Close and ⌘O act on the focused window", () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const closed: Array<string | undefined> = [];
    const toolCalls: Array<string | undefined> = [];
    let quits = 0;
    const template = menuTemplate<string>(platform, { newWindow: () => {}, closeWindow: (w) => closed.push(w), toolCalls: (w) => toolCalls.push(w), find: () => {}, page: () => {}, quit: () => quits++ });
    const byId = new Map(menuItems(template).filter((i) => i.id).map((i) => [i.id!, i]));
    assert.equal(byId.get('close-window')?.accelerator, 'CmdOrCtrl+W', platform);
    assert.equal(byId.get('quit')?.accelerator, platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4', platform);
    assert.equal(byId.get('quit')?.menu, platform === 'darwin' ? 'Ledung' : 'File', platform);
    assert.equal(byId.has('tool-calls'), platform === 'darwin', `${platform}: ⌘O only on the Mac`);
    byId.get('close-window')!.click!(undefined, 'focused');
    byId.get('tool-calls')?.click!(undefined, 'focused');
    byId.get('quit')!.click!(undefined, undefined);
    assert.deepEqual(closed, ['focused'], `${platform}: Close Window closes the focused window`);
    assert.deepEqual(toolCalls, platform === 'darwin' ? ['focused'] : [], platform);
    assert.equal(quits, 1, platform);
    assert.deepEqual(template.filter((t) => t.role).map((t) => t.role), ['editMenu', 'viewMenu'], `${platform}: Edit and View keep their standard items`);
  }
});

// The find bar (#445). Martin, 2026-11-19 22:52: "I want to be able to search the conversation/window with ctrl-f".
// Its Done: Ctrl+F / ⌘F opens it, also in the composer; Enter and Shift+Enter step, Esc closes; "n of m"; Edit → Find….

const findInput = (k: string, mods: Partial<Omit<FindKeyInput, 'key'>> = {}): FindKeyInput =>
  ({ type: 'keyDown', key: k, control: false, alt: false, meta: false, shift: false, ...mods });

test('Ctrl+F opens the find bar on Windows and Linux and ⌘F on the Mac, from the page (its text boxes too) and from the bar', () => {
  for (const platform of ['win32', 'linux'] as const) {
    for (const inBar of [false, true]) {
      assert.equal(findKey(findInput('f', { control: true, code: 'KeyF' }), inBar, platform), 'open', `${platform}, in the bar: ${inBar}`);
      assert.equal(findKey(findInput('F', { control: true, code: 'KeyF' }), inBar, platform), 'open', `${platform}: with Caps Lock on`);
    }
    assert.equal(findKey(findInput('f', { meta: true }), false, platform), null, `${platform}: the Windows key and F is not the app's`);
  }
  assert.equal(findKey(findInput('f', { meta: true, code: 'KeyF' }), false, 'darwin'), 'open', '⌘F on the Mac');
  assert.equal(findKey(findInput('f', { meta: true, code: 'KeyF' }), true, 'darwin'), 'open', '⌘F in the bar selects its text again');
  // Ctrl+F in a Mac text box moves the cursor one character on (the system's Emacs keys): it stays the text box's.
  assert.equal(findKey(findInput('f', { control: true }), false, 'darwin'), null, 'Ctrl+F on the Mac stays the text box\'s');
});

test('the F of Ctrl+F is the key that types "f", or the physical F key on a layout with no Latin letter there', () => {
  assert.equal(findKey(findInput('а', { control: true, code: 'KeyF' }), false, 'win32'), 'open', 'Russian: the F key types "а"');
  assert.equal(findKey(findInput('φ', { control: true, code: 'KeyF' }), false, 'win32'), 'open', 'Greek: the F key types "φ"');
  assert.equal(findKey(findInput('u', { control: true, code: 'KeyF' }), false, 'win32'), null, 'Dvorak: the physical F key types "u"');
  assert.equal(findKey(findInput('f', { control: true, code: 'KeyY' }), false, 'win32'), 'open', 'Dvorak: "f" is on the physical Y key');
});

test('not the find key: Ctrl+Shift+F, Ctrl+Alt+F (AltGr), a key let go, a plain F, other letters', () => {
  assert.equal(findKey(findInput('F', { control: true, shift: true, code: 'KeyF' }), false, 'win32'), null, 'Ctrl+Shift+F');
  assert.equal(findKey(findInput('f', { control: true, alt: true, code: 'KeyF' }), false, 'win32'), null, 'Ctrl+Alt is AltGr, which types');
  assert.equal(findKey(findInput('f', { control: true, type: 'keyUp', code: 'KeyF' }), false, 'win32'), null, 'once per press: the key going down');
  assert.equal(findKey(findInput('f', { code: 'KeyF' }), false, 'win32'), null, 'a plain f types');
  assert.equal(findKey(findInput('f', { code: 'KeyF' }), true, 'win32'), null, 'a plain f types in the bar too');
  for (const other of ['g', 'o', 'n', 'w', '+']) assert.equal(findKey(findInput(other, { control: true }), false, 'win32'), null, other);
});

test("in the bar Enter steps to the next match, Shift+Enter to the previous, Esc closes; in the page they stay the page's", () => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    assert.equal(findKey(findInput('Enter'), true, platform), 'next', platform);
    assert.equal(findKey(findInput('Enter', { shift: true }), true, platform), 'previous', platform);
    assert.equal(findKey(findInput('Escape'), true, platform), 'close', platform);
    // The same presses with the page in focus: the composer's Enter sends, the page's Esc closes its own dialogs.
    assert.equal(findKey(findInput('Enter'), false, platform), null, `${platform}: Enter in the page`);
    assert.equal(findKey(findInput('Enter', { shift: true }), false, platform), null, `${platform}: Shift+Enter in the page`);
    assert.equal(findKey(findInput('Escape'), false, platform), null, `${platform}: Esc in the page`);
  }
  assert.equal(findKey(findInput('Enter', { isComposing: true }), true, 'win32'), null, "an input method's Enter is its own");
  assert.equal(findKey(findInput('Escape', { isComposing: true }), true, 'win32'), null, "an input method's Esc is its own");
  assert.equal(findKey(findInput('Enter', { control: true }), true, 'win32'), null, 'Ctrl+Enter is not a step');
  assert.equal(findKey(findInput('Enter', { type: 'keyUp' }), true, 'win32'), null, 'once per press');
  for (const other of ['a', 'Backspace', 'ArrowDown', 'Tab']) assert.equal(findKey(findInput(other), true, 'win32'), null, `${other} types in the bar`);
});

test('the search: typing starts a new one, Enter and Shift+Enter step through it, an empty box clears the highlights', () => {
  const search = new FindSession();
  assert.equal(search.step(true), null, 'nothing to step through before anything is typed');
  assert.equal(search.reopen(), null, 'an empty bar opens with no search');
  assert.deepEqual(search.query('ledung'), { text: 'ledung', forward: true, findNext: true }, "Electron's findNext true starts a new search");
  assert.deepEqual(search.step(true), { text: 'ledung', forward: true, findNext: false }, 'Enter: the next match of the same search');
  assert.deepEqual(search.step(false), { text: 'ledung', forward: false, findNext: false }, 'Shift+Enter: the previous one');
  assert.equal(search.query(''), 'stop', 'the box emptied: stop, which clears the highlights');
  assert.equal(search.step(true), null, 'nothing to step through with an empty box');
  search.query('x'.repeat(MAX_FIND_TEXT + 50));
  assert.equal(search.text.length, MAX_FIND_TEXT, 'a pasted wall of text is cut');
});

test('the bar shows "n of m" for its own search\'s answers, "No matches" once none are found, and keeps its text when closed', () => {
  assert.equal(findLabel({ activeMatchOrdinal: 2, matches: 5, finalUpdate: true }), '2 of 5');
  assert.equal(findLabel({ activeMatchOrdinal: 0, matches: 0, finalUpdate: true }), 'No matches');
  assert.equal(findLabel({ activeMatchOrdinal: 0, matches: 0, finalUpdate: false }), null, 'not done yet: no "No matches" while typing');
  assert.equal(findLabel({ activeMatchOrdinal: 0, matches: 5, finalUpdate: false }), null, 'a count with no active match yet');

  const search = new FindSession();
  search.query('session');
  search.sent(7);
  assert.equal(search.answer({ requestId: 7, activeMatchOrdinal: 1, matches: 3, finalUpdate: true }), '1 of 3', 'its own answer');
  assert.equal(search.answer({ requestId: 6, activeMatchOrdinal: 4, matches: 9, finalUpdate: true }), null, "an older search's late answer");
  search.step(true);
  search.sent(8);
  assert.equal(search.answer({ requestId: 8, activeMatchOrdinal: 2, matches: 3, finalUpdate: true }), '2 of 3', 'a step answers with the next match');
  search.closed();
  assert.equal(search.answer({ requestId: 8, activeMatchOrdinal: 3, matches: 3, finalUpdate: true }), null, 'closed: answers are dropped');
  assert.equal(search.text, 'session', 'the text stays for the next open');
  assert.deepEqual(search.reopen(), { text: 'session', forward: true, findNext: true }, 'opened again: the kept text searched anew');
});

test('Edit → Find… is on ⌘F on the Mac and Ctrl+F elsewhere, opens the focused window\'s bar, and Edit keeps its standard items', () => {
  assert.equal(FIND_ACCELERATOR, 'CmdOrCtrl+F');
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const found: Array<string | undefined> = [];
    const template = menuTemplate<string>(platform, { newWindow: () => {}, closeWindow: () => {}, toolCalls: () => {}, find: (w) => found.push(w), page: () => {}, quit: () => {} });
    const edit = template.find((t) => t.role === 'editMenu');
    const items = edit?.submenu ?? [];
    const find = items.find((i) => i.id === 'find');
    assert.ok(find, `${platform}: Find… is in the Edit menu`);
    assert.equal(find.label, 'Find…', platform);
    assert.equal(find.accelerator, 'CmdOrCtrl+F', platform);
    assert.equal(items.at(-1), find, `${platform}: last in Edit`);
    assert.equal(menuItems(template).filter((i) => i.id === 'find').length, 1, `${platform}: in no other menu`);
    find.click!(undefined, 'focused');
    assert.deepEqual(found, ['focused'], `${platform}: opens the focused window's bar`);
    const roles = items.map((i) => i.role).filter(Boolean);
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll']) assert.ok(roles.includes(role as never), `${platform}: Edit keeps ${role}`);
    assert.equal(roles.includes('pasteAndMatchStyle'), platform === 'darwin', `${platform}: Paste and Match Style on the Mac only, as Electron's own Edit menu`);
  }
});

test("View's items keep their names and keys and act on the window's page, never on the find bar in focus (#445)", () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    const pressed: Array<[string | undefined, string]> = [];
    const template = menuTemplate<string>(platform, { newWindow: () => {}, closeWindow: () => {}, toolCalls: () => {}, find: () => {}, page: (w, command) => pressed.push([w, command]), quit: () => {} });
    const view = template.find((t) => t.role === 'viewMenu');
    const items = (view?.submenu ?? []).filter((i) => i.id);
    // Electron's own View menu: the same items and keys (its viewMenu role).
    assert.deepEqual(items.map((i) => [i.id, i.label, i.accelerator]), [
      ['reload', 'Reload', 'CmdOrCtrl+R'], ['forceReload', 'Force Reload', 'Shift+CmdOrCtrl+R'],
      ['devTools', 'Toggle Developer Tools', platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I'],
      ['resetZoom', 'Actual Size', 'CmdOrCtrl+0'], ['zoomIn', 'Zoom In', 'CmdOrCtrl+Plus'], ['zoomOut', 'Zoom Out', 'CmdOrCtrl+-'],
    ], platform);
    assert.ok(items.every((i) => i.role === undefined), `${platform}: none is a standard role, which would act on the focused contents`);
    assert.equal(view?.submenu?.at(-1)?.role, 'togglefullscreen', `${platform}: Full Screen stays the window's`);
    for (const item of items) item.click!(undefined, 'focused');
    assert.deepEqual(pressed, items.map((i) => ['focused', i.id]), `${platform}: each acts on the focused window's page`);
  }
});
