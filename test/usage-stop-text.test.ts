// The usage stop's wording under the page's meters and in managers' prompt line (issue #280).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meterStopLine, resetsInText, shownPercent, stopNote } from '../src/shared/usage-stop-text.ts';
import type { UsageStopInfo } from '../src/shared/protocol.ts';

const NOW = Date.UTC(2026, 9, 20, 12);
const MIN = 60_000;
const stop = (over: Partial<UsageStopInfo>): UsageStopInfo => ({
  account: 'default', kind: 'seven_day', percent: 95, utilization: 0.93, resetsAt: NOW + (11 * 60 + 30) * MIN,
  reached: false, lifted: false, holding: false, ...over,
} as UsageStopInfo);

test('not held: the figure, what is left to the stop and the countdown', () => {
  assert.equal(meterStopLine(stop({}), NOW), '93% · 2% to stop · Weekly limit resets in 11 h 30 min');
  // Rounded down like the ship's number, so 93.9% is still 2% from a stop at 95.
  assert.equal(meterStopLine(stop({ utilization: 0.939 }), NOW), '93% · 2% to stop · Weekly limit resets in 11 h 30 min');
  assert.equal(stopNote(stop({ utilization: 0.949 })), '1% to stop', 'under a percent away is still 1%');
  assert.equal(meterStopLine(stop({ utilization: null, resetsAt: null }), NOW), 'Stop at 95%', 'figure expired, no time known');
  // Floating point: 0.29 * 100 is 28.999…, which must still read 29% (review 1).
  assert.equal(shownPercent(0.29), 29);
  assert.equal(shownPercent(0.57), 57);
  assert.equal(meterStopLine(stop({ percent: 30, utilization: 0.29, resetsAt: null }), NOW), '29% · 1% to stop');
});

test('held: the stop and the countdown; lifted: said so', () => {
  assert.equal(meterStopLine(stop({ utilization: 0.96, reached: true, holding: true, resetsAt: NOW + 9 * 60 * MIN }), NOW), 'Held at 95% · Weekly limit resets in 9 h');
  assert.equal(meterStopLine(stop({ utilization: 0.96, reached: true, lifted: true }), NOW), '96% · stop at 95% lifted · Weekly limit resets in 11 h 30 min');
});

test('the countdown names its window and rounds minutes up', () => {
  assert.equal(resetsInText(NOW + 30_000, NOW, 'five_hour'), '5 h limit resets in 1 min');
  assert.equal(resetsInText(NOW + 40 * MIN, NOW, 'five_hour'), '5 h limit resets in 40 min');
  assert.equal(resetsInText(NOW + 3 * 60 * MIN, NOW, 'five_hour'), '5 h limit resets in 3 h');
  assert.equal(resetsInText(NOW + (2 * 1440 + 4 * 60 + 10) * MIN, NOW, 'seven_day'), 'Weekly limit resets in 2 d 4 h');
  assert.equal(resetsInText(NOW + (3 * 60 + 5) * MIN, NOW, 'seven_day'), 'Weekly limit resets in 3 h 5 min');
  assert.equal(resetsInText(NOW + 3 * 1440 * MIN, NOW, 'seven_day'), 'Weekly limit resets in 3 d');
  assert.equal(resetsInText(NOW + 5 * 60 * MIN, NOW, 'seven_day_opus'), 'Weekly Opus limit resets in 5 h');
  assert.equal(resetsInText(NOW + 5 * 60 * MIN, NOW, 'something_new'), 'something_new limit resets in 5 h');
  assert.equal(resetsInText(NOW - 1, NOW, 'five_hour'), '5 h limit resets now');
  assert.equal(resetsInText(null, NOW, 'five_hour'), '');
});

test('the stop line names its own window', () => {
  assert.equal(meterStopLine(stop({ kind: 'five_hour', resetsAt: NOW + 90 * MIN }), NOW), '93% · 2% to stop · 5 h limit resets in 1 h 30 min');
});
