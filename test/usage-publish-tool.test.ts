// Managers switch usage publishing and a project's published name (issue #376; Martin, 2026-10-28, Ledung questions
// #351, #352 and #354): switching either on sends more out of this computer, so it waits for the user's approval in
// Ledung, through the same hook and checks as set_project_settings; switching off runs at once. Locked projects stay
// the user's, and a manager at lockdown level B has neither.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Management, type SettingsPort } from '../src/sessions/management.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { parseConfig, parseProject } from '../src/config.ts';
import { applyPatch, changedFields, looseningChanges } from '../src/projects/settings-tools.ts';
import { LEDUNG_TOOLS, SETTINGS_CHANGE_TOOLS } from '../src/sessions/tools.ts';
import { unaskedTool } from '../src/sessions/session.ts';
import type { UsagePublishView } from '../src/shared/published-usage.ts';
import type { ProjectInfo } from '../src/shared/protocol.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

type Hook = (input: unknown, id: string) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;
type Tool = { handler(a: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> };
type Opts = { hooks?: { PreToolUse?: { hooks: Hook[] }[] }; mcpServers?: Record<string, { instance: { _registeredTools: Record<string, Tool> } }> };
type Live = {
  claudeOptions(h: object): Promise<Opts>;
  onPermission(t: string, i: object, o: object): Promise<unknown>;
  decide(id: string, d: { behavior: 'allow'; scope: 'once' }, by: string): boolean;
};

function ledung(published: Partial<UsagePublishView> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-usage-publish-tool-')));
  const at = (d: string) => path.join(root, 'missing', d);
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    userName: 'Simon',
    projects: [
      { name: 'home', runner: 'local', path: at('home'), projectSettingsTools: true },
      { name: 'other', runner: 'local', path: at('other') },
      { name: 'island', runner: 'local', path: at('island'), lockdown: { level: 'A' } },
    ],
  }), store, () => {}));
  // A stand-in for the server's Settings: the page's switch, counted; the publisher's own work is tested in usage-publish.
  const view: UsagePublishView = { enabled: false, repo: null, allAccounts: false, accounts: [], computer: 'Studio', lastPublishedAt: null, error: null, hasKey: false, ...published };
  const switched: { enabled: boolean; repo: string | null }[] = [];
  const port: SettingsPort = {
    relay: () => ({ relay: null, keySha256: null, tokenSet: false }),
    setRelay: () => { throw new Error('not used'); },
    makeAdminKey: () => { throw new Error('not used'); },
    invite: async () => { throw new Error('not used'); },
    linkCode: () => { throw new Error('not used'); },
    link: async () => { throw new Error('not used'); },
    links: () => ({ problem: null, links: [] }),
    computers: () => [],
    usagePublish: () => ({ ...view }),
    configureUsagePublish: async (next) => {
      switched.push(next);
      Object.assign(view, next, next.enabled ? { lastPublishedAt: Date.UTC(2026, 9, 28, 10, 0), hasKey: true } : {});
      return { ...view };
    },
  };
  manager.setSettings(port);
  const start = async (project: string) => {
    const s = await manager.start(project, undefined, { role: 'manager' });
    store.updateSession(s.id, { status: 'running' });
    return s.id;
  };
  const live = (id: string) => (manager as unknown as { live: Map<string, Live> }).live.get(id)!;
  const options = (id: string) => live(id).claudeOptions({ onLine: () => {}, onStderr: () => {} });
  /** The tool itself, as Claude Code runs it once the hook (or the user) allowed it. */
  const run = async (id: string, tool: string, input: Record<string, unknown> = {}) => {
    const r = await (await options(id)).mcpServers!.ledung!.instance._registeredTools[tool]!.handler(input);
    return { text: r.content[0]!.text, error: r.isError === true };
  };
  let n = 0;
  /** One call as Claude Code makes it: the hook's decision, and the tool's answer when the hook allowed it. */
  const call = async (id: string, tool: string, input: Record<string, unknown>) => {
    const out = await (await options(id)).hooks!.PreToolUse![0]!.hooks[0]!({ tool_name: `mcp__ledung__${tool}`, tool_input: input }, `tu-${++n}`);
    const decision = out.hookSpecificOutput?.permissionDecision ?? null;
    const reason = out.hookSpecificOutput?.permissionDecisionReason ?? '';
    return { decision, reason, result: decision === 'allow' ? await run(id, tool, input) : null };
  };
  /** An asked call, as Claude Code hands it to Ledung's permission flow: the prompt it makes. */
  const ask = (id: string, tool: string, input: Record<string, unknown>) => {
    void live(id).onPermission(`mcp__ledung__${tool}`, input, { signal: new AbortController().signal, toolUseID: `tu-${++n}` });
    return store.pendingPermissions().find((p) => p.sessionId === id && p.status === 'pending')!;
  };
  const project = (name: string) => manager.projects().find((p) => p.name === name)!;
  return { manager, store, view, switched, start, run, call, ask, live, project, at };
}

