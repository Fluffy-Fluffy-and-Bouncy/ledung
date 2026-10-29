// The board's GitHub adapter (docs/steps/message-board.md, step 2), against answers shaped like ones
// recorded from the board repo on 2026-10-14 (ids, URLs, headers and the Link format as GitHub sent them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubBackend, type Http, type HttpAnswer } from '../src/board/github.ts';
import { BoardError } from '../src/board/types.ts';
import { Board } from '../src/board/board.ts';
import { BoardStore } from '../src/board/store.ts';
import { openDatabase } from '../src/store/database.ts';
import { parseConfig } from '../src/config.ts';

const REPO = 'org/board';
const API = 'https://api.github.com';
const RATE = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4980', 'x-ratelimit-reset': '1791989301' };

const user = (login: string) => ({ login, avatar_url: `https://avatars.githubusercontent.com/u/1?v=4` });
const issue = (n: number, body: string, at: string, login = 'alice', updated = at) => ({
  number: n, id: 5849241600 + n, title: `Thread ${n}`, body, user: user(login), created_at: at, updated_at: updated, comments: 0,
});
const comment = (id: number, n: number, body: string, at: string, login = 'alice') => ({
  id, issue_url: `${API}/repos/${REPO}/issues/${n}`, body, user: user(login), created_at: at, updated_at: at,
});
const header = (to: string[], from = 'P') => `<!-- ledung ${JSON.stringify({ v: 1, to, from })} -->\n`;

/** Answers by URL; each route answers in turn, repeating its last answer. Records every call. */
function stub(routes: Record<string, (HttpAnswer | ((h: Record<string, string>) => HttpAnswer))[]>) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  const used = new Map<string, number>();
  const http: Http = async (method, url, headers, body) => {
    calls.push({ method, url, headers, body });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    if (!key) throw new Error(`no route for ${method} ${url}`);
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    const list = routes[key]!;
    const a = list[Math.min(n, list.length - 1)]!;
    return typeof a === 'function' ? a(headers) : a;
  };
  return { http, calls };
}

const ok = (body: unknown, extra: Record<string, string> = {}): HttpAnswer => ({ status: 200, headers: { ...RATE, ...extra }, body });
const notModified: HttpAnswer = { status: 304, headers: RATE, body: null };
/** 304 when the request carries the ETag, otherwise the body. */
const conditional = (etag: string, body: unknown) => (h: Record<string, string>): HttpAnswer => (h['if-none-match'] === etag ? notModified : ok(body, { etag }));

const NOW = Date.parse('2026-10-14T14:02:40Z');
const backend = (http: Http, token = async () => 'tok') => new GitHubBackend({ repo: REPO, pollMs: 5000, http, token, now: () => NOW });
const ISSUES = `GET ${API}/repos/${REPO}/issues?`;
const COMMENTS = `GET ${API}/repos/${REPO}/issues/comments?`;

test('304s change nothing; both lists are asked conditionally every round', async () => {
  const s = stub({ [ISSUES]: [conditional('W/"a"', [])], [COMMENTS]: [conditional('W/"c"', [])] });
  const b = backend(s.http);
  const first = await b.poll(null);
  const second = await b.poll(first.cursor);
  assert.deepEqual(second.posts, []);
  assert.equal(s.calls.filter((c) => c.url.includes('/issues?')).at(-1)!.headers['if-none-match'], 'W/"a"');
  assert.equal(s.calls.filter((c) => c.url.includes('/comments?')).at(-1)!.headers['if-none-match'], 'W/"c"');
  assert.equal(second.nextPollMs, 5000);
  assert.equal(s.calls[0]!.headers.authorization, 'Bearer tok');
});

test('a 200 with a new thread and comments: posts with the sender from GitHub and the header read', async () => {
  const s = stub({
    [ISSUES]: [ok([issue(1, `${header(['@me'])}Hello`, '2026-10-14T14:02:41Z', 'alice', '2026-10-14T14:02:50Z'), { ...issue(9, 'a PR', '2026-10-14T14:02:41Z'), pull_request: {} }])],
    [COMMENTS]: [ok([comment(6170187136, 1, 'typed by hand, says it is from bob', '2026-10-14T14:02:46Z'), comment(6170187137, 1, `${header(['@alice'], 'Q')}Reply`, '2026-10-14T14:02:50Z', 'me')])],
  });
  const r = await backend(s.http).poll(null);
  assert.deepEqual(r.posts.map((p) => [p.postId, p.threadId, p.author.id, p.viaLedung, p.to, p.text]), [
    ['issue:1', '1', 'alice', true, ['@me'], 'Hello'],
    ['comment:6170187136', '1', 'alice', false, [], 'typed by hand, says it is from bob'],
    ['comment:6170187137', '1', 'me', true, ['@alice'], 'Reply'],
  ]);
  assert.equal(r.posts[0]!.title, 'Thread 1');
  assert.equal(JSON.parse(r.cursor).since, '2026-10-14T14:02:50Z');
});

