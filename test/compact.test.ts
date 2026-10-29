// Compact for managers and sessions, self-clear for sessions (docs/steps/clear-and-compact.md).
// Message sequences are the ones Claude Code 2.1.295 sent in the findings (clear-and-compact-findings.md 2 and 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { compactCommand, compactNote, compactNoteText, Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';
import { handoffProblem } from '../src/sessions/files.ts';
import { compactionUsage, contextAfterCompact } from '../src/usage/recorder.ts';
import { CONTEXT_TOOLS, LEDUNG_TOOLS } from '../src/sessions/tools.ts';
import { removeTemp } from './temp.ts';

function setup() {
  const store = new Store(openDatabase(':memory:'));
  const woken: string[] = [];
  const management = new Management({
    store, userName: 'Simon', publish: () => {}, wake: (id) => woken.push(id), resume: async () => {},
    startSession: async () => { throw new Error('not used'); },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p'], decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {},
    projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
    ensureManager: async () => { throw new Error('not used'); },
    handoffProblem: (_id, file) => (file === 'docs/handoff.md' ? null : `The handoff file can't be used: There is no file ${file} in the project.`),
    shotPath: (_id, file) => file,
  });
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager', parentId: null, permissionMode: 'default', role: 'manager' });
  const info = store.createSession({ id: 's', project: 'p', runner: 'local', title: 'Worker', parentId: 'mgr', permissionMode: 'default' });
  const pushed: string[] = [];
  const session = new Session({
    info, store, publish: () => {}, userName: 'Simon', management,
    runner: { cwd: '.', currentBranch: async () => null } as never,
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
  });
  const s = session as unknown as { q: unknown; onMessage(m: unknown): void; input: { push(t: string): void } };
  s.q = {};
  s.input = { push: (t: string) => pushed.push(t) };
  store.updateSession('s', { status: 'idle' });
  const events = () => store.listMessages('s', { limit: 100 }).filter((m) => m.kind === 'event').map((m) => m.data.text as string);
  return { store, management, session, woken, pushed, events, feed: (m: unknown) => s.onMessage(m) };
}

const BOUNDARY = { type: 'system', subtype: 'compact_boundary', uuid: 'b1', compact_metadata: { trigger: 'manual', pre_tokens: 70_700, post_tokens: 2_400, duration_ms: 15_700 } };
const SUCCESS = [
  { type: 'system', subtype: 'status', status: 'compacting' },
  { type: 'system', subtype: 'status', status: null, compact_result: 'success' },
  BOUNDARY,
  { type: 'result', subtype: 'success', num_turns: 0, result: '' },
];
const FAILED = [
  { type: 'system', subtype: 'status', status: 'compacting' },
  { type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'API Error: Request was aborted.' },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '' },
];

test('the note for the summary: one line, at most 200 characters, refused rather than cut', () => {
  assert.equal(compactNote(undefined), undefined);
  assert.equal(compactNote('  Keep\nthe   review points  '), 'Keep the review points');
  assert.equal(compactNote('x'.repeat(200))?.length, 200);
  assert.throws(() => compactNote('x'.repeat(201)), /201 characters; at most 200/);
  assert.equal(compactCommand(null, 'manager "M"', 'Simon'), '/compact');
  assert.equal(compactCommand('Keep numbers.', 'manager "M"', 'Simon'), '/compact Additional instructions from Ledung, requested by manager "M" (not from Simon): Keep numbers.');
});

test('compact_session: own sessions or itself; queued behind what waits, then the note', async () => {
  const { store, management, woken } = setup();
  store.createSession({ id: 'stranger', project: 'p', runner: 'local', title: 'Other', parentId: null, permissionMode: 'default' });
  await assert.rejects(management.compactSession('mgr', 'stranger'), /not one you started/);
  await management.sendMessage('mgr', 's', 'Write your notes.');
  assert.match(await management.compactSession('mgr', 's', 'Keep numbers.', 'Go on with step 3.'), /compacted when it is free, then gets your message/);
  assert.deepEqual(store.undeliveredInbox('s').map((i) => [i.source, i.text]), [
    ['manager:mgr', 'Message from your manager "Manager":\n\nWrite your notes.'], ['compact:mgr', 'Keep numbers.'], ['compact-note:mgr', 'Go on with step 3.'],
  ]);
  assert.ok(woken.includes('s'));
  assert.match(await management.compactSession('mgr', undefined), /Your conversation is compacted after this turn ends/);
  assert.equal(store.undeliveredInbox('mgr').at(-1)!.source, 'compact:mgr');
});

