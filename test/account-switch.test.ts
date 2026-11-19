// Changing a project's or chats' account switches its running sessions (issue #395; Simon, 2026-11-19: "If I switch
// account, it should switch. I shouldn't have to manually restart the manager. Same for underlying chats."). At the
// session's next quiet moment, or at once on Switch now; a switch that fails leaves it on its old account, once.
// Claude Code is never started here: a session's start, stop and idle state are the test's own, and its account is
// what the session was given (the env of a throwaway sign-in folder), never a real login.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, type ProjectConfig } from '../src/config.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { CHATS, type SessionInfo } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-switch-')));
const home = path.join(base, 'home');
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.LEDUNG_DATA_DIR = path.join(home, 'ledung-data');
const shop = path.join(home, 'shop');
fs.mkdirSync(process.env.LEDUNG_DATA_DIR, { recursive: true });
fs.mkdirSync(shop, { recursive: true });

/** The account a start was given, by session; an account named "broken" refuses to start, as a signed-out one does. */
const starts: { id: string; account: string | null }[] = [];
const stops: { id: string; reason: string }[] = [];
const original = { start: Session.prototype.start, stop: Session.prototype.stop, deliver: Session.prototype.deliver };
type Internals = { account: { name: string } | null; store: Store; id: string };
Session.prototype.start = async function (this: Session) {
  const self = this as unknown as Internals;
  const account = self.account?.name ?? null;
  starts.push({ id: this.id, account });
  if (account === 'broken') {
    self.store.updateSession(this.id, { status: 'ended', endedAt: Date.now(), endReason: 'Not signed in: run claude /login for "broken".' });
    return;
  }
  self.store.updateSession(this.id, { status: 'idle' });
};
Session.prototype.stop = async function (this: Session, reason = 'Stopped.') {
  const self = this as unknown as Internals;
  stops.push({ id: this.id, reason });
  self.store.addMessage(this.id, 'event', { text: reason });
  self.store.updateSession(this.id, { status: 'ended', endedAt: Date.now(), endReason: reason });
};
Session.prototype.deliver = function () {};

const made: SessionManager[] = [];
after(() => {
  Object.assign(Session.prototype, original);
  for (const m of made) m.detachAll();
  removeTemp(base);
});

/** What the quiet check reads, per session: a turn running, background work, a prompt open. */
const busy = new Map<string, { turnOpen?: boolean; backgroundTasks?: number; pendingPermissions?: number; crons?: number }>();

function ledung(store = new Store(openDatabase(':memory:'))) {
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    userName: 'Simon', browseRoots: [home], chats: { folder: home },
    workflow: { folder: base, managerFile: 'LEAD.md', sessionFile: 'WORKER.md', projectConfig: 'docs/config.md' },
    projects: [{ name: 'shop', runner: 'local', path: shop }],
  }), store, () => {}));
  made.push(manager);
  manager.checkSignInWith = async () => ({ state: 'in', method: 'claude.ai', detail: null, checkedAt: 0 });
  manager.signOutWith = async () => {};
  for (const name of ['a', 'b', 'broken']) if (!manager.accounts.get(name)) manager.addAccount({ name, kind: 'folder' });
  const live = (manager as unknown as { live: Map<string, unknown> }).live;
  return { manager, store, live };
}

/** A running session of a project or chats, live in this manager, as if Claude Code ran on `account`. */
function running(m: ReturnType<typeof ledung>, id: string, project: string, account: string | null, extra: Partial<SessionInfo> = {}): void {
  m.store.createSession({ id, project, runner: 'local', title: id, parentId: null, permissionMode: 'acceptEdits', workDir: project === CHATS ? home : null, profile: 'full', requestedModel: 'haiku' });
  m.store.updateSession(id, { status: 'idle', claudeSessionId: `claude-${id}`, account, ...extra });
  liveFake(m, id);
}

/** A live session the manager can stop and resume: a stand-in for one reattached after a restart. */
function liveFake(m: ReturnType<typeof ledung>, id: string): void {
  m.live.set(id, {
    id,
    get info() { return m.store.getSession(id)!; },
    idleState: () => {
      const info = m.store.getSession(id)!;
      const b = busy.get(id) ?? {};
      return { info, turnOpen: !!b.turnOpen, pendingPermissions: b.pendingPermissions ?? 0, openQuestions: 0, waitingDeliveries: 0, backgroundTasks: b.backgroundTasks ?? 0, facts: { backgroundTasks: 0, crons: b.crons ?? 0 }, lastActivity: 0 };
    },
    stop: (reason: string) => Session.prototype.stop.call({ id, store: m.store } as never, reason),
    detach: () => {},
  });
}

function setProjectAccount(manager: SessionManager, account: string | null): void {
  const current = (manager as unknown as { projectStore: { get(n: string): { config: ProjectConfig } } }).projectStore.get('shop').config;
  const { account: _, ...rest } = current;
  manager.updateProject('shop', (account ? { ...rest, account } : rest) as ProjectConfig);
}

