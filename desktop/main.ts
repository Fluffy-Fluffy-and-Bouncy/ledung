// Ledung in a desktop window (issue #358, epic #357): one window showing this computer's running Ledung, signed in.
// With none running, the window says so and offers Start Ledung, which runs the installed `ledung` command (D5, #362,
// desktop/start.ts), and Retry.
//
// The page is Ledung's own page at http://127.0.0.1:<port>/, loaded like a browser loads it, so the core's Host
// check, sign-in cookie, Origin check and "no embedding" apply unchanged. Sign-in sets the cookie from this main
// process (Mac spike 2026-11-17: GET /api/state 200 with no token in any URL); the token never goes into a URL or a
// command line.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, type MenuItemConstructorOptions, type NativeImage, type Session, type WebContents } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRunning } from './attach.ts';
import { dockIconLayout, padBitmap } from './dock-icon.ts';
import { zoomed, zoomKey } from './keys.ts';
import { runStart } from './start.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOT_RUNNING_PAGE = path.join(here, 'not-running.html');
/** The page's one bridge to the app (#360): showing the window when a notification is clicked. */
const PRELOAD = path.join(here, 'preload.cjs');
/** The message the preload sends for it (preload.cjs). */
export const SHOW_WINDOW_MESSAGE = 'ledung-desktop:show-window';
/**
 * Ledung's own icon (#384), the page's app icon from the clone's web/public: the app runs from a clone (README), so
 * it is there. A PNG, since Electron's images load no SVG. Exported for the probe, which checks it loads.
 */
export const APP_ICON = path.join(here, '..', 'web', 'public', 'icon-512.png');
/** The core's sign-in cookie (src/server/security.ts COOKIE_NAME). */
const COOKIE_NAME = 'ledung_auth';

/**
 * The Dock's icon (#404): APP_ICON with the transparent margin every Mac app icon has, so it is the size of the
 * others. The resize is Electron's own (best quality); the padding is dock-icon.ts. Exported for the probe.
 */
export function dockIcon(): NativeImage {
  const icon = nativeImage.createFromPath(APP_ICON);
  const canvas = icon.getSize().width;
  const { body } = dockIconLayout(canvas);
  const small = icon.resize({ width: body, height: body, quality: 'best' });
  return nativeImage.createFromBitmap(padBitmap(small.toBitmap(), body, canvas), { width: canvas, height: canvas });
}
/** One partition for the app's cookies, kept between starts, apart from Electron's default session. */
const PARTITION = 'persist:ledung';

let win: BrowserWindow | null = null;
/** Set once the app is really quitting (⌘Q, Alt+F4, logging off): from then on closing closes. */
let quitting = false;
/** Windows is logging off or shutting down: nothing may hold that up, not even unsaved changes. */
let sessionEnding = false;
/** The origin the window may show: the attached Ledung's, or none while the "not running" page is up. */
let ownOrigin: string | null = null;
let attaching = false;
/** A start (#362) is under way: the page says so, and neither Start nor Retry does anything until it ends. */
let starting = false;

