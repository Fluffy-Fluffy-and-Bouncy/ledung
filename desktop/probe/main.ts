// The desktop app's loopback check (issue #358): loads the real ../main.ts in Electron, against a throwaway Ledung
// named by LEDUNG_CONFIG and LEDUNG_DATA_DIR, checks the window from inside and quits. Prints `PROBE {json}` lines;
// every observation the PR relies on is checked here, and a check that fails prints `"event":"fail"` and makes the
// exit code 1 (test review of PR #366, finding 1). 0 means every check held; 2 means it refused to run.
// Never point it at a real Ledung: the "notrunning" and "stopped" phases start and stop the Ledung of that config.
// Opening the default browser is intercepted and recorded, so nothing opens on the screen.
//
//   PROBE_PHASE=attach      a Ledung runs: signed in, address, settings, permissions, refused navigation and
//                           windows, links, Ledung's icon, the menu bar that never shows and the keys that still
//                           work off the Mac (#384, #389), the page's bridge to the app (#360, #414); saves the device
//                           list for "again"
//   PROBE_PHASE=again       a second start: still signed in, the same devices as after "attach"
//   PROBE_PHASE=notrunning  none runs: the "not running" page, whose call to show the window is refused (#360); the
//                           probe starts one, presses Retry, page loads, and the same call from it shows the window
//   PROBE_PHASE=stopped     the probe starts one, the app attaches, the probe stops it and reloads: the "not
//                           running" page again; it starts it again, presses Retry, page loads
//   PROBE_PHASE=window      a Ledung runs: closing hides, the Dock and a second start show the window again, ⌘O is
//                           the page's Ctrl+O, timers keep their pace while hidden, Quit ends the app and not
//                           Ledung (#359). PROBE_HIDDEN_SECONDS sets how long the timers run hidden (60)
//   PROBE_PHASE=find        a Ledung runs (#445): ⌘F / Ctrl+F opens the find bar from a text box, typing counts the
//                           page's matches ("n of m"), Enter and Shift+Enter step, Esc closes and clears the
//                           highlights, Edit → Find… opens it again; PROBE_SHOT=<file.png> also saves the window with
//                           the bar open on PROBE_FIND_TEXT ("Ledung")
//   PROBE_PHASE=context     a Ledung runs (#447): right-clicks a picture, a link, selected text, a text box, a broken
//                           picture and a plain spot in the page, and clicks the menu's items: Copy Image, Save Image
//                           As…, Copy Link Address, Copy, Paste and Select All do what they say, and the last two
//                           spots get no menu; PROBE_SHOT=<file.png> also shows the real menu over the picture and
//                           saves the screen (macOS)
//   PROBE_PHASE=pictures    a Ledung runs, with PROBE_PROJECT a local project whose sessions run on Haiku (#451): the
//                           real page's pictures, set up by the probe (a sent picture, a question with two
//                           screenshots), right-clicked in the conversation and on Waiting for you; each picture in
//                           sight gets Copy Image and Save Image As…, the menu opens, Copy Image copies; one with
//                           something over it fails, naming it.
//                           PROBE_CLICK=native uses the system's mouse (unlocked screen, window in front);
//                           PROBE_MAIN=<dist/desktop/main.js> runs a package's built app instead of ../main.ts;
//                           PROBE_SHOT_DIR saves the window per route. Runs on Windows too, as do "context" and
//                           "framed"
//   PROBE_PHASE=framed      a Ledung runs (#451): a picture in a frame of another site, as another computer's tab
//                           shows its page, right-clicked with PROBE_CLICK=native (Electron's input call never
//                           reaches such a frame); PROBE_FRAME_SAME=1 frames it from the page's own site, the control
//   PROBE_PHASE=frames      a Ledung runs whose config lists the computer other.example.test (#468): the probe stands
//                           in for that computer with an HTTPS server of its own on loopback, and shows its page in a
//                           frame on Ledung's page, as a computer tab does; a form there answers 303 with a cookie, as
//                           Pair does. The frame lands on the page the answer names, its cookie comes back there and
//                           on a reload, and the window itself still refuses a redirect away from Ledung. Needs
//                           openssl on PATH (a throwaway certificate, in the data folder)
//   (PROBE_PHASE=child is the second start "window" launches itself)
//   PROBE_PHASE=start      none runs: presses Start Ledung (#362), which runs LEDUNG_DESKTOP_START's script (the
//                           worktree's src/cli.ts) as the app's start; the page loads signed in within 15 s, and
//                           neither the started Ledung nor its launcher has an ELECTRON_* or npm_* variable. Leaves
//                           that Ledung running, so the shell can check it still answers after the app quit. Run it
//                           with an ELECTRON_* variable of your own set (ELECTRON_PROBE=1) and through npx, which
//                           adds npm_*: the probe checks the app has both, so their absence in Ledung means something
//   PROBE_PHASE=notify      a Ledung runs, with a project the shell starts a session in that asks for permission while
//                           the probe waits (#360): turns the page's notifications on, hides the window, waits for the
//                           page's notification, clicks it, and the window shows on the session that asked.
//                           PROBE_NOTIFY_SECONDS sets how long it waits for the notification (180)
//   PROBE_PHASE=startfail   none runs, LEDUNG_DESKTOP_START names a script that isn't there: Start fails, the page
//                           says so in one line and offers Start and Retry, no error dialog, and the menu's Quit ends
//                           the app
//   PROBE_PHASE=windows     a Ledung runs (#414): File → New Window on ⌘N/Ctrl+N and the page's New window button
//                           each open another signed-in window at the start page, the first keeping its own route;
//                           the "not running" page cannot ask for one; closing one leaves the others; the last one
//                           closed hides; the Dock and a second start show the most recently used; Quit ends the app
//
// Run from desktop/: `LEDUNG_CONFIG=… LEDUNG_DATA_DIR=… PROBE_PHASE=attach npx electron probe`. macOS and Linux
// only for now, but for "context", "pictures" and "framed": it reads command lines with `ps` (code review of PR #366, Minor 3).
import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, screen, shell, WebContentsView, type MenuItem, type NativeImage, type WebContents } from 'electron';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isToolCallsKey } from '../../web/src/sessionMenu.ts';
import { answersSignIn, candidatePorts, configFiles, dataDir, DEFAULT_PORT } from '../attach.ts';
import { ZOOM_STEP } from '../keys.ts';
import { START_SCRIPT_ENV } from '../start.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const clone = path.resolve(here, '..', '..');
const phase = process.env.PROBE_PHASE ?? 'attach';
const port = candidatePorts(configFiles())[0];
// Only a throwaway Ledung: without both settings the app would find the real one (self-check round 2, finding 1).
// Checked before the app is loaded, since it attaches as soon as Electron is ready.
// Windows only for the phases that read no command lines but signedIn's, which asks PowerShell there (#451).
const refused = process.platform === 'win32' && !['context', 'pictures', 'framed'].includes(phase)
  ? 'Windows has no ps to read command lines with; this phase runs on macOS or Linux (context, pictures and framed run on Windows too)'
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
/**
 * Alpha at three points of a 512 px Dock icon (#404): the top-left corner, the last margin pixel of the middle row,
 * and two pixels into the body on that row. Apple's grid gives a 50 px margin at 512 px (desktop/dock-icon.ts); the
 * 4th byte is alpha in Electron's BGRA and in RGBA alike.
 */
function dockEdge(image: NativeImage): { corner: number; outside: number; inside: number } {
  const { width } = image.getSize();
  const bitmap = image.toBitmap();
  const alpha = (x: number, y: number) => bitmap[(y * width + x) * 4 + 3] ?? -1;
  const mid = Math.floor(width / 2);
  return { corner: alpha(0, 0), outside: alpha(49, mid), inside: alpha(52, mid) };
}
/** main.ts's icon path, read from the module once it is loaded. */
let appIcon = '';
/** main.ts's Copy Image, read from the module once it is loaded: "framed" calls it as the menu does (#451). */
let appCopyImage: ((contents: WebContents, params: { x: number; y: number; srcURL: string; frame: Electron.WebFrameMain | null }) => Promise<void>) | null = null;
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
  const commandLines = process.platform === 'win32'
    ? execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object CommandLine'], { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true })
    : execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
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
 * Ledung's icon and the hidden menu bar (#384, #389, #404): the icon file loads as a 512 px image, the Mac's Dock was given
 * it, Windows and Linux hide the menu bar with no auto-hide, and the menu still carries the items whose shortcuts must
 * work.
 */
function looks(w: BrowserWindow): void {
  const icon = nativeImage.createFromPath(appIcon);
  const mac = process.platform === 'darwin';
  const menu = Menu.getApplicationMenu();
  const roles = (menu?.items ?? []).map((i) => i.role ?? i.label);
  const report = {
    icon: path.relative(clone, appIcon), iconSize: icon.getSize(), iconEmpty: icon.isEmpty(),
    dockIcons: dockIcons.map((d) => ({ size: d.getSize(), sameAsIcon: d.toPNG().equals(icon.toPNG()), edge: dockEdge(d) })),
    menuBarAutoHide: w.isMenuBarAutoHide(), menuBarVisible: w.isMenuBarVisible(), menu: roles,
    closeWindow: menuItem('close-window')?.accelerator ?? null, toolCalls: menuItem('tool-calls')?.accelerator ?? null,
  };
  out('looks', report);
  expect(appIcon.endsWith(path.join('web', 'public', 'icon-512.png')), "the icon is the page's own icon-512.png", report.icon);
  expect(!icon.isEmpty() && icon.getSize().width === 512 && icon.getSize().height === 512, 'the icon loads as a 512 × 512 image', report);
  if (mac) {
    // Padded, not the file as it is (#404): a 512 px image, clear up to the margin on the middle row, the body's
    // own pixels just inside it. The second half is the positive branch of the first.
    const dock = report.dockIcons[0];
    expect(report.dockIcons.length === 1 && dock !== undefined && dock.size.width === 512 && dock.size.height === 512 && !dock.sameAsIcon,
      "the Dock was given Ledung's icon, once, as a 512 px image of its own", report.dockIcons);
    expect(dock !== undefined && dock.edge.outside === 0 && dock.edge.corner === 0, 'the Dock icon is clear outside the margin', dock?.edge);
    expect(dock !== undefined && dock.edge.inside === 255, "the Dock icon's body starts just inside the margin", dock?.edge);
  } else {
    // Never shown, and not auto-hidden: auto-hide is what lets Alt show it (#389).
    expect(!report.menuBarAutoHide && !report.menuBarVisible, 'the menu bar is hidden, with no auto-hide', report);
    // The positive branch: the same probe sees the bar when it is shown.
    w.setMenuBarVisibility(true);
    const shown = w.isMenuBarVisible();
    w.setMenuBarVisibility(false);
    out('menu-bar-shown', { shown, hiddenAgain: !w.isMenuBarVisible() });
    expect(shown && !w.isMenuBarVisible(), 'the probe sees the menu bar when shown, and hidden again', { shown });
  }
  expect(report.closeWindow === 'CmdOrCtrl+W', 'Close Window keeps Ctrl+W / ⌘W', report.closeWindow);
  expect(['editmenu', 'viewmenu'].every((r) => roles.includes(r as never)), 'the Edit and View menus are still there (copy, paste, zoom)', roles);
  // Show Tool Calls is in the Mac's File menu only: Windows and Linux press the page's Ctrl+O directly (#359).
  if (mac) expect(report.toolCalls === 'Cmd+O', 'Show Tool Calls keeps ⌘O', report.toolCalls);
}