/** Until no switch or resume is under way: a settings change starts the quiet check without waiting for it. */
async function settled(m: ReturnType<typeof ledung>): Promise<void> {
  const inner = m.manager as unknown as { switching: Set<string>; resuming: Map<string, unknown> };
  for (let i = 0; i < 200 && (inner.switching.size || inner.resuming.size); i++) await new Promise((r) => setTimeout(r, 5));
}

const events = (store: Store, id: string) => store.allMessages(id).filter((m) => m.kind === 'event').map((m) => (m.data as { text: string }).text);
const liveAccount = (m: ReturnType<typeof ledung>, id: string) => (m.live.get(id) as Internals | undefined)?.account?.name ?? null;

test("a project's new account: its running sessions wait for a quiet moment, then switch keeping their conversation and settings", async () => {
  const m = ledung();
  setProjectAccount(m.manager, 'a');
  running(m, 'mgr', 'shop', 'a', { role: 'manager' } as never);
  running(m, 'worker', 'shop', 'a');
  busy.set('mgr', { turnOpen: true });
  busy.set('worker', { backgroundTasks: 1 });
  setProjectAccount(m.manager, 'b');
  await m.manager.relaunchWaiting();
  for (const id of ['mgr', 'worker']) {
    assert.deepEqual(m.store.getSession(id)!.accountSwitch, { to: 'b' }, 'waits to switch, shown on the session');
    assert.equal(m.store.getSession(id)!.account, 'a');
  }
  assert.deepEqual(stops, [], 'a running turn and background work are never interrupted');
  // The manager's turn ends; the worker's background command is still going.
  busy.delete('mgr');
  assert.deepEqual(await m.manager.relaunchWaiting(), ['mgr']);
  const mgr = m.store.getSession('mgr')!;
  assert.equal(mgr.account, 'b');
  assert.equal(liveAccount(m, 'mgr'), 'b', "Claude Code was resumed with the new account's sign-in");
  assert.equal(mgr.accountSwitch, null);
  assert.equal(mgr.claudeSessionId, 'claude-mgr', 'the same conversation');
  assert.equal(mgr.permissionMode, 'acceptEdits');
  assert.equal(mgr.requestedModel, 'haiku');
  assert.equal(mgr.profile, 'full');
  assert.ok(events(m.store, 'mgr').includes('Now on the account "b".'));
  assert.deepEqual(m.store.getSession('worker')!.accountSwitch, { to: 'b' }, 'still waiting');
  // A scheduled wake-up or an open prompt holds it too; then it switches.
  busy.set('worker', { crons: 1 });
  assert.deepEqual(await m.manager.relaunchWaiting(), []);
  busy.set('worker', { pendingPermissions: 1 });
  assert.deepEqual(await m.manager.relaunchWaiting(), []);
  busy.delete('worker');
  // Resumed and not spoken to since ("starting", shown as Ready) is as quiet as idle; with no Claude Code session id
  // yet it can't be resumed, so it waits for one.
  m.store.updateSession('worker', { status: 'starting', claudeSessionId: null });
  assert.deepEqual(await m.manager.relaunchWaiting(), []);
  m.store.updateSession('worker', { claudeSessionId: 'claude-worker' });
  assert.deepEqual(await m.manager.relaunchWaiting(), ['worker']);
  assert.equal(m.store.getSession('worker')!.account, 'b');
});

