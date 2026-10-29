// Usage stops (issue #278): reaching one holds new turns on its account, a lift by hand or a raised level
// lets them go, and so does the window's reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { promptUsageLine, stopStates } from '../src/usage/stops.ts';
import type { LimitInfo, ServerEvent, UsageStopInfo } from '../src/shared/protocol.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const NOW = Date.UTC(2026, 9, 20, 20, 0);
const HOUR = 3600_000;
const limit = (kind: string, utilization: number, resetsAt: number | null, account = 'default'): LimitInfo =>
  ({ account, kind, status: 'allowed', utilization, resetsAt, at: NOW });

test('a stop is reached at its level, not below it, and only on its own account', () => {
  const stops = { default: { seven_day: 98 } };
  assert.equal(stopStates(stops, [limit('seven_day', 0.97, NOW + HOUR)], {}, NOW)[0]!.holding, false);
  const [s] = stopStates(stops, [limit('seven_day', 0.98, NOW + HOUR), limit('seven_day', 1, NOW + HOUR, 'work')], {}, NOW);
  assert.deepEqual(s, { account: 'default', kind: 'seven_day', percent: 98, utilization: 0.98, resetsAt: NOW + HOUR, reached: true, lifted: false, holding: true });
  assert.equal(stopStates({ work: { five_hour: 50 } }, [limit('five_hour', 0.9, NOW + HOUR)], {}, NOW)[0]!.holding, false, 'another account\'s figure');
});

test('the exact level holds despite floating point, and a figure with no reset time ends a window after it was recorded (review 1 of #278)', () => {
  assert.equal(stopStates({ default: { seven_day: 57 } }, [limit('seven_day', 0.57, NOW + HOUR)], {}, NOW)[0]!.holding, true, '0.57 * 100 < 57 in floating point');
  const noReset = { ...limit('five_hour', 0.99, null), at: NOW - 4 * HOUR };
  const [s] = stopStates({ default: { five_hour: 95 } }, [noReset], {}, NOW);
  assert.equal(s!.holding, true);
  assert.equal(s!.resetsAt, NOW + HOUR, 'five hours after it was recorded, so the reset timer has a time');
  assert.equal(stopStates({ default: { five_hour: 95 } }, [noReset], {}, NOW + HOUR)[0]!.holding, false, 'lifted by itself then');
  // Lifted by hand: a newer figure moves the estimate, but the lift lasts until the end estimated when lifted (review 2, finding 1).
  const lifted = { 'default\nfive_hour': NOW + HOUR };
  const newer = { ...noReset, utilization: 0.995, at: NOW + 10 * 60_000 };
  assert.equal(stopStates({ default: { five_hour: 95 } }, [newer], lifted, NOW + 20 * 60_000)[0]!.holding, false, 'still lifted');
  assert.equal(stopStates({ default: { five_hour: 95 } }, [{ ...newer, at: NOW + HOUR + 1 }], lifted, NOW + HOUR + 2)[0]!.holding, true, 'a figure after that end holds again');
});

test('a lift by hand lasts for its window only; a window that has reset holds nothing', () => {
  const stops = { default: { seven_day: 98 } };
  const lifted = { 'default\nseven_day': NOW + HOUR };
  const s = stopStates(stops, [limit('seven_day', 0.99, NOW + HOUR)], lifted, NOW)[0]!;
  assert.equal(s.lifted, true);
  assert.equal(s.holding, false);
  assert.equal(stopStates(stops, [limit('seven_day', 0.99, NOW + 8 * 24 * HOUR)], lifted, NOW)[0]!.holding, true, 'the next window holds again');
  const reset = stopStates(stops, [limit('seven_day', 0.99, NOW - 1)], {}, NOW)[0]!;
  assert.equal(reset.holding, false, 'its reset time has passed: the figure is the old window\'s');
  assert.equal(reset.utilization, null);
});

// Issue #284: the figures are information only; a manager held work back on "weekly 96%" with no stop set.
const RULE = " Information only: don't delay or ration work for it; Ledung's usage stop holds work if needed.";

