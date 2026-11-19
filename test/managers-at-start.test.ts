// The managers that were running when Ledung stopped come back by themselves at start (#391; Martin, Ledung question
// #541: "a — Those that were running, start now"): only those, never one stopped on purpose, nor an ordinary session.
// Two stops are covered: a clean one (shutdown() writes the live managers down before it stops them) and one that never
// reached shutdown (a crash or reboot: the database still calls them running). The expected sets below follow from the
// issue's Done bullets, not from running the code.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import type { SessionStatus } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const NO_CLAUDE = 'no Claude Code in tests';
const prepare = LocalRunner.prototype.prepare;
LocalRunner.prototype.prepare = async function () { throw new Error(NO_CLAUDE); };

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-managers-at-start-')));
const home = path.join(base, 'home');
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.LEDUNG_DATA_DIR = path.join(home, 'ledung-data');
fs.mkdirSync(process.env.LEDUNG_DATA_DIR, { recursive: true });
const NAMES = ['clean', 'crashed', 'stopped', 'attached', 'stopping', 'never'];
for (const n of NAMES) fs.mkdirSync(path.join(home, n), { recursive: true });

const made: SessionManager[] = [];
after(() => {
  LocalRunner.prototype.prepare = prepare;
  for (const m of made) m.detachAll();
  removeTemp(base);
});

const config = parseConfig({
  userName: 'Simon', browseRoots: [home],
  projects: NAMES.map((n) => ({ name: n, runner: 'local', path: path.join(home, n) })),
});

function ledung(store = new Store(openDatabase(':memory:'))) {
  const manager = refuseRealSignInStores(new SessionManager(config, store, () => {}));
  made.push(manager);
  return { store, manager };
}

/** A session in the store, as the database has it; a manager is made its project's manager. */
function session(t: ReturnType<typeof ledung>, id: string, project: string, status: SessionStatus, opts: { manager?: boolean; current?: boolean; resumable?: boolean; reason?: string } = {}) {
  const manager = opts.manager ?? true;
  t.store.createSession({ id, project, runner: 'local', title: manager ? `Manager: ${project}` : 'Worker', parentId: null, permissionMode: 'default', ...(manager ? { role: 'manager' as const } : {}) });
  t.store.updateSession(id, { status, claudeSessionId: opts.resumable === false ? null : `cc-${id}`, ...(opts.reason ? { endReason: opts.reason } : {}) });
  if (manager && opts.current !== false) t.manager.projectStore.setManager(project, id);
}

test('#391: a clean stop writes down the live managers, and the next start finds exactly those', async () => {
  const before = ledung();
  // Live when Ledung is stopped: two managers (one idle, one working), one manager being stopped right then, a worker.
  session(before, 'm-clean', 'clean', 'idle');
  session(before, 'm-crashed', 'crashed', 'running');
  session(before, 'm-stopping', 'stopping', 'stopping');
  session(before, 'w-1', 'clean', 'running', { manager: false });
  // Stopped on purpose earlier: ended, and no longer live.
  session(before, 'm-stopped', 'stopped', 'ended', { reason: 'Stopped by manager "Manager: clean" with stop_manager.' });
  const live = (before.manager as unknown as { live: Map<string, unknown> }).live;
  for (const id of ['m-clean', 'm-crashed', 'm-stopping', 'w-1']) {
    // Stands in for a running Session: its info, and a stop that ends it in the store as Session.stop does.
    live.set(id, {
      get info() { return before.store.getSession(id)!; },
      stop: async (reason: string) => { before.store.updateSession(id, { status: 'ended', endReason: reason }); },
    });
  }
  await before.manager.shutdown();
  for (const id of ['m-clean', 'm-crashed', 'm-stopping', 'w-1']) assert.equal(before.store.getSession(id)!.status, 'ended', `${id} stopped`);
  // The next start, on the same database: every one of them is 'ended' now, so only the written record tells them apart.
  const next = ledung(before.store);
  const found = next.manager.managersRunningAtStop([]);
  assert.deepEqual([...found].sort(), ['m-clean', 'm-crashed']);
  // Once the resume step has run, the record is spent: a later start that follows no stop of its own resumes nobody.
  await next.manager.resumeManagersAtStart(found);
  assert.deepEqual(ledung(before.store).manager.managersRunningAtStop([]), []);
});

