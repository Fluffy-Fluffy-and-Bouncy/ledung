// The session pull request poll (issue #252, Martin's decision of 2026-10-20, question 425): free local
// git checks first, one GraphQL query per repo per round, and the budget's back-off. gh and git are faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  batchQuery, LOW_SHARE, NORMAL_MS, parseBatch, parseRemoteUrl, parseRestReading, pollingAt, prTarget, PullRequestPoller, SLOW_MS, STOP_SHARE, worstReading,
  type GhAnswer, type GitState, type PrSource,
} from '../src/sessions/pr-poll.ts';
import type { GitHubBudget, PullRequestInfo } from '../src/shared/protocol.ts';
import { githubBudgetLine, githubBudgetsShown } from '../web/src/githubBudget.ts';

const URL_LINE = 'remote.origin.url https://github.com/acme/app.git';
const SHA = 'a'.repeat(40);
const HEAD_REF = `refs/remotes/origin/HEAD ${'b'.repeat(40)} refs/remotes/origin/main`;
const MAIN_REF = `refs/remotes/origin/main ${'b'.repeat(40)} `;

/** git's output for a repo cloned from acme/app, on `branch`, with these remote branches and branch config lines. */
function git(branch: string, remoteBranches: string[] = [], config: string[] = []): GitState {
  return {
    head: `${branch}\n`,
    config: [URL_LINE, 'remote.origin.fetch +refs/heads/*:refs/remotes/origin/*', ...config].join('\n'),
    refs: [HEAD_REF, MAIN_REF, ...remoteBranches.map((b) => `refs/remotes/origin/${b} ${SHA} `)].join('\n'),
  };
}

test('no lookup for the default branch, a branch never pushed, a detached HEAD or a remote that is not GitHub', () => {
  assert.deepEqual(prTarget(git('main', [], ['branch.main.remote origin', 'branch.main.merge refs/heads/main'])), { skip: 'default', branch: 'main' });
  // `git switch -c am/x origin/main` tracks main until pushed: nothing to find yet.
  assert.deepEqual(prTarget(git('am/x', [], ['branch.am/x.remote origin', 'branch.am/x.merge refs/heads/main'])), { skip: 'default', branch: 'am/x' });
  assert.deepEqual(prTarget(git('am/x')), { skip: 'unpushed', branch: 'am/x' });
  assert.deepEqual(prTarget(git('HEAD')), { skip: 'detached', branch: null });
  assert.deepEqual(prTarget({ ...git('am/x', ['am/x']), config: 'remote.origin.url https://gitlab.com/acme/app.git' }), { skip: 'remote', branch: 'am/x' });
});

test('a pushed branch is looked up under its own name, even while it still tracks main', () => {
  assert.deepEqual(prTarget(git('am/x', ['am/x'], ['branch.am/x.remote origin', 'branch.am/x.merge refs/heads/main'])),
    { host: 'github.com', owner: 'acme', name: 'app', branch: 'am/x', remoteBranch: 'am/x', sha: SHA });
  assert.deepEqual(prTarget(git('am/x', ['am/x'])), { host: 'github.com', owner: 'acme', name: 'app', branch: 'am/x', remoteBranch: 'am/x', sha: SHA });
  // Tracking a branch of another name that isn't fetched yet: still asked for, under that name.
  assert.deepEqual(prTarget(git('local', [], ['branch.local.remote origin', 'branch.local.merge refs/heads/feature'])),
    { host: 'github.com', owner: 'acme', name: 'app', branch: 'local', remoteBranch: 'feature', sha: '' });
});

test('a branch tracking a fork is looked up in the fork', () => {
  const state: GitState = {
    head: 'fix\n',
    config: [URL_LINE, 'remote.mine.url git@github.com:me/app.git', 'branch.fix.remote mine', 'branch.fix.merge refs/heads/fix'].join('\n'),
    refs: [HEAD_REF, `refs/remotes/mine/fix ${SHA} `].join('\n'),
  };
  assert.deepEqual(prTarget(state), { host: 'github.com', owner: 'me', name: 'app', branch: 'fix', remoteBranch: 'fix', sha: SHA });
});

