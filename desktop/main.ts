// Ledung in a desktop window (issue #358, epic #357): one window showing this computer's running Ledung, signed in.
// It never starts a Ledung (D5, #362): with none running, the window says so and offers Retry.
//
// The page is Ledung's own page at http://127.0.0.1:<port>/, loaded like a browser loads it, so the core's Host
// check, sign-in cookie, Origin check and "no embedding" apply unchanged. Sign-in sets the cookie from this main
// process (Mac spike 2026-11-17: GET /api/state 200 with no token in any URL); the token never goes into a URL or a
// command line.
import { app, BrowserWindow, Menu, session, shell, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRunning } from './attach.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOT_RUNNING_PAGE = path.join(here, 'not-running.html');
/** The core's sign-in cookie (src/server/security.ts COOKIE_NAME). */
const COOKIE_NAME = 'ledung_auth';
/** One partition for the app's cookies, kept between starts, apart from Electron's default session. */
const PARTITION = 'persist:ledung';

let win: BrowserWindow | null = null;
/** Set once the app is really quitting (⌘Q, File → Quit, Alt+F4, logging off): from then on closing closes. */
let quitting = false;
/** The origin the window may show: the attached Ledung's, or none while the "not running" page is up. */
let ownOrigin: string | null = null;
let attaching = false;

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
  // The "not running" page's Retry is a link to #retry: an in-page move, so it needs no script bridge.
  wc.on('did-navigate-in-page', (_event, url) => {
    if (ownOrigin === null && url.startsWith('file:') && url.endsWith('#retry')) void attach();
  });
  // Ledung's page failed to load after attaching (it stopped, or a reload found nothing): back to the page with Retry
  // instead of Chromium's error page, which has none (self-check finding 1g). -3 is a load the app itself replaced.
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && ownOrigin !== null && sameOrigin(url)) void showNotRunning(`Ledung's page did not load (${description}).`);
  });
}

async function showNotRunning(reason: string): Promise<void> {
  ownOrigin = null;
  if (win && !win.isDestroyed()) await win.loadFile(NOT_RUNNING_PAGE, { query: { reason } });
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

/** Finds the running Ledung and shows it, or the "not running" page with Retry. */
async function attach(): Promise<void> {
  if (attaching || !win) return;
  attaching = true;
  try {
    const found = await findRunning();
    if (!win || win.isDestroyed()) return;
    if (!found.running) {
      await showNotRunning(found.reason);
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
  if (win && !win.isDestroyed()) win.hide();
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
 * Mac is the page's Ctrl+O, ⌘Q (Mac) and File → Quit (Windows, Linux) end the app. Edit, View and Window keep their
 * standard items, so copy and paste, reload and zoom work as in the default menu. The ids let the probe press items.
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
    webPreferences: {
      session: session.fromPartition(PARTITION),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // A hidden window keeps its timers at full speed, so notifications come on time (Windows spike: one 13–14 ms
      // after a prompt, 400 s hidden). The page also stays "visible" then, so its polls keep running (#359).
      backgroundThrottling: false,
    },
  });
  lockNavigation(win.webContents);
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    hideWindow();
  });
  // Windows: logging off or shutting down closes the window; let it, or the app would hold the logoff up.
  win.on('session-end', () => {
    quitting = true;
  });
  // Alt+F4 on Windows quits, where the window's close button hides; the system turns both into the same close, so the
  // key is noted on its way in, in case the system handles it before the menu's accelerator does.
  win.webContents.on('before-input-event', (_event, input) => {
    if (process.platform === 'win32' && input.type === 'keyDown' && input.alt && !input.control && !input.meta && input.key === 'F4') quitting = true;
  });
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
  app.on('before-quit', () => {
    quitting = true;
  });
  // Reached only while quitting, since closing otherwise hides.
  app.on('window-all-closed', () => app.quit());
  // A click on the app in the Dock (Mac), the window hidden or not.
  app.on('activate', showWindow);
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu());
    createWindow();
  });
}
