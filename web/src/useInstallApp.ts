// "Install as app" (issue #350) as a shared value: the browser's install offer is caught when this module loads,
// before the first render, since Edge and Chrome send it once, early, and not again for the same page.
import { useSyncExternalStore } from 'react';
import { inFrame } from './computerFrame.ts';
import { DESKTOP_DISMISSED_KEY, dismissKey, INSTALL_DISMISSED_KEY, installOffer, readDismissed, saveDismissed, showsNotice, type Install } from './installApp.ts';

/** Edge and Chrome's install offer; not in TypeScript's DOM types. */
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

const standaloneQuery = matchMedia('(display-mode: standalone)');
let offer: InstallPrompt | null = null;
let installed = false;
let refused = false;
let dismissed = readDismissed(localStorage);
let desktopDismissed = readDismissed(localStorage, DESKTOP_DISMISSED_KEY);
/** What hello said last: the desktop app is made on this computer and this page is on its screen (#409). */
let desktopHere = false;
const listeners = new Set<() => void>();

const read = (): Install => installOffer({
  standalone: standaloneQuery.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
  installed,
  offer: offer !== null,
  refused,
  framed: inFrame(),
  secure: window.isSecureContext,
  userAgent: navigator.userAgent,
  maxTouchPoints: navigator.maxTouchPoints ?? 0,
  desktopHere,
});

const noticeFor = (install: Install) => showsNotice(install, install.kind === 'desktop' ? desktopDismissed : dismissed);
let current = { install: read(), notice: false };
const changed = () => {
  const install = read();
  current = { install, notice: noticeFor(install) };
  for (const l of listeners) l();
};
current.notice = noticeFor(current.install);

/** From hello (App.tsx): whether the desktop app is made here and this page is on this computer's screen (#409). */
export function setDesktopHere(here: boolean): void {
  if (here === desktopHere) return;
  desktopHere = here;
  changed();
}

window.addEventListener('beforeinstallprompt', (e) => {
  // The page shows its own button; the browser's own icon in the address bar stays.
  e.preventDefault();
  offer = e as InstallPrompt;
  refused = false;
  changed();
});
window.addEventListener('appinstalled', () => {
  installed = true;
  offer = null;
  changed();
});
standaloneQuery.addEventListener('change', changed);
window.addEventListener('storage', (e) => {
  if (e.key === INSTALL_DISMISSED_KEY || e.key === DESKTOP_DISMISSED_KEY || e.key === null) {
    dismissed = readDismissed(localStorage);
    desktopDismissed = readDismissed(localStorage, DESKTOP_DISMISSED_KEY);
    changed();
  }
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
/** The current state, outside React (the wiring test reads it: review of #351). */
export const installState = () => current;
const get = installState;

/** Opens the browser's install dialog. The offer can be used once; the browser sends a new one if it is refused. */
export async function install(): Promise<void> {
  const prompt = offer;
  if (!prompt) return;
  offer = null;
  await prompt.prompt();
  if ((await prompt.userChoice).outcome === 'accepted') installed = true;
  else refused = true;
  changed();
}

/** "Not now", for what the notice offers: the install, or the desktop app (#409); each remembered on its own. */
export const dismiss = () => {
  const key = dismissKey(current.install);
  saveDismissed(localStorage, key);
  if (key === DESKTOP_DISMISSED_KEY) desktopDismissed = true;
  else dismissed = true;
  changed();
};

/** What to offer (Settings), whether the start notice shows, and its two actions. */
export function useInstallApp(): { install: Install; notice: boolean; onInstall: () => Promise<void>; onDismiss: () => void } {
  const state = useSyncExternalStore(subscribe, get);
  return { ...state, onInstall: install, onDismiss: dismiss };
}
