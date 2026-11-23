// The tools managers learn (issue #431): the record of what managers on this computer call, its seed from what Ledung
// stored, what a manager starting now leaves out, and the workflow's switch. Throwaway sessions and servers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { LEARN_MANAGER_TOOLS_DEFAULT, learnedTools, ManagerTools, ownServersInInit, usedBy, withLearned, type LearnedTools } from '../src/sessions/manager-tools.ts';
import { ProfileSetting } from '../src/sessions/profiles.ts';
import type { SessionOptions } from '../src/sessions/session.ts';
import { LEDUNG_SERVER } from '../src/sessions/tools.ts';
import { effectiveProfiles, parseWorkflowProfiles } from '../src/sessions/workflow-profiles.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { removeTemp } from './temp.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 19, 12);

test('a call shows which server or plugin it used; Ledung\'s own and built-in tools show nothing', () => {
  assert.deepEqual(usedBy('mcp__dns-box__lookup', {}), ['server:dns-box']);
  // A plugin's server: its tools are named mcp__plugin_<plugin>_<server>__<tool> by Claude Code.
  assert.deepEqual(usedBy('mcp__plugin_notes_notes__search', {}), ['server:plugin_notes_notes']);
  assert.deepEqual(usedBy('mcp__claude_ai_Mail__send', {}), ['server:claude_ai_Mail']);
  assert.deepEqual(usedBy('Skill', { skill: 'notes:summarise' }), ['plugin:notes']);
  assert.deepEqual(usedBy('Agent', { subagent_type: 'reviewer-kit:review' }), ['plugin:reviewer-kit']);
  assert.deepEqual(usedBy(`mcp__${LEDUNG_SERVER}__ask_user`, {}), []);
  assert.deepEqual(usedBy('Skill', { skill: 'my-own-skill' }), [], "the user's own skill is no plugin");
  assert.deepEqual(usedBy('Agent', { subagent_type: 'Explore' }), []);
  assert.deepEqual(usedBy('Bash', { command: 'ls' }), []);
});

test("an init message's servers: the user's own, by the name its tools carry; not Ledung's, a profile's or a plugin's", () => {
  assert.deepEqual(ownServersInInit([
    { name: 'dns-box', status: 'connected', source: 'user' },
    { name: 'claude.ai Mail', status: 'connected', source: 'claudeai' },
    { name: LEDUNG_SERVER, status: 'connected', source: 'sdk' },
    { name: 'docs', status: 'connected', source: 'sdk' },
    { name: 'plugin:notes:notes', status: 'connected', source: 'plugin' },
    // An older Claude Code gives no source: Ledung's server and a plugin's are still known by their names.
    { name: LEDUNG_SERVER, status: 'connected' },
    { name: 'plugin:notes:notes', status: 'connected' },
    { name: 'old-box', status: 'failed' },
  ]), ['dns-box', 'claude_ai_Mail', 'old-box']);
  assert.deepEqual(ownServersInInit(undefined), []);
});

test('a manager keeps the plugins and servers called in the last 7 days, never context-mode, and nothing is dropped in the first week', () => {
  const used = new Map([
    ['server:dns-box', NOW - 2 * DAY],
    ['server:plugin_notes_notes', NOW - 6 * DAY],
    ['plugin:reviewer-kit', NOW - DAY],
    ['server:plugin_context-mode_context-mode', NOW - 60_000],
    ['plugin:context-mode', NOW - 60_000],
    ['server:context-mode', NOW - 60_000],
    // Called, but 8 days ago: out of the window.
    ['server:old-box', NOW - 8 * DAY],
    ['plugin:stale-kit', NOW - 8 * DAY],
  ]);
  const seen = ['dns-box', 'old-box', 'never-box', 'context-mode', 'claude_ai_Mail'];
  const installed = ['notes@m', 'reviewer-kit@m', 'context-mode@m', 'stale-kit@m', 'unused@m'];
  assert.deepEqual(learnedTools(used, seen, installed, NOW - 10 * DAY, NOW), {
    // Kept: notes (its server), reviewer-kit (a skill). context-mode goes however recent its calls.
    pluginsOff: ['context-mode@m', 'stale-kit@m', 'unused@m'],
    // Kept: dns-box. A context-mode set up as a plain server goes too.
    serversOff: ['claude_ai_Mail', 'context-mode', 'never-box', 'old-box'],
  });
  // Managers here have run less than a week: nothing is dropped yet; none at all: the same.
  assert.equal(learnedTools(used, seen, installed, NOW - 6 * DAY, NOW), null);
  assert.equal(learnedTools(used, seen, installed, null, NOW), null);
});

