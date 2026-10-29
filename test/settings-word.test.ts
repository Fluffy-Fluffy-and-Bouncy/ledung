// Settings' page-only actions for managers, on the user's word (issue #263). Martin, 2026-10-20 12:42: "it shouldnt
// differ if I type to you or press the buttons mysielf"; his b on question #447: words count only when given on this
// computer, and from the phone the prompt comes. Claude Code is never started: the projects' folders are missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { parseConfig } from '../src/config.ts';
import { ledungToolServer, SETTINGS_TOOLS, USER_APPROVED_TOOLS, type ManagerHandlers, type ToolHandlers } from '../src/sessions/tools.ts';
import { unaskedTool } from '../src/sessions/session.ts';
import { matchSensitive } from '../src/sessions/sensitive.ts';
import { namesAction, SETTINGS_RULE, settingsAction, wordsFor, type Word } from '../src/sessions/word.ts';
import type { SettingsPort } from '../src/sessions/management.ts';
import { deskQuestion, type QuestionDetails } from '../src/shared/questions.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

process.env.LEDUNG_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-settings-word-data-'));

const ACTIONS = ['relay_address', 'relay_admin_key', 'link_code', 'link_computer', 'invite_computer'];
const CODE = 'pc-2.relay.example.test/K7QM3XR9TPLW';

// --- Which words name which action ------------------------------------------------------------------------

const typed = (text: string): Word[] => [{ key: 'm1', text }];
const named = (action: Parameters<typeof wordsFor>[0], input: Record<string, unknown>, text: string) => wordsFor(action, input, typed(text)).length === 1;

test('a typed instruction allows an action only with its arguments as the user gave them, and nothing holding it back', () => {
  assert.ok(named('relay_admin_key', {}, 'Please make a new admin key for the relay'));
  assert.ok(named('relay_admin_key', {}, 'Generate the relay admin key and tell me its hash.'));
  assert.ok(!named('relay_admin_key', {}, "Don't make a new admin key yet"), 'held back');

  assert.ok(named('relay_address', { relay: 'wss://relay.example.org' }, 'Set the relay to relay.example.org'));
  assert.ok(named('relay_address', { relay: 'wss://relay.example.org' }, 'set the relay address to wss://relay.example.org/'));
  assert.ok(!named('relay_address', { relay: 'wss://evil.example.org' }, 'Set the relay to relay.example.org'), 'another address');
  assert.ok(!named('relay_address', { relay: 'wss://example.org' }, 'Set the relay to relay.example.org'), 'a part of the address is not the address');

  assert.ok(named('link_code', {}, 'give me a link code'));
  assert.ok(named('link_computer', { code: CODE }, `link with ${CODE} please`));
  assert.ok(!named('link_computer', { code: 'pc-3.relay.example.test/AAAAAAAAAAAA' }, `link with ${CODE}`), 'another code');

  assert.ok(named('invite_computer', { owner: 'Anna' }, 'invite a computer for Anna'));
  assert.ok(named('invite_computer', { owner: 'Anna' }, "Invite Anna's computer to the relay"));
  assert.ok(!named('invite_computer', { owner: 'Annabel' }, 'invite a computer for Anna'), 'another owner');
  assert.ok(named('invite_computer', { owner: 'Anna', name: 'annas-pc' }, 'invite annas-pc for Anna'));
  assert.ok(!named('invite_computer', { owner: 'Anna', name: 'other' }, 'invite a computer for Anna'), 'a name the user did not give');
  // The owner is who the user named, not any word of the line (review of #263, finding 3).
  for (const owner of ['a', 'for', 'computer', 'invite']) assert.ok(!named('invite_computer', { owner }, 'invite a computer for Anna'), `owner "${owner}"`);

  // A hold anywhere in the words stops it, even meant for something else: one prompt rather than a guess
  // (review of #263, round 2, finding 1).
  assert.ok(!named('link_code', {}, 'Make a link code.\nWait for my go on the rest.'));
  assert.ok(!named('link_code', {}, 'Make a link code later'));
  // Two instructions in one line, as people write them.
  for (const action of ['relay_address', 'invite_computer'] as const) {
    assert.ok(named(action, { relay: 'wss://relay.example.test', owner: 'Anna' }, 'Set the relay to wss://relay.example.test, then invite a computer for Anna.'), action);
  }
});

