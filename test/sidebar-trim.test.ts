// The sidebar's top-left panel, slimmed (issue #284): which limits are drawn, how the line under a meter fits, the
// GitHub line, and what the Machine panel folds. All pure; the values come from the issue's Done bullets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shownLimits } from '../web/src/usage/limitsShown.ts';
import { meterLineLayout, meterLineVariants, stripWidth } from '../web/src/usage/meterLine.ts';
import { meterStopHead, resetsInVariants } from '../src/shared/usage-stop-text.ts';
import { githubBudgetsShown } from '../web/src/githubBudget.ts';
import { jobOpen, jobUse, waitingOpen } from '../web/src/usage/machineFold.ts';
import type { GitHubBudget, UsageStopInfo } from '../src/shared/protocol.ts';

const MIN = 60_000;
const H = 60 * MIN;
const NOW = Date.UTC(2026, 10, 12, 12, 0);
const kinds = (r: { shown: { kind: string }[] }) => r.shown.map((l) => l.kind);

test('item 1: a 5-hour window unreported for over 5 hours, while the week still reports, is not drawn', () => {
  const week = { kind: 'seven_day', at: NOW - MIN };
  // Last heard 6 h ago, the week heard since: the plan doesn't send it.
  assert.deepEqual(kinds(shownLimits([{ kind: 'five_hour', at: NOW - 6 * H }, week], NOW)), ['seven_day']);
  // Positive branch: heard 4 h ago is inside its own 5 hours, so it is drawn.
  assert.deepEqual(kinds(shownLimits([{ kind: 'five_hour', at: NOW - 4 * H }, week], NOW)), ['five_hour', 'seven_day']);
  // seenAt, when there, is the reading's time.
  assert.deepEqual(kinds(shownLimits([{ kind: 'five_hour', at: NOW - 6 * H, seenAt: NOW - 2 * H }, week], NOW)), ['five_hour', 'seven_day']);
});

test('item 1: it stays when nothing on the account reported since, and when its stop holds', () => {
  // Ledung idle for 6 h: every reading is old, the account reported nothing newer, so nothing says the plan lacks it.
  const idle = [{ kind: 'five_hour', at: NOW - 6 * H }, { kind: 'seven_day', at: NOW - 6 * H + 30 * MIN }];
  assert.deepEqual(kinds(shownLimits(idle, NOW)), ['five_hour', 'seven_day']);
  const old = [{ kind: 'five_hour', at: NOW - 6 * H }, { kind: 'seven_day', at: NOW - MIN }];
  assert.deepEqual(kinds(shownLimits(old, NOW, new Set(['five_hour']))), ['five_hour', 'seven_day']);
  assert.deepEqual(kinds(shownLimits(old, NOW, new Set())), ['seven_day']);
});

test('item 2: the overage-included weekly window folds into the weekly meter, and stands alone without one', () => {
  const week = { kind: 'seven_day', at: NOW - MIN };
  const extra = { kind: 'seven_day_overage_included', at: NOW - MIN };
  const r = shownLimits([week, extra], NOW);
  assert.deepEqual(kinds(r), ['seven_day']);
  assert.equal(r.folded.get('seven_day'), extra);
  const alone = shownLimits([extra], NOW);
  assert.deepEqual(kinds(alone), ['seven_day_overage_included']);
  assert.equal(alone.folded.size, 0);
});

test('item 3: the reset countdown shortens in the order the issue gives', () => {
  const resetsAt = NOW + (5 * 24 + 19) * H;
  assert.deepEqual(resetsInVariants(resetsAt, NOW, 'seven_day'), ['Weekly limit resets in 5 d 19 h', 'resets in 5 d 19 h', '5 d 19 h']);
  assert.deepEqual(resetsInVariants(NOW + 90 * MIN, NOW, 'five_hour'), ['5 h limit resets in 1 h 30 min', 'resets in 1 h 30 min', '1 h 30 min']);
  assert.deepEqual(resetsInVariants(NOW - MIN, NOW, 'seven_day'), ['Weekly limit resets now', 'resets now']);
  assert.deepEqual(resetsInVariants(null, NOW, 'seven_day'), []);
});

test('item 3: the stop line keeps its head and drops only the countdown\'s words', () => {
  const stop: UsageStopInfo = { account: 'default', kind: 'seven_day', percent: 98, utilization: 0.22, resetsAt: NOW + (5 * 24 + 19) * H, reached: false, holding: false, lifted: false };
  const v = meterLineVariants(meterStopHead(stop), resetsInVariants(stop.resetsAt, NOW, stop.kind));
  assert.deepEqual(v, ['22% · 76% to stop · Weekly limit resets in 5 d 19 h', '22% · 76% to stop · resets in 5 d 19 h', '22% · 76% to stop · 5 d 19 h']);
  assert.deepEqual(meterLineVariants(null, []), []);
  assert.deepEqual(meterLineVariants('Stop at 95%', []), ['Stop at 95%']);
});

