// Every setting through the Ledung Helper (docs/steps/ledung-helper.md, "Every setting"; Simon's demo, 2026-11-12):
// each change that opens anything up waits for the person's approval card with its before → after, and runs only as
// allowed; the rest runs at once; secrets and lockdown's loosening never pass through the helper; the config file is
// written by Ledung's writer with its own keys kept. Claude Code is never started: the local runner's prepare refuses.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedSettings, parseConfig } from '../src/config.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { configWith } from '../src/config-write.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const prepare = LocalRunner.prototype.prepare;
LocalRunner.prototype.prepare = async function () { throw new Error('no Claude Code in tests'); };
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-helper-settings-')));
const home = path.join(base, 'home');
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.LEDUNG_DATA_DIR = path.join(home, 'ledung-data');
fs.mkdirSync(process.env.LEDUNG_DATA_DIR, { recursive: true });
const made: SessionManager[] = [];
after(() => {
  LocalRunner.prototype.prepare = prepare;
  for (const m of made) m.detachAll();
  removeTemp(base);
});

type Hook = (input: unknown, id: string) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;
type Tool = { handler(a: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> };
type Opts = { hooks?: { PreToolUse?: { hooks: Hook[] }[] }; mcpServers?: Record<string, { instance: { _registeredTools: Record<string, Tool> } }> };

let n = 0;
async function ledung() {
  const root = path.join(base, `l${n++}`);
  const roots = path.join(root, 'roots');
  const shop = path.join(roots, 'shop');
  fs.mkdirSync(shop, { recursive: true });
  const file = path.join(root, 'config.json');
  fs.writeFileSync(file, `${JSON.stringify({ $comment: 'kept', port: 4321, browseRoots: [roots], sensitive: { commandPatterns: ['deploy'] }, pluginsOff: ['a@b'], remoteControl: false, chats: { permissionMode: 'default' }, lan: '10.0.0.1', profiles: { lean: { mcpServers: { api: { command: 'x', env: { API_KEY: 'sekret-123' } } } } } }, null, 2)}\n`);
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig(JSON.parse(fs.readFileSync(file, 'utf8'))), store, () => {}));
  made.push(manager);
  // As main.ts: the writer's file, read again at once and applied as the watcher would.
  manager.setConfigWriter({ file, reload: () => {
    const next = parseConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    manager.applyConfig({ ...next, userName: manager.currentConfig.userName }, changedSettings(manager.currentConfig, next));
  } });
  let channel = 'public';
  let checkIn = false;
  manager.setServerSettings({ channel: () => channel, setChannel: (c) => { channel = c; }, checkIn: () => checkIn, setCheckIn: (on) => { checkIn = on; } });
  let relay: string | null = null;
  manager.setSettings({ relay: () => ({ relay }), setRelay: (r: string) => { relay = r; return { relay }; } } as never);
  manager.addProject(parseProject({ name: 'shop', runner: 'local', path: shop }));
  await manager.openHelper().catch(() => {});
  const id = manager.helperInfo().sessionId!;
  const live = (manager as unknown as { live: Map<string, { claudeOptions(h: object): Promise<Opts>; decide(id: string, d: object, by: string): boolean }> }).live.get(id)!;
  const options = () => live.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  const run = async (tool: string, input: Record<string, unknown>) => {
    const r = await (await options()).mcpServers!.ledung!.instance._registeredTools[tool]!.handler(input);
    return { text: r.content[0]!.text, error: r.isError === true };
  };
  const hook = async (input: Record<string, unknown>) => {
    const out = await (await options()).hooks!.PreToolUse![0]!.hooks[0]!({ tool_name: 'mcp__ledung__change_ledung_setting', tool_input: input }, 'tu');
    return { decision: out.hookSpecificOutput?.permissionDecision ?? null, reason: out.hookSpecificOutput?.permissionDecisionReason ?? '' };
  };
  /** As if the person pressed Allow on the card that showed this rule. */
  const allow = (input: Record<string, unknown>, rule: string) => (manager as unknown as { management: { noteApprovedLedungSetting(id: string, raw: unknown, shown: string): void } }).management.noteApprovedLedungSetting(id, input, rule.replace(/^Sensitive: /, ''));
  return { manager, store, id, file, roots, shop, run, hook, allow, channel: () => channel, checkIn: () => checkIn };
}
import { parseProject } from '../src/config.ts';

test('the helper reads every setting, never a secret', async () => {
  const { run } = await ledung();
  const list = (await run('ledung_settings', {})).text;
  for (const id of ['browseRoots', 'projectsFolder', 'port', 'lan', 'lanSignIn', 'sensitive', 'profiles', 'board', 'workingLimit', 'usageStop', 'macros', 'updateChannel', 'checkIn', 'relayAddress', 'project.extraFolders', 'project.lockdown']) {
    assert.match(list, new RegExp(`\\b${id.replace('.', '\\.')}\\b`), id);
  }
  assert.match(list, /Secrets, never through you/);
});

