// Where a plan limit is heading by its reset, shown next to the limit's ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atReset, forecastAt, WINDOW_MS } from '../web/src/usage/projection.ts';

const H = 3_600_000;

test('the use so far, at the same pace, carried on to the reset', () => {
  // Halfway through the 5 hours at 20%: about 40% by the reset.
  assert.ok(Math.abs(atReset('five_hour', 0.2, 2.5 * H, 0)! - 0.4) < 1e-9);
  // Two days into the week at 65%: well past the limit.
  assert.ok(Math.abs(atReset('seven_day', 0.65, 5 * 24 * H, 0)! - 0.65 * 3.5) < 1e-9);
});

test('no forecast too early in a window, for unknown windows, or without a reset time', () => {
  assert.equal(atReset('five_hour', 0.1, WINDOW_MS.five_hour! - 10 * 60_000, 0), null);
  assert.equal(atReset('seven_day_opus', 0.5, 3 * H, 0), null);
  assert.equal(atReset('five_hour', 0.5, null, 0), null);
});

test("in a window's first tenth the forecast is a dash with the reason, not a wild number (issue #70)", () => {
  // One hour into the week (a tenth is 16.8 h) at 5%: the pace says little yet.
  const early = forecastAt('seven_day', 0.05, WINDOW_MS.seven_day! - H, 0);
  assert.equal(early.share, null);
  assert.match((early as { why: string }).why, /too little of the window/);
  // Two of the five hours gone at 20%: 50% by the reset.
  assert.ok(Math.abs(forecastAt('five_hour', 0.2, 3 * H, 0).share! - 0.5) < 1e-9);
  // Without a reset time there is still a reason, never a blank.
  assert.match((forecastAt('seven_day', 0.2, null, 0) as { why: string }).why, /reset time/);
});
