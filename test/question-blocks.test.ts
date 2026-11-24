// One stored shape for every question (issue #509): ask_user's fields are stored as blocks, every question stored
// before is rewritten once by migration 64, and each one opens, answers and moves a run exactly as before. Answers,
// question texts and the chat's option labels are never touched; Ledung's own permission-carrying questions keep their
// shape; secrets stay blanked; the update is one transaction, so a start stopped half-way changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync as Db, type DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { askedQuestion } from '../src/sessions/tools.ts';
import { answerWord } from '../src/sessions/flow-runs.ts';
import { inBlocks, toBlocks } from '../src/shared/blocks.ts';
import { deskQuestion, keepsItsShape, legacyDesk, ownDecision, type QuestionDetails } from '../src/shared/questions.ts';
import { isRequest, movingAnswer, requestAnswer, requestModel } from '../src/shared/requests.ts';
import { questionLine } from '../src/shared/waiting-line.ts';
import type { FlowBlock } from '../src/shared/flow.ts';
import type { QuestionInfo } from '../src/shared/protocol.ts';
import { TODAY_CALLS } from './fixtures/ask-user-today.calls.ts';

/** The fields ask_user's calls before #509 stored, and Ledung's own questions: old rows, as a database from before has them. */
type Row = { question: string; options: string[] | null; details: QuestionDetails | null; about_request?: string; shots?: unknown[]; answer?: string };
const OLD_FIELDS = ['options', 'recommended', 'why', 'reviewer'] as const;
const RUN = { run: 'run-1', block: 'decide', runTitle: 'Fix the cart', blockTitle: 'Person decides', flow: 'main' };
const SHOT = { path: 'a.png', group: 'G', lookFor: 'x', doneWhen: null, facts: [], opinions: [] };

const ROWS: Row[] = [
  // ask_user's calls as main stored them (plain, structured, with screenshots, reviews), answered and not.
  ...TODAY_CALLS.filter((c) => !c.order_command).map((c, i): Row => {
    const a = askedQuestion(c);
    return { ...a, ...(c.screenshots ? { shots: [SHOT] } : {}), ...(i % 2 ? { answer: a.options?.[0] ?? 'typed words' } : {}) };
  }),
  // A question from before #96 and #59: no tier, no fields at all.
  { question: 'Release now? It is Friday.', options: ['Yes', 'No (recommended)'], details: null, answer: 'No (recommended)' },
  { question: 'Anything else?', options: null, details: null },
  // A coordinator's write-up at a run's step, and Ledung's own fallback card there.
  {
    question: 'Go on or fix?', options: ['a — Go on', 'b — Fix again'],
    details: {
      title: 'Go on or fix?', issue: 'Three rounds.', tier: 'Process', run: { ...RUN, writeUp: true },
      options: [{ key: 'a', text: '**Go on**', outcome: 'go on' }, { key: 'b', text: '**Fix again**', outcome: 'Fix again' }],
      opinions: [{ who: 'Manager', pick: 'a' }],
    },
  },
  { question: 'Ledung wrote this card', options: ['Go on', 'Fix again'], details: { title: 'No write-up yet: Person decides', issue: 'Ledung wrote this card.', tier: 'Process', run: RUN } },
  // A request asked since #502 with the asker's own question text beside its issue.
  {
    question: 'My own words', options: null,
    details: { title: 'Two things', issue: 'Context', tier: 'Process', decisions: [{ key: 'd1', title: 'One', options: [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }] }], signOff: true },
  },
  // Ledung's own permission-carrying questions: never rewritten.
  { question: 'Allow `npm publish`?', options: ['Allow once', 'Deny'], details: { tier: 'Process', refusal: { toolName: 'Bash', input: { command: 'npm publish' }, reason: 'r', toolUseId: 't' } } },
  { question: 'Allow the request?', options: ['Allow', 'Deny (recommended)'], details: { tier: 'Process' }, about_request: 'req-1' },
  ...TODAY_CALLS.filter((c) => c.order_command).map((c): Row => askedQuestion(c)),
  { question: 'Keep this order?', options: ['Keep it', 'End it'], details: { tier: 'Process', order: { orderId: 1 } as never } },
  { question: 'Workflow change', options: null, details: { title: 'Change', tier: 'Process', flowProposal: 3, review: { solving: 's', done: 'd' } } },
];

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-blocks-'));
}

/** A database as a Ledung from before #509 left it: every row written as it stored them, the version one short. */
function oldDatabase(file: string): void {
  const db = openDatabase(file);
  db.exec("INSERT INTO sessions (id, project, runner, title, status, created_at) VALUES ('s', 'p', 'local', 't', 'idle', 1)");
  const insert = db.prepare('INSERT INTO questions (session_id, asked_at, question, options, addressed_to, status, about_request, details, shots, answer, answered_at, answered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ROWS.forEach((r, i) => insert.run('s', i + 1, r.question, r.options ? JSON.stringify(r.options) : null, 'user', r.answer ? 'answered' : 'open', r.about_request ?? null,
    r.details ? JSON.stringify(r.details) : null, r.shots ? JSON.stringify(r.shots) : null, r.answer ?? null, r.answer ? 5 : null, r.answer ? 'user' : null));
  db.exec('PRAGMA user_version = 63');
  db.close();
}

