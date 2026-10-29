// The Shared usage tab (issue #364): limit cards per account split by computer, the daily stack, who's who
// and Mine; reading the files is the publisher's (#363), tested there. Expected figures are worked out by hand from the inputs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PublishedAccount, PublishedUsage } from '../src/shared/published-usage.ts';
import { accountCards, costSince, dailyStack, periodStart, viewerLogin, visibleFiles, whosWho } from '../web/src/usage/sharedModel.ts';
import { bucket, day, generatedFleet } from './shared-usage-files.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 9, 28, 12, 0).getTime();

function acc(fingerprint: string | null, parts: Partial<PublishedAccount> = {}): PublishedAccount {
  return { label: 'Team', fingerprint, daily: [], hourly: [], limits: [], ...parts };
}
function file(login: string, computerId: string, accounts: PublishedAccount[], asOf = NOW): PublishedUsage {
  return { version: 1, login, computer: computerId.toUpperCase(), computerId, asOf, timeZone: 'Europe/Stockholm', accounts };
}

test('two computers on one account share one card, with the freshest reading and each one\'s share of the cost', () => {
  const five = { kind: 'five_hour', status: 'allowed', resetsAt: NOW + 2.5 * HOUR };
  const a = file('ann', 'a', [acc('fp', { limits: [{ ...five, utilization: 0.3, seenAt: NOW - 30 * 60_000 }], hourly: [{ ...bucket('opus-5-5', 1, 3), t: NOW - HOUR }, { ...bucket('opus-5-5', 1, 50), t: NOW - 6 * HOUR }] })]);
  const b = file('ann', 'b', [acc('fp', { limits: [{ ...five, utilization: 0.4, seenAt: NOW - 60_000 }], hourly: [{ ...bucket('opus-5-5', 1, 1), t: NOW - 2 * HOUR }] })]);
  const cards = accountCards([a, b], NOW);
  assert.equal(cards.length, 1);
  const row = cards[0]!.rows[0]!;
  assert.equal(row.reading?.utilization, 0.4, 'the fresher computer\'s reading');
  // Whichever order the files come in (test review of PR #372, finding 2).
  assert.equal(accountCards([b, a], NOW)[0]!.rows[0]!.reading?.utilization, 0.4);
  // The window began 2.5 h ago: a's hour 6 h back is before it, so a has $3 and b $1.
  assert.deepEqual(row.shares.map((s) => [s.computerId, s.cost, s.share]), [['a', 3, 0.75], ['b', 1, 0.25]]);
  // 40% in 2.5 of 5 hours: 80% at this pace.
  assert.equal(Math.round(row.pace! * 100), 80);
});

test('people on different accounts get separate cards; an account without a fingerprint stays its own computer\'s', () => {
  const cards = accountCards([file('ann', 'a', [acc('one')]), file('bo', 'b', [acc('two')]), file('cy', 'c', [acc(null)]), file('cy', 'd', [acc(null)])], NOW);
  assert.equal(cards.length, 4);
});

test('an account with no reading has no rows, and a window that reset since is marked reset', () => {
  const [none] = accountCards([file('ann', 'a', [acc('fp')])], NOW);
  assert.equal(none!.rows.length, 0);
  const [reset] = accountCards([file('ann', 'a', [acc('fp', { limits: [{ kind: 'five_hour', status: 'allowed', utilization: 0.9, resetsAt: NOW - 1, seenAt: NOW - 6 * HOUR }] })])], NOW);
  assert.equal(reset!.rows[0]!.reset, true);
  assert.equal(reset!.rows[0]!.pace, null);
});