test('a manager\'s prompt line has each window, when it resets, and the stop or that none is set', () => {
  const states = stopStates({ default: { seven_day: 98 } }, [limit('seven_day', 0.985, NOW + HOUR)], {}, NOW);
  const line = promptUsageLine([limit('five_hour', 0.41, NOW + 2 * HOUR), limit('seven_day', 0.985, NOW + HOUR)], states, 'default', NOW);
  assert.match(line, /^Plan usage: 5-hour 41% \(resets \w{3} \d\d:\d\d; no stop set\), weekly 98% \(resets \w{3} \d\d:\d\d, held at 98%: work is held\)\. /);
  assert.match(promptUsageLine([limit('five_hour', 0.41, NOW - 1)], [], 'default', NOW), /^Plan usage: 5-hour 0% \(reset since; no stop set\)\. /);
  assert.match(promptUsageLine([limit('five_hour', 0.57, NOW + HOUR)], [], 'default', NOW), /^Plan usage: 5-hour 57% /, '0.57 is 57%, not 56% (review 1 of #280)');
  const near = stopStates({ default: { seven_day: 95 } }, [limit('seven_day', 0.93, NOW + HOUR)], {}, NOW);
  assert.match(promptUsageLine([limit('seven_day', 0.93, NOW + HOUR)], near, 'default', NOW), /^Plan usage: weekly 93% \(resets \w{3} \d\d:\d\d, 2% to stop\)\. /, 'the page meter\'s wording (issue #280)');
  assert.equal(promptUsageLine([limit('five_hour', 0.41, NOW)], [], 'other', NOW), '', 'nothing recorded for the account');
});

test('the prompt line ends with the rule that the figures are information only, stop or not (#284)', () => {
  const none = promptUsageLine([limit('seven_day', 0.96, NOW + HOUR)], [], 'default', NOW);
  assert.match(none, /^Plan usage: weekly 96% \(resets \w{3} \d\d:\d\d; no stop set\)\./);
  assert.ok(none.endsWith(`.${RULE}`), none);
  const near = stopStates({ default: { seven_day: 98 } }, [limit('seven_day', 0.92, NOW + HOUR)], {}, NOW);
  const stopped = promptUsageLine([limit('seven_day', 0.92, NOW + HOUR)], near, 'default', NOW);
  assert.match(stopped, /^Plan usage: weekly 92% \(resets \w{3} \d\d:\d\d, 6% to stop\)\./);
  assert.ok(stopped.endsWith(`.${RULE}`), stopped);
});

test('the manager holds the account when the figures reach a stop, and lifts it by hand, on a raised level and on reset', async () => {
  const store = new Store(openDatabase(':memory:'));
  const events: ServerEvent[] = [];
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', usageStops: { default: { seven_day: 98 } } }), store, (e) => events.push(e)));
  store.createSession({ id: 's', project: 'p', runner: 'local', title: 'Worker', parentId: null, permissionMode: 'default' });
  const record = (utilization: number, resetsAt: number) => {
    store.addLimit({ account: 'default', at: Date.now(), kind: 'seven_day', status: 'allowed', utilization, resetsAt, data: {} });
    (manager as unknown as { publish(e: ServerEvent): void }).publish({ type: 'limits', limits: store.latestLimits() });
  };
  record(0.9, Date.now() + HOUR);
  assert.equal(manager.usageHold('s'), undefined, 'the config\'s stop, not reached');
  record(0.98, Date.now() + HOUR);
  assert.equal(manager.usageHold('s')?.percent, 98, 'reached: held');
  const told = events.filter((e): e is Extract<ServerEvent, { type: 'usageStops' }> => e.type === 'usageStops').at(-1)!;
  assert.equal(told.usageStops[0]!.holding, true, 'the page is told');

  manager.liftUsageStop('default', 'seven_day');
  assert.equal(manager.usageHold('s'), undefined, 'lifted by hand');
  assert.throws(() => manager.liftUsageStop('default', 'seven_day'), /not holding/);
  manager.setUsageStop('default', 'seven_day', 97);
  assert.ok(manager.usageHold('s'), 'a new level ends the lift');
  manager.setUsageStop('default', 'seven_day', 99);
  assert.equal(manager.usageHold('s'), undefined, 'raised above the figure');
  manager.setUsageStop('default', 'seven_day', 98);
  assert.ok(manager.usageHold('s'));
  assert.throws(() => manager.setUsageStop('default', 'seven_day', 150), /1 to 100/);

  record(0.99, Date.now() + 60);
  assert.ok(manager.usageHold('s'));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(manager.usageHold('s'), undefined, 'the window has reset');
  manager.setUsageStop('default', 'seven_day', null);
  assert.deepEqual(manager.usageStopStates(), [], 'removed');
});

