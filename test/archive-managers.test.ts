// A project's old, ended managers can be archived (issue #515; Martin, 2026-11-27: "Now kill the two unused managers in
// local-gen. I do NOT want them there"): an ended manager that is not its project's current manager (projects.managerId)
// is archived like any ended session, from the page and with archive_session by the project's current manager; the
// current manager stays refused. A manager that never got a session id, replaced by a fresh one (#514), is archived by
// itself. The expected outcomes follow from the issue's Done bullets, not from running the code.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { Management } from '../src/sessions/management.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import type { SessionStatus } from '../src/shared/protocol.ts';
import { isReplacedManager, sessionActions } from '../web/src/sidebarMenu.ts';
import { sessionControls } from '../web/src/sessionMenu.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const NO_CLAUDE = 'no Claude Code in tests';
const prepare = LocalRunner.prototype.prepare;
LocalRunner.prototype.prepare = async function () { throw new Error(NO_CLAUDE); };

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-archive-managers-')));
const home = path.join(base, 'home');
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.LEDUNG_DATA_DIR = path.join(home, 'ledung-data');
fs.mkdirSync(process.env.LEDUNG_DATA_DIR, { recursive: true });
for (const n of ['gen', 'other']) fs.mkdirSync(path.join(home, n), { recursive: true });

const made: SessionManager[] = [];
after(() => {
  LocalRunner.prototype.prepare = prepare;
  for (const m of made) m.detachAll();
  removeTemp(base);
});

const config = parseConfig({
  userName: 'Simon', browseRoots: [home],
  projects: ['gen', 'other'].map((n) => ({ name: n, runner: 'local', path: path.join(home, n) })),
});

function ledung() {
  const store = new Store(openDatabase(':memory:'));
  const events: string[] = [];
  const manager = refuseRealSignInStores(new SessionManager(config, store, (e) => {
    if (e.type === 'message' && e.message.kind === 'event') events.push(`${e.message.sessionId}: ${(e.message.data as { text: string }).text}`);
  }));
  made.push(manager);
  const mgr = (id: string, project: string, status: SessionStatus, opts: { current?: boolean; talked?: boolean } = {}) => {
    store.createSession({ id, project, runner: 'local', title: `Manager: ${project}`, parentId: null, permissionMode: 'default', role: 'manager' });
    store.updateSession(id, { status, claudeSessionId: opts.talked === false ? null : `cc-${id}` });
    if (opts.current) manager.projectStore.setManager(project, id);
  };
  const management = (manager as unknown as { management: Management }).management;
  return { store, manager, events, mgr, management };
}