// Review of #263, finding 1: a line that only mentions or reports an action must not allow it; when in doubt, it asks.
test('a mention, a question or a report never allows an action', () => {
  const mentions: [Parameters<typeof wordsFor>[0], Record<string, unknown>, string][] = [
    ['relay_admin_key', {}, "I've put the new admin key's hash in the relay config."],
    ['relay_admin_key', {}, 'I put the new admin key\'s hash in the relay'],
    ['relay_admin_key', {}, 'Done, the new admin key is on the relay.'],
    ['relay_admin_key', {}, 'Can you get me the admin key hash?'],
    ['relay_admin_key', {}, 'Is there a new admin key yet?'],
    ['relay_admin_key', {}, 'What is the admin key for?'],
    ['relay_admin_key', {}, 'Make a new admin key?'],
    ['relay_admin_key', {}, 'We should make a new admin key at some point'],
    ['invite_computer', { owner: 'Anna' }, 'Did the invite for Anna work?'],
    ['invite_computer', { owner: 'Anna' }, 'The invite for Anna worked.'],
    ['relay_address', { relay: 'wss://old.example.org' }, 'Is the relay at old.example.org still running?'],
    ['relay_address', { relay: 'wss://old.example.org' }, 'relay: wss://old.example.org/'],
    ['link_code', {}, 'The link code expired.'],
    ['link_computer', { code: CODE }, CODE],
    ['link_computer', { code: CODE }, `The other computer showed ${CODE}`],
  ];
  for (const [action, input, text] of mentions) assert.ok(!named(action, input, text), `${action}: "${text}"`);
});

// Review of #263, round 2, findings 1 and 3: a hold in a later sentence, or a condition Ledung can't check, asks.
test('a hold anywhere in the words, or a condition on the instruction, asks', () => {
  for (const text of [
    'Make a new admin key. Wait, not yet.',
    'Make a new admin key. No, wait until I have updated the relay server.',
    'Make a new admin key. Actually hold off.',
    'Make a new admin key if the relay refuses the old one',
    'Make a new admin key once the relay is updated',
    'Make a new admin key unless one exists',
    'Make a new admin key or a link code',
  ]) assert.ok(!named('relay_admin_key', {}, text), text);
  assert.ok(named('relay_admin_key', {}, 'Make a new admin key and tell me its hash.'), 'a plain instruction still counts');
});

// Lead's review of #263, round 3: an allow-list. Every part of the words must be a known instruction or filler;
// a retraction, a doubt or anything else in any sentence and the action asks.
test('words count only when every part of them is a known instruction or filler', () => {
  for (const text of [
    // Round 3's lines.
    'Make a new admin key. Actually, keep the old one.',
    'Make a new admin key. Or maybe not.',
    'Make a new admin key. On second thought, leave it.',
    // Made up in the same spirit: retractions and doubts no word list names.
    'Make a new admin key. Hmm, the relay is busy today.',
    'Make a new admin key. Let me check with Anna first.',
    'Make a new admin key. Ignore that.',
    'Make a new admin key. Sorry, wrong chat.',
    'Make a new admin key — no.',
    'Make a new admin key. The old one is fine though.',
    'Make a new admin key, unless you already did.',
    'Make a new admin key. Tell me when it is done.',
    'Make a new admin key for Anna',
    'Make a new admin key 🙂 jk',
    'make a new admin key and also delete the old relay',
  ]) assert.ok(!named('relay_admin_key', {}, text), text);
  // Plain instructions, with filler around them, still count.
  for (const text of [
    'Make a new admin key',
    'Please make a new admin key for the relay. Thanks!',
    'ok, make a new admin key',
    'Create the relay admin key and tell me its hash.',
  ]) assert.ok(named('relay_admin_key', {}, text.replace('ok, ', 'ok. ')), text);
  assert.ok(named('link_code', {}, 'Give me a link code, and link with ' + CODE + '.'));
  assert.ok(named('link_computer', { code: CODE, name: 'Laptop' }, `Link with ${CODE} as Laptop`));
  assert.ok(!named('link_computer', { code: CODE }, `Link with ${CODE} as Laptop`), 'a name the user gave, not used');
});

