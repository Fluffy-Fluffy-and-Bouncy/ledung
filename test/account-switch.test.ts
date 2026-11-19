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
import { composerClosed } from '../web/src/accountSwitch.ts';
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
const busy = new Map<string, { turnOpen?: boolean; backgroundTasks?: number; pendingPermissions?: number; crons?: number; repeating?: number; shellRunning?: boolean }>();

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
      return { info, turnOpen: !!b.turnOpen, pendingPermissions: b.pendingPermissions ?? 0, openQuestions: 0, waitingDeliveries: 0, backgroundTasks: b.backgroundTasks ?? 0, facts: { backgroundTasks: 0, crons: b.crons ?? 0, repeating: b.repeating ?? 0 }, lastActivity: 0, shellRunning: !!b.shellRunning };
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
  const inner = m.manager as unknown as { switching: Map<string, unknown>; resuming: Map<string, unknown> };
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
  // Each says what it waits for (acceptance of #395): a turn, or, its turn over, its background work.
  assert.deepEqual(m.store.getSession('mgr')!.accountSwitch, { to: 'b' }, 'waits to switch, shown on the session');
  assert.deepEqual(m.store.getSession('worker')!.accountSwitch, { to: 'b', waitsFor: 'background' });
  for (const id of ['mgr', 'worker']) assert.equal(m.store.getSession(id)!.account, 'a');
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
  assert.deepEqual(m.store.getSession('worker')!.accountSwitch, { to: 'b', waitsFor: 'background' }, 'still waiting');
  // A scheduled wake-up or an open prompt holds it too; then it switches. A repeating wake-up never ends by itself.
  busy.set('worker', { crons: 1 });
  assert.deepEqual(await m.manager.relaunchWaiting(), []);
  assert.deepEqual(m.store.getSession('worker')!.accountSwitch, { to: 'b', waitsFor: 'wakeup' });
  busy.set('worker', { crons: 2, repeating: 1 });
  assert.deepEqual(await m.manager.relaunchWaiting(), []);
  assert.deepEqual(m.store.getSession('worker')!.accountSwitch, { to: 'b', waitsFor: 'repeating' });
  busy.set('worker', { pendingPermissions: 1 });
  assert.deepEqual(await m.manager.relaunchWaiting(), []);
  assert.deepEqual(m.store.getSession('worker')!.accountSwitch, { to: 'b' }, 'a prompt is in a turn');
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
  // A permission prompt open: the switch drops it, and the chat says which (acceptance of #395).
  m.store.createPermission({ id: 'p1', sessionId: 'w1', toolName: 'Bash', input: { command: 'npm   test\n  -- --watch' }, title: null, reason: null });
  await m.manager.accountSwitchAction('w1', 'now');
  assert.ok(events(m.store, 'w1').includes('The open permission prompt (Bash: npm test -- --watch) was dropped by the switch; ask again if it is still needed.'), JSON.stringify(events(m.store, 'w1')));
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

test("the chats' account: running chats on it switch, a chat started on another or picked in New chat keeps its own", async () => {
  const m = ledung();
  m.manager.setAccountChoices({ chats: 'a' });
  running(m, 'chat-a', CHATS, 'a');
  running(m, 'chat-other', CHATS, 'b');
  // On the chats' account, but picked for it in New chat (acceptance of #395): it keeps it.
  running(m, 'chat-picked', CHATS, 'a', { accountChosen: true });
  m.manager.setAccountChoices({ chats: 'b' });
  await settled(m);
  assert.equal(m.store.getSession('chat-a')!.account, 'b');
  assert.equal(liveAccount(m, 'chat-a'), 'b');
  assert.equal(m.store.getSession('chat-a')!.workDir, home, 'in its own folder');
  assert.equal(m.store.getSession('chat-other')!.account, 'b');
  assert.equal(m.store.getSession('chat-other')!.accountSwitch ?? null, null, 'never touched');
  assert.equal(starts.filter((s) => s.id === 'chat-other').length, 0, 'not restarted');
  assert.equal(m.store.getSession('chat-picked')!.account, 'a');
  assert.equal(m.store.getSession('chat-picked')!.accountSwitch ?? null, null);
  assert.equal(starts.filter((s) => s.id === 'chat-picked').length, 0);
});