/** The View menu's Zoom In moves the zoom level by ZOOM_STEP, the step the app's own zoom keys take (#389). */
async function menuZoomStep(w: BrowserWindow): Promise<void> {
  // The app's own Zoom In since #445 (desktop/menu.ts), by its id.
  const zoomIn = Menu.getApplicationMenu()?.getMenuItemById('zoomIn') ?? undefined;
  w.focus();
  w.webContents.zoomLevel = 0;
  zoomIn?.click(undefined, w, w.webContents);
  await sleep(300);
  const level = w.webContents.zoomLevel;
  w.webContents.zoomLevel = 0;
  out('menu-zoom-in', { found: zoomIn !== undefined, level, step: ZOOM_STEP });
  expect(zoomIn !== undefined && level === ZOOM_STEP, "the View menu's Zoom In takes the app's zoom step", level);
}

/** Presses a key in the window as the keyboard does: down, then up. */
async function press(w: BrowserWindow, keyCode: string, modifiers: Array<'control' | 'alt' | 'shift'> = []): Promise<void> {
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await sleep(400);
}

/**
 * Windows and Linux (#389): Alt shows no menu bar, and the hidden menu's keys and the app's own still work: Ctrl and
 * "+" or "=" zoom in one step, Ctrl+- out, Ctrl+0 back, Ctrl and the wheel zoom, Ctrl+O reaches the page as Show tool
 * calls, copy works, and Ctrl+W hides the window. Leaves the window shown at 100 %.
 */
async function keys(w: BrowserWindow): Promise<void> {
  const wc = w.webContents;
  // Alt, pressed and let go: the bar stays hidden. The positive branch: with auto-hide on, as #384 had it, the same
  // presses show it, so the presses do reach the window.
  await press(w, 'Alt', ['alt']);
  const afterAlt = w.isMenuBarVisible();
  w.setAutoHideMenuBar(true);
  await press(w, 'Alt', ['alt']);
  const autoHideShows = w.isMenuBarVisible();
  w.setAutoHideMenuBar(false);
  w.setMenuBarVisibility(false);
  out('alt', { afterAlt, autoHideShows, hiddenAgain: !w.isMenuBarVisible() });
  expect(!afterAlt, 'Alt shows no menu bar', afterAlt);
  expect(autoHideShows && !w.isMenuBarVisible(), 'with auto-hide, the same Alt shows the bar (the presses reach the window)', autoHideShows);

  // Zoom: each press one step of 0.5, the View menu's own; "+" exactly once, though the menu has a Ctrl+Shift+"=" too.
  wc.zoomLevel = 0;
  const levels: Record<string, number> = {};
  for (const [name, keyCode, modifiers] of [
    ['ctrl+plus', 'Plus', ['control']], ['ctrl+equals', '=', ['control']], ['ctrl+minus', '-', ['control']], ['ctrl+0', '0', ['control']],
  ] as const) {
    await press(w, keyCode, [...modifiers]);
    levels[name] = wc.zoomLevel;
  }
  // Ctrl and one wheel notch up, then down.
  const wheel = (deltaY: number) => wc.sendInputEvent({ type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY, wheelTicksX: 0, wheelTicksY: Math.sign(deltaY), canScroll: true, modifiers: ['control'] });
  wheel(120);
  await sleep(400);
  levels['ctrl+wheel-up'] = wc.zoomLevel;
  wheel(-120);
  await sleep(400);
  levels['ctrl+wheel-down'] = wc.zoomLevel;
  out('zoom', levels);
  expect(levels['ctrl+plus'] === 0.5 && levels['ctrl+equals'] === 1, 'Ctrl and "+" or "=" zoom in one step each', levels);
  expect(levels['ctrl+minus'] === 0.5 && levels['ctrl+0'] === 0, 'Ctrl+- zooms out and Ctrl+0 resets', levels);
  expect(levels['ctrl+wheel-up'] === 0.5 && levels['ctrl+wheel-down'] === 0, 'Ctrl and the wheel zoom in and out', levels);
  wc.zoomLevel = 0;

  // Ctrl+O: the page's own Show tool calls key, which no menu item takes off the Mac (#359).
  await page(w, `window.__probeKeys = []; window.addEventListener('keydown', (e) => window.__probeKeys.push({ key: e.key, code: e.code,
    ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, isComposing: e.isComposing }), true); 1`);
  await press(w, 'O', ['control']);
  const heard = await page(w, 'window.__probeKeys');
  out('ctrl-o', heard);
  expect(heard.length === 1 && isToolCallsKey(heard[0]), 'Ctrl+O reaches the page as its Show tool calls key', heard);

  // Copy: select a text of the probe's own and Ctrl+C; the clipboard then holds it.
  const text = `ledung-probe-${Date.now()}`;
  await page(w, `(() => { const t = document.createElement('textarea'); t.id = '__probeText'; t.value = ${JSON.stringify(text)}; document.body.append(t); t.focus(); return 1; })()`);
  await press(w, 'A', ['control']);
  await press(w, 'C', ['control']);
  const copied = await clipboard.readText();
  await page(w, `document.getElementById('__probeText')?.remove(); 1`);
  out('copy', { copied: copied === text });
  expect(copied === text, 'Ctrl+A and Ctrl+C copy the selected text', copied);

  // Ctrl+W, pressed: hides the window; the Dock's way back (activate) shows it again.
  await press(w, 'W', ['control']);
  const hidden = !w.isVisible() && !w.isDestroyed();
  app.emit('activate', {}, false);
  await sleep(800);
  out('ctrl-w', { hidden, shownAgain: w.isVisible() });
  expect(hidden, 'Ctrl+W hides the window', hidden);
  expect(w.isVisible(), 'the window is shown again for the checks after this one', w.isVisible());
}

/** The window's find bar (#445): the view over it showing find-bar.html, once it has been opened. */
function findBarView(w: BrowserWindow): WebContentsView | null {
  for (const child of w.contentView.children) {
    if (child instanceof WebContentsView && child.webContents.getURL().endsWith('/find-bar.html')) return child;
  }
  return null;
}

/** Presses a key in `wc` (the page or the bar), with the Mac's ⌘ as well as the others' modifiers. */
async function pressIn(wc: WebContents, keyCode: string, modifiers: Array<'control' | 'meta' | 'alt' | 'shift'> = []): Promise<void> {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await sleep(500);
}

/** Pixels in `rect` of the page painted in Chromium's find highlights: yellow for every match, orange for the active one. */
async function highlighted(w: BrowserWindow, rect: { x: number; y: number; width: number; height: number }): Promise<number> {
  const image = await w.webContents.capturePage(rect);
  const bitmap = image.toBitmap();
  let count = 0;
  // BGRA. Yellow (255, 255, 0) and orange (255, 150, 50): red high, blue low, which the page's own colours never are.
  for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i + 2]! > 200 && bitmap[i]! < 90 && bitmap[i + 1]! > 110) count++;
  return count;
}

/**
 * The window as a person sees it: the page with the find bar laid over it. Each is captured on its own (a window's
 * capture holds only its page) and the bar drawn over the page at its place, blending its clear corners.
 */
async function windowShot(w: BrowserWindow, bar: WebContentsView): Promise<NativeImage> {
  const pageImage = await w.webContents.capturePage();
  const scale = pageImage.getSize().width / w.getContentBounds().width;
  const barImage = await bar.webContents.capturePage().catch(async (e: Error) => {
    // A locked screen paints the page but leaves the bar's surface out ("Current display surface not available"):
    // the bar's own page, preload and text drawn off screen at its size instead, and the run says so.
    out('shot-bar-offscreen', { reason: e.message });
    const at = bar.getBounds();
    const twin = new BrowserWindow({ show: false, width: at.width, height: at.height, frame: false, transparent: true, backgroundColor: '#00000000',
      webPreferences: { offscreen: true, preload: path.join(here, '..', 'find-bar.cjs'), sandbox: true, contextIsolation: true } });
    await twin.loadFile(path.join(here, '..', 'find-bar.html'));
    const [text, line] = await bar.webContents.executeJavaScript(`[document.getElementById('text').value, document.getElementById('count').textContent]`);
    twin.webContents.send('ledung-find:open', text);
    twin.webContents.send('ledung-find:count', line);
    await sleep(800);
    const image = await twin.webContents.capturePage();
    twin.destroy();
    return image.resize({ width: Math.round(at.width * scale), height: Math.round(at.height * scale) });
  });
  const { width: pw, height: ph } = pageImage.getSize();
  const { width: bw, height: bh } = barImage.getSize();
  const pagePixels = Buffer.from(pageImage.toBitmap());
  const barPixels = barImage.toBitmap();
  const at = bar.getBounds();
  const x0 = Math.round(at.x * scale);
  const y0 = Math.round(at.y * scale);
  for (let y = 0; y < bh && y0 + y < ph; y++) {
    for (let x = 0; x < bw && x0 + x < pw; x++) {
      const s = (y * bw + x) * 4;
      const d = ((y0 + y) * pw + x0 + x) * 4;
      const a = barPixels[s + 3]! / 255;
      for (let c = 0; c < 3; c++) pagePixels[d + c] = Math.round(barPixels[s + c]! * a + pagePixels[d + c]! * (1 - a));
    }
  }
  return nativeImage.createFromBitmap(pagePixels, { width: pw, height: ph, scaleFactor: scale });
}