test('one compact or clear at a time, in every combination', async () => {
  const { store, management } = setup();
  await management.compactSession('mgr', 's');
  assert.match(await management.compactSession('mgr', 's'), /A compact of "Worker" is already waiting or under way/);
  assert.match(await management.clearSession('mgr', 's'), /A compact of "Worker" is already waiting/);
  assert.match(management.compactSelf('s'), /already waiting/);
  assert.match(management.clearSelf('s', 'docs/handoff.md'), /already waiting/);
  // Running: the inbox item is gone, the field holds it.
  store.markInboxDelivered(store.undeliveredInbox('s').map((i) => i.id));
  store.updateSession('s', { compacting: { requester: 'mgr', startedAt: 1, note: null } });
  assert.match(await management.clearSession('mgr', 's'), /A compact of "Worker" is already waiting or under way/);
  store.updateSession('s', { compacting: null });
  await management.clearSession('mgr', 's');
  assert.match(await management.compactSession('mgr', 's'), /A clear of "Worker" is already waiting/);
});

test('clear_self: refuses without a usable handoff file; otherwise the countdown and a note that points at it', () => {
  const { store, management } = setup();
  assert.throws(() => management.clearSelf('s', 'notes.md'), /no file notes.md/);
  assert.equal(store.undeliveredInbox('s').length, 0, 'nothing queued');
  assert.match(management.clearSelf('s', 'docs\\handoff.md', 'Then issue 12.', 5), /pointed at docs\/handoff.md. Simon gets 10 s to cancel it/);
  const [clear, note] = store.undeliveredInbox('s');
  assert.equal(clear!.source, 'clear:10:s');
  assert.match(note!.text, /cleared at your own request \(clear_self\). Your handoff note is docs\/handoff.md: read it first.*Then issue 12\./s);
});

test('a successful compact: the labelled command, the figures, the note after it, and the context figure', () => {
  const { store, management, session, pushed, feed, events, woken } = setup();
  void management.compactSession('mgr', 's', 'Keep numbers.', 'Go on with step 3.');
  session.deliver();
  assert.equal(pushed.at(-1), '/compact Additional instructions from Ledung, requested by manager "Manager" (not from Simon): Keep numbers.');
  assert.equal(store.getSession('s')!.status, 'running');
  assert.equal(store.getSession('s')!.compacting!.requester, 'mgr');
  assert.match(events().at(-1)!, /^Compact requested by manager "Manager". Note for the summary: Keep numbers\.$/);
  woken.length = 0;
  for (const m of SUCCESS) feed(m);
  assert.equal(store.getSession('s')!.compacting, null);
  assert.equal(store.getSession('s')!.status, 'running', 'the note went straight in');
  assert.match(pushed.at(-1)!, /Ledung has delivered messages/);
  assert.equal(store.undeliveredInbox('s').length, 0);
  const delivered = store.listMessages('s', { limit: 100 }).filter((m) => m.kind === 'user').at(-1)!;
  assert.match(delivered.data.context, /compacted by your manager "Manager". Message from your manager "Manager":\n\nGo on with step 3\./);
  assert.ok(!woken.includes('mgr'), 'a success needs no news for the manager');
});

test('the context figure: after a compact the fixed part is kept; after a clear it is unknown', () => {
  assert.equal(contextAfterCompact(25_961, 2_452), 28_413, 'the live test: the smallest call plus the summary');
  assert.equal(contextAfterCompact(null, 2_400), 2_400, 'no call recorded yet: post alone');
});