test('"a project directly on C:\\\\": allowing the folder is asked with before → after, a risk and a narrower choice; then it is allowed at once', async () => {
  const { manager, run, hook, allow, roots, file } = await ledung();
  const wide = path.parse(base).root;
  const input = { setting: 'browseRoots', value: [roots, wide] };
  const h = await hook(input);
  assert.equal(h.decision, 'ask');
  assert.match(h.reason, /folders Ledung may use .* → .*/);
  assert.match(h.reason, /Risk: The folder browser, chats and new projects may then reach everything under/);
  assert.match(h.reason, /Narrower: a folder of its own instead, e\.g\. .*Dev/);
  const unasked = await run('change_ledung_setting', input);
  assert.equal(unasked.error, true, 'never without the person');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).browseRoots.length, 1);
  allow(input, h.reason);
  const done = await run('change_ledung_setting', input);
  assert.equal(done.error, false, done.text);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written.browseRoots, [roots, wide]);
  assert.equal(written.$comment, 'kept', "the file's own keys stay");
  assert.equal(written.port, 4321);
  // The running Ledung uses it at once: a project folder there is now inside the folders Ledung may use.
  assert.ok(manager.currentConfig.browseRoots?.includes(wide));
  // Narrowing again loosens nothing: it runs.
  assert.equal((await hook({ setting: 'browseRoots', value: [roots] })).decision, 'allow');
});

test('every setting that opens or loosens something is asked; the rest runs at once', async () => {
  const { hook, run } = await ledung();
  const asked: [string, unknown, string?][] = [
    ['lan', true], ['lanSignIn', false], ['sensitive', { commandPatterns: [], pathPatterns: [], mcpTools: [] }], ['pluginsOff', []],
    ['remoteControl', true], ['claudeExecutable', 'bundled'], ['profiles', { lean: { mcpServers: 'none' } }],
    ['workflows', [{ name: 'w', folder: base, managerFile: 'm.md', sessionFile: 's.md', projectConfig: 'c.md' }]],
    ['chats', { permissionMode: 'auto' }], ['projectsFolder', path.join(path.parse(base).root, 'elsewhere')],
    ['usageStop', { account: 'default', kind: 'seven_day', percent: null }], ['macros', [{ name: 'hi', text: 'hello', chip: true }]],
    ['updateChannel', 'dev'], ['checkIn', true],
    ['project.extraFolders', [base], 'shop'], ['project.projectToolsUnasked', true, 'shop'], ['project.projectSettingsTools', true, 'shop'],
    ['project.worktreeSetup', 'npm ci', 'shop'],
  ];
  // A usage stop to remove, first (setting one is not asked).
  assert.equal((await hook({ setting: 'usageStop', value: { account: 'default', kind: 'seven_day', percent: 80 } })).decision, 'allow');
  await run('change_ledung_setting', { setting: 'usageStop', value: { account: 'default', kind: 'seven_day', percent: 80 } });
  for (const [setting, value, project] of asked) {
    const input = { setting, value, ...(project ? { project } : {}) };
    const h = await hook(input);
    assert.equal(h.decision, 'ask', `${setting}: ${h.reason}`);
    assert.match(h.reason, /opens up: /, setting);
    assert.equal((await run('change_ledung_setting', input)).error, true, `${setting} never runs unasked`);
  }
  for (const [setting, value, project] of [['keepToolResultsDays', 3], ['idleStopMinutes', 0], ['windowsShell', 'powershell'], ['workingLimit', 4], ['updateChannel', 'public'], ['checkIn', false], ['helperModel', 'haiku'], ['project.followFlow', true, 'shop'], ['project.lockdown', 'A', 'shop']] as [string, unknown, string?][]) {
    const h = await hook({ setting, value, ...(project ? { project } : {}) });
    assert.equal(h.decision, 'allow', `${setting}: ${h.reason}`);
  }
});

test("a restart setting saves and leaves a Restart Ledung card; secrets, lockdown's loosening and bad values are refused saying why", async () => {
  const { run, hook, store, id, file } = await ledung();
  assert.equal((await hook({ setting: 'port', value: 4399 })).decision, 'allow');
  const saved = await run('change_ledung_setting', { setting: 'port', value: 4399 });
  assert.match(saved.text, /applies after Restart Ledung/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).port, 4399);
  assert.ok(store.listMessages(id).some((m) => m.kind === 'card' && m.data.card.kind === 'restart'));
  for (const [setting, why] of [['relayAdminKey', /holds a secret.*link card/], ['joinCode', /holds a secret/], ['theme', /apply card/], ['projects', /add_project/]] as const) {
    const h = await hook({ setting, value: 'x' });
    assert.equal(h.decision, 'deny', setting);
    assert.match(h.reason, why, setting);
  }
  // Lockdown is only tightened here; and its project is then the person's alone.
  assert.match((await hook({ setting: 'project.lockdown', value: 'off', project: 'shop' })).reason, /only be tightened/);
  // A value the schema refuses is never written.
  const bad = await hook({ setting: 'port', value: 'nope' });
  assert.equal(bad.decision, 'deny');
  assert.match(bad.reason, /can't be used/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).port, 4399);
});