// An answer counts only as a button press: exactly one option, whose whole text is the call (lead's review, round 4).
// The options are built as the desk builds them from what ask_user stored.
type Opt = { key: string; text: string; cost?: string };
const question = (options: Opt[], extra: Partial<QuestionDetails> = {}) =>
  ({ options: deskQuestion({ question: extra.title ?? 'Which?', options: null, details: { title: extra.title ?? 'Which?', issue: 'x', options, ...extra } }).options });
const answered = (text: string, a: ReturnType<typeof question>, action: Parameters<typeof wordsFor>[0] = 'relay_admin_key', input: Record<string, unknown> = {}) =>
  wordsFor(action, input, [{ key: 'q1', text, ask: a }]).length === 1;

test("an answer counts only as exactly one option whose whole text is the call; no yes, no free text", () => {
  const keyOrKeep = question([{ key: 'a', text: '**Keep it**' }, { key: 'b', text: '**Make a new admin key**' }], { recommended: 'b' });
  assert.ok(answered('b — Make a new admin key', keyOrKeep), 'the button press');
  assert.ok(!answered('b', keyOrKeep), 'a typed bare key asks (round 5)');
  assert.ok(!answered('a', keyOrKeep), 'a typed bare key asks (round 5)');
  assert.ok(answered('Make a new admin key', keyOrKeep), 'its label');
  assert.ok(answered('b — Make a new admin key, please', keyOrKeep), 'with filler');
  assert.ok(!answered('a', keyOrKeep), 'the other option');
  assert.ok(!answered('a — Keep it', keyOrKeep));
  // Round 4, finding 1: a bare yes never counts, whatever the manager recommended.
  const keepQuestion = question([{ key: 'a', text: '**Keep it**' }, { key: 'b', text: '**Make a new admin key** — replaces the old one' }], { title: 'Keep the current admin key?', recommended: 'b' });
  for (const yes of ['yes', 'Yes', 'ok', 'yes please', 'go ahead', 'sure']) assert.ok(!answered(yes, keepQuestion), yes);
  assert.ok(!answered('yes', question([{ key: 'a', text: '**Make a new admin key**' }], { recommended: 'a' })), 'even a single option');
  // Round 5: options keyed "yes" / "ok" can't turn a typed yes into a press; no bare key counts.
  const yesKeys = question([{ key: 'yes', text: '**Make a new admin key**' }, { key: 'no', text: '**Keep it**' }], { title: 'Keep the current admin key?' });
  for (const yes of ['yes', 'Yes', 'Yes, thanks', 'yes please']) assert.ok(!answered(yes, yesKeys), yes);
  assert.ok(!answered('ok', question([{ key: 'ok', text: '**Make a new admin key**' }, { key: 'no', text: '**Keep it**' }])), 'key "ok"');
  assert.ok(answered('yes — Make a new admin key', yesKeys), 'the button press itself still counts');
  // Free text never counts, not even the instruction itself.
  assert.ok(!answered('Make a new admin key', question([])), 'an answer with no options');
  assert.ok(!answered('b — Make a new admin key. Tell me the hash', keyOrKeep), 'more than the button');
  assert.ok(!answered('b but not today', keyOrKeep));
  assert.ok(!answered('b or a', keyOrKeep));
  // Round 4, finding 2: the option's whole text must be the call; a condition in its detail or cost asks.
  const later = question([{ key: 'a', text: '**Make a new admin key**' }, { key: 'b', text: '**Make a new admin key** later, after the relay is updated' }]);
  assert.ok(!answered('b', later), 'a condition in the detail');
  assert.ok(!answered('b — Make a new admin key', later));
  assert.ok(!answered('b', question([{ key: 'b', text: '**Make a new admin key**', cost: 'only once the relay is updated' }])), 'a condition in the cost');
  assert.ok(!answered('b', keepQuestion), 'any detail at all: one prompt');
  assert.ok(!answered('a', question([{ key: 'a', text: '**Invite a computer for Anna** once she confirms her name' }]), 'invite_computer', { owner: 'Anna' }));
  assert.ok(!answered('a', question([{ key: 'a', text: "**Set the relay to x.org** unless you'd rather keep y" }]), 'relay_address', { relay: 'wss://x.org' }));
  // The arguments are the option's.
  const invite = question([{ key: 'a', text: 'Invite a computer for Anna' }, { key: 'b', text: 'Wait' }]);
  assert.ok(answered('a — Invite a computer for Anna', invite, 'invite_computer', { owner: 'Anna' }));
  assert.ok(!answered('a — Invite a computer for Anna', invite, 'invite_computer', { owner: 'Bob' }), 'Anna is not Bob');
  assert.ok(answered('a — Set the relay to wss://b.example.org', question([{ key: 'a', text: 'Set the relay to wss://b.example.org' }, { key: 'b', text: 'Keep a.example.org' }]), 'relay_address', { relay: 'wss://b.example.org' }));
  // A plain question's options, as a button press sends them.
  const plain = { options: deskQuestion({ question: 'Which?', options: ['Make a new admin key (recommended)', 'Keep the old one'], details: null }).options };
  assert.ok(answered('Make a new admin key (recommended)', plain));
  assert.ok(!answered('yes', plain));
});

