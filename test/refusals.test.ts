// Classifier refusals reach the person at once, with Allow once (issue #104). The refusal text is Claude Code's own,
// read from its program (2.1.x): "Permission for this action was denied by the Claude Code auto mode classifier.
// Reason: …". The session is fed the stream lines a refused call gives; its PreToolUse hook is called as Claude Code
// calls it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { buildDelivery, Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';
import { Push, type PushPayload } from '../src/server/push.ts';
import { classifierReason, guardedWrite, sameCall } from '../src/sessions/refusals.ts';
import { waitingLists } from '../web/src/waitingLists.ts';
import type { QuestionInfo, ServerEvent } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';

// Built as Claude Code's message builder builds a classifier block (agent SDK 0.3.295, its bundled claude.exe), all on
// one line: the reason, then its advice to the model, and sometimes the sentence about a permission rule.
const ADVICE = "If you have other tasks that don't depend on this action, continue working on those. IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, e.g. do not use your ability to run tests to execute non-test actions. You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. Let the user decide how to proceed.";
const REFUSED = (reason: string, rule = false) =>
  `Permission for this action was denied by the Claude Code auto mode classifier. Reason: ${reason}. ${ADVICE}` +
  (rule ? ' To allow this type of action in the future, the user can add a permission rule for Bash to their settings.' : '');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-refusals-'));
after(() => removeTemp(temp));

function setup() {
  const store = new Store(openDatabase(':memory:'));
  const management = new Management({
    store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async () => {},
    startSession: async () => { throw new Error('not used'); },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p'], decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {},
    projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
    ensureManager: async () => { throw new Error('not used'); },
    handoffProblem: () => null, shotPath: (_id, file) => file,
  });
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager', parentId: null, permissionMode: 'auto', role: 'manager' });
  const info = store.createSession({ id: 's', project: 'p', runner: 'local', title: 'Worker', parentId: 'mgr', permissionMode: 'auto' });
  // The push to phones, as the server wires it: every event passes Push.notice; what it would send is kept.
  const sent: PushPayload[] = [];
  const push = new Push({ db: store.database, keyFile: path.join(temp, 'vapid.json'), computer: () => 'PC', publicName: () => 'ledung.example' });
  (push as unknown as { send(p: PushPayload): void }).send = (p) => sent.push(p);
  const published: ServerEvent[] = [];
  const session = new Session({
    info, store, userName: 'Simon', management,
    publish: (e) => { published.push(e); push.notice(e); },
    runner: { cwd: '.', currentBranch: async () => null } as never,
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
  });
  const s = session as unknown as { q: unknown; onMessage(m: unknown): void };
  s.q = {};
  store.updateSession('s', { status: 'running' });
  /** The two lines a refused call gives: the model's tool_use, then Claude Code's error result for it. */
  const refuse = (id: string, command: string, reason = 'External System Writes', isError = true) => {
    s.onMessage({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Do it' } }] } });
    s.onMessage({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: REFUSED(reason) }] } });
  };
  /** The same two lines for any tool's call (Project-Ledung#470). */
  const refuseCall = (id: string, name: string, input: Record<string, unknown>, reason = '[Self-Modification]') => {
    s.onMessage({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input }] } });
    s.onMessage({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: REFUSED(reason) }] } });
  };
  const refusals = () => store.listQuestions(100).filter((q) => q.details?.refusal);
  const hooks = async () => {
    const o = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
    const pre = o.hooks!.PreToolUse![0]!.hooks[0]!;
    const post = o.hooks!.PostToolUse![0]!.hooks[0]!;
    const signal = { signal: new AbortController().signal };
    return {
      /** Ledung's PreToolUse answer for a Bash call: 'allow', or null when it doesn't allow it itself. */
      decide: async (command: string, toolUseId: string, description = 'Again') => {
        const out = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description } } as never, toolUseId, signal) as { hookSpecificOutput?: { permissionDecision?: string } };
        return out.hookSpecificOutput?.permissionDecision === 'allow' ? 'allow' : null;
      },
      /** The same for any tool's call. */
      decideCall: async (toolName: string, toolInput: Record<string, unknown>, toolUseId: string) => {
        const out = await pre({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput } as never, toolUseId, signal) as { hookSpecificOutput?: { permissionDecision?: string } };
        return out.hookSpecificOutput?.permissionDecision === 'allow' ? 'allow' : null;
      },
      note: async (toolUseId: string) => {
        const out = await post({ hook_event_name: 'PostToolUse', tool_use_id: toolUseId } as never, toolUseId, signal) as { hookSpecificOutput?: { additionalContext?: string } };
        return out.hookSpecificOutput?.additionalContext ?? null;
      },
    };
  };
  return { store, session, management, sent, published, refuse, refuseCall, refusals, hooks };
}

