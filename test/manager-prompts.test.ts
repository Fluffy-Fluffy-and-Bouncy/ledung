// A manager's own pending prompt froze its turn and its inbox (issue #308): Claude Code waits on a permission prompt
// before the tool runs, and Ledung hands a session its messages only between turns, never while a prompt is open
// (deliver() returns while one is pending; research for #262, §3). #262 ended that for a manager's own shell call that
// away mode holds. Martin 2026-11-13, Ledung question #2183 "a — Fix both kinds": a manager's own AskUserQuestion or
// ExitPlanMode is declined at once, pointing at ask_user; its own settings change and sensitive non-shell call return
// at once as a question to Martin, and on Allow once its exact retry goes through once. Workers' prompts stay as today.
// Driven through the same entry points Claude Code calls (the PreToolUse hook and canUseTool); nothing here comes from
// running the new code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';
import { Away } from '../src/sessions/away.ts';
import { refusalAnswerText } from '../src/sessions/refusals.ts';

const clock = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** Two hours ahead of the real clock, so the away period never runs out during a test. */
const later = () => clock(Date.now() + 2 * 3600_000);

/** A sensitive MCP tool and a sensitive file, by the project's lists; and merges, a sensitive command. */
const PROD = 'mcp__prod__run';
const SECRET = { file_path: 'secrets/key.txt', old_string: 'a', new_string: 'b' };
const MERGE = 'gh pr merge 12 -R o/r --merge';
const SETTINGS = 'mcp__ledung__set_project_settings';

type Result = { behavior: string; message?: string; updatedInput?: Record<string, unknown> };

function setup() {
  const store = new Store(openDatabase(':memory:'));
  const management = new Management({
    store, userName: 'Martin', publish: () => {}, wake: () => {}, resume: async () => {},
    startSession: async () => { throw new Error('not used'); },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p'], decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {}, handoffProblem: () => null, shotPath: (_id, file) => file,
    projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
    ensureManager: async () => { throw new Error('not used'); },
  });
  const away = new Away(store, () => {});
  const make = (id: string, role: 'manager' | undefined, parentId: string | null) => {
    store.createSession({ id, project: 'p', runner: 'local', title: role ? 'Manager: p' : 'Worker', parentId, permissionMode: 'default', ...(role ? { role } : {}) });
    const pushed: string[] = [];
    const session = new Session({
      info: store.getSession(id)!, store, publish: () => {}, userName: 'Martin', management, away, devShip: null,
      runner: { cwd: '.', currentBranch: async () => null } as never,
      sensitive: { commandPatterns: [String.raw`\bgh\s+pr\s+merge\b`], pathPatterns: ['secrets/'], mcpTools: [PROD] },
      gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    });
    const s = session as unknown as { q: unknown; onMessage(m: unknown): void; input: { push(t: string): void } };
    s.q = {};
    s.input = { push: (t: string) => pushed.push(t) };
    store.updateSession(id, { status: 'running' });
    const pre = async () => (await session.claudeOptions({ onLine: () => {}, onStderr: () => {} })).hooks!.PreToolUse![0]!.hooks[0]!;
    return {
      pushed,
      /** canUseTool's path: the permission step Claude Code reaches after the hook's "ask". */
      call: (toolName: string, input: Record<string, unknown>, o: { toolUseID?: string; agentID?: string; requestId?: string } = {}) => (session as unknown as {
        onPermission(t: string, i: Record<string, unknown>, o: object): Promise<Result>;
      }).onPermission(toolName, input, { signal: new AbortController().signal, ...o }),
      /** Ledung's PreToolUse answer: allow, ask, deny, or none (left to Claude Code). */
      hook: async (toolName: string, input: Record<string, unknown>, toolUseId: string, extra: Record<string, unknown> = {}) => {
        const out = await (await pre())({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: input, ...extra } as never, toolUseId, { signal: new AbortController().signal }) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
        return { decision: out.hookSpecificOutput?.permissionDecision ?? 'none', reason: out.hookSpecificOutput?.permissionDecisionReason ?? '' };
      },
      /** The end of a turn, as Claude Code's stream gives it. */
      turnEnds: () => s.onMessage({ type: 'result', subtype: 'success', num_turns: 1, result: '', session_id: 'x', total_cost_usd: 0, usage: {} }),
    };
  };
  const mgr = make('mgr', 'manager', null);
  const worker = make('w', undefined, 'mgr');
  const asked = () => store.listQuestions(100).filter((q) => q.details?.refusal?.held === 'prompt');
  const settle = <T>(p: Promise<T>) => Promise.race([p, new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 50))]);
  return { store, away, mgr, worker, asked, settle };
}

const msg = (r: Result | 'waiting') => (r === 'waiting' ? '' : r.message ?? '');

