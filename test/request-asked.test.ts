// A request asked through a session's own ask_user (issue #502, acceptance round 1): the real chain, from the tool
// server through Session.ask, Management's checks on the project folder, to the store. The round found a review's
// screenshots dropped without a word on this path, which the unit tests' fake ask never took.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { parseConfig } from '../src/config.ts';
import type { Management } from '../src/sessions/management.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { LEDUNG_SERVER, ledungToolServer, type ToolHandlers } from '../src/sessions/tools.ts';
import { isRequest, requestKinds } from '../src/shared/requests.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-request-asked-'));
const root = path.join(base, 'project');
fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
for (const f of ['cart-1280.png', 'cart-390.png', 'checkout.png', 'before.png']) fs.writeFileSync(path.join(root, 'shots', f), PNG);
fs.writeFileSync(path.join(root, 'test.log'), 'all 12 passed\n');
after(() => removeTemp(base));

type Tool = { handler(a: unknown, extra: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> };

async function managerAsk() {
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects: [{ name: 'p', runner: 'local', path: root }] }), store, () => {}));
  // A manager, as requests to Simon usually come from (the round's point 3).
  const info = store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager', parentId: null, permissionMode: 'default', role: 'manager' });
  const session = new Session({
    info, store, publish: () => {}, userName: 'Simon', management: (manager as unknown as { management: Management }).management,
    runner: { cwd: root, currentBranch: async () => null } as never,
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
  });
  const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  const ask = (options.mcpServers![LEDUNG_SERVER] as unknown as { instance: { _registeredTools: Record<string, Tool> } }).instance._registeredTools.ask_user!;
  return { store, ask };
}

const SHOTS = [
  { file: 'shots/cart-1280.png', group: 'Cart', look_for: 'The total on one line' },
  { file: 'shots/cart-390.png', group: 'Cart', look_for: 'The total on one line' },
  { file: 'shots/checkout.png', group: 'Checkout', look_for: 'Nothing cut off' },
];
const DECISIONS = [
  { key: 'rounding', title: 'Which rounding for display?', options: [{ key: 'a', text: '**Round half up**' }, { key: 'b', text: '**Banker’s rounding**' }] },
  { key: 'release', title: 'When to release?', options: [{ key: 'a', text: '**Today**' }, { key: 'b', text: '**Tomorrow**' }] },
];

test('a review keeps its screenshots beside its evidence files and decisions, and the reply names every part', async () => {
  const { store, ask } = await managerAsk();
  const r = await ask.handler({
    title: 'Checkout page: review, shots and two follow-ups', tier: 'Blocks a finished PR', refs: ['PR #12'],
    review: { solving: 'The total wrapped on a phone.', done: 'It fits now.', notes: 'Checked at 390 px.', evidence: [{ file: 'test.log', caption: 'The tests' }, { file: 'shots/before.png', caption: 'Before' }] },
    opinions: [{ who: 'Reviewer', why: 'Looks right.' }],
    screenshots: SHOTS, decisions: DECISIONS,
  }, {});
  assert.equal(r.isError, undefined, r.content[0]!.text);
  const [q] = store.listQuestions();
  assert.equal(q!.shots?.length, 3, 'the screenshots are kept with the review');
  assert.deepEqual(q!.shots!.map((s) => s.path.replace(/^kept:[0-9a-f]{32}\//, '')), ['shots/cart-1280.png', 'shots/cart-390.png', 'shots/checkout.png']);
  assert.equal(q!.details!.review!.evidence!.length, 2, 'and so are the evidence files');
  assert.ok(isRequest(q!));
  assert.deepEqual(requestKinds(q!), ['review', '2 decisions', '3 screenshots']);
  assert.match(r.content[0]!.text, new RegExp(`^Request #${q!.id} \\(review, 2 decisions, 3 screenshots\\) is recorded`));
});

test('a plain review with screenshots alone is a request too, and still asks as a review would without them', async () => {
  const { store, ask } = await managerAsk();
  const withShots = await ask.handler({ title: 'Cart', tier: 'Blocks a finished PR', review: { solving: 's', done: 'd' }, screenshots: [SHOTS[0]] }, {});
  assert.equal(withShots.isError, undefined, withShots.content[0]!.text);
  assert.equal(store.listQuestions()[0]!.shots?.length, 1);
  assert.match(withShots.content[0]!.text, /\(review, 1 screenshot\) is recorded/);
  // Without screenshots, byte-for-byte as before #502.
  const plain = await ask.handler({ title: 'Cart', tier: 'Blocks a finished PR', review: { solving: 's', done: 'd' } }, {});
  assert.match(plain.content[0]!.text, /^Review #\d+ is recorded/);
  assert.equal(store.listQuestions().find((x) => !x.shots)!.shots, null);
});

test('a bad screenshot beside a review refuses the whole request; nothing is stored', async () => {
  const { store, ask } = await managerAsk();
  const r = await ask.handler({ title: 'Cart', tier: 'Process', review: { solving: 's', done: 'd' }, screenshots: [SHOTS[0], { file: '../outside.png', look_for: 'x' }] }, {});
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /^Screenshot 2 \(\.\.\/outside\.png\) can't be attached/);
  assert.equal(store.listQuestions().length, 0);
});

test("about_request is Ledung's own text: a request's parts are refused there, and anything else left out is said", async () => {
  const asked: unknown[] = [];
  const h: ToolHandlers = {
    userName: 'Simon', role: 'manager', asksWhom: 'Simon',
    ask: (...a) => { asked.push(a); return { id: 9, shots: null } as never; },
    withdraw: () => '',
  };
  const tool = (ledungToolServer(h).instance as unknown as { _registeredTools: Record<string, Tool> })._registeredTools.ask_user!;
  const about = { question: 'Allow?', about_request: 'req-12345678', tier: 'Process' };
  for (const extra of [{ decisions: DECISIONS }, { sign_off: true }]) {
    const r = await tool.handler({ ...about, ...extra }, {});
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(r.content[0]!.text, /not with about_request.*Nothing was asked\./);
  }
  assert.equal(asked.length, 0);
  // Accepted before #502, so still accepted; the reply now says the screenshots didn't go with it.
  const r = await tool.handler({ ...about, screenshots: [SHOTS[0]] }, {});
  assert.equal(r.isError, undefined);
  assert.match(r.content[0]!.text, /^Question #9 about request req-12345678 is recorded and has gone to Simon\. Its screenshots were left out: /);
  const plain = await tool.handler(about, {});
  assert.equal(plain.content[0]!.text, 'Question #9 about request req-12345678 is recorded and has gone to Simon. Ledung applies the answer to the request itself and tells you. End your turn now.');
});
