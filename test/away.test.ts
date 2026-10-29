// Away mode (issue #35; decision of 2026-10-13). The GitHub answers below have the shape of
// `gh pr view --json state,mergeable,statusCheckRollup`: CheckRun items carry status and conclusion,
// StatusContext items a state (GitHub's GraphQL schema). Nothing here comes from running the new code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { parseConfig } from '../src/config.ts';
import { Away, awayLine, backText, classify, decide, shipCore, SHIP_FORM, droppedText, floorsOf, formatLog, periodText, promptAwayLine, ranOutText, untilFromHHMM, words, type ViewPr } from '../src/sessions/away.ts';
import type { AwayInfo, ServerEvent } from '../src/shared/protocol.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const at = (h: number, m = 0) => new Date(2026, 9, 13, h, m).getTime();
const clock = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** An end time two hours ahead of the real clock: a test that runs on the real clock never reaches it, however close to midnight it runs (#402). */
const later = () => clock(Date.now() + 2 * 3600_000);
const AWAY: AwayInfo = { since: at(1), until: at(8), allow: ['merge', 'devShip'] };

const run = (name: string, status: string, conclusion = '') => ({ __typename: 'CheckRun', name, status, conclusion });
const pr = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [run('check (windows)', 'COMPLETED', 'SUCCESS'), run('check (macos)', 'COMPLETED', 'SUCCESS')], ...over });

// ---------------------------------------------------------------- the time and the line

test('until is the next HH:MM: later today, or tomorrow when it has passed', () => {
  assert.equal(untilFromHHMM('08:00', at(1)), at(8));
  assert.equal(untilFromHHMM('00:30', at(1)), new Date(2026, 9, 14, 0, 30).getTime());
  assert.equal(untilFromHHMM('01:00', at(1)), new Date(2026, 9, 14, 1, 0).getTime(), 'now itself is already past');
  for (const bad of ['8', '24:00', '07:60', 'soon', '']) assert.throws(() => untilFromHHMM(bad, at(1)), /HH:MM/);
});

test('the prompt line is the one Martin gave, and only a manager gets it', () => {
  assert.equal(awayLine(AWAY, 'Martin'), 'Martin is away until 08:00; allowed: merge, dev ship.');
  assert.equal(awayLine({ ...AWAY, allow: ['merge'] }, 'Martin'), 'Martin is away until 08:00; allowed: merge.');
  assert.equal(awayLine({ ...AWAY, allow: [] }, 'Martin'), 'Martin is away until 08:00; allowed: nothing.');
  assert.equal(promptAwayLine({ role: 'manager' }, AWAY, 'Martin'), 'Martin is away until 08:00; allowed: merge, dev ship.');
  assert.equal(promptAwayLine({ role: 'session' }, AWAY, 'Martin'), '');
  assert.equal(promptAwayLine({ role: 'manager' }, null, 'Martin'), '', 'not away: no line');
});

// ---------------------------------------------------------------- which command

test('a plain gh pr merge is a merge, with its PR and repository', () => {
  assert.deepEqual(classify('gh pr merge 31 -R Owner/Repo --squash'), { kind: 'merge', pr: 31, repo: 'Owner/Repo' });
  assert.deepEqual(classify('gh pr merge 31 --repo=Owner/Repo --merge --delete-branch'), { kind: 'merge', pr: 31, repo: 'Owner/Repo' });
  assert.deepEqual(classify('gh pr merge 7'), { kind: 'merge', pr: 7, repo: null });
  assert.deepEqual(classify('gh pr merge https://github.com/Owner/Repo/pull/9 --rebase'), { kind: 'merge', pr: 9, repo: 'Owner/Repo' });
  assert.deepEqual(classify('gh pr merge 31 -R o/r --subject "Away mode (#35)" --body \'one; two\''), { kind: 'merge', pr: 31, repo: 'o/r' });
});

test('anything that is not exactly one plain merge is not judged, so it is held', () => {
  const held = [
    'gh pr merge 31 && git push origin main',
    'gh pr merge 31; gh pr merge 32',
    'for p in 31 32; do gh pr merge $p -R o/r; done',
    'gh pr merge $(gh pr list -q .[0].number)',
    'gh pr merge 31 | tee log',
    'gh pr merge 31 --admin',
    'gh pr merge 31 --auto',
    'gh pr merge 31 32',
    'gh pr merge',
    'gh pr merge 31 -R "$R"',
    'gh pr merge 31 -R evil',
    'gh pr merge https://github.com/a/b/pull/3 -R c/d',
    'GH_REPO=x/y gh pr merge 31',
    'gh pr merge 31 --body "unclosed',
    'gh api repos/o/r/pulls/31/merge -X PUT',
  ];
  for (const c of held) assert.equal(classify(c).kind, 'other', c);
});