test('#515: an ended manager its project replaced is archived from the page; the current one stays refused', () => {
  const t = ledung();
  t.mgr('old-1', 'gen', 'ended', { talked: false });
  t.mgr('old-2', 'gen', 'ended');
  t.mgr('now', 'gen', 'ended', { current: true });
  // The current manager first: refused, even ended, and nothing changes.
  assert.throws(() => t.manager.archive('now'), /current manager can't be archived/);
  assert.equal(t.store.getSession('now')!.archivedAt, null);
  // The two it replaced, the one that never talked too: archived, nothing deleted.
  assert.ok(t.manager.archive('old-1').archivedAt);
  assert.ok(t.manager.archive('old-2').archivedAt);
  assert.deepEqual(t.events, ['old-1: Archived by Simon.', 'old-2: Archived by Simon.']);
  assert.ok(t.store.getSession('old-1') && t.store.getSession('old-2'), 'the sessions stay');
  // And back, as any archived session.
  assert.equal(t.manager.unarchive('old-1').archivedAt, null);
});

test('#515: a replaced manager that still runs is not archived; it is stopped first, like any session', () => {
  const t = ledung();
  t.mgr('old', 'gen', 'idle');
  t.mgr('now', 'gen', 'idle', { current: true });
  assert.throws(() => t.manager.archive('old'), /Only an ended session/);
  t.store.updateSession('old', { status: 'ended' });
  assert.ok(t.manager.archive('old').archivedAt);
});

test('#515: archive_session by the project\'s current manager archives an old one; other managers and the current one are refused', () => {
  const t = ledung();
  t.mgr('old', 'gen', 'ended');
  t.mgr('now', 'gen', 'idle', { current: true });
  t.mgr('elsewhere', 'other', 'idle', { current: true });
  t.mgr('other-old', 'other', 'ended');
  // The current manager finds the old one's id in list_sessions; another project's manager doesn't see it there.
  assert.match(t.management.listSessions('now'), /Old managers of gen, replaced by you[^\n]*\n- "Manager: gen" \(old\): /);
  assert.doesNotMatch(t.management.listSessions('elsewhere'), /\(old\)/);
  assert.match(t.management.listSessions('elsewhere'), /\(other-old\)/, 'its own project\'s old one, though');
  // Another project's manager can't reach it, and the current manager can't archive another project's old one.
  assert.throws(() => t.management.archiveSession('elsewhere', 'old'), /not one you started/);
  assert.throws(() => t.management.archiveSession('now', 'other-old'), /not one you started/);
  assert.equal(t.store.getSession('old')!.archivedAt, null);
  assert.match(t.management.archiveSession('now', 'old'), /^Archived "Manager: gen"/);
  assert.ok(t.store.getSession('old')!.archivedAt);
  assert.ok(t.events.includes('old: Archived by manager "Manager: gen".'));
  assert.doesNotMatch(t.management.listSessions('now'), /Old managers/, 'archived: no longer listed');
  // The current manager itself, ended: not its own session, and refused all the same.
  t.store.updateSession('now', { status: 'ended' });
  assert.throws(() => t.management.archiveSession('now', 'now'), /not one you started/);
  assert.equal(t.store.getSession('now')!.archivedAt, null);
});

test('#515 (optional bullet): a fresh manager replacing one that never got a session id archives the dead one', async () => {
  const t = ledung();
  t.mgr('dead', 'gen', 'ended', { talked: false, current: true });
  // Claude Code can't start in tests, so the new manager ends too; what counts is what happened to the dead one.
  const fresh = await t.manager.start('gen', undefined, { role: 'manager' }).catch(() => undefined);
  const now = t.manager.projectStore.get('gen')!.managerId!;
  assert.notEqual(now, 'dead', 'a new manager took its place');
  if (fresh) assert.equal(fresh.id, now);
  assert.ok(t.store.getSession('dead')!.archivedAt, 'the dead one is archived');
  assert.ok(t.events.includes('dead: Archived by Ledung (a new manager replaced it).'));
  assert.equal(t.store.getSession(now)!.title, 'Manager: gen', 'the name carries over, as before (#223)');
});

test('#515 (optional bullet): a replaced manager not yet ended is left alone, not archived', async () => {
  const t = ledung();
  // Never got a session id, but still starting: replaced (as #223 has it), not archived.
  t.mgr('starting', 'gen', 'starting', { talked: false, current: true });
  await t.manager.start('gen', undefined, { role: 'manager' }).catch(() => undefined);
  assert.notEqual(t.manager.projectStore.get('gen')!.managerId, 'starting');
  assert.equal(t.store.getSession('starting')!.archivedAt, null);
});

test('#515: the page offers Archive on an ended replaced manager, in the sidebar menu and the header; never on the current one', () => {
  const projects = [{ name: 'gen', managerId: 'now' }];
  const row = (id: string) => ({ id, role: 'manager' as const, project: 'gen', status: 'ended' as const, paused: false, claudeSessionId: 'c', archivedAt: null, compacting: null, clearDue: null, claudeVersion: null });
  assert.equal(isReplacedManager(row('old'), projects), true);
  assert.equal(isReplacedManager(row('now'), projects), false);
  assert.equal(isReplacedManager(row('old'), []), false, 'a project the page does not know: not replaced, as on the server');
  assert.equal(isReplacedManager({ ...row('old'), role: 'session' }, projects), false, 'only managers');
  const old = { ...row('old'), replaced: isReplacedManager(row('old'), projects) };
  const now = { ...row('now'), replaced: isReplacedManager(row('now'), projects) };
  assert.ok(sessionActions(old, false).includes('archive'));
  assert.ok(!sessionActions(now, false).includes('archive'));
  assert.deepEqual(sessionControls(old).header, ['resume', 'archive']);
  assert.deepEqual(sessionControls(now).header, ['resume']);
  // Not while it runs, and no Stop and archive for a manager; not again once archived.
  const running = sessionActions({ ...old, status: 'idle' }, false);
  assert.ok(!running.includes('archive') && !running.includes('stopArchive'));
  assert.ok(!sessionActions({ ...old, archivedAt: 1 }, false).includes('archive'));
});
