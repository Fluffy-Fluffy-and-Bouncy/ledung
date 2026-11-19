// "Install as app" (issue #350): what the page offers in each browser, and the start notice's "Not now".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_DISMISSED_KEY, dismissKey, INSTALL_DISMISSED_KEY, installOffer, readDismissed, saveDismissed, showsNotice, type InstallEnv } from '../web/src/installApp.ts';

// Real user agents of the browsers the issue names.
const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
  // Electron's default form (app name and version, Chrome/, Electron/): the desktop app sets none of its own (#374).
  electronMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ledung-desktop/0.0.0 Chrome/140.0.7339.249 Electron/45.3.3 Safari/537.36',
  electronWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ledung-desktop/0.0.0 Chrome/140.0.7339.249 Electron/45.3.3 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

const env = (over: Partial<InstallEnv>): InstallEnv => ({
  standalone: false, installed: false, offer: false, refused: false, framed: false, secure: true, userAgent: UA.chrome, maxTouchPoints: 0, ...over,
});

test('Edge and Chrome with an install offer show the button', () => {
  assert.deepEqual(installOffer(env({ offer: true })), { kind: 'button' });
  assert.deepEqual(installOffer(env({ offer: true, userAgent: UA.edge })), { kind: 'button' });
});

test('installed, or running as an app, shows nothing and no reason', () => {
  for (const over of [{ standalone: true }, { installed: true }, { standalone: true, userAgent: UA.safariMac }]) {
    assert.deepEqual(installOffer(env({ offer: true, ...over })), { kind: 'none' });
  }
});

test('the desktop app (Electron) shows nothing and no reason, where the same page in Chrome says why', () => {
  for (const userAgent of [UA.electronMac, UA.electronWin]) {
    for (const over of [{}, { secure: false }, { framed: true }, { refused: true }, { offer: true }]) {
      const r = installOffer(env({ userAgent, ...over }));
      assert.deepEqual(r, { kind: 'none' });
      assert.equal(showsNotice(r, false), false);
    }
  }
  // The positive branch: Chrome with the same page and no offer gives the address-bar reason the app must not show.
  for (const userAgent of [UA.chrome, UA.chromeMac]) {
    const chrome = installOffer(env({ userAgent }));
    assert.equal(chrome.kind, 'none');
    assert.match((chrome as { reason: string }).reason, /address bar/);
  }
});

test('Safari on macOS gets the Add to Dock hint, over plain http too', () => {
  assert.deepEqual(installOffer(env({ userAgent: UA.safariMac })), { kind: 'dock' });
  assert.deepEqual(installOffer(env({ userAgent: UA.safariMac, secure: false })), { kind: 'dock' });
});

test('an iPad asking for the desktop site is not Safari on macOS', () => {
  const r = installOffer(env({ userAgent: UA.safariMac, maxTouchPoints: 5 }));
  assert.equal(r.kind, 'none');
  assert.match((r as { reason: string }).reason, /Add to Home Screen/);
  const iphone = installOffer(env({ userAgent: UA.iphone, maxTouchPoints: 5 }));
  assert.equal(iphone.kind, 'none');
  assert.match((iphone as { reason: string }).reason, /Add to Home Screen/);
});

test('Chrome on a Mac is not Safari', () => {
  assert.equal(installOffer(env({ userAgent: UA.chromeMac })).kind, 'none');
  assert.equal(installOffer(env({ userAgent: UA.chromeMac, offer: true })).kind, 'button');
});

