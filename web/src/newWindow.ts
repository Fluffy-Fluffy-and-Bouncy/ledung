// The sidebar footer's New window button (#414), beside the ⚙: another window of the page. In the desktop app it asks
// the app for another app window through the preload (desktop/preload.cjs); in a browser it opens the page in a new
// window or tab. The app's own key for it is ⌘N on the Mac and Ctrl+N elsewhere (desktop/menu.ts); in a browser the
// same keys open the browser's own new window.
//
// In a linked computer's tab (#454) the button is that computer's page, in a frame (ComputerTabs.tsx), which has no
// preload of its own: the app gives it only to its own top-level page. So the framed page asks the page around it
// whether it is the app, once as it starts, and if it is, its New window asks that page to open the window, which it
// does through its own preload: a window of the app on the clicker's computer, at this computer's start page (Martin,
// 2026-11-20 08:14, Ledung question #708: "b — Ready now, open at the start page"). Only between a frame and the page
// around it, each checking the other's window and origin; nothing reaches either Ledung's server. Where the page
// around it is a browser, or an older Ledung that does not answer, the frame keeps the browser's way.

const DESKTOP_ASK = 'ledung:desktop?';
const DESKTOP = 'ledung:desktop';
const NEW_WINDOW = 'ledung:new-window';

export type FramingAppMessage = { type: typeof DESKTOP_ASK } | { type: typeof DESKTOP } | { type: typeof NEW_WINDOW };

/** The page around a frame, where that page is the desktop app's: its window and its origin, to post to. */
export interface FramingApp {
  parent: { postMessage: (msg: FramingAppMessage, targetOrigin: string) => void };
  origin: string;
}

/** The part of `window` the button uses, so the tests can hand it a stand-in. */
export interface NewWindowHost {
  ledungDesktop?: { showWindow?: () => void; newWindow?: () => void };
  location: { origin: string };
  open: (url: string, target: string, features: string) => unknown;
}

/**
 * Opens another window: the app's own when the page runs in the desktop app, or when it is in a frame of the app's
 * page (#454), which then opens it; else the page's start in a new browser window or tab, with no link back to this
 * one. Says which it did.
 */
export function openNewWindow(host: NewWindowHost, framing: FramingApp | null = framingApp): 'app' | 'framing app' | 'browser' {
  const ask = host.ledungDesktop?.newWindow;
  if (typeof ask === 'function') {
    ask();
    return 'app';
  }
  if (framing) {
    framing.parent.postMessage({ type: NEW_WINDOW }, framing.origin);
    return 'framing app';
  }
  host.open(`${host.location.origin}/`, '_blank', 'noopener');
  return 'browser';
}

/** A Mac (or an iPad, whose keyboards use ⌘ too), by what the browser reports. */
export function isMacLike(nav: { platform?: string; userAgent: string }): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(nav.platform || nav.userAgent);
}

/** The button's tooltip, with the key the app opens a new window on (#414: "New window (⌘N)" / "(Ctrl+N)"). */
export function newWindowTitle(mac: boolean): string {
  return `New window (${mac ? '⌘N' : 'Ctrl+N'})`;
}


const record = (data: unknown): Record<string, unknown> | null =>
  typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : null;

// The page around the frame: this computer's own page (#454).

/**
 * The framing page's handling of a message from a computer's frame: only from that frame's window, at that computer's
 * origin (as framePaired), and only where this page is the app's, with a New window of its own. Its ask is answered
 * that it is; its New window opens one here, when a click in the frame is what sent it (`active`: the click's user
 * activation, which reaches the frames around it), so a page in a frame cannot open windows on its own. Says whether
 * the message was one of these.
 */
export function framedNewWindow(
  msg: { data: unknown; origin: string; fromFrame: boolean }, computerUrl: string, host: Pick<NewWindowHost, 'ledungDesktop'>,
  reply: (answer: FramingAppMessage) => void, active: boolean,
): boolean {
  let origin: string;
  try { origin = new URL(computerUrl).origin; } catch { return false; }
  const ask = host.ledungDesktop?.newWindow;
  if (!msg.fromFrame || msg.origin !== origin || typeof ask !== 'function') return false;
  const type = record(msg.data)?.type;
  if (type === DESKTOP_ASK) reply({ type: DESKTOP });
  else if (type === NEW_WINDOW) { if (active) ask(); }
  else return false;
  return true;
}

// The framed page: another computer's page in this one's tab.

/** The page around this one, once it has said it is the app's; null until then, and outside a frame. */
let framingApp: FramingApp | null = null;

/** Whether a message is the page around this frame saying it is the app's: only from window.parent. */
export function framingAppAnswered(data: unknown, fromParent: boolean): boolean {
  return fromParent && record(data)?.type === DESKTOP;
}

/**
 * In a frame, asks the page around this one whether it is the desktop app's, and keeps its answer for New window. The
 * ask carries nothing and goes to any origin: only the pages frame-ancestors allows can frame this one, and only
 * window.parent's answer counts, kept with its origin so the New window ask goes there alone.
 */
export function followFramingApp(w: Pick<Window, 'addEventListener'> & { parent: FramingApp['parent'] } = window as never): void {
  w.addEventListener('message', (e) => {
    if (!framingAppAnswered(e.data, e.source === w.parent)) return;
    framingApp = { parent: w.parent, origin: e.origin };
  });
  w.parent.postMessage({ type: DESKTOP_ASK }, '*');
}