test('the Settings actions are sensitive under their own rule, whatever the project lets its manager do unasked', () => {
  assert.deepEqual(ACTIONS.map((a) => settingsAction(`mcp__ledung__${a}`)), ACTIONS);
  assert.equal(settingsAction('mcp__ledung__settings_status'), null, 'reading is not an action');
  assert.equal(settingsAction('mcp__other__relay_admin_key'), null, "another server's tool");
  for (const t of SETTINGS_TOOLS) {
    assert.ok(!unaskedTool(t, []), `${t} is never unasked, also with projectToolsUnasked`);
    assert.deepEqual(matchSensitive(t, {}, {}, [...SETTINGS_TOOLS]), { rule: SETTINGS_RULE });
  }
  assert.ok(unaskedTool('mcp__ledung__settings_status', USER_APPROVED_TOOLS), 'settings_status reads, like list_projects');
  assert.ok(namesAction('link_code', {}, 'make a new link code'));
  assert.ok(!namesAction('link_code', {}, 'new link code'), 'no verb, no instruction');
});

// --- Who gets the tools -----------------------------------------------------------------------------------

const toolNames = (h: ToolHandlers) => Object.keys((ledungToolServer(h).instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
const anyManager = new Proxy({}, { get: () => () => '' }) as ManagerHandlers;

test("only a manager outside lockdown level B has the Settings tools; a worker can't call them", () => {
  const manager: ToolHandlers = { userName: 'Simon', role: 'manager', asksWhom: 'Simon', ask: () => { throw new Error('not called'); }, withdraw: () => '', manager: anyManager };
  for (const t of [...ACTIONS, 'settings_status']) assert.ok(toolNames(manager).includes(t), t);
  const worker: ToolHandlers = { userName: 'Simon', role: 'session', asksWhom: 'your manager', ask: () => { throw new Error('not called'); }, withdraw: () => '' };
  const airgapped: ToolHandlers = { ...manager, airgap: true };
  for (const t of [...ACTIONS, 'settings_status']) {
    assert.ok(!toolNames(worker).includes(t), `worker: ${t}`);
    assert.ok(!toolNames(airgapped).includes(t), `level B: ${t}`);
  }
});

// --- The gate, in a real session ------------------------------------------------------------------------

type Hook = (input: unknown, id: string) => Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;
type Tool = { handler(a: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> };
type Opts = {
  hooks?: { PreToolUse?: { hooks: Hook[] }[]; PostToolUse?: { hooks: ((input: unknown) => Promise<{ hookSpecificOutput?: { additionalContext?: string } }>)[] }[] };
  mcpServers?: Record<string, { instance: { _registeredTools: Record<string, Tool> } }>;
};

function ledung(projectToolsUnasked = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-settings-word-')));
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects: [{ name: 'p', runner: 'local', path: path.join(root, 'missing'), projectToolsUnasked }] }), store, () => {}));
  // A stand-in for the server's Settings, counting what runs; the routes' own code is the server's.
  const ran: string[] = [];
  const port: SettingsPort = {
    relay: () => ({ relay: null, keySha256: null, tokenSet: false }),
    setRelay: (relay) => { ran.push(`relay ${relay}`); return { relay, keySha256: null, tokenSet: false }; },
    makeAdminKey: () => { ran.push('key'); return { relay: null, keySha256: 'ab'.repeat(32), tokenSet: false }; },
    invite: async (owner) => { ran.push(`invite ${owner}`); return { id: 'i1', owner, name: 'x', host: 'x.relay.example.test', expiresAt: Date.now() + 60_000, code: 'JOIN' }; },
    linkCode: () => { ran.push('code'); return { code: 'here/SECRET', expiresAt: Date.now() + 60_000 }; },
    link: async (code, name) => { ran.push(`link ${code}`); return { id: 'l1', name: name ?? 'pc-2', publicName: 'pc-2.relay.example.test', linkedAt: 0, lastUsedAt: null }; },
    links: () => ({ problem: null, links: [] }),
    computers: () => [],
  };
  manager.setSettings(port);
  const start = async (role: 'manager' | 'session') => {
    const s = await manager.start('p', undefined, { role });
    store.updateSession(s.id, { status: 'running' });
    return s.id;
  };
  const options = (id: string) => (manager as unknown as { live: Map<string, { claudeOptions(h: object): Promise<Opts> }> }).live.get(id)!.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  let n = 0;
  /** One tool call as Claude Code makes it: the PreToolUse hook, and the tool only if the hook allowed it. */
  const call = async (id: string, tool: string, input: Record<string, unknown> = {}) => {
    const o = await options(id);
    const toolUseId = `tu-${++n}`;
    const out = await o.hooks!.PreToolUse![0]!.hooks[0]!({ tool_name: `mcp__ledung__${tool}`, tool_input: input }, toolUseId);
    const decision = out.hookSpecificOutput?.permissionDecision ?? null;
    let result: string | null = null;
    let note: string | null = null;
    if (decision === 'allow') {
      result = (await o.mcpServers!.ledung!.instance._registeredTools[tool]!.handler(input)).content[0]!.text;
      note = (await o.hooks!.PostToolUse![0]!.hooks[0]!({ tool_use_id: toolUseId })).hookSpecificOutput?.additionalContext ?? null;
    }
    return { decision, result, note };
  };
  /** The user typed this into the session: on this computer (here), or through the public name. */
  const typed = (id: string, text: string, here: boolean) => store.addMessage(id, 'user', here ? { text, here: true } : { text });
  return { manager, store, start, call, typed, ran, options };
}