test("a project's published name: shown, switching it on loosens what reaches others, switching off does not", () => {
  const base = parseProject({ name: 'p', runner: 'local', path: '/p' });
  const on = parseProject(applyPatch(base, { project: 'p', publishUsageName: true }));
  assert.equal(on.publishUsageName, true);
  assert.deepEqual(looseningChanges(base, on), ['usage published under its name "p" instead of as other# and a hash']);
  assert.deepEqual(changedFields(base, on), ['publishUsageName']);
  const off = parseProject(applyPatch(on, { project: 'p', publishUsageName: false }));
  assert.equal(off.publishUsageName, undefined, 'off is the default, stored as nothing');
  assert.deepEqual(looseningChanges(on, off), []);
  assert.deepEqual(changedFields(base, parseProject({ name: 'p', runner: 'local', path: '/p', publishUsageName: false })), [], 'a stored false is no change');
});

test('usage_publish is never unasked by the tool list; the hook decides', () => {
  for (const t of ['mcp__ledung__usage_publish']) {
    assert.ok(SETTINGS_CHANGE_TOOLS.includes(t), t);
    assert.ok(!LEDUNG_TOOLS.includes(t), t);
    assert.ok(!unaskedTool(t, []), t);
  }
});

test('project_settings shows publishUsageName; switching it on waits for the user, switching it off runs at once', async () => {
  const { start, run, call, ask, live, project } = ledung();
  const id = await start('home');
  const all = JSON.parse((await run(id, 'project_settings')).text);
  assert.equal(all.other.publishUsageName, false);
  assert.equal(all.island, 'locked');

  const input = { project: 'other', publishUsageName: true };
  const c = await call(id, 'set_project_settings', input);
  assert.equal(c.decision, 'ask');
  assert.match(c.reason, /"other" that loosens what reaches you: usage published under its name "other"/);
  assert.equal(project('other').publishUsageName, false, 'nothing ran');
  // Without the user's allow the tool itself refuses it, whatever let the call through.
  const unallowed = await run(id, 'set_project_settings', input);
  assert.equal(unallowed.error, true);
  assert.match(unallowed.text, /Simon did not allow it; nothing was saved/);
  // The prompt is the user's alone, and once allowed the tool saves it.
  const asked = ask(id, 'set_project_settings', input);
  assert.equal(asked.addressedTo, 'user');
  assert.match(asked.sensitive!, /usage published under its name "other"/);
  assert.ok(live(id).decide(asked.id, { behavior: 'allow', scope: 'once' }, 'user'));
  const saved = await run(id, 'set_project_settings', input);
  assert.equal(saved.error, false, saved.text);
  assert.match(saved.text, /Saved publishUsageName for "other"/);
  assert.equal(project('other').publishUsageName, true);

  const off = await call(id, 'set_project_settings', { project: 'other', publishUsageName: false });
  assert.equal(off.decision, 'allow', 'off: unasked');
  assert.equal(off.result!.error, false, off.result!.text);
  assert.equal(project('other').publishUsageName, false);
});

