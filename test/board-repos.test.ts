// The board repo picker (decision 2026-10-14): listing what the GitHub login can reach, merging it with the
// boards other projects use, searching it, and creating a private repo. Answers shaped like GitHub's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Http, HttpAnswer } from '../src/board/github.ts';
import { GitHubRepos, validRepoName } from '../src/board/repos.ts';
import { BoardError } from '../src/board/types.ts';
import { matches, pickerGroups, suggestBoardName, SHOWN } from '../web/src/boardRepos.ts';

const API = 'https://api.github.com';
const repo = (full: string, isPrivate = true) => ({ full_name: full, private: isPrivate, id: 1 });
const ok = (body: unknown, headers: Record<string, string> = {}): HttpAnswer => ({ status: 200, headers, body });

/** Answers by "METHOD url" prefix, the longest prefix first; a list answers in turn and repeats its last. Records every call. */
function stub(routes: Record<string, HttpAnswer | HttpAnswer[]>) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  const seen = new Map<string, number>();
  const http: Http = async (method, url, headers, body) => {
    calls.push({ method, url, headers, body });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => `${method} ${url}`.startsWith(k));
    if (!key) throw new Error(`no route for ${method} ${url}`);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const a = routes[key]!;
    return Array.isArray(a) ? a[Math.min(n, a.length - 1)]! : a;
  };
  return { http, calls };
}

const make = (http: Http, now = () => 1000) => new GitHubRepos({ http, token: async () => 'tok', now });
const owners = { [`GET ${API}/user/orgs`]: ok([{ login: 'acme' }]), [`GET ${API}/user`]: ok({ login: 'me' }) };

test('lists every page of the repos the login can reach, user and organisations together', async () => {
  const { http, calls } = stub({
    [`GET ${API}/user/repos?per_page=100`]: [
      ok([repo('me/a'), repo('org/b', false)], { link: `<${API}/user/repos?page=2>; rel="next"` }),
      ok([repo('org/c')]),
    ],
    [`GET ${API}/user/repos?page=2`]: ok([repo('org/c')]),
  });
  const c = await make(http).choices();
  assert.deepEqual(c.repos, [{ repo: 'me/a', private: true }, { repo: 'org/b', private: false }, { repo: 'org/c', private: true }]);
  assert.equal(c.truncated, false);
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /affiliation=owner,collaborator,organization_member/);
  assert.equal(calls[0]!.headers.authorization, 'Bearer tok');
});

test('the list is cached for a minute, and read again on refresh or after it expires', async () => {
  let t = 1000;
  const { http, calls } = stub({ [`GET ${API}/user/repos`]: ok([repo('me/a')]) });
  const r = make(http, () => t);
  await r.choices();
  await r.choices();
  assert.equal(calls.length, 1);
  await r.choices(true);
  assert.equal(calls.length, 2);
  t += 61_000;
  await r.choices();
  assert.equal(calls.length, 3);
});

test('a very long list is cut at ten pages and says so', async () => {
  const { http, calls } = stub({ [`GET ${API}/user/repos`]: ok([repo('me/a')], { link: `<${API}/user/repos?page=2>; rel="next"` }) });
  const c = await make(http).choices();
  assert.equal(calls.length, 10);
  assert.equal(c.truncated, true);
});

test('listing failures: not signed in, rate limited, unreachable', async () => {
  const signedOut = new GitHubRepos({ http: async () => ok([]), token: async () => { throw new Error('no gh'); } });
  await assert.rejects(signedOut.choices(), (e: BoardError) => e.kind === 'signin' && /gh auth login/.test(e.message));
  const unauthorised = make(stub({ 'GET ': { status: 401, headers: {}, body: { message: 'Bad credentials' } } }).http);
  await assert.rejects(unauthorised.choices(), (e: BoardError) => e.kind === 'signin');
  const limited = make(stub({ 'GET ': { status: 403, headers: {}, body: { message: 'API rate limit exceeded' } } }).http);
  await assert.rejects(limited.choices(), (e: BoardError) => e.kind === 'limited');
  const down = make(async () => { throw new Error('offline'); });
  await assert.rejects(down.choices(), (e: BoardError) => e.kind === 'unreachable' && /offline/.test(e.message));
});

test('owners are the user, then each organisation', async () => {
  const { http } = stub({ [`GET ${API}/user/orgs`]: ok([{ login: 'acme' }, { login: 'zed' }]), [`GET ${API}/user`]: ok({ login: 'me' }) });
  assert.deepEqual(await make(http).owners(), [{ login: 'me', kind: 'user' }, { login: 'acme', kind: 'org' }, { login: 'zed', kind: 'org' }]);
});