test('no offer: Settings says why, and the start notice shows nothing', () => {
  const http = installOffer(env({ secure: false }));
  assert.equal(http.kind, 'none');
  assert.match((http as { reason: string }).reason, /plain http/);
  const firefox = installOffer(env({ userAgent: UA.firefoxMac }));
  assert.match((firefox as { reason: string }).reason, /can't install/);
  const framed = installOffer(env({ framed: true, offer: true }));
  assert.equal(framed.kind, 'none');
  for (const r of [http, firefox, framed, installOffer(env({}))]) assert.equal(showsNotice(r, false), false);
});

test('a refused install dialog says so in Settings, and a new offer brings the button back', () => {
  const r = installOffer(env({ refused: true }));
  assert.equal(r.kind, 'none');
  assert.match((r as { reason: string }).reason, /Refused for now/);
  assert.equal(showsNotice(r, false), false);
  assert.deepEqual(installOffer(env({ refused: true, offer: true })), { kind: 'button' });
});

test('the start notice shows the button or the hint until "Not now", which is remembered', () => {
  const store = new Map<string, string>();
  const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.equal(readDismissed(s), false);
  assert.equal(showsNotice({ kind: 'button' }, readDismissed(s)), true);
  assert.equal(showsNotice({ kind: 'dock' }, readDismissed(s)), true);
  saveDismissed(s);
  assert.equal(store.get(INSTALL_DISMISSED_KEY), '1');
  assert.equal(showsNotice({ kind: 'button' }, readDismissed(s)), false);
  assert.equal(showsNotice({ kind: 'dock' }, readDismissed(s)), false);
});

test('a storage that throws (private mode) is not dismissed and does not break', () => {
  const s = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } };
  assert.equal(readDismissed(s), false);
  assert.doesNotThrow(() => saveDismissed(s));
});

// "Open in the Ledung app" (#409): on the computer Ledung runs on, with the app made there, the page points at it.

test('a browser on the computer with the app made points at the app, in every browser and over plain http', () => {
  for (const userAgent of [UA.chrome, UA.edge, UA.chromeMac, UA.safariMac, UA.firefoxMac]) {
    for (const over of [{}, { offer: true }, { secure: false }, { refused: true }, { standalone: true }, { installed: true }]) {
      const r = installOffer(env({ userAgent, desktopHere: true, ...over }));
      assert.deepEqual(r, { kind: 'desktop' }, `${userAgent} ${JSON.stringify(over)}`);
      assert.equal(showsNotice(r, false), true);
    }
  }
});

test('the app itself, a frame on another computer and a page not told so get no pointer; they keep what they had', () => {
  // The app's own window: nothing, as before.
  for (const userAgent of [UA.electronMac, UA.electronWin]) assert.deepEqual(installOffer(env({ userAgent, desktopHere: true })), { kind: 'none' });
  // In a frame: this computer's own page is not where the person is.
  assert.equal(installOffer(env({ framed: true, desktopHere: true })).kind, 'none');
  // Not told (a phone, another computer, no app made): the install offer as before.
  assert.deepEqual(installOffer(env({ offer: true, desktopHere: false })), { kind: 'button' });
  assert.deepEqual(installOffer(env({ userAgent: UA.safariMac })), { kind: 'dock' });
  // Premise: the same page told so points at the app.
  assert.deepEqual(installOffer(env({ offer: true, desktopHere: true })), { kind: 'desktop' });
});

test('"Not now" on the app is remembered apart from the install notice\'s', () => {
  const store = new Map<string, string>();
  const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.equal(dismissKey({ kind: 'desktop' }), DESKTOP_DISMISSED_KEY);
  for (const kind of ['button', 'dock', 'none'] as const) assert.equal(dismissKey({ kind }), INSTALL_DISMISSED_KEY);
  assert.notEqual(DESKTOP_DISMISSED_KEY, INSTALL_DISMISSED_KEY);
  // The install notice dismissed earlier: the app's pointer still shows once.
  saveDismissed(s);
  assert.equal(readDismissed(s, DESKTOP_DISMISSED_KEY), false);
  assert.equal(showsNotice({ kind: 'desktop' }, readDismissed(s, DESKTOP_DISMISSED_KEY)), true);
  saveDismissed(s, DESKTOP_DISMISSED_KEY);
  assert.equal(store.get(DESKTOP_DISMISSED_KEY), '1');
  assert.equal(showsNotice({ kind: 'desktop' }, readDismissed(s, DESKTOP_DISMISSED_KEY)), false);
});
