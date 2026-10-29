// The Settings status dot switch (issue #151) as a shared value: a change in Settings, or in another
// tab of this browser, re-renders the sidebar with it.
import { useSyncExternalStore } from 'react';
import { STATUS_DOT_KEY, readStatusDot, saveStatusDot } from './statusDot.ts';

const listeners = new Set<() => void>();
let current = readStatusDot(localStorage);

const changed = (on: boolean) => {
  current = on;
  for (const l of listeners) l();
};

window.addEventListener('storage', (e) => {
  if (e.key === STATUS_DOT_KEY || e.key === null) changed(readStatusDot(localStorage));
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const get = () => current;

/** Whether the sidebar shows the status dot in this browser, and the Settings switch's setter. */
export function useStatusDot(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, get);
  return [on, (next) => { saveStatusDot(localStorage, next); changed(next); }];
}
