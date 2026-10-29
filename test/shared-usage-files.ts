// Generated published usage files (issue #364): three made-up people on five computers, two of which share one
// account, one computer silent for days and one account with no limit reading yet. Never real data.
import type { PublishedAccount, PublishedBucket, PublishedLimit, PublishedUsage } from '../src/shared/published-usage.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function day(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A bucket whose tokens are `k` thousand each kind, and whose cost is `cost` dollars. */
export function bucket(model: string, k: number, cost: number, project = 'other#0000'): PublishedBucket {
  return { t: 0, model, project, input: k * 1000, cacheWrite: k * 1000, cacheRead: k * 1000, output: k * 1000, cost, calls: k };
}

function account(label: string, fingerprint: string | null, now: number, days: number, perDay: (i: number) => PublishedBucket[], perHour: (i: number) => PublishedBucket[], limits: PublishedLimit[]): PublishedAccount {
  const daily: PublishedAccount['daily'] = [];
  for (let i = days - 1; i >= 0; i--) for (const b of perDay(i)) daily.push({ ...b, t: day(now - i * DAY) });
  const hourly: PublishedAccount['hourly'] = [];
  const thisHour = Math.floor(now / HOUR) * HOUR;
  for (let i = 8 * 24 - 1; i >= 0; i--) for (const b of perHour(i)) hourly.push({ ...b, t: thisHour - i * HOUR });
  return { label, fingerprint, daily, hourly, limits };
}

function file(login: string, computer: string, computerId: string, asOf: number, accounts: PublishedAccount[]): PublishedUsage {
  return { version: 1, login, computer, computerId, asOf, timeZone: 'Europe/Stockholm', accounts };
}

/**
 * The fleet the screenshots and tests use, at `now`:
 * - alice: "Alice Max" on two computers (alice-mac, alice-pc), the pc's reading is the fresher one;
 * - bob: "Bob Pro" on bob-laptop;
 * - carol: "Carol Max" on carol-desk, and "Carol work" on carol-old, which last published three days ago and has no reading.
 */
export function generatedFleet(now: number): PublishedUsage[] {
  const week = now + 3 * DAY;
  const five = now + 2 * HOUR;
  const wave = (i: number, base: number) => Math.round(base * (1 + 0.5 * Math.sin(i / 2)));
  const alice = 'f1'.repeat(32);
  return [
    file('alice', 'alice-mac', 'c-alice-mac', now - 4 * 60_000, [account('Alice Max', alice, now, 30,
      (i) => [bucket('opus-5-5', wave(i, 900), wave(i, 900) * 0.02, 'ledung'), bucket('sonnet-5-5', wave(i, 300), wave(i, 300) * 0.006, 'other#k3x9')],
      (i) => (i % 3 === 0 ? [bucket('opus-5-5', 40, 1)] : []),
      [{ kind: 'five_hour', status: 'allowed', utilization: 0.35, resetsAt: five, seenAt: now - 40 * 60_000 }, { kind: 'seven_day', status: 'allowed', utilization: 0.5, resetsAt: week, seenAt: now - 40 * 60_000 }])]),
    file('alice', 'alice-pc', 'c-alice-pc', now - 2 * 60_000, [account('Alice Max', alice, now, 20,
      (i) => [bucket('opus-5-5', wave(i, 500), wave(i, 500) * 0.02, 'other#k3x9')],
      (i) => (i % 3 === 0 ? [bucket('opus-5-5', 40, 3)] : []),
      [{ kind: 'five_hour', status: 'allowed', utilization: 0.42, resetsAt: five, seenAt: now - 3 * 60_000 }, { kind: 'seven_day', status: 'allowed_warning', utilization: 0.61, resetsAt: week, seenAt: now - 3 * 60_000 }])]),
    file('bob', 'bob-laptop', 'c-bob-laptop', now - 70 * 60_000, [account('Bob Pro', 'b0'.repeat(32), now, 30,
      (i) => [bucket('sonnet-5-5', wave(i, 700), wave(i, 700) * 0.006, 'other#2mq7'), bucket('haiku-5-5', wave(i, 200), wave(i, 200) * 0.001, 'other#2mq7')],
      (i) => (i % 4 === 0 ? [bucket('sonnet-5-5', 30, 0.5)] : []),
      [{ kind: 'five_hour', status: 'allowed', utilization: 0.12, resetsAt: now - 30 * 60_000, seenAt: now - 6 * HOUR }, { kind: 'seven_day', status: 'allowed', utilization: 0.22, resetsAt: week + 2 * DAY, seenAt: now - 90 * 60_000 }])]),
    file('carol', 'carol-desk', 'c-carol-desk', now - 10 * 60_000, [account('Carol Max', 'c4'.repeat(32), now, 30,
      (i) => [bucket('opus-5-5', wave(i, 1200), wave(i, 1200) * 0.02, 'website'), bucket('fable-5-1', wave(i, 150), wave(i, 150) * 0.03, 'other#zz01')],
      (i) => (i % 2 === 0 ? [bucket('opus-5-5', 60, 2)] : []),
      [{ kind: 'five_hour', status: 'rejected', utilization: 1, resetsAt: five, seenAt: now - 10 * 60_000 }, { kind: 'seven_day', status: 'allowed_warning', utilization: 0.83, resetsAt: week, seenAt: now - 10 * 60_000 }, { kind: 'seven_day_opus', status: 'allowed', utilization: 0.7, resetsAt: week, seenAt: now - 10 * 60_000 }])]),
    file('carol', 'carol-old', 'c-carol-old', now - 3 * DAY, [account('Carol work', 'c5'.repeat(32), now - 3 * DAY, 14,
      (i) => [bucket('sonnet-5-5', wave(i, 250), wave(i, 250) * 0.006, 'other#zz01')],
      () => [],
      [])]),
  ];
}