test("the learned servers go as whole-server rules only where the profile keeps the user's servers", () => {
  const learned: LearnedTools = { pluginsOff: ['x@m'], serversOff: ['dns-box', 'claude_ai_Mail'] };
  const full = ProfileSetting.parse({ disallowedTools: ['Workflow'] });
  assert.deepEqual(withLearned(full, learned).disallowedTools, ['Workflow', 'mcp__dns-box', 'mcp__claude_ai_Mail']);
  // "none" or a profile's own servers: the user's are gone already (strict), and the profile's own stay.
  const none = ProfileSetting.parse({ mcpServers: 'none' });
  assert.equal(withLearned(none, learned), none);
  const own = ProfileSetting.parse({ mcpServers: { 'dns-box': { command: 'dns' } } });
  assert.equal(withLearned(own, learned), own);
});

/** A store with sessions on this computer whose stored messages hold tool calls and init messages, at given days back. */
function storeWithHistory(now = NOW) {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  let seq = 0;
  const call = (session: string, daysAgo: number, ...tools: [string, unknown][]) => store.addHostLine(session, ++seq, now - daysAgo * DAY, {
    type: 'assistant', parent_tool_use_id: null, message: { content: tools.map(([name, input], i) => ({ type: 'tool_use', id: `t${seq}-${i}`, name, input })) },
  });
  const init = (session: string, daysAgo: number, servers: { name: string; source?: string }[]) => store.addHostLine(session, ++seq, now - daysAgo * DAY, {
    type: 'system', subtype: 'init', mcp_servers: servers.map((s) => ({ status: 'connected', ...s })),
  });
  const session = (id: string, role: 'manager' | 'session', daysAgo: number, project = 'p') => {
    store.createSession({ id, project, runner: 'local', title: id, parentId: null, permissionMode: 'default', role });
    db.prepare('UPDATE sessions SET created_at = ? WHERE id = ?').run(now - daysAgo * DAY, id);
  };
  return { store, call, init, session };
}

/** The record over a store, with its sessions as the session manager hands them over. */
const recordOn = (store: Store) => new ManagerTools(store, {
  sessions: () => store.listSessions().map((s) => ({ id: s.id, manager: s.role === 'manager', createdAt: s.createdAt, endedAt: s.endedAt })),
  lines: (id, since, kind) => store.sdkLines(id, since, kind),
});

test("the record is seeded once from what Ledung stored: managers' calls in the last week, every session's servers", () => {
  const h = storeWithHistory();
  h.session('lead', 'manager', 9);
  h.session('worker', 'session', 3);
  h.init('lead', 5, [{ name: 'dns-box', source: 'user' }, { name: 'mail-box', source: 'user' }, { name: LEDUNG_SERVER, source: 'sdk' }]);
  h.init('worker', 3, [{ name: 'worker-only-box', source: 'project' }]);
  h.call('lead', 2, ['mcp__dns-box__lookup', {}], ['Skill', { skill: 'notes:summarise' }], [`mcp__${LEDUNG_SERVER}__ask_user`, {}]);
  // A worker's calls are not a manager's: mail-box stays unused although a worker called it.
  h.call('worker', 1, ['mcp__mail-box__send', {}]);
  // Called by a manager, but before the window.
  h.call('lead', 8, ['mcp__mail-box__send', {}]);
  const record = recordOn(h.store);
  assert.deepEqual(record.forManager(['notes@m', 'other@m'], NOW), { pluginsOff: ['other@m'], serversOff: ['mail-box', 'worker-only-box'] });
  assert.deepEqual([...h.store.toolUses()].sort(), [['plugin:notes', NOW - 2 * DAY], ['server:dns-box', NOW - 2 * DAY]]);
  // Once: a call stored after the seed reaches the record only as it happens, through noteCalls.
  h.call('lead', 0, ['mcp__mail-box__send', {}]);
  assert.deepEqual(record.forManager(['notes@m'], NOW)!.serversOff, ['mail-box', 'worker-only-box'], 'not read again');
  record.noteCalls([{ type: 'tool_use', name: 'mcp__mail-box__send', input: {} }], NOW);
  assert.deepEqual(record.forManager(['notes@m'], NOW)!.serversOff, ['worker-only-box']);
});

test('noteInit and noteCalls keep the latest time, and a seed does not take a time back', () => {
  const h = storeWithHistory();
  h.session('lead', 'manager', 9);
  h.call('lead', 6, ['mcp__dns-box__lookup', {}]);
  const record = recordOn(h.store);
  record.noteCalls([{ type: 'tool_use', name: 'mcp__dns-box__lookup', input: {} }], NOW - DAY);
  record.noteInit([{ name: 'dns-box', source: 'user' }], NOW);
  record.seed(NOW);
  assert.deepEqual(h.store.toolUses().get('server:dns-box'), NOW - DAY);
  assert.deepEqual(h.store.serversSeen(), ['dns-box']);
});