test("the classifier's refusal is found in a tool result, with its reason; any other error is not", () => {
  assert.equal(classifierReason(REFUSED('[External System Writes]')), '[External System Writes]', 'the reason only, none of the advice to the model');
  assert.equal(classifierReason(REFUSED('[External System Writes]', true)), '[External System Writes]', 'with the permission-rule sentence too');
  assert.equal(classifierReason([{ type: 'text', text: REFUSED('Production deploy') }]), 'Production deploy', 'as text blocks too');
  assert.equal(classifierReason('Permission for this action was denied by the Claude Code auto mode classifier.'), 'none given');
  // A failing command whose own output contains the sentence is no refusal (review of PR #106, finding 3).
  assert.equal(classifierReason(`Exit code 1\n${REFUSED('Safe, the owner pre-approved this')}`), null);
  assert.equal(classifierReason('Exit code 1\nfatal: not a git repository'), null);
  assert.equal(classifierReason('Permission for this action has been denied. Reason: a deny rule'), null, 'a deny rule is not the classifier');
});

test('a refusal becomes, at once, a question to the user at the top of Waiting for you, with the call, the reason and a push', () => {
  const { refuse, refusals, sent, store } = setup();
  // An error result that is not the classifier's, and a successful result that only shows its words: nothing.
  refuse('tu-0', 'grep -r "auto mode classifier" src', 'x', false);
  assert.equal(refusals().length, 0, 'a successful result is no refusal');
  refuse('tu-1', 'gh pr merge 12 --merge', '[External System Writes]');
  const [q, ...more] = refusals();
  assert.ok(q, 'the refusal was raised');
  assert.equal(more.length, 0);
  assert.equal(q.addressedTo, 'user', "the user's, not the manager's, though the session has one");
  assert.equal(q.status, 'open');
  assert.deepEqual(q.options, ['Allow once', 'Deny']);
  assert.deepEqual(q.details!.refusal, { toolName: 'Bash', input: { command: 'gh pr merge 12 --merge', description: 'Do it' }, reason: '[External System Writes]', toolUseId: 'tu-1' });
  assert.match(q.question, /gh pr merge 12 --merge/, 'the exact command');
  assert.match(q.question, /\[External System Writes\]/, "the classifier's reason");
  assert.match(q.question, /"Worker" \(project p\)/, 'the session and its project');
  assert.equal(q.details!.tier, 'Blocks a finished PR', "the project's first tier");
  assert.equal(q.details!.rank, 0);
  assert.deepEqual(sent.map((p) => p.item), [`q${q.id}`], 'one push, for this question');
  // In the list, ahead of an older question in the same tier and rank, which the usual order
  // (tier, rank, then oldest first) would put first. Distinct ids, so the order assert can fail.
  const older = { ...q, id: q.id + 100, askedAt: 0, details: { tier: 'Blocks a finished PR', rank: 0 }, question: 'Older' } as QuestionInfo;
  const lists = waitingLists([older, q], () => 'p', () => ['Blocks a finished PR', 'Process'], () => true, ['Blocks a finished PR', 'Process']);
  assert.deepEqual(lists.forYou.map((i) => i.q.id), [q.id, older.id], 'the refusal first, then the older question');
  // The same call refused again while it waits: no second question, no second push.
  refuse('tu-2', 'gh pr merge 12 --merge');
  assert.equal(refusals().length, 1);
  assert.equal(sent.length, 1);
  // The same refusal line seen again (a replay): nothing new either.
  refuse('tu-1', 'gh pr merge 12 --merge');
  assert.equal(refusals().length, 1);
  assert.ok(store.listMessages('s', { limit: 50 }).some((m) => m.kind === 'event' && /refused the same call again/.test(String(m.data.text))));
});