test("a locked project's published name is refused outright, its own manager's included", async () => {
  const { start, call, project, manager, at } = ledung();
  const id = await start('home');
  for (const publishUsageName of [true, false]) {
    const c = await call(id, 'set_project_settings', { project: 'island', publishUsageName });
    assert.equal(c.decision, 'deny', 'refused, not asked');
    assert.match(c.reason, /"island" is locked/);
  }
  manager.updateProject('home', parseProject({ name: 'home', runner: 'local', path: at('home'), projectSettingsTools: true, lockdown: { level: 'A' } }));
  const own = await call(id, 'set_project_settings', { project: 'home', publishUsageName: true });
  assert.equal(own.decision, 'deny');
  assert.equal(project('home').publishUsageName, false);
});

test('usage_publish: switching on waits for the user and runs exactly once; switching off runs at once', async () => {
  const { start, run, call, ask, live, switched, view } = ledung();
  const id = await start('home');
  const input = { enabled: true, repo: 'acme/usage' };
  const c = await call(id, 'usage_publish', input);
  assert.equal(c.decision, 'ask');
  assert.match(c.reason, /^Sensitive: publishing this computer's usage to the GitHub repository "acme\/usage", where everyone with access to it reads it$/);
  assert.deepEqual(switched, [], 'nothing ran');
  // Without the user's allow the tool itself refuses it.
  const unallowed = await run(id, 'usage_publish', input);
  assert.equal(unallowed.error, true);
  assert.match(unallowed.text, /Simon did not allow it; nothing changed/);
  assert.deepEqual(switched, []);
  // The prompt is the user's alone, whatever grant the manager has.
  const asked = ask(id, 'usage_publish', input);
  assert.equal(asked.addressedTo, 'user');
  assert.match(asked.sensitive!, /publishing this computer's usage to the GitHub repository "acme\/usage"/);
  assert.ok(live(id).decide(asked.id, { behavior: 'allow', scope: 'once' }, 'user'));
  const on = await run(id, 'usage_publish', input);
  assert.equal(on.error, false, on.text);
  assert.match(on.text, /Publishing usage \(Settings → Claude & usage\): on, to "acme\/usage" as "Studio"; last published/);
  assert.deepEqual(switched, [{ enabled: true, repo: 'acme/usage' }]);
  // Already on there: nothing to ask and nothing to change.
  const same = await call(id, 'usage_publish', input);
  assert.equal(same.decision, 'allow');
  assert.match(same.result!.text, /Nothing to change: publishing is on, to "acme\/usage"/);
  assert.equal(switched.length, 1, 'one allow, one switch');

  // Another repo is asked again, with where it publishes now.
  const move = await call(id, 'usage_publish', { enabled: true, repo: 'acme/other' });
  assert.equal(move.decision, 'ask');
  assert.match(move.reason, /"acme\/other" instead of "acme\/usage"/);

  // Off: at once, keeping the repo the page shows.
  const off = await call(id, 'usage_publish', { enabled: false });
  assert.equal(off.decision, 'allow');
  assert.match(off.reason, /switching publishing off/);
  assert.equal(off.result!.error, false, off.result!.text);
  assert.deepEqual(switched.at(-1), { enabled: false, repo: 'acme/usage' });
  assert.equal(view.enabled, false);
  // Back on to the same repo is asked again: approvals are used up.
  assert.equal((await call(id, 'usage_publish', { enabled: true })).decision, 'ask', 'on with the kept repo');
});

test('an allowed switch-on that no longer matches what the prompt showed is refused', async () => {
  const { start, run, call, ask, live, switched, view } = ledung();
  const id = await start('home');
  const input = { enabled: true, repo: 'acme/usage' };
  assert.equal((await call(id, 'usage_publish', input)).decision, 'ask');
  const asked = ask(id, 'usage_publish', input);
  // While the prompt waits, publishing is switched on in the page to another repo.
  Object.assign(view, { enabled: true, repo: 'acme/elsewhere' });
  assert.ok(live(id).decide(asked.id, { behavior: 'allow', scope: 'once' }, 'user'));
  const late = await run(id, 'usage_publish', input);
  assert.equal(late.error, true);
  assert.match(late.text, /changed while Simon was asked, so this is no longer what they allowed; nothing changed/);
  assert.deepEqual(switched, []);
});

test('usage_publish refuses what the page would: no repo, a malformed one', async () => {
  const { start, call, switched } = ledung();
  const id = await start('home');
  const none = await call(id, 'usage_publish', { enabled: true });
  assert.equal(none.decision, 'deny', 'refused, not asked');
  assert.match(none.reason, /Give the repository to publish to/);
  const bad = await call(id, 'usage_publish', { enabled: true, repo: 'https://github.com/acme/usage' });
  assert.equal(bad.decision, 'deny');
  assert.match(bad.reason, /Write the repository as owner\/name/);
  assert.deepEqual(switched, []);
});

test('settings_status shows publishing on this computer', async () => {
  const { start, run } = ledung({ enabled: true, repo: 'acme/usage', error: 'GitHub refused' });
  const id = await start('home');
  const status = await run(id, 'settings_status');
  assert.match(status.text, /Publishing usage \(Settings → Claude & usage\): on, to "acme\/usage" as "Studio"; not published yet; the last try failed, tried again: GitHub refused\./);
});

test('a manager at lockdown level B is refused, for one launched before the change', async () => {
  const store = new Store(openDatabase(':memory:'));
  const info = (name: string, level: 'off' | 'B') => ({ name, lockdown: { level, board: false, remoteControl: false } }) as unknown as ProjectInfo;
  const projects = [info('island', 'B')];
  const switched: unknown[] = [];
  const port = {
    usagePublish: () => ({ enabled: false, repo: null, computer: 'Studio', lastPublishedAt: null, error: null, hasKey: false }),
    configureUsagePublish: async (next: unknown) => { switched.push(next); throw new Error('must not switch'); },
  } as unknown as SettingsPort;
  const m = new Management({
    store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async () => {},
    startSession: async () => { throw new Error('not used'); }, stopSession: async () => {}, archiveSession: () => {}, projectNames: () => projects.map((p) => p.name),
    decidePermission: () => true, machine: () => { throw new Error('not used'); }, setPriority: () => {}, setPaused: () => {}, projects: () => projects,
    addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); }, ensureManager: async () => '',
    handoffProblem: () => null, shotPath: (_id, f) => f, settings: () => port,
  });
  store.createSession({ id: 'mgr-i', project: 'island', runner: 'local', title: 'Manager: island', parentId: null, permissionMode: 'default', role: 'manager' });
  for (const enabled of [true, false]) {
    const d = m.usagePublishChange('mgr-i', { enabled, repo: 'acme/usage' });
    assert.ok('deny' in d && /lockdown level B/.test(d.deny), JSON.stringify(d));
    await assert.rejects(m.usagePublish('mgr-i', { enabled, repo: 'acme/usage' }), /lockdown level B/);
  }
  assert.deepEqual(switched, []);
});