test('changed back before it switched, a session stops waiting; Switch now switches a busy one at once', async () => {
  const m = ledung();
  setProjectAccount(m.manager, 'a');
  running(m, 'w1', 'shop', 'a');
  busy.set('w1', { turnOpen: true });
  setProjectAccount(m.manager, 'b');
  assert.deepEqual(m.store.getSession('w1')!.accountSwitch, { to: 'b' });
  setProjectAccount(m.manager, 'a');
  assert.equal(m.store.getSession('w1')!.accountSwitch, null, 'nothing left to switch');
  setProjectAccount(m.manager, null);
  assert.deepEqual(m.store.getSession('w1')!.accountSwitch, { to: null }, "to the computer's own login");
  const stopped = stops.length;
  await m.manager.accountSwitchAction('w1', 'now');
  assert.equal(stops.length, stopped + 1);
  assert.match(stops.at(-1)!.reason, /^Stopped by Simon to switch to the computer's own login now/);
  assert.equal(m.store.getSession('w1')!.account, null);
  assert.equal(m.store.getSession('w1')!.accountSwitch, null);
  assert.ok(events(m.store, 'w1').includes("Now on the computer's own login."));
  await assert.rejects(m.manager.accountSwitchAction('w1', 'now'), /not waiting to switch/);
  busy.delete('w1');
});

test("a switch that fails leaves the session on its old account, says so, and isn't tried again on its own", async () => {
  const m = ledung();
  setProjectAccount(m.manager, 'a');
  running(m, 'w2', 'shop', 'a');
  setProjectAccount(m.manager, 'broken');
  await settled(m);
  const info = m.store.getSession('w2')!;
  assert.equal(info.account, 'a', 'resumed on the account it had');
  assert.equal(info.status, 'idle', JSON.stringify(events(m.store, 'w2')));
  assert.equal(liveAccount(m, 'w2'), 'a');
  assert.deepEqual(info.accountSwitch, { to: 'broken', failed: 'Not signed in: run claude /login for "broken".' });
  assert.ok(events(m.store, 'w2').some((t) => t === `Couldn't switch to the account "broken", so it stays on the account "a"; why is above.`));
  const tries = starts.filter((s) => s.id === 'w2').length;
  liveFake(m, 'w2');
  await m.manager.relaunchWaiting();
  m.manager.relaunchChanged();
  await m.manager.relaunchWaiting();
  assert.equal(starts.filter((s) => s.id === 'w2').length, tries, 'no loop');
  await assert.rejects(m.manager.accountSwitchAction('w2', 'now'), /use Try again/);
  // Signed in now: Try again lets it switch at its next quiet moment.
  m.manager.updateProject('shop', { ...(m.manager as unknown as { projectStore: { get(n: string): { config: ProjectConfig } } }).projectStore.get('shop').config });
  await m.manager.accountSwitchAction('w2', 'retry');
  await settled(m);
  assert.equal(m.store.getSession('w2')!.accountSwitch?.failed, 'Not signed in: run claude /login for "broken".', 'still broken: failed again, once');
  // Another account chosen: it waits again, and switches.
  liveFake(m, 'w2');
  setProjectAccount(m.manager, 'b');
  await settled(m);
  assert.equal(m.store.getSession('w2')!.account, 'b');
  assert.equal(m.store.getSession('w2')!.accountSwitch, null);
});

test("the chats' account: running chats on it switch, a chat started on another keeps its own", async () => {
  const m = ledung();
  m.manager.setAccountChoices({ chats: 'a' });
  running(m, 'chat-a', CHATS, 'a');
  running(m, 'chat-other', CHATS, 'b');
  m.manager.setAccountChoices({ chats: 'b' });
  await settled(m);
  assert.equal(m.store.getSession('chat-a')!.account, 'b');
  assert.equal(liveAccount(m, 'chat-a'), 'b');
  assert.equal(m.store.getSession('chat-a')!.workDir, home, 'in its own folder');
  assert.equal(m.store.getSession('chat-other')!.account, 'b');
  assert.equal(m.store.getSession('chat-other')!.accountSwitch ?? null, null, 'never touched');
  assert.equal(starts.filter((s) => s.id === 'chat-other').length, 0, 'not restarted');
});

test('a pending switch outlives Restart Ledung and happens afterwards', async () => {
  const store = new Store(openDatabase(':memory:'));
  const before = ledung(store);
  setProjectAccount(before.manager, 'a');
  running(before, 'w3', 'shop', 'a');
  busy.set('w3', { turnOpen: true });
  setProjectAccount(before.manager, 'b');
  before.live.delete('w3');
  // The new Ledung on the same database: the session reattached, still mid-turn.
  const later = ledung(store);
  liveFake(later, 'w3');
  later.manager.relaunchChanged();
  assert.deepEqual(store.getSession('w3')!.accountSwitch, { to: 'b' });
  busy.delete('w3');
  assert.deepEqual(await later.manager.relaunchWaiting(), ['w3']);
  assert.equal(store.getSession('w3')!.account, 'b');
});

test('the page words a switch as the issue says: waiting, resuming on it, or failed with its reason', async () => {
  const { switchState, switchTooltip } = await import('../web/src/accountSwitch.ts');
  assert.deepEqual(switchState({ accountSwitch: { to: 'b' }, status: 'idle', account: 'a' }), { kind: 'pending', text: 'Switches to b when this turn ends' });
  assert.deepEqual(switchState({ accountSwitch: { to: null }, status: 'running', account: 'a' }), { kind: 'pending', text: "Switches to the computer's own login when this turn ends" });
  assert.equal(switchTooltip({ accountSwitch: { to: 'b' }, status: 'ended', account: 'a' }), 'Resumes on b');
  assert.deepEqual(switchState({ accountSwitch: { to: 'b', failed: 'Not signed in.' }, status: 'idle', account: 'a' }), { kind: 'failed', text: "Couldn't switch to b; still on a.", reason: 'Not signed in.' });
  assert.equal(switchState({ accountSwitch: null, status: 'idle', account: 'a' }), null);
  assert.equal(switchTooltip({ status: 'idle', account: 'a' }), '');
});