test("the workflow's profiles file turns learning on; saying nothing, or a broken file, gives the default", () => {
  const computer = { profiles: {}, defaultProfiles: {}, pluginsOff: [] };
  const on = parseWorkflowProfiles('profiles.json', JSON.stringify({ version: 1, learnManagerTools: true, profiles: {} }));
  assert.equal(effectiveProfiles(computer, on).learnManagerTools, true);
  const off = parseWorkflowProfiles('profiles.json', JSON.stringify({ version: 1, learnManagerTools: false, profiles: {} }));
  assert.equal(effectiveProfiles(computer, off).learnManagerTools, false);
  const silent = parseWorkflowProfiles('profiles.json', JSON.stringify({ version: 1, profiles: {} }));
  assert.equal(effectiveProfiles(computer, silent).learnManagerTools, LEARN_MANAGER_TOOLS_DEFAULT);
  assert.equal(effectiveProfiles(computer, parseWorkflowProfiles('profiles.json', '{')).learnManagerTools, LEARN_MANAGER_TOOLS_DEFAULT);
  assert.equal(effectiveProfiles(computer, null).learnManagerTools, LEARN_MANAGER_TOOLS_DEFAULT);
  const wrong = parseWorkflowProfiles('profiles.json', JSON.stringify({ version: 1, learnManagerTools: 'yes', profiles: {} }));
  assert.match(wrong.problem ?? '', /learnManagerTools/);
});

/** A Ledung whose workflow's profiles file says `learn`, with project p following it; its folder doesn't exist. */
function ledungWith(learn: boolean | undefined, store: Store) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-learned-'));
  fs.writeFileSync(path.join(folder, 'profiles.json'), JSON.stringify({ version: 1, ...(learn === undefined ? {} : { learnManagerTools: learn }), profiles: {} }));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    userName: 'Simon',
    workflow: { folder, managerFile: 'lead.md', sessionFile: 'worker.md', projectConfig: 'LEAD-CONFIG.md', profilesFile: 'profiles.json' },
    projects: [{ name: 'p', runner: 'local', path: path.join(folder, 'missing-project') }],
  }), store, () => {}));
  return { manager, cleanup: () => removeTemp(folder) };
}

const learnedOf = (m: SessionManager, id: string) =>
  (m as unknown as { live: Map<string, { learnedTools: SessionOptions['learnedTools'] }> }).live.get(id)!.learnedTools;

test('with the switch on a manager starts with the learned tools; with it off, or for a worker, nothing is limited', async () => {
  // The session manager asks at the real time, so the history is set back from it.
  const h = storeWithHistory(Date.now());
  h.session('old-lead', 'manager', 10);
  h.init('old-lead', 3, [{ name: 'dns-box', source: 'user' }, { name: 'mail-box', source: 'user' }]);
  h.call('old-lead', 1, ['mcp__dns-box__lookup', {}]);
  const on = ledungWith(true, h.store);
  try {
    // The folder is missing, so each session ends at once; the options it was given are what counts here.
    const lead = await on.manager.start('p', undefined, { role: 'manager' });
    const learned = learnedOf(on.manager, lead.id)!;
    assert.ok(learned.limit, 'a manager under the switch is limited');
    assert.ok(learned.noteCalls, "a manager's calls go in the record");
    assert.deepEqual(learned.limit(['notes@m']), { pluginsOff: ['notes@m'], serversOff: ['mail-box'] });
    h.store.updateSession(lead.id, { status: 'ended' });
    const worker = await on.manager.start('p');
    assert.equal(learnedOf(on.manager, worker.id)!.limit, undefined, "a worker's profile is not this issue's");
    assert.equal(learnedOf(on.manager, worker.id)!.noteCalls, undefined, "a worker's calls are not a manager's");
    assert.ok(learnedOf(on.manager, worker.id)!.noteInit, "a worker's servers still tell which servers there are");
  } finally {
    on.cleanup();
  }
  for (const learn of [false, undefined]) {
    const off = ledungWith(learn, h.store);
    try {
      const lead = await off.manager.start('p', undefined, { role: 'manager' });
      // Off: the profile's tools as today. Not said: whatever the default is.
      assert.equal(!!learnedOf(off.manager, lead.id)!.limit, learn ?? LEARN_MANAGER_TOOLS_DEFAULT, `switch ${String(learn)}`);
      assert.ok(learnedOf(off.manager, lead.id)!.noteCalls, 'the record is kept either way');
      h.store.updateSession(lead.id, { status: 'ended' });
    } finally {
      off.cleanup();
    }
  }
});