test("#308: a manager's own AskUserQuestion and ExitPlanMode are declined at once, pointing at ask_user, present or away; a worker's stay prompts", async () => {
  const t = setup();
  for (const awayNow of [false, true]) {
    if (awayNow) t.away.start(later(), ['merge']);
    const q = await t.settle(t.mgr.call('AskUserQuestion', { questions: [{ question: 'Merge?', options: [{ label: 'Yes' }, { label: 'No' }] }] }, { toolUseID: `ask-${awayNow}` }));
    assert.equal(q !== 'waiting' && q.behavior, 'deny', 'returned at once');
    assert.match(msg(q), /Ledung declined AskUserQuestion/);
    assert.match(msg(q), /ask_user \(mcp__ledung__ask_user\)/);
    const plan = await t.settle(t.mgr.call('ExitPlanMode', { plan: 'Do it' }, { toolUseID: `plan-${awayNow}` }));
    assert.equal(plan !== 'waiting' && plan.behavior, 'deny');
    assert.match(msg(plan), /Ledung declined ExitPlanMode.*ask_user/);
    assert.equal(t.store.pendingPermissions().length, 0, 'no prompt');
    assert.notEqual(t.store.getSession('mgr')!.status, 'waiting');
    if (awayNow) t.away.stop();
  }
  // The positive branch: the same calls from a worker are prompts, to its manager, as before.
  assert.equal(await t.settle(t.worker.call('AskUserQuestion', { questions: [] }, { toolUseID: 'w-ask' })), 'waiting');
  assert.equal(await t.settle(t.worker.call('ExitPlanMode', { plan: 'x' }, { toolUseID: 'w-plan' })), 'waiting');
  assert.equal(t.store.pendingPermissions().filter((p) => p.sessionId === 'w').length, 2);
  assert.equal(t.store.listQuestions(100).length, 0, 'no question for any of them');
});