test('GitHub remote URLs in their usual forms', () => {
  const app = { host: 'github.com', owner: 'acme', name: 'app' };
  assert.deepEqual(parseRemoteUrl('https://github.com/acme/app'), app);
  assert.deepEqual(parseRemoteUrl('https://user@github.com/acme/app.git/'), app);
  assert.deepEqual(parseRemoteUrl('git@github.com:acme/app.git'), app);
  assert.deepEqual(parseRemoteUrl('ssh://git@ssh.github.com:443/acme/app.git'), app);
  assert.deepEqual(parseRemoteUrl('https://github.example.com/team/tool.git'), { host: 'github.example.com', owner: 'team', name: 'tool' });
  assert.equal(parseRemoteUrl('C:/repos/app'), null);
  assert.equal(parseRemoteUrl('https://gitlab.com/acme/app.git'), null);
});

test('one query names every branch twice (by ref and by head name) and asks for the budget', () => {
  const q = batchQuery('acme', 'app', ['am/x', 'am/"y"']);
  assert.match(q, /rateLimit\{remaining limit resetAt\}/);
  assert.match(q, /repository\(owner:"acme",name:"app"\)/);
  assert.match(q, /r0:ref\(qualifiedName:"refs\/heads\/am\/x"\)\{associatedPullRequests\(first:3,states:\[OPEN,MERGED,CLOSED\]/);
  assert.match(q, /h1:pullRequests\(headRefName:"am\/\\"y\\""/);
  assert.match(q, /isDraft url headRepositoryOwner\{login\} commits\(last:1\)\{nodes\{commit\{statusCheckRollup\{state\}\}\}\}/);
});

/** A GraphQL pull request node. */
function node(number: number, state: string, rollup: string | null, extra: Record<string, unknown> = {}) {
  return {
    number, title: `PR ${number}`, state, isDraft: false, url: `https://github.com/acme/app/pull/${number}`, headRepositoryOwner: { login: 'acme' },
    commits: { nodes: [{ commit: { statusCheckRollup: rollup === null ? null : { state: rollup } } }] }, ...extra,
  };
}
const RESET = '2026-10-20T10:00:00Z';
function answer(repo: Record<string, unknown> | null, remaining = 4000): string {
  return JSON.stringify({ data: { rateLimit: { remaining, limit: 5000, resetAt: RESET }, repository: repo } });
}
const byRef = (...nodes: unknown[]) => ({ associatedPullRequests: { nodes } });
const byName = (...nodes: unknown[]) => ({ nodes });

test('the answer gives what the page showed before: number, title, state, link and checks', () => {
  const { prs, reading } = parseBatch(answer({
    r0: byRef(node(7, 'OPEN', 'SUCCESS')), h0: byName(node(7, 'OPEN', 'SUCCESS')),
    r1: byRef(node(8, 'OPEN', 'FAILURE', { isDraft: true })), h1: byName(),
    r2: byRef(node(9, 'OPEN', 'PENDING')), h2: byName(),
    r3: byRef(node(10, 'OPEN', null)), h3: byName(),
    r4: byRef(node(11, 'OPEN', 'ERROR')), h4: byName(),
    r5: byRef(node(12, 'OPEN', 'EXPECTED')), h5: byName(),
  }), 'acme', 6);
  assert.deepEqual(prs![0], { number: 7, title: 'PR 7', state: 'open', url: 'https://github.com/acme/app/pull/7', checks: 'passing' });
  assert.deepEqual(prs!.map((p) => [p!.state, p!.checks]), [['open', 'passing'], ['draft', 'failing'], ['open', 'running'], ['open', 'none'], ['open', 'failing'], ['open', 'running']]);
  assert.deepEqual(reading, { remaining: 4000, limit: 5000, resetAt: Date.parse(RESET) });
});

test('an open pull request beats a newer closed one; a deleted branch still finds its merged one, but not a stranger\'s', () => {
  const { prs } = parseBatch(answer({
    r0: byRef(node(3, 'CLOSED', null), node(4, 'OPEN', null)), h0: byName(),
    // GitHub deleted the branch after the merge: no ref, found by head name.
    r1: null, h1: byName(node(5, 'MERGED', 'SUCCESS')),
    // Someone else's fork has a branch of the same name.
    r2: null, h2: byName(node(6, 'OPEN', null, { headRepositoryOwner: { login: 'stranger' } })),
  }), 'acme', 3);
  assert.deepEqual(prs!.map((p) => p && [p.number, p.state]), [[4, 'open'], [5, 'merged'], null]);
  assert.deepEqual(parseBatch(answer(null), 'acme', 2).prs, [null, null]);
});

test('an unusable or rate-limited answer changes nothing it shows', () => {
  assert.deepEqual(parseBatch('', 'acme', 1), { prs: null, reading: null, rateLimited: false });
  const limited = parseBatch(JSON.stringify({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }), 'acme', 1);
  assert.equal(limited.prs, null);
  assert.equal(limited.rateLimited, true);
});

test('the budget: the worst reading still in its hour; slow under 20 % left, stopped under 5 %', () => {
  assert.equal(LOW_SHARE, 0.2);
  assert.equal(STOP_SHARE, 0.05);
  const now = 1000;
  const r = (remaining: number, resetAt = 2000) => ({ remaining, limit: 5000, resetAt });
  assert.deepEqual(worstReading([r(4000), r(300), null], now), r(300));
  assert.deepEqual(worstReading([r(4000), r(10, 500)], now), r(4000), 'an expired reading no longer counts');
  assert.equal(worstReading([null, r(1, 900)], now), null);
  assert.equal(pollingAt(null), 'normal');
  assert.equal(pollingAt(r(1000)), 'normal');
  assert.equal(pollingAt(r(999)), 'slow');
  assert.equal(pollingAt(r(250)), 'slow');
  assert.equal(pollingAt(r(249)), 'stopped');
  assert.deepEqual(parseRestReading(JSON.stringify({ resources: { core: { remaining: 1, limit: 5000, reset: 1 }, graphql: { remaining: 4809, limit: 5000, reset: 1760954615 } } })),
    { remaining: 4809, limit: 5000, resetAt: 1760954615000 });
});

// --- The poller, with fake sessions -----------------------------------------------------------------

const NOW = Date.parse('2026-10-20T09:00:00Z');
const REST_RESET = Math.floor(Date.parse(RESET) / 1000);

interface Fake extends PrSource { state: GitState | null }

/** A world of fake sessions sharing one gh: every gh call is recorded; `graphql` answers queries. */
function world(opts: { rest?: number; graphql?: (query: string) => string } = {}) {
  const calls: string[] = [];
  const shown: [string, PullRequestInfo | null][] = [];
  const budgets: GitHubBudget[][] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  let rest = opts.rest ?? 4500;
  let graphql = opts.graphql ?? (() => answer({}));
  const source = (state: GitState | null, scope = 'local'): Fake => ({
    ghScope: scope,
    state,
    async gitState() {
      return this.state;
    },
    async ghApi(args: string[], input: string | null): Promise<GhAnswer> {
      if (args[0] === 'rate_limit') {
        calls.push(`${scope} rate_limit`);
        return { ok: true, stdout: JSON.stringify({ resources: { graphql: { remaining: rest, limit: 5000, reset: REST_RESET } } }) };
      }
      const query = JSON.parse(input!).query as string;
      calls.push(`${scope} graphql ${/repository\(owner:"([^"]+)",name:"([^"]+)"\)/.exec(query)!.slice(1).join('/')}`);
      return { ok: true, stdout: graphql(query) };
    },
  });
  const poller = new PullRequestPoller({
    show: (id, pr) => shown.push([id, pr]),
    onBudget: (b) => budgets.push(b),
    now: () => NOW,
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => (t.cancelled = true);
    },
  });
  return {
    poller, calls, shown, budgets, timers, source,
    setRest: (n: number) => (rest = n),
    setGraphql: (f: (query: string) => string) => (graphql = f),
    graphqlCalls: () => calls.filter((c) => c.includes(' graphql ')),
  };
}

/** Answers every branch's aliases with this pull request node by ref (or none). */
const allAre = (n: unknown) => () => {
  const repo: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) {
    repo[`r${i}`] = n ? byRef(n) : null;
    repo[`h${i}`] = byName();
  }
  return answer(repo);
};

test('one round: one query for all the sessions on a repo, none for a manager on main or an unpushed branch', async () => {
  const w = world({ graphql: allAre(node(42, 'OPEN', 'SUCCESS')) });
  w.poller.watch('w1', w.source(git('am/a', ['am/a'])));
  w.poller.watch('w2', w.source(git('am/b', ['am/b'])));
  w.poller.watch('w3', w.source(git('am/b', ['am/b'])));
  w.poller.watch('mgr', w.source(git('main', [], ['branch.main.remote origin', 'branch.main.merge refs/heads/main'])));
  w.poller.watch('new', w.source(git('am/c', [], ['branch.am/c.remote origin', 'branch.am/c.merge refs/heads/main'])));
  await w.poller.run('soon');
  assert.deepEqual(w.calls, ['local rate_limit', 'local graphql acme/app']);
  const shown = Object.fromEntries(w.shown);
  assert.equal(shown.w1?.number, 42);
  assert.equal(shown.w2?.number, 42);
  assert.equal(shown.w3?.number, 42);
  assert.equal(shown.mgr, null);
  assert.equal(shown.new, null);
  assert.deepEqual(w.budgets.at(-1), [{ host: 'github.com', container: null, remaining: 4000, limit: 5000, resetAt: Date.parse(RESET), polling: 'normal' }]);
});

test('a round per repo, and per gh login: a container\'s sessions use its own', async () => {
  const w = world({ graphql: allAre(null) });
  w.poller.watch('a', w.source(git('am/a', ['am/a'])));
  w.poller.watch('b', w.source({ ...git('am/b', ['am/b']), config: `remote.origin.url https://github.com/acme/other\n` }));
  w.poller.watch('c', w.source(git('am/c', ['am/c']), 'docker:box'));
  await w.poller.run('soon');
  assert.deepEqual(w.calls.sort(), ['docker:box graphql acme/app', 'docker:box rate_limit', 'local graphql acme/app', 'local graphql acme/other', 'local rate_limit']);
  assert.deepEqual(w.poller.budgets().map((b) => b.container).sort(), ['box', null]);
});

test('a merged or closed pull request is not asked about again until the branch moves', async () => {
  const w = world({ graphql: allAre(node(5, 'MERGED', 'SUCCESS')) });
  const s = w.source(git('am/a', ['am/a']));
  w.poller.watch('w1', s);
  await w.poller.run('soon');
  assert.equal(w.graphqlCalls().length, 1);
  await w.poller.run('all');
  w.poller.watch('w1', s);
  await w.poller.run('soon');
  assert.equal(w.graphqlCalls().length, 1, 'no query for a merged pull request on an unchanged branch');
  // GitHub deleted the branch and a fetch pruned it: the merged pull request stays shown, still no query.
  s.state = git('am/a');
  await w.poller.run('all');
  assert.equal(w.graphqlCalls().length, 1);
  assert.deepEqual(w.shown.at(-1), ['w1', { number: 5, title: 'PR 5', state: 'merged', url: 'https://github.com/acme/app/pull/5', checks: 'passing' }]);
  // A new branch, pushed: asked about again.
  s.state = git('am/b', ['am/b']);
  w.setGraphql(allAre(node(6, 'OPEN', 'PENDING')));
  await w.poller.run('all');
  assert.equal(w.graphqlCalls().length, 2);
  assert.equal(w.shown.at(-1)![1]!.number, 6);
});

test('under 20 % left only the 10-minute rounds ask, and under 5 % none until the reset', async () => {
  const w = world({ rest: 900, graphql: allAre(node(1, 'OPEN', null)) });
  w.poller.watch('w1', w.source(git('am/a', ['am/a'])));
  await w.poller.run('soon');
  assert.equal(w.graphqlCalls().length, 0, 'a turn\'s end asks nothing at 18 % left');
  await w.poller.run('all');
  assert.equal(w.graphqlCalls().length, 1, 'the timed round does');
  assert.equal(w.poller.budgets()[0]!.polling, 'slow');
  // The timed round that is due now sets the next one 10 minutes on, not 3.
  const due = w.timers.find((t) => !t.cancelled && t.ms === NORMAL_MS)!;
  due.cancelled = true; // spent once it fires
  due.fn();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.graphqlCalls().length, 2);
  assert.equal(w.timers.filter((t) => !t.cancelled && t.ms >= NORMAL_MS).map((t) => t.ms).join(), String(SLOW_MS));
  w.setRest(200);
  const before = w.graphqlCalls().length;
  await w.poller.run('all');
  assert.equal(w.graphqlCalls().length, before, 'stopped at 4 % left');
  assert.equal(w.poller.budgets()[0]!.polling, 'stopped');
});

