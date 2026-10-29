// The Board view in the page (read-only): sender labels, where a post went, the list filters and addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardShown, boardUnreadTotal, deliveryMarks, filterThreads, hasUndelivered, parseThreadOpenId, senderLabel, threadFromHash, threadHash, threadOpenId, unreadIn, NO_FILTERS } from '../web/src/boardView.ts';
import type { BoardPostView, BoardStatus, BoardThreadSummary } from '../src/shared/protocol.ts';

const thread = (over: Partial<BoardThreadSummary> = {}): BoardThreadSummary => ({
  repo: 'org/board', id: '1', title: 'T', participants: [], updatedAt: 1, posts: 1, dropped: 0, unsent: 0, refused: 0, projects: [], unread: {},
  last: null, onlyDropped: false, url: null, ...over,
});
const post = (over: Partial<BoardPostView> = {}): BoardPostView => ({
  id: 'comment:1', author: 'alice', viaLedung: true, fromProject: 'Open', mine: false, recipients: [], text: 'hi', at: 1, deliveries: [], status: 'delivered', url: null, attachments: [], ...over,
});

test('the entry shows only while a project names a board; unread is added up', () => {
  assert.equal(boardShown(null), false);
  assert.equal(boardShown({ configured: false } as BoardStatus), false);
  const b = { configured: true, unread: { A: 2, B: 1 } } as unknown as BoardStatus;
  assert.equal(boardShown(b), true);
  assert.equal(boardUnreadTotal(b), 3);
  assert.equal(boardUnreadTotal(null), 0);
});

test('a sender is labelled by how the service knows it: a Ledung, a person typing, or our own manager', () => {
  assert.equal(senderLabel(post(), 'GitHub'), "@alice's Ledung, project Open");
  assert.equal(senderLabel(post({ fromProject: null }), 'GitHub'), "@alice's Ledung");
  assert.equal(senderLabel(post({ viaLedung: false, fromProject: null }), 'GitHub'), 'typed on GitHub by @alice');
  assert.equal(senderLabel(post({ mine: true, fromProject: 'Desk', author: 'me' }), 'GitHub'), "this Ledung's manager of project Desk");
});

test('where a post went: woke, quiet, channel, not delivered, and why a post reached nobody', () => {
  const marks = deliveryMarks(post({ deliveries: [
    { project: 'A', kind: 'wake', read: true }, { project: 'B', kind: 'quiet', read: false },
    { project: 'C', kind: 'channel', read: false }, { project: 'D', kind: 'ignored', read: true },
  ] }));
  assert.deepEqual(marks.map((m) => [m.level, m.project]), [['ok', 'A'], ['quiet', 'B'], ['quiet', 'C'], ['warn', 'D']]);
  assert.deepEqual(marks.map((m) => m.text.split(' ')[0]), ['woke', 'quiet', 'channel,', 'not']);
  assert.match(marks[3]!.text, /not delivered to D: its allowlist does not name @alice/);
  assert.match(deliveryMarks(post({ status: 'ignored' }))[0]!.text, /not delivered: no project here allows @alice; only the id was kept/);
  assert.match(deliveryMarks(post({ status: 'quiet' }))[0]!.text, /^not delivered: it reached no manager/);
  assert.equal(deliveryMarks(post({ status: 'sent' }))[0]!.text, 'sent from this Ledung');
  assert.equal(deliveryMarks(post({ status: 'other' }))[0]!.text, 'not for this Ledung');
});

test('the filters: project, board, unread only and not delivered, alone and together', () => {
  const all = [
    thread({ id: '1', projects: ['A'], unread: { A: 2 } }),
    thread({ id: '2', projects: ['A', 'B'], unread: { B: 1 } }),
    thread({ id: '3', repo: 'org/other', projects: ['B'], dropped: 1 }),
    thread({ id: '4', projects: [], unsent: 1 }),
  ];
  const ids = (f: Partial<typeof NO_FILTERS>) => filterThreads(all, { ...NO_FILTERS, ...f }).map((t) => t.id);
  assert.deepEqual(ids({}), ['1', '2', '3', '4']);
  assert.deepEqual(ids({ project: 'A' }), ['1', '2']);
  assert.deepEqual(ids({ repo: 'org/other' }), ['3']);
  assert.deepEqual(ids({ unreadOnly: true }), ['1', '2']);
  assert.deepEqual(ids({ unreadOnly: true, project: 'A' }), ['1'], 'unread for that project, not in general');
  assert.deepEqual(ids({ notDelivered: true }), ['3', '4']);
  assert.deepEqual(ids({ notDelivered: true, project: 'B' }), ['3']);
  assert.equal(hasUndelivered(thread({ refused: 1 })), true);
  assert.equal(unreadIn(all[1]!), 1);
  assert.equal(unreadIn(all[1]!, 'A'), 0);
});

test('a thread has an address of its own, and a hash that is not one is refused', () => {
  assert.equal(threadOpenId('org/board', '12'), 'bt:org/board#12');
  assert.deepEqual(parseThreadOpenId('bt:org/board#12'), { repo: 'org/board', id: '12' });
  assert.equal(parseThreadOpenId('settings'), null);
  assert.equal(parseThreadOpenId(null), null);
  assert.equal(threadHash('org/board', '12'), '#/board/org/board/12');
  assert.deepEqual(threadFromHash('#/board/org/board/12'), { repo: 'org/board', id: '12' });
  assert.equal(threadFromHash('#/board'), null);
  assert.equal(threadFromHash('#/board/org/board'), null);
  assert.equal(threadFromHash('#/board/org/bo ard/1'), null);
  assert.equal(threadFromHash('#/board/org/board/%E0%A4%A'), null, 'a broken escape');
});
