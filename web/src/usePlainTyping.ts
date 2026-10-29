// The Settings autocorrect switch (issue #147) as a shared value: a change in Settings, or in
// another tab of this browser, re-renders every text field with it.
import { useSyncExternalStore } from 'react';
import { AUTOCORRECT_KEY, readAutocorrect, saveAutocorrect, typingProps } from './plainTyping.ts';

const listeners = new Set<() => void>();
let current = readAutocorrect(localStorage);

const changed = (on: boolean) => {
  current = on;
  for (const l of listeners) l();
};

window.addEventListener('storage', (e) => {
  if (e.key === AUTOCORRECT_KEY || e.key === null) changed(readAutocorrect(localStorage));
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const get = () => current;

/** Whether autocorrect is on in this browser, for the Settings switch. */
export function useAutocorrect(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, get);
  return [on, (next) => { saveAutocorrect(localStorage, next); changed(next); }];
}

/** The props every free-text field spreads: `<textarea {...typing}`. */
export function usePlainTyping(): { autoCorrect?: 'off' } {
  return typingProps(useSyncExternalStore(subscribe, get));
}
