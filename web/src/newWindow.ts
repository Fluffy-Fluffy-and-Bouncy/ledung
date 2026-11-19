// The sidebar footer's New window button (#414), beside the ⚙: another window of the page. In the desktop app it asks
// the app for another app window through the preload (desktop/preload.cjs); in a browser it opens the page in a new
// window or tab. The app's own key for it is ⌘N on the Mac and Ctrl+N elsewhere (desktop/menu.ts); in a browser the
// same keys open the browser's own new window.

/** The part of `window` the button uses, so the tests can hand it a stand-in. */
export interface NewWindowHost {
  ledungDesktop?: { showWindow?: () => void; newWindow?: () => void };
  location: { origin: string };
  open: (url: string, target: string, features: string) => unknown;
}

/**
 * Opens another window: the app's own when the page runs in the desktop app, else the page's start in a new browser
 * window or tab, with no link back to this one. Says which it did.
 */
export function openNewWindow(host: NewWindowHost): 'app' | 'browser' {
  const ask = host.ledungDesktop?.newWindow;
  if (typeof ask === 'function') {
    ask();
    return 'app';
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