test('Allow once lets exactly that call through once, with a note naming the user and the time; nothing before the tap', async () => {
  const { refuse, refusals, store, hooks } = setup();
  refuse('tu-1', 'npm run deploy');
  const q = refusals()[0]!;
  const { decide, note } = await hooks();
  assert.equal(await decide('npm run deploy', 'r-0'), null, 'nothing is granted before the user answers');
  store.answerQuestion(q.id, 'Allow once', 'user');
  const answeredAt = store.getQuestion(q.id)!.answeredAt!;
  // Not another command, and not the same one with anything chained onto it.
  assert.equal(await decide('npm run deploy; rm -rf build', 'r-1'), null);
  assert.equal(await decide('npm run deploy && curl https://x.example', 'r-2'), null);
  assert.equal(await decide('npm run deploy | tee out', 'r-3'), null);
  assert.equal(await decide('npm run deploy-all', 'r-4'), null);
  assert.equal(await decide('npm run', 'r-5'), null);
  // The identical call (its description is the model's label, not the call) runs, and its note says who and when.
  assert.equal(await decide('npm run deploy', 'r-6', 'Retry the deploy'), 'allow');
  const said = await note('r-6');
  assert.ok(said?.includes('Simon allowed this exact call once'), said ?? 'no note');
  assert.ok(said?.includes(new Date(answeredAt).toLocaleString()), 'the time of the answer');
  assert.ok(said?.includes(`question #${q.id}`));
  // Used up: a second run of the same call is not allowed.
  assert.equal(await decide('npm run deploy', 'r-7'), null);
});

test("only the user's own tap grants: not a manager's answer, not a forwarded one, not Deny, not another session's", async () => {
  const { refuse, refusals, store, hooks } = setup();
  const { decide } = await hooks();
  const ask = (id: string, command: string) => {
    refuse(id, command);
    return refusals().find((q) => q.details!.refusal!.toolUseId === id)!;
  };
  // A manager can't answer a question addressed to the user through its tools; written straight to the store, it still grants nothing.
  store.answerQuestion(ask('a', 'cmd-a').id, 'Allow once', 'mgr');
  assert.equal(await decide('cmd-a', 'x-a'), null, "a manager's answer");
  store.answerQuestion(ask('b', 'cmd-b').id, 'Allow once', 'user', 99);
  assert.equal(await decide('cmd-b', 'x-b'), null, 'an answer passed on from another question');
  store.answerQuestion(ask('c', 'cmd-c').id, 'Deny', 'user');
  assert.equal(await decide('cmd-c', 'x-c'), null, 'Deny');
  store.answerQuestion(ask('d', 'cmd-d').id, 'Allow it whenever', 'user');
  assert.equal(await decide('cmd-d', 'x-d'), null, 'any other words');
  // The positive branch on the same session: the user's own Allow once does grant.
  store.answerQuestion(ask('e', 'cmd-e').id, 'Allow once\n\nNote: just this time', 'user');
  assert.equal(await decide('cmd-e', 'x-e'), 'allow');
  // Another session's question grants nothing here.
  store.createSession({ id: 'other', project: 'p', runner: 'local', title: 'Other', parentId: null, permissionMode: 'auto' });
  const foreign = store.createQuestion({ sessionId: 'other', question: 'x', options: ['Allow once', 'Deny'], addressedTo: 'user', details: { refusal: { toolName: 'Bash', input: { command: 'cmd-f' }, reason: 'r', toolUseId: 'f' } } });
  store.answerQuestion(foreign.id, 'Allow once', 'user');
  assert.equal(await decide('cmd-f', 'x-f'), null);
});

