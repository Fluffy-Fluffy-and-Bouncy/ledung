// Standard question tiers, enforced by Ledung (issue #96): every project has a list, the five unless it
// changed them, never empty; every question needs a tier from its project's list, whoever asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { parseConfig } from '../src/config.ts';
import type { Management } from '../src/sessions/management.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { LEDUNG_SERVER } from '../src/sessions/tools.ts';
import { FakeBackend, FakeBoard } from '../src/board/fake.ts';
import { DEFAULT_TIERS, ledungTier, tiersOf, type QuestionDetails } from '../src/shared/questions.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

// The Question Desk's five, in its order (agent-workflow a8e7520, v84), as the issue quotes them.
const FIVE = ['Blocks a finished PR', 'Blocks a card from Ready', 'Process', 'Housekeeping', 'Record only'];

test('a project with no tiers of its own, or an empty list, has the five in order; its own list is kept', () => {
  assert.deepEqual(DEFAULT_TIERS, FIVE);
  assert.deepEqual(tiersOf(undefined), FIVE);
  assert.deepEqual(tiersOf([]), FIVE);
  assert.deepEqual(tiersOf(['  ', '']), FIVE, 'blank lines are no list');
  assert.deepEqual(tiersOf(['Now', 'Later']), ['Now', 'Later']);
});

test("Ledung's own questions take Process, or the project's first tier when it has none called that", () => {
  assert.equal(ledungTier(FIVE), 'Process');
  assert.equal(ledungTier(['Now', 'Later']), 'Now');
});

/** A session manager with two projects, one with its own tiers, and live sessions in them. */
function setup() {
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    userName: 'Simon',
    projects: [
      { name: 'p', runner: 'local', path: '/tmp/ledung-test-p' },
      { name: 'q', runner: 'local', path: '/tmp/ledung-test-q', questionTiers: ['Now', 'Later'] },
    ],
  }), store, () => {}));
  const management = (manager as unknown as { management: Management }).management;
  const make = (id: string, project: string, role: 'session' | 'manager', parentId: string | null) => {
    const info = store.createSession({ id, project, runner: 'local', title: `title-${id}`, parentId, permissionMode: 'default', role });
    return new Session({
      info, store, publish: () => {}, userName: 'Simon', management,
      runner: { cwd: '.', currentBranch: async () => null } as never,
      gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    });
  };
  return { store, manager, make };
}