// Per account and per project (issue #380): what shares more still waits for the user.

test('#380: usage_publish switches accounts; switching one on or every account asks, switching one off runs at once', async () => {
  const { start, call, switched, view } = ledung({ enabled: true, repo: 'acme/usage', allAccounts: true });
  const id = await start('home');
  // On for every account. Down to "default" only shares less.
  const fewer = await call(id, 'usage_publish', { allAccounts: false, accounts: { default: true } });
  assert.equal(fewer.decision, 'allow');
  assert.equal(fewer.result!.error, false, fewer.result!.text);
  assert.deepEqual(switched.at(-1), { enabled: true, repo: 'acme/usage', allAccounts: false, accounts: ['default'] });
  assert.match(fewer.result!.text, /Accounts published: "default"\./);
  // Another account on: asked, naming it.
  const more = await call(id, 'usage_publish', { accounts: { work: true } });
  assert.equal(more.decision, 'ask');
  assert.match(more.reason, /^Sensitive: publishing the usage of the account "work" to the GitHub repository "acme\/usage", where everyone with access to it reads it$/);
  // Every account: asked, ones added later named.
  const all = await call(id, 'usage_publish', { allAccounts: true });
  assert.equal(all.decision, 'ask');
  assert.match(all.reason, /every Claude account on this computer, ones added later too/);
  assert.equal(switched.length, 1, 'nothing asked ran');
  // The last account off: publishing is off, at once.
  const none = await call(id, 'usage_publish', { accounts: { default: false } });
  assert.equal(none.decision, 'allow');
  assert.deepEqual(switched.at(-1), { enabled: false, repo: 'acme/usage', allAccounts: false, accounts: [] });
  assert.equal(view.enabled, false);
  // From off with accounts: asked, with the accounts in the prompt.
  const on = await call(id, 'usage_publish', { enabled: true, accounts: { work: true } });
  assert.equal(on.decision, 'ask');
  assert.match(on.reason, /publishing this computer's usage \(the account "work"\) to the GitHub repository "acme\/usage"/);
  const bad = await call(id, 'usage_publish', { accounts: ['work'] });
  assert.equal(bad.decision, 'deny');
  assert.match(bad.reason, /Give accounts as/);
});

test("#380: a project's usage repo: shown, set or cleared only with the user's allow, a malformed one refused", async () => {
  const base = parseProject({ name: 'p', runner: 'local', path: '/p' });
  const moved = parseProject(applyPatch(base, { project: 'p', usageRepo: 'team/usage' }));
  assert.equal(moved.usageRepo, 'team/usage');
  assert.deepEqual(changedFields(base, moved), ['usageRepo']);
  assert.deepEqual(looseningChanges(base, moved), ['usage published to the repository "team/usage" instead of this computer\'s default usage repository']);
  // Back to the default reaches that repo's readers instead: asked too.
  const back = parseProject(applyPatch(moved, { project: 'p', usageRepo: null }));
  assert.equal(back.usageRepo, undefined);
  assert.deepEqual(looseningChanges(moved, back), ['usage published to this computer\'s default usage repository instead of the repository "team/usage"']);
  assert.throws(() => parseProject(applyPatch(base, { project: 'p', usageRepo: 'https://github.com/team/usage' })), /owner\/name/);

  const { start, run, call, ask, live, project } = ledung();
  const id = await start('home');
  assert.equal(JSON.parse((await run(id, 'project_settings')).text).other.usageRepo, null);
  const input = { project: 'other', usageRepo: 'team/usage' };
  const c = await call(id, 'set_project_settings', input);
  assert.equal(c.decision, 'ask');
  assert.match(c.reason, /usage published to the repository "team\/usage"/);
  assert.equal(project('other').usageRepo, null, 'nothing ran');
  const asked = ask(id, 'set_project_settings', input);
  assert.equal(asked.addressedTo, 'user');
  assert.ok(live(id).decide(asked.id, { behavior: 'allow', scope: 'once' }, 'user'));
  const saved = await run(id, 'set_project_settings', input);
  assert.equal(saved.error, false, saved.text);
  assert.equal(project('other').usageRepo, 'team/usage');
});

test("#380: switching on names the projects' own repos it starts too (review of PR #382, finding 3)", async () => {
  const { start, call, manager, at } = ledung();
  manager.updateProject('other', parseProject({ name: 'other', runner: 'local', path: at('other'), usageRepo: 'team/usage' }));
  const id = await start('home');
  const c = await call(id, 'usage_publish', { enabled: true, repo: 'acme/usage' });
  assert.equal(c.decision, 'ask');
  assert.match(c.reason, /^Sensitive: publishing this computer's usage to the GitHub repository "acme\/usage", and "other" to "team\/usage", where everyone with access to each reads it$/);
});