test('the worst counter decides: the query\'s own reading can stop it when the free one looks fine', async () => {
  const w = world({ rest: 4800 });
  w.setGraphql(() => answer({ r0: byRef(node(1, 'OPEN', null)), h0: byName() }, 100));
  w.poller.watch('w1', w.source(git('am/a', ['am/a'])));
  await w.poller.run('all');
  assert.equal(w.graphqlCalls().length, 1);
  assert.deepEqual(w.budgets.at(-1)!.map((b) => [b.remaining, b.polling]), [[100, 'stopped']]);
  await w.poller.run('all');
  assert.equal(w.graphqlCalls().length, 1);
});

test('refused for the rate limit: stopped until the reset; gh failing otherwise keeps what is shown', async () => {
  const w = world({ graphql: () => JSON.stringify({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }) });
  w.poller.watch('w1', w.source(git('am/a', ['am/a'])));
  await w.poller.run('all');
  assert.deepEqual(w.shown, []);
  assert.equal(w.poller.budgets()[0]!.polling, 'stopped');
  const w2 = world({ graphql: () => 'gh: not logged in' });
  w2.poller.watch('w1', w2.source(git('am/a', ['am/a'])));
  await w2.poller.run('all');
  assert.deepEqual(w2.shown, []);
});

test('a forgotten session is not polled, and with none left no timer runs', async () => {
  const w = world({ graphql: allAre(null) });
  w.poller.watch('w1', w.source(git('am/a', ['am/a'])));
  w.poller.forget('w1');
  await w.poller.run('all');
  assert.deepEqual(w.calls, []);
  assert.ok(w.timers.filter((t) => t.ms >= NORMAL_MS).every((t) => t.cancelled));
});

test('the page drops a line once its reset has passed, so a stale "0 left" never stays up', () => {
  const b: GitHubBudget = { host: 'github.com', container: null, remaining: 0, limit: 5000, resetAt: 2000, polling: 'stopped' };
  assert.deepEqual(githubBudgetsShown([b], 1999), [b]);
  assert.deepEqual(githubBudgetsShown([b], 2000), []);
});

test('the page line: what is left, until when, and the poll\'s state', () => {
  const time = () => '11:03';
  const b: GitHubBudget = { host: 'github.com', container: null, remaining: 4210, limit: 5000, resetAt: 0, polling: 'normal' };
  assert.equal(githubBudgetLine(b, time), 'GitHub: 4,210 of 5,000 left until 11:03');
  assert.equal(githubBudgetLine({ ...b, remaining: 900, polling: 'slow' }, time), 'GitHub: 900 of 5,000 left until 11:03 · PRs checked every 10 min');
  assert.equal(githubBudgetLine({ ...b, container: 'box', host: 'github.example.com', remaining: 10, polling: 'stopped' }, time),
    'GitHub (box, github.example.com): 10 of 5,000 left until 11:03 · PRs not checked until then');
});