test('New chat records an account picked there, and only then', async () => {
  const m = ledung();
  const picked = await m.manager.startChat({ account: 'a' });
  const followed = await m.manager.startChat({});
  assert.equal(m.store.getSession(picked.id)!.accountChosen, true);
  assert.equal(m.store.getSession(followed.id)!.accountChosen, false);
});

test("a switch refused for sign-in says so briefly in the chat: the banner at the top has how, so it shows once", async () => {
  const m = ledung();
  const inner = m.manager as unknown as { switching: Map<string, Promise<void>>; switchRefusal(id: string, name: string, r: Promise<unknown>): Promise<unknown> };
  const long = { refuse: 'The account "broken" is not signed in. In PowerShell, run `$env:X="C:\\very\\long"; claude` and type `/login`; then press Check again.' };
  m.manager.checkSignInWith = async () => ({ state: 'out', method: null, detail: null, checkedAt: 0 });
  // Not switching: the start's refusal as it was.
  assert.deepEqual(await inner.switchRefusal('w9', 'broken', Promise.resolve(long)), long);
  inner.switching.set('w9', Promise.resolve());
  assert.deepEqual(await inner.switchRefusal('w9', 'broken', Promise.resolve(long)), { refuse: 'The account "broken" is not signed in; the notice at the top of the page says how to sign in.' });
  assert.ok(m.manager.signedOut().some((s) => s.account === 'broken'), 'the banner shows it');
  // A start that may go on, or warns, is left alone.
  assert.equal(await inner.switchRefusal('w9', 'broken', Promise.resolve(null)), null);
  assert.deepEqual(await inner.switchRefusal('w9', 'broken', Promise.resolve({ warn: 'w' })), { warn: 'w' });
  inner.switching.delete('w9');
});

