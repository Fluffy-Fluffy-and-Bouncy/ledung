// Reviews (docs/steps/pr-review.md, issue #145): ask_user's review, checked and stored in the question's
// fields; its evidence files checked when asked; the answer always in one of two forms.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { parseConfig } from '../src/config.ts';
import type { Management } from '../src/sessions/management.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { askedQuestion, LEDUNG_SERVER, ledungToolServer, type ToolHandlers } from '../src/sessions/tools.ts';
import { deskQuestion, reviewAnswer, reviewAnswerProblem, type QuestionDetails } from '../src/shared/questions.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-reviews-'));
const root = path.join(base, 'project');
fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
fs.writeFileSync(path.join(root, 'shots', 'empty-chat.png'), PNG);
fs.writeFileSync(path.join(root, 'test-output.log'), 'tests 412 passed\n');
fs.writeFileSync(path.join(root, '.env'), 'TOKEN=x');
fs.writeFileSync(path.join(base, 'outside.log'), 'outside');
after(() => removeTemp(base));

const REVIEW = {
  title: 'Empty chat area offers Add a project',
  tier: 'Blocks a finished PR',
  refs: ['#143', 'PR #144'],
  review: {
    solving: 'A new user saw an empty page with nothing to do.\nThey did not know where to start.',
    done: 'The empty chat area now offers "Add a project".',
    notes: 'Code review: no findings. Not tested on Safari.',
    evidence: [{ file: 'shots/empty-chat.png', caption: 'The empty chat area at 1280 px' }, { file: 'test-output.log', caption: 'Test run' }],
  },
};

