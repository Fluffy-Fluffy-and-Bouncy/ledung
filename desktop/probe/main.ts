// The desktop app's loopback check (issue #358): loads the real ../main.ts in Electron, against a throwaway Ledung
// named by LEDUNG_CONFIG and LEDUNG_DATA_DIR, checks the window from inside and quits. Prints `PROBE {json}` lines;
// every observation the PR relies on is checked here, and a check that fails prints `"event":"fail"` and makes the
// exit code 1 (test review of PR #366, finding 1). 0 means every check held; 2 means it refused to run.
// Never point it at a real Ledung: the "notrunning" and "stopped" phases start and stop the Ledung of that config.
// Opening the default browser is intercepted and recorded, so nothing opens on the screen.
//
//   PROBE_PHASE=attach      a Ledung runs: signed in, address, settings, permissions, refused navigation and
//                           windows, links, Ledung's icon and the hidden menu bar (#384); saves the device list
//                           for "again"
//   PROBE_PHASE=again       a second start: still signed in, the same devices as after "attach"
//   PROBE_PHASE=notrunning  none runs: the "not running" page; the probe starts one, presses Retry, page loads
//   PROBE_PHASE=stopped     the probe starts one, the app attaches, the probe stops it and reloads: the "not
//                           running" page again; it starts it again, presses Retry, page loads
//   PROBE_PHASE=window      a Ledung runs: closing hides, the Dock and a second start show the window again, ⌘O is
//                           the page's Ctrl+O, timers keep their pace while hidden, Quit ends the app and not
//                           Ledung (#359). PROBE_HIDDEN_SECONDS sets how long the timers run hidden (60)
//   (PROBE_PHASE=child is the second start "window" launches itself)
//   PROBE_PHASE=start      none runs: presses Start Ledung (#362), which runs LEDUNG_DESKTOP_START's script (the
//                           worktree's src/cli.ts) as the app's start; the page loads signed in within 15 s, and
//                           neither the started Ledung nor its launcher has an ELECTRON_* or npm_* variable. Leaves
//                           that Ledung running, so the shell can check it still answers after the app quit. Run it
//                           with an ELECTRON_* variable of your own set (ELECTRON_PROBE=1) and through npx, which
//                           adds npm_*: the probe checks the app has both, so their absence in Ledung means something
//   PROBE_PHASE=startfail   none runs, LEDUNG_DESKTOP_START names a script that isn't there: Start fails, the page
//                           says so in one line and offers Start and Retry, no error dialog, and the menu's Quit ends
//                           the app
//
// Run from desktop/: `LEDUNG_CONFIG=… LEDUNG_DATA_DIR=… PROBE_PHASE=attach npx electron probe`. macOS and Linux
// only for now: it reads command lines with `ps` (code review of PR #366, Minor 3).
import { app, BrowserWindow, dialog, Menu, nativeImage, shell, type MenuItem, type NativeImage } from 'electron';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isToolCallsKey } from '../../web/src/sessionMenu.ts';
import { answersSignIn, candidatePorts, configFiles, dataDir, DEFAULT_PORT } from '../attach.ts';
import { START_SCRIPT_ENV } from '../start.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const clone = path.resolve(here, '..', '..');
const phase = process.env.PROBE_PHASE ?? 'attach';
const port = candidatePorts(configFiles())[0];
// Only a throwaway Ledung: without both settings the app would find the real one (self-check round 2, finding 1).
// Checked before the app is loaded, since it attaches as soon as Electron is ready.
const refused = process.platform === 'win32'
  ? 'Windows has no ps to read command lines with; run this on macOS or Linux'
  : !process.env.LEDUNG_CONFIG || !process.env.LEDUNG_DATA_DIR
    ? 'LEDUNG_CONFIG and LEDUNG_DATA_DIR must both name a throwaway Ledung'
    : port === undefined || port === DEFAULT_PORT ? `the config's port is ${port ?? 'unreadable'}; use a test port, never the real Ledung's`
      // Start Ledung runs the real `ledung` command without the test setting; a session never may (CLAUDE.local.md).
      : (phase === 'start' || phase === 'startfail') && !process.env[START_SCRIPT_ENV] ? `${START_SCRIPT_ENV} must name the start script (the worktree's src/cli.ts)` : null;