test('a compact that failed: the event, the note says so, the manager is woken; nothing for the user', () => {
  const { store, management, session, feed, events, woken } = setup();
  void management.compactSession('mgr', 's', undefined, 'Go on.');
  session.deliver();
  woken.length = 0;
  for (const m of FAILED) feed(m);
  assert.ok(events().includes('Compact failed: API Error: Request was aborted.'));
  const delivered = store.listMessages('s', { limit: 100 }).filter((m) => m.kind === 'user').at(-1)!;
  assert.match(delivered.data.context, /The compact your manager "Manager" asked for failed \(API Error: Request was aborted\.\); your context is unchanged\./);
  assert.ok(woken.includes('mgr'));
  assert.match(store.undeliveredInbox('mgr').at(-1)!.text, /"Worker" \(s\) could not be compacted: API Error: Request was aborted\. Its context is unchanged\./);
});

test('a failure seen only in the result text still counts as a failure', () => {
  const { store, management, session, feed, events } = setup();
  void management.compactSession('mgr', 's');
  session.deliver();
  feed({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: 'Error during compaction: API Error: 500 boom' });
  assert.ok(events().includes('Compact failed: API Error: 500 boom'));
  assert.equal(store.getSession('s')!.compacting, null);
});

test('nothing to compact: said as such, not as a failure', () => {
  const { store, management, session, feed, events } = setup();
  void management.compactSession('mgr', 's');
  session.deliver();
  feed({ type: 'result', subtype: 'success', num_turns: 0, result: '' });
  assert.ok(events().includes('Nothing to compact yet; the context is unchanged.'));
  assert.match(store.undeliveredInbox('mgr').at(-1)!.text, /had nothing to compact yet/);
});

test("a session's own compact: its manager hears quietly; a failure reaches the session itself", () => {
  const { store, management, session, feed, woken } = setup();
  assert.match(management.compactSelf('s'), /compacted after this turn ends/);
  session.deliver();
  assert.match(store.listMessages('s', { limit: 100 }).filter((m) => m.kind === 'event').at(-1)!.data.text, /Compact requested by the session itself\./);
  woken.length = 0;
  for (const m of SUCCESS) feed(m);
  assert.match(store.undeliveredInbox('mgr').at(-1)!.text, /"Worker" \(s\) asked to compact itself and was compacted: 71k → 2.4k in 16 s\./);
  assert.ok(!woken.includes('mgr'), 'quiet');
  management.compactSelf('s');
  session.deliver();
  for (const m of FAILED) feed(m);
  const toSession = store.listMessages('s', { limit: 100 }).filter((m) => m.kind === 'user').at(-1)!;
  assert.match(toSession.data.context, /the compact you asked for failed \(API Error: Request was aborted\.\)/);
});

test('the 10-minute alert goes out once, to the requester; for a session\'s own compact its manager is woken too', () => {
  const { store, session, woken } = setup();
  store.updateSession('s', { compacting: { requester: 's', startedAt: 0, note: null } });
  session.checkCompact(9 * 60000);
  assert.equal(woken.length, 0);
  session.checkCompact(11 * 60000);
  assert.ok(woken.includes('mgr'));
  assert.match(store.undeliveredInbox('mgr').at(-1)!.text, /has run 11 minutes with no result/);
  assert.match(store.undeliveredInbox('s').at(-1)!.text, /has run 11 minutes/);
  assert.equal(store.getSession('s')!.compacting!.alerted, true);
  woken.length = 0;
  session.checkCompact(20 * 60000);
  assert.equal(woken.length, 0, 'once');
});

test('the note heading for each outcome', () => {
  assert.match(compactNoteText({ kind: 'success' }, true, 'W', 'x'), /^Your conversation was compacted at your own request\. Your note to yourself:\n\nx$/);
  assert.match(compactNoteText({ kind: 'ended' }, false, 'M', 'x'), /^The session ended before the compact finished; your context is unchanged\. Message from your manager "M"/);
});