test('#391: a start that fails before its resume step (a port in use) leaves every manager found for the next start', () => {
  const first = ledung();
  // One written down at a clean stop, one the database still calls running after a crash.
  session(first, 'm-clean', 'clean', 'ended', { reason: 'Ledung was shut down. Resume to continue.' });
  session(first, 'm-crashed', 'crashed', 'running');
  first.store.setMeta('managers-at-stop', JSON.stringify(['m-clean']));
  assert.deepEqual(first.manager.managersRunningAtStop([]).sort(), ['m-clean', 'm-crashed']);
  // That start marks the rest ended, as main.ts does, and then fails: no resume step.
  first.store.markUnfinishedSessionsEnded('Ledung stopped before this session ended. Resume to continue.');
  assert.equal(first.store.getSession('m-crashed')!.status, 'ended');
  assert.deepEqual(ledung(first.store).manager.managersRunningAtStop([]).sort(), ['m-clean', 'm-crashed'], 'both still found');
});

test("#391: an away period that ran out while Ledung was off reaches the managers coming back, not one stopped on purpose", () => {
  const t = ledung();
  session(t, 'm-clean', 'clean', 'ended', { reason: 'Ledung was shut down. Resume to continue.' });
  session(t, 'm-stopped', 'stopped', 'ended', { reason: 'Stopped by Simon.' });
  t.store.setMeta('managers-at-stop', JSON.stringify(['m-clean']));
  assert.deepEqual(t.manager.managersRunningAtStop([]), ['m-clean']);
  // The note away mode sends to the managers when a period ends (Away's notify), before the resume step runs.
  (t.manager as unknown as { tellManagers(text: string): void }).tellManagers('Away ended.');
  assert.deepEqual(t.store.undeliveredInbox('m-clean').map((i) => i.text), ['Away ended.'], 'waits for its resume');
  assert.deepEqual(t.store.undeliveredInbox('m-stopped'), []);
});

test('#391: after a stop that never reached shutdown, the managers the database still calls running are found; nothing else is', () => {
  const t = ledung();
  session(t, 'm-crashed', 'crashed', 'running');
  session(t, 'm-clean', 'clean', 'waiting');
  session(t, 'm-stopped', 'stopped', 'ended', { reason: 'Stopped by Simon.' });
  session(t, 'm-attached', 'attached', 'idle');
  session(t, 'm-stopping', 'stopping', 'stopping');
  // An earlier manager of a project that has a newer one: not the project's manager any more.
  session(t, 'm-old', 'never', 'running', { current: false });
  // An ordinary session in the very state that brings the managers back.
  session(t, 'w-1', 'crashed', 'running', { manager: false });
  assert.deepEqual(t.manager.managersRunningAtStop(['m-attached']).sort(), ['m-clean', 'm-crashed']);
});

test('#391: each manager found is resumed in turn; one that fails says so in its chat and the next is still tried', async () => {
  const t = ledung();
  session(t, 'm-clean', 'clean', 'ended', { reason: 'Ledung was shut down. Resume to continue.' });
  session(t, 'm-crashed', 'crashed', 'ended', { reason: 'Ledung stopped before this session ended. Resume to continue.' });
  // Never got far enough to resume: left alone, as the page's Resume would refuse it.
  session(t, 'm-never', 'never', 'ended', { resumable: false });
  await t.manager.resumeManagersAtStart(['m-clean', 'm-crashed', 'm-never']);
  const events = (id: string) => t.store.listMessages(id).filter((m) => m.kind === 'event').map((m) => String((m.data as { text?: string }).text));
  // Both were tried: the real resume ran up to starting Claude Code, which this test has none of.
  for (const id of ['m-clean', 'm-crashed']) {
    const said = events(id).filter((e) => e.includes('when Ledung started'));
    assert.equal(said.length, 1, `${id}: one line about it`);
    assert.match(said[0]!, /It was running when Ledung stopped, but could not be resumed when Ledung started: .*no Claude Code in tests/);
  }
  assert.deepEqual(events('m-never').filter((e) => e.includes('when Ledung started')), []);
});
