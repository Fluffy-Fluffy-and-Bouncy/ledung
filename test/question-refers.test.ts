// What a question refers to (issue #368): the original a manager's question is about comes with it however old
// it is, and the asker's conversation just before it asked is kept as it was then.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { parseConfig } from '../src/config.ts';
import type { Management } from '../src/sessions/management.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { conversationBefore, EARLIER_LINE_CHARS, EARLIER_LINES, EARLIER_TOTAL_CHARS } from '../src/sessions/earlier.ts';
import { CONTEXT_SENTENCE } from '../src/shared/delivery.ts';
import type { StoredMessage } from '../src/shared/protocol.ts';
import type { QuestionDetails } from '../src/shared/questions.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

type Asker = { ask(question: string, options: string[] | null, about: number | null, aboutRequest?: string | null, details?: QuestionDetails | null): { id: number } };

/** A manager and one of its sessions, live, as question-tiers.test.ts sets them up. */
function setup() {
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    userName: 'Simon',
    projects: [{ name: 'p', runner: 'local', path: '/tmp/ledung-test-p' }],
  }), store, () => {}));
  const management = (manager as unknown as { management: Management }).management;
  const make = (id: string, role: 'session' | 'manager', parentId: string | null) => {
    const info = store.createSession({ id, project: 'p', runner: 'local', title: `title-${id}`, parentId, permissionMode: 'default', role });
    return new Session({
      info, store, publish: () => {}, userName: 'Simon', management,
      runner: { cwd: '.', currentBranch: async () => null } as never,
      gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    }) as unknown as Asker;
  };
  return { store, make };
}

const reply = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'assistant', ...extra, message: { content: [{ type: 'text', text }] } });

test("a manager's question comes with the original it is about, even when that one is older than the recent questions the page gets", async () => {
  const { store, make } = setup();
  const mgr = make('mgr', 'manager', null);
  make('w', 'session', 'mgr');
  const details: QuestionDetails = {
    tier: 'Process', title: 'VAT lines when a cart mixes rates', issue: 'A cart with books and toys shows one VAT total.',
    evidence: 'Swedish receipts list VAT per rate.',
    options: [{ key: 'a', text: '**Per rate everywhere**', cost: 'half a day' }, { key: 'b', text: '**One total**', cost: 'none' }],
    opinions: [{ who: 'title-w', pick: 'a', why: 'one component, one rule' }],
  };
  const original = store.createQuestion({ sessionId: 'w', question: 'VAT per rate?', options: null, addressedTo: 'mgr', details });
  // Ask the manager's question while the original is open, then push the original past the 50 the page loads.
  const asked = mgr.ask('Its full question is above.', null, original.id, null, { tier: 'Process' });
  store.answerQuestion(original.id, 'a', 'mgr');
  // The recent ones are the latest answered: the fillers must be answered in a later millisecond than the original.
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 60; i++) {
    const q = store.createQuestion({ sessionId: 'w', question: `filler ${i}`, options: null, addressedTo: 'mgr', details: { tier: 'Process' } });
    store.answerQuestion(q.id, 'ok', 'mgr');
  }
  const list = store.listQuestions();
  assert.ok(!list.some((q) => q.id === original.id), 'the original is outside the recent window');
  const sent = list.find((q) => q.id === asked.id)!;
  assert.deepEqual(sent.original, {
    id: original.id, sessionId: 'w', askedAt: original.askedAt, question: 'VAT per rate?', options: null, details, status: 'answered',
  });
  assert.deepEqual(store.getQuestion(asked.id)!.original, sent.original, 'a single question as published carries it too');
  // Ledung's own reads on every manager Bash call leave it out (review of PR #373, finding 3): asserted on a question
  // that has one, so it fails if they attach it (test review of PR #373, round 2, finding 1).
  assert.equal(store.listQuestions(500, false).find((q) => q.id === asked.id)!.original, null);
  assert.equal(store.getQuestion(original.id)!.original, null, 'a question about nothing has none');
});

