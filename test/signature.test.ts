// A project's signature, part 1 (issue #513, docs/steps/project-signature.md): Ledung's default for a project with no
// setting, the fill-ins and the line they leave out, Off as no line at all, what the settings form stores and sends,
// the config's checks, and Claude Code's `attribution` per session (at the start, refilled when Claude Code names its
// model, and live when the project changes). The query is a stand-in for the SDK's Query.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, parseProject } from '../src/config.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { Session } from '../src/sessions/session.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import type { ProjectConfig } from '../src/config.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import {
  LEDUNG_DEFAULT_SIGNATURE, attributionSetting, emptyTexts, fillSignature, modelDisplayName, sameSignature, signatureSettingOf, signatureState, signatureTexts,
  unknownFillIn, type SignatureLaunch,
} from '../src/shared/signature.ts';
import type { ProjectInfo } from '../src/shared/protocol.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { changedFields, emptySettings, settingsOf, toApi } from '../web/src/projects/projectSettings.ts';
import { removeTemp } from './temp.ts';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-signature-')));
// The home and data folders are the test's own, so no real host record or AppData is ever read.
process.env.USERPROFILE = base;
process.env.HOME = base;
process.env.LEDUNG_DATA_DIR = path.join(base, 'data');
fs.mkdirSync(process.env.LEDUNG_DATA_DIR, { recursive: true });
const made: SessionManager[] = [];
after(() => {
  for (const manager of made) manager.detachAll();
  try {
    removeTemp(base);
  } catch {
    // Left in the temp folder.
  }
});

const values = { user: 'Simon', project: 'shop', run: 'run-7', workflow: 'Development', model: 'Claude Opus 5.5' };
const outside = { ...values, run: '', workflow: '' };

test("a project with no setting has Ledung's default, which is open choice 4a's table", () => {
  assert.deepEqual(signatureTexts(undefined), LEDUNG_DEFAULT_SIGNATURE);
  assert.equal(signatureState(undefined), 'default');
  assert.deepEqual(LEDUNG_DEFAULT_SIGNATURE, {
    pr: '— via Ledung for {user}', commit: 'Co-Authored-By: {model} <noreply@anthropic.com>', newIssue: '— via Ledung for {user}',
    issueComment: '', prComment: '', trackers: '— via Ledung for {user}',
  });
  // A place a hand-written config leaves out keeps its default; Off empties every place.
  assert.equal(signatureTexts({ texts: { pr: 'mine' } }).commit, LEDUNG_DEFAULT_SIGNATURE.commit);
  assert.equal(signatureState({ texts: { pr: 'mine' } }), 'edited');
  assert.equal(signatureState({ texts: { ...LEDUNG_DEFAULT_SIGNATURE } }), 'default');
  assert.deepEqual(signatureTexts({ off: true, texts: { pr: 'kept?' } }), emptyTexts());
  assert.equal(signatureState({ off: true }), 'off');
});

