// Away merges and the auto mode classifier (issue #133). On 2026-11-05 a manager's plain `gh pr merge <n> -R <repo>
// --merge`, with away mode allowing merge and every floor met, was refused by Claude Code's auto mode classifier
// ("[Merge Without Review]") and became a question to the person. Claude Code (2.1.316, read from its program) runs the
// classifier when Ledung's PreToolUse hook answers "ask", and skips it when the hook answers "allow" ("Hook approved
// tool use for …, bypassing permission prompt"); so the hook is where the away merge is decided. The GitHub answers have
// the shape of `gh pr view --json state,mergeable,statusCheckRollup`, as in away.test.ts; the refusal text is Claude
// Code's own, as in refusals.test.ts. Nothing here comes from running the new code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';
import { Away, formatLog, pinnedMerge } from '../src/sessions/away.ts';

const clock = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** Two hours ahead of the real clock, so the period never runs out during a test (#402). */
const later = () => clock(Date.now() + 2 * 3600_000);

const run = (name: string, status: string, conclusion = '') => ({ __typename: 'CheckRun', name, status, conclusion });
const GREEN = JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [run('check (windows)', 'COMPLETED', 'SUCCESS')] });
// The evidence's PR: open, mergeable and clean, no CI checks configured.
const NO_CHECKS = JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [] });
const FAILING = JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [run('ci', 'COMPLETED', 'FAILURE')] });

/** The head commit GitHub gives for every PR here: any 40 hex digits, as gh's headRefOid gives them. */
const HEAD = 'b4d1c0ffee5eed0123456789abcdef0123456789';
/**
 * GitHub's answer with the link and head the floors ask for since issues #143 and #144: those of the PR asked for, in
 * o/r, unless the answer gives its own.
 */
const pinned = (json: string, pr: number) => JSON.stringify({ url: `https://github.com/o/r/pull/${pr}`, headRefOid: HEAD, ...JSON.parse(json) });

/** The merge from the issue's evidence, with the repository made generic. */
const MERGE = 'gh pr merge 2264 -R o/r --merge';

const REFUSED = (reason: string) =>
  `Permission for this action was denied by the Claude Code auto mode classifier. Reason: ${reason}. If you have other tasks that don't depend on this action, continue working on those.`;

const MERGE_SENSITIVE = String.raw`\bgh\s+pr\s+merge\b`;

interface Options {
  /** GitHub's answer for the PR, by PR number and the folder it was read in (none: the project folder); default: GREEN. */
  gh?: (pr: number, readIn?: string) => string;
  /** The project folder; default ".". */
  cwd?: string;
  /** The sensitive command patterns; default: merges are sensitive. */
  sensitive?: string[];
  /** Extra sessions: id → project, all managers. */
  managers?: Record<string, string>;
  /** The project's dev ship command pattern; default: none. */
  devShip?: string;
}

