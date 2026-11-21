// Ledung in a desktop window (issue #358, epic #357): windows showing this computer's running Ledung, signed in; one
// at start, more by File → New Window (#414).
// With none running, the window says so and offers Start Ledung, which runs the installed `ledung` command (D5, #362,
// desktop/start.ts), and Retry.
//
// The page is Ledung's own page at http://127.0.0.1:<port>/, loaded like a browser loads it, so the core's Host
// check, sign-in cookie, Origin check and "no embedding" apply unchanged. Sign-in sets the cookie from this main
// process (Mac spike 2026-11-17: GET /api/state 200 with no token in any URL); the token never goes into a URL or a
// command line.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, session, shell, WebContentsView, type BaseWindow, type ContextMenuParams, type Input, type IpcMainEvent, type NativeImage, type Session, type WebContents } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { dataDir, findRunning } from './attach.ts';
import { CONTEXT_LABELS, contextItems, type ContextItem } from './context-menu.ts';
import { dockIconLayout, padBitmap } from './dock-icon.ts';
import { FindSession, type FindRequest } from './find.ts';
import { findKey, zoomed, zoomKey, type FindKey } from './keys.ts';
import { APP_ID, installedVersion, readMadeConfig, readStartUpdate, reloadRestarts, restartBrings, START_HIDDEN_FILE, START_UPDATE_FILE, updateAtStart, WRITE_SHORTCUT_ARG } from './made.ts';
import { menuTemplate, type PageCommand } from './menu.ts';
import { restartCommand, runStart, startCommand, startEnv } from './start.ts';
import { WindowList } from './windows.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * The made app's settings (#407): present when the npm package's `ledung` made this app in the data folder, null for a
 * clone run. Its LEDUNG_CONFIG and LEDUNG_DATA_DIR pick the Ledung the app shows, so an app opened from Finder or the
 * Start menu, with none of the terminal's settings, finds the same one; Start Ledung runs the Node and `ledung` that
 * made it.
 */
const made = readMadeConfig(here);
/** Set when the core started this just-made app only to write its Start-menu shortcut (#587, made.ts). */
const shortcutFile = process.argv.find((a) => a.startsWith(`${WRITE_SHORTCUT_ARG}=`))?.slice(WRITE_SHORTCUT_ARG.length + 1);
if (made) {
  for (const [name, value] of Object.entries(made.env)) process.env[name] = value;
  // Electron would keep its profile (cookies, caches) in a folder named after the app, "Ledung": on the Mac and
  // Windows that is Ledung's own data folder. Its own folder beside the made app instead; the shortcut writer gets a
  // throwaway one, so a running app's profile is never shared.
  app.setPath('userData', path.join(dataDir(), 'desktop', shortcutFile ? '.shortcut-profile' : 'profile'));
  // Windows: the taskbar and notifications group the app under this id instead of Electron's.
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
}
const NOT_RUNNING_PAGE = path.join(here, 'not-running.html');
/** The page's bridge to the app: showing its window when a notification is clicked (#360), opening another (#414). */
const PRELOAD = path.join(here, 'preload.cjs');
/** The messages the preload sends for them (preload.cjs). */
export const SHOW_WINDOW_MESSAGE = 'ledung-desktop:show-window';
export const NEW_WINDOW_MESSAGE = 'ledung-desktop:new-window';
export const RESTART_FOR_UPDATE_MESSAGE = 'ledung-desktop:restart-for-update';
/**
 * Tells the preload that this is a made app, which can restart into an update (#408); a clone run can't, so its page
 * gets no such function and shows no button that does nothing.
 */
const MADE_APP_ARG = '--ledung-made-app';
/** Left by an app that restarted while hidden (#408): the new one starts hidden too, as the person left it. */
const START_HIDDEN = path.join(dataDir(), 'desktop', START_HIDDEN_FILE);
/** Left by an app that restarted at start to take the installed version (#455): the next start does not try it again. */
const START_UPDATE = path.join(dataDir(), 'desktop', START_UPDATE_FILE);
/**
 * Ledung's own icon (#384), the page's app icon: next to main.js in the npm package and the made app (#407), from the
 * clone's web/public in a clone run. A PNG, since Electron's images load no SVG. Exported for the probe, which checks
 * it loads.
 */
export const APP_ICON = fs.existsSync(path.join(here, 'icon-512.png')) ? path.join(here, 'icon-512.png') : path.join(here, '..', 'web', 'public', 'icon-512.png');
/** The core's sign-in cookie (src/server/security.ts COOKIE_NAME). */
const COOKIE_NAME = 'ledung_auth';

/**
 * The Dock's icon (#404): APP_ICON with the transparent margin every Mac app icon has, so it is the size of the
 * others. The resize is Electron's own (best quality); the padding is dock-icon.ts. Exported for the probe.
 */
export function dockIcon(): NativeImage {
  const icon = nativeImage.createFromPath(APP_ICON);
  // A clone without the file gives an empty image: passed on as before (#384), not padded into an error at start.
  if (icon.isEmpty()) return icon;
  const canvas = icon.getSize().width;
  const { body } = dockIconLayout(canvas);
  const small = icon.resize({ width: body, height: body, quality: 'best' });
  return nativeImage.createFromBitmap(padBitmap(small.toBitmap(), body, canvas), { width: canvas, height: canvas });
}
/** One partition for the app's cookies, kept between starts, apart from Electron's default session. */
const PARTITION = 'persist:ledung';

/** The app's windows, the most recently used last (#414). All show the same Ledung, or all the "not running" page. */
const windows = new WindowList<BrowserWindow>();
/** The windows still open: one being destroyed is in the list until its `closed`. */
const openWindows = (): BrowserWindow[] => windows.all().filter((w) => !w.isDestroyed());
/** The app's window that is `w`, if `w` is one: the menu hands its items the focused window as a BaseWindow. */
const ownWindow = (w: BaseWindow | undefined): BrowserWindow | null => openWindows().find((x) => x === w) ?? null;
/**
 * The window a menu item acts on: the focused one Electron hands it, or with none (the Mac's menu while every window
 * is hidden, an item clicked from code) the most recently used, as when the app had one window.
 */
const menuWindow = (w: BaseWindow | undefined): BrowserWindow | null => (w === undefined ? windows.latest() : ownWindow(w));
/** Set once the app is really quitting (⌘Q, Alt+F4, logging off): from then on closing closes. */
let quitting = false;
/** Windows is logging off or shutting down: nothing may hold that up, not even unsaved changes. */
let sessionEnding = false;
/** The origin the windows may show: the attached Ledung's, or none while the "not running" page is up. */
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
 * A window shows Ledung's page and nothing else: a navigation away from its origin is refused, and so is every new
 * window the page opens. A web link elsewhere (a pull request in a chat) opens in the default browser instead. The
 * page's New window button asks through the preload instead (#414), so a same-origin link still opens nothing.
 */
function lockNavigation(wc: WebContents): void {
  wc.on('will-navigate', (event, url) => {
    if (sameOrigin(url)) return;
    event.preventDefault();
    if (webLink(url)) void shell.openExternal(url);
  });
  // The window itself only, as will-navigate is: a frame is a linked computer's page in its tab, which the page's own
  // frame-src already limits to those computers. Refusing its redirects cancelled the Pair form's answer, which goes
  // back to that computer's own page, so pairing a tab in the app never landed (#468, #466).
  wc.on('will-redirect', (event) => {
    if (event.isMainFrame && !sameOrigin(event.url)) event.preventDefault();
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

type NotRunningState = 'stopped' | 'starting' | 'failed';
/** What the "not running" page last said, for a window opened after it was shown (#414). */
// Before any was shown (an attach that failed on its way, self-check round 2, point 2): a reason that still says what
// to do.
let notRunningAs: { reason: string; state: NotRunningState } = { reason: 'Ledung could not be reached. Press Retry to look again.', state: 'stopped' };
/**
 * Windows opened while an attach was finding the Ledung (#414): it may already have taken its list of windows, so it
 * shows them what it found when it ends (self-check finding 5).
 */
const waitingForAttach = new Set<BrowserWindow>();

/** The "not running" page in one window. */
async function loadNotRunning(w: BrowserWindow, reason: string, state: NotRunningState): Promise<void> {
  if (!w.isDestroyed()) await w.loadFile(NOT_RUNNING_PAGE, { query: { reason, state } });
}

/**
 * The page with Start Ledung and Retry, saying why, in every window: they share the one Ledung, so when it is gone it
 * is gone for all (#414). `state` "starting" shows a start under way and no buttons.
 */
async function showNotRunning(reason: string, state: NotRunningState = 'stopped'): Promise<void> {
  ownOrigin = null;
  notRunningAs = { reason, state };
  const all = openWindows();
  for (const w of all) waitingForAttach.delete(w);
  await Promise.all(all.map((w) => loadNotRunning(w, reason, state)));
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
  if (attaching || starting || windows.size === 0) return;
  attaching = true;
  try {
    const found = await findRunning();
    if (openWindows().length === 0) return;
    if (!found.running) {
      await showNotRunning(failed ?? found.reason, failed ? 'failed' : 'stopped');
      return;
    }
    const origin = `http://127.0.0.1:${found.port}`;
    // One partition for every window, so signing it in signs them all in (#414).
    await signIn(session.fromPartition(PARTITION), origin, found.token);
    ownOrigin = origin;
    // Every window: a window opened while this ran is in the list by now, and shows the page too; taken here, it
    // needs no second load when this ends (self-check round 2, point 1).
    const all = openWindows();
    for (const w of all) waitingForAttach.delete(w);
    await Promise.all(all.map((w) => w.loadURL(`${origin}/`)));
  } catch (e) {
    // A failed page load is shown by did-fail-load; this only says it in the terminal.
    console.error(`Ledung desktop: ${(e as Error).message}`);
  } finally {
    attaching = false;
    // A window opened meanwhile shows what this found, whether or not the loads above took it in (#414).
    for (const w of waitingForAttach) showCurrent(w);
    waitingForAttach.clear();
  }
}

/** A window opened after the others: the attached Ledung's page, or the "not running" page as it last read. */
function showCurrent(w: BrowserWindow): void {
  if (w.isDestroyed()) return;
  if (ownOrigin !== null) w.loadURL(`${ownOrigin}/`).catch((e: Error) => console.error(`Ledung desktop: ${e.message}`));
  else void loadNotRunning(w, notRunningAs.reason, notRunningAs.state);
}

/** How long a started Ledung may take to answer after `ledung` returned (it returns early when still starting). */
const ANSWER_MS = 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start Ledung (#362): runs the installed `ledung --no-open` with a clean environment (in the made app, the Node and
 * `ledung` that made it, #407), then attaches as on Retry. A
 * Ledung that was already started elsewhere meanwhile is simply found. What failed is one line on the page, with
 * Start Ledung and Retry again; nothing here shows a dialog or throws (Mac spike surprise 3).
 */
async function start(): Promise<void> {
  if (starting || attaching || windows.size === 0) return;
  starting = true;
  let failed: string | undefined;
  try {
    await showNotRunning('Starting Ledung in the background…', 'starting');
    const result = await runStart(startCommand(process.env, made));
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

/**
 * Brings a hidden (or minimised) window back to the front: `w`, or else the most recently used one (#414), for a
 * second start, a click in the Dock. With none open, a new one.
 */
function showWindow(w: BrowserWindow | null = windows.latest()): void {
  if (!app.isReady()) return;
  if (!w || w.isDestroyed()) {
    // Not while restarting at start or for a reload (#455): a Dock click or a second start would make a window it then
    // closes. An open window still shows: a "Leave this page?" on a hidden one must be seen (self-check, finding 1).
    if (restartAppOnly) return;
    createWindow();
    return;
  }
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  // Started again from a terminal, the app is not the active one on the Mac, and focus alone leaves it behind.
  if (process.platform === 'darwin') app.focus({ steal: true });
}

/** Hides a window: what closing the last one does. */
function hideWindow(w: BrowserWindow): void {
  if (w.isDestroyed()) return;
  // Hidden while in full screen, a Mac window leaves an empty black Space behind: leave full screen first (self-check
  // finding 2).
  if (w.isFullScreen()) {
    w.once('leave-full-screen', () => {
      if (!w.isDestroyed()) w.hide();
    });
    w.setFullScreen(false);
    return;
  }
  w.hide();
}

/**
 * Closing a window, by its button or ⌘W/Ctrl+W: the last one only hides, so the app stays and notifications keep
 * coming (#359); any other closes for real, and the rest stay (#414).
 */
function closeWindow(w: BrowserWindow): void {
  if (w.isDestroyed()) return;
  if (windows.closeHides(w)) hideWindow(w);
  else w.close();
}

/** Ends the app: the window may close for real now. The Ledung it attached to is another program, and stays. */
function quit(): void {
  quitting = true;
  app.quit();
}

/**
 * Ledung was updated and this app still runs the old version's code (#408): the page said so. The window restarts by
 * itself while no window is shown, and when the person presses the page's Restart (Martin, 2026-11-19, Ledung question
 * #593: "restart by itself when hidden, ask when in front").
 */
let updatePending = false;
/** A quit that restarts the app once it is sure (will-quit): a page that asked "Leave this page?" may still keep it. */
let restartOnQuit = false;
/**
 * That restart is the one at start or a reload's (#455): the `ledung` it runs opens the app, and starts Ledung only when
 * none runs (#477), never a second one.
 */
let restartAppOnly = false;

/** Whether any window is in sight: shown and not minimised. */
const anyShown = (): boolean => openWindows().some((w) => w.isVisible() && !w.isMinimized());

/**
 * Whether the app had no visible window when its restart began: then the new one starts hidden too. Taken before the
 * quit, since by will-quit every window has closed (self-check finding 1). A minimised window counts as there, so
 * it comes back shown rather than vanishing from the Windows taskbar (self-check finding 2).
 */
let hiddenAtRestart = false;

/**
 * Restarts the app to take the updated Ledung's code (#408): quits, and the `ledung` that made it opens it again. Not
 * when that command is gone (a Node upgraded or moved): quitting would leave nothing to open the app again, so it stays
 * on the old code with its banner, and starting `ledung` updates it (self-check finding 4).
 */
function restartForUpdate(appOnly = false): boolean {
  if (!made || restartOnQuit) return false;
  if (!restartCommand(made, process.pid)) {
    console.error('Ledung desktop: the ledung command that made this app is gone; start it again with ledung to update it.');
    return false;
  }
  // That command is this app's own version: the running Ledung is another install, and a restart would bring the same
  // code back, told again it is out of date (PR #425, review Minor 2).
  if (!restartBrings(app.getVersion(), installedVersion(made.cli))) {
    console.error(`Ledung desktop: the ledung that made this app is version ${app.getVersion()} too; run the running Ledung's own ledung command to update the app.`);
    return false;
  }
  // Minimised counts as there: the Mac reports a minimised window as not visible (self-check round 2, finding 1).
  hiddenAtRestart = !openWindows().some((w) => w.isVisible() || w.isMinimized());
  restartOnQuit = true;
  restartAppOnly = appOnly;
  quit();
  return true;
}

/** The update waits for the windows to be out of sight; called when one hides or is minimised. */
function restartIfHidden(): void {
  // Not while quitting: windows closing for a plain quit must not turn it into a restart.
  if (updatePending && !quitting && !anyShown()) restartForUpdate();
}

/**
 * The quit is sure: run the `ledung` that made this app, which waits for it to end, writes the new code into it and
 * opens it (src/cli.ts, --after-app). Detached, so it outlives this app; its output goes to restart.log beside the app.
 */
function startAfterQuit(): void {
  const cmd = restartCommand(made, process.pid, restartAppOnly);
  if (!cmd) {
    console.error('Ledung desktop: the ledung command that made this app is gone; start it again with ledung to update it.');
    return;
  }
  const dir = path.dirname(START_HIDDEN);
  let out: number | 'ignore' = 'ignore';
  try {
    fs.mkdirSync(dir, { recursive: true });
    // No window was visible: the new app starts hidden too, so a restart the person did not ask for shows nothing.
    if (hiddenAtRestart) fs.writeFileSync(START_HIDDEN, '');
    out = fs.openSync(path.join(dir, 'restart.log'), 'a');
  } catch (e) {
    console.error(`Ledung desktop: ${(e as Error).message}`);
  }
  try {
    spawn(cmd.command, cmd.args, { detached: true, stdio: ['ignore', out, out], windowsHide: true, env: startEnv(process.env) }).unref();
  } catch (e) {
    console.error(`Ledung desktop: could not restart for the update: ${(e as Error).message}`);
    // Nothing restarts it: the next start, by hand, shows its window (self-check finding 2).
    fs.rmSync(START_HIDDEN, { force: true });
  } finally {
    if (typeof out === 'number') fs.closeSync(out);
  }
}

/**
 * Ctrl+O, as the page hears it: the page binds Show tool calls to Ctrl+O on every system so that ⌘O stays the
 * browser's (web/src/sessionMenu.ts). In the app ⌘O is the app's own, so it hands the page the page's key.
 */
function sendToolCallsKey(w: BrowserWindow): void {
  if (w.isDestroyed() || ownOrigin === null) return;
  w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'O', modifiers: ['control'] });
  w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'O', modifiers: ['control'] });
}

/**
 * The find bar (#445): Ctrl+F / ⌘F, or Edit → Find…, shows it over the window's top right; typing searches the page
 * with Chromium's own find, which highlights the matches and scrolls to the active one, and the bar shows "n of m".
 * The bar is a page of its own (find-bar.html) in a view laid over the window, not part of Ledung's page: the page's
 * search then never finds the bar's text, and the page needs no change. One per window, made at its first open.
 */
const FIND_BAR_PAGE = path.join(here, 'find-bar.html');
const FIND_BAR_PRELOAD = path.join(here, 'find-bar.cjs');
/** The messages the bar's preload sends (find-bar.cjs). */
export const FIND_QUERY_MESSAGE = 'ledung-find:query';
export const FIND_STEP_MESSAGE = 'ledung-find:step';
export const FIND_CLOSE_MESSAGE = 'ledung-find:close';
/** The bar's size and place: a browser's find bar's, in from the window's right edge, below the page's top bar. */
const FIND_BAR = { width: 400, height: 44, right: 16, top: 52 };

interface FindBar {
  view: WebContentsView;
  search: FindSession;
  open: boolean;
  /** The bar's page has loaded: until then it can't take the focus or a message. */
  loaded: Promise<void>;
}
/** Each window's bar, once it has been opened. */
const findBars = new Map<BrowserWindow, FindBar>();

/** Puts the bar at the window's top right; a window narrower than the bar gets one as wide as it. */
function placeFindBar(w: BrowserWindow, bar: FindBar): void {
  const { width: inside } = w.getContentBounds();
  const width = Math.min(FIND_BAR.width, Math.max(0, inside - 2 * FIND_BAR.right));
  bar.view.setBounds({ x: Math.max(0, inside - width - FIND_BAR.right), y: FIND_BAR.top, width, height: FIND_BAR.height });
}

/** The window's bar, made (hidden) the first time. */
function findBarOf(w: BrowserWindow): FindBar {
  const existing = findBars.get(w);
  if (existing) return existing;
  const view = new WebContentsView({ webPreferences: { preload: FIND_BAR_PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  // Clear, so the bar's rounded corners show the page behind them.
  view.setBackgroundColor('#00000000');
  view.setVisible(false);
  w.contentView.addChildView(view);
  const contents = view.webContents;
  // The bar shows its own file and nothing else.
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Enter, Shift+Enter, Esc and Ctrl+F / ⌘F in the bar (desktop/keys.ts), and the window's own keys as in the page
  // (Alt+F4, Ctrl and "+"); everything else types in its text box.
  contents.on('before-input-event', (event, input) => windowKeys(w, event, input, true));
  // Cut, Copy, Paste and Select All in its text box, as in the page's (#447).
  contents.on('context-menu', (_event, params) => showContextMenu(w, contents, params));
  const bar: FindBar = { view, search: new FindSession(), open: false, loaded: contents.loadFile(FIND_BAR_PAGE) };
  bar.loaded.catch((e: Error) => console.error(`Ledung desktop: the find bar did not load: ${e.message}`));
  w.on('resize', () => placeFindBar(w, bar));
  w.on('closed', () => {
    findBars.delete(w);
    if (!contents.isDestroyed()) contents.close();
  });
  findBars.set(w, bar);
  return bar;
}

/** Sends one search to the window's page; only its answers reach the bar. */
function findInPage(w: BrowserWindow, bar: FindBar, request: FindRequest | 'stop'): void {
  if (w.isDestroyed()) return;
  if (request === 'stop') w.webContents.stopFindInPage('clearSelection');
  else bar.search.sent(w.webContents.findInPage(request.text, { forward: request.forward, findNext: request.findNext }));
}

/**
 * Opens the bar with its text box in focus and its text selected. Opened again after a close, it searches its kept
 * text anew; pressed again while open, it only selects the text, as a browser's does.
 */
function openFind(w: BrowserWindow): void {
  if (w.isDestroyed()) return;
  const bar = findBarOf(w);
  const wasOpen = bar.open;
  bar.open = true;
  placeFindBar(w, bar);
  bar.view.setVisible(true);
  void bar.loaded.then(() => {
    if (!bar.open || w.isDestroyed()) return;
    bar.view.webContents.focus();
    bar.view.webContents.send('ledung-find:open', bar.search.text);
    if (!wasOpen) {
      const request = bar.search.reopen();
      if (request) findInPage(w, bar, request);
    }
  }, () => {});
}

/** Closes the bar: the highlights go, and the page has the keys again. */
function closeFind(w: BrowserWindow): void {
  const bar = findBars.get(w);
  if (!bar?.open) return;
  bar.open = false;
  bar.search.closed();
  bar.view.setVisible(false);
  if (w.isDestroyed()) return;
  w.webContents.stopFindInPage('clearSelection');
  w.webContents.focus();
}

/** A find key (desktop/keys.ts) pressed in the window: open, step or close. */
function findAction(w: BrowserWindow, key: FindKey): void {
  if (key === 'open') openFind(w);
  else if (key === 'close') closeFind(w);
  else {
    const bar = findBars.get(w);
    const request = bar?.open ? bar.search.step(key === 'next') : null;
    if (bar && request) findInPage(w, bar, request);
  }
}

/**
 * The window's own keys, pressed in its page or in its find bar (`inBar`): the same in both, so a key works while the
 * bar has the focus too (self-check of PR #448, finding 1).
 */
function windowKeys(w: BrowserWindow, event: { preventDefault(): void }, input: Input, inBar: boolean): void {
  // Alt+F4 on Windows quits, where the window's close button hides; the system turns both into the same close, so the
  // key is noted on its way in, in case the system handles it before the menu's accelerator does.
  if (process.platform === 'win32' && input.type === 'keyDown' && input.alt && !input.control && !input.meta && input.key === 'F4') quitting = true;
  // Ctrl and "+" zooms the page in on every layout (#389, desktop/keys.ts); the menu's own Zoom In matches the US key
  // only. Taken here, so the menu does not zoom a second time on a US keyboard.
  if (zoomKey(input) === 'in') {
    event.preventDefault();
    if (!w.isDestroyed()) w.webContents.zoomLevel = zoomed(w.webContents.zoomLevel, 'in');
  }
  // Ctrl+F / ⌘F opens the find bar from anywhere in the page, its text boxes too (#445): taken before the page sees it,
  // which binds no Ctrl+F of its own, and before the menu's Find…, so it opens once. In the bar, its other keys too.
  const key = findKey(input, inBar);
  if (key) {
    event.preventDefault();
    findAction(w, key);
  }
}

/** The window whose bar a message came from; null for any other sender (the bar's preload is the only one sending these). */
function findBarWindow(event: IpcMainEvent): BrowserWindow | null {
  for (const [w, bar] of findBars) if (!w.isDestroyed() && bar.view.webContents === event.sender && bar.open) return w;
  return null;
}

/**
 * The right-click menu (#447): the items desktop/context-menu.ts picks for what was clicked, acting on the page (or
 * the find bar) that was clicked. Copy Image copies the picture under the pointer, as a browser's does; Save Image As…
 * downloads its address through the window's signed-in session, and with no download handler of the app's own Electron
 * asks where to save it. Nothing applies: no menu.
 */
function showContextMenu(w: BrowserWindow, contents: WebContents, params: ContextMenuParams): void {
  const entries = contextItems(params);
  if (entries.length === 0 || w.isDestroyed()) return;
  const act: Record<ContextItem, () => void> = {
    copyImage: () => contents.copyImageAt(params.x, params.y),
    saveImage: () => contents.downloadURL(params.srcURL),
    // Electron 45's clipboard is the W3C one, a promise.
    copyLink: () => void clipboard.writeText(params.linkURL).catch((e: Error) => console.error(`Ledung desktop: ${e.message}`)),
    cut: () => contents.cut(),
    copy: () => contents.copy(),
    paste: () => contents.paste(),
    selectAll: () => contents.selectAll(),
  };
  const menu = Menu.buildFromTemplate(entries.map((e) => (e === 'separator'
    ? { type: 'separator' as const }
    : {
        id: `context-${e}`,
        label: CONTEXT_LABELS[e],
        click: () => {
          if (!contents.isDestroyed()) act[e]();
        },
      })));
  menu.popup({ window: w, frame: params.frame ?? undefined });
}

/** A View menu item on the window's page (desktop/menu.ts): the zoom steps are the app's own keys' (#389). */
function pageCommand(w: BrowserWindow, command: PageCommand): void {
  if (w.isDestroyed()) return;
  const page = w.webContents;
  // This app's own code is not the installed Ledung's (#455): a reload restarts the window into it instead of
  // reloading the page alone. App only: a running Ledung is left as it is, and one that is not running is started
  // as at the app's start (#477). A restart that can't go reloads the page.
  if (made && reloadRestarts(command, app.getVersion(), installedVersion(made.cli)) && restartForUpdate(true)) return;
  if (command === 'reload') page.reload();
  else if (command === 'forceReload') page.reloadIgnoringCache();
  else if (command === 'devTools') page.toggleDevTools();
  else if (command === 'resetZoom') page.zoomLevel = 0;
  else page.zoomLevel = zoomed(page.zoomLevel, command === 'zoomIn' ? 'in' : 'out');
}

/** The app's menu (desktop/menu.ts); its items act on the focused window, which Electron hands them. */
function buildMenu(): Menu {
  return Menu.buildFromTemplate(menuTemplate<BaseWindow>(process.platform, {
    newWindow: () => newWindow(),
    closeWindow: (w) => {
      // No focused window with several open (all minimised on the Mac): nothing, as the Mac's own apps do, rather than
      // close one the person cannot see for real (code review of PR #416, Minor 2). One window hides, as before.
      if (w === undefined && windows.size > 1) return;
      const own = menuWindow(w);
      if (own) closeWindow(own);
    },
    toolCalls: (w) => {
      const own = menuWindow(w);
      if (own) sendToolCallsKey(own);
    },
    find: (w) => {
      const own = menuWindow(w);
      if (own) openFind(own);
    },
    page: (w, command) => {
      const own = menuWindow(w);
      if (own) pageCommand(own, command);
    },
    quit,
  }));
}

/** How far a new window sits from the one it opened from, right and down, so both can be seen (#414). */
const NEW_WINDOW_OFFSET = 28;

/**
 * Another window (#414): File → New Window, ⌘N/Ctrl+N, or the page's New window button. It shows the same Ledung,
 * signed in by the shared partition, at its start page, with a route and scroll of its own.
 */
function newWindow(): BrowserWindow {
  const from = windows.latest();
  const at = from && !from.isDestroyed() && from.isVisible() && !from.isFullScreen() ? from.getBounds() : null;
  return createWindow(at ? { x: at.x + NEW_WINDOW_OFFSET, y: at.y + NEW_WINDOW_OFFSET, width: at.width, height: at.height } : undefined);
}

/**
 * Opens a window and shows the attached Ledung in it, or finds one; `bounds` places it (newWindow), else the default.
 * `hidden`: loaded but not shown, as after a restart for an update while hidden (#408).
 */
function createWindow(bounds?: { x: number; y: number; width: number; height: number }, hidden = false): BrowserWindow {
  limitPermissions(session.fromPartition(PARTITION));
  const w = new BrowserWindow({
    ...(bounds ?? { width: 1280, height: 860 }),
    show: !hidden,
    title: 'Ledung',
    backgroundColor: '#1b1d22',
    // The window's and the Windows taskbar's icon; the Mac takes the Dock's, set at start (#384).
    icon: APP_ICON,
    // Windows and Linux draw the menu inside the window. It is never shown there, and Alt does not show it, so Alt
    // stays free for a key of Ledung's own later (Martin, 2026-11-19 01:09 on #384, issue #389). No auto-hide: that is
    // what made Alt show it. The Mac ignores both: its menu is the system's.
    autoHideMenuBar: false,
    webPreferences: {
      // The same partition in every window: one sign-in, one set of cookies (#414).
      session: session.fromPartition(PARTITION),
      contextIsolation: true,
      sandbox: true,
      // Functions for the page: `ledungDesktop.showWindow()`, which a click on its notification calls (#360),
      // `ledungDesktop.newWindow()`, the New window button's (#414), and in a made app `restartForUpdate()` (#408).
      preload: PRELOAD,
      // A made app's page also gets `ledungDesktop.restartForUpdate()` (#408); the preload reads this.
      additionalArguments: made ? [MADE_APP_ARG] : [],
      nodeIntegration: false,
      // A hidden window keeps its timers at full speed, so notifications come on time (Windows spike: one 13–14 ms
      // after a prompt, 400 s hidden). The page also stays "visible" then, so its polls keep running (#359).
      backgroundThrottling: false,
    },
  });
  windows.add(w);
  // Hidden, not removed: the hidden menu's accelerators still work (Ctrl+N, Ctrl+W, Alt+F4, copy and paste, zoom), and
  // with auto-hide off nothing shows it again (#389).
  if (process.platform !== 'darwin') w.setMenuBarVisibility(false);
  const contents = w.webContents;
  lockNavigation(contents);
  w.on('focus', () => windows.focused(w));
  w.on('close', (event) => {
    if (quitting) return;
    if (windows.closeHides(w)) {
      event.preventDefault();
      hideWindow(w);
      return;
    }
    // Closing for real: out of the list now, not at `closed`, so a second window closed straight after this one is
    // the last and hides, and the app never ends by its windows closing (#414).
    windows.remove(w);
  });
  // Windows: logging off or shutting down closes the window; let it, or the app would hold the logoff up.
  w.on('session-end', () => {
    quitting = true;
    sessionEnding = true;
  });
  // A page with unsaved changes (the flow builder's) asks before it is left, by quitting, reloading or closing a
  // window that closes for real (#414). A browser asks the person then; Electron would silently stay instead, and a
  // cancelled quit would leave `quitting` set, so the next close would end the app instead of hiding it (self-check
  // finding 1). Ask as a browser does; Stay keeps everything.
  contents.on('will-prevent-unload', (event) => {
    // Logging off: leave without asking, or the question would hold the logoff up (code review of PR #372, Minor 2).
    if (sessionEnding) {
      event.preventDefault();
      return;
    }
    // The question belongs to the window: asked of a hidden one (⌘W, then Quit from the Dock) it may never be seen,
    // and the app would wait on it for good (code review of PR #372, Minor 2). Show the window first.
    showWindow(w);
    const choice = dialog.showMessageBoxSync(w, {
      type: 'question',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      message: 'Leave this page?',
      detail: 'Changes you made may not be saved.',
    });
    if (choice === 0) event.preventDefault();
    else {
      quitting = false;
      // A restart for an update waits too (#408), until the page asks again at its next connection: not at the next
      // hide, which would ask the same question again (self-check finding 5).
      restartOnQuit = false;
      restartAppOnly = false;
      updatePending = false;
      // A window that was closing stays: back in the list (#414).
      if (!windows.has(w)) windows.add(w);
    }
  });
  contents.on('before-input-event', (event, input) => windowKeys(w, event, input, false));
  // A right-click gets a menu as in a browser (#447); Electron shows none of its own.
  contents.on('context-menu', (_event, params) => showContextMenu(w, contents, params));
  // The bar's count: answers to its own search only (desktop/find.ts).
  contents.on('found-in-page', (_event, result) => {
    const bar = findBars.get(w);
    const line = bar?.open ? bar.search.answer(result) : null;
    if (bar && line !== null) bar.view.webContents.send('ledung-find:count', line);
  });
  // A new page in the window (a reload, the "not running" page): its highlights are gone, so the bar closes too.
  contents.on('did-navigate', () => closeFind(w));
  // Ctrl and the mouse wheel: Electron only reports it, and zooms nothing unless the app does (#389). Off the Mac,
  // which is unchanged.
  contents.on('zoom-changed', (_event, direction) => {
    if (process.platform !== 'darwin') contents.zoomLevel = zoomed(contents.zoomLevel, direction);
  });
  w.on('closed', () => windows.remove(w));
  // The last window out of sight lets a waiting update restart the app (#408).
  w.on('hide', restartIfHidden);
  w.on('minimize', restartIfHidden);
  // A window opened while a start runs (the Dock, New Window) shows that it runs; the start shows the outcome in it.
  if (starting) void loadNotRunning(w, 'Starting Ledung in the background…', 'starting');
  // An attach under way: it shows this window what it found when it ends.
  else if (attaching) waitingForAttach.add(w);
  // Attached already (New Window, #414): this window shows the page; the partition is signed in.
  else if (ownOrigin !== null) showCurrent(w);
  // Not attached: find the Ledung, which loads every window in the list, this one too.
  else void attach();
  return w;
}

/**
 * The window a message from the preload came from, when Ledung's own page asked in its top frame: not the "not
 * running" page, and not a frame of anything else (#360). Null for any other sender.
 */
function askingWindow(event: IpcMainEvent): BrowserWindow | null {
  const frame = event.senderFrame;
  const w = BrowserWindow.fromWebContents(event.sender);
  if (!w || w.isDestroyed() || !windows.has(w) || event.sender !== w.webContents || !frame || frame.parent !== null || !sameOrigin(frame.url)) return null;
  return w;
}

// One app per computer: a second start shows the first one's window and ends (#359). Asked before anything else, so
// the second never opens a window or signs in.
if (shortcutFile) {
  // Only the shortcut, then quit: no window, no single-instance lock (a running app keeps its own). The target is this
  // program, with the app's id, so Windows names its notifications "Ledung" (#587).
  void app.whenReady().then(() => {
    let ok = false;
    try {
      fs.mkdirSync(path.dirname(shortcutFile), { recursive: true });
      ok = shell.writeShortcutLink(shortcutFile, 'create', { target: process.execPath, appUserModelId: APP_ID, icon: process.execPath, iconIndex: 0, description: 'Ledung' });
    } catch (e) {
      console.error(`Ledung desktop: ${(e as Error).message}`);
    }
    app.exit(ok ? 0 : 1);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second start brings the most recently used window forward (#414).
  app.on('second-instance', () => showWindow());
  // A click on one of the page's notifications (#360) shows the window whose page showed it: the page then opens the
  // session it was about there.
  ipcMain.on(SHOW_WINDOW_MESSAGE, (event) => {
    const w = askingWindow(event);
    if (w) showWindow(w);
  });
  // The page's New window button (#414).
  ipcMain.on(NEW_WINDOW_MESSAGE, (event) => {
    if (askingWindow(event)) newWindow();
  });
  // The page saw that Ledung was updated and this app runs the old code (#408): `now` from its Restart button, else
  // the app restarts once no window is in sight, at once if none is now.
  ipcMain.on(RESTART_FOR_UPDATE_MESSAGE, (event, now: unknown) => {
    if (!askingWindow(event) || !made) return;
    updatePending = true;
    if (now === true) restartForUpdate();
    else restartIfHidden();
  });
  // The find bar's text, steps and close (#445).
  ipcMain.on(FIND_QUERY_MESSAGE, (event, text: unknown) => {
    const w = findBarWindow(event);
    const bar = w ? findBars.get(w) : undefined;
    if (w && bar && typeof text === 'string') findInPage(w, bar, bar.search.query(text));
  });
  ipcMain.on(FIND_STEP_MESSAGE, (event, forward: unknown) => {
    const w = findBarWindow(event);
    if (w) findAction(w, forward === true ? 'next' : 'previous');
  });
  ipcMain.on(FIND_CLOSE_MESSAGE, (event) => {
    const w = findBarWindow(event);
    if (w) closeFind(w);
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  // Every window has closed and nothing kept the quit: the restart for an update may go (#408).
  app.on('will-quit', () => {
    if (restartOnQuit) startAfterQuit();
  });
  // Reached only while quitting, since closing the last window hides it (#414: the list counts one closing as gone).
  app.on('window-all-closed', () => app.quit());
  // Started hidden after a restart for an update (#408): the start itself is no reason to show it.
  // Only a fresh marker counts: one a failed restart left behind must not hide a later start by hand (self-check
  // finding 2). Ten minutes covers the wait for this app to end and a new Electron's download.
  let startedHidden = false;
  try {
    startedHidden = Date.now() - fs.statSync(START_HIDDEN).mtimeMs < 10 * 60_000;
    fs.rmSync(START_HIDDEN, { force: true });
  } catch {
    // Not there: a usual start.
  }
  let readyAt = 0;
  // A click on the app in the Dock (Mac), the windows hidden or not: the most recently used comes forward (#414). The
  // Mac may count the launch itself as one; a hidden restart ignores that first moment.
  app.on('activate', () => {
    if (startedHidden && Date.now() - readyAt < 2000) return;
    showWindow();
  });
  // Started from a shortcut, a pin, Launchpad or Finder after an npm update (#455): this app still has the old version's
  // code. It restarts at once, before any window, through the `ledung` that made it, which writes the installed
  // version's code into it and opens it; only once per version in ten minutes, so a restart that could not bring it
  // leaves this app running its own code (made.ts updateAtStart).
  const own = app.getVersion();
  const installed = made ? installedVersion(made.cli) : null;
  const updateNow = made !== null && restartCommand(made, process.pid, true) !== null && updateAtStart({ own, installed, tried: readStartUpdate(START_UPDATE), now: Date.now() });
  if (!updateNow && installed === own) {
    try {
      fs.rmSync(START_UPDATE, { force: true });
    } catch {
      // Held for a moment (a virus scanner on Windows): left for the next start; a throw here would stop every start.
    }
  }
  void app.whenReady().then(() => {
    if (updateNow) {
      try {
        fs.mkdirSync(path.dirname(START_UPDATE), { recursive: true });
        fs.writeFileSync(START_UPDATE, `${installed}\n`);
      } catch (e) {
        // Without the note a failed restart is tried again at the next start, not in a loop: the next start is a person's.
        console.error(`Ledung desktop: ${(e as Error).message}`);
      }
      console.error(`Ledung desktop: this app runs Ledung ${own} and ${installed} is installed; restarting to take it.`);
      // An app that was itself restarting hidden (#408) comes back hidden; one a person opened comes back shown.
      hiddenAtRestart = startedHidden;
      restartOnQuit = true;
      restartAppOnly = true;
      quit();
      return;
    }
    readyAt = Date.now();
    Menu.setApplicationMenu(buildMenu());
    // Run from a clone the app is Electron's own, with Electron's icon in the Dock until it is told otherwise (#384),
    // and the Dock draws what it is given edge to edge, so it gets the margin Mac app icons carry (#404).
    if (process.platform === 'darwin') app.dock?.setIcon(dockIcon());
    createWindow(undefined, startedHidden);
  });
}
