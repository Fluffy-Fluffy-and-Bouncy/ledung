// The page's live connection while Ledung is away (#488): Martin, 2026-11-21 21:25 (Ledung question #112 on
// tubal-cain, "c — Banner only"): "retry faster (every 0.5 s while the server is away)", and a hidden window shown
// again reconnects at once. Before, the wait doubled up to 10 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryConnection, type Events } from '../web/src/reconnect.ts';

/** A stand-in for `document` or `window`: listeners by event name, fired by hand. */
function target(visibilityState = 'visible'): Events & { visibilityState: string; fire(type: string): void; count(): number } {
  const listeners = new Map<string, Set<() => void>>();
  return {
    visibilityState,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    fire(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    count() {
      return [...listeners.values()].reduce((n, s) => n + s.size, 0);
    },
  };
}

test('#488: while Ledung is away the page tries again every 0.5 s, the twentieth wait as short as the first (no back-off to 10 s)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = target();
  const win = target();
  let tries = 0;
  const retry = retryConnection(() => {
    tries += 1;
    // Each try fails at once, as a connection to a stopped Ledung does.
    retry.closed();
  }, page, win);
  retry.closed();
  t.mock.timers.tick(499);
  assert.equal(tries, 0, 'not before 0.5 s');
  t.mock.timers.tick(1);
  assert.equal(tries, 1, 'the first try at 0.5 s');
  // Nineteen more failed tries, each 0.5 s after the last: with the doubling they would have taken 0.5+1+2+4+8+10×14 s.
  for (let i = 0; i < 19; i++) t.mock.timers.tick(500);
  assert.equal(tries, 20, 'twenty tries in 10 s');
  t.mock.timers.tick(499);
  assert.equal(tries, 20);
  t.mock.timers.tick(1);
  assert.equal(tries, 21, 'the 21st wait is 0.5 s too');
  retry.stop();
});

test('#488: a page shown again, or focused, while it waits to try again connects at once; connected, neither starts a try', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = target('hidden');
  const win = target();
  let tries = 0;
  const retry = retryConnection(() => { tries += 1; }, page, win);

  // Connected (no close yet): showing or focusing the page starts nothing.
  page.visibilityState = 'visible';
  page.fire('visibilitychange');
  win.fire('focus');
  win.fire('online');
  assert.equal(tries, 0, 'no try while connected');

  // Closed, the window still hidden: a visibilitychange that leaves it hidden waits on.
  retry.closed();
  page.visibilityState = 'hidden';
  page.fire('visibilitychange');
  assert.equal(tries, 0, 'still hidden: waits');
  // Shown: at once, not 0.5 s later.
  page.visibilityState = 'visible';
  page.fire('visibilitychange');
  assert.equal(tries, 1, 'shown: tried at once');
  // The waiting timer went with it: no second try at 0.5 s.
  t.mock.timers.tick(500);
  assert.equal(tries, 1, 'no second try from the old timer');

  // Closed again: focus (the desktop app's hidden window shown and focused, which stays "visible" while hidden).
  retry.closed();
  win.fire('focus');
  assert.equal(tries, 2, 'focused: tried at once');
  win.fire('focus');
  assert.equal(tries, 2, 'a second focus with no close between starts nothing');

  // And the network coming back.
  retry.closed();
  win.fire('online');
  assert.equal(tries, 3, 'online: tried at once');
  retry.stop();
});

test('#488: cancel drops a waiting try; stop ends the tries and takes every listener away', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = target();
  const win = target();
  let tries = 0;
  const retry = retryConnection(() => { tries += 1; }, page, win);
  assert.ok(page.count() + win.count() > 0, 'it listens while running');

  retry.closed();
  retry.cancel();
  t.mock.timers.tick(1000);
  win.fire('focus');
  assert.equal(tries, 0, 'cancelled: no try');
  // The same without cancel does try: the probe above can see one.
  retry.closed();
  t.mock.timers.tick(500);
  assert.equal(tries, 1, 'not cancelled: tried');

  retry.closed();
  retry.stop();
  t.mock.timers.tick(1000);
  win.fire('focus');
  page.fire('visibilitychange');
  retry.closed();
  t.mock.timers.tick(1000);
  assert.equal(tries, 1, 'stopped: no try');
  assert.equal(page.count() + win.count(), 0, 'no listener left');
});