/** An address the person's browser may open: plain web links only, never file:, javascript: or custom schemes. */
function webLink(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function sameOrigin(url: string): boolean {
  try {
    return ownOrigin !== null && new URL(url).origin === ownOrigin;
  } catch {
    return false;
  }
}

/**
 * The window shows Ledung's page and nothing else: a navigation away from its origin is refused, and so is every new
 * window. A web link elsewhere (a pull request in a chat) opens in the default browser instead.
 */
function lockNavigation(wc: WebContents): void {
  wc.on('will-navigate', (event, url) => {
    if (sameOrigin(url)) return;
    event.preventDefault();
    if (webLink(url)) void shell.openExternal(url);
  });
  wc.on('will-redirect', (event, url) => {
    if (!sameOrigin(url)) event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (webLink(url) && !sameOrigin(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // The "not running" page's Retry and Start Ledung are links to #retry and #start: in-page moves, so they need no
  // script bridge.
  wc.on('did-navigate-in-page', (_event, url) => {
    if (ownOrigin !== null || !url.startsWith('file:')) return;
    if (url.endsWith('#retry')) void attach();
    else if (url.endsWith('#start')) void start();
  });
  // Ledung's page failed to load after attaching (it stopped, or a reload found nothing): back to the page with Retry
  // instead of Chromium's error page, which has none (self-check finding 1g). -3 is a load the app itself replaced.
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && ownOrigin !== null && sameOrigin(url)) void showNotRunning(`Ledung's page did not load (${description}).`);
  });
}

/** The page with Start Ledung and Retry, saying why; `state` "starting" shows a start under way and no buttons. */
async function showNotRunning(reason: string, state: 'stopped' | 'starting' | 'failed' = 'stopped'): Promise<void> {
  ownOrigin = null;
  if (win && !win.isDestroyed()) await win.loadFile(NOT_RUNNING_PAGE, { query: { reason, state } });
}

/**
 * Signs the app's partition in to the Ledung on this port. A cookie the core gave before (a paired browser's) is kept
 * while it still signs in: the core turns the token cookie into a new paired browser on each page load, so setting
 * it at every start would add a device each time (src/server/security.ts, oldTokenCookie).
 */
async function signIn(ses: Session, origin: string, token: string): Promise<void> {
  const kept = await ses.cookies.get({ url: origin, name: COOKIE_NAME });
  if (kept.length > 0) {
    const probe = await ses.fetch(`${origin}/api/device`, { credentials: 'include' }).catch(() => null);
    if (probe?.ok) return;
  }
  await ses.cookies.set({ url: origin, name: COOKIE_NAME, value: token, httpOnly: true, sameSite: 'strict' });
}

/**
 * Finds the running Ledung and shows it, or the "not running" page. With `failed`, a start that ended without a Ledung
 * answering: the page shows that line instead of the plain reason.
 */
async function attach(failed?: string): Promise<void> {
  if (attaching || starting || !win) return;
  attaching = true;
  try {
    const found = await findRunning();
    if (!win || win.isDestroyed()) return;
    if (!found.running) {
      await showNotRunning(failed ?? found.reason, failed ? 'failed' : 'stopped');
      return;
    }
    const origin = `http://127.0.0.1:${found.port}`;
    await signIn(win.webContents.session, origin, found.token);
    ownOrigin = origin;
    await win.loadURL(`${origin}/`);
  } catch (e) {
    // A failed page load is shown by did-fail-load; this only says it in the terminal.
    console.error(`Ledung desktop: ${(e as Error).message}`);
  } finally {
    attaching = false;
  }
}

/** How long a started Ledung may take to answer after `ledung` returned (it returns early when still starting). */
const ANSWER_MS = 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start Ledung (#362): runs the installed `ledung --no-open` with a clean environment, then attaches as on Retry. A
 * Ledung that was already started elsewhere meanwhile is simply found. What failed is one line on the page, with
 * Start Ledung and Retry again; nothing here shows a dialog or throws (Mac spike surprise 3).
 */
async function start(): Promise<void> {
  if (starting || attaching || !win) return;
  starting = true;
  let failed: string | undefined;
  try {
    await showNotRunning('Starting Ledung in the background…', 'starting');
    const result = await runStart();
    if (!result.ok) failed = result.line;
    else {
      const deadline = Date.now() + ANSWER_MS;
      let answered = false;
      // Waits whether or not the window is open: one closed and opened again meanwhile shows the outcome too.
      while (!answered && Date.now() < deadline) {
        answered = (await findRunning()).running;
        if (!answered) await sleep(500);
      }
      if (!answered) failed = `Ledung was started but did not answer within ${ANSWER_MS / 1000} s; see ledung.log in its data folder.`;
    }
  } catch (e) {
    failed = `Could not start Ledung: ${(e as Error).message}`;
  } finally {
    starting = false;
  }
  if (failed) console.error(`Ledung desktop: ${failed}`);
  await attach(failed);
}

/**
 * What the page may use without asking: notifications (and push, which Electron asks as notifications) and writing to
 * the clipboard, the two the page uses, and only for Ledung's own address. Everything else (camera, microphone,
 * screen, location, reading the clipboard …) is refused: Electron would grant it silently where a browser asks the
 * person (code review of PR #366, Minor 2; Electron's checklist, "Handle session permission requests").
 */
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write']);

function allowed(permission: string, origin: string | undefined): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && origin !== undefined && sameOrigin(origin);
}

function limitPermissions(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => callback(allowed(permission, details.requestingUrl)));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed(permission, requestingOrigin));
}

