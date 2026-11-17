// Ledung in a desktop window (issue #358, epic #357): one window showing this computer's running Ledung, signed in.
// With none running, the window says so and offers Start Ledung, which runs the installed `ledung` command (D5, #362,
// desktop/start.ts), and Retry.
//
// The page is Ledung's own page at http://127.0.0.1:<port>/, loaded like a browser loads it, so the core's Host
// check, sign-in cookie, Origin check and "no embedding" apply unchanged. Sign-in sets the cookie from this main
// process (Mac spike 2026-11-17: GET /api/state 200 with no token in any URL); the token never goes into a URL or a
// command line.
import { app, BrowserWindow, session, shell, type Session, type WebContents } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRunning } from './attach.ts';
import { runStart } from './start.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOT_RUNNING_PAGE = path.join(here, 'not-running.html');
/** The core's sign-in cookie (src/server/security.ts COOKIE_NAME). */
const COOKIE_NAME = 'ledung_auth';
/** One partition for the app's cookies, kept between starts, apart from Electron's default session. */
const PARTITION = 'persist:ledung';

let win: BrowserWindow | null = null;
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
    },
  });
  lockNavigation(win.webContents);
  // A window opened again (the Dock) while a start runs shows that it runs; the start shows the outcome in it.
  if (starting) void showNotRunning('Starting Ledung in the background…', 'starting');
  win.on('closed', () => {
    win = null;
  });
  void attach();
}

// Plain window behaviour for now; closing hides, one instance and the shortcuts are D2 (#359).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (!win && app.isReady()) createWindow();
});
void app.whenReady().then(createWindow);
