// Ledung in a desktop window (issue #358, epic #357): one window showing this computer's running Ledung, signed in.
// It never starts a Ledung (D5, #362): with none running, the window says so and offers Retry.
//
// The page is Ledung's own page at http://127.0.0.1:<port>/, loaded like a browser loads it, so the core's Host
// check, sign-in cookie, Origin check and "no embedding" apply unchanged. Sign-in sets the cookie from this main
// process (Mac spike 2026-11-17: GET /api/state 200 with no token in any URL); the token never goes into a URL or a
// command line.
import { app, BrowserWindow, session, shell, type Session, type WebContents } from 'electron';
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

function createWindow(): void {
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