test("the project's dev ship command is dev ship only as one plain command", () => {
  const pattern = String.raw`^npm run ship:dev$`;
  assert.deepEqual(classify('npm run ship:dev', pattern), { kind: 'devShip' });
  assert.equal(classify('npm run ship:dev; rm -rf build', pattern).kind, 'other');
  assert.equal(classify('npm run ship:dev', null).kind, 'other', 'no dev ship command: nothing is dev ship');
  assert.equal(classify('npm run ship', pattern).kind, 'other');
});

test("the dev ship command must match the whole command, even when the setting isn't anchored (review 1, PR #42)", () => {
  assert.deepEqual(classify('npm run ship:dev', 'npm run ship:dev'), { kind: 'devShip' });
  assert.deepEqual(classify('NPM run ship:dev', 'npm run ship:dev'), { kind: 'devShip' }, 'case does not matter, as for the sensitive list');
  assert.equal(classify('git push --force origin main ship-dev', 'ship-dev').kind, 'other');
  assert.equal(classify('git push --force origin HEAD:main npm run ship:dev', 'npm run ship:dev').kind, 'other');
  assert.equal(classify('gh release create v9 --notes "npm run ship:dev"', 'npm run ship:dev').kind, 'other');
});

test('words: quotes keep text together; shell operators outside quotes refuse', () => {
  assert.deepEqual(words('gh pr merge 1 -t "a b"'), ['gh', 'pr', 'merge', '1', '-t', 'a b']);
  assert.ok(!Array.isArray(words('a && b')));
  assert.ok(!Array.isArray(words('echo "$HOME"')));
});

// ---------------------------------------------------------------- the floors

test('floors: open, mergeable, all checks green passes every floor', () => {
  const f = floorsOf(31, pr());
  assert.ok(f.every((x) => x.ok), JSON.stringify(f));
  assert.equal(f.at(-1)!.detail, '2 checks green');
});

