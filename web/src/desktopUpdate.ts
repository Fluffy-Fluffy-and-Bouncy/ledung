// Updating Ledung with the desktop app open (#408): after Update Ledung the core runs the new version, but the app's
// own code is the old one until the app restarts. The core says so in hello (desktopApp.stale); in the made app the page
// then asks the app, through its preload (desktop/preload.cjs), to restart its window once no window is in sight, and
// offers Restart for a window in front (Martin, 2026-11-19, Ledung question #593: "restart by itself when hidden, ask
// when in front"). A browser, or the app run from a clone, has no such function and shows nothing for it.
import type { DesktopAppInfo } from '../../src/shared/protocol.ts';

/** The part of `window` this uses, so the tests can hand it a stand-in. */
export interface DesktopUpdateHost {
  ledungDesktop?: { restartForUpdate?: (now?: boolean) => void };
}

/** The app's restart when this page is in the made app and that app is out of date; null otherwise. */
export function desktopRestart(host: DesktopUpdateHost, info: DesktopAppInfo | null): ((now: boolean) => void) | null {
  const restart = host.ledungDesktop?.restartForUpdate;
  if (!info?.stale || typeof restart !== 'function') return null;
  return (now) => restart(now);
}

/** The banner's line in the app: its window restarts to take the update. */
export const RESTART_LINE = 'Ledung was updated — restart the window to finish the update';
