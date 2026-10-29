// "Install as app" (issue #350; Martin, 2026-10-27 22:13, Ledung question #299: "a — Install button + Safari
// hint"). A page can't install itself: Edge and Chrome hand it an install offer (beforeinstallprompt) whose prompt
// opens their own dialog, and Safari on macOS has only File → Add to Dock. Pure decisions, kept apart from the
// browser so they can be tested.

export const INSTALL_DISMISSED_KEY = 'ledung.installDismissed';

/** What the browser says about this page. */
export type InstallEnv = {
  /** Runs as an installed app already (display-mode standalone, or iOS's navigator.standalone). */
  standalone: boolean;
  /** The browser said it was installed while this page was open (appinstalled, or the dialog accepted). */
  installed: boolean;
  /** The browser handed over an install offer that hasn't been used yet. */
  offer: boolean;
  /** The browser's install dialog was refused in this visit, and no new offer has come since. */
  refused: boolean;
  /** Shown in a frame on another computer's page: that page offers it, not this one. */
  framed: boolean;
  /** HTTPS or 127.0.0.1: browsers offer installing only there. */
  secure: boolean;
  userAgent: string;
  /** An iPad asking for the desktop site says Macintosh too; only it has a touch screen. */
  maxTouchPoints: number;
};

/**
 * What to show: `button` opens the browser's dialog; `dock` is Safari's File → Add to Dock hint; `none` shows
 * nothing, with `reason` saying why for Settings (absent when there is nothing to say, as when it is installed).
 */
export type Install = { kind: 'button' } | { kind: 'dock' } | { kind: 'none'; reason?: string };

const isSafariMac = (ua: string, touch: number) =>
  /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua) && touch <= 1;
const isIos = (ua: string, touch: number) => /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1);
const isChromium = (ua: string) => /Chrome|Chromium|Edg\//.test(ua);

export function installOffer(env: InstallEnv): Install {
  if (env.standalone || env.installed) return { kind: 'none' };
  if (env.framed) return { kind: 'none', reason: "Install this computer's own page, opened in a tab of its own." };
  if (env.offer) return { kind: 'button' };
  // Not "installed already or not allowed": the person just said no (review of #351).
  if (env.refused) return { kind: 'none', reason: 'Refused for now. Reload the page to be offered it again.' };
  // Add to Dock works on any page, plain http too.
  if (isSafariMac(env.userAgent, env.maxTouchPoints)) return { kind: 'dock' };
  if (isIos(env.userAgent, env.maxTouchPoints)) return { kind: 'none', reason: 'On an iPhone or iPad, use Share → Add to Home Screen in Safari.' };
  if (!env.secure) return { kind: 'none', reason: 'Browsers offer installing only a page at 127.0.0.1 or over HTTPS; this one is plain http.' };
  if (isChromium(env.userAgent)) {
    return { kind: 'none', reason: "The browser isn't offering to install this page: it is installed already, or not allowed here. The install icon in the address bar says which." };
  }
  return { kind: 'none', reason: "This browser can't install pages as apps; Edge, Chrome and Safari on macOS can." };
}

/** The parts of `localStorage` used here, so tests can pass their own. */
export type InstallStore = Pick<Storage, 'getItem' | 'setItem'>;

/** Whether "Not now" was pressed on the start notice in this browser. */
export function readDismissed(store: InstallStore): boolean {
  try { return store.getItem(INSTALL_DISMISSED_KEY) === '1'; } catch { return false; }
}

export function saveDismissed(store: InstallStore): void {
  try { store.setItem(INSTALL_DISMISSED_KEY, '1'); } catch { /* private mode: kept for this visit only */ }
}

/** The start notice shows what Settings shows, until it is dismissed; never a reason, only a button or the hint. */
export const showsNotice = (install: Install, dismissed: boolean): boolean => !dismissed && install.kind !== 'none';