test('floors: each one fails on its own', () => {
  const fails = (json: string) => floorsOf(31, json).filter((x) => !x.ok).map((x) => x.floor);
  assert.deepEqual(fails(pr({ state: 'MERGED' })), ['open']);
  assert.deepEqual(fails(pr({ state: 'CLOSED' })), ['open']);
  assert.deepEqual(fails(pr({ mergeable: 'CONFLICTING' })), ['mergeable']);
  assert.deepEqual(fails(pr({ mergeable: 'UNKNOWN' })), ['mergeable'], 'not yet computed counts as held');
  assert.deepEqual(fails(pr({ statusCheckRollup: [run('ci', 'COMPLETED', 'FAILURE')] })), ['no failing checks']);
  assert.deepEqual(fails(pr({ statusCheckRollup: [run('ci', 'COMPLETED', 'CANCELLED')] })), ['no failing checks']);
  assert.deepEqual(fails(pr({ statusCheckRollup: [run('ci', 'IN_PROGRESS')] })), ['no checks running']);
  assert.deepEqual(fails(pr({ statusCheckRollup: [run('ci', 'QUEUED')] })), ['no checks running']);
  assert.deepEqual(fails(pr({ statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING' }] })), ['no checks running']);
  assert.deepEqual(fails(pr({ statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' }] })), ['no failing checks']);
  assert.deepEqual(fails('not json'), ['readable']);
});

test('floors: skipped and neutral checks are green; no checks at all passes and says so', () => {
  assert.ok(floorsOf(1, pr({ statusCheckRollup: [run('a', 'COMPLETED', 'SKIPPED'), run('b', 'COMPLETED', 'NEUTRAL')] })).every((x) => x.ok));
  const none = floorsOf(1, pr({ statusCheckRollup: [] }));
  assert.ok(none.every((x) => x.ok));
  assert.equal(none.at(-1)!.detail, 'no checks at all');
});

// ---------------------------------------------------------------- the decision

const view = (json: string): ViewPr & { calls: unknown[][] } => {
  const calls: unknown[][] = [];
  const f = (async (n: number, repo: string | null, fields: string) => {
    calls.push([n, repo, fields]);
    return { json };
  }) as ViewPr & { calls: unknown[][] };
  f.calls = calls;
  return f;
};

test('decide: a merge whose floors pass is allowed, and GitHub is asked about that PR in that repo', async () => {
  const v = view(pr());
  const d = await decide(AWAY, 'Martin', 'gh pr merge 31 -R o/r --squash', null, v);
  assert.equal(d.allowed, true);
  assert.equal(d.pr, 31);
  assert.equal(d.repo, 'o/r');
  assert.deepEqual(v.calls, [[31, 'o/r', 'state,mergeable,statusCheckRollup']]);
  assert.match(d.reason, /^Allowed by away mode: PR #31 open, mergeable, no failing checks, 2 checks green$/);
});

test('decide: a floor that fails holds the merge for Martin, with the reason', async () => {
  const d = await decide(AWAY, 'Martin', 'gh pr merge 31', null, view(pr({ statusCheckRollup: [run('ci', 'IN_PROGRESS')] })));
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'held for Martin: checks still running: ci');
});

test('decide: a PR GitHub does not answer for is held', async () => {
  const d = await decide(AWAY, 'Martin', 'gh pr merge 31', null, async () => ({ error: 'gh did not answer within 20 s' }));
  assert.equal(d.allowed, false);
  assert.match(d.reason, /PR #31 could not be read \(gh did not answer within 20 s\)/);
});

test('decide: a kind Martin did not allow is held without asking GitHub', async () => {
  const v = view(pr());
  const d = await decide({ ...AWAY, allow: ['devShip'] }, 'Martin', 'gh pr merge 31', null, v);
  assert.equal(d.allowed, false);
  assert.match(d.reason, /did not allow merge/);
  assert.equal(v.calls.length, 0);
});

test('decide: force-push, push to main and other sensitive commands are held', async () => {
  for (const c of ['git push --force origin x', 'git push origin main', 'npm publish', 'gh release create v1']) {
    const d = await decide(AWAY, 'Martin', c, '^npm run ship:dev$', view(pr()));
    assert.equal(d.allowed, false, c);
    assert.equal(d.kind, 'other', c);
  }
});

test('decide: the dev ship command goes through when dev ship is allowed, and only then', async () => {
  assert.equal((await decide(AWAY, 'Martin', 'npm run ship:dev', '^npm run ship:dev$', view(pr()))).allowed, true);
  assert.equal((await decide({ ...AWAY, allow: ['merge'] }, 'Martin', 'npm run ship:dev', '^npm run ship:dev$', view(pr()))).allowed, false);
});

// ---------------------------------------------------------------- the state and the record

test('away state: kept in the database, ends with Back or by itself at the time', () => {
  const store = new Store(openDatabase(':memory:'));
  const events: ServerEvent[] = [];
  const away = new Away(store, (e) => events.push(e));
  const now = Date.now();
  assert.equal(away.current(now), null);
  const a = away.start('08:00', ['merge'], now);
  assert.deepEqual(away.current(now), a);
  assert.deepEqual(events.at(-1), { type: 'away', away: a });
  // A restarted Ledung reads the same state from the database.
  const again = new Away(store, () => {});
  assert.deepEqual(again.current(now), a);
  assert.equal(again.current(a.until), null, 'it ends by itself at the time');
  away.end(now + 1);
  assert.equal(away.current(now + 2), null, 'Back ends it');
  assert.deepEqual(events.at(-1), { type: 'away', away: null });
  away.stop();
  again.stop();
});

test('away_log: what was allowed and held, per manager, since the period began', async () => {
  const store = new Store(openDatabase(':memory:'));
  const away = new Away(store, () => {});
  const a = away.start('08:00', ['merge', 'devShip']);
  away.record('mgr', 'gh pr merge 31', await decide(a, 'Martin', 'gh pr merge 31', null, view(pr())));
  away.record('mgr', 'gh pr merge 32', await decide(a, 'Martin', 'gh pr merge 32', null, view(pr({ mergeable: 'CONFLICTING' }))));
  away.record('other-mgr', 'gh pr merge 33', await decide(a, 'Martin', 'gh pr merge 33', null, view(pr())));
  const log = away.log('mgr');
  assert.equal(log.since, a.since);
  assert.deepEqual(log.records.map((r) => [r.pr, r.allowed]), [[31, true], [32, false]]);
  assert.equal(log.records[1]!.reason, 'held for Martin: PR #32 has merge conflicts');
  assert.equal(log.records[0]!.floors.length, 4);
  away.stop();
});

// ---------------------------------------------------------------- the permission path

/** devShip: the project's dev ship command; onView: runs while GitHub is being asked (to press Back then). */
/** sensitive: patterns added to the list; managerProject: the manager's own project (default p); orphan: a session with no manager. */
function sessionSetup(role: 'manager' | 'session', ghJson: string | { error: string }, opts: { devShip?: string; onView?: (away: Away) => void; sensitive?: string[]; managerProject?: string; orphan?: boolean } = {}) {
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
  store.createSession({ id: 'mgr', project: opts.managerProject ?? 'p', runner: 'local', title: 'Manager: p', parentId: null, permissionMode: 'default', role: 'manager' });
  if (role === 'session') store.createSession({ id: 's', project: 'p', runner: 'local', title: 'Worker', parentId: opts.orphan ? null : 'mgr', permissionMode: 'default' });
  const id = role === 'manager' ? 'mgr' : 's';
  const away = new Away(store, () => {});
  const viewed: unknown[][] = [];
  const session = new Session({
    info: store.getSession(id)!, store, publish: () => {}, userName: 'Martin', management, away, devShip: opts.devShip ?? null,
    runner: {
      cwd: '.', currentBranch: async () => null,
      pullRequestView: async (...args: unknown[]) => {
        viewed.push(args);
        opts.onView?.(away);
        return typeof ghJson === 'string' ? { json: ghJson } : ghJson;
      },
    } as never,
    sensitive: { commandPatterns: [String.raw`\bgh\s+pr\s+merge\b`, String.raw`\bgit\s+push\b.*--force`, ...(opts.sensitive ?? [])] },
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
  });
  const ask = (command: string, toolUseID = 'tu1', requestId?: string) => (session as unknown as {
    onPermission(t: string, i: Record<string, unknown>, o: { signal: AbortSignal; toolUseID?: string; requestId?: string }): Promise<{ behavior: string }>;
  }).onPermission('Bash', { command }, { signal: new AbortController().signal, toolUseID, requestId });
  const settle = (p: Promise<unknown>) => Promise.race([p.then((r) => r), new Promise((r) => setTimeout(() => r('waiting'), 50))]);
  return { store, away, session, ask, settle, viewed, id };
}

test("while away, a manager's merge with every floor passing runs with no prompt, noted and recorded", async () => {
  const t = sessionSetup('manager', pr());
  t.away.start(later(), ['merge', 'devShip']);
  const result = await t.settle(t.ask('gh pr merge 31 -R o/r'));
  assert.deepEqual(result, { behavior: 'allow', updatedInput: { command: 'gh pr merge 31 -R o/r' } });
  assert.equal(t.store.pendingPermissions().length, 0, 'no prompt');
  assert.equal(t.viewed.length, 1);
  const log = t.away.log('mgr').records;
  assert.equal(log.length, 1);
  assert.equal(log[0]!.allowed, true);
  const note = (t.session as unknown as { allowedBy: { take(id: string): string | undefined } }).allowedBy.take('tu1');
  assert.match(note ?? '', /^Allowed by away mode: PR #31 open, mergeable/);
  t.away.stop();
});

test('while away, a merge that fails a floor is the same prompt to Martin as always, with the reason', async () => {
  const t = sessionSetup('manager', pr({ statusCheckRollup: [run('ci', 'COMPLETED', 'FAILURE')] }));
  t.away.start(later(), ['merge']);
  assert.equal(await t.settle(t.ask('gh pr merge 31')), 'waiting');
  const [p] = t.store.pendingPermissions();
  assert.equal(p!.addressedTo, 'user');
  assert.ok(p!.sensitive);
  assert.match(p!.reason ?? '', /Away mode held for Martin: failing checks: ci/);
  assert.equal(t.away.log('mgr').records[0]!.allowed, false);
  t.away.stop();
});

test("while away, an ordinary session's merge is held for Martin as now, and GitHub is not even asked", async () => {
  const t = sessionSetup('session', pr());
  t.away.start(later(), ['merge', 'devShip']);
  assert.equal(await t.settle(t.ask('gh pr merge 31')), 'waiting');
  // Held for Martin: since issue #51 it reaches him through the session's manager, which can't allow it.
  assert.equal(t.store.pendingPermissions()[0]!.addressedTo, 'mgr');
  assert.ok(t.store.pendingPermissions()[0]!.sensitive);
  assert.equal(t.viewed.length, 0);
  assert.equal(t.away.log('s').records.length, 0);
  t.away.stop();
});

test('while away, a manager\'s force-push stays held for Martin', async () => {
  const t = sessionSetup('manager', pr());
  t.away.start(later(), ['merge', 'devShip']);
  assert.equal(await t.settle(t.ask('git push --force origin am/x')), 'waiting');
  assert.equal(t.store.pendingPermissions()[0]!.addressedTo, 'user');
  assert.match(t.away.log('mgr').records[0]!.reason, /^held for Martin/);
  t.away.stop();
});

test("while away, a force-push that contains the dev ship command stays held for Martin (review 1, PR #42)", async () => {
  const t = sessionSetup('manager', pr(), { devShip: 'ship-dev' });
  t.away.start(later(), ['merge', 'devShip']);
  assert.equal(await t.settle(t.ask('git push --force origin main ship-dev')), 'waiting');
  assert.equal(t.store.pendingPermissions()[0]!.addressedTo, 'user');
  assert.match(t.away.log('mgr').records[0]!.reason, /^held for Martin/);
  t.away.stop();
});

test("while away, a request re-sent after a restart stays the prompt already on screen, untouched by away mode", async () => {
  const t = sessionSetup('manager', pr());
  assert.equal(await t.settle(t.ask('gh pr merge 31', 'tu1', 'req-1')), 'waiting');
  t.away.start(later(), ['merge', 'devShip']);
  assert.equal(await t.settle(t.ask('gh pr merge 31', 'tu1', 'req-1')), 'waiting');
  assert.equal(t.viewed.length, 0, 'GitHub is not asked');
  assert.equal(t.away.log('mgr').records.length, 0, 'no away decision');
  assert.equal(t.store.pendingPermissions().length, 1, 'still the one prompt');
  t.away.stop();
});

test("Back pressed while GitHub is being asked: the merge is held for Martin, not run", async () => {
  const t = sessionSetup('manager', pr(), { onView: (away) => away.end() });
  t.away.start(later(), ['merge', 'devShip']);
  assert.equal(await t.settle(t.ask('gh pr merge 31')), 'waiting');
  assert.equal(t.viewed.length, 1, 'GitHub was asked while away');
  const prompts = t.store.pendingPermissions();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.addressedTo, 'user');
  assert.match(t.away.log('mgr').records[0]!.reason, /came back$/);
  t.away.stop();
});

test("not away (never set, or after Back), a manager's merge prompts Martin as before", async () => {
  const t = sessionSetup('manager', pr());
  assert.equal(await t.settle(t.ask('gh pr merge 31', 'a')), 'waiting');
  t.away.start(later(), ['merge']);
  t.away.end();
  assert.equal(await t.settle(t.ask('gh pr merge 32', 'b')), 'waiting');
  assert.equal(t.store.pendingPermissions().length, 2);
  assert.equal(t.viewed.length, 0);
  t.away.stop();
});

// ---------------------------------------------------------------- computer control (issue #328)
// The wording is the one Martin accepted with question #813 (2026-10-27): "Martin is away until 17:00;
// allowed: merge, dev ship, computer control." and the back, ran-out and dropped messages.

const CC: AwayInfo = { since: at(7, 20), until: at(17), allow: ['merge', 'devShip', 'computerControl'] };

test('computer control: the prompt line names it, after merge and dev ship', () => {
  assert.equal(awayLine(CC, 'Martin'), 'Martin is away until 17:00; allowed: merge, dev ship, computer control.');
  assert.equal(awayLine({ ...CC, allow: ['computerControl'] }, 'Martin'), 'Martin is away until 17:00; allowed: computer control.');
});

test('computer control gates nothing: it lets no merge or dev ship through', async () => {
  const only: AwayInfo = { ...CC, allow: ['computerControl'] };
  const merge = await decide(only, 'Martin', 'gh pr merge 31', 'npm run ship:dev', view(pr()));
  assert.equal(merge.allowed, false);
  assert.equal(merge.reason, 'held for Martin: Martin is away and did not allow merge');
  const other = await decide(only, 'Martin', 'git push --force', 'npm run ship:dev', view(pr()));
  assert.equal(other.reason, 'held for Martin: Martin is away and only nothing can run without them', 'computer control is not a kind a call can be');
  assert.equal((await decide(CC, 'Martin', 'git push --force', null, view(pr()))).reason, 'held for Martin: Martin is away and only merge, dev ship can run without them');
});

test('the messages: Back with and without computer control, the time running out, and a change that drops it', () => {
  assert.equal(backText(CC, 'Martin', at(14, 5)),
    'Ledung: Martin is back (pressed Back at 14:05): computer control ended. Stop driving this computer now (mouse, keyboard, programs you started) and tell your sessions that do; merge and dev ship wait for Martin again.');
  assert.equal(backText({ ...CC, allow: ['merge', 'devShip'] }, 'Martin', at(14, 5)),
    'Ledung: Martin is back (pressed Back at 14:05): away mode ended; merge and dev ship wait for Martin again.');
  assert.equal(backText({ ...CC, allow: ['merge'] }, 'Martin', at(14, 5)), 'Ledung: Martin is back (pressed Back at 14:05): away mode ended; merge waits for Martin again.');
  assert.equal(backText({ ...CC, allow: [] }, 'Martin', at(14, 5)), 'Ledung: Martin is back (pressed Back at 14:05): away mode ended.');
  assert.equal(ranOutText(CC, 'Martin'),
    "Ledung: Martin's away time ended at 17:00: computer control ended. Stop driving this computer now (mouse, keyboard, programs you started) and tell your sessions that do; merge and dev ship wait for Martin again.");
  assert.equal(droppedText({ ...CC, allow: ['merge'] }, 'Martin', at(12)),
    'Ledung: Martin changed away mode at 12:00: computer control ended. Stop driving this computer now (mouse, keyboard, programs you started) and tell your sessions that do; Martin is still away until 17:00; allowed: merge.');
});

/** An Away whose notes to the managers are collected. */
function noted(store = new Store(openDatabase(':memory:'))) {
  const notes: string[] = [];
  return { store, notes, away: new Away(store, () => {}, { userName: 'Martin', notify: (t) => notes.push(t) }) };
}

test('Back tells every manager once, with computer control or without; Back when not away tells nobody', () => {
  const t = noted();
  t.away.end();
  assert.deepEqual(t.notes, [], 'not away: nothing to tell');
  const now = at(12);
  t.away.start('23:59', ['merge', 'computerControl'], now);
  assert.deepEqual(t.notes, [], 'going away is seen at the next turn, nobody is woken');
  t.away.end(now + 1);
  t.away.end(now + 2);
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0]!, /^Ledung: Martin is back \(pressed Back at \d\d:\d\d\): computer control ended\. .*; merge waits for Martin again\.$/);
  t.away.start('23:59', ['devShip'], now + 3);
  t.away.end(now + 4);
  assert.match(t.notes[1]!, /: away mode ended; dev ship waits for Martin again\.$/);
  t.away.stop();
});

/** HH:MM an hour ago, and a "now" two hours ago: away from then until then has already run out. */
const ranOut = () => {
  return { hhmm: clock(Date.now() - 3600_000), now: Date.now() - 7200_000 };
};
const tick = () => new Promise((r) => setTimeout(r, 150));

test('the time running out tells every manager once with computer control, also after a restart; without it, nobody', async () => {
  const t = noted();
  const { hhmm, now } = ranOut();
  t.away.start(hhmm, ['merge', 'computerControl'], now);
  await tick();
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0]!, new RegExp(`^Ledung: Martin's away time ended at ${hhmm}: computer control ended\\. `));
  const restarted = noted(t.store);
  restarted.away.begin();
  await tick();
  assert.deepEqual(restarted.notes, [], 'told once, not again after a restart');
  t.away.stop();
  restarted.away.stop();

  // Ledung was not running at the time: a restart tells them then.
  const down = new Store(openDatabase(':memory:'));
  const before = new Away(down, () => {});
  before.start(ranOut().hhmm, ['computerControl'], ranOut().now);
  before.stop();
  const later = noted(down);
  await tick();
  assert.deepEqual(later.notes, [], 'nothing before begin: the sessions are not attached yet (review 1 of #328)');
  later.away.begin();
  await tick();
  assert.equal(later.notes.length, 1);
  later.away.stop();

  const plain = noted();
  plain.away.start(ranOut().hhmm, ['merge', 'devShip'], ranOut().now);
  await tick();
  assert.deepEqual(plain.notes, [], 'no computer control: the line just goes, as before');
  plain.away.stop();
});

test('away set again while away changes the same period: since stays, the change is kept, and dropping computer control tells the managers', () => {
  const t = noted();
  const now = at(12);
  const first = t.away.start('23:58', ['merge', 'computerControl'], now);
  const changed = t.away.start('23:59', ['merge', 'computerControl'], now + 1000);
  assert.equal(changed.since, first.since, 'the same period');
  assert.deepEqual(t.away.current(now + 2000), changed);
  assert.deepEqual(t.notes, [], 'a new time alone tells nobody');
  t.away.start('23:59', ['merge'], now + 2000);
  assert.equal(t.notes.length, 1);
  assert.match(t.notes[0]!, /^Ledung: Martin changed away mode at \d\d:\d\d: computer control ended\. .*; Martin is still away until 23:59; allowed: merge\.$/);
  assert.equal(t.away.log('mgr').since, first.since, "away_log still starts at the period's start");
  const lines = t.away.period(now + 3000).split('\n');
  assert.equal(lines.length, 3, 'the period and its two changes');
  assert.match(lines[0]!, /^Last away period: \d\d:\d\d–23:59, still on; allowed: merge\.$/);
  assert.match(lines[1]!, /^ {2}Changed at \d\d:\d\d; before that: until 23:58, allowed: merge, computer control\.$/);
  assert.match(lines[2]!, /^ {2}Changed at \d\d:\d\d; before that: until 23:59, allowed: merge, computer control\.$/);
  t.away.stop();
});

test('a new period after Back starts afresh', () => {
  const t = noted();
  const now = at(12);
  t.away.start('23:58', ['computerControl'], now);
  t.away.end(now + 1);
  const again = t.away.start('23:59', ['merge'], now + 2);
  assert.equal(again.since, now + 2);
  assert.equal(t.away.period(now + 3).split('\n').length, 1, 'no changes carried over');
  t.away.stop();
});

test("away_log's period line: when it ran, how it ended, what was allowed", () => {
  assert.equal(periodText(null, at(9)), '');
  assert.equal(periodText({ ...CC, endedAt: at(14, 5) }, at(15)), 'Last away period: 07:20–14:05, ended early by Back; allowed: merge, dev ship, computer control.');
  assert.equal(periodText(CC, at(18)), 'Last away period: 07:20–17:00, ran to its time; allowed: merge, dev ship, computer control.');
  assert.equal(periodText(CC, at(9)), 'Last away period: 07:20–17:00, still on; allowed: merge, dev ship, computer control.');
  const text = formatLog({ since: CC.since, records: [] }, null, 'Martin', periodText({ ...CC, endedAt: at(14, 5) }, at(15)));
  assert.equal(text.split('\n').slice(0, 2).join('\n'), 'Martin is not away now.\nLast away period: 07:20–14:05, ended early by Back; allowed: merge, dev ship, computer control.');
});

test('after a restart, a period that ran out with computer control tells only the managers still live, once they are attached (review 1 of #328)', async () => {
  const store = new Store(openDatabase(':memory:'));
  const mk = (id: string) => {
    store.createSession({ id, project: 'p', runner: 'local', title: `t-${id}`, parentId: null, permissionMode: 'default', role: 'manager' });
    store.updateSession(id, { status: 'idle' });
  };
  mk('live');
  mk('gone');
  // Before the restart: away with computer control, until an hour ago.
  const before = new Away(store, () => {});
  before.start(ranOut().hhmm, ['merge', 'computerControl'], ranOut().now);
  before.stop();

  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Martin' }), store, () => {}));
  await tick();
  assert.equal(store.undeliveredInbox('live').length + store.undeliveredInbox('gone').length, 0, 'nothing while the hosts are being attached');
  // As main.ts does: 'live' was attached, 'gone' had no host left.
  store.markUnfinishedSessionsEnded('Ledung stopped before this session ended.', ['live']);
  manager.away.begin();
  await tick();
  const notes = store.undeliveredInbox('live');
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.source, 'ledung');
  assert.match(notes[0]!.text, /^Ledung: Martin's away time ended at \d\d:\d\d: computer control ended\. /);
  assert.deepEqual(store.undeliveredInbox('gone'), [], 'an ended manager gets no stale note');
  manager.away.stop();
});

// ---------------------------------------------------------------- dev ships from sessions, with cd and redirects (issue #408)
// Martin, 2026-10-29 11:55: "in away mode shipping to dev is free! … if that toggle is enabled". The evidence
// command is the one a project manager's away_log held at 11:49:47 that day.

const SHIP = String.raw`python tools/ship\.py \S+ \S+ \S+ --dev( --(msg|notes) \S+)*`;
const PLAIN = 'python tools/ship.py 125.10 125.9 109 --dev --msg ship-msg-v125.10.txt --notes ship-notes-v125.10.txt';

test('a dev ship counts with cd <path> && before it and output redirects after it', () => {
  const ok = [
    PLAIN,
    `cd ../worktrees/ship && ${PLAIN}`,
    `cd "C:/Users/x/my worktree" && ${PLAIN}`,
    `cd 'odd path' &&${PLAIN}`,
    `${PLAIN} > ../../../.scratch/ship-v125.10-run2.log 2>&1`,
    `${PLAIN} > run.log`,
    `${PLAIN} >> run.log`,
    `${PLAIN} 2> err.log`,
    `${PLAIN} 2>&1`,
    `${PLAIN} >run.log 2>err.log`,
    `cd ../w && ${PLAIN} > "ship log.txt" 2>&1`,
  ];
  for (const c of ok) assert.deepEqual(classify(c, SHIP), { kind: 'devShip' }, c);
  assert.deepEqual(shipCore(`cd ../w && ${PLAIN} > x.log 2>&1`), { core: PLAIN });
});

test('a dev ship that chains, pipes, computes or does a second thing is held, saying what to change', () => {
  const held = [
    // The 11:49:47 command, held then and held now: a second command after the ship.
    `${PLAIN} > ../../../.scratch/ship-v125.10-run2.log 2>&1; echo exit $?; tail -15 ../../../.scratch/ship-v125.10-run2.log`,
    `${PLAIN} > run.log; echo done`,
    `${PLAIN} | tee run.log`,
    `${PLAIN} 2>&1 | tail -15`,
    `${PLAIN} && git push --force origin main`,
    `${PLAIN} &`,
    `${PLAIN} > $LOG`,
    `${PLAIN} >&run.log`,
    `${PLAIN} 2>&1x`,
    `cd x && cd y && ${PLAIN}`,
    `cd $DIR && ${PLAIN}`,
    `cd \`pwd\` && ${PLAIN}`,
    `cd x; ${PLAIN}`,
    `cd x || ${PLAIN}`,
    `rm -rf build && ${PLAIN}`,
    `${PLAIN} --msg "$(cat m.txt)"`,
    `${PLAIN} > run.log < in.txt`,
  ];
  for (const c of held) {
    const p = classify(c, SHIP);
    assert.equal(p.kind, 'other', c);
    assert.ok(p.kind === 'other' && p.shipLike && p.why?.endsWith(SHIP_FORM), `${c}: ${JSON.stringify(p)}`);
  }
  // Bash takes the 5 of 5> as a file descriptor, so the ship would run without it (review 1 of PR #409).
  const versioned = String.raw`npm run ship:dev( \d+)?`;
  assert.deepEqual(classify('npm run ship:dev 5 > run.log', versioned), { kind: 'devShip' }, 'a 5 with a space is the argument');
  for (const c of ['npm run ship:dev 5>run.log', 'npm run ship:dev 10> run.log', 'npm run ship:dev 3>&1']) {
    const p = classify(c, versioned);
    assert.ok(p.kind === 'other' && p.shipLike && /file descriptor/.test(p.why ?? ''), `${c}: ${JSON.stringify(p)}`);
  }
  // A redirect or a cd is not a way around the whole-command rule (review 1, PR #42).
  assert.equal(classify('cd x && git push --force origin main ship-dev', 'ship-dev').kind, 'other');
  assert.equal(classify('git push --force origin main > ship-dev', 'ship-dev').kind, 'other');
  assert.equal(classify('cd ship-dev && git push --force origin main', 'ship-dev').kind, 'other');
});

test('decide: a held dev ship says what to change; dev ship not allowed changes nothing', async () => {
  const chained = await decide(AWAY, 'Martin', `${PLAIN} > run.log; echo done`, SHIP, view(pr()));
  assert.equal(chained.allowed, false);
  assert.equal(chained.reason, `held for Martin: Martin is away, and this is not a dev ship away mode lets through: it is more than one plain command; ${SHIP_FORM}`);
  assert.match(chained.reason, /`cd <path> &&`/);
  assert.equal((await decide(AWAY, 'Martin', PLAIN, null, view(pr()))).allowed, false, 'no dev ship command set: nothing is a dev ship');
  // Without dev ship in the away line, every form is held, as before.
  const merges = { ...AWAY, allow: ['merge' as const] };
  for (const c of [PLAIN, `cd w && ${PLAIN}`, `${PLAIN} > run.log 2>&1`]) {
    const d = await decide(merges, 'Martin', c, SHIP, view(pr()));
    assert.equal(d.allowed, false, c);
    assert.match(d.reason, /did not allow dev ship/, c);
  }
  assert.equal((await decide(AWAY, 'Martin', `cd w && ${PLAIN} > run.log 2>&1`, SHIP, view(pr()))).allowed, true);
});

test("while away, a manager's dev ship with cd and a redirect runs with no prompt", async () => {
  const t = sessionSetup('manager', pr(), { devShip: SHIP, sensitive: [String.raw`\bship\.py\b`] });
  t.away.start(later(), ['merge', 'devShip']);
  const command = `cd ../w && ${PLAIN} > run.log 2>&1`;
  assert.deepEqual(await t.settle(t.ask(command)), { behavior: 'allow', updatedInput: { command } });
  assert.equal(t.store.pendingPermissions().length, 0);
  assert.equal(t.away.log('mgr').records[0]!.allowed, true);
  t.away.stop();
});

test("while away, a session's dev ship goes through without Martin, recorded in its manager's away_log with its name", async () => {
  const t = sessionSetup('session', pr(), { devShip: SHIP, sensitive: [String.raw`\bship\.py\b`] });
  t.away.start(later(), ['merge', 'devShip']);
  const command = `${PLAIN} > run.log 2>&1`;
  assert.deepEqual(await t.settle(t.ask(command)), { behavior: 'allow', updatedInput: { command } });
  assert.equal(t.store.pendingPermissions().length, 0, 'no prompt');
  assert.equal(t.viewed.length, 0, 'GitHub is not asked');
  const [r] = t.away.log('mgr').records;
  assert.equal(r!.allowed, true);
  assert.equal(r!.kind, 'devShip');
  assert.equal(r!.command, command);
  assert.match(r!.reason, /^Allowed by away mode: .* \(run by its session "Worker"\)$/);
  assert.equal(t.away.log('s').records.length, 0);
  assert.match(formatLog(t.away.log('mgr'), t.away.current(), 'Martin'), /ALLOWED · dev ship[\s\S]*run by its session "Worker"/);
  t.away.stop();
});

test("while away, a session's chained dev ship is held for Martin as before, with the reason, and noted in its manager's record", async () => {
  const t = sessionSetup('session', pr(), { devShip: SHIP, sensitive: [String.raw`\bship\.py\b`] });
  t.away.start(later(), ['merge', 'devShip']);
  assert.equal(await t.settle(t.ask(`${PLAIN} > run.log; echo done`)), 'waiting');
  const [p] = t.store.pendingPermissions();
  assert.equal(p!.addressedTo, 'mgr');
  assert.ok(p!.sensitive);
  assert.match(p!.reason ?? '', /Away mode held for Martin: .*not a dev ship away mode lets through/);
  const [r] = t.away.log('mgr').records;
  assert.equal(r!.allowed, false);
  assert.match(r!.reason, /\(run by its session "Worker"\)$/);
  t.away.stop();
});

test("while away, a session's dev ship waits for Martin as before when dev ship is not allowed, or it has no manager in its project", async () => {
  const cases: [string, Parameters<typeof sessionSetup>[2], Parameters<Away['start']>[1]][] = [
    ['dev ship not allowed', {}, ['merge']],
    ["its manager is another project's", { managerProject: 'q' }, ['merge', 'devShip']],
    ['no manager', { orphan: true }, ['merge', 'devShip']],
    ['no dev ship command set', { devShip: '' }, ['merge', 'devShip']],
  ];
  for (const [name, extra, allow] of cases) {
    const t = sessionSetup('session', pr(), { devShip: SHIP, sensitive: [String.raw`\bship\.py\b`], ...extra });
    t.away.start(later(), allow);
    assert.equal(await t.settle(t.ask(PLAIN)), 'waiting', name);
    assert.equal(t.store.pendingPermissions().length, 1, name);
    assert.equal(t.away.log('mgr').records.length, 0, `${name}: away mode stays out of it`);
    t.away.stop();
  }
});