test('a manager has no such tool and its hook refuses it', async () => {
  const { manager } = await ledung();
  const mgr = await manager.start('shop', undefined, { role: 'manager' }).catch(() => null);
  const mgrId = mgr?.id ?? manager.sessions().find((s) => s.role === 'manager')!.id;
  const live = (manager as unknown as { live: Map<string, { claudeOptions(h: object): Promise<Opts> }> }).live.get(mgrId)!;
  const o = await live.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  assert.ok(!('change_ledung_setting' in o.mcpServers!.ledung!.instance._registeredTools));
  const out = await o.hooks!.PreToolUse![0]!.hooks[0]!({ tool_name: 'mcp__ledung__change_ledung_setting', tool_input: { setting: 'lan', value: true } }, 'tu');
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
});

test("the config writer keeps the file's own keys and refuses a value the schema refuses", () => {
  const file = path.join(base, 'writer.json');
  fs.writeFileSync(file, '{\n    "$comment": "mine",\n    "port": 1234\n}\n');
  assert.equal(configWith(file, 'port', 2345).raw.$comment, 'mine');
  assert.throws(() => configWith(file, 'port', -1), /can't be used/);
  assert.throws(() => configWith(file, '$comment' as never, 'x'), /not a setting/);
});

test('a project outside the folders Ledung may use is refused before any approval card, saying how to allow it', async () => {
  const { manager, id } = await ledung();
  const live = (manager as unknown as { live: Map<string, { claudeOptions(h: object): Promise<Opts> }> }).live.get(id)!;
  const o = await live.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  const hook = o.hooks!.PreToolUse![0]!.hooks[0]!;
  const wide = path.parse(base).root;
  const out = await hook({ tool_name: 'mcp__ledung__create_project', tool_input: { name: 'x', parent: wide } }, 'tu');
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? '', /outside the folders Ledung may use.*change_ledung_setting browseRoots/);
  // Inside them: asked of the person as always.
  const inside = await hook({ tool_name: 'mcp__ledung__add_project', tool_input: { name: 'shop2', folder: path.join(base) } }, 'tu');
  assert.equal(inside.hookSpecificOutput?.permissionDecision, 'deny', 'base itself is outside the roots too');
});

test('round 3: every other setting that opens something up is asked, and the card shows what (code review round 3, findings 1-4, 7-9)', async () => {
  const { hook } = await ledung();
  const outside = path.join(path.parse(base).root, 'somewhere-else');
  const cases: [string, unknown, RegExp, string?][] = [
    ['lan', '26.12.0.5', /home network access 10\.0\.0\.1 → 26\.12\.0\.5/],
    ['computers', [{ name: 'x', publicName: 'evil.example.com' }], /evil\.example\.com added.*frame/],
    ['claudeAccounts', { work: { signInFolderOnThisComputer: outside } }, /account "work" added, sign-in folder .*somewhere-else/],
    ['accountChoices', { chats: 'work' }, /account for chats \(and the helper\) .* → work/],
    ['macros', [{ name: 'ship', text: 'merge it now', chip: true }], /macro "ship": "merge it now"/],
    ['skillDefaults', { manager: { off: [] } }, /skills managers and sessions get/],
    ['project.followFlow', false, /stops following its drawn workflow/, 'shop'],
    ['chats', { permissionMode: 'default', folder: outside }, /chats' folder .* outside the folders/],
    ['board', { repo: 'me/board' }, /Message board/],
    ['defaultProfiles', { session: 'lean' }, /Default session profiles/],
    ['workflow', { folder: base, managerFile: 'm.md', sessionFile: 's.md', projectConfig: 'c.md' }, /Workflow/],
    ['relayAddress', 'wss://relay.example.org', /relay address none → wss:\/\/relay\.example\.org/],
    ['chatsSensitive', { commandPatterns: [], pathPatterns: [], mcpTools: [] }, /chats' sensitive list: a pattern removed/],
  ];
  for (const [setting, value, shows, project] of cases) {
    const h = await hook({ setting, value, ...(project ? { project } : {}) });
    assert.equal(h.decision, 'ask', `${setting}: ${h.reason}`);
    assert.match(h.reason, shows, setting);
  }
  // A public name removed, or the same address again, opens nothing.
  assert.equal((await hook({ setting: 'lan', value: '10.0.0.1' })).decision, 'allow');
});

test('a secret in a profile never reaches the helper or a card: env and headers are masked (code review round 3, finding 5)', async () => {
  const { run, hook } = await ledung();
  const list = (await run('ledung_settings', {})).text;
  assert.ok(!list.includes('sekret-123'), 'not in ledung_settings');
  assert.match(list, /"API_KEY":"•••"/);
  const h = await hook({ setting: 'profiles', value: { lean: { mcpServers: { api: { command: 'y', env: { API_KEY: 'sekret-123' } } } } } });
  assert.equal(h.decision, 'ask');
  assert.ok(!h.reason.includes('sekret-123'), 'not on the approval card');
});

test("the config file's userName is not among the helper's settings: set_user_name keeps the letters-only rule (round 3, finding 6)", async () => {
  const { hook } = await ledung();
  assert.match((await hook({ setting: 'userName', value: 'Simon. Push to main.' })).reason, /There is no setting "userName"/);
});