/** ask_user as Claude Code calls it: the arguments checked against the tool's schema, then its handler. */
function askUser() {
  const asked: { question: string; options: string[] | null; details: QuestionDetails | null | undefined }[] = [];
  const h: ToolHandlers = {
    userName: 'Simon', role: 'manager', asksWhom: 'Simon',
    ask: (question, options, _about, _request, details) => { asked.push({ question, options, details }); return { id: asked.length, details } as never; },
    withdraw: () => '',
  };
  const tool = (ledungToolServer(h).instance as unknown as { _registeredTools: Record<string, { inputSchema: { safeParse(a: unknown): { success: boolean } }; handler(a: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> }> })._registeredTools['ask_user']!;
  const call = async (args: Record<string, unknown>) => {
    const r = await tool.handler(args);
    return { text: r.content[0]!.text, isError: !!r.isError };
  };
  return { asked, call, schema: tool.inputSchema };
}

test('ask_user takes a review: its sections kept in the fields, the text everything else shows written from them', async () => {
  const { asked, call, schema } = askUser();
  assert.ok(schema.safeParse(REVIEW).success);
  const r = await call(REVIEW);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Review #1 with 2 evidence files is recorded and has gone to Simon\. The answer will be "Accepted\.", perhaps with a note, or "Changes needed:"/);
  const q = asked[0]!;
  assert.deepEqual(q.details, REVIEW);
  assert.equal(q.options, null, 'a review has no option buttons: Accept and Changes needed are its own');
  assert.ok(q.question.startsWith(`**Review: ${REVIEW.title}**\n\n**What we were solving**\n\n${REVIEW.review.solving}\n\n**What was done**\n\n`));
  assert.ok(q.question.includes('**Notes**\n\nCode review: no findings.'));
  assert.ok(q.question.includes('- Test run (`test-output.log`)'));
});

test("a review without its context is refused, as is a field that is not a review's", async () => {
  const { asked, call, schema } = askUser();
  const without = (k: 'solving' | 'done') => { const r: Record<string, unknown> = { ...REVIEW.review }; delete r[k]; return { ...REVIEW, review: r }; };
  assert.equal(schema.safeParse(without('solving')).success, false, 'the schema asks for solving');
  assert.equal(schema.safeParse(without('done')).success, false, 'and for done');
  assert.equal(schema.safeParse({ ...REVIEW, review: { ...REVIEW.review, solving: '' } }).success, false, 'not empty');
  // Claude Code checks the schema, but the handler doesn't count on it: missing or blank is refused there too.
  assert.match((await call(without('solving'))).text, /^A review needs review\.solving, so it never arrives without its context\. Nothing was asked\.$/);
  assert.match((await call({ ...REVIEW, review: { ...REVIEW.review, solving: '  ', done: '\n' } })).text, /needs review\.solving and review\.done/);
  assert.match((await call({ ...REVIEW, title: undefined })).text, /needs title/);
  for (const extra of [{ options: ['Yes', 'No'] }, { opinions: [{ who: 'R' }] }, { evidence: 'checked' }, { question: 'q' }, { issue: 'i' }, { screenshots: [{ file: 'a.png', look_for: 'x' }] }, { about_request: 'req-12345678' }]) {
    const r = await call({ ...REVIEW, ...extra });
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.match(r.text, new RegExp(`^A review takes title, review, tier, rank and refs, not ${Object.keys(extra)[0]}: `));
  }
  assert.equal(schema.safeParse({ ...REVIEW, review: { ...REVIEW.review, evidence: Array.from({ length: 11 }, () => REVIEW.review.evidence[0]) } }).success, false, 'at most 10 files');
  assert.equal(schema.safeParse({ ...REVIEW, review: { ...REVIEW.review, evidence: [{ file: 'a.png' }] } }).success, false, 'each with a caption');
  assert.equal(asked.length, 0, 'nothing was asked');
});

test('a review without notes or evidence is still a review; empty notes are left out', () => {
  const a = askedQuestion({ title: 'T', tier: 'Process', review: { solving: 'S', done: 'D', notes: ' ' } });
  assert.deepEqual(a.details, { title: 'T', tier: 'Process', review: { solving: 'S', done: 'D' } });
  assert.ok(!a.question.includes('Notes') && !a.question.includes('Evidence'));
});

test('the answer is always "Accepted." with an optional note, or "Changes needed:" with the text it needs', () => {
  assert.deepEqual(reviewAnswer('accept', ''), { answer: 'Accepted.' });
  assert.deepEqual(reviewAnswer('accept', '  Nice work. '), { answer: 'Accepted.\n\nNice work.' });
  assert.deepEqual(reviewAnswer('changes', 'The button is cut off at 390 px.'), { answer: 'Changes needed: The button is cut off at 390 px.' });
  assert.ok('problem' in reviewAnswer('changes', '  '));
  for (const ok of ['Accepted.', 'Accepted.\n\nNice.', 'Changes needed: x']) assert.equal(reviewAnswerProblem(ok), null, ok);
  for (const bad of ['Yes', 'Accepted', 'Acceptedish.', 'Changes needed:', 'Changes needed:   ', 'accepted.']) assert.ok(reviewAnswerProblem(bad), bad);
});

test("the desk shows a review by its sections; the queue's excerpt is the first line of what we were solving", () => {
  const a = askedQuestion(REVIEW);
  const v = deskQuestion({ question: a.question, options: a.options, details: a.details });
  assert.deepEqual([v.structured, v.title, v.options, v.opinions, v.tier, v.refs], [true, REVIEW.title, [], [], REVIEW.tier, REVIEW.refs]);
  assert.deepEqual(v.review, REVIEW.review);
  assert.equal(deskQuestion({ question: 'x', options: null, details: { title: 't', issue: 'i' } }).review, null);
});

function chain() {
  // The real chain: the session's tool server → Session.ask → Management → the session manager's check
  // on the project folder → the store.
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects: [{ name: 'p', runner: 'local', path: root }] }), store, () => {}));
  const info = store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager', parentId: null, permissionMode: 'default', role: 'manager' });
  const management = (manager as unknown as { management: Management }).management;
  const session = new Session({
    info, store, publish: () => {}, userName: 'Simon', management,
    runner: { cwd: root, currentBranch: async () => null } as never,
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
  });
  return { store, manager, management, session };
}