test('the fill-ins are filled, and a line whose fill-in is empty is left out', () => {
  assert.equal(fillSignature('— via Ledung for {user} in {project}', values), '— via Ledung for Simon in shop');
  assert.equal(fillSignature('Co-Authored-By: {model} <noreply@anthropic.com>', values), 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
  assert.equal(fillSignature('Ledung-Run: {run} ({workflow})\nVia: Ledung for {user}', values), 'Ledung-Run: run-7 (Development)\nVia: Ledung for Simon');
  // Outside a run: the run's line goes, the rest stays; nothing left gives no line at all.
  assert.equal(fillSignature('Ledung-Run: {run}\nVia: Ledung for {user}', outside), 'Via: Ledung for Simon');
  assert.equal(fillSignature('Ledung-Run: {run}', outside), '');
  assert.equal(fillSignature('', values), '');
  assert.equal(fillSignature('\n\n— via Ledung  \n\n', values), '— via Ledung');
  // Only the five exist: anything else is no fill-in, named on save.
  assert.equal(unknownFillIn('— {user} {session}'), '{session}');
  assert.equal(unknownFillIn('— {user} {project} {run} {workflow} {model}'), null);
  assert.equal(fillSignature('{folder}', values), '{folder}');
});

test("the model is named as Claude Code names it in its own trailer", () => {
  assert.equal(modelDisplayName('claude-opus-5-5'), 'Claude Opus 5.5');
  assert.equal(modelDisplayName('claude-haiku-4-5-20251001'), 'Claude Haiku 4.5');
  assert.equal(modelDisplayName('claude-sonnet-4-20250514'), 'Claude Sonnet 4');
  assert.equal(modelDisplayName('claude-opus-4-1[1m]'), 'Claude Opus 4.1');
  assert.equal(modelDisplayName('claude-3-5-sonnet-20241022'), 'Claude Sonnet 3.5');
  assert.equal(modelDisplayName('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'Claude Sonnet 4.5');
  assert.equal(modelDisplayName('sonnet'), 'Claude Sonnet');
  assert.equal(modelDisplayName(undefined), 'Claude');
  assert.equal(modelDisplayName('some-other-model'), 'Claude');
});

test("Claude Code's attribution: the project's texts filled in, empty for an emptied place, false when Off", () => {
  const launch = (over: Partial<SignatureLaunch> = {}): SignatureLaunch => ({ off: false, texts: { ...LEDUNG_DEFAULT_SIGNATURE }, values: { user: 'Simon', project: 'shop', run: '', workflow: '' }, ...over });
  assert.deepEqual(attributionSetting(launch(), 'Claude Haiku 5.5'), { pr: '— via Ledung for Simon', commit: 'Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>' });
  assert.deepEqual(attributionSetting(launch({ texts: { ...LEDUNG_DEFAULT_SIGNATURE, commit: '' } }), 'Claude'), { pr: '— via Ledung for Simon', commit: '' });
  assert.equal(attributionSetting(launch({ off: true, texts: emptyTexts() }), 'Claude'), false);
});

const project = (over: Partial<ProjectInfo> = {}): ProjectInfo => ({
  name: 'Demo', runner: 'local', where: '/home/demo', account: null, model: null, managerModel: null, permissionMode: null, managerGrant: null, projectToolsUnasked: false,
  sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] }, devShipCommand: null, tickets: null,
  questionTiers: [], extraFolders: [], profiles: { manager: null, session: null }, skills: {}, workflow: null, managerId: null, createdAt: 0,
  colours: { manager: null, sessions: 'same' }, lockdown: { level: 'off', board: false, remoteControl: false }, ...over,
});

test("the form stores nothing while it is Ledung's default, Off alone, or the edited texts; a save never drops one", () => {
  // No setting: the form shows the default, and a save of something else sends no signature, so the project follows it.
  const plain = settingsOf(project());
  assert.deepEqual(plain.signature, LEDUNG_DEFAULT_SIGNATURE);
  assert.equal(plain.signatureOff, false);
  assert.equal(plain.recordPosts, true);
  const sent = toApi({ ...plain, model: 'opus' }, project()) as Record<string, unknown>;
  assert.equal('signature' in sent, false);
  assert.equal('recordPosts' in sent, false);
  // Edited: the texts as typed, kept on a save of another field.
  const mine = { ...LEDUNG_DEFAULT_SIGNATURE, pr: '— sent by our bot' };
  const edited = project({ signature: { texts: mine } });
  assert.deepEqual((toApi({ ...settingsOf(edited), model: 'opus' }, edited) as Record<string, unknown>).signature, { texts: mine });
  // Edited back to the default: nothing stored again.
  assert.equal('signature' in toApi({ ...settingsOf(edited), signature: { ...LEDUNG_DEFAULT_SIGNATURE } }, edited), false);
  // Off: only that, the texts are gone.
  const off = project({ signature: { off: true } });
  assert.deepEqual(settingsOf(off).signature, emptyTexts());
  assert.deepEqual((toApi(settingsOf(off), off) as Record<string, unknown>).signature, { off: true });
  // Recording off is stored, on is the default.
  assert.equal((toApi({ ...plain, recordPosts: false }, project()) as Record<string, unknown>).recordPosts, false);
  assert.equal(settingsOf(project({ recordPosts: false })).recordPosts, false);
  // The Save bar counts a signature change, in its own group.
  assert.deepEqual(changedFields(plain, { ...plain, signature: mine }), ['signature']);
  assert.deepEqual(changedFields(emptySettings('Demo'), { ...emptySettings('Demo'), signatureOff: true, signature: emptyTexts() }), ['signatureOff', 'signature']);
  assert.deepEqual(signatureSettingOf(false, { ...LEDUNG_DEFAULT_SIGNATURE }), undefined);
});

test('the config takes a signature with the five fill-ins only, and refuses one too long', () => {
  const p = (signature: unknown) => ({ name: 'shop', runner: 'local', path: base, signature });
  assert.deepEqual(parseProject(p({ off: true })).signature, { off: true });
  assert.deepEqual(parseProject(p({ texts: { pr: '— {user} in {run}' } })).signature, { texts: { pr: '— {user} in {run}' } });
  assert.throws(() => parseProject(p({ texts: { pr: '— {user} from {folder}' } })), /\{folder\} is not a fill-in/);
  assert.throws(() => parseProject(p({ texts: { commit: 'x'.repeat(1001) } })), /signature/);
  const config = parseConfig({ projects: [{ name: 'shop', runner: 'local', path: base }] });
  assert.equal(config.projects[0]!.signature, undefined);
  assert.equal(config.projects[0]!.recordPosts, undefined);
  assert.equal(sameSignature(undefined, { texts: { ...LEDUNG_DEFAULT_SIGNATURE } }), true);
  assert.equal(sameSignature(undefined, { off: true }), false);
});

const handlers = { onLine: () => {}, onStderr: () => {} };

/** A Session whose query records what it was launched with and each flag-settings call; `init` is Claude Code's first message. */
async function running(opts: { launch: () => SignatureLaunch | Promise<SignatureLaunch>; model?: string; init?: string; signature?: boolean }) {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 'Worker', parentId: null, permissionMode: 'default', role: 'session' });
  const info = store.getSession('s1')!;
  const flags: unknown[] = [];
  const messages = opts.init ? [{ type: 'system', subtype: 'init', model: opts.init, session_id: 'c1', claude_code_version: '2.1.319', cwd: base, mcp_servers: [], permissionMode: 'default', tools: [] }] : [];
  const stream = {
    accountInfo: async () => ({}),
    applyFlagSettings: async (settings: unknown) => { flags.push(settings); },
    [Symbol.asyncIterator]: () => ({ next: () => (messages.length ? Promise.resolve({ value: messages.shift(), done: false }) : new Promise<IteratorResult<unknown>>(() => {})) }),
  };
  const launched: Record<string, unknown>[] = [];
  const s = new Session({
    info, store, publish: () => {}, userName: 'Simon', model: opts.model,
    management: new Proxy({}, { get: (_, k) => (k === 'questionTiers' ? () => [] : () => undefined) }) as never,
    runner: new LocalRunner({ name: 'p', runner: 'local', path: base } as never),
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    query: ((args: { options: Record<string, unknown> }) => { launched.push(args.options); return stream; }) as never,
    signature: opts.signature === false ? null : async () => opts.launch(),
  });
  await s.start();
  return { s, store, flags, launched, settings: () => launched[0]!.settings as Record<string, unknown> };
}