/**
 * The find bar (#445): ⌘F / Ctrl+F in a text box of the page opens it with the focus in it; typing counts the
 * matches in the page and not in the bar; Enter and Shift+Enter step, around the end; Enter in the page stays the
 * page's; Esc closes it and clears the highlights; Edit → Find… opens it again with the last search; nothing found
 * says so. With PROBE_SHOT set, ends with the bar open on PROBE_FIND_TEXT and saves the window there as a PNG.
 */
async function findPhase(w: BrowserWindow): Promise<void> {
  const wc = w.webContents;
  const command = process.platform === 'darwin' ? 'meta' : 'control';
  const word = 'zebraquokka';
  // The window in front, so the focus checks below mean something (started from a terminal, it may not be).
  w.show();
  w.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
  await sleep(800);
  // A locked screen (a run from another computer at night) puts no window in front: which part of the window has the
  // keys is then read from inside the bar's page, and the run says so.
  const inFront = w.isFocused();
  out('find-window', { inFront });
  const barHasKeys = async (bar: WebContentsView) => (inFront ? bar.webContents.isFocused() : true)
    && (await bar.webContents.executeJavaScript(`document.activeElement?.id`)) === 'text';
  // Three matches in a block of the probe's own, a text box standing in for the composer, and a list of the keys
  // the page hears.
  await page(w, `(() => {
    const d = document.createElement('div'); d.id = '__probeFind';
    d.style.cssText = 'position:fixed;left:40%;top:45%;z-index:99999;padding:8px;font:24px sans-serif;background:#16181d;color:#e3e6eb';
    d.textContent = '${word} one, ${word} two, ${word} three';
    const t = document.createElement('textarea'); t.id = '__probeComposer';
    t.style.cssText = 'position:fixed;left:40%;top:60%;z-index:99999';
    document.body.append(d, t);
    window.__probeKeys = [];
    window.addEventListener('keydown', (e) => window.__probeKeys.push({ key: e.key, code: e.code, ctrlKey: e.ctrlKey,
      metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, isComposing: e.isComposing }), true);
    t.focus();
    return 1;
  })()`);
  const rect = await page(w, `(() => { const r = document.getElementById('__probeFind').getBoundingClientRect();
    return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);
  const count = (bar: WebContentsView) => bar.webContents.executeJavaScript(`document.getElementById('count').textContent`);
  const heard = async () => (await page(w, 'window.__probeKeys.splice(0)')) as Array<{ key: string; ctrlKey: boolean; metaKey: boolean }>;
  wc.focus();
  await heard();

  // ⌘F / Ctrl+F in the text box: the bar opens and takes the keys; the page never hears the F.
  expect(findBarView(w) === null, 'no find bar before the first ⌘F / Ctrl+F');
  await pressIn(wc, 'F', [command]);
  await sleep(500);
  const bar = findBarView(w);
  const opened = { bar: bar !== null, visible: bar?.getVisible() ?? false, focused: bar ? await barHasKeys(bar) : false, pageHeard: await heard() };
  out('find-open', opened);
  expect(opened.bar && opened.visible && opened.focused, `${command}+F in a text box opens the find bar with the focus in it`, opened);
  expect(!opened.pageHeard.some((k) => k.key.toLowerCase() === 'f'), 'the page did not hear the F', opened.pageHeard);
  if (!bar) return;
  const barPrefs = (bar.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences();
  expect(barPrefs.sandbox === true && barPrefs.contextIsolation === true && barPrefs.nodeIntegration === false, 'the bar is sandboxed and isolated', barPrefs);

  // Typing: the page's three matches, not the bar's own text (which holds the word too), the first active.
  const before = await highlighted(w, rect);
  await bar.webContents.insertText(word);
  await sleep(800);
  const typed = { count: await count(bar), barText: await bar.webContents.executeJavaScript(`document.getElementById('text').value`), highlightedBefore: before, highlighted: await highlighted(w, rect) };
  out('find-typed', typed);
  expect(typed.count === '1 of 3' && typed.barText === word, 'typing finds the page\'s three matches, not the bar\'s own text: "1 of 3"', typed);
  expect(before === 0 && typed.highlighted > 0, 'the matches are highlighted in the page, and were not before', typed);

  // Enter, Shift+Enter, and around the start.
  const steps: string[] = [];
  for (const shift of [false, true, true]) {
    await pressIn(bar.webContents, 'Enter', shift ? ['shift'] : []);
    steps.push(await count(bar));
  }
  out('find-steps', steps);
  expect(JSON.stringify(steps) === JSON.stringify(['2 of 3', '1 of 3', '3 of 3']), 'Enter steps on, Shift+Enter back, and back past the first to the last', steps);

  // Enter in the page, with the bar open: the page's, the bar stays as it was.
  wc.focus();
  await page(w, `document.getElementById('__probeComposer').focus(); 1`);
  await heard();
  await pressIn(wc, 'Return');
  const pageEnter = { heard: await heard(), count: await count(bar), visible: bar.getVisible() };
  out('find-page-enter', pageEnter);
  expect(pageEnter.heard.some((k) => k.key === 'Enter') && pageEnter.count === '3 of 3' && pageEnter.visible, 'Enter in the page is the page\'s, and the bar stays', pageEnter);

  // Esc in the bar: closed, highlights gone, the page has the keys again.
  bar.webContents.focus();
  await pressIn(bar.webContents, 'Escape');
  const closed = { visible: bar.getVisible(), pageFocused: inFront ? wc.isFocused() : null, highlighted: await highlighted(w, rect) };
  out('find-closed', closed);
  expect(!closed.visible && closed.pageFocused !== false, 'Esc closes the bar and the page has the focus again', closed);
  expect(closed.highlighted === 0, 'Esc clears the highlights', closed);

  // The page's own keys still reach it: Ctrl+O, its Show tool calls key on every system.
  await heard();
  await pressIn(wc, 'O', ['control']);
  const ctrlO = await heard();
  out('find-ctrl-o', ctrlO);
  expect(ctrlO.length === 1 && isToolCallsKey(ctrlO[0] as never), "the page's own Ctrl+O still reaches it", ctrlO);

  // Edit → Find…: opens again with the last search, found anew, its text selected.
  const item = Menu.getApplicationMenu()?.getMenuItemById('find') ?? null;
  item?.click(undefined, w, wc);
  await sleep(900);
  const selection = `(() => { const t = document.getElementById('text'); return [t.selectionStart, t.selectionEnd, t.value.length]; })()`;
  const menuOpen = { item: item?.label ?? null, accelerator: item?.accelerator ?? null, visible: bar.getVisible(), focused: await barHasKeys(bar),
    count: await count(bar), selection: await bar.webContents.executeJavaScript(selection), highlighted: await highlighted(w, rect) };
  out('find-menu', menuOpen);
  expect(menuOpen.item === 'Find…' && menuOpen.accelerator === 'CmdOrCtrl+F', 'Edit → Find… is on ⌘F / Ctrl+F', menuOpen);
  expect(menuOpen.visible && menuOpen.focused && menuOpen.count === '1 of 3' && menuOpen.highlighted > 0, 'Find… opens the bar again on the last search, found anew', menuOpen);
  expect(JSON.stringify(menuOpen.selection) === JSON.stringify([0, word.length, word.length]), "the bar's text is selected, so typing replaces it", menuOpen.selection);

  // ⌘F / Ctrl+F in the open bar: stays open, the search where it was.
  await pressIn(bar.webContents, 'Enter');
  await pressIn(bar.webContents, 'F', [command]);
  const again = { visible: bar.getVisible(), count: await count(bar), selection: await bar.webContents.executeJavaScript(selection) };
  out('find-again', again);
  expect(again.visible && again.count === '2 of 3' && JSON.stringify(again.selection) === JSON.stringify([0, word.length, word.length]),
    `${command}+F in the open bar selects its text and leaves the search where it was`, again);

  // The menu's View items while the bar has the focus: Electron hands a menu item the focused contents, the bar's,
  // and its standard Zoom In zoomed the bar (self-check of PR #448, finding 1). Pressed as the menu does, with the bar
  // as the focused contents.
  wc.zoomLevel = 0;
  Menu.getApplicationMenu()?.getMenuItemById('zoomIn')?.click(undefined, w, bar.webContents);
  await sleep(400);
  const zoom = { page: wc.zoomLevel, bar: bar.webContents.zoomLevel };
  wc.zoomLevel = 0;
  bar.webContents.zoomLevel = 0;
  out('find-menu-zoom', zoom);
  expect(zoom.page === ZOOM_STEP && zoom.bar === 0, "View → Zoom In with the bar in focus zooms the page, not the bar", zoom);

  // Nothing found, then an empty box.
  await bar.webContents.insertText('qxqzvkw');
  await sleep(800);
  const none = await count(bar);
  await bar.webContents.executeJavaScript(`(() => { const t = document.getElementById('text'); t.value = ''; t.dispatchEvent(new Event('input')); return 1; })()`);
  await sleep(500);
  const empty = { count: await count(bar), highlighted: await highlighted(w, rect) };
  out('find-none', { none, empty });
  expect(none === 'No matches', 'a text not in the page: "No matches"', none);
  expect(empty.count === '' && empty.highlighted === 0, 'an emptied box shows no count and no highlights', empty);
  await page(w, `document.getElementById('__probeFind')?.remove(); document.getElementById('__probeComposer')?.remove(); 1`);

  const shot = process.env.PROBE_SHOT;
  if (shot) {
    await bar.webContents.insertText(process.env.PROBE_FIND_TEXT ?? 'Ledung');
    await sleep(1000);
    await pressIn(bar.webContents, 'Enter');
    await sleep(500);
    fs.writeFileSync(shot, (await windowShot(w, bar)).toPNG());
    out('find-shot', { file: shot, count: await count(bar) });
  }
}

/**
 * The right-click menu (#447): the probe right-clicks a picture, a broken picture, a link, selected text, a text box and
 * a plain spot it put in Ledung's page, reads the menu the app built, and clicks its items itself: the menu is recorded
 * instead of shown, since a shown one waits for a person. Copy Image puts the picture on the clipboard, Save Image As…
 * saves its bytes, Copy Link Address and Copy the text, Select All and Paste act in the box; the broken picture and
 * the plain spot get no menu. With PROBE_SHOT set, ends by showing the real menu over the picture and saving the
 * screen with `screencapture` (a native menu is not in the window's own capture).
 */
async function contextPhase(w: BrowserWindow): Promise<void> {
  const realPopup = Menu.prototype.popup;
  const popped: Menu[] = [];
  const shown = { real: false };
  Menu.prototype.popup = function popup(this: Menu, options?: Electron.PopupOptions) {
    popped.push(this);
    if (shown.real) realPopup.call(this, options);
  };
  // Put back however the phase ends, a check that throws too (self-check of #447, finding 1).
  try {
    await contextChecks(w, popped, shown);
  } finally {
    Menu.prototype.popup = realPopup;
  }
}

/** The picture on the clipboard: Electron 45's clipboard is the W3C one, where it is an image/png entry. */
async function clipboardPicture(): Promise<NativeImage> {
  for (const item of await clipboard.read()) {
    if (!item.types.includes('image/png')) continue;
    const blob = await item.getType('image/png') as Blob;
    return nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
  }
  return nativeImage.createEmpty();
}

/**
 * A right-click at a point in the window's page (CSS pixels): by Electron's input call, or with `native` by the
 * system's own mouse (Windows: user32; macOS: rclick.swift, run with swift). Electron's input call goes to the top
 * page's own process only: a frame of another site, which runs in its own process (as another computer's tab does),
 * never sees it (#451, the "framed" phase), so a click there needs `native`.
 */
function rightClickAt(w: BrowserWindow, x: number, y: number, native: boolean): void {
  const wc = w.webContents;
  const zoom = wc.getZoomFactor();
  if (!native) {
    const at = { x: Math.round(x * zoom), y: Math.round(y * zoom) };
    wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'right', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'right', clickCount: 1 });
    return;
  }
  const b = w.getContentBounds();
  const dip = { x: Math.round(b.x + x * zoom), y: Math.round(b.y + y * zoom) };
  if (process.platform === 'win32') {
    // Physical pixels of the window's own display, with the helper's thread per-monitor DPI aware (-4; the thread's
    // setting holds whatever PowerShell's own manifest says), so a scaled or second display puts the pointer on the
    // picture. Hidden, or its console window could take the click.
    const p = screen.dipToScreenPoint(dip);
    execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -Name M -Namespace P -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr SetThreadDpiAwarenessContext(System.IntPtr v); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e);'; [P.M]::SetThreadDpiAwarenessContext([System.IntPtr](-4)) | Out-Null; [P.M]::SetCursorPos(${p.x}, ${p.y}) | Out-Null; Start-Sleep -Milliseconds 100; [P.M]::mouse_event(8, 0, 0, 0, [System.UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [P.M]::mouse_event(16, 0, 0, 0, [System.UIntPtr]::Zero)`], { windowsHide: true });
  } else {
    execFileSync('swift', [path.join(here, 'rclick.swift'), String(process.pid), String(dip.x), String(dip.y)]);
  }
}

