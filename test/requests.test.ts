// One request page built from blocks (issue #502, docs/steps/request-blocks.md): ask_user's decisions and sign_off,
// the mixes it now takes and the ones it still refuses, every call accepted before stored as before, the answer built
// from the person's parts (a preset's byte-for-byte today's), the parts and drafts kept blanked, and the words the
// #350 line, waiting_for_you and notifications use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { askedQuestion, ledungToolServer, type ToolHandlers } from '../src/sessions/tools.ts';
import { reviewAnswer, type QuestionDetails } from '../src/shared/questions.ts';
import { shotAnswer } from '../src/shared/shots.ts';
import { isRequest, leftToAnswer, movingAnswer, requestAnswer, requestKinds, requestModel, type AnswerParts } from '../src/shared/requests.ts';
import { lineOutcome, questionLine } from '../src/shared/waiting-line.ts';
import { waitingItems } from '../web/src/notify.ts';
import type { QuestionInfo, QuestionShot } from '../src/shared/protocol.ts';
import { TODAY_CALLS } from './fixtures/ask-user-today.calls.ts';
import { waitingForYou } from '../src/sessions/waiting-tool.ts';
import { draftParts, emptyRequestDraft, isEmptyDraft, nextOpen, openParts, readDraft, rebaseDraft, sameDraft } from '../web/src/requestDraft.ts';

/** ask_user as Claude Code calls it: the arguments checked against the tool's schema, then its handler. */
function askUser() {
  const asked: { question: string; options: string[] | null; details: QuestionDetails | null | undefined; shots: unknown }[] = [];
  const h: ToolHandlers = {
    userName: 'Simon', role: 'manager', asksWhom: 'Simon',
    ask: (question, options, _about, _request, details, shots) => {
      asked.push({ question, options, details, shots });
      return { id: asked.length, details, shots: shots?.length ? shots : null } as never;
    },
    withdraw: () => '',
  };
  const tool = (ledungToolServer(h).instance as unknown as { _registeredTools: Record<string, { inputSchema: { safeParse(a: unknown): { success: boolean } }; handler(a: unknown): Promise<{ content: { text: string }[]; isError?: boolean }> }> })._registeredTools['ask_user']!;
  const call = async (args: Record<string, unknown>) => {
    const r = await tool.handler(args);
    return { text: r.content[0]!.text, isError: !!r.isError };
  };
  return { asked, call, schema: tool.inputSchema };
}

const D1 = { key: 'layout', title: 'Which layout?', options: [{ key: 'a', text: '**Stacked blocks** with a summary rail', cost: '2 h' }, { key: 'b', text: '**Tabs**' }], opinions: [{ who: 'Manager', pick: 'a', why: 'Reads on a phone.' }] };
const D2 = { key: 'side-chat', title: 'Ask about this', options: [{ key: 'a', text: '**Build it now**' }, { key: 'b', text: '**Later**, its own part' }] };
const REVIEW = { title: 'Request page', tier: 'Blocks a finished PR', refs: ['#502'], review: { solving: 'Three pages that cannot be combined.', done: 'One page built from blocks.' } };
const SHOTS = [{ file: 'shots/1280.png', look_for: 'the rail', group: 'Request page' }, { file: 'shots/390.png', look_for: 'Send above the keyboard', group: 'Request page' }];

test("every ask_user call accepted before #502 stores the same question, options and details as main's code did", () => {
  const today = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'ask-user-today.json'), 'utf8'));
  assert.equal(today.length, TODAY_CALLS.length);
  TODAY_CALLS.forEach((c, i) => assert.deepEqual(JSON.parse(JSON.stringify(askedQuestion(c))), today[i], JSON.stringify(c)));
  // None of them is a request: each still opens on the page it opened on.
  for (const c of TODAY_CALLS) {
    const a = askedQuestion(c);
    assert.equal(isRequest({ details: a.details, shots: (c.screenshots as unknown[] | undefined)?.length ? [{}] as QuestionShot[] : null }), false, JSON.stringify(c));
  }
});