test('the cursor survives a restart: the next poll asks from it, with an overlap the core de-duplicates', async () => {
  const s = stub({ [ISSUES]: [ok([])], [COMMENTS]: [ok([])] });
  await backend(s.http).poll(JSON.stringify({ since: '2026-10-14T14:02:50Z' }));
  assert.match(s.calls[0]!.url, /since=2026-10-14T14%3A01%3A50Z/);

  // In the core: the same post seen twice (overlapping "since") is delivered once.
  const settings = new BoardStore(openDatabase(':memory:'));
  settings.setProjectSetting('D', { enabled: true, repo: REPO, allow: ['alice'], channels: [] });
  settings.setFrontDesk(REPO, 'D');
  const config = parseConfig({ board: {} }).board!;
  const inbox: string[] = [];
  const answer = ok([issue(1, `${header(['@me'])}Hello`, '2026-10-14T14:02:41Z')]);
  // Lists first: a route is matched by the start of the URL.
  const s2 = stub({ [ISSUES]: [answer], [COMMENTS]: [ok([])], [`GET ${API}/user`]: [ok({ login: 'me' })], [`GET ${API}/repos/${REPO}`]: [ok({})] });
  const mk = () => new Board({
    repo: REPO, store: settings.repo(REPO), settings, backend: backend(s2.http), config, userName: 'Sam', projectNames: () => ['D'], manager: async () => 'm', inbox: (_i, _s, t) => void inbox.push(t),
    wake: async () => {}, sensitive: () => ({ commandPatterns: [], pathPatterns: [] }), askUser: () => 1, publish: () => {}, setTimer: () => () => {},
  });
  await mk().pollOnce();
  // A new Ledung (a restart) with the same database: the stored cursor, and the same post again.
  await mk().pollOnce();
  assert.equal(inbox.length, 1);
});

test('a reply shows in the comments list while the issues list is still unchanged: found at once', async () => {
  const s = stub({
    [ISSUES]: [conditional('W/"a"', [])],
    [COMMENTS]: [conditional('W/"c0"', []), ok([comment(77, 4, 'quick reply', '2026-10-14T14:02:45Z')], { etag: 'W/"c1"' })],
  });
  const b = backend(s.http);
  const first = await b.poll(null);
  const second = await b.poll(first.cursor);
  assert.deepEqual(second.posts.map((p) => [p.postId, p.threadId, p.text]), [['comment:77', '4', 'quick reply']]);
});

test('pages are followed by Link rel="next"', async () => {
  const next = `${API}/repositories/1419036382/issues?state=all&per_page=1&after=Y3Vyc29y&page=2`;
  const s = stub({
    [`GET ${next}`]: [ok([issue(2, 'second', '2026-10-14T14:03:00Z')])],
    [ISSUES]: [ok([issue(1, 'first', '2026-10-14T14:02:41Z')], { link: `<${next}>; rel="next"` })],
    [COMMENTS]: [ok([])],
  });
  const r = await backend(s.http).poll(null);
  assert.deepEqual(r.posts.map((p) => p.postId), ['issue:1', 'issue:2']);
});

test('a short budget slows polling to 15 s', async () => {
  const low = { ...RATE, 'x-ratelimit-remaining': '900' };
  const s = stub({ [ISSUES]: [{ status: 200, headers: { ...low, etag: 'W/"b"' }, body: [] }, { status: 304, headers: low, body: null }], [COMMENTS]: [{ status: 200, headers: low, body: [] }] });
  const b = backend(s.http);
  assert.equal((await b.poll(null)).nextPollMs, 15000);
  // A 304 carries the budget too.
  assert.equal((await b.poll(null)).nextPollMs, 15000);
});

test('rate limits, server errors, network errors, no access and a lost sign-in become the right errors', async () => {
  const cases: [HttpAnswer | Error, string, number | null][] = [
    [{ status: 429, headers: { 'retry-after': '42' }, body: { message: 'slow down' } }, 'limited', 42000],
    [{ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 120) }, body: { message: 'API rate limit exceeded' } }, 'limited', 120000],
    [{ status: 403, headers: { 'retry-after': '60' }, body: { message: 'You have exceeded a secondary rate limit' } }, 'limited', 60000],
    [{ status: 502, headers: {}, body: { message: 'Server Error' } }, 'unreachable', null],
    [new Error('getaddrinfo ENOTFOUND api.github.com'), 'unreachable', null],
    [{ status: 404, headers: {}, body: { message: 'Not Found' } }, 'access', null],
    [{ status: 401, headers: {}, body: { message: 'Bad credentials' } }, 'signin', null],
  ];
  for (const [answer, kind, ms] of cases) {
    const http: Http = async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    };
    await assert.rejects(backend(http).poll(null), (e: unknown) => {
      assert.ok(e instanceof BoardError);
      assert.equal(e.kind, kind, JSON.stringify(answer));
      assert.equal(e.retryAfterMs, ms);
      return true;
    });
  }
});

