// Settings → Questions at a workflow step (#291) and its first-run picker (#293) as one shared value, so a pick in
// the picker shows in Settings at once. Read once when the page loads; Settings' "Show the samples" opens it again.
import { useEffect, useSyncExternalStore } from 'react';
import type { StepQuestions, StepQuestionsView } from '../../src/shared/flow-run.ts';
import { api } from './api.ts';

let view: StepQuestionsView | null = null;
/** Opened again from Settings (#293: so whoever tries the feature can see the samples once a choice is saved). */
let shown = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const set = (next: StepQuestionsView | null, open = shown) => {
  view = next;
  shown = open;
  for (const l of listeners) l();
};
// useSyncExternalStore needs the same object back while nothing changed.
let last: { view: StepQuestionsView | null; shown: boolean } = { view, shown };
const read = () => (last.view === view && last.shown === shown ? last : (last = { view, shown }));

function load(): Promise<void> {
  loading ??= api.stepQuestions().then((v) => set(v), () => set(null));
  return loading;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useStepQuestions(): {
  view: StepQuestionsView | null;
  shown: boolean;
  choose: (choice: StepQuestions) => Promise<void>;
  skip: () => Promise<void>;
  show: (open: boolean) => void;
} {
  useEffect(() => void load(), []);
  const current = useSyncExternalStore(subscribe, read);
  return {
    ...current,
    choose: async (choice) => set(await api.setStepQuestions(choice), false),
    skip: async () => set(await api.skipStepQuestions(), false),
    show: (open) => set(view, open),
  };
}