test('new mixes are accepted: a review with screenshots and decisions, a sign-off with decisions, screenshots with decisions, two decisions', async () => {
  const { asked, call, schema } = askUser();
  const full = { ...REVIEW, opinions: [{ who: 'Manager', why: 'Looks right at 390 px.' }], screenshots: SHOTS, decisions: [D1, D2] };
  assert.ok(schema.safeParse(full).success);
  const r = await call(full);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Request #1 \(review, 2 decisions, 2 screenshots\) is recorded and has gone to Simon\. It is answered on one page/);
  assert.deepEqual(asked[0]!.details!.decisions!.map((x) => x.key), ['layout', 'side-chat']);
  assert.deepEqual(asked[0]!.details!.opinions, [{ who: 'Manager', why: 'Looks right at 390 px.' }]);
  // The text the chat and the manager read names every part.
  assert.match(asked[0]!.question, /\*\*Decision layout: Which layout\?\*\*/);
  assert.match(asked[0]!.question, /- b\) \*\*Later\*\*, its own part/);
  assert.match(asked[0]!.question, /Answered on the request page: each decision, and "Accepted\." or "Changes needed: …" as the sign-off\./);

  const signOff = await call({ title: 'Ship it?', issue: 'The build is done.', tier: 'Process', sign_off: true, decisions: [D1] });
  assert.equal(signOff.isError, false, signOff.text);
  assert.equal(asked[1]!.details!.signOff, true);
  assert.equal(asked[1]!.options, null, 'no option buttons in the chat: it is answered on its page');

  assert.equal((await call({ title: 'Look', tier: 'Process', screenshots: SHOTS, decisions: [D1] })).isError, false);
  assert.equal((await call({ title: 'Two', issue: 'Two things.', tier: 'Process', decisions: [D1, D2] })).isError, false);
  assert.equal((await call({ title: 'Sign only', tier: 'Process', sign_off: true })).isError, false);
  assert.equal(asked.length, 5);
});

