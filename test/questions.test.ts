// Structured questions (issue #59): ask_user's optional fields, stored through migration 20, and how the
// question desk shows a structured and a plain question and orders the queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { askedQuestion, ledungToolServer, type ToolHandlers } from '../src/sessions/tools.ts';
import { deskCompare, deskQuestion, disagree, mergeTiers, tierOf, titleFrom, type QuestionDetails } from '../src/shared/questions.ts';

// The example from the mockup Martin approved (2026-10-14).
const MERGE = {
  title: 'Merge PR #212 as one PR, or split the rounding change out?',
  issue: 'PR #212 fixes the cart total. It also changed how line prices round.',
  evidence: '- `npm test`: 412 passed, 0 failed.',
  options: [
    { key: 'a', text: '**Merge as one PR.** The rounding change ships with the VAT fix.', cost: 'Nothing now.' },
    { key: 'b', text: '**Split the rounding change into its own PR.** The VAT fix merges today.', cost: 'About 30 minutes.' },
    { key: 'c', text: '**Hold the PR.**', cost: 'The fix waits a day or two.' },
  ],
  recommended: 'a',
  why: 'Both changes are small and tested together.',
  reviewer: { pick: 'b', who: 'Reviewer session', why: 'Finance will notice the rounding change.' },
  tier: 'Blocks a finished PR',
  rank: 1,
  refs: ['PR #212', '#198'],
};

