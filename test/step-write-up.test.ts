// #291: a manager's write-up of a run's person step, through a real Session's ask_user. It goes to the person whoever
// coordinates the run (test review of PR #294, finding 2): a session with a manager of its own still asks the person,
// not its manager, as Ledung's own card always did; its other questions go to its manager as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { parseConfig } from '../src/config.ts';
import type { Management } from '../src/sessions/management.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { LEDUNG_SERVER, type RunHandlers } from '../src/sessions/tools.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

test('#291: a write-up from a session that has a manager goes to the person; its plain question goes to its manager', async () => {
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects: [{ name: 'p', runner: 'local', path: '/tmp/ledung-test-p' }] }), store, () => {}));
  const management = (manager as unknown as { management: Management }).management;
  store.createSession({ id: 'm', project: 'p', runner: 'local', title: 'Manager: p', parentId: null, permissionMode: 'default', role: 'manager' });
  const info = store.createSession({ id: 'w', project: 'p', runner: 'local', title: 'Worker', parentId: 'm', permissionMode: 'default', role: 'session' });
  const linked: number[] = [];
  // The run engine stands in here: this test is about where Session puts the question, not about the run's checks.
  const runs: RunHandlers = {
    step: async () => '', status: async () => '',
    writeUp: async (a) => ({ tag: { run: a.run, block: a.block, runTitle: 'Cart', blockTitle: 'Owner decides', flow: 'main', writeUp: true }, options: a.options }),
    writeUpAsked: (q) => { linked.push(q.id); },
  };
  const session = new Session({
    info, store, publish: () => {}, userName: 'Simon', management, runs: async () => runs,
    runner: { cwd: '.', currentBranch: async () => null } as never,
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
  });
  const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  const ask = (options.mcpServers![LEDUNG_SERVER] as unknown as {
    instance: { _registeredTools: Record<string, { handler(a: unknown, extra: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> }> };
  }).instance._registeredTools.ask_user!;

  // Its ordinary question goes to its manager (the premise: this session does have one).
  const plain = await ask.handler({ question: 'Which colour?', tier: 'Process' }, {});
  assert.equal(plain.isError, undefined, plain.content[0]!.text);
  assert.equal(store.listQuestions().at(-1)!.addressedTo, 'm');

  const written = await ask.handler({
    run: 'run-1', block: 'decide', tier: 'Blocks a finished PR', issue: 'The cart adds VAT twice.',
    options: [{ key: 'a', text: '**Go on**', outcome: 'Go on' }, { key: 'b', text: '**Fix again**', outcome: 'Fix again' }],
  }, {});
  assert.equal(written.isError, undefined, written.content[0]!.text);
  const q = store.listQuestions().at(-1)!;
  assert.equal(q.addressedTo, 'user');
  assert.equal(q.sessionId, 'w');
  assert.equal(q.details!.run!.run, 'run-1');
  assert.deepEqual(linked, [q.id]);
});
