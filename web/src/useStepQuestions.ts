// Settings → Questions at a workflow step (#291) and its first-run picker (#293) as one shared value, so a pick in
// the picker shows in Settings at once. Read when the page loads and again each time Settings shows it (as #291 did, so
// a change from another device shows there); Settings' "Show the samples" opens the picker again.
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

/** Unread, Settings shows Ledung's card and the picker stays shut, as #291's section did. */
const UNREAD: StepQuestionsView = { choice: 'card', picker: false, ask: false };

/** `fresh`: read it again (Settings opening) rather than reuse the page's first read. */
function load(fresh = false): Promise<void> {
  if (fresh || !loading) loading = api.stepQuestions().then((v) => set(v), () => set(view ?? UNREAD));
  return loading;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** `fresh` for Settings: the setting is read again each time it is shown (self-check of #293, finding 1). */
export function useStepQuestions(fresh = false): {
  view: StepQuestionsView | null;
  shown: boolean;
  choose: (choice: StepQuestions) => Promise<void>;
  skip: () => Promise<void>;
  show: (open: boolean) => void;
} {
  useEffect(() => void load(fresh), [fresh]);
  const current = useSyncExternalStore(subscribe, read);
  return {
    ...current,
    choose: async (choice) => set(await api.setStepQuestions(choice), false),
    skip: async () => set(await api.skipStepQuestions(), false),
    show: (open) => set(view, open),
  };
}
