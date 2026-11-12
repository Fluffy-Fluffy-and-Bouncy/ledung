// Settings → Questions at a workflow step (#291, Martin 2026-11-12, Ledung questions #873 and #875): who writes the
// question when a run reaches a step where you decide. Ledung's card is the default, as before; the manager's full
// write-up is chosen here, for every project and workflow on this Ledung. The first-run picker with samples (#293)
// shares this value, and with its test feature on, Show the samples opens it from here.
import type { StepQuestions } from '../../../src/shared/flow-run.ts';
import { ABOUT, LABEL } from '../stepQuestions.ts';
import { useStepQuestions } from '../useStepQuestions.ts';

export function StepQuestionsSettings({ run }: { run: (action: () => Promise<unknown>) => Promise<void> }) {
  const { view, choose, show } = useStepQuestions(true);
  const choice: StepQuestions | null = view?.choice ?? null;
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
              onChange={() => void run(() => choose(c))} /> {LABEL[c]}{c === 'card' ? ' (default)' : ''}
          </label>
        ))}
        {view?.picker && <button className="small" onClick={() => show(true)}>Show the samples</button>}
      </div>
      {choice && <p className="muted">{ABOUT[choice]}</p>}
    </section>
  );
}