/**
 * #451: a picture in a frame of another site, as another computer's tab shows that computer's page (`https://<its
 * public name>`, a frame in a process of its own). A small picture page on localhost (another site than 127.0.0.1) is
 * framed over Ledung's page, the page's frame rule widened for it in the probe only, and its picture right-clicked:
 * Electron reports a picture, the menu has Copy Image and Save Image As… and opens, and Copy Image copies. Needs
 * PROBE_CLICK=native (Electron's input call never reaches such a frame: the frame then sees no mouse event, printed as
 * frameEvents); PROBE_FRAME_SAME=1 frames the picture from the page's own site instead, the control.
 */
async function framedPhase(w: BrowserWindow): Promise<void> {
  // A picture page on another site (localhost, not 127.0.0.1), as another computer's tab shows its page in a frame.
  const png = fs.readFileSync(path.join(clone, 'web', 'public', 'icon-512.png'));
  const server = http.createServer((req, res) => {
    if (req.url === '/p.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(png);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><body style="margin:0;background:#222"><img id="pic" src="/p.png" width="240" height="240" style="margin:20px"></body>');
  });
  await new Promise<void>((r) => server.listen(0, 'localhost', () => r()));
  const framePort = (server.address() as { port: number }).port;
  const frameOrigin = `http://localhost:${framePort}`;
  const wc = w.webContents;
  // The page lets only the config's computers be framed; this one is let in as one of them would be. Widened in the
  // page's own frame-src when it has one (a config with computers): a second frame-src would be ignored (code review
  // of PR #452, Minor 1).
  const widen = (csp: string) => (/(^|;)\s*frame-src\s/.test(csp)
    ? csp.replace(/((?:^|;)\s*frame-src)\s/, `$1 ${frameOrigin} `)
    : `${csp}; frame-src 'self' ${frameOrigin}`);
  wc.session.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'content-security-policy') headers[k] = headers[k]!.map(widen);
    }
    callback({ responseHeaders: headers });
  });
  wc.reload();
  await sleep(4000);
  const realPopup = Menu.prototype.popup;
  const popped: { menu: Menu; shown: boolean }[] = [];
  Menu.prototype.popup = function popup(this: Menu, options?: Electron.PopupOptions) {
    const entry = { menu: this, shown: false };
    popped.push(entry);
    this.once('menu-will-show', () => {
      entry.shown = true;
    });
    realPopup.call(this, options);
  };
  const reported: Electron.ContextMenuParams[] = [];
  const listen = (_e: Electron.Event, p: Electron.ContextMenuParams) => reported.push(p);
  wc.on('context-menu', listen);
  const native = process.env.PROBE_CLICK === 'native';
  w.show();
  w.focus();
  if (native) w.setAlwaysOnTop(true);
  w.moveTop();
  if (process.platform === 'darwin') app.focus({ steal: true });
  try {
    // PROBE_FRAME_SAME=1: a frame of the page's own site (same process), the control for how input reaches a frame.
    const same = !!process.env.PROBE_FRAME_SAME;
    await page(w, `(() => { const f = document.createElement('iframe'); f.id = '__pFrame';
      ${same ? `f.srcdoc = '<body style="margin:0;background:#222"><img id="pic" src="/icon-512.png" width="240" height="240" style="margin:20px"></body>';` : `f.src = ${JSON.stringify(frameOrigin + '/')};`}
      f.style.cssText = 'position:fixed;left:300px;top:150px;width:320px;height:320px;z-index:99999;border:0'; document.body.append(f); return 1; })()`);
    await sleep(2500);
    const frames = wc.mainFrame.framesInSubtree.map((f) => ({ url: f.url, pid: f.osProcessId, top: f.parent === null }));
    const child = wc.mainFrame.framesInSubtree.find((f) => f.parent !== null);
    await child?.executeJavaScript(`window.__ev = []; for (const t of ['mousedown', 'contextmenu']) addEventListener(t, (e) => __ev.push(t + ':' + e.target.tagName), true); 1`);
    const onTop = await page(w, `(() => { const e = document.elementFromPoint(440, 290); return e ? e.tagName + '#' + e.id : null; })()`);
    // The frame came up with its picture before anything is clicked: a frame that never loaded would fail the checks
    // below for the probe's own reason, not the app's (test review of PR #452, Minor 1).
    const loaded = await child?.executeJavaScript(`(() => { const i = document.getElementById('pic'); return !!i && i.complete && i.naturalWidth > 0; })()`).catch(() => false);
    const top = wc.mainFrame;
    out('framed-frames', { frames, same, onTop, loaded });
    expect(!!child && child.url === (same ? 'about:srcdoc' : `${frameOrigin}/`), 'the frame loaded its page', child?.url ?? 'no frame');
    expect(same || (!!child && child.osProcessId !== top.osProcessId), 'the frame of another site runs in a process of its own', frames);
    expect(loaded === true, 'the frame\'s picture loaded', loaded);
    expect(onTop === 'IFRAME#__pFrame', 'the frame is what lies under the click', onTop);
    if (!child || loaded !== true) return;
    const zoom = wc.getZoomFactor();
    // The picture's middle: the frame at (300, 150), the picture 20 px in, 240 px wide.
    const at = { x: Math.round((300 + 20 + 120) * zoom), y: Math.round((150 + 20 + 120) * zoom) };
    /** The picture on the clipboard after `ms` at most, as its size; null for none. */
    const clipboardSize = async (ms = 4000) => {
      let copied = await clipboardPicture();
      for (const end = Date.now() + ms; copied.isEmpty() && Date.now() < end;) {
        await sleep(200);
        copied = await clipboardPicture();
      }
      return copied.isEmpty() ? null : copied.getSize();
    };
    // The click and its menu: Electron's input call reaches only a frame of the page's own site, so the cross-site
    // frame's click is checked with the system's mouse only.
    if (native || same) {
      rightClickAt(w, at.x / zoom, at.y / zoom, native);
      for (let i = 0; i < 60 && !popped.at(-1)?.shown; i++) await sleep(50);
      const p = reported[0];
      const last = popped.at(-1);
      const labels = last ? last.menu.items.map((i) => (i.type === 'separator' ? '-' : i.label)) : null;
      out('framed-picture', { frameEvents: await child.executeJavaScript('window.__ev'), reported: p ? { mediaType: p.mediaType, hasImageContents: p.hasImageContents, srcURL: p.srcURL, frame: p.frame?.url ?? null } : null, menu: labels, shown: last?.shown ?? false });
      expect(p?.mediaType === 'image', 'Electron reports the framed picture as a picture', p?.mediaType ?? 'no context-menu event');
      expect(JSON.stringify(labels) === JSON.stringify(['Copy Image', 'Save Image As…']), 'the framed picture gets Copy Image and Save Image As…', labels);
      expect(last?.shown === true, 'the menu opened over the framed picture', last?.shown);
      if (last) {
        last.menu.closePopup(w);
        await sleep(300);
        clipboard.clear();
        last.menu.items.find((i) => i.label === 'Copy Image')?.click();
        const size = await clipboardSize();
        out('framed-copied', { size });
        expect(size !== null && size.width === 512, 'Copy Image copied the framed picture at its own size', size);
      }
    } else {
      out('framed-picture', { skipped: 'Electron\'s input call never reaches a frame of another site: PROBE_CLICK=native checks the click' });
    }
    // Copy Image itself, called as the menu calls it for this picture, with any click: the app's own function (#451).
    expect(appCopyImage !== null, 'the app has its Copy Image for the probe (a package from before #451 has none)');
    if (appCopyImage) {
      const srcURL = same ? `${origin}/icon-512.png` : `${frameOrigin}/p.png`;
      clipboard.clear();
      await appCopyImage(wc, { x: at.x, y: at.y, srcURL, frame: child });
      const size = await clipboardSize();
      out('framed-copy-direct', { size });
      expect(size !== null && size.width === 512 && size.height === 512, 'the app\'s Copy Image copies the framed picture at its own size', size);
    }
    // Why the app asks the frame: the top page's copy, all Electron offers, copies nothing from a frame of another
    // site (tubal-cain's run on PR #452). Its positive branch is the same call on the same-site control.
    clipboard.clear();
    wc.copyImageAt(at.x, at.y);
    const topCopy = await clipboardSize(same ? 4000 : 2000);
    out('framed-copy-top-page', { size: topCopy, same });
    if (same) expect(topCopy !== null && topCopy.width === 512, 'the top page\'s copy copies a picture in a frame of its own site', topCopy);
    else expect(topCopy === null, 'the top page\'s copy copies nothing from a frame of another site', topCopy);
  } finally {
    Menu.prototype.popup = realPopup;
    wc.off('context-menu', listen);
    wc.session.webRequest.onHeadersReceived(null);
    if (native) w.setAlwaysOnTop(false);
    server.close();
  }
}