const launchOf = (over: Partial<SignatureLaunch> = {}): SignatureLaunch => ({
  off: false, texts: { ...LEDUNG_DEFAULT_SIGNATURE }, values: { user: 'Simon', project: 'p', run: '', workflow: '' }, ...over,
});
const settle = () => new Promise((r) => setTimeout(r, 20));

test("a session starts with its project's lines in place of Claude Code's, its model named", async () => {
  const { settings } = await running({ launch: () => launchOf(), model: 'claude-haiku-5-5' });
  assert.deepEqual(settings().attribution, { pr: '— via Ledung for Simon', commit: 'Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>' });
  // Ledung's other launch settings are still there beside it (the boundary's rules).
  assert.ok(settings().permissions, 'the boundary rules stay');
});

test('Off launches with attribution false: no line at all, Claude Code\'s included', async () => {
  const { settings } = await running({ launch: () => launchOf({ off: true, texts: emptyTexts() }) });
  assert.equal(settings().attribution, false);
});

test("a session without a signature (chats, the Helper) keeps Claude Code's own lines", async () => {
  const { settings } = await running({ launch: () => launchOf(), signature: false });
  assert.equal('attribution' in (settings() ?? {}), false);
});

test("a signature that can't be read leaves Claude Code's lines and never stops the start", async () => {
  const { settings } = await running({ launch: () => { throw new Error('its project is gone'); } });
  assert.equal('attribution' in (settings() ?? {}), false);
});