const rawRows = (db: DatabaseSync) => db.prepare('SELECT id, question, options, details, about_request, answer, shots FROM questions ORDER BY id').all() as Record<string, string | null>[];

/** What the old row was, read as the page read it before #509. */
const before = (r: Row) => ({ question: r.question, options: r.options, details: r.details, aboutRequest: r.about_request ?? null });

test('the update rewrites every old question in blocks once; answers, texts and labels stay byte-for-byte, permission questions untouched', () => {
  const dir = tempDir();
  const file = path.join(dir, 'ledung.db');
  oldDatabase(file);
  const raw = new Db(file);
  const was = rawRows(raw);
  raw.close();
  const db = openDatabase(file);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 64);
  const now = rawRows(db);
  const store = new Store(db);
  assert.equal(now.length, ROWS.length, 'nothing deleted');
  ROWS.forEach((r, i) => {
    const label = JSON.stringify(r).slice(0, 120);
    const [w, n] = [was[i]!, now[i]!];
    // Never touched: the answer, the text, the chat's labels, the screenshots.
    for (const k of ['question', 'options', 'answer', 'shots', 'about_request'] as const) assert.equal(n[k], w[k], `${k}: ${label}`);
    const old = before(r);
    const q = store.getQuestion(Number(n.id))!;
    if (keepsItsShape(old)) {
      assert.equal(n.details, w.details, `kept as asked: ${label}`);
      return;
    }
    // Every other question in blocks: none of ask_user's fields left; a non-review has its own decision or keyed ones.
    for (const k of OLD_FIELDS) assert.equal((q.details as Record<string, unknown>)[k], undefined, `${k} gone: ${label}`);
    if (!q.details!.review && !q.details!.signOff) assert.equal(q.details!.opinions, undefined, `opinions inside the decision: ${label}`);
    assert.ok(q.details!.review || q.details!.decisions?.length, `blocks: ${label}`);
    // It opens as it did: the same desk, the same page (preset), the same Waiting for you title.
    assert.deepEqual(deskQuestion(q), legacyDesk(old), `the desk: ${label}`);
    assert.equal(isRequest(q), !!r.details?.decisions?.length, `request or preset: ${label}`);
  });
  // Run again (a version set back): nothing changes a second time.
  db.exec('PRAGMA user_version = 63');
  db.close();
  const again = openDatabase(file);
  assert.deepEqual(rawRows(again), now);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a start stopped half-way through the update leaves every row as it was, and the next start converts them all', () => {
  const dir = tempDir();
  const file = path.join(dir, 'ledung.db');
  oldDatabase(file);
  // Opened by hand so the update doesn't run: the trigger stops it at the fourth row, after three are rewritten.
  const raw = new Db(file);
  const was = rawRows(raw);
  raw.exec("CREATE TRIGGER stop_half_way BEFORE UPDATE OF details ON questions WHEN NEW.id = 4 BEGIN SELECT RAISE(ABORT, 'stopped'); END;");
  raw.close();
  assert.throws(() => openDatabase(file), /stopped/);
  const check = new Db(file);
  assert.deepEqual(rawRows(check), was, 'the first three rewritten rows were rolled back');
  assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 63);
  check.exec('DROP TRIGGER stop_half_way');
  check.close();
  const db = openDatabase(file);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 64);
  assert.ok(rawRows(db).some((r, i) => r.details !== was[i]!.details));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("converted questions answer with exactly the old words: each option, a note, typed words; a run's step moves as before", () => {
  const block: FlowBlock = { id: 'decide', kind: 'person', title: 'Person decides', ask: 'question', outcomes: [{ word: 'Go on', to: 'x' }, { word: 'Fix again', to: 'y' }] };
  for (const r of ROWS) {
    const old = before(r);
    if (keepsItsShape(old) || r.details?.review || r.details?.decisions) continue;
    const q = { id: 7, shots: r.shots ? [SHOT] : null, ...inBlocks(old) } as QuestionInfo;
    const m = requestModel(q);
    const label = r.question.slice(0, 60);
    if (r.shots) {
      assert.equal(m.preset, 'shots', label);
      continue;
    }
    assert.equal(m.preset, 'question', label);
    // What the old page sent for each option is what it sends now.
    legacyDesk(old).options.forEach((o) => {
      const a = requestAnswer(q, { decisions: [{ key: '', pick: o.key }] }, 'Simon');
      assert.deepEqual(a, { answer: o.answer, parts: { decisions: [{ key: '', pick: o.key }] } }, label);
      assert.equal((requestAnswer(q, { decisions: [{ key: '', pick: o.key }], note: 'n' }, 'Simon') as { answer: string }).answer, `${o.answer}\n\nNote: n`);
    });
    assert.equal((requestAnswer(q, { decisions: [{ key: '', other: ' my words ' }] }, 'Simon') as { answer: string }).answer, 'my words');
    // At a run's step the answer moves it by its text, as before: the write-up by its option's outcome, the card by its word.
    if (r.details?.run) {
      assert.equal(movingAnswer({ ...q, answerParts: { decisions: [{ key: '', pick: 'a' }] } }), null, 'read from the text, as before');
      const opts = r.details.run.writeUp ? ownDecision(q.details)!.options : undefined;
      const go = legacyDesk(old).options[0]!.answer;
      assert.equal(answerWord(block, `${go}\n\nNote: file it`, opts), r.details.run.writeUp ? 'Go on' : null, label);
      assert.equal(answerWord(block, go, opts), 'Go on', label);
      assert.equal(m.decisions[0]!.moves, !!r.details.run.writeUp);
    }
  }
});