test('bad mixes are refused, saying what to do instead', async () => {
  const { asked, call, schema } = askUser();
  const base = { title: 'T', issue: 'I', tier: 'Process' };
  const refused = async (args: Record<string, unknown>, re: RegExp) => {
    const r = await call(args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re);
    assert.match(r.text, /Nothing was asked\.$/);
  };
  await refused({ ...base, decisions: [D1, D2], options: ['Yes', 'No'] }, /With decisions, give options inside each decision instead/);
  await refused({ ...base, decisions: [D1, D2], opinions: [{ who: 'M', pick: 'a' }] }, /With decisions, give opinions inside each decision/);
  await refused({ ...base, decisions: [D1] }, /One decision alone is an ordinary question/);
  await refused({ ...base, decisions: [D1, { ...D2, key: 'layout' }] }, /Each decision needs its own key/);
  await refused({ ...base, decisions: [D1, { ...D2, key: 'Side Chat' }] }, /Decision key "Side Chat" is not a short key/);
  await refused({ ...base, decisions: [D1, { ...D2, opinions: [{ who: 'R', pick: 'z' }] }] }, /Decision "side-chat": opinions\[0\]\.pick is "z", which is not one of the option keys/);
  await refused({ ...base, decisions: Array.from({ length: 7 }, (_, i) => ({ ...D1, key: `d${i}` })) }, /at most 6 decisions; this has 7/);
  await refused({ tier: 'Process', decisions: [D1, D2] }, /needs title or issue/);
  await refused({ ...base, sign_off: true, options: ['Yes', 'No'] }, /A sign-off takes no options: put any question beside it in decisions/);
  await refused({ tier: 'Process', sign_off: true }, /A sign-off needs title or issue/);
  await refused({ ...base, sign_off: true, opinions: [{ who: 'M', pick: 'a' }] }, /Opinions beside a sign-off are views on the whole request and pick no option/);
  await refused({ ...REVIEW, issue: 'x', decisions: [D1] }, /A review takes title, review, tier, rank and refs .* not issue/);
  await refused({ ...base, screenshots: Array.from({ length: 41 }, () => SHOTS[0]) }, /at most 40 files.*this has 41/);
  await refused({ ...base, decisions: [D1, { ...D2, options: [{ key: 'a', text: 'A', outcome: 'Go' }, { key: 'b', text: 'B' }] }] }, /An option's outcome goes with run and block/);
  // The schema refuses an outcome where ask_user takes no run, and more than 6 decisions.
  assert.equal(schema.safeParse({ ...base, decisions: Array.from({ length: 7 }, (_, i) => ({ ...D1, key: `d${i}` })) }).success, false);
  assert.equal(asked.length, 0);
});

/** A stored question as the page gets it. */
function stored(details: QuestionDetails | null, extra: Partial<QuestionInfo> = {}): QuestionInfo {
  return {
    id: 2104, sessionId: 's', askedAt: 1, question: 'q', options: null, addressedTo: 'user', status: 'open', answer: null, answeredAt: null,
    answeredBy: null, aboutQuestion: null, forwardedFrom: null, aboutRequest: null, shots: null, deliveredAt: null, withdrawnReason: null, details, ...extra,
  };
}
const shot = (path: string, group = 'Request page'): QuestionShot => ({ path, group, lookFor: 'x', doneWhen: null, facts: [], opinions: [] });

test("a preset's answer is byte-for-byte what its page sends today", () => {
  const ok = (r: ReturnType<typeof requestAnswer>) => { assert.ok('answer' in r, JSON.stringify(r)); return r.answer; };
  // A structured question: "a — Label", with "Note: …" after it, or the typed words (QuestionPage).
  const structured = stored({ title: 'T', options: [{ key: 'a', text: '**Merge** as one PR' }, { key: 'b', text: 'Split' }] });
  assert.equal(requestModel(structured).preset, 'question');
  assert.equal(ok(requestAnswer(structured, { decisions: [{ key: '', pick: 'a' }] }, 'Simon')), 'a — Merge');
  assert.equal(ok(requestAnswer(structured, { decisions: [{ key: '', pick: 'b' }], note: ' after lunch ' }, 'Simon')), 'b — Split\n\nNote: after lunch');
  assert.equal(ok(requestAnswer(structured, { decisions: [{ key: '', other: ' neither ' }] }, 'Simon')), 'neither');
  // A plain question answers with the label as offered, "(recommended)" and all.
  const plain = stored(null, { question: 'Merge?', options: ['Yes (recommended)', 'No'] });
  assert.equal(ok(requestAnswer(plain, { decisions: [{ key: '', pick: '1' }] }, 'Simon')), 'Yes (recommended)');
  // A question about a permission request takes no note (issue #51).
  assert.equal(ok(requestAnswer({ ...plain, aboutRequest: 'req-1' }, { decisions: [{ key: '', pick: '2' }], note: 'x' }, 'Simon')), 'No');
  // A review: reviewAnswer's two forms (ReviewAnswer), its one box being the note.
  const review = stored({ title: 'R', review: { solving: 's', done: 'd' } });
  assert.equal(ok(requestAnswer(review, { signOff: { verdict: 'accept' } }, 'Simon')), (reviewAnswer('accept', '') as { answer: string }).answer);
  assert.equal(ok(requestAnswer(review, { signOff: { verdict: 'accept', note: 'Nice.' } }, 'Simon')), 'Accepted.\n\nNice.');
  assert.equal(ok(requestAnswer(review, { signOff: { verdict: 'changes', note: 'the colour' } }, 'Simon')), 'Changes needed: the colour');
  assert.deepEqual(requestAnswer(review, { signOff: { verdict: 'changes' } }, 'Simon'), { problem: 'Sign-off: Say what needs changing in the box first.' });
  // A screenshot question: shotAnswer, its options shown but not answered.
  const shots = [shot('a.png'), shot('b.png')];
  const shotQ = stored({ title: 'S', options: [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }] }, { shots });
  assert.deepEqual(requestModel(shotQ).decisions, []);
  const parts: AnswerParts = { shots: [{ verdict: 'pass' }, { verdict: 'fail', note: 'too\nwide' }], note: 'thanks' };
  assert.equal(ok(requestAnswer(shotQ, parts, 'Simon')), shotAnswer(shots, { 0: { verdict: 'pass', note: '' }, 1: { verdict: 'fail', note: 'too\nwide' } }, 'thanks'));
  assert.deepEqual(requestAnswer(shotQ, { shots: [] }, 'Simon'), { problem: 'Judge at least one shot first.' });
});

