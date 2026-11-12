// The first-run picker for how questions at a workflow step are written (#293; Martin 2026-11-12, Ledung question #881:
// mockup A, "feature-flag it"): asked by itself only behind its test feature, on this computer's own page, while no
// choice is saved and it was not skipped. The server's half (what `ask` is) is in test/server-security.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StepQuestionsView } from '../src/shared/flow-run.ts';
import { asksPicker } from '../web/src/stepQuestions.ts';

const fresh: StepQuestionsView = { choice: 'card', picker: true, ask: true };

test('asked on a fresh Ledung with the test feature on, on this computer\'s own page', () => {
  assert.equal(asksPicker(fresh, false), true);
  assert.equal(asksPicker(fresh, true), false, "a framed page is another computer's");
  assert.equal(asksPicker(null, false), false, 'the setting could not be read');
});

test('not asked with the test feature off, or once a choice is saved or it was skipped', () => {
  assert.equal(asksPicker({ ...fresh, picker: false, ask: false }, false), false);
  // The server says ask false once answered or skipped; the picker follows it whatever the choice is.
  assert.equal(asksPicker({ ...fresh, ask: false }, false), false);
  assert.equal(asksPicker({ ...fresh, choice: 'write-up', ask: false }, false), false);
});