/**
 * #451: right-clicks the real page's pictures, as Martin did, not a picture the probe put in. Sets them up itself in the
 * project PROBE_PROJECT names (its sessions on Haiku): two pictures in its folder, a session sent a picture, which is
 * then asked to raise a question with both as screenshots. Then each of Ledung's own pictures (<img> from /api/) on the
 * session's conversation (the sent one and the question's two thumbnails) and on Waiting for you (the big screenshot
 * and the strip's two) gets Copy Image and Save Image As…, and the menu really opens; Copy Image on the first puts it
 * on the clipboard. A picture inside a closed block is skipped; one with something else on top fails, naming it (an
 * overlay is one of the issue's suspects). PROBE_CLICK=native clicks with the system's mouse (Windows: user32; macOS:
 * desktop/probe/rclick.swift, run with swift; the screen must be unlocked), not Electron's input call; PROBE_SHOT_DIR
 * saves the window per route. Prints what Electron reported for each picture.
 */
async function picturesPhase(w: BrowserWindow): Promise<void> {
  const project = process.env.PROBE_PROJECT;
  if (!project) {
    expect(false, 'PROBE_PROJECT names a local project in the throwaway config');
    return;
  }
  const wc = w.webContents;
  const native = process.env.PROBE_CLICK === 'native';
  if (native && process.platform === 'linux') {
    expect(false, 'PROBE_CLICK=native runs on Windows and macOS only');
    return;
  }
  const state = await api(w, 'state');
  const entry = ((state.body?.projects ?? []) as { name: string; path?: string; model?: string }[]).find((p) => p.name === project);
  if (!entry?.path) {
    expect(false, 'the project is in the throwaway Ledung, with a folder', project);
    return;
  }
  // Test sessions run on Haiku (repo CLAUDE.md).
  if (!/haiku/i.test(entry.model ?? '')) {
    expect(false, 'the project\'s sessions run on Haiku ("model": "haiku" in the throwaway config)', entry.model ?? 'none');
    return;
  }
  fs.copyFileSync(path.join(clone, 'web', 'public', 'icon-512.png'), path.join(entry.path, 'probe-shot.png'));
  fs.copyFileSync(path.join(clone, 'web', 'public', 'icon-256.png'), path.join(entry.path, 'probe-small.png'));
  // Each step's answer is checked: a session that did not start says why now, not as a question that never came.
  const setup = await page(w, `(async () => {
    const send = async (route, body, type) => { const r = await fetch('/api/' + route, { method: 'POST', headers: { 'Content-Type': type ?? 'application/json' }, body: type ? body : JSON.stringify(body) });
      const answer = await r.json().catch(() => ({})); if (!r.ok) throw new Error(route + ': ' + r.status + ' ' + (answer.error ?? '')); return answer; };
    try {
      const s = await send('sessions', { project: ${JSON.stringify(project)}, role: 'session' });
      if (!s.id) return { error: 'no session id' };
      const picture = await (await fetch('/icon-512.png')).blob();
      const sent = await send('sessions/' + s.id + '/images', picture, 'image/png');
      if (!sent.id) return { error: 'no picture id' };
      await send('sessions/' + s.id + '/messages', { images: [sent.id], text: "Call the ask_user tool once, loading it with ToolSearch if you need to: question 'Do these look right?', tier the lowest one its description lists, screenshots [{file: 'probe-shot.png', look_for: 'the picture'}, {file: 'probe-small.png', look_for: 'the icon'}]. Nothing else, no other tools." });
      return { id: s.id };
    } catch (e) {
      return { error: e.message };
    }
  })()`) as { id?: string; error?: string };
  out('pictures-session', setup);
  if (!setup.id) {
    expect(false, 'the probe started a session and sent it a picture', setup.error);
    return;
  }
  const session = setup.id;
  let question: number | null = null;
  const seconds = Number(process.env.PROBE_QUESTION_SECONDS ?? 120);
  for (let i = 0; i < seconds && question === null; i++) {
    await sleep(1000);
    const qs = ((await api(w, 'state')).body?.questions ?? []) as { id: number; sessionId: string; status: string; shots?: unknown[] }[];
    question = qs.find((q) => q.sessionId === session && q.status === 'open' && (q.shots?.length ?? 0) > 0)?.id ?? null;
  }
  expect(question !== null, `the session asked its question with screenshots within ${seconds} s`, session);
  if (question === null) return;

  const realPopup = Menu.prototype.popup;
  /**
   * Each menu the app asked to open, with how long after its popup() the system showed it and closed it (ms). The
   * probe closes a menu only once it has shown, and waits for that before the next click: closing it a fixed 500 ms
   * after popup() cancelled one Windows had not shown yet (tubal-cain's run on #451, try 1, "shown":false).
   */
  type Popped = { menu: Menu; shown: boolean; showMs: number | null; closeMs: number | null };
  const popped: Popped[] = [];
  Menu.prototype.popup = function popup(this: Menu, options?: Electron.PopupOptions) {
    const calledAt = Date.now();
    const entry: Popped = { menu: this, shown: false, showMs: null, closeMs: null };
    popped.push(entry);
    this.once('menu-will-show', () => {
      entry.shown = true;
      entry.showMs = Date.now() - calledAt;
    });
    this.once('menu-will-close', () => {
      entry.closeMs = Date.now() - calledAt;
    });
    realPopup.call(this, options);
  };
  const MENU_WAIT_MS = Number(process.env.PROBE_MENU_WAIT_MS ?? 3000);
  /** Waits until `done` holds or `ms` passed; true when it held. */
  const until = async (done: () => boolean, ms: number) => {
    for (const end = Date.now() + ms; !done() && Date.now() < end;) await sleep(25);
    return done();
  };
  const reported: Electron.ContextMenuParams[] = [];
  const listen = (_e: Electron.Event, p: Electron.ContextMenuParams) => reported.push(p);
  wc.on('context-menu', listen);
  w.show();
  w.focus();
  // A system click lands on whatever window is in front: Windows keeps the terminal the probe started from in front
  // despite focus(), so the window stays on top while it clicks.
  if (native) w.setAlwaysOnTop(true);
  w.moveTop();
  if (process.platform === 'darwin') app.focus({ steal: true });
  const rightClick = (x: number, y: number) => rightClickAt(w, x, y, native);
  let copiedOne = false;
  /** Ledung's pictures each route should have in sight: the sent one and two thumbnails; the screenshot and two. */
  const routes = [{ route: `#/s/${session}`, want: 3 }, { route: `#/waiting/q/${question}`, want: 3 }];
  try {
    for (const { route, want } of routes) {
      await page(w, `location.hash = ${JSON.stringify(route)}; 1`);
      await sleep(3000);
      const count = await page(w, `document.querySelectorAll('img').length`) as number;
      let checked = 0;
      for (let n = 0; n < count; n++) {
        // Scrolled into sight. Only Ledung's own pictures count; one in a closed block can't be clicked by anyone.
        const img = await page(w, `(() => { const i = document.querySelectorAll('img')[${n}]; if (!i || !new URL(i.src).pathname.startsWith('/api/')) return null;
          const src = i.src.replace(location.origin, '').slice(0, 70);
          if (i.closest('details:not([open])')) return { src, hidden: 'in a closed block' };
          i.scrollIntoView({ block: 'center' });
          const r = i.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
          if (r.width === 0) return { src, hidden: 'no size (not loaded or not shown)' };
          const top = document.elementFromPoint(x, y);
          return { x, y, src, natural: [i.naturalWidth, i.naturalHeight], onTop: top === i ? null : top ? top.tagName.toLowerCase() + (top.className ? '.' + String(top.className).split(' ').join('.') : '') : 'nothing' }; })()`) as { x: number; y: number; src: string; hidden?: string; natural: [number, number]; onTop: string | null } | null;
        if (!img) continue;
        if (img.hidden) {
          out('picture', { route, src: img.src, skipped: img.hidden });
          continue;
        }
        checked++;
        expect(img.onTop === null, `nothing lies over the picture on ${route} (${img.src})`, img.onTop);
        reported.length = 0;
        popped.length = 0;
        rightClick(img.x, img.y);
        // The menu shows when the system shows it: up to MENU_WAIT_MS, then closed, and gone before the next click.
        await until(() => popped.length > 0 && (popped.at(-1)!.shown || popped.at(-1)!.closeMs !== null), MENU_WAIT_MS);
        const p = reported[0];
        const last = popped.at(-1);
        if (last?.shown) {
          last.menu.closePopup(w);
          await until(() => last.closeMs !== null, 2000);
        }
        const labels = last ? last.menu.items.map((i) => (i.type === 'separator' ? '-' : i.label)) : null;
        out('picture', { route, src: img.src, onTop: img.onTop, reported: p ? { mediaType: p.mediaType, hasImageContents: p.hasImageContents, srcURL: p.srcURL.replace(origin, '').slice(0, 70), linkURL: p.linkURL } : null, menu: labels, shown: last?.shown ?? false, showMs: last?.showMs ?? null, closeMs: last?.closeMs ?? null });
        expect(p?.mediaType === 'image', `Electron reports a picture on ${route} (${img.src})`, p?.mediaType ?? 'no context-menu event');
        expect(JSON.stringify(labels) === JSON.stringify(['Copy Image', 'Save Image As…']), `the picture gets Copy Image and Save Image As… on ${route}`, labels);
        expect(last?.shown === true, `the menu opened on ${route} within ${MENU_WAIT_MS} ms`, last ? { showMs: last.showMs, closeMs: last.closeMs } : null);
        if (!copiedOne && last) {
          copiedOne = true;
          clipboard.clear();
          last.menu.items.find((i) => i.label === 'Copy Image')?.click();
          let copied = await clipboardPicture();
          for (let i = 0; i < 20 && copied.isEmpty(); i++) {
            await sleep(200);
            copied = await clipboardPicture();
          }
          const size = copied.isEmpty() ? null : copied.getSize();
          out('picture-copied', { size, natural: img.natural });
          expect(size !== null && size.width === img.natural[0] && size.height === img.natural[1], 'Copy Image put the picture, at its own size, on the clipboard', size);
        }
      }
      out('pictures-checked', { route, checked, want });
      expect(checked === want, `${want} of Ledung's pictures in sight on ${route}`, checked);
      if (process.env.PROBE_SHOT_DIR) {
        const file = path.join(process.env.PROBE_SHOT_DIR, `pictures-${route.startsWith('#/s/') ? 'conversation' : 'waiting'}.png`);
        fs.writeFileSync(file, (await wc.capturePage()).toPNG());
        out('pictures-shot', { file });
      }
    }
  } finally {
    Menu.prototype.popup = realPopup;
    wc.off('context-menu', listen);
    if (native) w.setAlwaysOnTop(false);
  }
}