/** Brings the hidden (or minimised) window back to the front: a second start, a click in the Dock. */
function showWindow(): void {
  if (!app.isReady()) return;
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // Started again from a terminal, the app is not the active one on the Mac, and focus alone leaves it behind.
  if (process.platform === 'darwin') app.focus({ steal: true });
}

/** Closing the window, by its button or ⌘W/Ctrl+W, only hides it: the app stays, so notifications keep coming (#359). */
function hideWindow(): void {
  if (!win || win.isDestroyed()) return;
  // Hidden while in full screen, a Mac window leaves an empty black Space behind: leave full screen first (self-check
  // finding 2).
  if (win.isFullScreen()) {
    const w = win;
    w.once('leave-full-screen', () => {
      if (!w.isDestroyed()) w.hide();
    });
    w.setFullScreen(false);
    return;
  }
  win.hide();
}

/** Ends the app: the window may close for real now. The Ledung it attached to is another program, and stays. */
function quit(): void {
  quitting = true;
  app.quit();
}

/**
 * Ctrl+O, as the page hears it: the page binds Show tool calls to Ctrl+O on every system so that ⌘O stays the
 * browser's (web/src/sessionMenu.ts). In the app ⌘O is the app's own, so it hands the page the page's key.
 */
function sendToolCallsKey(): void {
  if (!win || win.isDestroyed() || ownOrigin === null) return;
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'O', modifiers: ['control'] });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'O', modifiers: ['control'] });
}

/**
 * The app's menu owns the keys a browser keeps (#359): ⌘W/Ctrl+W hides the window instead of closing it, ⌘O on the
 * Mac is the page's Ctrl+O, ⌘Q (Mac) and Alt+F4 (Windows) end the app. Edit, View and Window keep their
 * standard items, so copy and paste, reload and zoom work as in the default menu. The ids let the probe press items.
 * On Windows and Linux the menu is never shown (#389); it stays only for these keys (createWindow).
 */
function buildMenu(): Menu {
  const mac = process.platform === 'darwin';
  const closeWindow: MenuItemConstructorOptions = { id: 'close-window', label: 'Close Window', accelerator: 'CmdOrCtrl+W', click: hideWindow };
  const quitItem: MenuItemConstructorOptions = { id: 'quit', label: mac ? 'Quit Ledung' : 'Quit', accelerator: mac ? 'Cmd+Q' : 'Alt+F4', click: quit };
  const toolCalls: MenuItemConstructorOptions = { id: 'tool-calls', label: 'Show Tool Calls', accelerator: 'Cmd+O', click: sendToolCallsKey };
  const separator: MenuItemConstructorOptions = { type: 'separator' };
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [{
          label: 'Ledung',
          submenu: [
            { role: 'about' }, separator, { role: 'services' }, separator,
            { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, separator, quitItem,
          ],
        } satisfies MenuItemConstructorOptions]
      : []),
    { label: 'File', submenu: mac ? [toolCalls, closeWindow] : [closeWindow, separator, quitItem] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    // Spelled out: the standard Window menu on Windows has a Close of its own on Ctrl+W.
    { label: 'Window', submenu: mac ? [{ role: 'minimize' }, { role: 'zoom' }, separator, { role: 'front' }] : [{ role: 'minimize' }] },
  ];
  return Menu.buildFromTemplate(template);
}

