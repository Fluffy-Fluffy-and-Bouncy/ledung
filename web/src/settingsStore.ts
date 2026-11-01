// Where Settings → Look's choices are saved (issue #459, frameSettings.ts): this browser's storage, and in a frame
// also the page that frames this one, which keeps them where an iPhone does not drop them.
import { answeredSettings, frameSettingsAsk, mirroredStore, ownSettings, takeSettings, type FrameSettingsMessage } from './frameSettings.ts';
import { inFrame } from './computerFrame.ts';

/** The framing page's origin, once it has answered; until then (or with no framing page) nothing is sent. */
let framingOrigin: string | null = null;

const send = (msg: FrameSettingsMessage) => {
  if (framingOrigin !== null) window.parent.postMessage(msg, framingOrigin);
};

/** Settings → Look saves through this: it reads and saves as localStorage does. */
export const settingsStore = mirroredStore(() => localStorage, send);

/**
 * In a frame, asks the page that frames this one for this computer's settings and takes them: the shared values
 * (useCompactSidebar and the others, the theme in main.tsx) re-read on a storage event with no key, as for a clear
 * in another tab. A framing page that keeps none yet gets this page's own; one that never answers (an older
 * Ledung) leaves everything as before.
 */
export function followFramingPage(): void {
  if (!inFrame()) return;
  window.addEventListener('message', (e) => {
    const settings = answeredSettings(e.data, e.source === window.parent);
    if (settings === undefined) return;
    framingOrigin = e.origin;
    if (settings === null) {
      for (const save of ownSettings(localStorage)) send(save);
      return;
    }
    takeSettings(localStorage, settings);
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  });
  // The ask carries nothing; only pages frame-ancestors allows can frame this one, and only window.parent's answer counts.
  window.parent.postMessage(frameSettingsAsk(), '*');
}
