// What a stranger sees on the console of the npm package (#422, #428): no EXERCISED trace lines, and no Node SQLite
// ExperimentalWarning, while every other warning still shows and the traces still reach exercised.log.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleCore } from '../scripts/build-package.ts';
import { exercisedLine, EXERCISED_FILE } from '../src/platform/exercised.ts';
import { coreArgs } from '../src/platform/node-warnings.ts';
import { appDir } from '../src/platform/paths.ts';
import { freePort } from './free-port.ts';
import { removeTemp } from './temp.ts';

const SQLITE = 'SQLite is an experimental feature and might change at any time';

let base: string;
let dist: string;

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-console-'));
  // The package's layout: package.json above dist/, the dependencies where npm would install them.
  const pkg = path.join(base, 'pkg');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ledung', version: '9.8.7', type: 'module' }));
  fs.symlinkSync(path.join(appDir(), 'node_modules'), path.join(pkg, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  dist = path.join(pkg, 'dist');
  await bundleCore(appDir(), dist);
});

after(() => removeTemp(base));

/** The environment of a child: no inherited LEDUNG_* settings, its own data folder. */
function childEnv(data: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('LEDUNG_')) env[k] = v;
  env.LEDUNG_DATA_DIR = data;
  return env;
}

/** Every .ts file under dir. */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? sources(full) : e.name.endsWith('.ts') ? [full] : [];
  });
}

test('every EXERCISED line in the core goes through the trace, never straight to the console', () => {
  const stray: string[] = [];
  for (const file of sources(path.join(appDir(), 'src'))) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // A string that starts a trace line: 'EXERCISED #N …' (the process's own form, which its grep finds).
      if (/['"`]EXERCISED #\d+/.test(line) && !/\bexercisedLine\(\s*['"`]EXERCISED #\d+/.test(line)) {
        stray.push(`${path.relative(appDir(), file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(stray, []);
});

test('a trace line goes to its file, and to the console only when asked', () => {
  const file = path.join(base, 'trace', EXERCISED_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const printed: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { printed.push(a.join(' ')); };
  try {
    exercisedLine('EXERCISED #1 quiet', { console: false, file: () => file });
    exercisedLine('EXERCISED #2 loud', { console: true, file: () => file });
    // A folder that can't be written loses the line and doesn't throw.
    exercisedLine('EXERCISED #3 lost', { console: false, file: () => path.join(base, 'no-such-folder', EXERCISED_FILE) });
  } finally {
    console.log = log;
  }
  assert.deepEqual(printed, ['EXERCISED #2 loud']);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^\d{4}-\d\d-\d\dT\S+ EXERCISED #1 quiet$/);
  assert.match(lines[1]!, /^\d{4}-\d\d-\d\dT\S+ EXERCISED #2 loud$/);
});

test("the package's start of the core drops the SQLite warning and no other", () => {
  // A stand-in core next to the package's preload, started with the arguments the ledung command uses. It emits the
  // warning as node:sqlite does on Node 24.14 (24.21 no longer emits it, so it can't be left to the real module).
  const script = path.join(dist, 'warns.mjs');
  fs.writeFileSync(script, [
    `process.emitWarning(${JSON.stringify(SQLITE)}, 'ExperimentalWarning');`,
    `const e = new Error(${JSON.stringify(SQLITE)}); e.name = 'ExperimentalWarning'; process.emitWarning(e);`,
    "process.emitWarning('Some other feature is experimental', 'ExperimentalWarning');",
    "process.emitWarning('An old way', 'DeprecationWarning', 'DEP0999');",
    "process.emitWarning('Plain warning');",
  ].join('\n'));
  const data = path.join(base, 'warns-data');
  const r = spawnSync(process.execPath, coreArgs(script, [], false, true), { encoding: 'utf8', env: childEnv(data), timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /SQLite/);
  assert.match(r.stderr, /ExperimentalWarning: Some other feature is experimental/);
  assert.match(r.stderr, /DeprecationWarning: An old way/);
  assert.match(r.stderr, /Warning: Plain warning/);
  // Packaged: the trace of the drop is in the data folder, not on the console.
  assert.doesNotMatch(r.stdout, /EXERCISED/);
  assert.match(fs.readFileSync(path.join(data, EXERCISED_FILE), 'utf8'), /EXERCISED #428 /);
});

test('a start of the packaged core prints no EXERCISED lines', async () => {
  // Started as the ledung command starts it. No EXERCISED line logs at every start since #388's was removed; that
  // the lines reach exercised.log is the trace-file test's and the #428 test's.
  const data = path.join(base, 'core-data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'ledung.config.json'), JSON.stringify({ port: await freePort() }));
  const core = spawn(process.execPath, coreArgs(path.join(dist, 'main.js'), ['--no-open'], false, true), {
    env: childEnv(data), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => core.on('exit', () => resolve()));
  let out = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`not running within 30 s:\n${out}`)), 30_000);
      const look = (d: Buffer) => {
        out += d;
        if (/Ledung is running at/.test(out)) { clearTimeout(timer); resolve(); }
      };
      core.stdout.on('data', look);
      core.stderr.on('data', look);
      core.on('exit', (code) => { clearTimeout(timer); reject(new Error(`main.js exited (${code}) before running:\n${out}`)); });
    });
  } finally {
    // Stopped by its own pid; it started no sessions, so no hosts are left behind.
    if (core.exitCode === null) core.kill();
    await exited;
  }
  assert.doesNotMatch(out, /EXERCISED/);
  assert.doesNotMatch(out, /SQLite/);
});