/** A Session through start() with a stand-in for the SDK's query (as in bang.test.ts), its PreToolUse hook and a held account. */
async function heldSession(status?: 'running') {
  const store = new Store(openDatabase(':memory:'));
  let info = store.createSession({ id: 's1', project: 'p', runner: 'local', title: 'Worker', parentId: null, permissionMode: 'default', role: 'session' });
  // Mid-turn when Ledung restarted.
  if (status) {
    store.updateSession('s1', { status });
    info = store.getSession('s1')!;
  }
  let freed = 0;
  let next: ((m: unknown) => void) | null = null;
  const stream = { accountInfo: async () => ({}), [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>((resolve) => { next = (m) => resolve({ value: m, done: false }); }) }) };
  const turns: string[] = [];
  const box: { hold?: UsageStopInfo } = {};
  let hooks: Record<string, { hooks: ((...a: unknown[]) => Promise<unknown>)[] }[]> = {};
  const s = new Session({
    info, store, publish: () => {}, userName: 'Simon',
    management: new Proxy({}, { get: (_, k) => (k === 'questionTiers' ? () => [] : () => undefined) }) as never,
    runner: new LocalRunner({ name: 'p', runner: 'local', path: process.cwd() } as never),
    gate: { mayStart: () => true, started: (_id, trigger) => turns.push(trigger), ended: () => {}, usageHold: () => box.hold, freed: () => { freed++; } },
    query: ((args: { options: { hooks: typeof hooks } }) => { hooks = args.options.hooks; return stream; }) as never,
  });
  await s.start();
  const fromClaude = async (m: Record<string, unknown>) => {
    (s as unknown as { onHostLine(seq: number, at: number, json: string): void }).onHostLine(Date.now(), Date.now(), JSON.stringify(m));
    next!(m);
    await new Promise((r) => setTimeout(r, 20));
  };
  /** Whether a tool call gets past the hook within 100 ms. */
  const toolCall = () => Promise.race([
    hooks.PreToolUse![0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'README.md' } }, 'tu1', { signal: new AbortController().signal }).then(() => 'ran'),
    new Promise((r) => setTimeout(() => r('waits'), 100)),
  ]);
  const said = () => store.listMessages('s1', { limit: 50 }).filter((m) => m.kind === 'event' && /usage stop/.test(m.data.text));
  return { s, store, box, turns, fromClaude, toolCall, said, freed: () => freed };
}

const HOLD: UsageStopInfo = { account: 'default', kind: 'seven_day', percent: 98, utilization: 0.98, resetsAt: NOW, reached: true, lifted: false, holding: true, since: 0 };

test('a held session starts no turn, also with Start now, leaves the line, and says so once; it starts when the hold ends', async () => {
  const { s, store, box, turns, said } = await heldSession();
  box.hold = HOLD;
  store.updateSession('s1', { status: 'queued', queuedAt: Date.now() });
  s.send('work on it');
  s.deliver();
  s.startNow();
  assert.deepEqual(turns, [], 'held');
  assert.equal(store.getSession('s1')!.status, 'idle', 'out of the line, so other accounts can start');
  assert.equal(said().length, 1, 'said once');
  assert.match(said()[0]!.data.text, /weekly usage stop at 98%/);
  box.hold = undefined;
  s.releaseHeld();
  assert.deepEqual(turns, ['user'], 'Simon\'s message goes once the hold ends');
});

test('a turn under way when the stop is reached finishes; a turn Claude Code starts itself waits at its first tool call until released', async () => {
  const { s, box, fromClaude, toolCall, freed } = await heldSession();
  s.send('work on it');
  box.hold = { ...HOLD, since: Date.now() + 1 };
  assert.equal(await toolCall(), 'ran', 'the running turn began before the stop');
  await fromClaude({ type: 'result', subtype: 'success', num_turns: 1, result: 'done', session_id: 'c', total_cost_usd: 0, usage: {}, modelUsage: {} });
  // A wake-up, a /loop or a finished background task: Claude Code's own turn, after the stop.
  await fromClaude({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] } });
  assert.equal(await toolCall(), 'waits', 'held');
  assert.equal(s.heldAtToolCall, true, 'not counted as working (review 2, finding 2)');
  assert.ok(freed() > 0, 'the line is told its place is free');
  box.hold = undefined;
  s.releaseHeld();
  assert.equal(s.heldAtToolCall, false);
  assert.equal(await toolCall(), 'ran', 'released');
});

test('a turn under way when Ledung restarted finishes, whatever stop it now sees (review 2, finding 3)', async () => {
  const { box, toolCall } = await heldSession('running');
  box.hold = { ...HOLD, since: Date.now() };
  assert.equal(await toolCall(), 'ran');
});
