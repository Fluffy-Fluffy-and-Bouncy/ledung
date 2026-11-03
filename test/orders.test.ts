// Orders on record (issue #105): a manager attaches the person's order to start_session or send_message; Ledung checks
// the words against its own record, shows the order, and its PreToolUse hook lets exactly the ordered command run in the
// manager and the session it went to. Away mode's "ordered" kind and the end of an away period are covered too. The
// session's hooks are called as Claude Code calls them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { buildDelivery, Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';
import { Away, formatLog } from '../src/sessions/away.ts';
import { commandProblem, covers, Orders } from '../src/sessions/orders.ts';
import { DROP, KEEP, statusText } from '../src/shared/orders.ts';
import { waitingLists } from '../web/src/waitingLists.ts';
import type { AwayKind, ServerEvent } from '../src/shared/protocol.ts';

const DEPLOY = 'scripts/deploy.sh --stats';
const HOUR = 3600_000;

function setup() {
  const store = new Store(openDatabase(':memory:'));
  const published: ServerEvent[] = [];
  const told: { id: string; text: string }[] = [];
  const publish = (e: ServerEvent) => published.push(e);
  // The order record and away mode, wired as the session manager wires them.
  let orders: Orders;
  const away = new Away(store, publish, { userName: 'Simon', notify: () => {}, onEnded: (since, end) => void orders.settleAway(since, end) });
  orders = new Orders({ store, userName: 'Simon', publish, tierOf: () => 'Blocks a finished PR', tell: (id, text) => told.push({ id, text }) });
  const tasks: string[] = [];
  let next = 0;
  const management = new Management({
    store, userName: 'Simon', publish, wake: () => {}, resume: async () => {},
    startSession: async (project, task, opts) => {
      // What the session gets, composed as SessionManager.start composes it; the task itself is kept for the title.
      tasks.push(`${opts.before ? `${opts.before}\n\n` : ''}Your task, from your manager "Manager":\n\n${task}`);
      return store.createSession({ id: `w${++next}`, project, runner: 'local', title: `Worker ${next}`, parentId: opts.parentId, permissionMode: 'auto' });
    },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p'], decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {},
    projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
    ensureManager: async () => { throw new Error('not used'); },
    handoffProblem: () => null, shotPath: (_id, file) => file,
    orders, away: () => away.current(),
  });
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager', parentId: null, permissionMode: 'auto', role: 'manager' });
  store.createSession({ id: 'mgr2', project: 'p', runner: 'local', title: 'Other manager', parentId: null, permissionMode: 'auto', role: 'manager' });
  /** A question of `asker` the person answered, here (on this computer) or not. */
  const answered = (answer: string, opts: { asker?: string; here?: boolean; forwarded?: number | null; at?: number } = {}) => {
    const q = store.createQuestion({ sessionId: opts.asker ?? 'mgr', question: 'Publish the stats?', options: ['Yes, publish', 'Not yet'], addressedTo: 'user' });
    store.answerQuestion(q.id, answer, 'user', opts.forwarded ?? null, opts.here ?? true);
    if (opts.at !== undefined) store.database.prepare('UPDATE questions SET answered_at = ? WHERE id = ?').run(opts.at, q.id);
    return q.id;
  };
  /** Words the person typed into the manager: on this computer (here) unless told otherwise, and with no `from`. */
  const typed = (text: string, at = Date.now(), data: Record<string, unknown> = { here: true }) => store.addMessage('mgr', 'user', { text, ...data }, at);
  const hooksOf = async (id: string) => {
    const session = new Session({
      info: store.getSession(id)!, store, userName: 'Simon', management, away, orders,
      publish, runner: { cwd: '.', currentBranch: async () => null } as never,
      gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    });
    (session as unknown as { q: unknown }).q = {};
    const o = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
    const pre = o.hooks!.PreToolUse![0]!.hooks[0]!;
    const post = o.hooks!.PostToolUse![0]!.hooks[0]!;
    const failure = o.hooks!.PostToolUseFailure![0]!.hooks[0]!;
    const signal = { signal: new AbortController().signal };
    return {
      /** Ledung's PreToolUse answer for a Bash call: 'allow', or null when it doesn't allow it itself. */
      decide: async (command: string, toolUseId: string, extra: Record<string, unknown> = {}) => {
        const out = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'Run it', ...extra } } as never, toolUseId, signal) as { hookSpecificOutput?: { permissionDecision?: string } };
        return out.hookSpecificOutput?.permissionDecision === 'allow' ? 'allow' : null;
      },
      /** The call ended well: the note after it. */
      ran: async (toolUseId: string) => {
        const out = await post({ hook_event_name: 'PostToolUse', tool_use_id: toolUseId } as never, toolUseId, signal) as { hookSpecificOutput?: { additionalContext?: string } };
        return out.hookSpecificOutput?.additionalContext ?? null;
      },
      failed: async (toolUseId: string, error: string) => {
        await failure({ hook_event_name: 'PostToolUseFailure', tool_use_id: toolUseId, error } as never, toolUseId, signal);
      },
    };
  };
  const goAway = (allow: AwayKind[]) => away.start('23:59', allow);
  return { store, management, orders, away, published, told, tasks, answered, typed, hooksOf, goAway };
}

