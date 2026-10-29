import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageRecorder } from '../src/usage/recorder.ts';
import { callCost } from '../src/usage/pricing.ts';

const facts = { sessionId: 's1', project: 'p', role: 'session' as const, team: 'mgr', branch: 'main' };
const assistant = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  type: 'assistant', parent_tool_use_id: null, message: { id, model: 'claude-sonnet-5-5', usage, content: [] }, ...extra,
});

test('one record per model call, with what started the turn', () => {
  const r = new UsageRecorder();
  r.startTurn('manager');
  const out = r.feed(assistant('msg_1', { input_tokens: 10, output_tokens: 200, cache_creation_input_tokens: 1000, cache_read_input_tokens: 30000 }), 1, facts);
  assert.equal(out.usage!.messageId, 'msg_1');
  assert.equal(out.usage!.trigger, 'manager');
  assert.equal(out.usage!.team, 'mgr');
  assert.equal(out.usage!.branch, 'main');
  assert.deepEqual(out.context, { tokens: 31010 });
  r.feed({ type: 'result', num_turns: 1 }, 2, facts);
  // A turn Claude Code starts by itself (e.g. a background subagent finished) continues the same work.
  assert.equal(r.feed(assistant('msg_2', { input_tokens: 1, output_tokens: 1 }), 3, facts).usage!.trigger, 'manager');
  r.startTurn('user');
  assert.equal(r.feed(assistant('msg_3', { input_tokens: 1, output_tokens: 1 }), 4, facts).usage!.trigger, 'user');
});

test('calls from a subagent carry its type and leave the context alone', () => {
  const r = new UsageRecorder();
  r.startTurn('answer');
  r.feed({
    type: 'assistant', parent_tool_use_id: null,
    message: { id: 'msg_a', model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'tu_1', name: 'Agent', input: { subagent_type: 'Explore' } }] },
  }, 1, facts);
  const sub = r.feed(assistant('msg_b', { input_tokens: 5, output_tokens: 5 }, { parent_tool_use_id: 'tu_1' }), 2, facts);
  assert.equal(sub.usage!.subagent, 'Explore');
  r.startTurn('user');
  assert.equal(r.feed(assistant('msg_c', { input_tokens: 5, output_tokens: 5 }, { parent_tool_use_id: 'tu_1' }), 3, facts).usage!.trigger, 'answer', 'a subagent keeps the trigger it was launched under');
  assert.equal(sub.context, undefined);
});

test('thinking estimates go to the next main-thread call', () => {
  const r = new UsageRecorder();
  r.feed({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 300, estimated_tokens_delta: 300 }, 1, facts);
  r.feed({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 450, estimated_tokens_delta: 150 }, 2, facts);
  assert.equal(r.feed(assistant('m1', { input_tokens: 1, output_tokens: 500 }), 3, facts).usage!.thinking, 450);
  assert.equal(r.feed(assistant('m2', { input_tokens: 1, output_tokens: 5 }), 4, facts).usage!.thinking, null);
});

test('plan limits are read from rate limit events', () => {
  const r = new UsageRecorder();
  const out = r.feed({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.82, resetsAt: 1791600000 } }, 5, facts);
  assert.deepEqual({ ...out.limits![0], data: undefined }, { account: 'default', at: 5, kind: 'five_hour', status: 'allowed_warning', utilization: 0.82, resetsAt: 1791600000000, data: undefined });
});

test('every window in a rate limit event is read, with its utilization, even far from the limit', () => {
  const r = new UsageRecorder();
  const out = r.feed({ type: 'rate_limit_event', rate_limit_info: {
    status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1791816000,
    unifiedWindows: { five_hour: { utilization: 0.01, resetsAt: 1791816000 }, seven_day: { utilization: 0.63, resetsAt: 1791964800 } },
  } }, 5, facts);
  assert.deepEqual(out.limits!.map((l) => [l.kind, l.status, l.utilization, l.resetsAt]), [
    ['five_hour', 'allowed', 0.01, 1791816000000],
    ['seven_day', 'allowed', 0.63, 1791964800000],
  ]);
});

