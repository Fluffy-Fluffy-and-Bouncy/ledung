// waiting_for_you (issue #338): a manager reads what waits for the person from its own project only, in Waiting for
// you's order, with what waits for itself apart and the recent answers; never another project's, Chats' or a secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Management } from '../src/sessions/management.ts';
import { ledungToolServer, type ManagerHandlers } from '../src/sessions/tools.ts';
import { CHATS, type ProjectInfo } from '../src/shared/protocol.ts';
import { tiersOf, type QuestionDetails } from '../src/shared/questions.ts';
import { waitingLists } from '../web/src/waitingLists.ts';

const HOUR = 60 * 60 * 1000;

const info = (name: string, level: 'off' | 'A' = 'off', questionTiers: string[] = []): ProjectInfo => ({
  name, runner: 'local', where: `/home/${name}`, path: `/home/${name}`, account: null, model: 'haiku', managerModel: null, permissionMode: 'auto', managerGrant: null,
  projectToolsUnasked: false, sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] }, devShipCommand: null, tickets: null, questionTiers: tiersOf(questionTiers),
  extraFolders: [], profiles: { manager: null, session: null }, skills: {}, workflow: null, managerId: null, createdAt: 0, colours: { manager: null, sessions: 'same' },
  lockdown: { level, board: false, remoteControl: false },
});

function setup() {
  const store = new Store(openDatabase(':memory:'));
  // A locked secret's value is blanked in everything stored, as Ledung's secrets do (issue #468).
  store.setBlanker({ text: (s) => s.replaceAll('hunter2', '••••'), deep: (d) => JSON.parse(JSON.stringify(d).replaceAll('hunter2', '••••')) });
  const projects = [info('alpha'), info('locked', 'A', ['Now', 'Later'])];
  const m = new Management({
    store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async () => {},
    startSession: async () => { throw new Error('not used'); },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => projects.map((p) => p.name), decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {}, projects: () => projects,
    addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
    ensureManager: async () => { throw new Error('not used'); }, handoffProblem: () => null, shotPath: (_id, f) => f,
  });
  const session = (id: string, project: string, title: string, parentId: string | null = null, role: 'manager' | 'session' = 'session') =>
    store.createSession({ id, project, runner: 'local', title, parentId, permissionMode: 'default', role });
  session('mgr-a', 'alpha', 'Manager: alpha', null, 'manager');
  session('build-a', 'alpha', 'Build', 'mgr-a');
  session('solo-a', 'alpha', 'Solo work');
  session('mgr-l', 'locked', 'Manager: locked', null, 'manager');
  session('build-l', 'locked', 'Locked build', 'mgr-l');
  session('chat', CHATS, 'A chat');
  let t = Date.now() - 10 * HOUR;
  const ask = (sessionId: string, addressedTo: string, question: string, details: QuestionDetails | null = null) => {
    const q = store.createQuestion({ sessionId, question, options: null, addressedTo, details });
    // Ten minutes apart, oldest first, so the age order is known.
    store.database.prepare('UPDATE questions SET asked_at = ? WHERE id = ?').run((t += 10 * 60_000), q.id);
    return q.id;
  };
  const q = {
    process: ask('mgr-a', 'user', '', { title: 'Which test port', tier: 'Process', refs: ['#12'] }),
    review: ask('mgr-a', 'user', '', { title: 'Cart fix', tier: 'Blocks a finished PR', refs: ['PR #212'], review: { solving: 's', done: 'd' }, run: { run: 'run-3', block: 'review', runTitle: 'Cart', blockTitle: 'Simon reviews' } }),
    ranked: ask('solo-a', 'user', '', { title: 'Ranked first', tier: 'Blocks a finished PR', rank: 0 }),
    proposal: ask('mgr-a', 'user', '', { title: 'Workflow change: add a step', tier: 'Process', flowProposal: 4, review: { solving: 's', done: 'd' } }),
    personStep: ask('mgr-a', 'user', '', { title: 'Ship it?', tier: 'Housekeeping', run: { run: 'run-5', block: 'ok', runTitle: 'Ship', blockTitle: 'Go or no' } }),
    refused: ask('build-a', 'user', 'Allow the call?', { title: 'Refused: rm', tier: 'Process', refusal: { toolName: 'Bash', input: { command: 'rm x' }, reason: 'r', toolUseId: 'u' } }),
    untiered: ask('solo-a', 'user', 'An old plain question'),
    forManager: ask('build-a', 'mgr-a', '', { title: 'Which branch', tier: 'Process' }),
    lockedQ: ask('build-l', 'user', '', { title: 'Locked secret plan', tier: 'Now' }),
    chatQ: ask('chat', 'user', '', { title: 'Chat musing', tier: 'Process' }),
  };
  store.createPermission({ id: 'perm-user', sessionId: 'solo-a', toolName: 'Bash', input: { command: 'deploy --token hunter2' }, title: null, reason: null });
  store.createPermission({ id: 'perm-mgr', sessionId: 'build-a', toolName: 'Bash', input: { command: 'npm test' }, title: null, reason: null, addressedTo: 'mgr-a' });
  store.createPermission({ id: 'perm-locked', sessionId: 'build-l', toolName: 'Bash', input: { command: 'locked-cmd' }, title: null, reason: null });
  store.createPermission({ id: 'perm-chat', sessionId: 'chat', toolName: 'Bash', input: { command: 'chat-cmd' }, title: null, reason: null });
  return { store, m, q, projects };
}

