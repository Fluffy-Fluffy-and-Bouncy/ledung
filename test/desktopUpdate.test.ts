// The page's side of updating Ledung with the desktop app open (#408, web/src/desktopUpdate.ts): only a page in the
// made app, with the core saying that app is out of date, gets the app's restart; a browser and an up-to-date app don't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopRestart, type DesktopUpdateHost } from '../web/src/desktopUpdate.ts';

test("in the made app after an update the page gets the app's restart, which passes `now` on", () => {
  const asked: (boolean | undefined)[] = [];
  const host: DesktopUpdateHost = { ledungDesktop: { restartForUpdate: (now) => asked.push(now) } };
  const restart = desktopRestart(host, { stale: true, notice: null });
  assert.ok(restart);
  restart(false);
  restart(true);
  assert.deepEqual(asked, [false, true]);
});

test('no restart in a browser, in an app run from a clone, or when the app is up to date', () => {
  const asked: unknown[] = [];
  const made: DesktopUpdateHost = { ledungDesktop: { restartForUpdate: (now) => asked.push(now) } };
  assert.equal(desktopRestart(made, { stale: false, notice: null }), null, 'Restart Ledung alone: up to date');
  assert.equal(desktopRestart(made, null), null, 'no app made here');
  for (const host of [{}, { ledungDesktop: {} }] as DesktopUpdateHost[]) {
    assert.equal(desktopRestart(host, { stale: true, notice: null }), null, JSON.stringify(host));
  }
  assert.deepEqual(asked, [], 'nothing was asked of the app');
});
