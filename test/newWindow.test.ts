// The sidebar footer's New window button (issue #414, web/src/newWindow.ts): in the desktop app it asks the app for
// another window, in a browser it opens the page in a new window or tab; its tooltip names the app's key. In a linked
// computer's tab (#454) the page around the frame opens it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framedNewWindow, isMacLike, newWindowTitle, openNewWindow, type NewWindowHost } from '../web/src/newWindow.ts';

/** A stand-in for `window`, recording what the page opened itself. */
function host(ledungDesktop: NewWindowHost['ledungDesktop']) {
  const opened: Array<[string, string, string]> = [];
  const h: NewWindowHost = { location: { origin: 'http://127.0.0.1:4317' }, open: (url, target, features) => opened.push([url, target, features]), ledungDesktop };
  return { h, opened };
}

test('in the desktop app the button asks the app for a window and opens nothing in the page', () => {
  let asked = 0;
  const { h, opened } = host({ showWindow: () => {}, newWindow: () => asked++ });
  assert.equal(openNewWindow(h), 'app');
  assert.equal(asked, 1, 'the app was asked once');
  assert.deepEqual(opened, [], 'no browser window from the page');
});

test("in a browser it opens the page's start in a new window or tab, with no link back", () => {
  // A browser has no ledungDesktop; a preload without newWindow (an app made before #414) is treated as one.
  for (const desktop of [undefined, {}, { showWindow: () => {} }]) {
    const { h, opened } = host(desktop);
    assert.equal(openNewWindow(h), 'browser', JSON.stringify(desktop));
    assert.deepEqual(opened, [['http://127.0.0.1:4317/', '_blank', 'noopener']], 'the same Ledung, in a new browsing context');
  }
});