test('ask_user stores every call in blocks, also given the old fields; the text and buttons the asker and manager read are unchanged', () => {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 's', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default' });
  for (const c of TODAY_CALLS) {
    const a = askedQuestion(c);
    const q = store.createQuestion({ sessionId: 's', question: a.question, options: a.options, addressedTo: 'user', details: a.details });
    assert.equal(q.question, a.question);
    assert.deepEqual(q.options, a.options);
    const old = { question: a.question, options: a.options, details: a.details };
    if (keepsItsShape(old)) {
      assert.deepEqual(q.details, a.details, 'an order command keeps its shape');
      continue;
    }
    assert.deepEqual(q.details, toBlocks(old) ?? a.details);
    for (const k of OLD_FIELDS) assert.equal((q.details as Record<string, unknown>)[k], undefined, `${k}: ${JSON.stringify(c)}`);
    assert.deepEqual(deskQuestion(q), legacyDesk(old));
  }
});

test('secrets stay blanked: the copies a conversion makes come from blanked text', () => {
  const store = new Store(openDatabase(':memory:'));
  store.setBlanker({ text: (s) => s.replaceAll('hunter2', '••••'), deep: (d) => JSON.parse(JSON.stringify(d).replaceAll('hunter2', '••••')) });
  store.createSession({ id: 's', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default' });
  const plain = store.createQuestion({ sessionId: 's', question: 'Use the password hunter2 now?', options: ['Yes hunter2', 'No'], addressedTo: 'user', details: { tier: 'Process' } });
  const a = askedQuestion({ title: 'Key hunter2', issue: 'The key is hunter2.', tier: 'Process', options: [{ key: 'a', text: 'Use hunter2' }, { key: 'b', text: 'No' }], recommended: 'a', why: 'hunter2 works' });
  const structured = store.createQuestion({ sessionId: 's', question: a.question, options: a.options, addressedTo: 'user', details: a.details });
  for (const q of [plain, structured]) {
    const row = store.database.prepare('SELECT question, options, details FROM questions WHERE id = ?').get(q.id) as Record<string, string>;
    assert.doesNotMatch(JSON.stringify(row), /hunter2/);
    assert.match(row.details!, /••••/);
  }
  // A database from before: its rows were blanked when stored, and the update only rearranges them.
  const dir = tempDir();
  const file = path.join(dir, 'ledung.db');
  const db = openDatabase(file);
  db.exec("INSERT INTO sessions (id, project, runner, title, status, created_at) VALUES ('s', 'p', 'local', 't', 'idle', 1)");
  db.prepare("INSERT INTO questions (session_id, asked_at, question, options, addressed_to, status, details) VALUES ('s', 1, ?, ?, 'user', 'open', ?)")
    .run('Use ••••?', JSON.stringify(['Yes ••••', 'No']), JSON.stringify({ tier: 'Process', title: 'Key ••••' }));
  db.exec('PRAGMA user_version = 63');
  db.close();
  const after = openDatabase(file);
  const details = (after.prepare('SELECT details FROM questions').get() as { details: string }).details;
  assert.match(details, /"decisions"/);
  assert.doesNotMatch(details, /hunter2/);
  after.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the #350 line of a converted question reads as before: its title, and an answered pick by its label', () => {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 's', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default' });
  const a = askedQuestion({ title: 'Merge?', issue: 'PR #12.', tier: 'Process', options: [{ key: 'a', text: '**Merge** now' }, { key: 'b', text: '**Wait**' }] });
  const q = store.createQuestion({ sessionId: 's', question: a.question, options: a.options, addressedTo: 'user', details: a.details });
  store.answerQuestion(q.id, 'a — Merge\n\nNote: thanks', 'user');
  const line = questionLine(store.getQuestion(q.id)!, 'Simon', () => 't');
  assert.equal(line.title, 'Merge?');
  assert.equal(line.label, 'Question');
  const plain = store.createQuestion({ sessionId: 's', question: 'Ship it?', options: ['Yes (recommended)', 'No'], addressedTo: 'user', details: { tier: 'Process' } });
  store.answerQuestion(plain.id, 'Yes (recommended)', 'user');
  assert.equal(questionLine(store.getQuestion(plain.id)!, 'Simon', () => 't').label, 'Question');
});