const origin = `http://127.0.0.1:${port}`;
/** The device list "attach" saved, for "again" to compare with: in the throwaway's data folder. */
const devicesFile = path.join(dataDir(), 'desktop-probe-devices.json');
let failed = false;
const external: string[] = [];
(shell as { openExternal: (url: string) => Promise<void> }).openExternal = async (url: string) => {
  external.push(url);
};
/** Error dialogs the main process tried to show (Mac spike surprise 3: an uncaught error shows one nobody can close). */
const errorDialogs: string[] = [];
(dialog as { showErrorBox: (title: string, content: string) => void }).showErrorBox = (title: string, content: string) => {
  errorDialogs.push(`${title}: ${content}`);
};
/** What the app set as its Dock icon (Mac): recorded, then passed on (#384). */
const dockIcons: NativeImage[] = [];
if (app.dock) {
  const dock = app.dock;
  const setIcon = dock.setIcon.bind(dock);
  dock.setIcon = (image: NativeImage | string) => {
    dockIcons.push(typeof image === 'string' ? nativeImage.createFromPath(image) : image);
    setIcon(image);
  };
}
/** main.ts's icon path, read from the module once it is loaded. */
let appIcon = '';
const out = (event: string, data: unknown = {}) => console.log('PROBE ' + JSON.stringify({ phase, event, data }));
/** A check the PR relies on: a failing one is printed and makes the run exit 1. */
function expect(holds: boolean, what: string, seen?: unknown): void {
  if (holds) return;
  failed = true;
  out('fail', { what, seen });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const token = () => {
  try {
    return fs.readFileSync(path.join(dataDir(), 'auth-token'), 'utf8').trim();
  } catch {
    return null;
  }
};

/** The config's Ledung on plain Node from PATH, never Electron's binary and with no ELECTRON_* setting (#361). */
function startCore(): ChildProcess {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('ELECTRON_')) env[k] = v;
  const core = spawn('node', [path.join(clone, 'src', 'main.ts'), '--no-open'], { cwd: clone, env, stdio: 'ignore' });
  out('core-started', { pid: core.pid });
  return core;
}
async function stopCore(core: ChildProcess): Promise<void> {
  core.kill('SIGTERM');
  await new Promise((r) => (core.exitCode !== null ? r(null) : core.once('exit', r)));
  out('core-stopped', { pid: core.pid });
}
async function waitForCore(): Promise<void> {
  for (let i = 0; i < 60 && token() === null; i++) await sleep(500);
  await sleep(3000);
}

const win = () => BrowserWindow.getAllWindows()[0];
/** Waits for the window to show `prefix` and finish loading. */
async function showing(prefix: string): Promise<BrowserWindow> {
  for (let i = 0; i < 150; i++) {
    const w = win();
    const url = w?.webContents.getURL();
    if (w && url && !w.webContents.isLoading() && url.startsWith(prefix)) return w;
    await sleep(200);
  }
  throw new Error(`the window never showed ${prefix} (it shows ${win()?.webContents.getURL()})`);
}
const page = (w: BrowserWindow, js: string) => w.webContents.executeJavaScript(js);
const api = (w: BrowserWindow, route: string) =>
  page(w, `fetch('/api/${route}').then(async (r) => ({ status: r.status, body: r.status === 200 ? await r.json() : null }))`);

