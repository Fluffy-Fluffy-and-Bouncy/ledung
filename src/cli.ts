#!/usr/bin/env node
// The `ledung` command of the npm package (#105): starts Ledung and starts it again when it exits
// with RESTART_CODE (the page's Restart button). It does for the package what the launcher
// scripts/release.ts writes does for a release; the package has one folder, so there is no
// current.json to read, and a restart after `npm install -g ledung` runs the newly installed files.
// Since #456 it runs Ledung in the background and returns, so no terminal has to stay open (Martin, 2026-11-01
// 21:41, Ledung question #1149); --foreground keeps it in this terminal, for development and debugging.
//
//   ledung [--no-open]                 starts Ledung in the background, its output in ledung.log in the data folder;
//                                      without --no-open it then opens the desktop app (#407), making it first, or the
//                                      browser when the app is not installed or can't be made
//   ledung --browser                   the same, but opens the page in the browser
//   ledung app                         the same, but always the app: says why when it can't, and opens no browser
//   ledung --foreground [--no-open]    runs it in this terminal; Ctrl+C or closing the terminal stops it
//   ledung stop                        stops the running Ledung and its sessions; exits 3 when none runs
//   ledung account token <name>        puts a long-lived token into an account's Claude Code sign-in (#85)
//   ledung --version
//   ledung --open-only                 opens a running Ledung's page; exits 3 when none runs (the macOS app, issue #415)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configPath } from './config.ts';
import { appVersion, PACKAGED, userDataDir } from './platform/paths.ts';
import { coreArgs } from './platform/node-warnings.ts';
import { configuredPort, NOT_RUNNING_CODE, openIfRunning, savedToken } from './platform/running.ts';
import { startInBackground, stopRunning } from './platform/background.ts';
import { accountCommand } from './accounts/token-command.ts';
import { madeConfigFor } from '../desktop/made.ts';
import { desktopAppOff, desktopAvailability, ensureApp, openApp, openDesktop, progressPrinter } from './platform/desktop-app.ts';
import { openBrowser } from './platform/open-browser.ts';

/** Must match main.ts. */
const RESTART_CODE = 75;

const OWN = ['--open-only', '--foreground', '--browser'];
let passthrough = process.argv.slice(2).filter((a) => !OWN.includes(a));
if (passthrough.includes('--version') || passthrough.includes('-v')) {
  console.log(appVersion());
  process.exit(0);
}
if (passthrough[0] === 'stop') process.exit(await stopRunning({ configFile: configPath() }));
if (passthrough[0] === 'account') process.exit(await accountCommand(passthrough.slice(1)));

// The desktop app (#407, Martin 2026-11-19, Ledung question #577): `ledung` opens it by default and the browser when
// it is not installed or can't be made; --browser keeps to the browser. `ledung app` insists on the
// app. Not for --no-open (the app's own Start Ledung, the sign-in start), --open-only (the shortcuts, unchanged) or
// --foreground (development, where the core opens the browser itself).
const appCommand = passthrough[0] === 'app';
if (appCommand) passthrough = passthrough.slice(1);
const noOpen = passthrough.includes('--no-open');
// "desktopApp": false in the config keeps plain `ledung` on the browser for good (Ledung question #584).
const tryApp = appCommand || !(noOpen || desktopAppOff(configPath()) || ['--browser', '--open-only', '--foreground'].some((a) => process.argv.includes(a)));
const desktop = tryApp ? desktopAvailability() : null;
if (appCommand && desktop && !desktop.ok) {
  console.error(`ledung app: ${desktop.reason}`);
  process.exit(1);
}

/** Opens the desktop app, making it first; on failure the browser (or, for `ledung app`, only the reason). */
async function openTheApp(): Promise<number> {
  if (!desktop?.ok) return 0;
  const cli = fileURLToPath(import.meta.url);
  return openDesktop({
    make: {
      dataDir: userDataDir(),
      electron: desktop.electron,
      source: desktop.source,
      ledungVersion: appVersion(),
      config: madeConfigFor(process.execPath, cli, process.env),
      progress: progressPrinter((text) => process.stdout.write(text), process.stdout.isTTY === true),
    },
    fallback: !appCommand,
    steps: {
      ensure: ensureApp,
      open: (paths) => openApp(paths),
      browser: () => {
        const port = configuredPort(configPath());
        const token = savedToken();
        if (port !== null && token !== null) openBrowser(`http://127.0.0.1:${port}/login?token=${token}`);
      },
      print: (line) => console.log(line),
    },
  });
}

// Already running (issue #415): open it (the app, or its page) rather than start a second Ledung on the busy port.
if (await openIfRunning({ configFile: configPath(), open: !noOpen && !desktop?.ok })) process.exit(desktop?.ok ? await openTheApp() : 0);
if (process.argv.includes('--open-only')) process.exit(NOT_RUNNING_CODE);

// The background start runs this same command with --foreground, detached and with its output in the log (#456). With
// the app, the started Ledung opens no browser: the app opens once it answers.
if (!process.argv.includes('--foreground')) {
  const args = [fileURLToPath(import.meta.url), '--foreground', ...passthrough, ...(desktop?.ok && !noOpen ? ['--no-open'] : [])];
  const code = await startInBackground({ args, configFile: configPath() });
  process.exit(code === 0 && desktop?.ok ? await openTheApp() : code);
}

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
      // In the background this command has no console, and Windows would give Ledung a window of its own (#456).
      windowsHide: true,
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