test('the week\'s cost takes daily totals for the days before the hourly ones begin, and hourly after', () => {
  // Hourly totals from yesterday 00:00; the window began four days ago.
  const yesterday = new Date(NOW - DAY); yesterday.setHours(0, 0, 0, 0);
  const a = acc('fp', {
    daily: [5, 4, 3, 2, 1, 0].map((i) => ({ ...bucket('opus-5-5', 1, 10), t: day(NOW - i * DAY) })),
    hourly: [{ ...bucket('opus-5-5', 1, 2), t: yesterday.getTime() }, { ...bucket('opus-5-5', 1, 2), t: NOW - HOUR }],
  });
  // Days 4, 3 and 2 back from daily ($30, the 5-day-old one is before the window), then $4 hourly.
  assert.equal(costSince(a, NOW - 4 * DAY), 34);
  // Weekly Opus counts only Opus.
  assert.equal(costSince(acc('fp', { hourly: [{ ...bucket('sonnet-5-5', 1, 7), t: NOW - HOUR }] }), NOW - DAY, (m) => m.includes('opus')), 0);
});

test('the Weekly Opus bar is split by Opus cost only, the Weekly bar by every model (test review of PR #372, finding 1)', () => {
  const week = NOW + 3 * DAY;
  const limits = [
    { kind: 'seven_day', status: 'allowed', utilization: 0.5, resetsAt: week, seenAt: NOW },
    { kind: 'seven_day_opus', status: 'allowed', utilization: 0.4, resetsAt: week, seenAt: NOW },
  ];
  // a: $6 Opus and $2 Sonnet; b: $2 Opus and $6 Sonnet, all within the window.
  const a = file('ann', 'a', [acc('fp', { limits, hourly: [{ ...bucket('opus-5-5', 1, 6), t: NOW - HOUR }, { ...bucket('sonnet-5-5', 1, 2), t: NOW - HOUR }] })]);
  const b = file('ann', 'b', [acc('fp', { limits, hourly: [{ ...bucket('opus-5-5', 1, 2), t: NOW - HOUR }, { ...bucket('sonnet-5-5', 1, 6), t: NOW - HOUR }] })]);
  const rows = accountCards([a, b], NOW)[0]!.rows;
  const shares = (kind: string) => rows.find((r) => r.kind === kind)!.shares.map((s) => [s.computerId, s.cost, s.share]).sort();
  assert.deepEqual(shares('seven_day'), [['a', 8, 0.5], ['b', 8, 0.5]]);
  assert.deepEqual(shares('seven_day_opus'), [['a', 6, 0.75], ['b', 2, 0.25]]);
});

test('the daily chart stacks tokens by person, account, computer, model or project', () => {
  const d = day(NOW);
  const files = [
    file('ann', 'a', [acc('fp', { label: 'Ann', daily: [{ ...bucket('opus-5-5', 1, 1, 'web'), t: d }, { ...bucket('sonnet-5-5', 2, 1, 'other#ab12'), t: d }] })]),
    file('bo', 'b', [acc('fp2', { label: 'Bo', daily: [{ ...bucket('opus-5-5', 3, 1, 'web'), t: d }] })]),
  ];
  const at = (by: Parameters<typeof dailyStack>[1]) => ({ ...dailyStack(files, by, d, NOW).columns.at(-1)!.values });
  // bucket(k) holds 4k thousand tokens.
  assert.deepEqual(at('person'), { ann: 12_000, bo: 12_000 });
  assert.deepEqual(at('account'), { Ann: 12_000, Bo: 12_000 });
  assert.deepEqual(at('computer'), { A: 12_000, B: 12_000 });
  assert.deepEqual(at('model'), { 'opus-5-5': 16_000, 'sonnet-5-5': 8_000 });
  assert.deepEqual(at('project'), { web: 16_000, 'other#ab12': 8_000 });
});

test('a project named "__proto__" in someone\'s file is stacked as a plain key (review of PR #372, finding 1)', () => {
  const d = day(NOW);
  const files = [file('ann', 'a', [acc('fp', { daily: [{ ...bucket('opus-5-5', 1, 1, '__proto__'), t: d }, { ...bucket('opus-5-5', 2, 1, 'web'), t: d }] })])];
  const values = dailyStack(files, 'project', d, NOW).columns.at(-1)!.values;
  assert.equal(Object.hasOwn(values, '__proto__'), true);
  assert.equal(values['__proto__'], 4_000);
  assert.equal(values.web, 8_000);
});

