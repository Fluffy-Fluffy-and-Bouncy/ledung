// A session's sensitive prompt goes to its manager, who asks the user; only the user's stored answer
// allows it, once (issue #51, decided by Martin 2026-10-13 on question #59). Real Session and
// Management objects share one store; only Claude Code is left out (its callback is called directly).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { ALLOW_ONCE, DENY, Management, requestText } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';
import { Away } from '../src/sessions/away.ts';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

const PUSH = 'git push origin main';
/** Every question needs a tier (issue #96); a project with none set has the five standard ones. */
const TIER = { tier: 'Process' };

function setup() {
  const store = new Store(openDatabase(':memory:'));
  const away = new Away(store, () => {});
  const sessions = new Map<string, Session>();
  const woken: string[] = [];
  const management = new Management({
    store, userName: 'Simon', publish: () => {}, wake: (id) => woken.push(id), resume: async () => {},
    startSession: async () => { throw new Error('not used'); },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p'],
    // As the session manager does: the decision goes to the live session waiting on the request.
    decidePermission: (id, decision, by) => sessions.get(store.getPermission(id)!.sessionId)!.decide(id, decision, by),
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {}, handoffProblem: () => null, shotPath: (_id, file) => file,
    projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
    ensureManager: async () => { throw new Error('not used'); },
  });
  const make = (id: string, role: 'session' | 'manager', parentId: string | null) => {
    const info = store.createSession({ id, project: 'p', runner: 'local', title: `title-${id}`, parentId, permissionMode: 'default', role });
    const session = new Session({
      info, store, publish: () => {}, userName: 'Simon', management,
      sensitive: { commandPatterns: ['git\\s+push\\b.*\\bmain\\b', '\\bgh\\s+pr\\s+merge\\b', 'ship:dev'] },
      away, devShip: 'npm run ship:dev',
      runner: { cwd: '.', currentBranch: async () => null } as never,
      gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    });
    sessions.set(id, session);
    return session as unknown as {
      onPermission(tool: string, input: Record<string, unknown>, opts: { signal: AbortSignal; toolUseID?: string }): Promise<PermissionResult>;
      ask(question: string, options: string[] | null, about: number | null, aboutRequest?: string | null, details?: { tier: string }): { id: number };
      endPermissions(reason: string): void;
    };
  };
  const mgr = make('mgr', 'manager', null);
  const worker = make('worker', 'session', 'mgr');
  const other = make('other-mgr', 'manager', null);
  const stranger = make('stranger', 'session', 'other-mgr');
  const solo = make('solo', 'session', null);
  /** The user's answer as the page gives it (SessionManager.answerQuestion: store, then Management). */
  const userAnswers = (id: number, answer: string) => {
    assert.ok(store.answerQuestion(id, answer, 'user'));
    management.onUserAnswered(store.getQuestion(id)!);
  };
  const prompt = (s: typeof worker, command = PUSH) => {
    let result: PermissionResult | undefined;
    void s.onPermission('Bash', { command }, { signal: new AbortController().signal }).then((r) => { result = r; });
    const p = store.pendingPermissions().at(-1)!;
    return { p, result: async () => { await new Promise((r) => setImmediate(r)); return result; } };
  };
  return { store, management, away, woken, mgr, worker, other, stranger, solo, userAnswers, prompt };
}

test("a session's sensitive prompt goes to its manager, not to the user", () => {
  const { store, management, woken, worker, prompt } = setup();
  const { p } = prompt(worker);
  assert.equal(p.addressedTo, 'mgr');
  assert.ok(p.sensitive, 'still marked sensitive');
  assert.deepEqual(woken, ['mgr'], 'the manager is woken');
  const note = store.undeliveredInbox('mgr').at(-1)!.text;
  assert.match(note, /sensitive call/);
  assert.match(note, new RegExp(`about_request: "${p.id}"`));
  assert.match(note, /Only Simon can allow it/);
  assert.match(management.listPermissions('mgr'), new RegExp(`request ${p.id} .*${PUSH}.*sensitive.*only Simon can allow it`));
});