test('the cost of a compact is the difference of the running totals (probe of 2026-10-13)', () => {
  const facts = { sessionId: 's', project: 'p', role: 'session' as const, team: 'mgr', branch: null, trigger: 'manager' as const };
  const before = [
    { type: 'result', num_turns: 1, modelUsage: { 'claude-haiku-5-5': { inputTokens: 15852, outputTokens: 654, cacheReadInputTokens: 50289, cacheCreationInputTokens: 27343 } } },
    { type: 'system', subtype: 'status', status: 'compacting' },
    BOUNDARY,
  ];
  const result = { type: 'result', num_turns: 0, modelUsage: { 'claude-haiku-5-5': { inputTokens: 20457, outputTokens: 2663, cacheReadInputTokens: 84258, cacheCreationInputTokens: 30889 } } };
  const [r, ...rest] = compactionUsage(before, result, 5, facts)!;
  assert.equal(rest.length, 0);
  assert.deepEqual([r!.input, r!.output, r!.cacheRead, r!.cacheWrite, r!.kind, r!.messageId, r!.trigger], [4605, 2009, 33969, 3546, 'compaction', 'compact:b1', 'manager']);
  assert.deepEqual(compactionUsage(before.slice(0, 2), result, 5, facts), [], 'no boundary: no compaction');
  assert.equal(compactionUsage(before.slice(1), result, 5, facts), null, 'no earlier result: not known');
  const afterClear = [before[0], { type: 'conversation_reset' }, BOUNDARY];
  assert.equal(compactionUsage(afterClear, result, 5, facts)![0]!.input, 20457, 'a clear resets the totals');
  const down = { type: 'result', num_turns: 0, modelUsage: { 'claude-haiku-5-5': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 1 } } };
  assert.equal(compactionUsage(before, down, 5, facts), null, 'totals going down: not known');
  assert.deepEqual(compactionUsage([...before.slice(0, 1), { ...BOUNDARY, compact_metadata: { ...BOUNDARY.compact_metadata, trigger: 'auto' } }], result, 5, facts), [], 'automatic compaction is not counted here');
});

test('the compact and clear tools need no prompt, and only the main session may call them', async () => {
  for (const t of ['compact_self', 'clear_self', 'compact_session', 'clear_session']) {
    assert.ok(LEDUNG_TOOLS.includes(`mcp__ledung__${t}`));
    assert.ok(CONTEXT_TOOLS.includes(`mcp__ledung__${t}`));
  }
  const { session } = setup();
  const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
  const call = (agent_id?: string) => hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__ledung__compact_self', tool_input: {}, agent_id } as never, undefined, { signal: new AbortController().signal });
  assert.deepEqual(await call(), {});
  assert.equal(((await call('sub-1')) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny');
});

test('the handoff check: inside the project, not empty, changed within the hour', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-handoff-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'handoff.md'), '# Handoff\nNext: issue 12.');
    fs.writeFileSync(path.join(root, 'empty.md'), '  \n');
    fs.writeFileSync(path.join(root, 'old.md'), 'old');
    const hourAgo = (Date.now() - 2 * 3600_000) / 1000;
    fs.utimesSync(path.join(root, 'old.md'), hourAgo, hourAgo);
    assert.equal(handoffProblem(root, 'docs/handoff.md'), null);
    assert.match(handoffProblem(root, 'missing.md')!, /no file missing.md/);
    assert.match(handoffProblem(root, 'empty.md')!, /is empty/);
    assert.match(handoffProblem(root, 'old.md')!, /last changed 120 minutes ago/);
    assert.match(handoffProblem(root, '../outside.md')!, /no file|inside the project/);
  } finally {
    removeTemp(root);
  }
});

test('the divider shows the figures from compact_metadata', async () => {
  const { compactedLabel } = await import('../src/shared/compact-label.ts');
  assert.equal(compactedLabel({ pre_tokens: 70_700, post_tokens: 2_400, duration_ms: 15_700 }), 'Compacted: 71k → 2.4k in 16 s.');
  assert.equal(compactedLabel({ pre_tokens: 6_300, post_tokens: 2_100 }), 'Compacted: 6.3k → 2.1k.');
  assert.equal(compactedLabel(undefined), 'Compacted.');
});
