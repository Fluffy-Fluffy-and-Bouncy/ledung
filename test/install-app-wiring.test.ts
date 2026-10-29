// "Install as app" (issue #350, review of #351): the page's wiring to the browser, not just the rule. The real
// module is loaded against a stub browser (window, matchMedia, navigator, localStorage) and given the events Edge
// and Chrome send: the install offer, the dialog's answer and appinstalled. Each test loads its own copy of the
// module (a query on its address) on its own window, since the module keeps its state from when it loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTALL_DISMISSED_KEY } from '../web/src/installApp.ts';

type Module = typeof import('../web/src/useInstallApp.ts');
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
let loads = 0;

async function load() {
  const g = globalThis as unknown as Record<string, unknown>;
  const win = Object.assign(new EventTarget(), { isSecureContext: true });
  const stored = new Map<string, string>();
  g.window = win;
  g.matchMedia = () => ({ matches: false, addEventListener: () => {} });
  g.localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: CHROME, maxTouchPoints: 0 } });
  const mod = (await import(`../web/src/useInstallApp.ts?load=${++loads}`)) as Module;
  /** An install offer as Chrome sends it, answering its dialog with `outcome`. */
  const offer = (outcome: 'accepted' | 'dismissed') => {
    const e = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompts: 0,
      prompt: async () => { e.prompts++; },
      userChoice: Promise.resolve({ outcome }),
    });
    win.dispatchEvent(e);
    return e;
  };
  return { ...mod, win, stored, offer };
}

test('the offer shows the button; Not now is remembered and Settings keeps it; a refused dialog says so', async () => {
  const { installState, install, dismiss, stored, offer } = await load();
  // No offer yet: Chrome says why in Settings, no notice.
  assert.equal(installState().install.kind, 'none');
  assert.equal(installState().notice, false);

  // The offer: the browser's own banner held back, the button and the notice shown.
  const first = offer('dismissed');
  assert.equal(first.defaultPrevented, true);
  assert.deepEqual(installState().install, { kind: 'button' });
  assert.equal(installState().notice, true);

  // Not now: remembered in the browser, the notice gone, Settings keeps the button.
  dismiss();
  assert.equal(stored.get(INSTALL_DISMISSED_KEY), '1');
  assert.equal(installState().notice, false);
  assert.deepEqual(installState().install, { kind: 'button' });

  // The dialog refused: Settings says so, not "installed already".
  await install();
  assert.equal(first.prompts, 1);
  const refused = installState().install;
  assert.equal(refused.kind, 'none');
  assert.match((refused as { reason: string }).reason, /Refused for now/);

  // A new offer brings the button back.
  offer('dismissed');
  assert.deepEqual(installState().install, { kind: 'button' });
});

test('an accepted dialog hides everything, with no reason', async () => {
  const { installState, install, offer } = await load();
  const e = offer('accepted');
  assert.equal(installState().notice, true);
  await install();
  assert.equal(e.prompts, 1);
  assert.deepEqual(installState().install, { kind: 'none' });
  assert.equal(installState().notice, false);
});

test('appinstalled (installed from the address bar) hides everything, and a later offer does not bring it back', async () => {
  const { installState, win, offer } = await load();
  offer('dismissed');
  assert.equal(installState().notice, true);
  win.dispatchEvent(new Event('appinstalled'));
  assert.deepEqual(installState().install, { kind: 'none' });
  assert.equal(installState().notice, false);
  offer('dismissed');
  assert.deepEqual(installState().install, { kind: 'none' });
});