test('a request answers as one message, sign-off first, every session text on one line; every decision and the sign-off are needed (D3)', () => {
  const q = stored({ title: 'Request page:\nlayout and next steps', review: { solving: 's', done: 'd' }, decisions: [D1, D2] }, { shots: [shot('shots/1280.png'), shot('shots/390.png'), shot('shots/390-folded.png')] });
  assert.equal(isRequest(q), true);
  const m = requestModel(q);
  assert.equal(m.parts, 4);
  assert.equal(leftToAnswer(m, null), 3);
  assert.equal(leftToAnswer(m, { decisions: [{ key: 'layout', pick: 'a' }] }), 2);
  assert.match((requestAnswer(q, { signOff: { verdict: 'accept' }, decisions: [{ key: 'layout', pick: 'a' }] }, 'Simon') as { problem: string }).problem, /Answer decision "Ask about this" first/);
  assert.match((requestAnswer(q, { decisions: [{ key: 'layout', pick: 'a' }, { key: 'side-chat', pick: 'b' }] }, 'Simon') as { problem: string }).problem, /^Give the sign-off first/);
  const r = requestAnswer(q, {
    signOff: { verdict: 'changes', note: 'the phone view hides Send under the keyboard.' },
    decisions: [{ key: 'layout', pick: 'a' }, { key: 'side-chat', pick: 'b' }],
    shots: [{ verdict: 'pass' }, { verdict: 'fail', note: 'Send hidden under the keyboard' }, { verdict: 'pass' }],
    note: 'good direction; fix the phone view first.',
  }, 'Simon');
  assert.ok('answer' in r);
  assert.equal(r.answer, [
    'Answer to request #2104 "Request page: layout and next steps" (4 parts)',
    '',
    'Sign-off: Changes needed: the phone view hides Send under the keyboard.',
    'Decision layout — Which layout?: a — Stacked blocks',
    'Decision side-chat — Ask about this: b — Later',
    'Screenshot verdicts: Pass 2 · Fail 1',
    '- Request page · shots/1280.png: Pass',
    '- Request page · shots/390.png: Fail — Send hidden under the keyboard',
    '- Request page · shots/390-folded.png: Pass',
    '',
    "Simon's note: good direction; fix the phone view first.",
  ].join('\n'));
  // The parts as data: what a run reads (D6).
  assert.deepEqual(movingAnswer({ details: q.details, answerParts: r.parts }), { answer: 'Changes needed: the phone view hides Send under the keyboard.' });
  // Simon's own words keep their lines, indented inside their part; "Other" is always there.
  const other = requestAnswer(q, { signOff: { verdict: 'accept' }, decisions: [{ key: 'layout', other: 'not sure yet:\nask me Monday' }, { key: 'side-chat', pick: 'a' }] }, 'Simon');
  assert.ok('answer' in other);
  assert.match(other.answer, /\nDecision layout — Which layout\?: Other: not sure yet:\n  ask me Monday\n/);
  assert.match(other.answer, /Screenshot verdicts: no verdict 3/, 'shots may stay unjudged beside other parts');
});