test("Haiku 5.5 is priced by each call's prompt length: over 100,000 tokens, cache hits included, costs more", () => {
  const near = (a: number | null, b: number) => assert.ok(Math.abs(a! - b) < 1e-12, `${a} ≠ ${b}`);
  // At the threshold: $0.10 in, $0.50 out, $0.125 cache write, $0.01 cache read.
  near(callCost('claude-haiku-5-5', { input: 40_000, output: 1_000, cacheWrite: 40_000, cacheRead: 20_000 }), (40_000 * 0.1 + 1_000 * 0.5 + 40_000 * 0.125 + 20_000 * 0.01) / 1e6);
  // One token over, the cache read tipping it: $0.50 in, $2.50 out, $0.625 cache write, $0.05 cache read.
  near(callCost('claude-haiku-5-5', { input: 40_000, output: 1_000, cacheWrite: 40_000, cacheRead: 20_001 }), (40_000 * 0.5 + 1_000 * 2.5 + 40_000 * 0.625 + 20_001 * 0.05) / 1e6);
  // Other models have one price across the context window.
  near(callCost('claude-sonnet-5-5', { input: 500_000, output: 0, cacheWrite: 0, cacheRead: 0 }), 1);
});

test('older models at their own prices: Opus 4 and 4.1 above Opus 4.5, Haiku 3.5', () => {
  const out = (model: string) => callCost(model, { input: 0, output: 1_000_000, cacheWrite: 0, cacheRead: 0 });
  assert.equal(out('claude-opus-4-1-20250805'), 75);
  assert.equal(out('claude-opus-4-20250514'), 75);
  assert.equal(out('claude-opus-4-5-20251101'), 25);
  assert.equal(out('claude-opus-4-6'), 25);
  assert.equal(out('claude-3-5-haiku-20241022'), 4);
  assert.equal(out('claude-mythos-5'), 50);
});

test('API-equivalent cost per call; unknown models get none', () => {
  // Sonnet 5.5: $2 in, $10 out, cache read $0.10, cache write 1.25 × input.
  const cost = callCost('claude-sonnet-5-5', { input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 });
  assert.ok(Math.abs(cost! - (2 + 10 + 2.5 + 0.1)) < 1e-9);
  assert.ok(Math.abs(callCost('claude-opus-5-5', { input: 0, output: 1_000_000, cacheWrite: 0, cacheRead: 0 })! - 20) < 1e-9);
  assert.equal(callCost('some-other-model', { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }), null);
});

test("Claude Code's synthetic placeholder replies are not model calls", () => {
  const r = new UsageRecorder();
  const out = r.feed({ type: 'assistant', parent_tool_use_id: null, message: { id: 'x', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 }, content: [] } }, 1, facts);
  assert.equal(out.usage, undefined);
});

// A result's modelUsage lists a helper model first and subagents' models after it (2026-10-13).
const win = (contextWindow: number) => ({ contextWindow, inputTokens: 1 });
const windowOf = (r: UsageRecorder, modelUsage: Record<string, unknown>) => r.feed({ type: 'result', modelUsage }, 9, facts).context?.window;

test('the context window is the session model\'s, not the helper\'s or a subagent\'s', () => {
  const r = new UsageRecorder();
  r.feed({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' }, 1, facts);
  assert.equal(windowOf(r, { 'claude-haiku-4-5': win(200000), 'claude-sonnet-5-5': win(500000), 'claude-opus-5': win(1000000) }), 500000);
});

test('the context window matches init\'s model despite a [1m] suffix or an alias', () => {
  const keys = { 'claude-haiku-4-5': win(200000), 'claude-sonnet-5-5[1m]': win(1000000), 'claude-opus-5': win(300000) };
  const a = new UsageRecorder();
  a.feed({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' }, 1, facts);
  assert.equal(windowOf(a, keys), 1000000, 'init without the suffix');
  const b = new UsageRecorder();
  b.feed({ type: 'system', subtype: 'init', model: 'sonnet[1m]' }, 1, facts);
  assert.equal(windowOf(b, keys), 1000000, 'init as an alias');
});

test('without a matching init the busiest main-thread model gives the window; subagents never do', () => {
  const r = new UsageRecorder();
  r.feed(assistant('m1', { input_tokens: 10, cache_read_input_tokens: 5000 }), 1, facts);
  r.feed({ ...assistant('m2', { input_tokens: 90000 }, { parent_tool_use_id: 'tu_x' }), message: { id: 'm2', model: 'claude-opus-5', usage: { input_tokens: 90000 }, content: [] } }, 2, facts);
  assert.equal(windowOf(r, { 'claude-haiku-4-5': win(200000), 'claude-opus-5': win(1000000), 'claude-sonnet-5-5': win(400000) }), 400000);
  assert.equal(windowOf(new UsageRecorder(), { 'claude-haiku-4-5': win(200000) }), undefined, 'nothing known: no window rather than a helper\'s');
});
