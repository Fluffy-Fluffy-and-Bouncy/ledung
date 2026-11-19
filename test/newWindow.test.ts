// The sidebar footer's New window button (issue #414, web/src/newWindow.ts): in the desktop app it asks the app for
// another window, in a browser it opens the page in a new window or tab; its tooltip names the app's key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMacLike, newWindowTitle, openNewWindow, type NewWindowHost } from '../web/src/newWindow.ts';

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