test('the daily chart keeps quiet days, so gaps show', () => {
  const files = [file('ann', 'a', [acc('fp', { daily: [{ ...bucket('opus-5-5', 1, 1), t: day(NOW - 2 * DAY) }] })])];
  const { columns } = dailyStack(files, 'person', periodStart('7d', files, NOW), NOW);
  assert.equal(columns.length, 7);
  assert.deepEqual({ ...columns.at(-1)!.values }, {});
});

test('who\'s who marks a computer stale after a day without a publish', () => {
  const rows = whosWho([file('ann', 'a', [acc('fp')], NOW - DAY - 60_000), file('ann', 'b', [acc('fp')], NOW - 60_000)], null, NOW);
  assert.deepEqual(rows.map((r) => [r.computerId, r.stale]), [['a', true], ['b', false]]);
});

test('who\'s who sums each computer\'s tokens and cost over the period only (test review of PR #372, finding 3)', () => {
  const from = day(NOW - 2 * DAY);
  const a = file('ann', 'a', [acc('fp', { daily: [
    { ...bucket('opus-5-5', 1, 5), t: day(NOW - 5 * DAY) }, // before the period: left out
    { ...bucket('opus-5-5', 2, 3), t: day(NOW - 2 * DAY) },
    { ...bucket('sonnet-5-5', 1, 1.5), t: day(NOW) },
  ] })]);
  const b = file('bo', 'b', [acc('fp2', { daily: [{ ...bucket('opus-5-5', 3, 7), t: day(NOW - DAY) }] })]);
  // bucket(k) holds 4k thousand tokens: a has 8k + 4k in the period, b 12k.
  assert.deepEqual(whosWho([b, a], from, NOW).map((r) => [r.computerId, r.tokens, r.cost]), [['a', 12_000, 4.5], ['b', 12_000, 7]]);
  assert.deepEqual(whosWho([a], null, NOW).map((r) => [r.tokens, r.cost]), [[16_000, 9.5]], 'all time takes every day');
});

test('"Since weekly reset" starts at the earliest weekly window among the accounts shown (test review of PR #372, finding 4)', () => {
  const week = (resetsAt: number) => ({ kind: 'seven_day', status: 'allowed', utilization: 0.1, resetsAt, seenAt: NOW });
  // Windows that reset in 5 and in 2 days began 2 and 5 days ago.
  const files = [file('ann', 'a', [acc('fp', { limits: [week(NOW + 5 * DAY)] })]), file('bo', 'b', [acc('fp2', { limits: [week(NOW + 2 * DAY)] })])];
  assert.equal(periodStart('week', files, NOW), day(NOW - 5 * DAY));
  assert.equal(periodStart('week', [files[0]!], NOW), day(NOW - 2 * DAY));
});

test('Mine keeps only the signed-in login\'s computers', () => {
  const files = generatedFleet(NOW);
  const entries = files.map((f) => ({ id: f.computerId, own: f.computerId === 'c-alice-pc', state: 'ok' as const, login: f.login, computer: f.computer, asOf: f.asOf, stale: false, file: f }));
  const view = { repo: 'org/usage', entries, canRemove: false, error: null, checkedAt: NOW };
  assert.equal(viewerLogin(view), 'alice', 'the login this computer publishes under');
  const mine = visibleFiles(view, true);
  assert.deepEqual(mine.map((f) => f.computer), ['alice-mac', 'alice-pc']);
  assert.equal(accountCards(mine, NOW).length, 1);
  assert.equal(visibleFiles(view, false).length, 5);
  assert.equal(viewerLogin({ ...view, entries: entries.map((e) => ({ ...e, own: false })) }), null, 'no own file: no Mine');
});

test('the generated fleet: five computers, four accounts, alice\'s two on one card', () => {
  const cards = accountCards(generatedFleet(NOW), NOW);
  assert.deepEqual(cards.map((c) => [c.label, c.computers.length]), [['Alice Max', 2], ['Bob Pro', 1], ['Carol Max', 1], ['Carol work', 1]]);
});
