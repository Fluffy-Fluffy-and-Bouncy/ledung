// The anonymous daily check-in (#220) as one shared value, so OK on the notice and the switch in Settings show the
// same. Read once when the page loads; a Ledung without it (an older one in a frame) has none.
import { useEffect, useSyncExternalStore } from 'react';
import type { CheckInAction, CheckInView } from '../../src/shared/protocol.ts';
import { api } from './api.ts';

let view: CheckInView | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const set = (next: CheckInView | null) => {
  view = next;
  for (const l of listeners) l();
};

function load(): Promise<void> {
  loading ??= api.checkIn().then(set, () => set(null));
  return loading;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function useCheckIn(): { view: CheckInView | null; act: (action: CheckInAction) => Promise<void> } {
  useEffect(() => void load(), []);
  const current = useSyncExternalStore(subscribe, () => view);
  return { view: current, act: async (action) => set(await api.checkInAct(action)) };
}