test("start_session and send_message take an order on the person's own word; any other source is refused, with the reason", async () => {
  const t = setup();
  t.store.createSession({ id: 'w0', project: 'p', runner: 'local', title: 'Worker 0', parentId: 'mgr', permissionMode: 'auto' });
  const refused = async (source: object, why: RegExp) => {
    await assert.rejects(t.management.sendMessage('mgr', 'w0', 'Deploy.', { command: DEPLOY, ...source }), why);
  };
  await refused({ question: t.answered('Yes, publish', { asker: 'mgr2' }) }, /not one of your own questions/);
  await refused({ question: t.answered('Yes, publish', { here: false }) }, /not answered on this computer/);
  const original = t.answered('Yes, publish');
  await refused({ question: t.answered('Yes, publish', { forwarded: original }) }, /not answered by the person themself/);
  await refused({ question: t.answered('Yes, publish', { at: Date.now() - 3 * 24 * HOUR }) }, /more than two days old/);
  const open = t.store.createQuestion({ sessionId: 'mgr', question: 'Publish?', options: null, addressedTo: 'user' });
  await refused({ question: open.id }, /has no answer/);
  t.typed('publish the stats now', Date.now(), { here: false });
  await refused({ typed: { words: 'publish the stats now', at: new Date().toISOString() } }, /no message the person typed/);
  t.typed('publish the stats', Date.now(), { here: true, from: 'ledung' });
  await refused({ typed: { words: 'publish the stats', at: new Date().toISOString() } }, /no message the person typed/);
  await refused({}, /exactly one of/);
  // Nothing of a refused order reaches the session or the page.
  assert.equal(t.store.undeliveredInbox('w0').length, 0);
  assert.deepEqual(t.orders.list(), []);

  // The person's own words: an answer given here, to this manager's question; or what they typed here, at that time.
  const q = t.answered('Yes, publish');
  const started = await t.management.startSession('mgr', { task: 'Run the deploy.', order: { command: DEPLOY, question: q } });
  assert.match(started, /Order #1 recorded \(answer to question #\d+/);
  assert.ok(t.tasks[0]!.startsWith('Yes, publish\n\n— Simon\'s own words (answer to question #'), 'the task starts with the words verbatim');
  assert.ok(t.tasks[0]!.endsWith('Run the deploy.'));
  const at = Date.now() - 5 * 60_000;
  t.typed('Please deploy the stats tonight, then go to bed.', at);
  const hhmm = `${String(new Date(at).getHours()).padStart(2, '0')}:${String(new Date(at).getMinutes()).padStart(2, '0')}`;
  const sent = await t.management.sendMessage('mgr', 'w0', 'Deploy.', { command: DEPLOY, typed: { words: 'deploy the stats tonight', at: hhmm } });
  assert.match(sent, /Order #2 recorded \(typed on this computer/);
  assert.ok(t.store.undeliveredInbox('w0')[0]!.text.startsWith('deploy the stats tonight\n\n— Simon'), 'the message starts with the words verbatim');
  const page = t.orders.list();
  assert.deepEqual(page.map((o) => [o.id, o.sessionId, o.project, o.words, o.status]), [[2, 'w0', 'p', 'deploy the stats tonight', 'open'], [1, 'w1', 'p', 'Yes, publish', 'open']]);
});

test('a pattern must name its program plainly and can only cover one plain command', () => {
  assert.match(commandProblem('*', 'pattern')!, /start with the program/);
  assert.match(commandProblem('gh *', 'pattern')!, /start with the program/);
  assert.match(commandProblem('npm run deploy', 'pattern')!, /needs a `\*`/);
  assert.match(commandProblem('scripts/deploy.sh --env * && rm -rf x', 'pattern')!, /one plain command/);
  assert.equal(commandProblem('scripts/deploy.sh --env *', 'pattern'), null);
  assert.equal(commandProblem('cd site && ./deploy.sh', 'exact'), null);
  const p = { command: 'scripts/deploy.sh --env *', match: 'pattern' as const };
  assert.equal(covers(p, 'Bash', { command: 'scripts/deploy.sh --env prod' }), true);
  assert.equal(covers(p, 'Bash', { command: 'scripts/deploy.sh --env prod && rm -rf /' }), false, 'chained');
  assert.equal(covers(p, 'Bash', { command: 'scripts/deploy.sh --env prod; rm -rf /' }), false, 'chained');
  assert.equal(covers(p, 'Bash', { command: 'scripts/deploy.sh --env $(cat x)' }), false, 'computed');
  assert.equal(covers(p, 'Bash', { command: 'other.sh --env prod' }), false);
  const e = { command: DEPLOY, match: 'exact' as const };
  assert.equal(covers(e, 'Bash', { command: ` ${DEPLOY} `, description: 'x', run_in_background: true }), true);
  assert.equal(covers(e, 'PowerShell', { command: DEPLOY }), true);
  assert.equal(covers(e, 'Bash', { command: `${DEPLOY} && echo done` }), false);
  assert.equal(covers(e, 'Bash', { command: DEPLOY, dangerouslyDisableSandbox: true }), false, 'another call');
  assert.equal(covers(e, 'Write', { command: DEPLOY }), false);
});

test('the ordered command runs without a prompt in the session and in its manager, with a note quoting the words; nothing else does', async () => {
  const t = setup();
  const q = t.answered('Yes, publish');
  await t.management.startSession('mgr', { task: 'Deploy.', order: { command: DEPLOY, question: q, until: 'done' } });
  const worker = await t.hooksOf('w1');
  // The premise: without the order, nothing lets this through (positive branch of the absence asserts below).
  assert.equal(await worker.decide(`${DEPLOY} && rm -rf /`, 'c0'), null, 'a chained one is not covered');
  assert.equal(await worker.decide('scripts/deploy.sh --all', 'c1'), null, 'another command is not covered');
  assert.equal(await worker.decide(DEPLOY, 'c2'), 'allow');
  const note = await worker.ran('c2');
  assert.match(note!, /under order #1: Simon's own words, "Yes, publish" \(answer to question #\d+, \d\d:\d\d\)/);
  const manager = await t.hooksOf('mgr');
  assert.equal(await manager.decide(DEPLOY, 'm1'), 'allow', 'in the manager too');
  // Another session of the same manager is not covered.
  t.store.createSession({ id: 'w9', project: 'p', runner: 'local', title: 'Other', parentId: 'mgr', permissionMode: 'auto' });
  assert.equal(await (await t.hooksOf('w9')).decide(DEPLOY, 'o1'), null);
  // Cancelled on the page: nothing is allowed any more, and the manager and the session are told.
  const cancelled = t.orders.cancel(1);
  assert.equal(cancelled.status, 'dropped');
  assert.match(statusText(cancelled, 'Simon'), /^dropped on Simon's word \d\d:\d\d$/);
  assert.equal(await worker.decide(DEPLOY, 'c3'), null);
  assert.equal(await manager.decide(DEPLOY, 'm2'), null);
  assert.deepEqual(t.told.map((x) => x.id), ['mgr', 'w1']);
  assert.match(t.told[0]!.text, /Simon cancelled order #1 on the page/);
  assert.ok(t.published.some((e) => e.type === 'orders' && e.orders[0]?.status === 'dropped'), 'the page hears of it');
});

test('a once-order runs once: done after it ran; given back with its error when it failed', async () => {
  const t = setup();
  await t.management.startSession('mgr', { task: 'Deploy.', order: { command: DEPLOY, question: t.answered('Yes, publish') } });
  const worker = await t.hooksOf('w1');
  assert.equal(await worker.decide(DEPLOY, 'a'), 'allow');
  assert.equal(await worker.decide(DEPLOY, 'b'), null, 'taken while the first run is under way');
  await worker.failed('a', 'exit code 1: no network');
  assert.equal(t.store.getOrder(1)!.note, 'exit code 1: no network');
  assert.equal(t.store.getOrder(1)!.status, 'open');
  assert.equal(await worker.decide(DEPLOY, 'c'), 'allow', 'given back after the failure');
  await worker.ran('c');
  assert.equal(t.store.getOrder(1)!.status, 'done');
  assert.equal(await worker.decide(DEPLOY, 'd'), null, 'done: used up');
});

test('an until-done order holds until the manager marks it done', async () => {
  const t = setup();
  await t.management.startSession('mgr', { task: 'Deploy.', order: { command: DEPLOY, question: t.answered('Yes, publish'), until: 'done' } });
  const worker = await t.hooksOf('w1');
  assert.equal(await worker.decide(DEPLOY, 'a'), 'allow');
  await worker.ran('a');
  assert.equal(await worker.decide(DEPLOY, 'b'), 'allow');
  assert.match(t.management.orderDone('mgr2', 1), /not one of yours/);
  assert.match(t.management.orderDone('mgr', 1), /done/);
  assert.equal(await worker.decide(DEPLOY, 'c'), null);
});

test('away kind "ordered": on, an order from the away period runs and away_log lists it; off, it is held and reads refused', async () => {
  for (const kind of [true, false]) {
    const t = setup();
    t.goAway(kind ? ['merge', 'ordered'] : ['merge']);
    await t.management.startSession('mgr', { task: 'Deploy.', order: { command: DEPLOY, question: t.answered('Yes, publish') } });
    assert.notEqual(t.store.getOrder(1)!.awaySince, null, 'recorded during the away period');
    const worker = await t.hooksOf('w1');
    const log = formatLog(t.away.log('mgr'), t.away.current(), 'Simon');
    assert.match(log, /No sensitive call/, 'nothing logged before the call');
    const decided = await worker.decide(DEPLOY, 'a');
    const after = formatLog(t.away.log('mgr'), t.away.current(), 'Simon');
    if (kind) {
      assert.equal(decided, 'allow');
      assert.match(after, /ALLOWED · ordered/);
      assert.match(after, /Allowed by order #1: Simon's own words, "Yes, publish" \(run by its session "Worker 1"\)/);
      assert.equal(t.store.getOrder(1)!.status, 'open');
    } else {
      assert.equal(decided, null);
      assert.match(after, /HELD · ordered/);
      assert.equal(t.store.getOrder(1)!.status, 'refused');
      assert.match(statusText(t.store.getOrder(1)!, 'Simon'), /^refused: held for Simon: order #1 was recorded while Simon was away/);
    }
  }
});

test('an order recorded before the person left still runs while they are away, with the kind off', async () => {
  const t = setup();
  await t.management.startSession('mgr', { task: 'Deploy.', order: { command: DEPLOY, question: t.answered('Yes, publish') } });
  t.goAway(['merge']);
  const worker = await t.hooksOf('w1');
  assert.equal(await worker.decide(DEPLOY, 'a'), 'allow');
  assert.match(formatLog(t.away.log('mgr'), t.away.current(), 'Simon'), /ALLOWED · ordered/, 'and away_log has it');
});

test('at the end of away, every order from the period that is not done asks "keep it?" first; Keep puts it back, Drop ends it', async () => {
  const t = setup();
  t.goAway(['ordered']);
  for (const command of ['scripts/a.sh', 'scripts/b.sh', 'scripts/c.sh']) {
    await t.management.startSession('mgr', { task: 'Go.', order: { command, question: t.answered('Yes, publish') } });
  }
  const w1 = await t.hooksOf('w1');
  assert.equal(await w1.decide('scripts/a.sh', 'a'), 'allow');
  await w1.ran('a');
  const w2 = await t.hooksOf('w2');
  assert.equal(await w2.decide('scripts/b.sh', 'b'), 'allow');
  await w2.failed('b', 'exit code 2: denied by the server');
  const ordinary = t.store.createQuestion({ sessionId: 'mgr', question: 'Which colour?', options: null, addressedTo: 'user', details: { tier: 'Blocks a finished PR', rank: 0 } });
  assert.equal(t.store.listQuestions(100).filter((q) => q.details?.order).length, 0, 'nothing asked while away');
  t.away.end();
  const keep = t.store.listQuestions(100).filter((q) => q.details?.order);
  // Done (a) is shown as done; b failed and c never ran: each asks.
  assert.deepEqual(keep.map((q) => q.details!.order!.orderId).sort(), [2, 3]);
  assert.equal(t.store.getOrder(1)!.status, 'done');
  assert.deepEqual([2, 3].map((id) => t.store.getOrder(id)!.status), ['waiting', 'waiting']);
  const b = keep.find((q) => q.details!.order!.orderId === 2)!;
  assert.deepEqual(b.options, [KEEP, DROP]);
  assert.match(b.question, /Not done\.\*\* The last problem: exit code 2: denied by the server\./);
  assert.match(statusText(t.store.getOrder(2)!, 'Simon'), new RegExp(`^waiting on your word \\(Ledung question #${b.id}\\)$`));
  // First in Waiting for you, ahead of the manager's own question of the same tier and rank.
  const lists = waitingLists(t.store.listQuestions(100), () => 'p', () => ['Blocks a finished PR'], () => true, ['Blocks a finished PR']);
  assert.deepEqual(lists.forYou.slice(0, 2).map((i) => !!i.q.details?.order), [true, true]);
  assert.equal(lists.forYou[2]!.q.id, ordinary.id);
  // Waiting allows nothing.
  assert.equal(await w2.decide('scripts/b.sh', 'b2'), null);
  // Keep: open again, and it runs; the manager is told.
  t.store.answerQuestion(b.id, KEEP, 'user', null, true);
  t.orders.answered(t.store.getQuestion(b.id)!);
  assert.equal(t.store.getOrder(2)!.status, 'open');
  assert.equal(await w2.decide('scripts/b.sh', 'b3'), 'allow');
  const told = buildDelivery('Simon', [t.store.getQuestion(b.id)!], [], () => 'x', (id) => t.store.getOrder(id));
  assert.match(told.userText, /Simon answered Ledung's question #\d+ about order #2: keep it\. Order #2 is open again and is your top item/);
  // Drop: ended.
  const c = keep.find((q) => q.details!.order!.orderId === 3)!;
  t.store.answerQuestion(c.id, DROP, 'user', null, true);
  t.orders.answered(t.store.getQuestion(c.id)!);
  assert.equal(t.store.getOrder(3)!.status, 'dropped');
  assert.equal(await (await t.hooksOf('w3')).decide('scripts/c.sh', 'c1'), null);
  // Settled once: Back again, or a restart, asks nothing more.
  t.away.begin();
  assert.equal(t.store.listQuestions(100).filter((q) => q.details?.order).length, 2);
});

test('a period that ran out while Ledung was stopped is settled at the next start', async () => {
  const t = setup();
  t.goAway(['ordered']);
  await t.management.startSession('mgr', { task: 'Go.', order: { command: DEPLOY, question: t.answered('Yes, publish') } });
  t.away.stop();
  // The period's end passes with nothing running: wind its time back, then start again.
  const meta = JSON.parse(t.store.getMeta('away')!);
  t.store.setMeta('away', JSON.stringify({ ...meta, since: meta.since - 2000, until: Date.now() - 1000 }));
  t.store.database.prepare('UPDATE orders SET created_at = ?').run(Date.now() - 1500);
  assert.equal(t.store.listQuestions(100).filter((q) => q.details?.order).length, 0);
  t.away.begin();
  t.away.stop();
  assert.equal(t.store.listQuestions(100).filter((q) => q.details?.order).length, 1);
});