/** contextPhase's checks: `popped` collects the menus the app built, `shown.real` shows them for the screenshot. */
async function contextChecks(w: BrowserWindow, popped: Menu[], shown: { real: boolean }): Promise<void> {
  const wc = w.webContents;
  w.show();
  w.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
  await sleep(800);
  await page(w, `(() => {
    const box = document.createElement('div');
    box.id = '__probeContext';
    box.style.cssText = 'position:fixed;left:60px;top:140px;z-index:99999;display:flex;gap:24px;align-items:flex-start;padding:16px;background:#1b1d22';
    box.innerHTML = '<img id="__pImg" src="/icon-512.png" width="240" height="240" alt="">'
      + '<img id="__pBroken" src="/no-such-picture-447.png" width="60" height="60" alt="">'
      + '<div style="display:flex;flex-direction:column;gap:12px;color:#ddd"><a id="__pLink" href="https://example.com/447" style="font-size:20px">a link</a>'
      + '<p id="__pText" style="font-size:20px">zebraquokka words</p><textarea id="__pBox" style="font-size:20px">hello box</textarea>'
      + '<div id="__pPlain" style="width:120px;height:60px"></div></div>';
    document.body.append(box);
    return 1;
  })()`);
  const natural = await page(w, `new Promise((r) => { const i = document.getElementById('__pImg'); const done = () => r([i.naturalWidth, i.naturalHeight]);
    if (i.complete) done(); else { i.onload = done; i.onerror = done; } })`) as [number, number];
  await sleep(300);
  const zoom = wc.getZoomFactor();
  /** The middle of an element (or a point `dx` in from its left), in the window's own units. */
  const at = async (id: string, dx?: number) => {
    const r = await page(w, `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`) as number[];
    return { x: Math.round(((dx === undefined ? r[0]! + r[2]! / 2 : r[0]! + dx)) * zoom), y: Math.round((r[1]! + r[3]! / 2) * zoom) };
  };
  /** Right-clicks the element; the menu the app built for it, as its labels ("-" a separator), or null for none. */
  const rightClick = async (id: string, dx?: number): Promise<{ labels: string[] | null; menu: Menu | undefined }> => {
    const p = await at(id, dx);
    popped.length = 0;
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'right', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'right', clickCount: 1 });
    await sleep(700);
    const menu = popped.at(-1);
    return { labels: menu ? menu.items.map((i) => (i.type === 'separator' ? '-' : i.label)) : null, menu };
  };
  const press = (menu: Menu | undefined, label: string) => menu?.items.find((i) => i.label === label)?.click();

  // A picture: Copy Image and Save Image As….
  const image = await rightClick('__pImg');
  clipboard.clear();
  press(image.menu, 'Copy Image');
  // Electron 45's clipboard is the W3C one: the picture is an image/png entry.
  const clipboardImage = async (): Promise<NativeImage> => {
    for (const item of await clipboard.read()) {
      if (!item.types.includes('image/png')) continue;
      const blob = await item.getType('image/png') as Blob;
      return nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
    }
    return nativeImage.createEmpty();
  };
  let copied = await clipboardImage();
  for (let i = 0; i < 20 && copied.isEmpty(); i++) {
    await sleep(200);
    copied = await clipboardImage();
  }
  const saveTo = path.join(dataDir(), 'context-probe-saved.png');
  fs.rmSync(saveTo, { force: true });
  const saved = new Promise<string>((resolve) => {
    // The probe's own handler gives the save a path, so Electron asks no one; without one it asks where to save.
    wc.session.once('will-download', (_event, item) => {
      item.setSavePath(saveTo);
      item.once('done', (_e, state) => resolve(state));
    });
    setTimeout(() => resolve('timed out'), 10_000);
  });
  press(image.menu, 'Save Image As…');
  const saveState = await saved;
  const source = fs.readFileSync(path.join(clone, 'web', 'public', 'icon-512.png'));
  const savedBytes = fs.existsSync(saveTo) ? fs.readFileSync(saveTo) : Buffer.alloc(0);
  const imageReport = { labels: image.labels, natural, copied: copied.isEmpty() ? null : copied.getSize(), saveState, savedSame: savedBytes.equals(source), savedBytes: savedBytes.length };
  out('context-image', imageReport);
  expect(JSON.stringify(image.labels) === JSON.stringify(['Copy Image', 'Save Image As…']), 'a picture gets Copy Image and Save Image As…', image.labels);
  expect(!copied.isEmpty() && copied.getSize().width === natural[0] && copied.getSize().height === natural[1], 'Copy Image put the picture, at its own size, on the clipboard', imageReport.copied);
  expect(saveState === 'completed' && savedBytes.equals(source), 'Save Image As… saved the picture\'s own bytes', imageReport);

  // A picture that did not load, and a plain spot: no menu. The positive branch is the picture above.
  const broken = await rightClick('__pBroken');
  const plain = await rightClick('__pPlain');
  out('context-none', { broken: broken.labels, plain: plain.labels });
  expect(broken.labels === null, 'a broken picture gets no menu', broken.labels);
  expect(plain.labels === null, 'a plain spot gets no menu', plain.labels);

  // A link: Copy Link Address.
  const link = await rightClick('__pLink');
  clipboard.clear();
  press(link.menu, 'Copy Link Address');
  await sleep(300);
  const linkReport = { labels: link.labels, clipboard: await clipboard.readText(), browserOpened: [...external] };
  out('context-link', linkReport);
  expect(JSON.stringify(link.labels) === JSON.stringify(['Copy Link Address']), 'a link gets Copy Link Address', link.labels);
  expect(linkReport.clipboard === 'https://example.com/447', 'Copy Link Address copied the address', linkReport.clipboard);

  // Selected text: Copy.
  await page(w, `(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('__pText')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return 1; })()`);
  const text = await rightClick('__pText');
  clipboard.clear();
  press(text.menu, 'Copy');
  await sleep(300);
  const textReport = { labels: text.labels, clipboard: await clipboard.readText() };
  out('context-text', textReport);
  expect(JSON.stringify(text.labels) === JSON.stringify(['Copy']), 'selected text gets Copy', text.labels);
  expect(textReport.clipboard.trim() === 'zebraquokka words', 'Copy copied the selected text', textReport.clipboard);

  // A text box, nothing selected and text on the clipboard: Paste and Select All, and they act in the box.
  await page(w, `getSelection().removeAllRanges(); (() => { const t = document.getElementById('__pBox'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); return 1; })()`);
  await clipboard.writeText(' pasted');
  // Right of the text, so the click selects no word.
  const empty = await rightClick('__pBox', 200);
  press(empty.menu, 'Paste');
  await sleep(300);
  const afterPaste = await page(w, `document.getElementById('__pBox').value`);
  const box = await rightClick('__pBox', 200);
  press(box.menu, 'Select All');
  await sleep(300);
  const selected = await page(w, `(() => { const t = document.getElementById('__pBox'); return [t.selectionStart, t.selectionEnd, t.value.length]; })()`) as number[];
  // Everything selected now: Cut and Copy too.
  const full = await rightClick('__pBox', 20);
  const boxReport = { nothingSelected: empty.labels, afterPaste, selectAll: selected, allSelected: full.labels };
  out('context-box', boxReport);
  expect(JSON.stringify(empty.labels) === JSON.stringify(['Paste', '-', 'Select All']), 'a text box with nothing selected gets Paste and Select All', empty.labels);
  expect(afterPaste === 'hello box pasted', 'Paste pasted into the box', afterPaste);
  expect(selected[0] === 0 && selected[1] === selected[2], 'Select All selected the box\'s text', selected);
  expect(JSON.stringify(full.labels) === JSON.stringify(['Cut', 'Copy', 'Paste', '-', 'Select All']), 'with text selected the box gets Cut, Copy, Paste and Select All', full.labels);

  const shot = process.env.PROBE_SHOT;
  if (shot) {
    await page(w, `document.getElementById('__probeContext').style.background = 'transparent'; getSelection().removeAllRanges(); document.activeElement?.blur(); 1`);
    shown.real = true;
    await rightClick('__pImg', 60);
    await sleep(1200);
    let captured = false;
    try {
      execFileSync('screencapture', ['-x', shot]);
      captured = fs.existsSync(shot);
    } catch (e) {
      out('context-shot-error', { message: (e as Error).message });
    }
    popped.at(-1)?.closePopup();
    out('context-shot', { file: shot, captured });
  }
  await page(w, `document.getElementById('__probeContext')?.remove(); 1`);
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

