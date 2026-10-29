import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QuestionShot } from '../src/shared/protocol.ts';
import type { ShotJudgement } from '../src/shared/shots.ts';
import { carriedFrom, emptyDraft, fillGaps, type ShotDraft } from '../web/src/shotDrafts.ts';

const shot = (path: string): QuestionShot => ({ path, group: '#133 Message box', lookFor: 'The box', doneWhen: null, facts: [], opinions: [] });
const noColour = ['4-no-colour-light.png', '4-no-colour-light-typing.png', '4-no-colour-dark.png', '4-no-colour-dark-typing.png'];
const queue = ['q-queue-desktop-light.png', 'q-queue-desktop-dark.png'];
const pass: ShotJudgement = { verdict: 'pass', note: '' };
const draft = (paths: string[], judged: Record<number, ShotJudgement>, project = 'ledung'): ShotDraft =>
  ({ ...emptyDraft(paths.map(shot), project), judged });

test('verdicts given on a question withdrawn while being judged follow its files to the question asked again (issue #138, question #139 → #141)', () => {
  // #139 had the no-colour shots after another one and was withdrawn; #141 asked again with them first.
  const drafts = new Map([[139, draft(['1-manager-blue-light.png', ...noColour, ...queue], { 0: pass, 1: pass, 2: { verdict: 'fail', note: 'edge too faint' }, 3: pass, 4: pass })]]);
  const opened = fillGaps(141, emptyDraft([...noColour, ...queue].map(shot), 'ledung'), drafts, (id) => id === 139);
  assert.deepEqual(opened.judged, { 0: pass, 1: { verdict: 'fail', note: 'edge too faint' }, 2: pass, 3: pass });
  assert.deepEqual(opened.carried, { 0: 139, 1: 139, 2: 139, 3: 139 });
  assert.deepEqual(carriedFrom(opened), [139]);
});

test('a question judged before the old one was withdrawn takes its verdicts into its gaps only, never over its own (#141 review, finding 2)', () => {
  // #3 was asked and partly judged while #2 was still open; then #2 was withdrawn.
  const two = draft(noColour, { 0: pass, 1: pass, 2: pass, 3: pass });
  const three = draft(noColour, { 0: { verdict: 'fail', note: 'mine' } });
  const drafts = new Map([[2, two], [3, three]]);
  assert.equal(fillGaps(3, three, drafts, () => false), three, 'nothing withdrawn yet: unchanged');
  const after = fillGaps(3, three, drafts, (id) => id === 2);
  assert.deepEqual(after.judged, { 0: { verdict: 'fail', note: 'mine' }, 1: pass, 2: pass, 3: pass });
  assert.deepEqual(after.carried, { 1: 2, 2: 2, 3: 2 });
});

test('a shot judged or un-marked here, or filled before, is never filled again', () => {
  const old = draft(noColour, { 0: pass, 1: pass, 2: pass });
  const mine: ShotDraft = { ...draft(noColour, { 0: { verdict: null, note: '' } }), touched: { 0: true }, carried: { 1: 7 } };
  const after = fillGaps(9, mine, new Map([[8, old]]), () => true);
  assert.deepEqual(after.judged, { 0: { verdict: null, note: '' }, 2: pass });
  assert.deepEqual(after.carried, { 1: 7, 2: 8 });
});

test('verdicts carry only within the same project, and the later withdrawn question wins (#141 review, finding 3)', () => {
  const drafts = new Map([
    [5, draft(noColour, { 0: { verdict: 'fail', note: '' } })],
    [6, draft(noColour, { 0: pass })],
    [7, draft(noColour, { 1: pass }, 'other')],
  ]);
  const after = fillGaps(8, emptyDraft(noColour.map(shot), 'ledung'), drafts, () => true);
  assert.deepEqual(after.judged, { 0: pass });
  assert.deepEqual(after.carried, { 0: 6 });
});
