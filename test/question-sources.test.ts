// Sources a question attaches (issue #369): a session's reply, a PR or review comment, or an earlier question,
// fetched by Ledung when it is asked and kept word for word; one that can't be had doesn't stop the question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { parseConfig } from '../src/config.ts';
import type { Management } from '../src/sessions/management.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { LEDUNG_SERVER } from '../src/sessions/tools.ts';
import { parseCommentLink, replyTime, SOURCE_CHARS } from '../src/sessions/sources.ts';
import type { GhAnswer } from '../src/sessions/pr-poll.ts';
import type { AttachedSource, QuestionInfo } from '../src/shared/protocol.ts';
import { conversationFromHash, messageFromHash, messageHash } from '../web/src/conversation.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

type Gh = (args: string[]) => GhAnswer;

/** Two projects, "p" and the nearly air-gapped "b", with managers and sessions made live on demand. */
function setup() {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    userName: 'Simon',
    projects: [
      { name: 'p', runner: 'local', path: '/tmp/ledung-test-p' },
      { name: 'b', runner: 'local', path: '/tmp/ledung-test-b', lockdown: { level: 'B' } },
    ],
  }), store, () => {}));
  const management = (manager as unknown as { management: Management }).management;
  /** Every `gh api` call a session's runner was asked to make. */
  const calls: string[][] = [];
  const make = (id: string, role: 'session' | 'manager', parentId: string | null, opts: { project?: string; gh?: Gh } = {}) => {
    const info = store.createSession({ id, project: opts.project ?? 'p', runner: 'local', title: `title-${id}`, parentId, permissionMode: 'default', role });
    const ghApi = async (args: string[]) => {
      calls.push(args);
      return opts.gh ? opts.gh(args) : { ok: false as const, stdout: '', error: 'no gh in this test' };
    };
    return new Session({
      info, store, publish: () => {}, userName: 'Simon', management,
      runner: { cwd: '.', currentBranch: async () => null, ghApi } as never,
      gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    });
  };
  return { db, store, make, calls };
}