test('a message sent while the session is being switched waits for the switch and reaches it on the new account', async () => {
  const m = ledung();
  setProjectAccount(m.manager, 'a');
  running(m, 'ws', 'shop', 'a');
  // A stop that takes its time, as the host's does (up to 20 s): the session is "stopping" meanwhile.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fake = m.live.get('ws') as { stop: (reason: string) => Promise<void> };
  fake.stop = async (reason: string) => {
    m.store.updateSession('ws', { status: 'stopping' });
    await gate;
    await Session.prototype.stop.call({ id: 'ws', store: m.store } as never, reason);
  };
  const sent: { id: string; account: string | null; text: string }[] = [];
  const send = Session.prototype.send;
  Session.prototype.send = function (this: Session, text: string) {
    sent.push({ id: this.id, account: (this as unknown as Internals).account?.name ?? null, text });
  };
  try {
    setProjectAccount(m.manager, 'b');
    for (let i = 0; i < 100 && m.store.getSession('ws')!.status !== 'stopping'; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(m.store.getSession('ws')!.status, 'stopping', 'the switch is under way');
    // Marked so, so the page keeps Send working through this "Stopping" (acceptance round 3 of #395).
    assert.deepEqual(m.store.getSession('ws')!.accountSwitch, { to: 'b', underWay: true });
    assert.equal(composerClosed(m.store.getSession('ws')!), false);
    let settledSend = false;
    const sending = m.manager.send('ws', 'my reply').finally(() => { settledSend = true; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settledSend, false, 'neither failed nor sent to the stopping session');
    release();
    await sending;
    assert.deepEqual(sent, [{ id: 'ws', account: 'b', text: 'my reply' }]);
    await settled(m);
    assert.equal(m.store.getSession('ws')!.account, 'b');
    assert.equal(m.store.getSession('ws')!.accountSwitch ?? null, null, 'done, no longer under way');
  } finally {
    Session.prototype.send = send;
  }
});

test('a running "!" command holds the switch, and its end lets it go; a paused session says it waits for that', async () => {
  const m = ledung();
  setProjectAccount(m.manager, 'a');
  running(m, 'sh', 'shop', 'a');
  running(m, 'ps', 'shop', 'a', { paused: true } as never);
  let finish!: () => void;
  const fake = m.live.get('sh') as Record<string, unknown>;
  fake.runShell = () => {
    busy.set('sh', { shellRunning: true });
    return new Promise<void>((r) => { finish = () => { busy.delete('sh'); r(); }; });
  };
  await m.manager.runShell('sh', 'npm run build', false);
  setProjectAccount(m.manager, 'b');
  await settled(m);
  assert.equal(stops.filter((s) => s.id === 'sh').length, 0, 'the command is not ended by a switch');
  assert.deepEqual(m.store.getSession('sh')!.accountSwitch, { to: 'b', waitsFor: 'command' });
  assert.deepEqual(m.store.getSession('ps')!.accountSwitch, { to: 'b', waitsFor: 'paused' });
  assert.deepEqual(await m.manager.relaunchWaiting(), [], 'nor by the minute check');
  finish();
  for (let i = 0; i < 100 && m.store.getSession('sh')!.account !== 'b'; i++) await new Promise((r) => setTimeout(r, 5));
  await settled(m);
  assert.equal(m.store.getSession('sh')!.account, 'b', 'switched once the command ended');
  assert.equal(m.store.getSession('ps')!.account, 'a', 'the paused one still waits');
});

test("Send works while a session stops for an account switch, not for a plain Stop", () => {
  const s = (status: SessionInfo['status'], accountSwitch: SessionInfo['accountSwitch'], claudeSessionId: string | null = 'c1') => ({ status, accountSwitch, claudeSessionId });
  // A plain Stop, also of one that waits to switch: as before, the box takes nothing.
  assert.equal(composerClosed(s('stopping', null)), true);
  assert.equal(composerClosed(s('stopping', { to: 'b' })), true);
  assert.equal(composerClosed(s('stopping', { to: 'b', waitsFor: 'background' })), true);
  // The switch's own stop: the message waits for it and goes on the new account (acceptance round 3 of #395).
  assert.equal(composerClosed(s('stopping', { to: 'b', underWay: true })), false);
  // Otherwise unchanged: running and resumable ended ones take messages, an ended one that can't resume doesn't.
  assert.equal(composerClosed(s('idle', { to: 'b' })), false);
  assert.equal(composerClosed(s('ended', null)), false);
  assert.equal(composerClosed(s('ended', null, null)), true);
});

test('a switch left under way (Ledung stopped mid-switch) waits again and says what for', async () => {
  const m = ledung();
  setProjectAccount(m.manager, 'a');
  running(m, 'uw', 'shop', 'a');
  // In a turn: the plain wait, which a stale mark would otherwise hide (Send kept working through a plain Stop).
  busy.set('uw', { turnOpen: true });
  m.store.updateSession('uw', { accountSwitch: { to: 'b', underWay: true } });
  setProjectAccount(m.manager, 'b');
  assert.deepEqual(await m.manager.relaunchWaiting(), []);
  assert.deepEqual(m.store.getSession('uw')!.accountSwitch, { to: 'b' });
  busy.delete('uw');
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
  // Its turn over, what it still waits for (acceptance of #395).
  assert.equal(switchTooltip({ accountSwitch: { to: 'b', waitsFor: 'background' }, status: 'idle', account: 'a' }), 'Switches to b when its background work ends');
  assert.equal(switchTooltip({ accountSwitch: { to: 'b', waitsFor: 'wakeup' }, status: 'idle', account: 'a' }), 'Switches to b after its scheduled wake-up');
  assert.equal(switchTooltip({ accountSwitch: { to: 'b', waitsFor: 'repeating' }, status: 'idle', account: 'a' }), "Won't switch to b on its own while it has a repeating wake-up; use Switch now");
  assert.equal(switchTooltip({ accountSwitch: { to: 'b', waitsFor: 'paused' }, status: 'idle', account: 'a' }), 'Switches to b once it is unpaused');
  assert.equal(switchTooltip({ accountSwitch: { to: 'b', waitsFor: 'command' }, status: 'idle', account: 'a' }), 'Switches to b when its "!" command ends');
  assert.equal(switchTooltip({ accountSwitch: { to: 'b', underWay: true }, status: 'stopping', account: 'a' }), 'Switching to b now');
  // What to type in a reason shows as code, without its backticks.
  const { reasonParts } = await import('../web/src/accountSwitch.ts');
  assert.deepEqual(reasonParts('Run `claude` and type `/login`.'), [{ text: 'Run ', code: false }, { text: 'claude', code: true }, { text: ' and type ', code: false }, { text: '/login', code: true }, { text: '.', code: false }]);
  assert.equal(switchTooltip({ status: 'idle', account: 'a' }), '');
});