test('the session is told: retry once after Allow once, stop after Deny', () => {
  const { refuse, refusals, store } = setup();
  refuse('tu-1', 'gh pr comment 5 --body hi');
  refuse('tu-2', 'gh release create v1');
  const [allow, deny] = refusals().sort((a, b) => a.id - b.id);
  store.answerQuestion(allow!.id, 'Allow once', 'user');
  store.answerQuestion(deny!.id, 'Deny', 'user');
  const told = buildDelivery('Simon', [store.getQuestion(allow!.id)!, store.getQuestion(deny!.id)!], [], () => '').userText;
  assert.match(told, /Simon allowed, once, the call the auto mode classifier refused/);
  assert.match(told, /Retry exactly this call now, one time, unchanged:\n\n```\ngh pr comment 5 --body hi\n```/);
  assert.match(told, /Simon declined the call the auto mode classifier refused/);
  assert.match(told, /Don't retry it/);
});

test('the exact match: same tool and input, the description aside; no prefix, no chain', () => {
  const granted = { toolName: 'Bash', input: { command: 'git push origin main', description: 'Push' } };
  assert.ok(sameCall(granted, 'Bash', { command: 'git push origin main' }));
  assert.ok(sameCall(granted, 'Bash', { command: '  git push origin main ', description: 'Other words' }));
  assert.ok(!sameCall(granted, 'PowerShell', { command: 'git push origin main' }));
  assert.ok(!sameCall(granted, 'Bash', { command: 'git push origin main; git push --force' }));
  assert.ok(!sameCall(granted, 'Bash', { command: 'git push origin main && echo ok' }));
  assert.ok(!sameCall(granted, 'Bash', { command: 'git push origin main', dangerouslyDisableSandbox: true }));
  assert.ok(sameCall({ toolName: 'Write', input: { file_path: 'a.txt', content: 'x' } }, 'Write', { content: 'x', file_path: 'a.txt' }), 'key order does not matter');
  // Another tool's description can be what it writes (review of PR #106, finding 2): it counts, at any depth.
  const issue = { toolName: 'mcp__tracker__create_issue', input: { title: 'a', description: 'benign' } };
  assert.ok(sameCall(issue, issue.toolName, { title: 'a', description: 'benign' }));
  assert.ok(!sameCall(issue, issue.toolName, { title: 'a', description: 'anything else' }));
  assert.ok(!sameCall(issue, issue.toolName, { title: 'a' }));
  const nested = { toolName: 'mcp__x__post', input: { body: { description: 'one' } } };
  assert.ok(!sameCall(nested, nested.toolName, { body: { description: 'two' } }));
  assert.ok(!sameCall(granted, 'Bash', { command: 'git push origin main', extra: { description: 'x' } }), "only a shell command's own top-level description is its label");
});

// Project-Ledung#470. Claude Code 2.1.316 checks a write to its own settings files (and the other paths it guards)
// before a PreToolUse hook's allow counts. So in auto mode the classifier decides the call, whatever the person
// answered to Allow once. Reproduced with a hook that allows every call: Claude Code still asked about
// .claude/settings.local.json ("Claude requested permissions to write to …, but you haven't granted it yet"), and it
// let the hook allow an ordinary file through. The settings Edit below is the one in the issue.
const SETTINGS_EDIT = {
  file_path: 'C:\\Users\\simon\\work\\ledung\\.claude\\settings.local.json',
  old_string: '{\n  "permissions": {}\n}',
  new_string: '{\n  "permissions": { "allow": ["Bash(npm run check)"] }\n}',
};

test('the files Claude Code guards itself are known; an ordinary file and a worktree under .claude are not', () => {
  assert.equal(guardedWrite('Edit', SETTINGS_EDIT), SETTINGS_EDIT.file_path, "the project's local settings, as in the issue");
  assert.ok(guardedWrite('Write', { file_path: '/home/simon/.claude/settings.json', content: '{}' }), "the user's settings");
  assert.ok(guardedWrite('Edit', { file_path: 'repo/.git/config', old_string: 'a', new_string: 'b' }), 'git config');
  assert.ok(guardedWrite('Write', { file_path: '/home/simon/.bashrc', content: '' }), 'a shell start file');
  assert.ok(guardedWrite('Edit', { file_path: 'repo/.mcp.json', old_string: 'a', new_string: 'b' }), "the project's MCP servers");
  assert.ok(guardedWrite('Edit', { file_path: 'repo/.claude/worktrees/w/.claude/settings.local.json', old_string: 'a', new_string: 'b' }), "a worktree's own settings");
  // Not guarded: an ordinary file, a file in a worktree under .claude (where every worker writes), a read, a shell command.
  assert.equal(guardedWrite('Edit', { file_path: 'C:\\Users\\simon\\work\\ledung\\src\\main.ts', old_string: 'a', new_string: 'b' }), null);
  assert.equal(guardedWrite('Edit', { file_path: 'C:\\Users\\simon\\work\\ledung\\.claude\\worktrees\\w\\src\\main.ts', old_string: 'a', new_string: 'b' }), null);
  assert.equal(guardedWrite('Read', { file_path: SETTINGS_EDIT.file_path }), null);
  assert.equal(guardedWrite('Bash', { command: 'echo {} > .claude/settings.local.json' }), null);
});

test('a refused write to a guarded file is never offered as Allow once: only the person can do it, and the question gives the exact edit', async () => {
  const { refuseCall, refusals, store, hooks } = setup();
  refuseCall('tu-s', 'Edit', SETTINGS_EDIT);
  const [q, ...more] = refusals();
  assert.ok(q, 'the refusal was raised');
  assert.equal(more.length, 0);
  assert.equal(q.addressedTo, 'user');
  assert.deepEqual(q.options, ['Done by hand', 'Deny'], 'no Allow once');
  assert.equal(q.details!.refusal!.byHand, 'protected');
  assert.match(q.question, /Only you can/);
  assert.match(q.question, /Allow once in Ledung can't get it past Claude Code/);
  // The exact edit, to make by hand: the file, the text to replace and what replaces it.
  assert.ok(q.question.includes(`Open \`${SETTINGS_EDIT.file_path}\` and make this one edit.`), q.question);
  assert.ok(q.question.includes(`\`\`\`\n${SETTINGS_EDIT.old_string}\n\`\`\`\n\nwith:\n\n\`\`\`\n${SETTINGS_EDIT.new_string}\n\`\`\``), 'old and new text, each as it is');
  // The words "Allow once" typed as an answer grant nothing: the question offered no such thing.
  store.answerQuestion(q.id, 'Allow once', 'user');
  const { decideCall } = await hooks();
  assert.equal(await decideCall('Edit', SETTINGS_EDIT, 'r-s'), null);
  // The positive branch: a refused Edit of an ordinary file still offers Allow once, and its tap lets the retry through.
  const plain = { file_path: 'C:\\Users\\simon\\work\\ledung\\src\\main.ts', old_string: 'a', new_string: 'b' };
  refuseCall('tu-p', 'Edit', plain, '[External System Writes]');
  const p = refusals().find((x) => x.details!.refusal!.toolUseId === 'tu-p')!;
  assert.deepEqual(p.options, ['Allow once', 'Deny']);
  assert.equal(p.details!.refusal!.byHand, undefined);
  store.answerQuestion(p.id, 'Allow once', 'user');
  assert.equal(await decideCall('Edit', plain, 'r-p'), 'allow');
});

test('a retry refused again after an Allow once tells the person, with the call to make by hand, not another Allow once', async () => {
  const { refuse, refusals, store, hooks, published } = setup();
  refuse('tu-1', 'Set-Content .claude/settings.local.json "{}"');
  const first = refusals()[0]!;
  assert.deepEqual(first.options, ['Allow once', 'Deny'], 'a shell command: what it writes is not read off it, so Allow once is offered');
  store.answerQuestion(first.id, 'Allow once', 'user');
  const { decide, note } = await hooks();
  // Ledung lets the retry through; Claude Code refuses it anyway.
  assert.equal(await decide('Set-Content .claude/settings.local.json "{}"', 'tu-2'), 'allow');
  refuse('tu-2', 'Set-Content .claude/settings.local.json "{}"', '[Self-Modification]');
  const again = refusals().filter((q) => q.id !== first.id);
  assert.equal(again.length, 1, 'the person is told');
  const q = again[0]!;
  assert.equal(q.addressedTo, 'user');
  assert.equal(q.status, 'open');
  assert.deepEqual(q.options, ['Done by hand', 'Deny'], 'not Allow once again');
  assert.equal(q.details!.refusal!.byHand, 'retried');
  assert.equal(q.details!.refusal!.retryOf, first.id);
  assert.ok(q.question.includes(`You allowed this Bash command once (question #${first.id})`), q.question);
  assert.match(q.question, /refused it again/);
  assert.match(q.question, /Run this yourself, in Bash, in the session's folder:\n\n```bash\nSet-Content \.claude\/settings\.local\.json "\{\}"\n```/);
  assert.ok(published.some((e) => e.type === 'question' && e.question.id === q.id), 'published, so the page and a push show it');
  assert.equal(await note('tu-2'), null, "no note says the grant was used for a call that didn't run");
  assert.ok(store.listMessages('s', { limit: 50 }).some((m) => m.kind === 'event' && /refused the Bash call again after Simon's Allow once/.test(String(m.data.text))));
  // Answered Done by hand, the session is told not to retry.
  store.answerQuestion(q.id, 'Done by hand', 'user');
  const told = buildDelivery('Simon', [store.getQuestion(q.id)!], [], () => '').userText;
  assert.match(told, /Simon made this change by hand/);
  assert.match(told, /Don't retry it/);
  assert.doesNotMatch(told, /Retry exactly this call/);
});
