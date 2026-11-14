// Issue #328: switching from chat X to chat Y never draws X's messages in Y's view. The page renders Y's view once
// before its open runs; what it draws then comes through viewFor, as useLedung hands it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredMessage } from '../src/shared/protocol.ts';
import { OpenSession, viewFor, type OpenSessionView } from '../web/src/openSession.ts';
import { PAGE } from '../web/src/catchUp.ts';

let nextId = 1;
const msg = (sessionId: string, text: string): StoredMessage =>
  ({ id: nextId++, sessionId, role: 'user', data: { text }, createdAt: 0 }) as unknown as StoredMessage;

/** An OpenSession whose reads answer only when released, recording every view it emits. */
function harness(stored: Record<string, StoredMessage[]>) {
  const views: OpenSessionView[] = [];
  const pending: Array<() => void> = [];
  const open = new OpenSession({
    send: () => {},
    messages: (id) => new Promise((resolve) => pending.push(() => resolve(stored[id] ?? []))),
    messagesBefore: async () => [],
    messagesAfter: async () => [],
    changed: (v) => views.push(v),
  });
  const release = async () => {
    for (const r of pending.splice(0)) r();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { open, views, release };
}

test("the first render of chat Y after chat X shows none of X's messages, and nothing of Y's view ever holds them", async () => {
  const x = Array.from({ length: PAGE }, (_, i) => msg('X', `x${i}`));
  const y = [msg('Y', 'y0'), msg('Y', 'y1')];
  const { open, views, release } = harness({ X: x, Y: y });
  open.open('X');
  await release();
  const xView = views.at(-1)!;
  assert.equal(xView.sessionId, 'X');
  assert.equal(xView.messages.length, PAGE);
  assert.equal(viewFor(xView, 'X'), xView, 'the chat it belongs to gets it as it is');

  // Y's view is drawn with the view as it still is, before open('Y') runs.
  const first = viewFor(xView, 'Y');
  assert.deepEqual(first.messages, [], "none of X's messages");
  assert.equal(first.hasEarlier, false, "nor X's Load earlier");

  open.open('Y');
  await release();
  const drawn = views.slice(views.indexOf(xView) + 1).map((v) => viewFor(v, 'Y'));
  for (const v of drawn) assert.ok(v.messages.every((m) => m.sessionId === 'Y'), "Y's view never holds X's messages");
  assert.deepEqual(drawn.at(-1)!.messages.map((m) => m.data.text), ['y0', 'y1']);
});

test("a live message for the new chat that comes before its read is shown, and kept when the read lands", async () => {
  const x = [msg('X', 'x0')];
  const y = [msg('Y', 'y0')];
  const { open, views, release } = harness({ X: x, Y: y });
  open.open('X');
  await release();
  open.open('Y');
  const live = msg('Y', 'live');
  open.message(live);
  assert.deepEqual(viewFor(views.at(-1)!, 'Y').messages.map((m) => m.data.text), ['live'], 'shown before the read');
  await release();
  assert.deepEqual(viewFor(views.at(-1)!, 'Y').messages.map((m) => m.data.text), ['y0', 'live']);
});

test('no chat open shows nothing, and a late read of the previous chat is not shown in the next', async () => {
  const { open, views, release } = harness({ X: [msg('X', 'x0')], Y: [] });
  open.open('X');
  open.open('Y');
  await release();
  assert.deepEqual(viewFor(views.at(-1)!, 'Y').messages, []);
  open.open(null);
  assert.deepEqual(viewFor(views.at(-1)!, null).messages, []);
});