test('the parts and the draft are blanked like everything stored; a draft goes when the request is answered or withdrawn', () => {
  const store = new Store(openDatabase(':memory:'));
  store.setBlanker({ text: (s) => s.replaceAll('hunter2', '••••'), deep: (d) => JSON.parse(JSON.stringify(d).replaceAll('hunter2', '••••')) });
  store.createSession({ id: 's', project: 'p', runner: 'local', title: 'S', parentId: null, permissionMode: 'default' });
  const details: QuestionDetails = { title: 'T', signOff: true, decisions: [{ ...D1, issue: 'the hunter2 key' }, D2] };
  const q = store.createQuestion({ sessionId: 's', question: 'q', options: null, addressedTo: 'user', details });
  assert.equal(store.getQuestion(q.id)!.details!.decisions![0]!.issue, 'the •••• key');
  assert.equal(typeof store.saveRequestDraft(q.id, { note: 'token hunter2' }), 'number');
  assert.deepEqual(store.requestDraft(q.id)!.data, { note: 'token ••••' });
  const r = requestAnswer(store.getQuestion(q.id)!, { signOff: { verdict: 'changes', note: 'rotate hunter2' }, decisions: [{ key: 'layout', pick: 'a' }, { key: 'side-chat', other: 'hunter2 again' }] }, 'Simon');
  assert.ok('answer' in r);
  store.answerQuestion(q.id, r.answer, 'user', null, false, r.parts);
  const a = store.getQuestion(q.id)!;
  assert.doesNotMatch(JSON.stringify(a), /hunter2/);
  assert.equal(a.answerParts!.signOff!.note, 'rotate ••••');
  assert.equal(store.requestDraft(q.id), null, 'answered: its draft is gone');
  assert.equal(store.saveRequestDraft(q.id, {}), false, 'and none is kept for it again');
  const w = store.createQuestion({ sessionId: 's', question: 'q', options: null, addressedTo: 'user', details });
  store.saveRequestDraft(w.id, {});
  store.withdrawQuestion(w.id, 'no longer needed');
  assert.equal(store.requestDraft(w.id), null);
});

test('the #350 line, waiting_for_you and notifications name a request and its parts; a preset reads as before', () => {
  const q = stored({ title: 'Request page', review: { solving: 's', done: 'd' }, decisions: [D1, D2] }, { shots: [shot('a.png')] });
  assert.deepEqual(requestKinds(q), ['review', '2 decisions', '1 screenshot']);
  assert.equal(questionLine(q, 'Simon', () => undefined).label, 'Request');
  const r = requestAnswer(q, { signOff: { verdict: 'changes', note: 'x' }, decisions: [{ key: 'layout', pick: 'a' }, { key: 'side-chat', pick: 'a' }], shots: [{ verdict: 'pass' }] }, 'Simon');
  assert.ok('answer' in r);
  const answered = { ...q, status: 'answered' as const, answer: r.answer, answerParts: r.parts, answeredBy: 'user', answeredAt: 5 };
  assert.equal(lineOutcome(questionLine(answered, 'Simon', () => undefined)), 'Changes needed by Simon · 4 parts');
  const noSign = stored({ title: 'Two', decisions: [D1, D2] });
  const r2 = requestAnswer(noSign, { decisions: [{ key: 'layout', pick: 'a' }, { key: 'side-chat', pick: 'b' }] }, 'Simon');
  assert.ok('answer' in r2);
  assert.equal(lineOutcome(questionLine({ ...noSign, status: 'answered', answer: r2.answer, answerParts: r2.parts, answeredBy: 'user', answeredAt: 5 }, 'Simon', () => undefined)), 'Answered 2 parts by Simon');
  // A review stays a review.
  const review = stored({ title: 'R', review: { solving: 's', done: 'd' } }, { status: 'answered', answer: 'Accepted.', answeredBy: 'user', answeredAt: 5 });
  assert.equal(questionLine(review, 'Simon', () => undefined).label, 'Review');
  assert.equal(lineOutcome(questionLine(review, 'Simon', () => undefined)), 'Accepted by Simon');
  // One notification per request, naming its parts.
  const items = waitingItems([q, stored({ title: 'Plain' }, { id: 7, question: 'Merge?' })], [], () => 'Manager: shop');
  assert.deepEqual(items.map((i) => [i.title, i.body]), [['Request from Manager: shop', 'Review · 2 decisions · 1 screenshot: Request page'], ['Question from Manager: shop', 'Merge?']]);
});