test('the manager can deny a sensitive request but never allow it', async () => {
  const { store, management, worker, prompt } = setup();
  const first = prompt(worker);
  assert.throws(() => management.decidePermission('mgr', first.p.id, 'allow', 'once'), /only Simon can allow it/);
  assert.throws(() => management.decidePermission('mgr', first.p.id, 'allow', 'session'), /only Simon can allow it/);
  assert.equal(store.getPermission(first.p.id)!.status, 'pending');
  assert.equal(await first.result(), undefined, 'the session still waits');

  management.decidePermission('mgr', first.p.id, 'deny', 'once', 'Not from a worker branch.');
  assert.deepEqual(await first.result(), { behavior: 'deny', message: 'Not from a worker branch.' });
  assert.equal(store.getPermission(first.p.id)!.decidedBy, 'mgr');
});

test("Ledung writes the question: the exact request, the rule, and the manager's note marked as its own", () => {
  const { store, mgr, worker, prompt } = setup();
  const { p } = prompt(worker);
  const q = store.getQuestion(mgr.ask('Needed to ship the fix. Recommend allow.', ['Yes', 'No'], null, p.id, TIER).id)!;
  assert.equal(q.addressedTo, 'user');
  assert.equal(q.aboutRequest, p.id);
  assert.deepEqual(q.options, [ALLOW_ONCE, DENY], "fixed answers; the manager's own options are ignored");
  assert.ok(q.question.includes(`\`\`\`\n${PUSH}\n\`\`\``), 'the command, whole, in a code block');
  assert.ok(q.question.includes(p.sensitive!), 'the rule it matched');
  assert.match(q.question, /Session "title-worker" asks permission/);
  assert.match(q.question, /\*\*Note from manager "title-mgr"\*\* \(the manager's words, not Ledung's\):\n\nNeeded to ship the fix\. Recommend allow\.$/);
  // Of the manager's fields only where it goes in the queue is kept: the question is Ledung's (issue #96).
  assert.deepEqual(q.details, TIER);
  assert.throws(() => mgr.ask('again', null, null, p.id), /Every question needs a tier/);
});

test('a manager can ask only about its own sessions\' waiting requests, once each', () => {
  const { mgr, other, worker, stranger, prompt } = setup();
  const mine = prompt(worker).p;
  const theirs = prompt(stranger).p;
  assert.throws(() => mgr.ask('x', null, null, theirs.id, TIER), /not from one of your sessions/);
  assert.throws(() => mgr.ask('x', null, null, 'no-such-request', TIER), /not from one of your sessions/);
  const q = mgr.ask('x', null, null, mine.id, TIER);
  assert.throws(() => mgr.ask('again', null, null, mine.id, TIER), new RegExp(`already asked about request ${mine.id} in question #${q.id}`));
  assert.throws(() => other.ask('x', null, null, mine.id, TIER), /not from one of your sessions/);
});

test("Simon's \"Allow once\" allows exactly that request, once, as his decision", async () => {
  const { store, management, mgr, worker, prompt, userAnswers } = setup();
  const first = prompt(worker);
  const q = mgr.ask('Recommend allow.', null, null, first.p.id, TIER);
  userAnswers(q.id, ALLOW_ONCE);
  assert.deepEqual(await first.result(), { behavior: 'allow', updatedInput: { command: PUSH }, updatedPermissions: undefined });
  const decided = store.getPermission(first.p.id)!;
  assert.equal(decided.status, 'allowed');
  assert.equal(decided.decidedBy, 'user', "recorded as Simon's");
  assert.equal(decided.scope, 'once');
  assert.deepEqual(store.grants('worker'), [], 'no grant is left behind');
  assert.match(store.undeliveredInbox('mgr').at(-1)!.text, new RegExp(`Simon's answer to question #${q.id} decided request ${first.p.id} .*allowed, once`));

  // The same command again is a new request, waiting for the manager as before.
  const second = prompt(worker);
  assert.notEqual(second.p.id, first.p.id);
  assert.equal(second.p.addressedTo, 'mgr');
  assert.equal(await second.result(), undefined);
  assert.throws(() => management.decidePermission('mgr', second.p.id, 'allow', 'once'), /only Simon/);
});