test('a manager without the user\'s word gets a prompt to the user, even in a project whose manager may use project tools unasked', async () => {
  for (const unasked of [false, true]) {
    const { start, call, ran, store, manager } = ledung(unasked);
    const id = await start('manager');
    for (const t of ACTIONS) assert.equal((await call(id, t, { relay: 'wss://r.example.org', code: CODE, owner: 'Anna' })).decision, 'ask', `${t}, unasked ${unasked}`);
    assert.deepEqual(ran, [], 'nothing ran');
    // Claude Code then hands the call to Ledung's permission flow: a sensitive prompt for the user, not a grant's.
    const live = (manager as unknown as { live: Map<string, { onPermission(t: string, i: object, o: object): Promise<unknown> }> }).live.get(id)!;
    void live.onPermission('mcp__ledung__relay_admin_key', {}, { signal: new AbortController().signal, toolUseID: 'tu-x' });
    const asked = store.pendingPermissions().find((p) => p.sessionId === id)!;
    assert.equal(asked.sensitive, SETTINGS_RULE);
    assert.equal(asked.addressedTo, 'user');
  }
});

test("with the user's word typed on this computer the action runs once, and the session is told who allowed it", async () => {
  const { start, call, typed, ran, store } = ledung();
  const id = await start('manager');
  typed(id, 'Make a new admin key for the relay and tell me its hash.', true);
  const first = await call(id, 'relay_admin_key');
  assert.equal(first.decision, 'allow');
  assert.match(first.result!, new RegExp('ab'.repeat(32)), 'the hash comes back');
  assert.match(first.note!, /Simon asked for this \(relay admin key\) in what they typed at/);
  assert.ok(store.listMessages(id).some((m) => m.kind === 'event' && /Settings action allowed: Simon asked for this/.test(m.data.text)), 'in the history');
  // The same words once more: asked.
  assert.equal((await call(id, 'relay_admin_key')).decision, 'ask');
  assert.deepEqual(ran, ['key'], 'ran once');
  // New words: once more.
  typed(id, 'make a new admin key', true);
  assert.equal((await call(id, 'relay_admin_key')).decision, 'allow');
  assert.deepEqual(ran, ['key', 'key']);
  // One message naming two actions allows each of them once.
  typed(id, `Give me a link code, and link with ${CODE}.`, true);
  assert.equal((await call(id, 'link_code')).decision, 'allow');
  assert.equal((await call(id, 'link_computer', { code: CODE })).decision, 'allow');
  assert.equal((await call(id, 'link_computer', { code: CODE })).decision, 'ask');
  assert.deepEqual(ran, ['key', 'key', 'code', `link ${CODE}`]);
});

