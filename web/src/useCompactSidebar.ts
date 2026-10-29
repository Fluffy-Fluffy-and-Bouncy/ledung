// The Settings Compact sidebar slider (issue #153) as a shared value: dragging it, or a change in
// another tab of this browser, re-renders the sidebar at once.
import { useSyncExternalStore } from 'react';
import { COMPACT_KEY, readCompact, saveCompact, type CompactStep } from './compactSidebar.ts';

const listeners = new Set<() => void>();
let current = readCompact(localStorage);

const changed = (step: CompactStep) => {
  current = step;
  for (const l of listeners) l();
};

window.addEventListener('storage', (e) => {
  if (e.key === COMPACT_KEY || e.key === null) changed(readCompact(localStorage));
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const get = () => current;

/** The sidebar's compact step in this browser, and the Settings slider's setter. */
export function useCompactSidebar(): [CompactStep, (step: CompactStep) => void] {
  const step = useSyncExternalStore(subscribe, get);
  return [step, (next) => { saveCompact(localStorage, next); changed(next); }];
}