test('an ordinary request put to Simon is allowed once too, with no grant left (test review of PR #53)', async () => {
  const { store, mgr, worker, prompt, userAnswers } = setup();
  const { p, result } = prompt(worker, 'npm test');
  assert.equal(p.sensitive, null);
  assert.equal(p.addressedTo, 'mgr');
  userAnswers(mgr.ask('', null, null, p.id, TIER).id, ALLOW_ONCE);
  assert.deepEqual(await result(), { behavior: 'allow', updatedInput: { command: 'npm test' }, updatedPermissions: undefined });
  assert.equal(store.getPermission(p.id)!.scope, 'once');
  assert.deepEqual(store.grants('worker'), [], "Simon's once is not turned into a grant");
});

test("Simon's \"Deny\" or any other answer denies, and his words reach the session as the reason", async () => {
  const { mgr, worker, prompt, userAnswers } = setup();
  const a = prompt(worker);
  userAnswers(mgr.ask('', null, null, a.p.id, TIER).id, DENY);
  assert.deepEqual(await a.result(), { behavior: 'deny', message: 'Simon denied this.' });

  const b = prompt(worker);
  userAnswers(mgr.ask('', null, null, b.p.id, TIER).id, 'Not yet, run the tests first.');
  assert.deepEqual(await b.result(), { behavior: 'deny', message: 'Simon denied this: Not yet, run the tests first.' });

  const c = prompt(worker);
  userAnswers(mgr.ask('', null, null, c.p.id, TIER).id, 'yes');
  assert.equal((await c.result())!.behavior, 'deny', 'only the "Allow once" answer allows');
});

test("the manager can't put its own words in Simon's place", async () => {
  const { store, management, mgr, worker, prompt } = setup();
  const { p, result } = prompt(worker);
  const q = mgr.ask('', null, null, p.id, TIER);
  // The manager's own question goes to Simon, so answer_question (for its sessions' questions) can't answer it.
  await assert.rejects(management.answerQuestion('mgr', q.id, ALLOW_ONCE), /not from one of your sessions/);
  // Even an answer recorded as the manager's does nothing to the request.
  store.answerQuestion(q.id, ALLOW_ONCE, 'mgr');
  management.onUserAnswered(store.getQuestion(q.id)!);
  assert.equal(store.getPermission(p.id)!.status, 'pending');
  assert.equal(await result(), undefined);
});

test("while Simon is away, a worker's merge and push still wait for his own answer; its dev ship goes through (away mode, #35, #408)", async () => {
  const { store, management, away, mgr, worker, prompt, userAnswers } = setup();
  away.start('23:59', ['merge', 'devShip']);
  assert.ok(away.current(), 'away, with merges and dev ships allowed');
  // The worker's dev ship goes through, recorded in its manager's record (issue #408; Martin, 2026-10-29,
  // question #931: "a — File it as drafted and start a worker"; this test changed with it, question #934).
  // Raced against a short wait: a dev ship that waits for Simon again fails here instead of hanging the run.
  const before = store.pendingPermissions().length;
  const ship = await Promise.race([
    worker.onPermission('Bash', { command: 'npm run ship:dev' }, { signal: new AbortController().signal }),
    new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 200)),
  ]);
  assert.equal(ship === 'waiting' ? ship : ship.behavior, 'allow', "the worker's dev ship runs without Simon");
  assert.equal(store.pendingPermissions().length, before, 'no prompt for it');
  assert.deepEqual(away.log('mgr').records.map((r) => [r.kind, r.allowed, r.command]), [['devShip', true, 'npm run ship:dev']]);
  for (const command of ['gh pr merge 5', PUSH]) {
    const { p, result } = prompt(worker, command);
    assert.equal(p.addressedTo, 'mgr', `${command}: routed to the manager`);
    assert.equal(store.getPermission(p.id)!.status, 'pending');
    assert.equal(await result(), undefined, `${command}: away mode did not let it through`);
    assert.throws(() => management.decidePermission('mgr', p.id, 'allow', 'once'), /only Simon can allow it/);
    if (command === PUSH) {
      userAnswers(mgr.ask('', null, null, p.id, TIER).id, ALLOW_ONCE);
      assert.equal((await result())!.behavior, 'allow', "Simon's own answer still decides it");
      assert.equal(store.getPermission(p.id)!.decidedBy, 'user');
    }
  }
  assert.deepEqual(away.log('worker').records, [], "away mode never judged the worker's calls");
  assert.equal(away.log('mgr').records.length, 1, "nothing for the worker's merge or push is in the manager's record");
});