test('the page: a draft becomes the parts, its open parts in page order, Alt+↓ / Alt+↑ go to the next open one, a stored draft is read back safely', () => {
  const q = stored({ title: 'R', review: { solving: 's', done: 'd' }, decisions: [D1, D2] }, { shots: [shot('a.png'), shot('b.png')] });
  const m = requestModel(q);
  const d = emptyRequestDraft();
  assert.deepEqual(openParts(m, d), ['d:layout', 'd:side-chat', 'sign-off']);
  d.decisions.layout = { pick: 'a' };
  d.decisions['side-chat'] = { other: '  ' };
  d.signOff = { verdict: 'changes', note: '' };
  assert.deepEqual(openParts(m, d), ['d:side-chat', 'sign-off'], 'blank words and Changes needed without what are still open');
  const order = ['d:layout', 'd:side-chat', 'sign-off'];
  assert.equal(nextOpen(order, ['d:side-chat', 'sign-off'], null, 1), 'd:side-chat');
  assert.equal(nextOpen(order, ['d:side-chat', 'sign-off'], 'sign-off', 1), 'd:side-chat', 'wraps');
  assert.equal(nextOpen(order, ['d:side-chat', 'sign-off'], 'd:layout', -1), 'sign-off');
  assert.equal(nextOpen(order, [], null, 1), null);
  d.decisions['side-chat'] = { other: 'later' };
  d.signOff = { verdict: 'accept', note: '' };
  d.judged = { 1: { verdict: 'fail', note: 'off' } };
  d.note = 'thanks';
  const parts = draftParts(m, d);
  assert.deepEqual(parts, {
    decisions: [{ key: 'layout', pick: 'a' }, { key: 'side-chat', other: 'later' }], signOff: { verdict: 'accept' },
    shots: [{ verdict: null }, { verdict: 'fail', note: 'off' }], note: 'thanks',
  });
  assert.ok('answer' in requestAnswer(q, parts, 'Simon'));
  // What Ledung hands back is checked, not trusted: a wrong shape is left out.
  assert.deepEqual(readDraft({ decisions: { layout: { pick: 3, other: 'x' } }, signOff: { verdict: 'maybe', note: 1 }, judged: { 0: { verdict: 'pass' }, x: {} }, note: null }), {
    decisions: { layout: { other: 'x' } }, signOff: { note: '' }, judged: { 0: { verdict: 'pass', note: '' } }, note: '',
  });
  assert.equal(readDraft('nope'), null);
});