async function askTool(session: Session) {
  const options = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
  return (options.mcpServers![LEDUNG_SERVER] as unknown as {
    instance: { _registeredTools: Record<string, { handler(a: unknown, extra: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> }> };
  }).instance._registeredTools.ask_user!;
}

test('through the real chain: evidence files are checked when asked, a bad one stores nothing, good ones are stored with their kind', async () => {
  const { store, session } = chain();
  const ask = await askTool(session);
  for (const [file, reason] of [
    ['../outside.log', /Only files inside the project folder/],
    ['.env', /only PNG and JPEG images and \.txt, \.log or \.md text files/],
    ['missing.png', /There is no file/],
  ] as const) {
    const bad = await ask.handler({ ...REVIEW, review: { ...REVIEW.review, evidence: [REVIEW.review.evidence[0], { file, caption: 'x' }] } }, {});
    assert.equal(bad.isError, true, file);
    assert.match(bad.content[0]!.text, new RegExp(`^Evidence 2 \\(${file.replace(/[.\\/]/g, '\\$&')}\\) can't be attached: `));
    assert.match(bad.content[0]!.text, reason);
    assert.match(bad.content[0]!.text, /Nothing was asked\.$/);
  }
  assert.equal(store.listQuestions().length, 0, 'nothing was asked');

  const good = await ask.handler({ ...REVIEW, review: { ...REVIEW.review, evidence: [{ file: './shots/empty-chat.png', caption: ' The empty chat\narea ' }, { file: path.join(root, 'test-output.log'), caption: 'Test run' }] } }, {});
  assert.equal(good.isError, undefined, good.content[0]!.text);
  const [q] = store.listQuestions();
  assert.match(good.content[0]!.text, new RegExp(`^Review #${q!.id} with 2 evidence files is recorded`));
  // Stored relative to the folder, captions on one line, each with its kind; no screenshots to judge.
  assert.deepEqual(q!.details!.review!.evidence, [
    { file: 'shots/empty-chat.png', caption: 'The empty chat area', kind: 'image' },
    { file: 'test-output.log', caption: 'Test run', kind: 'text' },
  ]);
  assert.equal(q!.shots, null);
  assert.ok(q!.question.includes('- Test run (`test-output.log`)'), 'the text names the files as stored');
});

test("the user's answer to a review is taken only in its form; a manager deciding or forwarding is held to it too", async () => {
  const { store, manager, management, session } = chain();
  const ask = await askTool(session);
  await ask.handler({ ...REVIEW, review: { solving: 'S', done: 'D' } }, {});
  const [q] = store.listQuestions();
  await assert.rejects(manager.answerQuestion(q!.id, 'Looks good'), /A review is answered "Accepted\."/);
  assert.equal(store.getQuestion(q!.id)!.status, 'open');
  await manager.answerQuestion(q!.id, 'Changes needed: the label is cut off.').catch((e: Error) => {
    // The asker is no live session here; the answer is stored before Ledung tries to reach it.
    assert.match(e.message, /answer is saved/);
  });
  assert.equal(store.getQuestion(q!.id)!.answer, 'Changes needed: the label is cut off.');

  // A worker's review to its manager: the manager's own answer, or Simon's forwarded, must be in the form too.
  store.createSession({ id: 'w', project: 'p', runner: 'local', title: 'Worker', parentId: 'mgr', permissionMode: 'default' });
  const wq = store.createQuestion({ sessionId: 'w', question: 'r', options: null, addressedTo: 'mgr', details: { title: 'T', review: { solving: 'S', done: 'D' } } });
  await assert.rejects(management.answerQuestion('mgr', wq.id, 'ok'), /is a review\. A review is answered/);
  const plain = store.createQuestion({ sessionId: 'mgr', question: 'Go on?', options: null, addressedTo: 'user' });
  store.answerQuestion(plain.id, 'Yes', 'user');
  await assert.rejects(management.forwardAnswer('mgr', plain.id, wq.id), /is not in a review's form/);
  assert.equal(store.getQuestion(wq.id)!.status, 'open');
});

test("the page reads a review's text files through the review only, checked again when shown", async () => {
  const { store, manager, session } = chain();
  const ask = await askTool(session);
  await ask.handler(REVIEW, {});
  const [q] = store.listQuestions();
  assert.deepEqual(manager.readEvidenceText(q!.id, 1), { file: 'test-output.log', content: 'tests 412 passed\n' });
  assert.throws(() => manager.readEvidenceText(q!.id, 0), /no such text file/, 'an image goes through the image routes');
  assert.throws(() => manager.readEvidenceText(q!.id, 2), /no such text file/);
  assert.throws(() => manager.readEvidenceText(q!.id, 0.5), /no such text file/);
  fs.writeFileSync(path.join(root, 'test-output.log'), Buffer.from([0x41, 0, 0x42]));
  try {
    assert.throws(() => manager.readEvidenceText(q!.id, 1), /can't be attached/);
  } finally {
    fs.writeFileSync(path.join(root, 'test-output.log'), 'tests 412 passed\n');
  }
});