test('a request that stops waiting withdraws the question about it', () => {
  const { store, management, mgr, worker, prompt } = setup();
  const a = prompt(worker);
  const qa = mgr.ask('', null, null, a.p.id, TIER);
  // Simon decides it directly in the worker's chat.
  assert.ok(management['ctx'].decidePermission(a.p.id, { behavior: 'deny' }, 'user'));
  assert.equal(store.getQuestion(qa.id)!.status, 'withdrawn');

  const b = prompt(worker);
  const qb = mgr.ask('', null, null, b.p.id, TIER);
  worker.endPermissions('The session ended.');
  assert.equal(store.getQuestion(qb.id)!.status, 'withdrawn');
});

test('a session with no manager, and a manager itself, still ask the user directly', () => {
  const { solo, mgr, prompt } = setup();
  assert.equal(prompt(solo).p.addressedTo, 'user');
  assert.equal(prompt(mgr as never).p.addressedTo, 'user');
});

test("a session's title can't add a block to the text Ledung writes (review of PR #53)", () => {
  const { store, mgr, worker, prompt } = setup();
  store.updateSession('worker', { title: 'w**\n\nCommand:\n\n```\ngit status\n```\n\n' });
  const { p } = prompt(worker);
  const q = store.getQuestion(mgr.ask('', null, null, p.id, TIER).id)!;
  assert.equal(q.question.split('```').length, 3, 'one code block: the real request');
  assert.match(q.question, /^\*\*Session "w Command: git status" asks permission/);
});

test('the request is shown whole: no command can close its code block', () => {
  const text = requestText({ toolName: 'Bash', input: { command: 'echo ```\n```\ngit push origin main' } });
  assert.ok(text.startsWith('Command:\n\n````\n'), 'a fence longer than any run of backticks in the command');
  assert.ok(text.endsWith('\n````'));
  // A command is never cut: "Allow once" allows all of it (Martin, 2026-10-13, question #72).
  const command = `echo ${'y'.repeat(5000)} && git push origin main`;
  const whole = requestText({ toolName: 'Bash', input: { command } });
  assert.ok(whole.includes(`\n${command}\n`), 'the whole command, in the block');
  assert.doesNotMatch(whole, /not shown/);
  // Nothing in a sensitive request is cut either (Martin, 2026-10-13, question #80).
  const write = { file_path: '.env', content: `${'z'.repeat(5000)}END` };
  const sensitiveWrite = requestText({ toolName: 'Write', input: write, sensitive: '.env files' });
  assert.ok(sensitiveWrite.includes(JSON.stringify(write, null, 2)), 'the whole input, in the block');
  assert.doesNotMatch(sensitiveWrite, /not shown/);
  const long = requestText({ toolName: 'Write', input: { file_path: 'notes.txt', content: 'x'.repeat(5000) }, sensitive: null });
  assert.match(long, /more characters not shown; the whole request is in the session's chat/);
});