/** The page asks the app to show its window, as a click on its notification does (#360); the window's state after. */
async function askToShow(w: BrowserWindow): Promise<{ hiddenBefore: boolean; visible: boolean; focused: boolean }> {
  w.hide();
  await sleep(500);
  const hiddenBefore = !w.isVisible();
  await page(w, `window.ledungDesktop?.showWindow(); 1`);
  await sleep(800);
  return { hiddenBefore, visible: w.isVisible(), focused: w.isFocused() };
}

/**
 * The preload gives the page two functions and nothing of Node (#360, #414), and showWindow shows the hidden window
 * (newWindow is the "windows" phase's). Leaves the window shown.
 */
async function bridge(w: BrowserWindow): Promise<void> {
  const exposed = await page(w, `({ keys: Object.keys(window.ledungDesktop ?? {}), type: typeof window.ledungDesktop?.showWindow,
    newWindow: typeof window.ledungDesktop?.newWindow,
    require: typeof require, process: typeof process, ipcRenderer: typeof ipcRenderer, electron: typeof electron })`);
  out('bridge', exposed);
  expect(JSON.stringify(exposed.keys) === '["showWindow","newWindow"]' && exposed.type === 'function' && exposed.newWindow === 'function',
    'the page has the two functions, showWindow and newWindow', exposed);
  expect(['require', 'process', 'ipcRenderer', 'electron'].every((k) => exposed[k] === 'undefined'), 'the page has no Node and no ipcRenderer', exposed);
  const shown = await askToShow(w);
  out('bridge-show', shown);
  expect(shown.hiddenBefore && shown.visible, "Ledung's page showed the hidden window", shown);
  // Focus needs a screen: on a Mac reached only by Screen Sharing it can stay false, so it is reported, not judged.
  if (!shown.focused) out('bridge-focus', { focused: false, note: 'the window did not take focus on this computer' });
  w.show();
}

/**
 * The notification click (#360): the page's notifications on, the window hidden on another view, a session asking for
 * permission (the shell starts it) makes the page raise one, and its click shows the window on that session. The
 * probe records the page's notifications as they are made and clicks the one that came, as the system would.
 */
async function notifyPhase(w: BrowserWindow): Promise<void> {
  // Turned on as the page's Settings switch does, with the permission the app grants.
  await page(w, `localStorage.setItem('ledung.notify', '1'); 1`);
  w.webContents.reload();
  await sleep(1000);
  await showing(`${origin}/`);
  await sleep(2000);
  await page(w, `(() => {
    const Real = window.Notification;
    window.__probeNotes = [];
    window.Notification = class extends Real {
      constructor(title, options) { super(title, options); window.__probeNotes.push(this); }
    };
    location.hash = '#/overview';
    return 1;
  })()`);
  w.hide();
  await sleep(500);
  const hiddenBefore = !w.isVisible();
  out('notify-waiting', { hiddenBefore, hash: await page(w, 'location.hash') });
  const seconds = Number(process.env.PROBE_NOTIFY_SECONDS ?? 180);
  let note: { title: string; tag: string } | null = null;
  for (let i = 0; i < seconds * 2 && !note; i++) {
    await sleep(500);
    note = await page(w, `(() => { const n = window.__probeNotes.find((n) => n.tag.startsWith('p')); return n ? { title: n.title, tag: n.tag } : null; })()`);
  }
  out('notified', { note, visible: w.isVisible() });
  expect(note !== null, `the page raised a permission notification with the window hidden, within ${seconds} s`);
  if (!note) return;
  const tag = note.tag;
  expect(!w.isVisible(), 'the window was still hidden when it came', w.isVisible());
  const permissions = ((await api(w, 'state')).body?.permissions ?? []) as { id: string; sessionId: string }[];
  const asked = permissions.find((p) => `p${p.id}` === tag)?.sessionId ?? null;
  // The click, as the system hands it to the page.
  await page(w, `window.__probeNotes.find((n) => n.tag === ${JSON.stringify(tag)}).dispatchEvent(new Event('click')); 1`);
  await sleep(1500);
  const after = { visible: w.isVisible(), focused: w.isFocused(), hash: await page(w, 'location.hash'), asked };
  out('notification-clicked', after);
  expect(asked !== null, "the notification's permission is one Ledung lists", tag);
  expect(hiddenBefore && after.visible, 'the click showed the hidden window', after);
  expect(asked !== null && after.hash === `#/s/${asked}`, 'the window shows the session that asked', after);
  if (!after.focused) out('notify-focus', { focused: false, note: 'the window did not take focus on this computer' });
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

  // Quit (⌘Q / Alt+F4): the window closes for real, the app ends, the Ledung it attached to still answers.
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

/** The app's windows still open, in the order they were made. */
const openNow = () => BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed()).sort((a, b) => a.id - b.id);

/** Waits until `count` windows are open and the newest has loaded Ledung's page; returns the newest. */
async function newest(count: number): Promise<BrowserWindow | null> {
  for (let i = 0; i < 75; i++) {
    const all = openNow();
    const last = all.at(-1);
    if (all.length === count && last && !last.webContents.isLoading() && last.webContents.getURL() === `${origin}/`) return last;
    await sleep(200);
  }
  return null;
}

/** A window's page: signed in (its data request answers), its own route, and whether the probe's mark is on it. */
async function pageState(w: BrowserWindow) {
  const state = await api(w, 'state');
  return { url: w.webContents.getURL(), signedIn: state.status === 200, mark: await page(w, `window.__probeMark ?? null`), sidebar: await page(w, `!!document.querySelector('aside')`) };
}