/** Signed in at Ledung's own address, locked down, no token anywhere; returns the device ids. */
async function signedIn(w: BrowserWindow): Promise<string[]> {
  await sleep(2500);
  const wc = w.webContents;
  // Not in Electron's types, but on every WebContents: the preferences the page really runs with.
  const prefs = (wc as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences();
  const state = await api(w, 'state');
  const devices = await api(w, 'devices');
  const ids = ((devices.body?.devices ?? []) as { id: string }[]).map((d) => d.id).sort();
  const cookies = await wc.session.cookies.get({ url: origin, name: 'ledung_auth' });
  const t = token();
  const commandLines = execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const history = wc.navigationHistory.getAllEntries().map((e) => e.url);
  const sidebar = await page(w, `!!document.querySelector('nav, aside, .sidebar')`);
  const report = {
    url: wc.getURL(), history: history.map((u) => u.replace(/\?.*/, '?…')), title: wc.getTitle(), windows: BrowserWindow.getAllWindows().length,
    apiState: state.status, devicesState: devices.status, sidebar, devices: ids.map((id) => id.slice(0, 8)),
    cookie: cookies.map((c) => ({ httpOnly: c.httpOnly, sameSite: c.sameSite, isToken: c.value === t })),
    prefs: { contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration },
    browserOpened: [...external],
  };
  out('signed-in', report);
  expect(wc.getURL() === `${origin}/`, 'the address is Ledung\'s own', wc.getURL());
  expect(report.windows === 1, 'one window', report.windows);
  expect(state.status === 200 && devices.status === 200, 'the page is signed in (its data requests answered)', [state.status, devices.status]);
  expect(sidebar === true, 'the sidebar shows');
  expect(ids.length > 0, 'Ledung lists the app as a device');
  expect(prefs.contextIsolation === true && prefs.sandbox === true && prefs.nodeIntegration === false, 'the page is sandboxed and isolated', report.prefs);
  expect(cookies.length === 1 && cookies[0]!.httpOnly === true && cookies[0]!.sameSite === 'strict', 'one httpOnly, SameSite strict sign-in cookie', report.cookie);
  // No token anywhere, and the probes could see one (test review of PR #366, finding 2): the token was read, and the
  // same command-line scan finds this app's own binary.
  expect(t !== null, 'the throwaway Ledung\'s token was read');
  expect(commandLines.includes(process.execPath), 'the command-line scan sees this app', process.execPath);
  expect(t !== null && history.length > 0 && !history.some((u) => u.includes(t)), 'no address the window visited holds the token');
  expect(t !== null && !commandLines.includes(t), 'no command line holds the token');
  return ids;
}

/**
 * Ledung's icon and the hidden menu bar (#384): the icon file loads as a 512 px image, the Mac's Dock was given it,
 * Windows and Linux hide the menu bar until Alt, and the menu still carries the items whose shortcuts must work.
 */
function looks(w: BrowserWindow): void {
  const icon = nativeImage.createFromPath(appIcon);
  const mac = process.platform === 'darwin';
  const menu = Menu.getApplicationMenu();
  const roles = (menu?.items ?? []).map((i) => i.role ?? i.label);
  const report = {
    icon: path.relative(clone, appIcon), iconSize: icon.getSize(), iconEmpty: icon.isEmpty(),
    dockIcons: dockIcons.map((d) => ({ size: d.getSize(), sameAsIcon: d.toPNG().equals(icon.toPNG()) })),
    menuBarAutoHide: w.isMenuBarAutoHide(), menuBarVisible: w.isMenuBarVisible(), menu: roles,
    closeWindow: menuItem('close-window')?.accelerator ?? null, toolCalls: menuItem('tool-calls')?.accelerator ?? null,
  };
  out('looks', report);
  expect(appIcon.endsWith(path.join('web', 'public', 'icon-512.png')), "the icon is the page's own icon-512.png", report.icon);
  expect(!icon.isEmpty() && icon.getSize().width === 512 && icon.getSize().height === 512, 'the icon loads as a 512 × 512 image', report);
  if (mac) {
    expect(report.dockIcons.length === 1 && report.dockIcons[0]!.sameAsIcon, "the Dock was given Ledung's icon, once", report.dockIcons);
  } else {
    expect(report.menuBarAutoHide && !report.menuBarVisible, 'the menu bar is hidden until Alt', report);
  }
  expect(report.closeWindow === 'CmdOrCtrl+W', 'Close Window keeps Ctrl+W / ⌘W', report.closeWindow);
  expect(['editmenu', 'viewmenu'].every((r) => roles.includes(r as never)), 'the Edit and View menus are still there (copy, paste, zoom)', roles);
  // Show Tool Calls is in the Mac's File menu only: Windows and Linux press the page's Ctrl+O directly (#359).
  if (mac) expect(report.toolCalls === 'Cmd+O', 'Show Tool Calls keeps ⌘O', report.toolCalls);
}

/** Notifications and clipboard writes allowed for Ledung's page, anything else refused (code review, Minor 2). */
async function permissions(w: BrowserWindow): Promise<void> {
  const seen = await page(w, `(async () => ({
    notification: await Notification.requestPermission(),
    clipboard: (await navigator.permissions.query({ name: 'clipboard-write' })).state,
    location: (await navigator.permissions.query({ name: 'geolocation' })).state,
    camera: (await navigator.permissions.query({ name: 'camera' })).state,
  }))()`);
  out('permissions', seen);
  expect(seen.notification === 'granted', 'notifications are allowed', seen.notification);
  expect(seen.clipboard === 'granted', 'clipboard writes are allowed', seen.clipboard);
  expect(seen.location === 'denied' && seen.camera === 'denied', 'location and camera are refused', [seen.location, seen.camera]);
}

async function notRunningPage(): Promise<BrowserWindow> {
  const w = await showing('file:');
  const text = (await page(w, `document.body.innerText`)).replace(/\s+/g, ' ');
  const links = await page(w, `[...document.querySelectorAll('a.button')].filter((a) => a.offsetParent !== null).map((a) => [a.textContent, a.getAttribute('href')])`);
  out('not-running', { text, links });
  expect(text.includes('Ledung is not running'), 'the page says "Ledung is not running"', text);
  expect(JSON.stringify(links) === JSON.stringify([['Start Ledung', '#start'], ['Retry', '#retry']]), 'the page has its Start Ledung and Retry buttons', links);
  return w;
}
async function retry(w: BrowserWindow): Promise<string[]> {
  await page(w, `document.querySelector('a#retry').click(); 1`);
  out('retry-pressed');
  return signedIn(await showing(`${origin}/`));
}

/** The window's state as a person would see it, and whether the page still answers. */
async function windowState(w: BrowserWindow) {
  const answers = await Promise.race([page(w, '1 + 1').then((v) => v === 2, () => false), sleep(3000).then(() => false)]);
  return { visible: w.isVisible(), destroyed: w.isDestroyed(), windows: BrowserWindow.getAllWindows().length, pageAnswers: answers, url: w.webContents.getURL() };
}
const menuItem = (id: string) => Menu.getApplicationMenu()?.getMenuItemById(id) ?? null;

/** The window behaves like an app (#359). Ends the app with its own Quit; the probe exits from will-quit. */
async function windowPhase(w: BrowserWindow): Promise<void> {
  const throttling = w.webContents.getBackgroundThrottling();
  out('prefs', { backgroundThrottling: throttling });
  expect(throttling === false, 'the page runs without background throttling', throttling);

  // The window's close (its red button, Alt+F4's twin) hides it, and the app and the page stay.
  w.close();
  await sleep(800);
  const closed = await windowState(w);
  out('closed', closed);
  expect(!closed.visible && !closed.destroyed && closed.windows === 1 && closed.pageAnswers && closed.url === `${origin}/`,
    'closing hid the window; it and its page are still there', closed);

  // A click on the app in the Dock.
  app.emit('activate', {}, false);
  await sleep(800);
  const activated = await windowState(w);
  out('activated', activated);
  expect(activated.visible && activated.windows === 1, 'the Dock click showed the window', activated);

  // ⌘W / Ctrl+W: the menu's Close Window.
  const close = menuItem('close-window');
  out('close-item', { accelerator: close?.accelerator ?? null });
  expect(close?.accelerator === 'CmdOrCtrl+W', 'Close Window is on ⌘W / Ctrl+W', close?.accelerator);
  close?.click();
  await sleep(800);
  const hidden = await windowState(w);
  out('close-window', hidden);
  expect(!hidden.visible && !hidden.destroyed && hidden.windows === 1 && hidden.pageAnswers, 'Close Window hid the window', hidden);

  // A second start of the app shows this window and ends; Electron's own binary, the same app folder.
  const started = Date.now();
  const second = spawn(process.execPath, [here], { env: { ...process.env, PROBE_PHASE: 'child' }, stdio: 'ignore' });
  const exit = await Promise.race([
    new Promise<number | null>((r) => second.once('exit', (code) => r(code))),
    sleep(20_000).then(() => 'still running' as const),
  ]);
  if (exit === 'still running') second.kill('SIGKILL');
  await sleep(800);
  const again = { exit, ms: Date.now() - started, ...(await windowState(w)) };
  out('second-start', again);
  expect(exit === 0, 'the second start ended by itself', exit);
  expect(again.visible && again.windows === 1, 'the second start showed the first window', again);

  // ⌘O on the Mac: the page hears its own Ctrl+O, as its Show tool calls key reads it (web/src/sessionMenu.ts).
  const toolCalls = menuItem('tool-calls');
  if (process.platform === 'darwin') {
    await page(w, `window.__probeKeys = []; window.addEventListener('keydown', (e) => window.__probeKeys.push({ key: e.key, code: e.code,
      ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, isComposing: e.isComposing }), true); 1`);
    toolCalls?.click();
    await sleep(500);
    const keys = await page(w, 'window.__probeKeys');
    out('cmd-o', { accelerator: toolCalls?.accelerator ?? null, keys });
    expect(toolCalls?.accelerator === 'Cmd+O', 'the item is on ⌘O', toolCalls?.accelerator);
    expect(keys.length === 1 && isToolCallsKey(keys[0]), 'the page heard one key, and its Ctrl+O handler takes it', keys);
  } else {
    expect(toolCalls === null, 'no ⌘O item off the Mac', toolCalls?.accelerator);
  }

  // A page with unsaved changes asks before Quit; Stay keeps the app, and the next close still hides (self-check
  // finding 1). Asked with the window hidden, it shows the window first (code review of PR #372, Minor 2). The
  // question is answered here, as the browser is: nothing shows on the screen.
  const asked: string[] = [];
  /** Whether the window was shown at each question: one asked of a hidden window may never be seen (code review of
   *  PR #372, Minor 2). */
  const shownWhenAsked: boolean[] = [];
  (dialog as unknown as { showMessageBoxSync: (w: unknown, o: { message: string }) => number }).showMessageBoxSync = (_w, o) => {
    asked.push(o.message);
    shownWhenAsked.push(w.isVisible());
    return 1;
  };
  // With a user gesture, or Chromium ignores the page's request to be asked.
  await w.webContents.executeJavaScript(`window.addEventListener('beforeunload', (e) => e.preventDefault()); 1`, true);
  // The window hidden first, as after ⌘W, then Quit (from the Dock, say).
  w.hide();
  await sleep(500);
  const hiddenBefore = !w.isVisible();
  menuItem('quit')?.click();
  await sleep(1500);
  const stayed = { asked: [...asked], hiddenBefore, shownWhenAsked: [...shownWhenAsked], ...(await windowState(w)) };
  out('quit-stay', stayed);
  expect(stayed.asked.length === 1 && stayed.visible && !stayed.destroyed && stayed.windows === 1 && stayed.pageAnswers,
    'Quit on a page with unsaved changes asked once, and Stay kept the app and its window', stayed);
  expect(hiddenBefore && shownWhenAsked[0] === true, 'Quit from a hidden window showed the window before asking', stayed);
  w.close();
  await sleep(800);
  const afterStay = await windowState(w);
  out('close-after-stay', afterStay);
  expect(!afterStay.visible && !afterStay.destroyed && afterStay.windows === 1, 'after Stay, closing still hides the window', afterStay);
  // Leave lets the page go: a reload answered Leave goes through, and drops the probe's unsaved-changes handler.
  (dialog as unknown as { showMessageBoxSync: (w: unknown, o: { message: string }) => number }).showMessageBoxSync = (_w, o) => {
    asked.push(o.message);
    shownWhenAsked.push(w.isVisible());
    return 0;
  };
  const marked = await page(w, `window.__probeMark = 1; 1`);
  w.webContents.reload();
  await sleep(1000);
  await showing(`${origin}/`);
  await sleep(1500);
  const left = { asked: asked.length, reloaded: marked === 1 && (await page(w, `window.__probeMark === undefined`)) };
  out('reload-leave', left);
  expect(left.asked === 2 && left.reloaded, 'a reload answered Leave asked once and went through', left);
  w.show();

  // Full screen on the Mac: closing leaves full screen first, then hides (self-check finding 2).
  if (process.platform === 'darwin') {
    w.focus();
    w.setFullScreen(true);
    for (let i = 0; i < 40 && !w.isFullScreen(); i++) await sleep(250);
    if (!w.isFullScreen()) {
      // A Mac with no display attached (a headless one reached by Screen Sharing) may never enter full screen.
      w.setFullScreen(false);
      out('fullscreen-close', { checked: false, why: 'the window did not enter full screen within 10 s on this computer' });
    } else {
      w.close();
      for (let i = 0; i < 40 && (w.isFullScreen() || w.isVisible()); i++) await sleep(250);
      const full = { checked: true, fullScreenAfter: w.isFullScreen(), visibleAfter: w.isVisible() };
      out('fullscreen-close', full);
      expect(!full.fullScreenAfter && !full.visibleAfter, 'closing from full screen left full screen and hid the window', full);
    }
    w.show();
  }

  // Timers while hidden: a 100 ms interval keeps near its pace (throttled, it would tick about once a second).
  const seconds = Number(process.env.PROBE_HIDDEN_SECONDS ?? 60);
  await page(w, `window.__probeTicks = []; window.__probeTimer = setInterval(() => window.__probeTicks.push(performance.now()), 100); 1`);
  w.hide();
  await sleep(seconds * 1000);
  const ticks: number[] = await page(w, `clearInterval(window.__probeTimer); window.__probeTicks`);
  const avg = ticks.length > 1 ? (ticks.at(-1)! - ticks[0]!) / (ticks.length - 1) : null;
  const gaps = ticks.slice(1).map((t, i) => t - ticks[i]!).sort((a, b) => a - b);
  const round = (n: number | undefined) => (n === undefined ? null : Math.round(n * 10) / 10);
  const timers = {
    seconds, hiddenThroughout: !w.isVisible(), ticks: ticks.length, avgMs: avg === null ? null : round(avg),
    medianMs: round(gaps[Math.floor(gaps.length / 2)]), maxMs: round(gaps.at(-1)),
  };
  out('hidden-timers', timers);
  // Under 150 ms is the Windows bar (#359), where Chromium's throttling gives about 1000 ms. On macOS a hidden window
  // ran at 176–181 ms with throttling off (60 s) and on (5 s and 60 s) alike (2026-11-17, Electron 45.3.3: the
  // system's own timer coalescing, not Chromium's), so there the figure proves nothing about the setting and only
  // rules out 1 s ticks.
  const bar = process.platform === 'win32' ? 150 : 500;
  expect(timers.hiddenThroughout && avg !== null && avg < bar, `a hidden window keeps a 100 ms interval under ${bar} ms a tick`, timers);
  w.show();

  // Quit (⌘Q / File → Quit): the window closes for real, the app ends, the Ledung it attached to still answers.
  const quit = menuItem('quit');
  out('quit-item', { label: quit?.label ?? null, accelerator: quit?.accelerator ?? null });
  expect(quit?.accelerator === (process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4'), 'Quit is on ⌘Q (Mac) / Alt+F4', quit?.accelerator);
  const t = token();
  quitExpected = true;
  app.once('will-quit', (event) => {
    event.preventDefault();
    void (async () => {
      const after = { windows: BrowserWindow.getAllWindows().length, ledungAnswers: t !== null && port !== undefined && (await answersSignIn(port, t)) };
      out('quit', after);
      expect(after.windows === 0, 'Quit closed the window', after.windows);
      expect(after.ledungAnswers, 'the Ledung still answers on its port after Quit');
      out('done', { passed: !failed });
      app.exit(failed ? 1 : 0);
    })();
  });
  quit?.click();
  await sleep(10_000);
  expect(false, 'Quit ended the app');
}

/** Set just before the probe presses Quit; any other quit (the window closing for real, say) is a failure. */
let quitExpected = false;

/** The environment of a process of this user, as `NAME=value` lines' names; macOS reads it with ps -E, Linux in /proc. */
function envNames(pid: string): string[] {
  if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').map((e) => e.split('=')[0]!).filter(Boolean);
  const line = execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', pid], { encoding: 'utf8', maxBuffer: 16 << 20 });
  return [...line.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]!);
}

/** The started Ledung (the process listening on the port) and its launcher, `ledung --foreground`: no ELECTRON_*, no npm_*. */
function startedEnv(): void {
  // The app itself has both kinds (`npx electron` adds npm_*, the run sets an ELECTRON_* one), so leaving them out is
  // what the check below sees, not their absence to begin with.
  const own = Object.keys(process.env);
  expect(own.some((n) => n.startsWith('ELECTRON_')) && own.some((n) => n.startsWith('npm_')), 'the app has ELECTRON_* and npm_* variables to leave out', own.filter((n) => /^(ELECTRON_|npm_)/.test(n)).length);
  const pid = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0]!;
  const parent = execFileSync('ps', ['-o', 'ppid=', '-p', pid], { encoding: 'utf8' }).trim();
  const parentCommand = execFileSync('ps', ['-ww', '-o', 'command=', '-p', parent], { encoding: 'utf8' }).trim();
  for (const [who, p] of [['ledung', pid], ['launcher', parent]] as const) {
    const names = envNames(p);
    const leaked = names.filter((n) => /^(ELECTRON_|npm_)/i.test(n));
    out('started-env', { who, pid: p, variables: names.length, leaked, hasConfig: names.includes('LEDUNG_CONFIG') });
    // The positive branch: the same read finds a variable that is there, so an empty read can't pass.
    expect(names.includes('LEDUNG_CONFIG'), `the ${who}'s environment was read (LEDUNG_CONFIG found)`, names.length);
    expect(leaked.length === 0, `the ${who} has no ELECTRON_* and no npm_* variable`, leaked);
  }
  expect(parentCommand.includes('--foreground'), 'the launcher is `ledung --foreground`, as a terminal start makes', parentCommand);
}

/** Presses Start Ledung on the "not running" page; returns when the page says it is starting. */
async function pressStart(w: BrowserWindow): Promise<void> {
  await page(w, `document.querySelector('a#start').click(); 1`);
  out('start-pressed');
}

/** Presses the application menu's Quit, as ⌘Q or File → Quit does, and waits for the app to begin quitting (no dialog in the way). */
async function menuQuit(): Promise<boolean> {
  const find = (items: MenuItem[]): MenuItem | undefined => {
    for (const item of items) {
      if (item.role?.toLowerCase() === 'quit' || item.id === 'quit') return item;
      const inner = item.submenu ? find(item.submenu.items) : undefined;
      if (inner) return inner;
    }
    return undefined;
  };
  const item = find(Menu.getApplicationMenu()?.items ?? []);
  out('menu-quit', { found: item ? { role: item.role ?? null, id: item.id || null, label: item.label, accelerator: item.accelerator ?? null } : null });
  if (!item) return false;
  // This quit is asked for: the guard in run() fails any other (#359).
  quitExpected = true;
  const quitting = new Promise<boolean>((resolve) => {
    app.once('will-quit', (event) => {
      event.preventDefault();
      resolve(true);
    });
    setTimeout(() => resolve(false), 5000);
  });
  // The default menu's Quit on the Mac is the system's own terminate:, which a click from here doesn't reach; it ends
  // in app.quit() as this does. A Quit item of the app's own (#359's menu) is clicked as it is.
  if (item.role === 'quit' && process.platform === 'darwin') app.quit();
  else item.click();
  return quitting;
}

async function run(): Promise<void> {
  let core: ChildProcess | null = null;
  // Without this, an app that quits on its own would end the probe with exit code 0 (found by the #359 revert check).
  app.on('will-quit', (event) => {
    if (quitExpected) return;
    event.preventDefault();
    expect(false, 'the app quit when the probe did not ask it to');
    out('done', { passed: false });
    app.exit(1);
  });
  try {
    out('ready', { electron: process.versions.electron, node: process.versions.node, port });
    if (phase === 'attach' || phase === 'again') {
      const w = await showing(`${origin}/`);
      const ids = await signedIn(w);
      expect(external.length === 0, 'nothing opened in the browser at start', [...external]);
      if (phase === 'attach') {
        fs.writeFileSync(devicesFile, JSON.stringify(ids));
        looks(w);
        await permissions(w);
        const opened = await page(w, `[window.open('https://github.com/example/pr/1') === null, window.open('/api/state') === null]`);
        await sleep(500);
        await page(w, `location.href = 'https://example.com/away'; 1`);
        await sleep(1500);
        const navigation = { openGaveNothing: opened, urlAfter: w.webContents.getURL(), browserOpened: [...external], windows: BrowserWindow.getAllWindows().length };
        out('navigation', navigation);
        expect(opened[0] === true && opened[1] === true, 'no new window, for an outside or an own address', opened);
        expect(navigation.urlAfter === `${origin}/` && navigation.windows === 1, 'the window stayed on Ledung', navigation.urlAfter);
        expect(JSON.stringify(navigation.browserOpened) === JSON.stringify(['https://github.com/example/pr/1', 'https://example.com/away']),
          'both outside addresses went to the browser, the own one did not', navigation.browserOpened);
        external.length = 0;
        // A new-tab link, clicked as a person would, as the page's links to pull requests are.
        const link = 'https://github.com/Fluffy-Fluffy-and-Bouncy/ledung/pull/1';
        await page(w, `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(link)}; a.target = '_blank'; a.rel = 'noreferrer noopener'; document.body.append(a); a.click(); a.remove(); return 1; })()`);
        await sleep(1000);
        const blank = { browserOpened: [...external], urlAfter: w.webContents.getURL(), windows: BrowserWindow.getAllWindows().length };
        out('blank-link', blank);
        expect(blank.browserOpened.length === 1 && blank.browserOpened[0] === link && blank.urlAfter === `${origin}/` && blank.windows === 1,
          'the clicked link went to the browser and the window stayed', blank);
      } else {
        let before: string[] | null = null;
        try {
          before = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
        } catch {
          // No "attach" run first.
        }
        out('devices', { afterAttach: before?.map((id) => id.slice(0, 8)) ?? null, now: ids.map((id) => id.slice(0, 8)) });
        expect(before !== null, 'an "attach" run saved its device list first');
        expect(JSON.stringify(before) === JSON.stringify(ids), 'a second start added no device', { before, now: ids });
      }
    } else if (phase === 'notrunning') {
      const w = await notRunningPage();
      expect((await page(w, `document.body.innerText`)).includes(`port ${port}`), 'the reason names the port tried');
      core = startCore();
      await waitForCore();
      await retry(w);
    } else if (phase === 'stopped') {
      core = startCore();
      await waitForCore();
      // The app looked before the Ledung was up: Retry from the "not running" page, or it found it already.
      const first = await showing('');
      if (first.webContents.getURL().startsWith('file:')) await retry(first);
      else await signedIn(first);
      await stopCore(core);
      core = null;
      win()!.webContents.reload();
      const w = await notRunningPage();
      expect((await page(w, `document.body.innerText`)).includes('did not load'), 'the reason says the page did not load');
      core = startCore();
      await sleep(4000);
      await retry(w);
    } else if (phase === 'window') {
      const w = await showing(`${origin}/`);
      await signedIn(w);
      await windowPhase(w);
    } else if (phase === 'start') {
      const w = await notRunningPage();
      const pressed = Date.now();
      await pressStart(w);
      const startingText = (await page(await showing('file:'), `document.body.innerText`)).replace(/\s+/g, ' ');
      out('starting', { text: startingText });
      expect(startingText.includes('Starting Ledung') && !startingText.includes('Retry'), 'pressing Start shows "Starting Ledung…" with no buttons', startingText);
      await signedIn(await showing(`${origin}/`));
      const seconds = (Date.now() - pressed) / 1000;
      out('started', { seconds });
      expect(seconds <= 15, 'the page showed signed in within 15 s of pressing Start Ledung', seconds);
      startedEnv();
      expect(errorDialogs.length === 0, 'no error dialog', errorDialogs);
    } else if (phase === 'startfail') {
      const w = await notRunningPage();
      await pressStart(w);
      // The start runs, fails, and the page comes back with what failed.
      let failedPage: BrowserWindow | null = null;
      for (let i = 0; i < 100 && !failedPage; i++) {
        await sleep(200);
        const now = win();
        if (now && !now.webContents.isLoading() && now.webContents.getURL().includes('state=failed')) failedPage = now;
      }
      expect(failedPage !== null, 'the "not running" page came back after the failed start');
      if (failedPage) {
        const reason = await page(failedPage, `document.getElementById('reason').textContent`);
        out('start-failed', { reason });
        expect(/exited with code 1: Error: Cannot find module/.test(reason) && reason.includes('--no-open'), 'the page says what failed: the command, its exit and its error', reason);
        expect(!/[\r\n]/.test(reason), 'what failed is one line', reason);
        await notRunningPage();
      }
      expect(errorDialogs.length === 0, 'no error dialog', errorDialogs);
      expect(BrowserWindow.getAllWindows().length === 1, 'no other window', BrowserWindow.getAllWindows().length);
      expect(await menuQuit(), "the menu's Quit ends the app");
    } else {
      expect(false, `no phase named ${phase}`);
    }
  } catch (e) {
    out('error', { message: (e as Error).message });
    failed = true;
  }
  if (core) await stopCore(core);
  await win()?.webContents.session.cookies.flushStore();
  out('done', { passed: !failed });
  await sleep(500);
  app.exit(failed ? 1 : 0);
}

if (refused) {
  out('error', { message: `refused: ${refused}` });
  app.exit(2);
} else if (phase === 'child') {
  // The second start "window" launches: the app alone, which should hand over to the first and end.
  void import('../main.ts');
} else {
  // Not awaited: Electron holds its ready event until a top-level await in the entry module settles.
  void import('../main.ts').then((m: { APP_ICON: string }) => {
    appIcon = m.APP_ICON;
    return app.whenReady();
  }).then(run);
}
