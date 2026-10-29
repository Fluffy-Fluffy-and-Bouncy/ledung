// Shortcuts that start Ledung (issue #415) as one shared value, so Yes in the first-run question and Settings →
// Shortcuts show the same. Read once when the page loads; a page Ledung refuses it (a phone, another computer) has none.
import { useEffect, useSyncExternalStore } from 'react';
import type { ShortcutAction, ShortcutsView } from '../../src/shared/protocol.ts';
import { api } from './api.ts';

let view: ShortcutsView | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const set = (next: ShortcutsView | null) => {
  view = next;
  for (const l of listeners) l();
};

function load(): Promise<void> {
  loading ??= api.shortcuts().then(set, () => set(null));
  return loading;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useShortcuts(): { view: ShortcutsView | null; act: (action: ShortcutAction) => Promise<void> } {
  useEffect(() => void load(), []);
  const current = useSyncExternalStore(subscribe, () => view);
  return { view: current, act: async (action) => set(await api.shortcutsAct(action)) };
}