test('items 3 and 4: the longest words that fit beside the forecast, else the forecast moves up to the ship', () => {
  const widths = [300, 200, 100];
  // Wide: the full line and the forecast on it.
  assert.deepEqual(meterLineLayout({ widths, forecast: 80, room: 400, gap: 6, besideShip: true }), { variant: 0, forecastInline: true });
  // 290 px: 200 + 6 + 80 fits; the full line doesn't.
  assert.deepEqual(meterLineLayout({ widths, forecast: 80, room: 290, gap: 6, besideShip: true }), { variant: 1, forecastInline: true });
  // 150 px: even "5 d 19 h" doesn't fit beside it (100 + 6 + 80 > 150); alone, only it fits (200 > 150).
  assert.deepEqual(meterLineLayout({ widths, forecast: 80, room: 150, gap: 6, besideShip: true }), { variant: 2, forecastInline: false });
  // 210 px: "5 d 19 h" with the forecast (100 + 6 + 80) fits, so the forecast stays on the line.
  assert.deepEqual(meterLineLayout({ widths, forecast: 80, room: 210, gap: 6, besideShip: true }), { variant: 2, forecastInline: true });
  // 220 px with a long shortest form (190): nothing fits beside the forecast; alone, the middle one (200) does.
  assert.deepEqual(meterLineLayout({ widths: [300, 200, 190], forecast: 80, room: 220, gap: 6, besideShip: true }), { variant: 1, forecastInline: false });
  // Too narrow for anything: the shortest, which wraps between its parts.
  assert.deepEqual(meterLineLayout({ widths, forecast: 80, room: 50, gap: 6, besideShip: true }), { variant: 2, forecastInline: false });
  // No forecast: nothing to move.
  assert.deepEqual(meterLineLayout({ widths, forecast: 0, room: 150, gap: 6, besideShip: true }), { variant: 2, forecastInline: true });
});

test('item 4: when the ship cannot make room, the forecast stays on the line with the shortest words', () => {
  // Same 150 px as above, where it would have moved up: now it stays on the line, which wraps between its parts.
  assert.deepEqual(meterLineLayout({ widths: [300, 200, 100], forecast: 80, room: 150, gap: 6, besideShip: false }), { variant: 2, forecastInline: true });
  // It fits on the line: the ship's answer doesn't matter.
  assert.deepEqual(meterLineLayout({ widths: [300, 200, 100], forecast: 80, room: 400, gap: 6, besideShip: false }), { variant: 0, forecastInline: true });
});

test('item 4: the ship strip leaves room beside it only while it keeps its figure', () => {
  const widths = [50, 33, 25, 20, 10];
  // 3 px a column in a 190 px box: 50 columns (150 px) fit; 40 px are left.
  assert.deepEqual(stripWidth({ widths, charPx: 3, boxPx: 190, roomPx: 0, figureAt: () => true }), { cols: 50, roomMade: true });
  // 90 px wanted: 33 columns (99 px) leave 91 px, and it still shows its figure there.
  assert.deepEqual(stripWidth({ widths, charPx: 3, boxPx: 190, roomPx: 90, figureAt: () => true }), { cols: 33, roomMade: true });
  // The figure shows only at 50 columns: no room is made, the strip stays full.
  assert.deepEqual(stripWidth({ widths, charPx: 3, boxPx: 190, roomPx: 90, figureAt: (c) => c >= 50 }), { cols: 50, roomMade: false });
  // No figure even at full width (a ship near 0%): nothing to keep, so it may narrow.
  assert.deepEqual(stripWidth({ widths, charPx: 3, boxPx: 190, roomPx: 90, figureAt: () => false }), { cols: 33, roomMade: true });
});

test('item 6: the GitHub line shows only while the checks are slowed or stopped, until its reset', () => {
  const b: GitHubBudget = { host: 'github.com', container: null, remaining: 4210, limit: 5000, resetAt: NOW + H, polling: 'normal' };
  const slow = { ...b, remaining: 900, polling: 'slow' as const };
  const stopped = { ...b, remaining: 10, polling: 'stopped' as const };
  assert.deepEqual(githubBudgetsShown([b], NOW), []);
  assert.deepEqual(githubBudgetsShown([b, slow, stopped], NOW), [slow, stopped]);
  assert.deepEqual(githubBudgetsShown([slow], NOW + H), [], 'past its reset');
});

test('item 7: "Waiting for room" opens only once an item has waited over a minute', () => {
  assert.equal(waitingOpen([{ since: NOW - 30_000 }, { since: NOW - 59_000 }], NOW), false);
  assert.equal(waitingOpen([{ since: NOW - 30_000 }, { since: NOW - 61_000 }], NOW), true);
  assert.equal(waitingOpen([{ since: NOW - MIN }], NOW), false, 'exactly a minute is not over one');
  assert.equal(waitingOpen([], NOW), false);
});

test('item 5: a job is one line unless it is over its share; its bar is its most-used reservation', () => {
  assert.equal(jobOpen({ state: 'going' }), false);
  assert.equal(jobOpen({ state: 'paused' }), false);
  assert.equal(jobOpen({ state: 'over' }), true);
  // CPU 30 of 60 (0.5), memory 3 of 4 GB (0.75): the bar shows 0.75.
  assert.deepEqual(jobUse({ granted: { cpu: 60, ram: 4 }, using: { cpu: 30, ram: 3 } }), { share: 0.75, over: false });
  assert.deepEqual(jobUse({ granted: { cpu: 50 }, using: { cpu: 60 } }), { share: 1.2, over: true });
  assert.deepEqual(jobUse({ granted: {}, using: {} }), { share: 0, over: false });
});