test("about_question naming a question that is not from one of the asker's sessions is refused, and such a stored link shows no original", () => {
  const { store, make } = setup();
  const mgr = make('mgr', 'manager', null);
  make('w', 'session', 'mgr');
  make('other', 'session', null);
  // A session outside this manager's (in Ledung, another project's or a locked one's) asks the user directly.
  const foreign = store.createQuestion({ sessionId: 'other', question: 'SECRET other question', options: null, addressedTo: 'user', details: { tier: 'Process' } });
  assert.throws(() => mgr.ask('About that one', null, foreign.id, null, { tier: 'Process' }), /Question #\d+ is not from one of your sessions, so about_question can't name it\. Nothing was asked\./);
  assert.throws(() => mgr.ask('About nothing', null, 999, null, { tier: 'Process' }), /Question #999 is not from one of your sessions/);
  assert.equal(store.listQuestions().length, 1, 'nothing was stored');
  // A link stored before the check (or by any other path) still shows nothing of the foreign question.
  const linked = store.createQuestion({ sessionId: 'mgr', question: 'About that one', options: null, addressedTo: 'user', aboutQuestion: foreign.id, details: { tier: 'Process' } });
  assert.equal(linked.original, null);
  assert.equal(store.getQuestion(linked.id)!.original, null);
  // Its own session's question is still allowed.
  const own = store.createQuestion({ sessionId: 'w', question: 'Mine', options: null, addressedTo: 'mgr', details: { tier: 'Process' } });
  assert.equal(store.getQuestion(mgr.ask('About mine', null, own.id, null, { tier: 'Process' }).id)!.original?.id, own.id);
});

test('the conversation kept with a question is what was there when it asked, not what came later', () => {
  const { store, make } = setup();
  const mgr = make('mgr', 'manager', null);
  const report = 'DONE cart-vat · PR #212\nReview points:\n1. VAT rounding per line\n12. Confirmation e-mail uses the same component';
  store.addMessage('mgr', 'user', { text: 'Start on the cart, please.' }, 1000);
  store.addMessage('mgr', 'sdk', reply('Starting a worker.'), 2000);
  store.addMessage('mgr', 'user', { text: CONTEXT_SENTENCE('Simon'), from: 'ledung', context: report }, 3000);
  store.addMessage('mgr', 'sdk', reply('Points 1–11 are fixed in the PR.'), 4000);
  store.addMessage('mgr', 'sdk', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'gh pr view 212' } }] } }, 4500);
  store.addMessage('mgr', 'sdk', reply('Point 12 needs a call from Simon, so I am asking.'), 5000);
  store.addMessage('mgr', 'sdk', reply('a subagent talking', { parent_tool_use_id: 'x' }), 5500);
  const asked = mgr.ask('Point 12: see the 12 points above.', null, null, null, { tier: 'Process' });
  const expected = [
    { at: 1000, kind: 'user', text: 'Start on the cart, please.' },
    { at: 2000, kind: 'reply', text: 'Starting a worker.' },
    { at: 3000, kind: 'delivered', text: report },
    { at: 4000, kind: 'reply', text: 'Points 1–11 are fixed in the PR.\n\nPoint 12 needs a call from Simon, so I am asking.' },
  ];
  assert.deepEqual(store.getQuestion(asked.id)!.earlier, expected);

  // Later the conversation goes on (and could be cleared or trimmed): the question keeps what it had.
  store.addMessage('mgr', 'sdk', reply('Waiting for the answer.'), 6000);
  store.addMessage('mgr', 'user', { text: 'Something else entirely.' }, 7000);
  assert.deepEqual(store.getQuestion(asked.id)!.earlier, expected);
  assert.deepEqual(store.listQuestions().find((q) => q.id === asked.id)!.earlier, expected);
  // Ledung's own reads on every manager Bash call leave both out (review of PR #373, finding 3).
  const bare = store.listQuestions(500, false).find((q) => q.id === asked.id)!;
  assert.equal(bare.earlier, null);
});

const msg = (id: number, kind: StoredMessage['kind'], data: unknown): StoredMessage => ({ id, sessionId: 's', at: id, kind, data });

test('the kept conversation is the latest messages, a long one cut with a mark, within the limits', () => {
  const many = Array.from({ length: EARLIER_LINES + 3 }, (_, i) => msg(i + 1, 'user', { text: `m${i + 1}` }));
  assert.deepEqual(conversationBefore(many).map((l) => l.text), many.slice(-EARLIER_LINES).map((m) => m.data.text));

  const long = 'x'.repeat(EARLIER_LINE_CHARS + 50);
  const cut = conversationBefore([msg(1, 'user', { text: 'short' }), msg(2, 'user', { text: long })]);
  assert.deepEqual(cut.map((l) => [l.text.length, l.cut ?? false]), [[5, false], [EARLIER_LINE_CHARS, true]]);

  // Three lines at the per-line limit pass the total: the newest are kept whole as far as it goes, the oldest cut.
  const big = [1, 2, 3].map((i) => msg(i, 'user', { text: String(i).repeat(EARLIER_LINE_CHARS) }));
  const fitted = conversationBefore(big);
  assert.equal(fitted.reduce((n, l) => n + l.text.length, 0), EARLIER_TOTAL_CHARS);
  assert.deepEqual(fitted.map((l) => l.cut ?? false), [true, false, false]);
  assert.equal(fitted[0]!.text.length, EARLIER_TOTAL_CHARS - 2 * EARLIER_LINE_CHARS);
});

test('events, permissions and tool calls are not part of it; an empty conversation keeps an empty list', () => {
  assert.deepEqual(conversationBefore([]), []);
  const lines = conversationBefore([
    msg(1, 'event', { text: 'Renamed.' }),
    msg(2, 'permission', {}),
    msg(3, 'sdk', { type: 'result' }),
    msg(4, 'sdk', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }),
  ]);
  assert.deepEqual(lines, []);
});
