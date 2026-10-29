// The release launcher, launcher.mjs in the user data folder: scripts/release.ts writes it on each release. Kept here,
// apart from the release script, so a test can run it (issue #415).
// The launcher runs Ledung as a child process and starts it again, from whichever release
// current.json then points to, when Ledung exits with RESTART_CODE (the page's Restart button).
// It is replaced in one step on each release; Node reads it once at start, so a running launcher
// is not affected.
// A Ledung that already runs gets its page opened instead (issue #415); the check is the release's own
// src/platform/running.ts, and a release without one just starts. --open-only exits 3 when none runs (the macOS app).
export const LAUNCHER = `// Starts the release that current.json points to, and restarts it on request. Written by scripts/release.ts.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RESTART_CODE = 75;
const here = path.dirname(fileURLToPath(import.meta.url));
const passthrough = process.argv.slice(2).filter((a) => a !== '--open-only');
const readCurrent = () => JSON.parse(fs.readFileSync(path.join(here, 'current.json'), 'utf8'));

// Already running: open its page rather than start a second Ledung on the busy port.
{
  const current = readCurrent();
  let check = null;
  try {
    check = await import(pathToFileURL(path.join(current.dir, 'src', 'platform', 'running.ts')).href);
  } catch {
    // A release from before the check.
  }
  const configFile = process.env.LEDUNG_CONFIG ?? current.config;
  if (check && (await check.openIfRunning({ configFile, open: !passthrough.includes('--no-open') }))) process.exit(0);
  if (process.argv.includes('--open-only')) process.exit(check ? check.NOT_RUNNING_CODE : 3);
}

// Ctrl+C reaches Ledung too; it stops its sessions and exits, and then the launcher exits with it.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => {});

let restarted = false;
for (;;) {
  const current = readCurrent();
  const args = [path.join(current.dir, 'src', 'main.ts'), ...passthrough];
  if (restarted && !args.includes('--no-open')) args.push('--no-open');
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      // LEDUNG_LAUNCHER tells Ledung that exiting with RESTART_CODE will start it again.
      env: { ...process.env, LEDUNG_CONFIG: process.env.LEDUNG_CONFIG ?? current.config, LEDUNG_LAUNCHER: '1' },
    });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', (e) => { console.error(e.message); resolve(1); });
  });
  if (code !== RESTART_CODE) process.exit(code);
  restarted = true;
  console.log('Restarting Ledung...');
}
`;