/** ask_user as the session's own tool server runs it. */
async function askUser(session: Session) {
  const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  const tool = (options.mcpServers![LEDUNG_SERVER] as unknown as {
    instance: { _registeredTools: Record<string, { description: string; handler(a: unknown, extra: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> }> };
  }).instance._registeredTools.ask_user!;
  return { description: tool.description, call: (args: Record<string, unknown>) => tool.handler(args, {}) };
}

test('the page shows a project with no tiers set with the five, and one with its own with those', () => {
  const { manager } = setup();
  assert.deepEqual(manager.projects().map((p) => [p.name, p.questionTiers]), [['p', FIVE], ['q', ['Now', 'Later']]]);
});

test("ask_user without a tier, or with one not in its project's list, is refused with that list; nothing is stored", async () => {
  const { store, make } = setup();
  const ask = await askUser(make('s', 'p', 'session', null));
  const list = FIVE.map((t) => `"${t}"`).join(', ');
  assert.ok(ask.description.includes(list), "ask_user's description lists the project's tiers");

  const none = await ask.call({ question: 'Ship it?' });
  assert.equal(none.isError, true);
  assert.equal(none.content[0]!.text, `Every question needs a tier. Give tier as one of: ${list}. Nothing was asked.`);
  const wrong = await ask.call({ question: 'Ship it?', tier: 'Blocks work' });
  assert.equal(wrong.content[0]!.text, `The tier "Blocks work" is not one of this project's question tiers. Give tier as one of: ${list}. Nothing was asked.`);
  assert.equal(store.listQuestions().length, 0);

  const ok = await ask.call({ question: 'Ship it?', tier: 'housekeeping ' });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(store.listQuestions()[0]!.details, { tier: 'Housekeeping' }, "stored as the project spells it");
});

test("a project's own list is the one that counts: the five are refused there", async () => {
  const { store, make } = setup();
  const ask = await askUser(make('t', 'q', 'session', null));
  assert.match((await ask.call({ question: 'x', tier: 'Process' })).content[0]!.text, /not one of this project's question tiers\. Give tier as one of: "Now", "Later"\./);
  assert.equal((await ask.call({ question: 'x', tier: 'Later' })).isError, undefined);
  assert.equal(store.listQuestions()[0]!.details!.tier, 'Later');
});

test("a manager's questions need one too: its own, one about a session's question, and one about a permission request", () => {
  const { store, make } = setup();
  const mgr = make('mgr', 'p', 'manager', null) as unknown as {
    ask(question: string, options: string[] | null, about: number | null, aboutRequest?: string | null, details?: QuestionDetails | null): { id: number };
  };
  make('w', 'p', 'session', 'mgr');
  const asked = store.createQuestion({ sessionId: 'w', question: 'Merge?', options: null, addressedTo: 'mgr', details: { tier: 'Process' } });
  assert.throws(() => mgr.ask('Mine', null, null), /Every question needs a tier\. Give tier as one of: "Blocks a finished PR"/);
  assert.throws(() => mgr.ask('Forwarded', null, asked.id), /Every question needs a tier/);
  assert.throws(() => mgr.ask('Forwarded', null, asked.id, null, { tier: 'Soon' }), /The tier "Soon" is not one of/);
  // Checked before anything else, so even a request that doesn't exist is refused for its missing tier first.
  assert.throws(() => mgr.ask('Allow?', null, null, 'no-such-request'), /Every question needs a tier/);
  assert.equal(store.listQuestions().length, 1, 'only the session question set up above');
  const q = mgr.ask('Forwarded', null, asked.id, null, { tier: 'Blocks a finished PR', rank: 2 });
  assert.deepEqual(store.getQuestion(q.id)!.details, { tier: 'Blocks a finished PR', rank: 2 });
});

test("a manager's ask_user about a permission request is stored with its tier, and refused without one", async () => {
  const { store, make } = setup();
  const ask = await askUser(make('mgr', 'p', 'manager', null));
  make('w', 'p', 'session', 'mgr');
  store.createPermission({ id: 'req-12345678', sessionId: 'w', toolName: 'Bash', input: { command: 'ls' }, title: null, reason: null, addressedTo: 'mgr' });

  const none = await ask.call({ question: 'Allow?', about_request: 'req-12345678' });
  assert.equal(none.isError, true);
  assert.match(none.content[0]!.text, /^Every question needs a tier\./);
  assert.equal(store.listQuestions().length, 0);

  const ok = await ask.call({ question: 'Allow?', about_request: 'req-12345678', tier: 'Blocks a finished PR', rank: 1 });
  assert.equal(ok.isError, undefined, ok.content[0]!.text);
  const q = store.listQuestions()[0]!;
  assert.equal(q.aboutRequest, 'req-12345678');
  assert.deepEqual(q.details, { tier: 'Blocks a finished PR', rank: 1 });
});

test("Ledung's own question about a first board post takes Process, or the first of the project's own tiers", () => {
  const { store, manager } = setup();
  // The real context the session manager gives the boards, so its question goes through the same wiring.
  const { ctx } = manager.attachBoards(() => new FakeBackend(new FakeBoard(), 'me')) as unknown as {
    ctx: { askUser(managerId: string, question: string, options: string[]): number };
  };
  for (const [id, project] of [['mp', 'p'], ['mq', 'q']] as const) {
    store.createSession({ id, project, runner: 'local', title: `title-${id}`, parentId: null, permissionMode: 'default', role: 'manager' });
  }
  assert.equal(store.getQuestion(ctx.askUser('mp', 'Post?', ['Yes', 'No']))!.details!.tier, 'Process');
  assert.equal(store.getQuestion(ctx.askUser('mq', 'Post?', ['Yes', 'No']))!.details!.tier, 'Now');
});