/** More windows (#414). Ends the app with its own Quit; the probe exits from will-quit. */
async function windowsPhase(first: BrowserWindow): Promise<void> {
  // The first window on a route of its own, with a mark only its page has.
  await page(first, `window.__probeMark = 'first'; history.pushState(null, '', '/#usage'); 1`);
  const firstUrl = first.webContents.getURL();

  // File → New Window, ⌘N on the Mac and Ctrl+N elsewhere.
  const item = menuItem('new-window');
  out('new-window-item', { label: item?.label ?? null, accelerator: item?.accelerator ?? null });
  expect(item?.label === 'New Window' && item.accelerator === 'CmdOrCtrl+N', 'File → New Window is on ⌘N / Ctrl+N', item?.accelerator);
  item?.click();
  const second = await newest(2);
  expect(second !== null, 'New Window opened a second window showing Ledung', openNow().map((x) => x.webContents.getURL()));
  if (!second) return;
  await sleep(1500);
  const states = { first: await pageState(first), second: await pageState(second), secondVisible: second.isVisible(), firstVisible: first.isVisible() };
  out('new-window', states);
  expect(states.second.signedIn && states.second.sidebar && states.second.url === `${origin}/`, 'the new window is signed in, at the start page', states.second);
  expect(states.second.mark === null, "the new window's page is its own, not the first one's", states.second);
  expect(states.first.url === firstUrl && states.first.mark === 'first' && states.firstVisible, 'the first window kept its route and page', states.first);
  expect(states.secondVisible, 'the new window shows');
  const devices = (await api(second, 'devices')).body?.devices?.length ?? null;

  // The page's New window button, clicked as a person would (a user gesture), in the second window.
  const clicked = await second.webContents.executeJavaScript(`(() => { const b = document.querySelector('button.new-window'); if (!b) return null; b.click(); return b.title; })()`, true);
  const third = await newest(3);
  out('new-window-button', { title: clicked, windows: openNow().length, browserOpened: [...external] });
  expect(clicked === (process.platform === 'darwin' ? 'New window (⌘N)' : 'New window (Ctrl+N)'), "the footer's button is there, its tooltip naming the key", clicked);
  expect(third !== null && external.length === 0, 'the button opened a third app window, nothing in the browser', openNow().length);
  if (!third) return;
  await sleep(1500);
  const devicesAfter = (await api(third, 'devices')).body?.devices?.length ?? null;
  out('devices', { afterSecond: devices, afterThird: devicesAfter });
  expect(devices !== null && devices === devicesAfter, 'another window adds no device: the windows share one sign-in', { devices, devicesAfter });

  // The "not running" page has the same preload, and may not ask: only Ledung's own page can (#360's check).
  await third.loadFile(path.join(here, '..', 'not-running.html'), { query: { reason: 'probe', state: 'stopped' } });
  await page(third, `window.ledungDesktop?.newWindow(); 1`);
  await sleep(1500);
  out('not-running-asks', { windows: openNow().length });
  expect(openNow().length === 3, 'the "not running" page could not open a window', openNow().length);

  // Closing one of three closes it for real; the others stay, their pages answering.
  third.close();
  await sleep(1000);
  const afterClose = { thirdDestroyed: third.isDestroyed(), windows: openNow().length, first: (await windowState(first)).pageAnswers, second: (await windowState(second)).pageAnswers };
  out('close-one', afterClose);
  expect(afterClose.thirdDestroyed && afterClose.windows === 2 && afterClose.first && afterClose.second, 'closing one window closed it, and the other two stay', afterClose);

  // Close Window with no focused window while two are open (all minimised on the Mac): nothing closes (code review of
  // PR #416, Minor 2).
  menuItem('close-window')?.click();
  await sleep(800);
  const unfocused = { windows: openNow().length, firstVisible: first.isVisible(), secondVisible: second.isVisible() };
  out('close-window-unfocused', unfocused);
  expect(unfocused.windows === 2 && unfocused.firstVisible && unfocused.secondVisible, 'Close Window with no focused window closed and hid nothing', unfocused);

  // Close Window (⌘W / Ctrl+W) on the second: of two, it closes for real.
  menuItem('close-window')?.click(undefined, second);
  await sleep(1000);
  const afterKey = { secondDestroyed: second.isDestroyed(), windows: openNow().length, first: await windowState(first) };
  out('close-window-key', afterKey);
  expect(afterKey.secondDestroyed && afterKey.windows === 1 && afterKey.first.visible, 'Close Window closed the second, and the first stays', afterKey);

  // The last window closed only hides, as before (#359): the app and its page stay.
  first.close();
  await sleep(800);
  const last = await windowState(first);
  out('close-last', last);
  expect(!last.visible && !last.destroyed && last.windows === 1 && last.pageAnswers && last.url === firstUrl, 'closing the last window hid it, its page still there', last);

  // Two again, the newest used last: the Dock and a second start bring that one forward.
  menuItem('new-window')?.click();
  const fourth = await newest(2);
  expect(fourth !== null, 'New Window opened a window with the first hidden');
  if (!fourth) return;
  fourth.hide();
  await sleep(500);
  app.emit('activate', {}, false);
  await sleep(800);
  const activated = { fourth: fourth.isVisible(), first: first.isVisible() };
  out('activate', activated);
  expect(activated.fourth && !activated.first, 'the Dock click showed the most recently used window', activated);
  fourth.hide();
  await sleep(500);
  const child = spawn(process.execPath, [here], { env: { ...process.env, PROBE_PHASE: 'child' }, stdio: 'ignore' });
  const exit = await Promise.race([new Promise<number | null>((r) => child.once('exit', (code) => r(code))), sleep(20_000).then(() => 'still running' as const)]);
  if (exit === 'still running') child.kill('SIGKILL');
  await sleep(800);
  const again = { exit, fourth: fourth.isVisible(), first: first.isVisible(), windows: openNow().length };
  out('second-start', again);
  expect(exit === 0 && again.fourth && !again.first && again.windows === 2, 'a second start showed the most recently used window, and opened no app', again);

  // Quit closes every window and ends the app; the Ledung still answers.
  const t = token();
  quitExpected = true;
  app.once('will-quit', (event) => {
    event.preventDefault();
    void (async () => {
      const after = { windows: BrowserWindow.getAllWindows().length, ledungAnswers: t !== null && port !== undefined && (await answersSignIn(port, t)) };
      out('quit', after);
      expect(after.windows === 0, 'Quit closed every window', after.windows);
      expect(after.ledungAnswers, 'the Ledung still answers on its port after Quit');
      out('done', { passed: !failed });
      app.exit(failed ? 1 : 0);
    })();
  });
  menuItem('quit')?.click();
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

/** Presses the application menu's Quit, as ⌘Q or Alt+F4 does, and waits for the app to begin quitting (no dialog in the way). */
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

/** The `frames` phase's linked computer (#468): its public name, which the config lists and Chromium maps to loopback. */
const FRAME_HOST = 'other.example.test';
const FRAME_COOKIE = '__Host-probe_device=paired';
/** What the stand-in was asked, in order: each path and whether the request carried the cookie its form set. */
const frameHostSeen: { path: string; cookie: boolean }[] = [];

/**
 * The stand-in for a linked computer: HTTPS on a loopback port, with a throwaway certificate for FRAME_HOST, which
 * the app is started with leave to ignore. Its /form posts to /pair, which answers as Ledung's Pair form does: 303 to a
 * page of the same computer, with a Secure, Partitioned, SameSite=None cookie, as a frame gets (issue #241).
 */
async function startFrameHost(): Promise<number> {
  const dir = path.join(dataDir(), 'probe-frame-host');
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', `/CN=${FRAME_HOST}`, '-addext', `subjectAltName=DNS:${FRAME_HOST}`], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const where = (req.url ?? '/').replace(/\?.*/, '');
    frameHostSeen.push({ path: where, cookie: (req.headers.cookie ?? '').split(/;\s*/).includes(FRAME_COOKIE) });
    if (req.method === 'POST' && where === '/pair') {
      res.writeHead(303, { location: '/landed', 'set-cookie': `${FRAME_COOKIE}; Secure; HttpOnly; SameSite=None; Partitioned; Path=/` });
      res.end();
    } else if (where === '/bounce') {
      res.writeHead(303, { location: '/landed-top' });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(where === '/form' ? '<form method="post" action="/pair"><input name="code" value="probe"></form>' : `<p id="at">${where}</p>`);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as AddressInfo).port;
}

/** The first frame in the window at `route` on FRAME_HOST, waited for up to 10 s; null if none got there. */
async function frameAt(w: BrowserWindow, route: string) {
  for (let i = 0; i < 50; i++) {
    const frame = w.webContents.mainFrame.framesInSubtree.find((f) => f !== w.webContents.mainFrame && f.url === `https://${FRAME_HOST}${route}`);
    if (frame) return frame;
    await sleep(200);
  }
  return null;
}

/**
 * A linked computer's tab, paired in the app (#468, #466): the Pair form's answer is a redirect inside the frame, which
 * the app's navigation lock used to cancel; the window's own redirects away from Ledung stay refused.
 */
async function framesPhase(w: BrowserWindow): Promise<void> {
  await page(w, `(() => { const f = document.createElement('iframe'); f.src = 'https://${FRAME_HOST}/form'; document.body.append(f); return 1; })()`);
  const form = await frameAt(w, '/form');
  expect(form !== null, "the linked computer's page shows in a frame on Ledung's page", w.webContents.mainFrame.framesInSubtree.map((f) => f.url));
  if (!form) return;
  await form.executeJavaScript('document.forms[0].submit(); 1');
  const landed = await frameAt(w, '/landed');
  out('framed-pair', { landed: landed?.url ?? null, frames: w.webContents.mainFrame.framesInSubtree.map((f) => f.url), seen: [...frameHostSeen] });
  expect(landed !== null, "the form's 303 landed in the frame, on the page it names", frameHostSeen);
  expect(frameHostSeen.some((s) => s.path === '/landed' && s.cookie), 'the redirected request carried the cookie the answer set', frameHostSeen);
  if (landed) {
    // Kept, not only sent once: the frame reloaded still sends it.
    const before = frameHostSeen.length;
    await landed.executeJavaScript('location.reload(); 1');
    for (let i = 0; i < 50 && frameHostSeen.length === before; i++) await sleep(200);
    const again = frameHostSeen.slice(before);
    out('framed-reload', { seen: again });
    expect(again.some((s) => s.path === '/landed' && s.cookie), 'the frame kept its cookie: a reload sends it again', again);
  }
  // The window itself: a redirect away from Ledung's address is still cancelled. loadURL, so will-navigate (which
  // sends a link to the browser) is not what refuses it.
  let refusedTop = false;
  try {
    await w.webContents.loadURL(`https://${FRAME_HOST}/bounce`);
  } catch {
    refusedTop = true;
  }
  const top = { refused: refusedTop, url: w.webContents.getURL(), seen: frameHostSeen.filter((s) => s.path.endsWith('-top') || s.path === '/bounce') };
  out('window-redirect', top);
  expect(refusedTop && !frameHostSeen.some((s) => s.path === '/landed-top'), "the window's own redirect away from Ledung is still refused", top);
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
        await bridge(w);
        await menuZoomStep(w);
        if (process.platform !== 'darwin') await keys(w);
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
      // The "not running" page has the preload too, and its call is refused (#360) ...
      const refusedShow = await askToShow(w);
      out('not-running-show', refusedShow);
      expect(refusedShow.hiddenBefore && !refusedShow.visible, 'the "not running" page could not show the hidden window', refusedShow);
      w.show();
      core = startCore();
      await waitForCore();
      await retry(w);
      // ... and the same call from Ledung's page, in the same window, shows it: the probe sees a shown window.
      const ownShow = await askToShow(w);
      out('own-page-show', ownShow);
      expect(ownShow.hiddenBefore && ownShow.visible, "the same call from Ledung's page showed the window", ownShow);
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
    } else if (phase === 'windows') {
      const w = await showing(`${origin}/`);
      await signedIn(w);
      await windowsPhase(w);
    } else if (phase === 'find') {
      const w = await showing(`${origin}/`);
      await signedIn(w);
      await findPhase(w);
    } else if (phase === 'context') {
      const w = await showing(`${origin}/`);
      await signedIn(w);
      await contextPhase(w);
    } else if (phase === 'pictures') {
      const w = await showing(`${origin}/`);
      await signedIn(w);
      await picturesPhase(w);
    } else if (phase === 'framed') {
      const w = await showing(`${origin}/`);
      await signedIn(w);
      await framedPhase(w);
    } else if (phase === 'notify') {
      const w = await showing(`${origin}/`);
      await signedIn(w);
      await notifyPhase(w);
    } else if (phase === 'frames') {
      const w = await showing(`${origin}/`);
      await signedIn(w);
      await framesPhase(w);
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
  if (phase === 'frames') {
    // Before ready, so Chromium takes the switches: the linked computer's name goes to the stand-in, whose throwaway
    // certificate it accepts. Awaited here, before ready, since the switches need its port.
    const framePort = await startFrameHost();
    app.commandLine.appendSwitch('host-resolver-rules', `MAP ${FRAME_HOST} 127.0.0.1:${framePort}`);
    app.commandLine.appendSwitch('ignore-certificate-errors');
  }
  // Not awaited: Electron holds its ready event until a top-level await in the entry module settles.
  void import(process.env.PROBE_MAIN ? pathToFileURL(process.env.PROBE_MAIN).href : '../main.ts').then((m: { APP_ICON: string; copyImage?: typeof appCopyImage }) => {
    appIcon = m.APP_ICON;
    // A package built before #451's fix has none; "framed" then says so.
    appCopyImage = m.copyImage ?? null;
    return app.whenReady();
  }).then(run);
}
