// Builds a copy of Ledung to run from, separate from the source a session may be editing (issue #16).
//
//   npm run release
//
// Each release goes into its own folder under <user data>/app/<timestamp>. A small pointer file,
// current.json, says which one to run; it is replaced in one step (write a new file, then rename
// it over the old one), never edited in place. The launcher reads the pointer when it starts, so a
// running Ledung keeps its own files and the next start picks up the new release.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appDir, userDataDir } from '../src/platform/paths.ts';
import { configPath } from '../src/config.ts';
import { commandLines } from '../src/platform/process-tree.ts';
import { releasesToRemove } from '../src/update/releases.ts';
import { LAUNCHER } from '../src/update/launcher.ts';

const KEEP = 3;
const source = appDir();
const dataDir = userDataDir();
const releases = path.join(dataDir, 'app');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const target = path.join(releases, stamp);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function step(label: string, fn: () => void): void {
  process.stdout.write(`${label}... `);
  fn();
  console.log('done');
}

// The steps run without this Ledung's LEDUNG_* settings: they only say where the release lands, which is read above.
// Settings → Update Ledung sets them to the running Ledung's real data folder and config, and the check runs the
// tests, which must never see those (issue #435).
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !k.startsWith('LEDUNG_')) env[k] = v;
}

// Run npm through node directly (npm sets npm_execpath under `npm run`), so no shell is involved.
// Output is kept quiet unless a step fails; then it is shown, so the failing test or error is named (#251).
const sh = (cmd: string, args: string[], cwd: string) => {
  try {
    return cmd === npm && process.env.npm_execpath
      ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 })
      : execFileSync(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
  } catch (e) {
    console.log('failed');
    const { stdout, status, message } = e as { stdout?: Buffer; status?: number | null; message: string };
    console.log(stdout?.length ? failureOutput(String(stdout)) : message);
    // Exit rather than throw: the error would print the whole output again, as a Buffer.
    process.exit(status || 1);
  }
};

/** What to show of a failed step's output: the test runner's list of failing tests if there is one, else its last lines. */
function failureOutput(out: string): string {
  const lines = out.split(/\r?\n/);
  const failing = lines.findIndex((l) => /failing tests:/.test(l));
  return (failing >= 0 ? lines.slice(failing) : lines.slice(-80)).join('\n').trimEnd();
}

// The commit this release is built from, so Settings' Update Ledung can tell what is new (#100).
// Null when the source is not a git clone; a clone with uncommitted changes still names its HEAD.
let commit: string | null = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
} catch {
  // Not a git clone.
}

step('Checking types and running tests', () => sh(npm, ['run', 'check', '--silent'], source));
step('Building the page', () => sh(npm, ['run', 'build', '--silent'], source));

step(`Copying to ${target}`, () => {
  fs.mkdirSync(target, { recursive: true });
  for (const item of ['src', 'package.json', 'package-lock.json']) {
    fs.cpSync(path.join(source, item), path.join(target, item), { recursive: true });
  }
  fs.cpSync(path.join(source, 'web', 'dist'), path.join(target, 'web', 'dist'), { recursive: true });
  // The release's own record of where it came from; the running Ledung reads it even after
  // current.json has moved on to a newer release.
  fs.writeFileSync(path.join(target, 'release.json'), JSON.stringify({ source, commit, releasedAt: new Date().toISOString() }, null, 2));
});

step('Installing runtime dependencies', () => sh(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--silent'], target));

step('Pointing the launcher at the new release', () => {
  const pointer = path.join(dataDir, 'current.json');
  const tmp = `${pointer}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ dir: target, config: configPath(), source, commit, releasedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, pointer);

  // Replace the launcher in one step when it changed (write a new file, rename it over the old one).
  const launcher = path.join(dataDir, 'launcher.mjs');
  if (!fs.existsSync(launcher) || fs.readFileSync(launcher, 'utf8') !== LAUNCHER) {
    const launcherTmp = `${launcher}.${process.pid}.tmp`;
    fs.writeFileSync(launcherTmp, LAUNCHER);
    fs.renameSync(launcherTmp, launcher);
  }
  // Ledung.cmd and ledung.sh are one line each and never change: cmd.exe re-reads a running batch file.
  if (process.platform === 'win32') {
    const cmd = path.join(dataDir, 'Ledung.cmd');
    if (!fs.existsSync(cmd)) fs.writeFileSync(cmd, '@node "%~dp0launcher.mjs" %*\r\n');
  } else {
    const shFile = path.join(dataDir, 'ledung.sh');
    if (!fs.existsSync(shFile)) fs.writeFileSync(shFile, '#!/bin/sh\nexec node "$(dirname "$0")/launcher.mjs" "$@"\n', { mode: 0o755 });
  }
});

// A folder a running Ledung or session host runs from stays until a later release finds it unused
// (#117). Without the list of command lines nothing can be told apart, so nothing is removed.
let running: string[] | null = null;
try {
  running = await commandLines();
} catch {
  // ps or PowerShell unavailable.
}
step(`Removing old releases (keeping ${KEEP} and any in use)`, () => {
  if (!running) {
    process.stdout.write('could not list running processes, kept them all... ');
    return;
  }
  const names = fs.readdirSync(releases);
  const remove = releasesToRemove(names, [releases, fs.realpathSync(releases)], running, KEEP);
  const kept = names.sort().reverse().slice(KEEP).filter((name) => !remove.includes(name));
  if (kept.length) process.stdout.write(`kept ${kept.join(', ')} (in use)... `);
  for (const dir of remove) {
    try {
      fs.rmSync(path.join(releases, dir), { recursive: true, force: true });
    } catch {
      // A file Windows still holds open; removed next time.
    }
  }
});

const start = process.platform === 'win32' ? path.join(dataDir, 'Ledung.cmd') : path.join(dataDir, 'ledung.sh');
console.log(`\nRelease ${stamp} is ready. Start Ledung with:\n  ${start}\nA Ledung that is already running keeps its current release until it is restarted.`);