test("#308: a manager's own sensitive non-shell call and settings change return at once as a question to Martin, with the rule a prompt would have shown", async () => {
  const t = setup();
  for (const [toolName, input, rule] of [
    [PROD, { sql: 'select 1' }, /mcp__prod__run/],
    ['Edit', SECRET, /secrets\//],
    [SETTINGS, { project: 'p', managerGrant: 'anything' }, /settings/],
  ] as const) {
    const out = await t.settle(t.mgr.call(toolName, { ...input }, { toolUseID: `${toolName}-1` }));
    assert.equal(out !== 'waiting' && out.behavior, 'deny', `${toolName}: returned at once`);
    const q = t.asked().find((x) => x.details!.refusal!.toolName === toolName)!;
    assert.ok(q, `${toolName}: a question`);
    assert.equal(q.addressedTo, 'user');
    assert.equal(q.status, 'open');
    assert.match(q.details!.refusal!.reason, rule);
    assert.match(q.question, /needs your allow/);
    assert.match(msg(out), new RegExp(`^Waiting for Martin's allow as Ledung question #${q.id}; this call did not run`));
    assert.doesNotMatch(msg(out), /^Permission for this action was denied/, 'never read as a classifier refusal');
    // Allow always names an exact shell command: a non-shell call is offered Allow once and Deny (as for #225).
    assert.deepEqual(q.options, ['Allow once', 'Deny']);
  }
  assert.equal(t.store.pendingPermissions().length, 0, 'no prompt');
  assert.notEqual(t.store.getSession('mgr')!.status, 'waiting');
});

test('#308: messages reach the manager while each of these questions is open; before, the prompt held them', async () => {
  for (const [toolName, input] of [
    ['AskUserQuestion', { questions: [] }],
    ['ExitPlanMode', { plan: 'x' }],
    [PROD, { sql: 'select 1' }],
    ['Edit', SECRET],
    [SETTINGS, { project: 'p', managerGrant: 'anything' }],
  ] as const) {
    const t = setup();
    t.store.addInbox('mgr', 'manager:w', 'Worker finished: PR #12 is ready.');
    const out = await t.settle(t.mgr.call(toolName, { ...input }, { toolUseID: 'x' }));
    assert.equal(out !== 'waiting' && out.behavior, 'deny', `${toolName}: returned at once`);
    assert.equal(t.mgr.pushed.length, 0, 'nothing pushed in the middle of the turn');
    t.mgr.turnEnds();
    assert.equal(t.store.undeliveredInbox('mgr').length, 0, `${toolName}: the worker's report was delivered`);
    assert.equal(t.mgr.pushed.length, 1);
    // The question, where there is one, is still open: the inbox did not wait for Martin's answer.
    for (const q of t.asked()) assert.equal(q.status, 'open');
  }
  // The positive branch: a worker's prompt still holds its own inbox, as before.
  const t = setup();
  t.store.addInbox('w', 'manager:mgr', 'Carry on.');
  assert.equal(await t.settle(t.worker.call(PROD, { sql: 'select 1' }, { toolUseID: 'y' })), 'waiting');
  t.worker.turnEnds();
  assert.equal(t.store.undeliveredInbox('w').length, 1, "a worker's prompt still holds its inbox");
});

test("#308: Martin's Allow once lets the manager's exact retry through once; a changed call, a second retry or a subagent's call is not", async () => {
  const t = setup();
  await t.settle(t.mgr.call(PROD, { sql: 'select 1' }, { toolUseID: 'p-1' }));
  const [q] = t.asked();
  assert.notEqual((await t.mgr.hook(PROD, { sql: 'select 1' }, 'early')).decision, 'allow', 'not before Martin answers');
  assert.ok(t.store.answerQuestion(q!.id, 'Allow once', 'user'));
  assert.notEqual((await t.mgr.hook(PROD, { sql: 'drop table x' }, 'changed')).decision, 'allow', 'another call: not covered');
  assert.notEqual((await t.mgr.hook(PROD, { sql: 'select 1' }, 'sub', { agent_id: 'agent-1' })).decision, 'allow', "a subagent's identical call");
  const retry = await t.mgr.hook(PROD, { sql: 'select 1' }, 'retry');
  assert.equal(retry.decision, 'allow', 'the exact retry');
  assert.match(retry.reason, new RegExp(`question #${q!.id}`));
  assert.notEqual((await t.mgr.hook(PROD, { sql: 'select 1' }, 'again')).decision, 'allow', 'a second run');
  // Claude Code still bringing the let-through retry to the permission step: allowed on that answer, not asked again.
  assert.deepEqual(await t.settle(t.mgr.call(PROD, { sql: 'select 1' }, { toolUseID: 'retry' })), { behavior: 'allow', updatedInput: { sql: 'select 1' } });
  assert.equal(t.asked().length, 1, 'no new question');
  // The positive branch: the same call under an id no answer let through is asked again, as a new question.
  assert.equal((await t.settle(t.mgr.call(PROD, { sql: 'select 1' }, { toolUseID: 'later' })) as Result).behavior, 'deny');
  assert.equal(t.asked().length, 2);
});

test("#308: Deny grants nothing, a repeat while the question is open makes no second one, and the answers say what they mean", async () => {
  const t = setup();
  await t.settle(t.mgr.call('Edit', SECRET, { toolUseID: 'e-1' }));
  const [q] = t.asked();
  const again = await t.settle(t.mgr.call('Edit', SECRET, { toolUseID: 'e-2' }));
  assert.match(msg(again), new RegExp(`^Still waiting for Martin's allow as Ledung question #${q!.id}, which is still open`));
  assert.equal(t.asked().length, 1, 'no second question');
  t.store.answerQuestion(q!.id, 'Deny', 'user');
  assert.notEqual((await t.mgr.hook('Edit', SECRET, 'after-deny')).decision, 'allow');
  assert.match(refusalAnswerText(t.store.getQuestion(q!.id)!, 'Martin'), /^Martin declined the call Ledung asked them about/);
  // The positive branch: another such call is its own question, and its Allow once says to retry if still needed.
  await t.settle(t.mgr.call('Edit', { ...SECRET, new_string: 'c' }, { toolUseID: 'e-3' }));
  const other = t.asked().find((x) => x.id !== q!.id)!;
  t.store.answerQuestion(other.id, 'Allow once', 'user');
  const yes = refusalAnswerText(t.store.getQuestion(other.id)!, 'Martin');
  assert.match(yes, /^Martin allowed, once, the call Ledung asked them about/);
  assert.match(yes, /If it is still needed, retry exactly this call now, one time, unchanged/);
  assert.doesNotMatch(yes, /classifier|away mode/);
});

test("#308: what keeps the prompt: a worker's call, a manager's sensitive shell call while Martin is here, and a re-sent request", async () => {
  const t = setup();
  assert.equal(await t.settle(t.worker.call(PROD, { sql: 'select 1' }, { toolUseID: 'w' })), 'waiting', "a worker's sensitive call");
  assert.equal(await t.settle(t.mgr.call('Bash', { command: MERGE }, { toolUseID: 'b' })), 'waiting', "a manager's sensitive Bash call, Martin here (#262 covers only away holds)");
  // A manager's prompt from before the update, which the host re-sends after the restart: the one on screen stays.
  t.store.createPermission({ id: 'old', sessionId: 'mgr', toolName: PROD, input: { sql: 'select 1' }, title: null, reason: null, requestId: 'req-1', sensitive: 'mcp__prod__run' });
  assert.equal(await t.settle(t.mgr.call(PROD, { sql: 'select 1' }, { toolUseID: 'r', requestId: 'req-1' })), 'waiting', 'a re-sent request');
  assert.equal(t.asked().length, 0, 'no question for any of them');
  assert.deepEqual(t.store.pendingPermissions().map((p) => p.sessionId).sort(), ['mgr', 'mgr', 'w']);
  // The positive branch on the same sessions: the manager's own new call is a question, at once.
  assert.equal((await t.settle(t.mgr.call(PROD, { sql: 'select 1' }, { toolUseID: 'n' })) as Result).behavior, 'deny');
  assert.equal(t.asked().length, 1);
});