test('create: always private, under the user or an organisation, and the list is read afresh after', async () => {
  const user = stub({ ...owners, [`POST ${API}/user/repos`]: { status: 201, headers: {}, body: repo('me/x-board') }, [`GET ${API}/user/repos`]: ok([]) });
  const r = make(user.http);
  await r.choices();
  const made = await r.create('me', 'x-board');
  assert.deepEqual(made, { repo: 'me/x-board', private: true });
  const post = user.calls.find((c) => c.method === 'POST')!;
  assert.equal((post.body as { private: boolean }).private, true);
  assert.equal((post.body as { name: string }).name, 'x-board');
  await r.choices();
  assert.equal(user.calls.filter((c) => c.url.startsWith(`${API}/user/repos?`)).length, 2, 'the cache was dropped');

  const org = stub({ ...owners, [`POST ${API}/orgs/acme/repos`]: { status: 201, headers: {}, body: repo('acme/y') } });
  assert.equal((await make(org.http).create('ACME', 'y')).repo, 'acme/y');
  assert.equal((org.calls.find((c) => c.method === 'POST')!.body as { private: boolean }).private, true);
});

test('create: clear errors for a taken name, no permission, an owner that is not yours and bad names', async () => {
  const taken = stub({ ...owners, 'POST ': { status: 422, headers: {}, body: { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] } } });
  await assert.rejects(make(taken.http).create('me', 'x'), (e: BoardError) => e.kind === 'access' && /me\/x already exists/.test(e.message));
  const denied = stub({ ...owners, 'POST ': { status: 403, headers: {}, body: { message: 'You are not allowed to create private repositories' } } });
  await assert.rejects(make(denied.http).create('acme', 'x'), (e: BoardError) => /may not create repositories in acme/.test(e.message));
  const stranger = stub(owners);
  await assert.rejects(make(stranger.http).create('someone', 'x'), /neither your account nor an organisation/);
  assert.equal(stranger.calls.some((c) => c.method === 'POST'), false, 'nothing is sent for an owner that is not yours');
  const bad = stub(owners);
  await assert.rejects(make(bad.http).create('me', 'has space'), /not a repository name/);
  await assert.rejects(make(bad.http).create('me', '..'), /not a repository name/);
  assert.equal(bad.calls.length, 0);
});

test('repository names follow GitHub', () => {
  for (const good of ['a', 'my-board', 'x_y.z', 'A1']) assert.equal(validRepoName(good), true, good);
  for (const bad of ['', '.', '..', 'a b', 'a/b', 'x.git', 'a'.repeat(101)]) assert.equal(validRepoName(bad), false, bad);
});

test('the picker lists boards other projects use first, then the rest, and searches both', () => {
  const choices = {
    used: [{ repo: 'org/shared', projects: ['p1', 'p2'] }, { repo: 'me/old', projects: ['p3'] }],
    repos: [{ repo: 'me/a', private: true }, { repo: 'org/shared', private: false }, { repo: 'org/Board-2', private: true }],
    truncated: false, error: null,
  };
  const all = pickerGroups(choices, '');
  assert.deepEqual(all.used.map((r) => [r.repo, r.private, r.projects]), [['org/shared', false, ['p1', 'p2']], ['me/old', null, ['p3']]]);
  assert.deepEqual(all.others.map((r) => r.repo), ['me/a', 'org/Board-2'], 'a used board is not listed twice');
  const found = pickerGroups(choices, 'ORG board');
  assert.deepEqual(found.used, []);
  assert.deepEqual(found.others.map((r) => r.repo), ['org/Board-2']);
  assert.deepEqual(pickerGroups(null, 'x'), { used: [], others: [], hidden: 0 });
  assert.equal(matches('Org/Shared', 'org/sh'), true);
  assert.equal(matches('org/shared', 'org zzz'), false);
});

test('a long list shows the first screenful and says how many are hidden', () => {
  const repos = Array.from({ length: SHOWN + 15 }, (_, i) => ({ repo: `o/r${i}`, private: true }));
  const g = pickerGroups({ used: [], repos, truncated: false, error: null }, '');
  assert.equal(g.others.length, SHOWN);
  assert.equal(g.hidden, 15);
  assert.equal(pickerGroups({ used: [], repos, truncated: false, error: null }, 'r7').hidden, 0);
});

test('the suggested name is "<project>-board", spelled as GitHub allows', () => {
  assert.equal(suggestBoardName('Weight less'), 'weight-less-board');
  assert.equal(suggestBoardName('Project Ledung'), 'project-ledung-board');
  assert.equal(suggestBoardName('Ü'), 'ledung-board');
  assert.equal(validRepoName(suggestBoardName('My  odd/project!')), true);
});