function createWindow(): void {
  limitPermissions(session.fromPartition(PARTITION));
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'Ledung',
    backgroundColor: '#1b1d22',
    // The window's and the Windows taskbar's icon; the Mac takes the Dock's, set at start (#384).
    icon: APP_ICON,
    // Windows and Linux draw the menu inside the window. It is never shown there, and Alt does not show it, so Alt
    // stays free for a key of Ledung's own later (Martin, 2026-11-19 01:09 on #384, issue #389). No auto-hide: that is
    // what made Alt show it. The Mac ignores both: its menu is the system's.
    autoHideMenuBar: false,
    webPreferences: {
      session: session.fromPartition(PARTITION),
      contextIsolation: true,
      sandbox: true,
      // One function for the page, `ledungDesktop.showWindow()`, which a click on its notification calls (#360).
      preload: PRELOAD,
      nodeIntegration: false,
      // A hidden window keeps its timers at full speed, so notifications come on time (Windows spike: one 13–14 ms
      // after a prompt, 400 s hidden). The page also stays "visible" then, so its polls keep running (#359).
      backgroundThrottling: false,
    },
  });
  // Hidden, not removed: the hidden menu's accelerators still work (Ctrl+W, Alt+F4, copy and paste, zoom), and with
  // auto-hide off nothing shows it again (#389).
  if (process.platform !== 'darwin') win.setMenuBarVisibility(false);
  const contents = win.webContents;
  lockNavigation(contents);
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    hideWindow();
  });
  // Windows: logging off or shutting down closes the window; let it, or the app would hold the logoff up.
  win.on('session-end', () => {
    quitting = true;
    sessionEnding = true;
  });
  // A page with unsaved changes (the flow builder's) asks before it is left, by quitting or reloading. A browser asks
  // the person then; Electron would silently stay instead, and a cancelled quit would leave `quitting` set, so the next
  // close would end the app instead of hiding it (self-check finding 1). Ask as a browser does; Stay keeps everything.
  win.webContents.on('will-prevent-unload', (event) => {
    // Logging off: leave without asking, or the question would hold the logoff up (code review of PR #372, Minor 2).
    if (sessionEnding) {
      event.preventDefault();
      return;
    }
    // The question belongs to the window: asked of a hidden one (⌘W, then Quit from the Dock) it may never be seen,
    // and the app would wait on it for good (code review of PR #372, Minor 2). Show the window first.
    showWindow();
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'question',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      message: 'Leave this page?',
      detail: 'Changes you made may not be saved.',
    });
    if (choice === 0) event.preventDefault();
    else quitting = false;
  });
  // Alt+F4 on Windows quits, where the window's close button hides; the system turns both into the same close, so the
  // key is noted on its way in, in case the system handles it before the menu's accelerator does.
  win.webContents.on('before-input-event', (event, input) => {
    if (process.platform === 'win32' && input.type === 'keyDown' && input.alt && !input.control && !input.meta && input.key === 'F4') quitting = true;
    // Ctrl and "+" zooms in on every layout (#389, desktop/keys.ts); the menu's own Zoom In matches the US key only.
    // Taken here, so the menu does not zoom a second time on a US keyboard.
    if (zoomKey(input) === 'in') {
      event.preventDefault();
      contents.zoomLevel = zoomed(contents.zoomLevel, 'in');
    }
  });
  // Ctrl and the mouse wheel: Electron only reports it, and zooms nothing unless the app does (#389). Off the Mac,
  // which is unchanged.
  win.webContents.on('zoom-changed', (_event, direction) => {
    if (process.platform !== 'darwin') contents.zoomLevel = zoomed(contents.zoomLevel, direction);
  });
  // A window opened again (the Dock) while a start runs shows that it runs; the start shows the outcome in it.
  if (starting) void showNotRunning('Starting Ledung in the background…', 'starting');
  win.on('closed', () => {
    win = null;
  });
  void attach();
}

// One app per computer: a second start shows the first one's window and ends (#359). Asked before anything else, so
// the second never opens a window or signs in.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  // A click on one of the page's notifications (#360). Only Ledung's own page, in this window's top frame, may ask:
  // not the "not running" page, and not a frame of anything else.
  ipcMain.on(SHOW_WINDOW_MESSAGE, (event) => {
    const frame = event.senderFrame;
    if (!win || win.isDestroyed() || event.sender !== win.webContents || !frame || frame.parent !== null || !sameOrigin(frame.url)) return;
    showWindow();
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  // Reached only while quitting, since closing otherwise hides.
  app.on('window-all-closed', () => app.quit());
  // A click on the app in the Dock (Mac), the window hidden or not.
  app.on('activate', showWindow);
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu());
    // Run from a clone the app is Electron's own, with Electron's icon in the Dock until it is told otherwise (#384),
    // and the Dock draws what it is given edge to edge, so it gets the margin Mac app icons carry (#404).
    if (process.platform === 'darwin') app.dock?.setIcon(dockIcon());
    createWindow();
  });
}