test('no gh login: the board is off with the sign-in sentence', async () => {
  const { BoardError: E } = await import('../src/board/types.ts');
  const b = backend(async () => ok({}), async () => {
    throw new E('signin', 'Board off: sign in with `gh auth login`.');
  });
  await assert.rejects(b.identity(), /sign in with `gh auth login`/);
});

test('identity is the gh login, and a missing repo shows at once', async () => {
  const s = stub({ [`GET ${API}/user`]: [ok({ login: 'FFBuddha', name: 'Buddha' })], [`GET ${API}/repos/${REPO}`]: [ok({ private: true })] });
  assert.deepEqual(await backend(s.http).identity(), { id: 'FFBuddha', display: 'Buddha' });
  const missing = stub({ [`GET ${API}/user`]: [ok({ login: 'FFBuddha' })], [`GET ${API}/repos/${REPO}`]: [{ status: 404, headers: {}, body: { message: 'Not Found' } }] });
  await assert.rejects(backend(missing.http).identity(), /The board org\/board is missing, or the GitHub login has no access to it/);
});

test('sending: a new thread is an issue with the header and to: labels; a reply is a comment', async () => {
  const s = stub({
    [`POST ${API}/repos/${REPO}/issues/7/comments`]: [{ status: 201, headers: RATE, body: comment(55, 7, 'x', '2026-10-14T14:05:00Z', 'me') }],
    [`POST ${API}/repos/${REPO}/issues`]: [{ status: 201, headers: RATE, body: issue(7, 'x', '2026-10-14T14:04:00Z', 'me') }],
  });
  const b = backend(s.http);
  assert.deepEqual(await b.send({ threadId: null, title: 'Release?', to: ['@Alice/Q', '#ops'], fromProject: 'P', text: 'Ready?' }),
    { postId: 'issue:7', threadId: '7', at: Date.parse('2026-10-14T14:04:00Z') });
  const body = s.calls[0]!.body as { title: string; body: string; labels: string[] };
  assert.equal(body.title, 'Release?');
  assert.deepEqual(body.labels, ['to:alice']);
  assert.match(body.body, /^<!-- ledung \{"v":1,"to":\["@Alice\/Q","#ops"\],"from":"P"\} -->\nReady\?$/);
  assert.equal((await b.send({ threadId: '7', to: ['@alice'], fromProject: 'P', text: 'more' })).postId, 'comment:55');
});

test('people: collaborators with names and pictures; without write access, the organisation; else none', async () => {
  const s = stub({
    [`GET ${API}/repos/${REPO}/collaborators`]: [ok([user('alice'), user('me')])],
    [`GET ${API}/users/alice`]: [ok({ login: 'alice', name: 'Alice A' })],
    [`GET ${API}/users/me`]: [ok({ login: 'me', name: null })],
  });
  assert.deepEqual(await backend(s.http).people(), {
    source: 'collaborators', note: null,
    people: [{ id: 'alice', name: 'Alice A', avatarUrl: user('alice').avatar_url }, { id: 'me', name: null, avatarUrl: user('me').avatar_url }],
  });
  const forbidden: HttpAnswer = { status: 403, headers: {}, body: { message: 'Must have push access to view repository collaborators.' } };
  const s2 = stub({ [`GET ${API}/repos/${REPO}/collaborators`]: [forbidden], [`GET ${API}/orgs/org/members`]: [ok([user('bob')])], [`GET ${API}/users/bob`]: [ok({ name: 'Bob' })] });
  const members = await backend(s2.http).people();
  assert.equal(members.source, 'members');
  assert.match(members.note!, /needs write access/);
  const s3 = stub({ [`GET ${API}/repos/${REPO}/collaborators`]: [forbidden], [`GET ${API}/orgs/org/members`]: [{ status: 404, headers: {}, body: {} }] });
  assert.equal((await backend(s3.http).people()).source, 'none');
});

test('reading an old thread: its body and the last comments', async () => {
  const s = stub({
    [`GET ${API}/repos/${REPO}/issues/3/comments`]: [ok([comment(1, 3, 'c1', '2026-10-14T14:00:01Z'), comment(2, 3, 'c2', '2026-10-14T14:00:02Z')])],
    [`GET ${API}/repos/${REPO}/issues/3`]: [ok({ ...issue(3, `${header(['@me'])}first`, '2026-10-14T14:00:00Z'), comments: 2 })],
  });
  const t = await backend(s.http).readThread('3', 2);
  assert.equal(t.title, 'Thread 3');
  assert.deepEqual(t.posts.map((p) => p.text), ['c1', 'c2']);
});