function setup(opts: Options = {}) {
  const store = new Store(openDatabase(':memory:'));
  const management = new Management({
    store, userName: 'Martin', publish: () => {}, wake: () => {}, resume: async () => {},
    startSession: async () => { throw new Error('not used'); },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p', 'q'], decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {}, handoffProblem: () => null, shotPath: (_id, file) => file,
    projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
    ensureManager: async () => { throw new Error('not used'); },
  });
  const away = new Away(store, () => {});
  const viewed: unknown[][] = [];
  const make = (id: string, project: string, role: 'manager' | undefined, parentId: string | null) => {
    store.createSession({ id, project, runner: 'local', title: role ? `Manager: ${project}` : 'Worker', parentId, permissionMode: 'auto', ...(role ? { role } : {}) });
    const pushed: string[] = [];
    const session = new Session({
      info: store.getSession(id)!, store, publish: () => {}, userName: 'Martin', management, away, devShip: opts.devShip ?? null,
      runner: {
        cwd: opts.cwd ?? '.', currentBranch: async () => null,
        pullRequestView: async (...args: unknown[]) => {
          viewed.push(args);
          return { json: pinned((opts.gh ?? (() => GREEN))(args[0] as number, args[4] as string | undefined), args[0] as number) };
        },
      } as never,
      sensitive: { commandPatterns: opts.sensitive ?? [MERGE_SENSITIVE] },
      gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    });
    const s = session as unknown as { q: unknown; onMessage(m: unknown): void; input: { push(t: string): void } };
    s.q = {};
    s.input = { push: (t: string) => pushed.push(t) };
    store.updateSession(id, { status: 'idle' });
    const signal = { signal: new AbortController().signal };
    const pre = async () => (await session.claudeOptions({ onLine: () => {}, onStderr: () => {} })).hooks!.PreToolUse![0]!.hooks[0]!;
    return {
      session, pushed,
      /** Ledung's PreToolUse answer for a Bash call: allow, ask, or none (left to Claude Code). */
      hook: async (command: string, toolUseId: string, extra: Record<string, unknown> = {}) => {
        const out = await (await pre())({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'Merge' }, ...extra } as never, toolUseId, signal) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } };
        const updated = out.hookSpecificOutput?.updatedInput;
        // The input Claude Code runs instead of the one sent, when the hook gives one (issues #143, #144).
        return { decision: out.hookSpecificOutput?.permissionDecision ?? 'none', reason: out.hookSpecificOutput?.permissionDecisionReason ?? '', ...(updated ? { updatedInput: updated } : {}) };
      },
      /** The permission prompt path (canUseTool), which Claude Code reaches after the hook's "ask". */
      permission: (command: string, toolUseID: string) => (session as unknown as {
        onPermission(t: string, i: Record<string, unknown>, o: { signal: AbortSignal; toolUseID?: string }): Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>;
      }).onPermission('Bash', { command, description: 'Merge' }, { signal: new AbortController().signal, toolUseID }),
      /** The two stream lines a refused call gives: the model's tool_use, then Claude Code's error result for it. */
      /** parent: the subagent's Task call, when the refused call is one of the session's subagents'. */
      refuse: (toolUseId: string, command: string, reason = '[Merge Without Review]', parent: string | null = null) => {
        s.onMessage({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command, description: 'Merge' } }] } });
        s.onMessage({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: REFUSED(reason) }] } });
      },
      events: () => store.listMessages(id, { limit: 100 }).filter((m) => m.kind === 'event').map((m) => String(m.data.text)),
    };
  };
  const mgr = make('mgr', 'p', 'manager', null);
  const worker = make('s', 'p', undefined, 'mgr');
  const others = Object.fromEntries(Object.entries(opts.managers ?? {}).map(([id, project]) => [id, make(id, project, 'manager', null)]));
  const refusals = () => store.listQuestions(100).filter((q) => q.details?.refusal);
  const settle = <T>(p: Promise<T>) => Promise.race([p, new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 50))]);
  /** Lets the asynchronous floor check after a refusal finish. */
  const flush = () => new Promise((r) => setTimeout(r, 20));
  return { store, away, viewed, mgr, worker, others, refusals, settle, flush };
}

// ---------------------------------------------------------------- 1. decided in the hook, ahead of the classifier

