#!/usr/bin/env node
// The `ledung` command of the npm package (#105): starts Ledung and starts it again when it exits
// with RESTART_CODE (the page's Restart button). It does for the package what the launcher
// scripts/release.ts writes does for a release; the package has one folder, so there is no
// current.json to read, and a restart after `npm install -g ledung` runs the newly installed files.
//
//   ledung [--no-open]    ledung --version
//   ledung --open-only    opens a running Ledung's page; exits 3 when none runs (the macOS app, issue #415)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configPath } from './config.ts';
import { appVersion, PACKAGED } from './platform/paths.ts';
import { coreArgs } from './platform/node-warnings.ts';
import { NOT_RUNNING_CODE, openIfRunning } from './platform/running.ts';

/** Must match main.ts. */
const RESTART_CODE = 75;

const passthrough = process.argv.slice(2).filter((a) => a !== '--open-only');
if (passthrough.includes('--version') || passthrough.includes('-v')) {
  console.log(appVersion());
  process.exit(0);
}

// Already running (issue #415): open its page rather than start a second Ledung on the busy port.
if (await openIfRunning({ configFile: configPath(), open: !passthrough.includes('--no-open') })) process.exit(0);
if (process.argv.includes('--open-only')) process.exit(NOT_RUNNING_CODE);

// main.js next to this file in the package; main.ts when run from the source (node src/cli.ts).
const entry = fileURLToPath(new URL(PACKAGED ? './main.js' : './main.ts', import.meta.url));

// Ctrl+C reaches Ledung too; it stops its sessions and exits, and then this exits with it.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(signal, () => {});

let restarted = false;
for (;;) {
  // With a preload that keeps Node's SQLite warning off the console (#428).
  const args = coreArgs(entry, passthrough, restarted);
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      // LEDUNG_LAUNCHER tells Ledung that exiting with RESTART_CODE will start it again.
      env: { ...process.env, LEDUNG_LAUNCHER: '1' },
    });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', (e) => { console.error(e.message); resolve(1); });
  });
  if (code !== RESTART_CODE) process.exit(code);
  restarted = true;
  console.log('Restarting Ledung...');
}