/** The question numbers in the order the tool lists them for the person, by their places. */
const placed = (text: string) => [...text.matchAll(/^(\d+)\. #(\d+) /gm)].map((x) => Number(x[2]));

test("waiting_for_you lists the manager's own project only, in Waiting for you's One project order", () => {
  const { store, m, q, projects } = setup();
  const text = m.waitingForYou('mgr-a');
  // The page's own lists (waitingLists) with One project "alpha": the same questions in the same order.
  const projectOf = (id: string) => store.getSession(id)?.project ?? '';
  const tiers = (p: string) => projects.find((x) => x.name === p)?.questionTiers ?? [];
  const page = waitingLists(store.listQuestions(0), projectOf, tiers, (p) => p === 'alpha', tiers('alpha'));
  assert.deepEqual(placed(text), page.forYou.map((i) => i.q.id));
  // Refused call first, then by tier, rank (0 before none), then age; no tier last.
  assert.deepEqual(placed(text), [q.refused, q.ranked, q.review, q.process, q.proposal, q.personStep, q.untiered]);
  const pagePerms = store.pendingPermissions().filter((p) => p.addressedTo === 'user' && projectOf(p.sessionId) === 'alpha');
  assert.match(text, new RegExp(`^Waiting for Simon from "alpha": ${page.forYou.length + pagePerms.length} `));
  assert.match(text, /Permission prompts \(1\):\n- request perm-user from "Solo work"/);
  // Kinds, who asked, refs and runs.
  assert.match(text, new RegExp(`#${q.review} "Cart fix": review, person step of run-3 "Cart" at "Simon reviews"; asked by you .* ago; refs PR #212`));
  assert.match(text, new RegExp(`#${q.proposal} "Workflow change: add a step": workflow proposal 4; asked by you`));
  assert.match(text, new RegExp(`#${q.personStep} "Ship it\\?": question, person step of run-5 "Ship" at "Go or no"`));
  assert.match(text, new RegExp(`#${q.refused} "Refused: rm": refused call \\(Bash\\); asked by "Build"`));
  assert.match(text, /Older, without a tier \(1\):/);
  assert.match(text, /withdraw_question withdraws one of yours/);
  // Never another project's or Chats'.
  assert.doesNotMatch(text, /Locked secret plan|locked-cmd|Chat musing|chat-cmd|perm-locked|perm-chat/);
});

test("what waits for the manager itself is listed apart, and never counted as the person's", () => {
  const { m, q } = setup();
  const text = m.waitingForYou('mgr-a');
  const [forUser, mine] = text.split('\nWaiting for you, not Simon (2):');
  assert.ok(mine, text);
  assert.doesNotMatch(forUser!, new RegExp(`#${q.forManager} |perm-mgr`));
  assert.match(mine!, new RegExp(`- #${q.forManager} "Which branch": question; asked by "Build"`));
  assert.match(mine!, /- request perm-mgr from "Build"/);
});

test("a locked project's manager sees its own items, and no other manager ever does; Chats are never listed", () => {
  const { m, q } = setup();
  const locked = m.waitingForYou('mgr-l');
  assert.match(locked, /^Waiting for Simon from "locked": 2 /);
  assert.match(locked, new RegExp(`1\\. #${q.lockedQ} "Locked secret plan"`));
  assert.match(locked, /Now \(1\):/, "the project's own tiers");
  assert.doesNotMatch(locked, /Cart fix|Which test port|deploy|Chat musing/);
  assert.doesNotMatch(m.waitingForYou('mgr-a'), /locked/i);
  // A manager in Chats, should there be one, gets no list at all.
  const { store, m: m2 } = setup();
  store.createSession({ id: 'mgr-c', project: CHATS, runner: 'local', title: 'Chats manager', parentId: null, permissionMode: 'default', role: 'manager' });
  assert.doesNotMatch(m2.waitingForYou('mgr-c'), /Chat musing|chat-cmd/);
});

test('a prompt is shown as the page shows it, with secret values blanked', () => {
  const { m } = setup();
  const text = m.waitingForYou('mgr-a');
  assert.match(text, /Command:\n\n  ```\n  deploy --token ••••\n  ```/);
  assert.doesNotMatch(text, /hunter2/);
});

test('the answered window: what the person answered from this project, as given, within the hours asked', () => {
  const { store, m, q } = setup();
  store.answerQuestion(q.process, 'Use 4396. The password is hunter2.', 'user');
  store.answerQuestion(q.forManager, 'main', 'mgr-a');
  store.answerQuestion(q.lockedQ, 'Locked answer', 'user');
  store.answerQuestion(q.chatQ, 'Chat answer', 'user');
  const text = m.waitingForYou('mgr-a');
  assert.match(text, new RegExp(`Answered by Simon in the last 24 h \\(1\\), newest first:\n- #${q.process} "Which test port", asked by you; answered under 1 min ago:\n  Use 4396\\. The password is ••••\\.`));
  assert.doesNotMatch(text, /Locked answer|Chat answer|hunter2/);
  assert.doesNotMatch(text, /answered[^\n]*\n  main$/m, "a manager's own answer is not the person's");
  // Outside the window, and with the list turned off.
  store.database.prepare('UPDATE questions SET answered_at = ? WHERE id = ?').run(Date.now() - 30 * HOUR, q.process);
  assert.match(m.waitingForYou('mgr-a'), /Simon answered nothing from "alpha" in the last 24 h\./);
  assert.match(m.waitingForYou('mgr-a', 48), new RegExp(`in the last 48 h \\(1\\)[^]*#${q.process} `));
  assert.doesNotMatch(m.waitingForYou('mgr-a', 0), /answered/i);
});

test('it changes nothing: no answer, decision, withdrawal or read mark', () => {
  const { store, m } = setup();
  const snapshot = () => JSON.stringify([
    store.database.prepare('SELECT * FROM questions ORDER BY id').all(),
    store.database.prepare('SELECT * FROM permissions ORDER BY id').all(),
    store.database.prepare('SELECT * FROM inbox ORDER BY id').all(),
  ]);
  const before = snapshot();
  m.waitingForYou('mgr-a', 720);
  m.waitingForYou('mgr-l');
  assert.equal(snapshot(), before);
});

test("waiting_for_you is a manager's tool, never a session's", () => {
  const served = (role: 'manager' | 'session') => (ledungToolServer({
    userName: 'Simon', role, asksWhom: role === 'manager' ? 'Simon' : 'your manager "M"',
    ask: () => { throw new Error('not called'); }, withdraw: () => '',
    manager: role === 'manager' ? (new Proxy({}, { get: () => () => '' }) as ManagerHandlers) : undefined,
  }).instance as unknown as { _registeredTools: Record<string, { description?: string }>; server: { _instructions?: string } });
  assert.match(served('manager')._registeredTools.waiting_for_you!.description!, /Read-only/);
  assert.match(served('manager').server._instructions!, /waiting_for_you shows what waits for Simon from your project/);
  assert.equal(served('session')._registeredTools.waiting_for_you, undefined);
});