/** ask_user as Claude Code calls it: the arguments checked against the tool's schema, then its handler. */
function askUser() {
  const asked: { question: string; options: string[] | null; details: QuestionDetails | null | undefined }[] = [];
  const h: ToolHandlers = {
    userName: 'Simon', role: 'session', asksWhom: 'Simon',
    ask: (question, options, _about, _request, details) => { asked.push({ question, options, details }); return { id: asked.length } as never; },
    withdraw: () => '',
  };
  const tool = (ledungToolServer(h).instance as unknown as { _registeredTools: Record<string, { inputSchema: { safeParse(a: unknown): { success: boolean } }; handler(a: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> }> })._registeredTools['ask_user']!;
  const call = async (args: Record<string, unknown>) => {
    assert.ok(tool.inputSchema.safeParse(args).success, `the schema takes ${JSON.stringify(args).slice(0, 80)}`);
    const r = await tool.handler(args);
    return { text: r.content[0]!.text, isError: !!r.isError };
  };
  return { asked, call, schema: tool.inputSchema };
}

test('a plain ask_user call works unchanged: its text and labels, no fields', async () => {
  const { asked, call } = askUser();
  const r = await call({ question: 'Release now?', options: ['Yes (recommended)', 'No'] });
  assert.equal(r.isError, false);
  assert.match(r.text, /^Question #1 is recorded/);
  assert.deepEqual(asked, [{ question: 'Release now?', options: ['Yes (recommended)', 'No'], details: null }]);
});

test('a structured call: the fields are kept, and the text and buttons everything else shows are written from them', async () => {
  const { asked, call } = askUser();
  const r = await call(MERGE);
  assert.equal(r.isError, false);
  const q = asked[0]!;
  assert.deepEqual(q.details, MERGE);
  assert.deepEqual(q.options, ['a — Merge as one PR', 'b — Split the rounding change into its own PR', 'c — Hold the PR']);
  assert.ok(q.question.startsWith(`**${MERGE.title}**\n\n${MERGE.issue}`), 'title and issue lead the text a manager or the chat shows');
  assert.ok(q.question.includes('- b) **Split the rounding change into its own PR.** The VAT fix merges today. Cost: About 30 minutes.'));
  assert.ok(q.question.includes('Recommended: a. Both changes are small'));
  assert.ok(q.question.includes('Reviewer session: b. Finance will notice'));
});

test("the asker's own text wins over the written one; fields alone without options are kept too", async () => {
  const { asked, call } = askUser();
  await call({ question: 'My own words.', tier: 'Housekeeping', options: ['Yes', 'No'] });
  assert.deepEqual(asked[0], { question: 'My own words.', options: ['Yes', 'No'], details: { tier: 'Housekeeping' } });
});

test('ask_user refuses fields that do not fit together, as a message the asker can act on', async () => {
  const { asked, call, schema } = askUser();
  assert.match((await call({ ...MERGE, recommended: 'z' })).text, /recommended is "z", which is not one of the option keys \(a, b, c\)/);
  assert.match((await call({ ...MERGE, reviewer: { pick: 'q' } })).text, /reviewer\.pick is "q"/);
  assert.match((await call({ issue: 'x', options: [{ key: 'a', text: 'A' }, { key: 'a', text: 'B' }] })).text, /its own key/);
  assert.equal((await call({ title: 'Only a title' })).isError, false, 'a title alone is a question');
  assert.equal(schema.safeParse({}).success, true);
  assert.match((await askUser().call({})).text, /Give the question, or at least issue/);
  assert.equal(schema.safeParse({ question: 'q', options: ['only one'] }).success, false, 'labels: still two to five');
  assert.equal(asked.length, 1);
});

test('the fields are stored through the new migration and come back with the question; an old-style question has none', () => {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default' });
  const a = askedQuestion(MERGE);
  const structured = store.createQuestion({ sessionId: 's1', question: a.question, options: a.options, addressedTo: 'user', details: a.details });
  const plain = store.createQuestion({ sessionId: 's1', question: 'Release now?', options: ['Yes', 'No'], addressedTo: 'user' });
  assert.deepEqual(store.getQuestion(structured.id)!.details, MERGE);
  assert.equal(store.getQuestion(plain.id)!.details, null);
  assert.deepEqual(store.listQuestions().map((q) => q.details === null), [false, true]);
});

test('the desk shows a structured question from its fields', () => {
  const a = askedQuestion(MERGE);
  const v = deskQuestion({ question: a.question, options: a.options, details: a.details });
  assert.equal(v.structured, true);
  assert.equal(v.title, MERGE.title);
  assert.equal(v.issue, MERGE.issue);
  assert.equal(v.evidence, MERGE.evidence);
  assert.deepEqual(v.options[1], { key: 'b', label: 'Split the rounding change into its own PR', detail: 'The VAT fix merges today.', cost: 'About 30 minutes.', answer: 'b — Split the rounding change into its own PR' });
  // The older pair is two opinions, the reviewer's left as before and the asker's (who: null) right (issue #96).
  assert.deepEqual(v.opinions, [
    { who: 'Reviewer session', pick: 'b', why: 'Finance will notice the rounding change.' },
    { who: null, pick: 'a', why: MERGE.why },
  ]);
  assert.deepEqual([v.tier, v.rank, v.refs], ['Blocks a finished PR', 1, ['PR #212', '#198']]);
});

test("a plain question degrades: its text is The issue, its first sentence the title, its \"(recommended)\" option the asker's pick", () => {
  const text = 'Should the invoice PDFs switch to the new template now? The session has it ready.';
  const v = deskQuestion({ question: text, options: ['Keep the old template', 'Switch now (recommended)', 'Switch after month end'], details: null });
  assert.equal(v.structured, false);
  assert.equal(v.title, 'Should the invoice PDFs switch to the new template now?');
  assert.equal(v.issue, text);
  assert.deepEqual(v.opinions, [{ who: null, pick: '2', why: '' }]);
  assert.deepEqual(v.options.map((o) => [o.key, o.label, o.answer]), [
    ['1', 'Keep the old template', 'Keep the old template'],
    ['2', 'Switch now', 'Switch now (recommended)'],
    ['3', 'Switch after month end', 'Switch after month end'],
  ]);
  assert.deepEqual(deskQuestion({ question: 'Which one stays?', options: null, details: null }).options, []);
});

test("the desk shows the asker's own question text beside a title or an issue, as the chat does (issue #294)", async () => {
  const { asked, call } = askUser();
  const own = 'Should the nightly export move to 02:00? It collides with the backup at 01:00.';
  await call({ question: own, title: 'Move the nightly export?', options: ['Move it (recommended)', 'Keep 01:00'], tier: 'Housekeeping' });
  await call({ question: own, issue: 'The export and the backup both start at 01:00.', options: [{ key: 'a', text: 'Move it' }, { key: 'b', text: 'Keep it' }], tier: 'Housekeeping' });
  const [titled, withIssue] = asked.map((a) => deskQuestion({ question: a.question, options: a.options, details: a.details ?? null }));
  assert.equal(titled!.title, 'Move the nightly export?');
  assert.equal(titled!.issue, own, 'not only the title and the buttons');
  assert.ok(withIssue!.issue.includes('The export and the backup both start at 01:00.'));
  assert.ok(withIssue!.issue.includes(own), 'the question is shown with the issue');
  // Own text that opens with the bold title, or with the issue, is still the asker's and is shown.
  const bold = '**Move it?**\n\nThe export collides with the backup. Move to 02:00?';
  const b = askedQuestion({ title: 'Move it?', question: bold, options: ['Move it', 'Keep it'] });
  assert.equal(deskQuestion({ question: b.question, options: b.options, details: b.details }).issue, bold);
  const i = askedQuestion({ issue: 'The export collides with the backup.', question: 'The export collides with the backup. Which one moves?', options: [{ key: 'a', text: 'Export' }, { key: 'b', text: 'Backup' }] });
  assert.ok(deskQuestion({ question: i.question, options: i.options, details: i.details }).issue.includes('Which one moves?'));
  // Text written from the fields, or the title repeated as the question, is not shown twice.
  const t = askedQuestion({ title: 'Move it?', question: 'Move it?', options: ['Yes', 'No'] });
  assert.equal(deskQuestion({ question: t.question, options: t.options, details: t.details }).issue, '');
  const a = askedQuestion({ title: 'Only a title', options: [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }] });
  assert.equal(deskQuestion({ question: a.question, options: a.options, details: a.details }).issue, '');
  const m = askedQuestion(MERGE);
  assert.equal(deskQuestion({ question: m.question, options: m.options, details: m.details }).issue, MERGE.issue);
});

test('a title: a first line standing alone, else the first sentence, else the start', () => {
  assert.equal(titleFrom('**Ship it?**\n\nThe details follow here.'), 'Ship it?');
  assert.equal(titleFrom('Two pages call themselves the install guide. Which stays?'), 'Two pages call themselves the install guide.');
  assert.equal(titleFrom('x'.repeat(150)), `${'x'.repeat(100)}…`);
});

test("queue order: the project's tier order, then rank, then oldest first; a tier the project doesn't name goes with none, last", () => {
  const tiers = ['Blocks a finished PR', 'Blocks work', 'Housekeeping'];
  assert.equal(tierOf('Blocks work', tiers), 'Blocks work');
  assert.equal(tierOf('Something else', tiers), null);
  assert.equal(tierOf('Blocks work', []), null, 'no setting: one group');
  const qs = [
    { id: 1, tier: null, rank: null, askedAt: 1 },
    { id: 2, tier: 'Housekeeping', rank: 2, askedAt: 2 },
    { id: 3, tier: 'Blocks work', rank: null, askedAt: 3 },
    { id: 4, tier: 'Blocks a finished PR', rank: 2, askedAt: 4 },
    { id: 5, tier: 'Blocks a finished PR', rank: 1, askedAt: 5 },
    { id: 6, tier: 'Blocks work', rank: null, askedAt: 0 },
    { id: 7, tier: 'Blocks work', rank: 1, askedAt: 9 },
  ];
  assert.deepEqual(qs.sort(deskCompare(tiers)).map((q) => q.id), [5, 4, 7, 6, 3, 2, 1]);
  assert.deepEqual([{ id: 2, tier: null, rank: null, askedAt: 2 }, { id: 1, tier: null, rank: null, askedAt: 1 }].sort(deskCompare([])).map((q) => q.id), [1, 2]);
  assert.deepEqual(mergeTiers([['A', 'B'], ['C', 'A'], []]), ['A', 'B', 'C']);
});

test("the Overview's last reply shows a structured question that has no text of its own by its title", () => {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 's1', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default' });
  const say = (content: unknown[]) => store.addMessage('s1', 'sdk', { type: 'assistant', message: { content } });
  say([{ type: 'tool_use', id: 'a', name: 'mcp__ledung__ask_user', input: { title: MERGE.title, issue: MERGE.issue } }]);
  say([{ type: 'text', text: 'Waiting for your answer.' }]);
  assert.equal(store.lastReply('s1')!.text, MERGE.title);
  say([{ type: 'tool_use', id: 'b', name: 'mcp__ledung__ask_user', input: { issue: MERGE.issue } }]);
  say([{ type: 'text', text: 'Waiting for your answer.' }]);
  assert.equal(store.lastReply('s1')!.text, MERGE.issue);
});

// Issue #96: any number of opinions instead of the fixed asker and reviewer.
const OPINIONS = [
  { who: 'Asker', pick: 'a', why: 'Both changes are small.' },
  { who: 'Reviewer', pick: 'b', why: 'Finance will notice.' },
  { who: 'Test reviewer', pick: 'a' },
  { who: 'Steward', why: 'Neither: hold it for the release notes.' },
];

test('ask_user takes opinions, any number: kept in order, written into the text, a pick that is no option refused', async () => {
  const { asked, call, schema } = askUser();
  const base = { title: MERGE.title, issue: MERGE.issue, options: MERGE.options, tier: MERGE.tier };
  assert.equal((await call({ ...base, opinions: OPINIONS })).isError, false);
  assert.deepEqual(asked[0]!.details!.opinions, OPINIONS);
  assert.ok(asked[0]!.question.includes('Reviewer: b. Finance will notice.'));
  assert.ok(asked[0]!.question.includes('Steward: no pick among the options. Neither: hold it for the release notes.'));
  const seven = Array.from({ length: 7 }, (_, i) => ({ who: `Session ${i + 1}`, pick: 'c' }));
  assert.ok(schema.safeParse({ ...base, opinions: seven }).success, 'more than five is fine');
  await call({ ...base, opinions: [] });
  assert.equal(asked[1]!.details!.opinions, undefined, 'zero opinions: none stored');
  assert.match((await call({ ...base, opinions: [{ who: 'Reviewer', pick: 'z' }] })).text, /opinions\[0\]\.pick is "z", which is not one of the option keys \(a, b, c\)/);
  assert.equal(schema.safeParse({ ...base, opinions: [{ pick: 'a' }] }).success, false, 'an opinion says who gives it');
});

test("the desk shows the opinions in order, after an older question's pair; they disagree when their picks differ", () => {
  const a = askedQuestion({ title: MERGE.title, options: MERGE.options, opinions: OPINIONS });
  const v = deskQuestion({ question: a.question, options: a.options, details: a.details });
  assert.deepEqual(v.opinions.map((o) => [o.who, o.pick]), [['Asker', 'a'], ['Reviewer', 'b'], ['Test reviewer', 'a'], ['Steward', null]]);
  assert.equal(disagree(v.opinions), true);
  assert.equal(disagree([{ who: 'A', pick: 'a', why: '' }, { who: 'B', pick: 'a', why: '' }, { who: 'C', pick: null, why: '' }]), false, 'no pick is no disagreement');
  const both = deskQuestion({ question: 'x', options: null, details: { ...MERGE, opinions: [{ who: 'Steward', pick: 'c' }] } });
  assert.deepEqual(both.opinions.map((o) => [o.who, o.pick]), [['Reviewer session', 'b'], [null, 'a'], ['Steward', 'c']]);
  assert.deepEqual(deskQuestion({ question: 'x', options: null, details: { title: 't', options: MERGE.options } }).opinions, [], 'none given: none shown');
});