test("waiting_for_you names a request's kind and parts; a review stays a review", () => {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager: p', parentId: null, permissionMode: 'default', role: 'manager' });
  store.createQuestion({ sessionId: 'mgr', question: 'q', options: null, addressedTo: 'user', details: { title: 'Request page', tier: 'Process', review: { solving: 's', done: 'd' }, decisions: [D1, D2] }, shots: [shot('a.png'), shot('b.png'), shot('c.png')] });
  store.createQuestion({ sessionId: 'mgr', question: 'q', options: null, addressedTo: 'user', details: { title: 'Cart fix', tier: 'Process', review: { solving: 's', done: 'd' } } });
  const out = waitingForYou({ store, managerId: 'mgr', userName: 'Simon', tiers: () => ['Process'], request: () => '' });
  assert.match(out, /#1 "Request page": request \(review, 2 decisions, 3 screenshots\); asked by you/);
  assert.match(out, /#2 "Cart fix": review; asked by you/);
});

test("a draft is never saved empty, and one picked here before Ledung's arrived is laid over it, part by part (acceptance round 1)", () => {
  assert.ok(isEmptyDraft(emptyRequestDraft()));
  assert.ok(isEmptyDraft({ ...emptyRequestDraft(), note: '  ', decisions: { a: {} }, judged: { 0: { verdict: null, note: ' ' } } }));
  assert.ok(!isEmptyDraft({ ...emptyRequestDraft(), decisions: { a: { pick: 'b' } } }));
  assert.ok(!isEmptyDraft({ ...emptyRequestDraft(), judged: { 1: { verdict: 'fail', note: '' } } }));
  assert.ok(!isEmptyDraft({ ...emptyRequestDraft(), signOff: { note: 'x' } }));
  // Kept on the PC: decision 1 and three verdicts. On the phone, before that arrived: decision 2.
  const kept = {
    decisions: { rounding: { pick: 'a' } }, signOff: { verdict: 'changes' as const, note: 'wraps' },
    judged: { 0: { verdict: 'pass' as const, note: '' }, 1: { verdict: 'fail' as const, note: 'wraps' }, 2: { verdict: 'unsure' as const, note: '' } }, note: 'PC note',
  };
  const here = { ...emptyRequestDraft(), decisions: { release: { pick: 'b' } }, judged: { 2: { verdict: 'pass' as const, note: '' } } };
  assert.deepEqual(rebaseDraft(emptyRequestDraft(), here, kept), {
    decisions: { rounding: { pick: 'a' }, release: { pick: 'b' } },
    signOff: { verdict: 'changes', note: 'wraps' },
    judged: { 0: { verdict: 'pass', note: '' }, 1: { verdict: 'fail', note: 'wraps' }, 2: { verdict: 'pass', note: '' } },
    note: 'PC note',
  });
  assert.deepEqual(rebaseDraft(emptyRequestDraft(), emptyRequestDraft(), emptyRequestDraft()), emptyRequestDraft());
});

test('a page left open lays its own changes over the newer draft, part by part, and never puts its old copy back (acceptance round 2)', () => {
  // The PC read this; the phone then picked "Today" for release and judged shot 0. On the PC, still open, the note was typed.
  const read = { ...emptyRequestDraft(), decisions: { rounding: { pick: 'a' }, release: { pick: 'b' } }, judged: { 0: { verdict: 'fail' as const, note: '' } } };
  const phone = { ...read, decisions: { rounding: { pick: 'a' }, release: { pick: 'a' } }, judged: { 0: { verdict: 'pass' as const, note: '' } } };
  const pc = { ...read, note: 'ship it' };
  const merged = rebaseDraft(read, pc, phone);
  assert.deepEqual(merged.decisions, { rounding: { pick: 'a' }, release: { pick: 'a' } }, "the phone's Today stays");
  assert.deepEqual(merged.judged, { 0: { verdict: 'pass', note: '' } });
  assert.equal(merged.note, 'ship it', "and the PC's note");
  // A part changed on both: this page's latest wins, as the person is looking at it.
  assert.equal(rebaseDraft(read, { ...read, decisions: { ...read.decisions, release: { other: 'Friday' } } }, phone).decisions.release!.other, 'Friday');
  // "Other" chosen with its box still empty is a change of its own; a part cleared here stays cleared.
  assert.deepEqual(rebaseDraft(read, { ...read, decisions: { ...read.decisions, rounding: { other: '' } } }, read).decisions.rounding, { other: '' });
  assert.deepEqual(rebaseDraft(read, { ...read, judged: {} }, phone).judged, {});
  // The sign-off's verdict and note are parts of their own.
  const signed = rebaseDraft({ ...read, signOff: { note: 'a' } }, { ...read, signOff: { verdict: 'accept', note: 'a' } }, { ...read, signOff: { note: 'b' } });
  assert.deepEqual(signed.signOff, { verdict: 'accept', note: 'b' });
  // Nothing changed here: the newer draft as it is.
  assert.ok(sameDraft(rebaseDraft(read, read, phone), phone));
  assert.ok(sameDraft({ ...phone, judged: { 0: phone.judged[0], 3: { verdict: null, note: '' } } }, phone), 'an empty verdict is none');
  assert.ok(!sameDraft(pc, read));
});

test('a draft is kept only over the version it was made from; each version is later than the one before', () => {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 's', project: 'p', runner: 'local', title: 'S', parentId: null, permissionMode: 'default' });
  const q = store.createQuestion({ sessionId: 's', question: 'q', options: null, addressedTo: 'user', details: { title: 'T', decisions: [D1, D2] } });
  const first = store.saveRequestDraft(q.id, { note: 'pc' }, null, 1000);
  assert.equal(first, 1000);
  assert.equal(store.saveRequestDraft(q.id, { note: 'phone' }, null, 1000), 'stale', 'none read, but one is kept');
  const second = store.saveRequestDraft(q.id, { note: 'phone' }, 1000, 1000);
  assert.equal(second, 1001, 'later, even in the same millisecond');
  assert.equal(store.saveRequestDraft(q.id, { note: 'pc again' }, 1000), 'stale');
  assert.deepEqual(store.requestDraft(q.id), { data: { note: 'phone' }, at: 1001 });
  assert.equal(typeof store.saveRequestDraft(q.id, { note: 'old page' }), 'number', 'a page from an earlier release sends no version');
});