test('the tooltip says ⌘N on a Mac and Ctrl+N elsewhere (#414)', () => {
  assert.equal(newWindowTitle(true), 'New window (⌘N)');
  assert.equal(newWindowTitle(false), 'New window (Ctrl+N)');
  assert.equal(isMacLike({ platform: 'MacIntel', userAgent: '' }), true);
  assert.equal(isMacLike({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }), true, 'no platform: the user agent');
  assert.equal(isMacLike({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), false);
  assert.equal(isMacLike({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), false);
});

// New window in a linked computer's tab (#454): that computer's page is in a frame, with no preload; the page around
// it, this computer's own, opens the window through its own when it is the app's.

const LOCAL = 'http://127.0.0.1:4317';
const REMOTE = { url: 'https://second.l.example.test/', origin: 'https://second.l.example.test' };

type Module = typeof import('../web/src/newWindow.ts');
let loads = 0;

/**
 * The framed page as the browser starts it: a parent window whose postMessage goes to `toParent`, and a fresh copy of
 * the module (it keeps the framing page's answer) with followFramingApp run as App.tsx does in a frame.
 */
async function loadFrame(toParent: (msg: unknown, targetOrigin: string) => void) {
  const parent = { postMessage: toParent };
  const win = Object.assign(new EventTarget(), { parent });
  const mod = (await import(`../web/src/newWindow.ts?load=${++loads}`)) as Module;
  mod.followFramingApp(win as never);
  /** A message to the framed page, by default from its parent at this computer's origin. */
  const message = (data: unknown, origin = LOCAL, source: unknown = parent) =>
    win.dispatchEvent(Object.assign(new Event('message'), { data, origin, source }));
  const opened: string[] = [];
  const frameHost: NewWindowHost = { location: { origin: REMOTE.origin }, open: (url) => opened.push(url) };
  return { message, opened, click: () => mod.openNewWindow(frameHost) };
}

/**
 * This computer's page around the frame, handling each message as ComputerFrames does; `app`: it runs in the desktop
 * app with New window (else the given bridge, or none: a browser). Counts the app windows it opened and its answers.
 */
function framingPage(app: true | NewWindowHost['ledungDesktop']) {
  const answers: Array<{ answer: unknown; to: string }> = [];
  let windows = 0;
  const host = { ledungDesktop: app === true ? { newWindow: () => { windows++; } } : app };
  const take = (data: unknown, active: boolean, origin = REMOTE.origin, fromFrame = true) =>
    framedNewWindow({ data, origin, fromFrame }, REMOTE.url, host, (answer) => answers.push({ answer, to: origin }), active);
  return { take, answers, windows: () => windows };
}

test("in the app, New window in a linked computer's tab opens an app window here, through the page around it", async () => {
  const page = framingPage(true);
  const posted: string[] = [];
  // The page around it gets the frame's messages from that frame's window, at its origin; a click is user activation.
  const frame = await loadFrame((msg, to) => { posted.push(to); assert.equal(page.take(msg, true), true, `handled: ${JSON.stringify(msg)}`); });
  // The start ask went to the page around it, which answered that it is the app's, to that frame's origin alone.
  assert.deepEqual(page.answers, [{ answer: { type: 'ledung:desktop' }, to: REMOTE.origin }]);
  frame.message(page.answers[0]!.answer);
  assert.equal(frame.click(), 'framing app');
  assert.equal(page.windows(), 1, 'one app window, opened by the page around the frame');
  assert.deepEqual(frame.opened, [], 'no browser window from the frame');
  assert.deepEqual(posted, ['*', LOCAL], 'the ask to any framing page; New window only to the one that answered');
});

test('in a browser, or around an older Ledung, the frame keeps the browser way', async () => {
  // A browser page around it: no app, so no answer. An older Ledung around it never answers either.
  const page = framingPage(undefined);
  const asked: unknown[] = [];
  const frame = await loadFrame((msg) => { asked.push(msg); assert.equal(page.take(msg, true), false, 'not handled without the app'); });
  assert.deepEqual(asked, [{ type: 'ledung:desktop?' }], 'the frame did ask');
  assert.deepEqual(page.answers, [], 'and a browser did not answer');
  assert.equal(frame.click(), 'browser');
  assert.deepEqual(frame.opened, [`${REMOTE.origin}/`], "the linked computer's page in a new browser tab, as before #454");
  assert.equal(page.windows(), 0);
});

test("the frame takes only its parent's answer, and sends New window to that origin alone", async () => {
  const sent: Array<[unknown, string]> = [];
  const frame = await loadFrame((msg, to) => sent.push([msg, to]));
  frame.message({ type: 'ledung:desktop' }, LOCAL, {});
  frame.message({ type: 'ledung:other' });
  assert.equal(frame.click(), 'browser', 'an answer from another window, or another message, is not the app');
  frame.message({ type: 'ledung:desktop' });
  assert.equal(frame.click(), 'framing app', "the parent's answer is");
  assert.deepEqual(sent.at(-1), [{ type: 'ledung:new-window' }, LOCAL]);
  assert.equal(frame.opened.length, 1, 'only the first click opened a browser tab');
});

test("the page around the frame acts only for that computer's frame, at its origin, in the app, and on a click", () => {
  const page = framingPage(true);
  // The positive branch first: the same messages from the frame, at its origin, are taken.
  assert.equal(page.take({ type: 'ledung:desktop?' }, false), true);
  assert.equal(page.take({ type: 'ledung:new-window' }, true), true);
  assert.equal(page.windows(), 1);
  assert.equal(page.answers.length, 1);
  // Another window, another origin, something else: not taken, nothing opened, nothing answered.
  assert.equal(page.take({ type: 'ledung:new-window' }, true, REMOTE.origin, false), false, 'not from the frame');
  assert.equal(page.take({ type: 'ledung:new-window' }, true, 'https://evil.example.test'), false, 'another origin');
  assert.equal(page.take({ type: 'ledung:desktop?' }, true, 'https://evil.example.test'), false, 'another origin asking');
  assert.equal(page.take('ledung:new-window', true), false, 'not the message');
  // No click behind it (the frame sending on its own; Electron 45 probe: active false then, true after a click in the
  // frame): taken, but no window.
  assert.equal(page.take({ type: 'ledung:new-window' }, false), true);
  assert.equal(page.windows(), 1, 'no window without a click in the frame');
  assert.equal(page.answers.length, 1, 'and no answer to anyone else');
  // An app made before #414 has no newWindow: it does not say it is the app's.
  assert.equal(framingPage({ showWindow: () => {} }).take({ type: 'ledung:desktop?' }, true), false);
});
