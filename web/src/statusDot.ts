// The status dot at the left of every session row in the sidebar (issue #151): the ship shows much
// the same, so it can be switched off in Settings; shown unless switched off (Martin, 2026-10-16
// 14:32: FFBuddha wants to keep it). Kept per browser, like the autocorrect switch (#147). With the
// dot off, the row carries the status label as its tooltip and an ended session, which has no ship,
// gets a muted title, so the row still says what the dot said.
import type { SessionInfo } from '../../src/shared/protocol.ts';
import { STATUS_LABEL } from './sessionStatus.ts';

export const STATUS_DOT_KEY = 'ledung.statusDot';

/** The parts of `localStorage` used here, so tests can pass their own. */
export type DotStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Whether the sidebar shows the status dot in this browser; shown unless switched off. */
export function readStatusDot(store: DotStore): boolean {
  try { return store.getItem(STATUS_DOT_KEY) !== '0'; } catch { return true; }
}

/** Saves the switch; on is the default, so it removes the entry. */
export function saveStatusDot(store: DotStore, on: boolean): void {
  try {
    if (on) store.removeItem(STATUS_DOT_KEY);
    else store.setItem(STATUS_DOT_KEY, '0');
  } catch { /* private mode: kept for this visit only */ }
}

/** How a sidebar row shows its status: the dot, or, with the dot off, a tooltip and a muted title once ended. */
export function rowStatus(dot: boolean, s: Pick<SessionInfo, 'status'>): { dot: boolean; tooltip?: string; ended: boolean } {
  if (dot) return { dot: true, ended: false };
  return { dot: false, tooltip: STATUS_LABEL[s.status], ended: s.status === 'ended' };
}
