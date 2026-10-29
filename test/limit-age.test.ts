// How old a limit reading is (issue #360): the store notes when unchanged figures are seen again, and the meter
// shows the age from then and gives no figure for a window that has reset since.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { hasReset, readingAge, shownAge } from '../web/src/usage/readingAge.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 28, 9);

test('unchanged figures seen again move the reading\'s age, not its first time (#360)', () => {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  const rows = () => Number((db.prepare('SELECT COUNT(*) AS n FROM limits').get() as { n: number }).n);
  const reading = (at: number, utilization = 0.4) => ({ account: 'default', at, kind: 'seven_day', status: 'allowed', utilization, resetsAt: NOW + 24 * HOUR, data: {} });
  assert.equal(store.addLimit(reading(NOW - 3 * HOUR)), true, 'new figures are kept');
  assert.equal(store.latestLimits()[0]!.seenAt, NOW - 3 * HOUR, 'never seen again: its own time');

  assert.equal(store.addLimit(reading(NOW)), true, 'seen again hours later: the page hears of it');
  const [l] = store.latestLimits();
  assert.equal(l!.at, NOW - 3 * HOUR, 'the figures first came then');
  assert.equal(l!.seenAt, NOW, 'and were last confirmed now');
  assert.equal(rows(), 1, 'no new row for unchanged figures');

  assert.equal(store.addLimit(reading(NOW + 20_000)), false, 'seen again within a minute: no new list for the page');
  assert.equal(store.latestLimits()[0]!.seenAt, NOW + 20_000);
  assert.equal(store.addLimit(reading(NOW)), false, 'an older notice does not move it back');
  assert.equal(store.latestLimits()[0]!.seenAt, NOW + 20_000);

  assert.equal(store.addLimit(reading(NOW + MIN, 0.41)), true, 'changed figures are a new reading');
  assert.equal(store.latestLimits()[0]!.seenAt, NOW + MIN);
  assert.equal(rows(), 2, 'and a row of its own');
});

test('steady confirmations less than a minute apart still reach the page about once a minute (#360, review of #361)', () => {
  const store = new Store(openDatabase(':memory:'));
  const reading = (at: number) => ({ account: 'default', at, kind: 'five_hour', status: 'allowed', utilization: 0.2, resetsAt: NOW + 4 * HOUR, data: {} });
  assert.equal(store.addLimit(reading(NOW)), true);
  // One notice every 30 s for 20 minutes, as a session working steadily sends them.
  const told = Array.from({ length: 40 }, (_, i) => store.addLimit(reading(NOW + (i + 1) * 30_000))).filter(Boolean).length;
  assert.ok(told >= 19 && told <= 21, `the page was told ${told} times in 20 minutes`);
});

test('the meter shows a reading\'s age once it is an hour old, from when it was last confirmed (#360, Martin #329)', () => {
  const r = { resetsAt: NOW + HOUR, at: NOW - 5 * HOUR };
  assert.equal(shownAge({ ...r, seenAt: NOW - 59 * MIN }, NOW), null, 'under an hour: hover only');
  assert.equal(shownAge({ ...r, seenAt: NOW - 60 * MIN }, NOW), 'as of 1 h ago');
  assert.equal(readingAge({ ...r, seenAt: NOW - 15 * MIN }, NOW), 'as of 15 min ago', 'the hover gives minutes');
  assert.equal(shownAge(r, NOW), 'as of 5 h ago', 'never confirmed again: from when it came');
  assert.equal(readingAge({ ...r, seenAt: NOW - 20_000 }, NOW), 'as of just now');
  assert.match(readingAge({ ...r, seenAt: NOW - 30 * HOUR }, NOW), /^as of \S+ \d{2}[:.]\d{2}/, 'over a day: the day and time');
});

test('a window that has reset since its reading gives no figure (#360)', () => {
  assert.equal(hasReset({ resetsAt: NOW, at: NOW - HOUR }, NOW), true, 'resets at this moment');
  assert.equal(hasReset({ resetsAt: NOW - 1, at: NOW - HOUR }, NOW), true);
  assert.equal(hasReset({ resetsAt: NOW + 1, at: NOW - HOUR }, NOW), false);
  assert.equal(hasReset({ resetsAt: null, at: NOW - 10 * HOUR }, NOW), false, 'no reset time: not known to have reset');
});