/** ask_user as the session's own tool server runs it. */
async function askUser(session: Session) {
  const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  const tool = (options.mcpServers![LEDUNG_SERVER] as unknown as {
    instance: { _registeredTools: Record<string, { description: string; handler(a: unknown, extra: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> }> };
  }).instance._registeredTools.ask_user!;
  return { description: tool.description, call: (args: Record<string, unknown>) => tool.handler(args, {}) };
}

const reply = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
/** The question asked last: the highest number. */
const newest = (store: Store): QuestionInfo => store.listQuestions().reduce((a, b) => (b.id > a.id ? b : a));
const ok = (s: AttachedSource) => { assert.ok(!('error' in s), `fetched, not failed: ${JSON.stringify(s)}`); return s; };

test("a session's reply is attached word for word, kept as it was when asked, and the earlier-conversation box is left out", async () => {
  const { db, store, make } = setup();
  const mgr = make('mgr', 'manager', null);
  make('w', 'session', 'mgr');
  // A worker report of twelve review points, longer than the 600 characters a manager's turn note carries.
  const points = Array.from({ length: 12 }, (_, i) => `${i + 1}. Review point ${i + 1}: ${'detail '.repeat(10).trim()}`).join('\n');
  const report = `DONE cart-vat · PR #212\nReview points from the reviewer:\n${points}`;
  assert.ok(report.length > 600);
  store.addMessage('w', 'sdk', reply('Starting on the cart.'), 1000);
  const said = store.addMessage('w', 'sdk', reply(report), 2000);
  store.addMessage('w', 'sdk', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }, 2500);
  // A subagent's words after the report are not the session's reply (test review of PR #378, finding 4).
  store.addMessage('w', 'sdk', { ...reply('a subagent talking'), parent_tool_use_id: 'x' }, 2600);
  store.addMessage('mgr', 'sdk', reply('The worker reported 12 points.'), 3000);

  const ask = await askUser(mgr);
  assert.match(ask.description, /attach it with sources: Ledung fetches it itself and shows it word for word on the question page, so you need not copy it into issue or evidence/);
  const res = await ask.call({ issue: 'Point 12 of the attached report: VAT per rate on the confirmation too?', tier: 'Process', sources: [{ reply: 'title-w' }] });
  assert.equal(res.isError, undefined, res.content[0]!.text);
  assert.match(res.content[0]!.text, /^Question #\d+ with 1 attached source is recorded/);
  const asked = newest(store);
  const expected = [{ kind: 'reply', named: 'title-w', sessionId: 'w', messageId: said.id, at: 2000, text: report }];
  assert.deepEqual(asked.sources, expected);
  assert.equal(asked.earlier, null, 'with a source attached the earlier-conversation box is left out');

  // The conversation is pruned and goes on: the question still shows the reply as it was.
  db.prepare(`DELETE FROM messages WHERE session_id = 'w'`).run();
  store.addMessage('w', 'sdk', reply('Something else entirely.'), 4000);
  assert.deepEqual(store.getQuestion(asked.id)!.sources, expected);
  assert.deepEqual(store.listQuestions().find((q) => q.id === asked.id)!.sources, expected);
  assert.equal(store.listQuestions(500, false).find((q) => q.id === asked.id)!.sources, null, "Ledung's own reads leave it out");
});

test("a reply by its time is the one the conversation shows at that minute or second, and the asker's own replies count", async () => {
  const { store, make } = setup();
  const mgr = make('mgr', 'manager', null);
  make('w', 'session', 'mgr');
  const at = (h: number, m: number, s: number) => new Date(2026, 9, 28, h, m, s).getTime();
  store.addMessage('w', 'sdk', reply('the 14:04 one'), at(14, 4, 50));
  const first = store.addMessage('w', 'sdk', reply('the first at 14:05'), at(14, 5, 10));
  const second = store.addMessage('w', 'sdk', reply('the second at 14:05'), at(14, 5, 40));
  store.addMessage('w', 'sdk', reply('the last reply'), at(14, 30, 0));
  const own = store.addMessage('mgr', 'sdk', reply('my own summary'), at(14, 31, 0));
  const ask = await askUser(mgr);
  await ask.call({
    question: 'Which one?', tier: 'Process',
    sources: [{ reply: 'w', at: '2026-10-28 14:05' }, { reply: 'w', at: '2026-10-28 14:05:10' }, { reply: 'title-mgr' }],
  });
  const [minute, second_, self] = newest(store).sources!.map(ok) as Extract<AttachedSource, { kind: 'reply' }>[];
  assert.deepEqual([minute!.messageId, minute!.text], [second.id, 'the second at 14:05'], 'a minute names its latest reply');
  assert.deepEqual([second_!.messageId, second_!.text], [first.id, 'the first at 14:05']);
  assert.deepEqual([self!.sessionId, self!.messageId, self!.text], ['mgr', own.id, 'my own summary']);
  assert.deepEqual(replyTime('14:05', at(9, 0, 0)), { from: at(14, 5, 0), to: at(14, 6, 0) }, '"14:05" is that minute today');
  assert.equal(replyTime('25:00', at(9, 0, 0)), null);
  assert.equal(replyTime('yesterday', at(9, 0, 0)), null);
});

test("a reply from another manager's session, or one that isn't there, is refused: the question is asked without it and says why", async () => {
  const { store, make } = setup();
  const mgr = make('mgr', 'manager', null);
  make('other', 'manager', null);
  make('theirs', 'session', 'other');
  store.addMessage('theirs', 'sdk', reply('SECRET from another manager'), 1000);
  store.addMessage('other', 'sdk', reply('SECRET of the other manager itself'), 1000);
  store.addMessage('mgr', 'sdk', reply('Asking about theirs.'), 2000);
  const ask = await askUser(mgr);
  const res = await ask.call({ question: 'About theirs', tier: 'Process', sources: [{ reply: 'theirs' }, { reply: 'title-theirs' }, { reply: 'other' }, { reply: 'nobody' }] });
  assert.equal(res.isError, undefined);
  const text = res.content[0]!.text;
  assert.match(text, /^Question #\d+ is recorded and has gone to Simon\. 4 sources could not be attached, and the question says so: source 1 \(theirs\): "theirs" is not this session or one of its sessions/);
  const sources = newest(store).sources!;
  assert.deepEqual(sources.map((s) => 'error' in s && s.error), [
    '"theirs" is not this session or one of its sessions, so its replies can\'t be attached.',
    '"title-theirs" is not this session or one of its sessions, so its replies can\'t be attached.',
    '"other" is not this session or one of its sessions, so its replies can\'t be attached.',
    '"nobody" is not this session or one of its sessions, so its replies can\'t be attached.',
  ], "one that exists and one that doesn't get the same answer");
  assert.ok(!JSON.stringify(sources).includes('SECRET'), 'nothing of theirs is stored');
  assert.deepEqual(newest(store).earlier, [{ at: 2000, kind: 'reply', text: 'Asking about theirs.' }], 'nothing was attached, so the earlier-conversation box stays');
});

test('a PR comment, a review comment and a review are fetched once through the asker\'s own runner and kept as fetched', async () => {
  const bodies: Record<string, object> = {
    'repos/Fluffy-Fluffy-and-Bouncy/ledung/issues/comments/111': {
      body: 'Decision — Martin 11:05: "a — Merge and release"', user: { login: 'Magto' }, created_at: '2026-10-28T10:15:40Z',
      html_url: 'https://github.com/Fluffy-Fluffy-and-Bouncy/ledung/pull/373#issuecomment-111', issue_url: 'https://api.github.com/repos/Fluffy-Fluffy-and-Bouncy/ledung/issues/373',
    },
    'repos/o/r/pulls/comments/222': {
      body: 'This check can never fail.', user: { login: 'reviewer' }, created_at: '2026-10-28T09:56:00Z', path: 'test/a.test.ts', line: 12,
      html_url: 'https://github.com/o/r/pull/5#discussion_r222', pull_request_url: 'https://api.github.com/repos/o/r/pulls/5',
    },
    'repos/o/r/pulls/5/reviews/333': {
      body: '## Test review\nVerdict: Approved', user: { login: 'reviewer' }, submitted_at: '2026-10-28T09:57:00Z',
      html_url: 'https://github.com/o/r/pull/5#pullrequestreview-333', pull_request_url: 'https://api.github.com/repos/o/r/pulls/5',
    },
  };
  const { store, make, calls } = setup();
  const mgr = make('mgr', 'manager', null, { gh: (args) => ({ ok: true, stdout: JSON.stringify(bodies[args[0]!]) }) });
  const ask = await askUser(mgr);
  await ask.call({
    question: 'See the attached reviews.', tier: 'Process',
    sources: [
      { comment: 'https://github.com/Fluffy-Fluffy-and-Bouncy/ledung/pull/373#issuecomment-111' },
      { comment: 'https://github.com/o/r/pull/5/files#discussion_r222' },
      { comment: 'https://github.com/o/r/pull/5#pullrequestreview-333' },
    ],
  });
  assert.deepEqual(calls, Object.keys(bodies).map((path) => [path]), 'one gh api call each, through the asker\'s runner');
  const expected = [
    {
      kind: 'comment', named: 'https://github.com/Fluffy-Fluffy-and-Bouncy/ledung/pull/373#issuecomment-111', url: 'https://github.com/Fluffy-Fluffy-and-Bouncy/ledung/pull/373#issuecomment-111',
      what: 'comment', repo: 'Fluffy-Fluffy-and-Bouncy/ledung', number: 373, author: 'Magto', at: '2026-10-28T10:15:40Z', text: 'Decision — Martin 11:05: "a — Merge and release"',
    },
    {
      kind: 'comment', named: 'https://github.com/o/r/pull/5/files#discussion_r222', url: 'https://github.com/o/r/pull/5#discussion_r222',
      what: 'review comment', repo: 'o/r', number: 5, author: 'reviewer', at: '2026-10-28T09:56:00Z', text: 'This check can never fail.', path: 'test/a.test.ts', line: 12,
    },
    {
      kind: 'comment', named: 'https://github.com/o/r/pull/5#pullrequestreview-333', url: 'https://github.com/o/r/pull/5#pullrequestreview-333',
      what: 'review', repo: 'o/r', number: 5, author: 'reviewer', at: '2026-10-28T09:57:00Z', text: '## Test review\nVerdict: Approved',
    },
  ];
  const asked = newest(store);
  assert.deepEqual(asked.sources, expected);
  // Read again later (the comment may have been edited on GitHub since): what was fetched, and no new call.
  bodies['repos/o/r/pulls/comments/222'] = { body: 'edited later' };
  assert.deepEqual(store.getQuestion(asked.id)!.sources, expected);
  assert.equal(calls.length, 3);
});

test("a comment GitHub doesn't give, a link that isn't one, or one from a nearly air-gapped project doesn't stop the question", async () => {
  const { store, make, calls } = setup();
  const mgr = make('mgr', 'manager', null, { gh: () => ({ ok: false, stdout: '{"message":"Not Found","status":"404"}', error: 'gh: Not Found (HTTP 404)' }) });
  const ask = await askUser(mgr);
  const res = await ask.call({ question: 'Still asked?', tier: 'Process', sources: [{ comment: 'https://github.com/o/r/pull/5#issuecomment-9' }, { comment: 'https://example.com/o/r/pull/5#issuecomment-9' }] });
  assert.equal(res.isError, undefined);
  assert.match(res.content[0]!.text, /2 sources could not be attached, and the question says so: source 1 \(https:\/\/github\.com\/o\/r\/pull\/5#issuecomment-9\): GitHub did not give it: Not Found; source 2 \(https:\/\/example\.com\/o\/r\/pull\/5#issuecomment-9\): not a GitHub comment link/);
  assert.deepEqual(newest(store).sources!.map((s) => [s.kind, 'error' in s ? s.error.slice(0, 26) : 'fetched']), [['comment', 'GitHub did not give it: No'], ['comment', 'not a GitHub comment link:']]);
  assert.equal(newest(store).status, 'open');

  calls.length = 0;
  const island = make('mgr-b', 'manager', null, { project: 'b', gh: () => { throw new Error('must not be called'); } });
  await (await askUser(island)).call({ question: 'From the island', tier: 'Process', sources: [{ comment: 'https://github.com/o/r/pull/5#issuecomment-9' }] });
  assert.deepEqual(newest(store).sources, [{
    kind: 'comment', named: 'https://github.com/o/r/pull/5#issuecomment-9',
    error: 'the project "b" is in lockdown level B (nearly air-gapped), so Ledung fetches nothing from GitHub for it.',
  }]);
  assert.equal(calls.length, 0, 'no GitHub call for a level B project');
});

test("an earlier question is attached with its answer; another manager's question is refused", async () => {
  const { store, make } = setup();
  const mgr = make('mgr', 'manager', null);
  make('w', 'session', 'mgr');
  make('other', 'manager', null);
  const details = { tier: 'Process', title: 'VAT per rate?', issue: 'Books and toys in one cart.' };
  const fromWorker = store.createQuestion({ sessionId: 'w', question: 'VAT per rate?', options: null, addressedTo: 'mgr', details });
  store.answerQuestion(fromWorker.id, 'a — per rate everywhere', 'user');
  const mine = store.createQuestion({ sessionId: 'mgr', question: 'Mine, still open', options: null, addressedTo: 'user', details: { tier: 'Process' } });
  const theirs = store.createQuestion({ sessionId: 'other', question: 'SECRET of another manager', options: null, addressedTo: 'user', details: { tier: 'Process' } });
  // Each allowing clause on its own (test review of PR #378, finding 2): its session's question that went straight
  // to Simon, and a question that went to it from a session it did not start.
  const workerToUser = store.createQuestion({ sessionId: 'w', question: 'Straight to Simon', options: null, addressedTo: 'user', details: { tier: 'Process' } });
  make('stray', 'session', null);
  const toMe = store.createQuestion({ sessionId: 'stray', question: 'Went to the manager', options: null, addressedTo: 'mgr', details: { tier: 'Process' } });
  const answered = store.getQuestion(fromWorker.id)!;

  const ask = await askUser(mgr);
  await ask.call({ question: 'Either clause alone.', tier: 'Process', sources: [{ question: workerToUser.id }, { question: toMe.id }] });
  assert.deepEqual(newest(store).sources!.map((x) => (ok(x) as Extract<AttachedSource, { kind: 'question' }>).question.id), [workerToUser.id, toMe.id]);

  await ask.call({ question: 'As decided before.', tier: 'Process', sources: [{ question: fromWorker.id }, { question: mine.id }, { question: theirs.id }, { question: 999 }] });
  const asked = newest(store);
  const sources = asked.sources!;
  assert.deepEqual(sources[0], {
    kind: 'question', named: `#${fromWorker.id}`,
    question: {
      id: fromWorker.id, sessionId: 'w', askedAt: fromWorker.askedAt, question: 'VAT per rate?', options: null, details, status: 'answered',
      answer: 'a — per rate everywhere', answeredAt: answered.answeredAt, answeredBy: 'user',
    },
  });
  assert.equal((ok(sources[1]!) as Extract<AttachedSource, { kind: 'question' }>).question.status, 'open', 'its own, still open');
  assert.deepEqual(sources.slice(2), [
    { kind: 'question', named: `#${theirs.id}`, error: `question #${theirs.id} is not from this session or one of its sessions, nor went to it.` },
    { kind: 'question', named: '#999', error: 'question #999 is not from this session or one of its sessions, nor went to it.' },
  ]);
  assert.ok(!JSON.stringify(sources).includes('SECRET'));

  // Answered later (test review of PR #378, finding 1): the question still shows its copy as attached, open.
  store.answerQuestion(mine.id, 'b — later', 'user');
  const later = store.getQuestion(asked.id)!.sources![1] as Extract<AttachedSource, { kind: 'question' }>;
  assert.deepEqual([later.question.status, later.question.answer], ['open', null]);
  assert.deepEqual(store.getQuestion(asked.id)!.sources, sources);
});

test("only github.com is fetched: a lookalike or any other host gets no call; GitHub's answer must name the link's PR (code review of PR #378)", async () => {
  // Finding 1: a session chooses the link, so a host other than github.com would let it reach a server of its choosing.
  for (const url of [
    'https://evil-github.attacker.example/o/r/pull/1#issuecomment-5',
    'https://github.com.attacker.example/o/r/pull/1#issuecomment-5',
    'https://github.example.com/o/r/pull/1#issuecomment-5',
    'https://api.github.com/o/r/pull/1#issuecomment-5',
    'https://GITHUB.COM@evil.example/o/r/pull/1#issuecomment-5',
  ]) assert.equal(parseCommentLink(url), null, url);
  // Finding 2: owner and name as GitHub allows them, so nothing else reaches the API path.
  assert.equal(parseCommentLink('https://github.com/o/r?per_page=1&x=/pull/1#issuecomment-5'), null);
  assert.equal(parseCommentLink('https://github.com/../r/pull/1#issuecomment-5'), null);
  assert.equal(parseCommentLink('https://github.com/o/../pull/1#issuecomment-5'), null);
  assert.deepEqual(parseCommentLink('https://github.com/Fluffy-Fluffy-and-Bouncy/Project.Ledung_2/pull/1#issuecomment-5')?.name, 'Project.Ledung_2');

  const answers: Record<string, object> = {
    // On another pull request than the link says.
    'repos/o/r/issues/comments/7': { body: 'from PR 9', user: { login: 'x' }, issue_url: 'https://api.github.com/repos/o/r/issues/9' },
    // An answer that names no pull request at all.
    'repos/o/r/pulls/comments/8': { body: 'nowhere', user: { login: 'x' } },
    // A real one whose html_url is not a github.com link: the link as given is kept.
    'repos/o/r/issues/comments/6': { body: 'fine', user: { login: 'x' }, issue_url: 'https://api.github.com/repos/o/r/issues/5', html_url: 'javascript:alert(1)' },
  };
  const { store, make, calls } = setup();
  const mgr = make('mgr', 'manager', null, { gh: (args) => ({ ok: true, stdout: JSON.stringify(answers[args[0]!]) }) });
  await (await askUser(mgr)).call({
    question: 'Lookalikes', tier: 'Process',
    sources: [
      { comment: 'https://evil-github.attacker.example/secret/r/pull/1#issuecomment-5' },
      { comment: 'https://github.com/o/r/pull/5#issuecomment-7' },
      { comment: 'https://github.com/o/r/pull/5#discussion_r8' },
      { comment: 'https://github.com/o/r/pull/5#issuecomment-6' },
    ],
  });
  assert.deepEqual(calls, [['repos/o/r/issues/comments/7'], ['repos/o/r/pulls/comments/8'], ['repos/o/r/issues/comments/6']], 'no call for the lookalike, and never --hostname');
  const sources = newest(store).sources!;
  assert.deepEqual(sources.slice(0, 3).map((x) => 'error' in x ? x.error.slice(0, 32) : 'fetched'), [
    'not a GitHub comment link: give ', 'that comment is not on #5.', 'that comment is not on #5.',
  ]);
  assert.equal((ok(sources[3]!) as Extract<AttachedSource, { kind: 'comment' }>).url, 'https://github.com/o/r/pull/5#issuecomment-6');
});

test('a long source is cut with a mark; a GitHub link names a comment, a review comment or a review, nothing else', () => {
  assert.deepEqual(parseCommentLink('https://github.com/o/r/pull/12#issuecomment-345'), { owner: 'o', name: 'r', number: 12, what: 'comment', id: 345 });
  assert.deepEqual(parseCommentLink('https://github.com/o/r/issues/7#issuecomment-1'), { owner: 'o', name: 'r', number: 7, what: 'comment', id: 1 });
  assert.deepEqual(parseCommentLink('https://github.com/o/r/pull/12#discussion_r99'), { owner: 'o', name: 'r', number: 12, what: 'review comment', id: 99 });
  assert.deepEqual(parseCommentLink('https://github.com/o/r/pull/12#pullrequestreview-5'), { owner: 'o', name: 'r', number: 12, what: 'review', id: 5 });
  assert.equal(parseCommentLink('https://github.com/o/r/issues/7#pullrequestreview-5'), null, 'an issue has no reviews');
  assert.equal(parseCommentLink('https://github.com/o/r/pull/12'), null, 'a PR, not a comment');
  assert.equal(parseCommentLink('https://evil.example/o/r/pull/12#issuecomment-1'), null);
  assert.equal(parseCommentLink('http://github.com/o/r/pull/12#issuecomment-1'), null);
});

test('a reply longer than the limit is kept up to it and marked cut', async () => {
  const { store, make } = setup();
  const mgr = make('mgr', 'manager', null);
  const long = 'x'.repeat(SOURCE_CHARS + 10);
  store.addMessage('mgr', 'sdk', reply(long), 1000);
  await (await askUser(mgr)).call({ question: 'Long', tier: 'Process', sources: [{ reply: 'mgr' }] });
  const s = ok(newest(store).sources![0]!) as Extract<AttachedSource, { kind: 'reply' }>;
  assert.deepEqual([s.text.length, s.cut], [SOURCE_CHARS, true]);
});

test("a worker's sources reach the user through its manager: said in the note, shown in the original, kept in a copy (decision a on PR #378's review)", async () => {
  const { store, make } = setup();
  const mgr = make('mgr', 'manager', null);
  const w = make('w', 'session', 'mgr');
  const said = store.addMessage('w', 'sdk', reply('DONE cart-vat · 12 review points'), 1000);
  const earlier = store.createQuestion({ sessionId: 'w', question: 'Older one', options: null, addressedTo: 'mgr', details: { tier: 'Process' } });
  await (await askUser(w)).call({ question: 'Point 12?', tier: 'Process', sources: [{ reply: 'w' }, { question: earlier.id }] });
  const fromWorker = newest(store);
  const workerSources = fromWorker.sources!;
  assert.equal(workerSources.length, 2);

  // The manager's note says sources are attached and that the original box will show them.
  const note = store.undeliveredInbox('mgr').map((i) => i.text).find((t) => t.includes(`asked question #${fromWorker.id}`))!;
  assert.match(note, new RegExp(`It attached 2 sources \\(a reply of [^;]+; question #${earlier.id}\\)\\. When you ask with about_question: ${fromWorker.id}, Simon sees them word for word in its "Original question" box`));

  // Forwarded with about_question: the original carries them, as stored.
  const ask = await askUser(mgr);
  await ask.call({ question: 'Point 12, see the original.', tier: 'Process', about_question: fromWorker.id });
  const forwarded = newest(store);
  assert.deepEqual(forwarded.original!.sources, workerSources);
  assert.equal((forwarded.original!.sources![0] as Extract<AttachedSource, { kind: 'reply' }>).messageId, said.id);

  // Attached as an earlier question: the copy carries them too, a question among them without its own.
  await ask.call({ question: 'As in that one.', tier: 'Process', sources: [{ question: fromWorker.id }] });
  const copy = (ok(newest(store).sources![0]!) as Extract<AttachedSource, { kind: 'question' }>).question;
  assert.deepEqual(copy.sources![0], workerSources[0]);
  const nested = copy.sources![1] as Extract<AttachedSource, { kind: 'question' }>;
  assert.deepEqual([nested.question.id, nested.question.sources], [earlier.id, null]);
});

test("an attached reply's link opens its session's conversation at that message", () => {
  assert.equal(messageHash('abc-1', 42), '#/s/abc-1/m/42');
  assert.deepEqual(messageFromHash('#/s/abc-1/m/42'), { sessionId: 'abc-1', messageId: 42 });
  assert.equal(messageFromHash('#/s/abc-1/q/42'), null);
  assert.equal(conversationFromHash('#/s/abc-1/m/42'), null, 'a message address is not a question address');
});
