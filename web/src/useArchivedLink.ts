// The Settings switch for the sidebar's "Archived (N)" entry (issue #157) as a shared value: a change
// in Settings, or in another tab of this browser, re-renders the sidebar with it.
import { useSyncExternalStore } from 'react';
import { ARCHIVED_LINK_KEY, readArchivedLink, saveArchivedLink } from './archivedLink.ts';

const listeners = new Set<() => void>();
let current = readArchivedLink(localStorage);

const changed = (on: boolean) => {
  current = on;
  for (const l of listeners) l();
};

window.addEventListener('storage', (e) => {
  if (e.key === ARCHIVED_LINK_KEY || e.key === null) changed(readArchivedLink(localStorage));
});

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const get = () => current;

/** Whether the sidebar shows "Archived (N)" in this browser, and the Settings switch's setter. */
export function useArchivedLink(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, get);
  return [on, (next) => { saveArchivedLink(localStorage, next); changed(next); }];
}
