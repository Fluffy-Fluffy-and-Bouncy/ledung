// Settings → Questions at a workflow step (#291, Martin 2026-11-12, Ledung questions #873 and #875): who writes the
// question when a run reaches a step where you decide. Ledung's card is the default, as before; the manager's full
// write-up is chosen here, for every project and workflow on this Ledung. A first-run picker with samples is its own card.
import { useEffect, useState } from 'react';
import type { StepQuestions } from '../../../src/shared/flow-run.ts';
import { api } from '../api.ts';

const LABEL: Record<StepQuestions, string> = {
  card: "Ledung's card",
  'write-up': "The manager's full write-up",
};

const ABOUT: Record<StepQuestions, string> = {
  card: 'Ledung asks at once, from the run: its title, what the step before handed on, and where each answer takes the run.',
  'write-up':
    'The manager asks, with the backstory, what was done, the evidence, options with their cost, its recommendation and the reviewers\' views. ' +
    'If it has not asked within 10 minutes, Ledung asks its own card, headed "The manager gave no write-up for this step".',
};

export function StepQuestionsSettings({ run }: { run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [choice, setChoice] = useState<StepQuestions | null>(null);
  useEffect(() => { void api.stepQuestions().then((r) => setChoice(r.choice), () => setChoice('card')); }, []);
  return (
    <section>
      <h3>Questions at a workflow step</h3>
      <p className="muted">
        When a workflow run reaches a step where you decide, such as a merge or a sign-off, who writes the question. Your answer moves the run either way. For every project on this Ledung.
      </p>
      <div className="restart-confirm" role="radiogroup" aria-label="Questions at a workflow step">
        {(['card', 'write-up'] as const).map((c) => (
          <label key={c}>
            <input type="radio" name="step-questions" checked={choice === c} disabled={choice === null}
              onChange={() => void run(async () => setChoice((await api.setStepQuestions(c)).choice))} /> {LABEL[c]}{c === 'card' ? ' (default)' : ''}
          </label>
        ))}
      </div>
      {choice && <p className="muted">{ABOUT[choice]}</p>}
    </section>
  );
}