test("Claude Code's init names the model it runs: {model} is refilled live, only attribution sent", async () => {
  // Started on an alias, so the start can only say "Claude Haiku"; the init names the model itself.
  const { flags, settings } = await running({ launch: () => launchOf(), model: 'haiku', init: 'claude-haiku-5-5' });
  assert.equal((settings().attribution as { commit: string }).commit, 'Co-Authored-By: Claude Haiku <noreply@anthropic.com>');
  await settle();
  assert.deepEqual(flags, [{ attribution: { pr: '— via Ledung for Simon', commit: 'Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>' } }]);
});

test("the same model in Claude Code's init sends nothing again", async () => {
  const { flags } = await running({ launch: () => launchOf(), model: 'claude-haiku-5-5', init: 'claude-haiku-5-5' });
  await settle();
  assert.deepEqual(flags, []);
});

test("a project's changed signature reaches a running session at once", async () => {
  let current = launchOf();
  const { s, flags } = await running({ launch: () => current, model: 'claude-opus-5-5' });
  current = launchOf({ texts: { ...LEDUNG_DEFAULT_SIGNATURE, pr: '— by our team via Ledung, {run}' }, values: { user: 'Simon', project: 'p', run: 'run-3', workflow: 'Dev' } });
  await s.refreshSignature();
  assert.deepEqual(flags, [{ attribution: { pr: '— by our team via Ledung, run-3', commit: 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' } }]);
  current = launchOf({ off: true, texts: emptyTexts() });
  await s.refreshSignature();
  assert.deepEqual(flags.at(-1), { attribution: false });
});

/** A Ledung with one project, whose sessions never start. */
function ledung() {
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({
    userName: 'Simon', browseRoots: [base], chats: { folder: base },
    sensitive: { pathPatterns: ['\\.secret$'] },
    projects: [{ name: 'shop', runner: 'local', path: base }],
  }), store, () => {}));
  made.push(manager);
  return { manager, store };
}

test("a signature that names a sensitive path or holds a token is refused on save; a plain one is saved", () => {
  const { manager } = ledung();
  const config = (texts: Record<string, string>) => ({ name: 'shop', runner: 'local', path: base, signature: { texts } }) as ProjectConfig;
  assert.throws(() => manager.updateProject('shop', config({ pr: 'see deploy.secret' })), /"PR descriptions" can't be saved: "deploy\.secret" matches the sensitive path pattern/);
  assert.throws(() => manager.updateProject('shop', config({ commit: `Token: ghp_${'a1B2'.repeat(9)}` })), /"Commits" can't be saved: a GitHub token/);
  const saved = manager.updateProject('shop', config({ pr: '— by our team, via Ledung for {user}' }));
  assert.deepEqual(saved.signature, { texts: { pr: '— by our team, via Ledung for {user}' } });
  assert.equal(saved.recordPosts, true);
});

test("a session's signature is its project's as saved now, with the person's name and no run outside one", async () => {
  const { manager, store } = ledung();
  store.createSession({ id: 'w1', project: 'shop', runner: 'local', title: 'Worker', parentId: null, permissionMode: 'default', role: 'session' });
  const launch = (manager as unknown as { signatureLaunch(id: string): Promise<SignatureLaunch> }).signatureLaunch.bind(manager);
  assert.deepEqual(await launch('w1'), { off: false, texts: LEDUNG_DEFAULT_SIGNATURE, values: { user: 'Simon', project: 'shop', run: '', workflow: '' } });
  manager.updateProject('shop', { name: 'shop', runner: 'local', path: base, signature: { off: true } } as ProjectConfig);
  assert.deepEqual(await launch('w1'), { off: true, texts: emptyTexts(), values: { user: 'Simon', project: 'shop', run: '', workflow: '' } });
});

test('an unknown fill-in is refused under the name the page gives its place, not an internal key', () => {
  const p = { name: 'shop', runner: 'local', path: base, signature: { texts: { issueComment: '— {session}' } } };
  assert.throws(() => parseProject(p), (e: Error) => {
    assert.equal(e.message, 'Issue comments: {session} is not a fill-in; use {user}, {project}, {run}, {workflow} or {model}.');
    return true;
  });
});

test('a project added with a signature that holds a token or names a sensitive path is refused, and not stored', () => {
  const { manager } = ledung();
  const config = (texts: Record<string, string>) => ({ name: 'new', runner: 'local', path: base, signature: { texts } }) as ProjectConfig;
  assert.throws(() => manager.addProject(config({ pr: 'see deploy.secret' })), /"PR descriptions" can't be saved: "deploy\.secret" matches the sensitive path pattern/);
  assert.throws(() => manager.addProject(config({ commit: `Token: ghp_${'a1B2'.repeat(9)}` })), /"Commits" can't be saved: a GitHub token/);
  // A pattern only a new project's suggested list has, not the config's (acceptance round 2 of #513).
  assert.throws(() => manager.addProject(config({ issueComment: 'see credentials.txt' })), /"Issue comments" can't be saved: "credentials\.txt" matches the sensitive path pattern/);
  assert.equal(manager.projects().some((p) => p.name === 'new'), false);
  assert.deepEqual(manager.addProject(config({ pr: '— via Ledung for {user}, {project}' })).signature, { texts: { pr: '— via Ledung for {user}, {project}' } });
});

test("renaming a project and changing its signature in one save reaches its running session at once, under the new name", async () => {
  const { manager, store } = ledung();
  store.createSession({ id: 'w1', project: 'shop', runner: 'local', title: 'Worker', parentId: null, permissionMode: 'default', role: 'session' });
  const launch = (manager as unknown as { signatureLaunch(id: string): Promise<SignatureLaunch> }).signatureLaunch.bind(manager);
  // A running session as the manager sees it: its project read from the store, and the attribution a refresh would send.
  const flags: unknown[] = [];
  const live = {
    id: 'w1',
    detach: () => {},
    get info() { return store.getSession('w1')!; },
    refreshSignature: async () => { flags.push({ attribution: attributionSetting(await launch('w1'), 'Claude Opus 5.5') }); },
  };
  (manager as unknown as { live: Map<string, unknown> }).live.set('w1', live);
  manager.renameProject('shop', 'store', { name: 'store', runner: 'local', path: base, signature: { texts: { pr: '— via Ledung for {user} in {project}' } } } as ProjectConfig);
  await settle();
  assert.equal(store.getSession('w1')!.project, 'store');
  assert.deepEqual(flags, [{ attribution: { pr: '— via Ledung for Simon in store', commit: 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' } }]);
  (manager as unknown as { live: Map<string, unknown> }).live.delete('w1');
});