test("while away allows merge, a manager's own plain merge with its floors met is allowed in the PreToolUse hook, so the classifier never judges it", async () => {
  const t = setup({ gh: () => NO_CHECKS });
  // Premise: before away mode, the hook asks (sensitive), which in auto mode sends the call to the classifier.
  assert.equal((await t.mgr.hook(MERGE, 'tu-0')).decision, 'ask', 'not away: asked, as before');
  assert.equal(t.viewed.length, 0, 'not away: GitHub is not asked');
  t.away.start(later(), ['merge', 'devShip', 'ordered', 'computerControl']);
  const out = await t.mgr.hook(MERGE, 'tu-1');
  assert.equal(out.decision, 'allow');
  assert.match(out.reason, /^Allowed by away mode: PR #2264 open, mergeable/);
  assert.deepEqual(t.viewed.map((v) => v.slice(0, 2)), [[2264, 'o/r']], 'the floors were read for that PR in that repository, once');
  const log = t.away.log('mgr').records;
  assert.deepEqual(log.map((r) => [r.kind, r.pr, r.allowed]), [['merge', 2264, true]], 'recorded once, for the morning report');
  assert.equal(t.store.pendingPermissions().length, 0, 'no prompt');
  assert.ok(t.mgr.events().some((e) => e.startsWith('Allowed by away mode: PR #2264')), 'noted in the chat');
  t.away.stop();
});

test('outside away mode, with merge not allowed, or for anything but one plain merge of its own, the hook does what it did before', async () => {
  const t = setup();
  t.away.start(later(), ['devShip', 'ordered', 'computerControl']);
  assert.equal((await t.mgr.hook(MERGE, 'a')).decision, 'ask', 'merge not allowed');
  t.away.start(later(), ['merge']);
  // Never wider: --admin, --auto, anything chained, piped or computed, two PRs, another command, a subagent's call.
  for (const [i, command] of [
    'gh pr merge 2264 -R o/r --merge --admin',
    'gh pr merge 2264 -R o/r --auto --merge',
    'gh pr merge 2264 -R o/r --merge && git push --force',
    'gh pr merge 2264 -R o/r --merge; rm -rf .',
    'gh pr merge 2264 -R o/r --merge | tee log',
    'gh pr merge $(echo 2264) -R o/r --merge',
    'gh pr merge 2264 2265 -R o/r',
    'git push --force origin main',
  ].entries()) {
    assert.notEqual((await t.mgr.hook(command, `n-${i}`)).decision, 'allow', command);
  }
  assert.notEqual((await t.mgr.hook(MERGE, 'sub', { agent_id: 'agent-1' })).decision, 'allow', "a subagent's call is not the manager's own");
  assert.notEqual((await t.worker.hook(MERGE, 'w')).decision, 'allow', 'an ordinary session');
  assert.equal(t.viewed.length, 0, 'GitHub was never asked for any of them');
  // The positive branch on the same session and period: the plain merge is allowed.
  assert.equal((await t.mgr.hook(MERGE, 'yes')).decision, 'allow');
  t.away.stop();
  // Back: asked again.
  t.away.start(later(), ['merge']);
  t.away.end();
  assert.equal((await t.mgr.hook(MERGE, 'back')).decision, 'ask');
  t.away.stop();
});

test("a dev ship, the other command away mode can allow, is not allowed in the merge hook: only a plain merge is", async () => {
  // Review of PR #141 (test review, finding 1): with the hook's own "one plain merge" check gone, a dev ship that away
  // mode allows went past the classifier with no prompt. Away dev ships are out of #133's scope (filed as #140).
  const SHIP = 'npm run publish:dev';
  const t = setup({ devShip: SHIP });
  t.away.start(later(), ['merge', 'devShip']);
  assert.notEqual((await t.mgr.hook(SHIP, 'ship')).decision, 'allow', 'the dev ship is not decided by the merge hook');
  // The positive branch, same session and period: the plain merge is allowed.
  assert.equal((await t.mgr.hook(MERGE, 'merge')).decision, 'allow');
  t.away.stop();
});

test('a merge whose floors fail is held as before: asked once, with the reason, GitHub asked and the decision recorded once', async () => {
  const t = setup({ gh: () => FAILING });
  t.away.start(later(), ['merge']);
  assert.equal((await t.mgr.hook(MERGE, 'tu-1')).decision, 'ask', 'the sensitive ask, as before');
  // Claude Code then reaches Ledung's prompt for it (the classifier allowed it, or let it through as an ask).
  assert.equal(await t.settle(t.mgr.permission(MERGE, 'tu-1')), 'waiting');
  const [p] = t.store.pendingPermissions();
  assert.equal(p!.addressedTo, 'user');
  assert.match(p!.reason ?? '', /Away mode held for Martin: failing checks: ci/);
  assert.equal(t.viewed.length, 1, 'GitHub asked once, not again at the prompt');
  assert.deepEqual(t.away.log('mgr').records.map((r) => r.allowed), [false], 'recorded once');
  t.away.stop();
});

test("a merge that isn't on the sensitive list: allowed when its floors are met, otherwise left to Claude Code and not recorded", async () => {
  const t = setup({ sensitive: [], gh: (pr) => (pr === 7 ? FAILING : GREEN) });
  t.away.start(later(), ['merge']);
  assert.deepEqual(await t.mgr.hook('gh pr merge 7 -R o/r --merge', 'a'), { decision: 'none', reason: '' }, 'floors fail: as before');
  assert.equal(t.away.log('mgr').records.length, 0, 'away mode held nothing it would have asked about');
  assert.equal((await t.mgr.hook('gh pr merge 8 -R o/r --merge', 'b')).decision, 'allow', 'floors met: allowed');
  assert.deepEqual(t.away.log('mgr').records.map((r) => [r.pr, r.allowed]), [[8, true]]);
  t.away.stop();
});

// ---------------------------------------------------------------- 2. refused anyway: logged, not asked

test('a merge the classifier refuses anyway, with merge allowed and the floors met, is no question: it goes in the away log and the morning report', async () => {
  const t = setup({ gh: (pr) => (pr === 2265 ? FAILING : NO_CHECKS) });
  t.away.start(later(), ['merge', 'devShip', 'ordered', 'computerControl']);
  t.mgr.refuse('tu-1', MERGE);
  await t.flush();
  assert.equal(t.refusals().length, 0, 'not asked of the person');
  const [r, ...more] = t.away.log('mgr').records;
  assert.equal(more.length, 0);
  assert.equal(r!.pr, 2264);
  // Issue #145 reworded it: "floors met when refused", not "though away mode allows it".
  assert.match(r!.reason, /^refused by Claude Code's auto mode classifier \(\[Merge Without Review\]\); floors met when refused: PR #2264 open, mergeable/);
  const report = formatLog(t.away.log('mgr'), t.away.current(), 'Martin');
  assert.match(report, /REFUSED BY THE CLASSIFIER · merge · PR #2264 \(o\/r\)/, 'the morning report names it');
  assert.ok(t.mgr.events().some((e) => e.startsWith("Away merge refused by Claude Code's auto mode classifier")), 'noted in the chat');
  // The same refusal line again (a replay): nothing new.
  t.mgr.refuse('tu-1', MERGE);
  await t.flush();
  assert.equal(t.away.log('mgr').records.length, 1);
  assert.equal(t.refusals().length, 0);
  // The positive branch, same session and period: a merge whose floors fail is asked as before.
  t.mgr.refuse('tu-2', 'gh pr merge 2265 -R o/r --merge');
  await t.flush();
  assert.deepEqual(t.refusals().map((q) => q.details!.refusal!.toolUseId), ['tu-2'], 'floors not met: the refusal alarm, as before');
  t.away.stop();
});

test('a refused merge is asked as before outside away mode, with merge not allowed, or from an ordinary session', async () => {
  const t = setup();
  t.mgr.refuse('a', MERGE);
  assert.equal(t.refusals().length, 1, 'not away: asked at once');
  t.away.start(later(), ['devShip']);
  t.mgr.refuse('b', 'gh pr merge 2 -R o/r --merge');
  assert.equal(t.refusals().length, 2, 'merge not allowed');
  t.away.start(later(), ['merge']);
  t.worker.refuse('c', 'gh pr merge 3 -R o/r --merge');
  assert.equal(t.refusals().length, 3, 'an ordinary session');
  t.mgr.refuse('d', 'gh pr merge 4 -R o/r --merge --admin');
  assert.equal(t.refusals().length, 4, 'not a plain merge');
  assert.equal(t.viewed.length, 0, 'GitHub never asked');
  t.away.stop();
});

test("a merge by one of the manager's subagents that the classifier refuses is asked as before, even with its floors met", async () => {
  // Review of PR #141 (code review, finding 1a): only the manager's own merge is away mode's here; a subagent's is
  // unchanged, in the refusal path as in the hook. Subagent messages carry the Task call's id as parent_tool_use_id.
  const t = setup({ gh: () => NO_CHECKS });
  t.away.start(later(), ['merge']);
  t.mgr.refuse('sub-1', MERGE, '[Merge Without Review]', 'task-1');
  await t.flush();
  assert.deepEqual(t.refusals().map((q) => q.details!.refusal!.toolUseId), ['sub-1'], "a subagent's refusal: the alarm, as before");
  assert.equal(t.away.log('mgr').records.length, 0, 'not in the away log');
  assert.equal(t.viewed.length, 0, 'GitHub not asked');
  // The positive branch, same session and period: the manager's own refused merge is logged, not asked.
  t.mgr.refuse('own-1', 'gh pr merge 2265 -R o/r --merge');
  await t.flush();
  assert.equal(t.refusals().length, 1, "the manager's own: not asked");
  assert.deepEqual(t.away.log('mgr').records.map((r) => r.pr), [2265]);
  t.away.stop();
});

// ---------------------------------------------------------------- 3. Allow once reaches only the refused session

test('an Allow once from the refusal alarm is delivered only to the session whose call was refused: another manager gets nothing', async () => {
  const t = setup({ managers: { other: 'q' } });
  const b = t.others.other!;
  t.mgr.refuse('tu-1', MERGE);
  const [q] = t.refusals();
  assert.equal(q!.sessionId, 'mgr');
  t.store.answerQuestion(q!.id, 'Allow once', 'user');
  // Both between turns, free to take a delivery.
  t.store.updateSession('mgr', { status: 'idle' });
  t.store.updateSession('other', { status: 'idle' });
  t.mgr.session.deliver();
  b.session.deliver();
  assert.equal(t.mgr.pushed.length, 1, 'the refused manager is told');
  assert.match(t.mgr.pushed[0]!, /Retry exactly this call now, one time, unchanged:\n\n```\ngh pr merge 2264 -R o\/r --merge\n```/);
  assert.deepEqual(b.pushed, [], 'the other manager gets nothing');
  // And only the refused manager's retry gets through.
  assert.notEqual((await b.hook(MERGE, 'x-1')).decision, 'allow', "not the other manager's");
  assert.equal((await t.mgr.hook(MERGE, 'x-2')).decision, 'allow', "the refused manager's, once");
  assert.notEqual((await t.mgr.hook(MERGE, 'x-3')).decision, 'allow', 'and not twice');
});

// ---------------------------------------------------------------- 4. the merge that runs is the PR read, at its head
// Issues #143 and #144 (post-merge security review of PR #141): the floors were read for PR n in the project folder's
// repository, while gh merged PR n wherever the shell stood (a nested clone after `cd vendor/lib`), and at whatever
// head the PR had by then. Now the PR is read where gh would resolve it, and what runs is
// `gh pr merge <its link> --match-head-commit <the head read>` with the options sent: a link names its repository and
// host, so neither the shell's folder nor GH_REPO can point gh at another PR, and gh refuses a moved head.

/** A folder link: a junction on Windows, which needs no privilege there and realpath resolves like a symlink. */
const LINK = process.platform === 'win32' ? 'junction' : 'dir';

/** A project folder with a nested clone in it, and a folder outside it. */
function folders() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-143-')));
  const project = path.join(root, 'project');
  const vendor = path.join(project, 'vendor', 'lib');
  const outside = path.join(root, 'elsewhere');
  for (const f of [vendor, outside]) fs.mkdirSync(f, { recursive: true });
  return { project, vendor, outside, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** GitHub as gh sees it from each folder: in the nested clone, its own repository v/lib; anywhere else, o/r. */
const byFolder = (vendor: string) => (pr: number, readIn?: string) =>
  JSON.stringify({ ...JSON.parse(NO_CHECKS), url: `https://github.com/${readIn === vendor ? 'v/lib' : 'o/r'}/pull/${pr}` });

test("#143: after cd into a nested clone, a bare merge is read in that clone and runs as that clone's PR, not the project's PR of the same number", async () => {
  const f = folders();
  const t = setup({ cwd: f.project, gh: byFolder(f.vendor) });
  t.away.start(later(), ['merge']);
  const out = await t.mgr.hook('gh pr merge 12 --squash', 'tu-v', { cwd: f.vendor });
  assert.equal(out.decision, 'allow');
  assert.deepEqual([t.viewed[0]![0], t.viewed[0]![1], t.viewed[0]![4]], [12, null, f.vendor], 'PR 12 read where the shell stands');
  assert.deepEqual(out.updatedInput, { command: `gh pr merge https://github.com/v/lib/pull/12 --match-head-commit ${HEAD} --squash`, description: 'Merge' });
  // The same merge with the shell in the project folder: the project's PR 12.
  const home = await t.mgr.hook('gh pr merge 12 --squash', 'tu-p', { cwd: f.project });
  assert.equal(home.updatedInput?.command, `gh pr merge https://github.com/o/r/pull/12 --match-head-commit ${HEAD} --squash`);
  t.away.stop();
  f.done();
});

test('#143: a bare merge with the shell outside the project folder is held and GitHub not asked; one that names its repository is read for it and runs as its link', async () => {
  const f = folders();
  const t = setup({ cwd: f.project, gh: byFolder(f.vendor) });
  t.away.start(later(), ['merge']);
  assert.equal((await t.mgr.hook('gh pr merge 12 --squash', 'out', { cwd: f.outside })).decision, 'ask', 'held: the sensitive ask, as before');
  assert.equal(t.viewed.length, 0, 'GitHub not asked');
  assert.match(t.away.log('mgr').records[0]!.reason, /names no repository and the shell is outside the project folder/);
  // The positive branch, same shell folder: with -R it is read for that repository, in the project folder.
  const named = await t.mgr.hook('gh pr merge 12 -R o/r --squash', 'named', { cwd: f.outside });
  assert.equal(named.decision, 'allow');
  assert.deepEqual([t.viewed[0]![0], t.viewed[0]![1], t.viewed[0]![4]], [12, 'o/r', undefined]);
  assert.equal(named.updatedInput?.command, `gh pr merge https://github.com/o/r/pull/12 --match-head-commit ${HEAD} -R o/r --squash`);
  t.away.stop();
  f.done();
});

test("#143: a merge GitHub answers for with another repository's link than the one it names is held: it fails closed", async () => {
  const t = setup({ gh: (pr) => (pr === 5 ? JSON.stringify({ ...JSON.parse(NO_CHECKS), url: 'https://github.com/x/y/pull/5' }) : NO_CHECKS) });
  t.away.start(later(), ['merge']);
  assert.equal((await t.mgr.hook('gh pr merge 5 -R o/r --merge', 'a')).decision, 'ask');
  assert.match(t.away.log('mgr').records[0]!.reason, /PR #5 was read in github\.com\/x\/y, not in o\/r/);
  // The positive branch: the link of the repository it names.
  assert.equal((await t.mgr.hook('gh pr merge 6 -R o/r --merge', 'b')).decision, 'allow');
  t.away.stop();
});

test("#143, #144: GitHub's answer without the PR's link or head commit holds the merge: it fails closed (PR #147 test review, Minor 1)", async () => {
  // pinned() fills in a link and head only where the answer gives none, so null here reaches the decision as missing.
  const t = setup({ gh: (pr) => JSON.stringify({ ...JSON.parse(NO_CHECKS), ...(pr === 7 ? { headRefOid: null } : pr === 8 ? { url: null } : {}) }) });
  t.away.start(later(), ['merge']);
  assert.equal((await t.mgr.hook('gh pr merge 7 -R o/r --merge', 'no-head')).decision, 'ask', 'no head: held');
  assert.match(t.away.log('mgr').records.at(-1)!.reason, /GitHub did not give PR #7's head commit/);
  assert.equal((await t.mgr.hook('gh pr merge 8 -R o/r --merge', 'no-url')).decision, 'ask', 'no link: held');
  assert.match(t.away.log('mgr').records.at(-1)!.reason, /GitHub did not give PR #8's link/);
  // The positive branch: an answer with both.
  const both = await t.mgr.hook('gh pr merge 9 -R o/r --merge', 'both');
  assert.equal(both.decision, 'allow');
  assert.equal(both.updatedInput?.command, `gh pr merge https://github.com/o/r/pull/9 --match-head-commit ${HEAD} -R o/r --merge`);
  t.away.stop();
});

// The shell folder is judged as it really is on disk (PR #147 test review, Minor 2): folders() gives real paths, so
// these two reach it through links, as /var and /private/var on macOS, or a link inside the project.
test('#143: a project folder reached through a link, the shell in its real path: inside, read there and allowed', async () => {
  const f = folders();
  const viaLink = path.join(path.dirname(f.project), 'project-link');
  fs.symlinkSync(f.project, viaLink, LINK);
  const t = setup({ cwd: viaLink, gh: byFolder(f.vendor) });
  t.away.start(later(), ['merge']);
  const real = await t.mgr.hook('gh pr merge 12 --squash', 'real', { cwd: f.vendor });
  assert.equal(real.decision, 'allow');
  assert.equal(real.updatedInput?.command, `gh pr merge https://github.com/v/lib/pull/12 --match-head-commit ${HEAD} --squash`);
  t.away.stop();
  f.done();
});

test('#143: a link inside the project folder that leads out of it is outside: held, GitHub not asked', async () => {
  const f = folders();
  const outLink = path.join(f.project, 'out');
  fs.symlinkSync(f.outside, outLink, LINK);
  const t = setup({ cwd: f.project, gh: byFolder(f.vendor) });
  t.away.start(later(), ['merge']);
  assert.equal((await t.mgr.hook('gh pr merge 12 --squash', 'out', { cwd: outLink })).decision, 'ask', 'a link out: held');
  assert.equal(t.viewed.length, 0, 'GitHub not asked');
  assert.match(t.away.log('mgr').records.at(-1)!.reason, /the shell is outside the project folder/);
  t.away.stop();
  f.done();
});

test('#144: an away merge runs only at the head its floors were read at; a sent --match-head-commit of another commit is held', async () => {
  const t = setup({ gh: () => NO_CHECKS });
  t.away.start(later(), ['merge']);
  const out = await t.mgr.hook(MERGE, 'pin');
  assert.equal(out.decision, 'allow');
  assert.equal(out.updatedInput?.command, `gh pr merge https://github.com/o/r/pull/2264 --match-head-commit ${HEAD} -R o/r --merge`);
  const OTHER = '1111111111111111111111111111111111111111';
  assert.equal((await t.mgr.hook(`${MERGE} --match-head-commit ${OTHER}`, 'other')).decision, 'ask', 'another head: held');
  assert.match(t.away.log('mgr').records.at(-1)!.reason, /its --match-head-commit 1{40} is not the head its floors were read at/);
  // The positive branch: the head read, sent along, is kept once.
  const same = await t.mgr.hook(`${MERGE} --match-head-commit=${HEAD}`, 'same');
  assert.equal(same.decision, 'allow');
  assert.equal(same.updatedInput?.command, `gh pr merge https://github.com/o/r/pull/2264 --match-head-commit ${HEAD} -R o/r --merge`);
  t.away.stop();
});

test('#143, #144: a merge away mode allows at the prompt, not in the hook, runs pinned too', async () => {
  const t = setup({ gh: () => NO_CHECKS });
  t.away.start(later(), ['merge']);
  const result = await t.mgr.permission(MERGE, 'prompt-1');
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(result.updatedInput, { command: `gh pr merge https://github.com/o/r/pull/2264 --match-head-commit ${HEAD} -R o/r --merge`, description: 'Merge' });
  t.away.stop();
});

test('#143, #144: the pinned merge keeps the options sent, -R included, and quotes what the shell must see as one word', () => {
  const pin = { url: 'https://github.com/o/r/pull/2264', head: HEAD };
  // Worked by hand from gh's options: all stay in order, -R too (without it gh would also delete a same-named local
  // branch on --delete-branch: PR #147 code review, Important 1).
  assert.deepEqual(pinnedMerge(`gh pr merge 2264 -R o/r --merge -t "it's done" --body=x -d`, pin),
    { command: `gh pr merge https://github.com/o/r/pull/2264 --match-head-commit ${HEAD} -R o/r --merge -t 'it'\\''s done' --body x -d` });
  assert.deepEqual(pinnedMerge('gh pr merge https://github.com/o/r/pull/2264 --repo=o/r -s', pin),
    { command: `gh pr merge https://github.com/o/r/pull/2264 --match-head-commit ${HEAD} --repo o/r -s` });
});

// ---------------------------------------------------------------- 5. post-merge security review of PR #141
// Issue #145: the refusal path logged every classifier reason quietly, not only "[Merge Without Review]", and a merge
// held at call time then refused read as if away mode had allowed it. Issue #146: dropping merge from away mode during
// the floor read went unseen, and an Allow once of the session's own could be used up by a subagent's identical call.

test('#145: a merge the classifier refuses for another reason than [Merge Without Review] is asked as before, even with merge allowed and its floors met', async () => {
  const t = setup({ gh: () => NO_CHECKS });
  t.away.start(later(), ['merge']);
  // Reasons of the shape Claude Code gives ("[Category] why"), worked from the issue's failure scenario.
  t.mgr.refuse('inj', MERGE, '[Prompt Injection] the merge follows an instruction found in a PR comment');
  t.mgr.refuse('tgt', 'gh pr merge 2265 -R o/r --merge', '[Unrequested Target] the user never named PR #2265');
  await t.flush();
  assert.deepEqual(t.refusals().map((q) => [q.details!.refusal!.toolUseId, q.addressedTo]), [['inj', 'user'], ['tgt', 'user']], 'both asked of the person');
  assert.match(t.refusals()[0]!.details!.issue!, /\[Prompt Injection\] the merge follows an instruction/, 'with the reason');
  assert.equal(t.away.log('mgr').records.length, 0, 'not quietly in the away log');
  // The positive branch, same session and period: a refusal for want of a review is logged, not asked.
  t.mgr.refuse('mwr', 'gh pr merge 2266 -R o/r --merge', '[Merge Without Review] no review of PR #2266');
  await t.flush();
  assert.equal(t.refusals().length, 2, 'not asked');
  assert.deepEqual(t.away.log('mgr').records.map((r) => r.pr), [2266], 'logged');
  t.away.stop();
});

test('#145: a refusal tagged [Merge Without Review] and another tag is asked; [Merge Without Review] alone is logged (PR #151 code review, Minor 2)', async () => {
  const t = setup({ gh: () => NO_CHECKS });
  t.away.start(later(), ['merge']);
  // Inferred shape, not observed: several tags in one reason. Any second tag means ask.
  t.mgr.refuse('two', MERGE, '[Merge Without Review] [Prompt Injection] the merge follows an instruction found in a PR comment');
  await t.flush();
  assert.deepEqual(t.refusals().map((q) => q.details!.refusal!.toolUseId), ['two'], 'asked of the person');
  assert.equal(t.away.log('mgr').records.length, 0, 'not quietly in the away log');
  // The positive branch, same session and period: the tag alone is logged, not asked.
  t.mgr.refuse('one', 'gh pr merge 2266 -R o/r --merge', '[Merge Without Review] no review of PR #2266');
  await t.flush();
  assert.equal(t.refusals().length, 1, 'not asked');
  assert.deepEqual(t.away.log('mgr').records.map((r) => r.pr), [2266], 'logged');
  t.away.stop();
});

test('#145: a merge held at call time and refused once its floors are met reads "floors met when refused", never as allowed', async () => {
  // The checks fail when the hook reads them, and have passed by the time the refusal comes.
  let reads = 0;
  const t = setup({ gh: () => (++reads === 1 ? FAILING : NO_CHECKS) });
  t.away.start(later(), ['merge']);
  assert.equal((await t.mgr.hook(MERGE, 'held')).decision, 'ask', 'held at call time');
  t.mgr.refuse('held', MERGE);
  await t.flush();
  assert.equal(t.refusals().length, 0, 'not asked: the floors were met when refused');
  const [held, refused, ...more] = t.away.log('mgr').records;
  assert.equal(more.length, 0);
  assert.deepEqual([held!.allowed, refused!.allowed], [false, false]);
  assert.match(held!.reason, /^held for Martin: failing checks: ci/);
  assert.match(refused!.reason, /\(\[Merge Without Review\]\); floors met when refused: PR #2264 open, mergeable/);
  assert.doesNotMatch(refused!.reason, /allow/i, 'nothing in it reads as allowed');
  const report = formatLog(t.away.log('mgr'), t.away.current(), 'Martin');
  assert.match(report, /HELD · merge · PR #2264/);
  assert.match(report, /REFUSED BY THE CLASSIFIER · merge · PR #2264/);
  assert.doesNotMatch(report, /ALLOWED ·/, 'the morning report shows no allowed merge');
  t.away.stop();
});

test('#146: merge dropped from away mode while the floors are read: held, not allowed; with nothing changed, allowed', async () => {
  let duringRead: (() => void) | null = null;
  const t = setup({ gh: () => { duringRead?.(); duringRead = null; return NO_CHECKS; } });
  t.away.start(later(), ['merge', 'devShip']);
  // The person changes away mode, keeping it on but without merge, while GitHub is asked.
  duringRead = () => t.away.start(later(), ['devShip']);
  const out = await t.mgr.hook(MERGE, 'dropped');
  assert.equal(out.decision, 'ask', 'not allowed: the sensitive ask, as before');
  assert.ok(t.away.current(), 'away mode is still on');
  assert.equal(t.viewed.length, 1, 'the floors were read');
  assert.match(t.away.log('mgr').records.at(-1)!.reason, /^held for Martin: away mode stopped allowing merge while its floors were checked/);
  // At the prompt the same.
  t.away.start(later(), ['merge', 'devShip']);
  duringRead = () => t.away.start(later(), ['devShip']);
  assert.equal(await t.settle(t.mgr.permission(MERGE, 'dropped-prompt')), 'waiting', 'asked at the prompt, not allowed');
  // The positive branch: merge still allowed after the read.
  t.away.start(later(), ['merge', 'devShip']);
  assert.equal((await t.mgr.hook(MERGE, 'kept')).decision, 'allow');
  t.away.stop();
});

test("#146: the manager's own Allow once is not used up by a subagent's identical call, and a subagent's is not the manager's", async () => {
  const t = setup();
  t.mgr.refuse('own', MERGE);
  const [own] = t.refusals();
  assert.equal(own!.details!.refusal!.byAgent, undefined, "the manager's own call");
  t.store.answerQuestion(own!.id, 'Allow once', 'user');
  assert.notEqual((await t.mgr.hook(MERGE, 'sub-try', { agent_id: 'agent-1' })).decision, 'allow', "a subagent's identical call: not allowed");
  assert.equal((await t.mgr.hook(MERGE, 'own-retry')).decision, 'allow', "the manager's retry still is: the grant was not used up");
  assert.notEqual((await t.mgr.hook(MERGE, 'own-again')).decision, 'allow', 'once');
  // A subagent's refusal of the same call is its own question, and its Allow once covers only a subagent's retry.
  t.mgr.refuse('sub', MERGE, '[Merge Without Review]', 'task-1');
  const sub = t.refusals().find((q) => q.details!.refusal!.toolUseId === 'sub');
  assert.ok(sub, "the subagent's refusal is asked");
  assert.equal(sub!.details!.refusal!.byAgent, true);
  t.store.answerQuestion(sub!.id, 'Allow once', 'user');
  assert.notEqual((await t.mgr.hook(MERGE, 'mgr-try')).decision, 'allow', "not the manager's own call");
  assert.equal((await t.mgr.hook(MERGE, 'sub-retry', { agent_id: 'agent-1' })).decision, 'allow', "the subagent's retry");
});

test("#146: a subagent's refusal of a call the manager's open question already asks about is asked on its own", async () => {
  const t = setup();
  t.mgr.refuse('own', MERGE);
  t.mgr.refuse('own-2', MERGE);
  assert.equal(t.refusals().length, 1, "the manager's repeat is only noted, as before");
  t.mgr.refuse('sub', MERGE, '[Merge Without Review]', 'task-1');
  assert.deepEqual(t.refusals().map((q) => [q.details!.refusal!.toolUseId, q.details!.refusal!.byAgent ?? false]), [['own', false], ['sub', true]]);
});
