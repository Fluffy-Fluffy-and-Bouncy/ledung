// Settings → Questions at a workflow step (#291) and its first-run picker (#293, Martin 2026-11-12, Ledung questions
// #873, #875 and #881: mockup A, "feature-flag it"): the words both use and when the picker asks. Pure, kept apart
// from the components so they can be tested; the picker is behind testFeatures "step-questions-picker".
import type { StepQuestions, StepQuestionsView } from '../../src/shared/flow-run.ts';

export const LABEL: Record<StepQuestions, string> = {
  card: "Ledung's card",
  'write-up': "The manager's full write-up",
};

/** What each choice does, as Settings says it (#291). */
export const ABOUT: Record<StepQuestions, string> = {
  card: 'Ledung asks at once, from the run: its title, what the step before handed on, and where each answer takes the run.',
  'write-up':
    'The manager asks, with the backstory, what was done, the evidence, options with their cost, its recommendation and the reviewers\' views. ' +
    'If it has not asked within 10 minutes, Ledung asks its own card, headed "The manager gave no write-up for this step".',
};

/** The one line under each sample in the picker. */
export const SHORT: Record<StepQuestions, string> = {
  card: 'Short, asked at once, from the run alone.',
  'write-up': 'Backstory, evidence, options with cost and opinions; the manager writes it, so it can take a few minutes.',
};

/**
 * The picker asks by itself on this computer's own page (a framed page is another computer's, as for the shortcuts
 * question, #415), behind its test feature, while this Ledung has neither a saved choice nor a Skip.
 */
export function asksPicker(view: StepQuestionsView | null, framed: boolean): boolean {
  return !!view && !framed && view.picker && view.ask;
}