test('words from the phone, from anyone else, or naming something else never count; the prompt comes', async () => {
  const { start, call, typed, ran, store } = ledung();
  const id = await start('manager');
  typed(id, 'invite a computer for Anna', false);
  assert.equal((await call(id, 'invite_computer', { owner: 'Anna' })).decision, 'ask', 'typed through the public name (question #447, b)');
  // A delivered message (a worker's report, another manager, the board) carries `from`, even marked here.
  store.addMessage(id, 'user', { text: 'invite a computer for Anna', here: true, from: 'ledung' });
  assert.equal((await call(id, 'invite_computer', { owner: 'Anna' })).decision, 'ask', 'delivered, not typed');
  typed(id, 'invite a computer for Anna', true);
  assert.equal((await call(id, 'invite_computer', { owner: 'Bob' })).decision, 'ask', 'another owner');
  assert.equal((await call(id, 'relay_address', { relay: 'wss://anna.example.org' })).decision, 'ask', 'another action');
  assert.deepEqual(ran, []);
  // Too old: two days.
  const old = store.addMessage(id, 'user', { text: 'Give me a new link code', here: true });
  (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db.prepare('UPDATE messages SET at = ? WHERE id = ?').run(Date.now() - 3 * 24 * 3600 * 1000, old.id);
  assert.equal((await call(id, 'link_code')).decision, 'ask', 'more than two days ago');
});

test("an answer to the manager's own question counts only when given on this computer", async () => {
  const { start, call, ran, store } = ledung();
  const id = await start('manager');
  const remote = store.createQuestion({ sessionId: id, question: 'Shall I make a new admin key for the relay?', options: ['Make a new admin key (recommended)', 'Keep the old one'], addressedTo: 'user' });
  store.answerQuestion(remote.id, 'Make a new admin key (recommended)', 'user', null, false);
  assert.equal((await call(id, 'relay_admin_key')).decision, 'ask', 'answered on the phone');
  const here = store.createQuestion({ sessionId: id, question: 'Shall I make a new admin key for the relay?', options: ['Make a new admin key (recommended)', 'Keep the old one'], addressedTo: 'user' });
  store.answerQuestion(here.id, 'Make a new admin key (recommended)', 'user', null, true);
  const allowed = await call(id, 'relay_admin_key');
  assert.equal(allowed.decision, 'allow');
  assert.match(allowed.note!, new RegExp(`in their answer to question #${here.id}`));
  assert.equal((await call(id, 'relay_admin_key')).decision, 'ask', 'once');
  // A manager's own answer under its grant is not the user's.
  const granted = store.createQuestion({ sessionId: id, question: 'Shall I make a new admin key for the relay?', options: ['Make a new admin key (recommended)', 'Keep the old one'], addressedTo: 'user' });
  store.answerQuestion(granted.id, 'Make a new admin key (recommended)', id, null, true);
  assert.equal((await call(id, 'relay_admin_key')).decision, 'ask', "a manager's answer");
  assert.deepEqual(ran, ['key']);
});

// Review of #263, finding 2: one instruction runs once, however many of the user's words carry it.
test('one instruction said twice, typed and as the option picked in the manager\'s question, runs once', async () => {
  const { start, call, typed, ran, store } = ledung();
  const id = await start('manager');
  typed(id, 'make a new admin key', true);
  const asked = store.createQuestion({ sessionId: id, question: 'Shall I make a new relay admin key? It replaces the old one.', options: ['Make a new admin key (recommended)', 'Keep the old one'], addressedTo: 'user' });
  store.answerQuestion(asked.id, 'Make a new admin key (recommended)', 'user', null, true);
  assert.equal((await call(id, 'relay_admin_key')).decision, 'allow');
  assert.equal((await call(id, 'relay_admin_key')).decision, 'ask', 'the pick said the same thing: used up with the typed word');
  assert.deepEqual(ran, ['key']);
});

// Review of #263, finding 1, in the failure it describes: the report after the key was made doesn't make another.
test('a report-back line or a plan in a question never allows a second run', async () => {
  const { start, call, typed, ran, store } = ledung();
  const id = await start('manager');
  typed(id, 'make a new admin key', true);
  assert.equal((await call(id, 'relay_admin_key')).decision, 'allow');
  typed(id, "Done, I've put the new admin key's hash in the relay config.", true);
  assert.equal((await call(id, 'relay_admin_key')).decision, 'ask');
  // A yes to a question about something else, whose later line mentions the action, is not a yes to it.
  const merge = store.createQuestion({ sessionId: id, question: 'Merge PR #12?\nAfter that I will make a new admin key if needed.', options: null, addressedTo: 'user' });
  store.answerQuestion(merge.id, 'yes', 'user', null, true);
  assert.equal((await call(id, 'relay_admin_key')).decision, 'ask');
  // Round 4, finding 1, in a real session: "Keep the current admin key?" with the manager recommending to make one,
  // answered yes. Only a button press counts.
  const keep = store.createQuestion({ sessionId: id, question: 'Keep the current admin key?', options: null, addressedTo: 'user',
    details: { title: 'Keep the current admin key?', issue: 'x', options: [{ key: 'a', text: '**Keep it**' }, { key: 'b', text: '**Make a new admin key**' }], recommended: 'b' } });
  store.answerQuestion(keep.id, 'yes', 'user', null, true);
  assert.equal((await call(id, 'relay_admin_key')).decision, 'ask', 'a yes to "keep?" with the manager recommending b');
  // Round 3's either/or questions, answered yes: a question's prose never names the action, only an option does.
  for (const question of ['Make a new admin key? Or keep the current one?', 'Shall I make a new admin key?\nOr should I wait?', 'Shall I make a new admin key for the relay?']) {
    const q = store.createQuestion({ sessionId: id, question, options: null, addressedTo: 'user' });
    store.answerQuestion(q.id, 'yes', 'user', null, true);
    assert.equal((await call(id, 'relay_admin_key')).decision, 'ask', question);
  }
  assert.deepEqual(ran, ['key']);
});

test('an invite runs on the instruction that names its owner, once', async () => {
  const { start, call, typed, ran } = ledung();
  const id = await start('manager');
  typed(id, 'Invite a computer for Anna.', true);
  assert.equal((await call(id, 'invite_computer', { owner: 'a' })).decision, 'ask', 'not an owner the user named');
  const allowed = await call(id, 'invite_computer', { owner: 'Anna' });
  assert.equal(allowed.decision, 'allow');
  assert.match(allowed.result!, /join code.*JOIN/);
  assert.equal((await call(id, 'invite_computer', { owner: 'Anna' })).decision, 'ask');
  assert.deepEqual(ran, ['invite Anna']);
});

test("a worker's call is asked, however the user's words read in it", async () => {
  const { start, call, typed, ran } = ledung(true);
  const worker = await start('session');
  typed(worker, 'Make a new admin key for the relay', true);
  assert.equal((await call(worker, 'relay_admin_key')).decision, 'ask');
  assert.deepEqual(ran, []);
});
