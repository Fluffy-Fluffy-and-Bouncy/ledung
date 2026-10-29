// Moving through Waiting for you: its history steps (issue #59), and the screenshot view, where a
// verdict moves on to the next shot and sending leaves for the view it was opened from (issue #92).
// Pure helpers, kept apart from the components so they can be tested.
import type { ShotVerdict } from '../../src/shared/protocol.ts';

/** The view's routes: the queue, or one question. */
export const isDeskView = (id: string | null): boolean => id === 'waiting' || !!id?.startsWith('q:');

/** Where a history entry is in Waiting for you: steps since the view before it, and whether there was one. */
export type DeskSteps = { depth: number; root: boolean };

/**
 * The steps of the entry `to` opens, coming from `from` with steps `fromSteps`. Each queue or
 * question opened inside Waiting for you is one step further; entering from another view is the first.
 */
export function deskStepsInto(from: string | null, fromSteps: DeskSteps, to: string | null): DeskSteps {
  if (!isDeskView(to)) return { depth: 0, root: false };
  if (isDeskView(from)) return { depth: fromSteps.depth + 1, root: fromSteps.root };
  return { depth: 1, root: false };
}

/**
 * Where sending verdicts (or withdrawing) leaves the screenshot view for, given how many steps into
 * Waiting for you its history entry is: one step back, to the view it was opened from (a session,
 * the queue, another question). At step 0 it was the first entry of the page (a reload, a typed
 * address) and there is none, so the queue.
 */
export function leaveShots(depth: number): { back: 1 } | { queue: true } {
  return depth > 0 ? { back: 1 } : { queue: true };
}

/**
 * A verdict given on the shot at place `k` of `order` (shot indexes in the order shown), whose
 * verdict so far is `before`. The same verdict again un-marks it and stays (issue #92, Martin's
 * reading by the lead). Otherwise it is marked and the view moves on to the next shot with no
 * verdict, wrapping round to the start (issue #138: shots before the one judged were otherwise never
 * reached by verdicts alone); when every shot has one, simply the next, and on the last shot it stays.
 */
export function afterVerdict(
  order: number[],
  judged: (index: number) => ShotVerdict | null | undefined,
  k: number,
  before: ShotVerdict | null | undefined,
  v: ShotVerdict,
): { verdict: ShotVerdict | null; to: number } {
  if (before === v) return { verdict: null, to: k };
  const open = firstWithout(order, judged, k + 1);
  return { verdict: v, to: open >= 0 && open !== k ? open : Math.min(k + 1, order.length - 1) };
}

/** The first place from `from` on, wrapping round, whose shot has no verdict; -1 when every shot has one. */
function firstWithout(order: number[], judged: (index: number) => ShotVerdict | null | undefined, from: number): number {
  for (let n = 0; n < order.length; n++) {
    const j = (from + n) % order.length;
    if (!judged(order[j]!)) return j;
  }
  return -1;
}

/** How soon after the missing shots were shown a send is taken as the same press (a double-click, a key bounce). */
export const SEND_GUARD_MS = 500;

/**
 * Sending verdicts (issue #138): with shots still without one, the first send doesn't go but shows the
 * first of them (in the order shown) and says how many. A send after that, at `shownAt`, sends them as
 * "no verdict", unless it comes within SEND_GUARD_MS: then it is the same double-click and is ignored
 * (#141 review, finding 1: a double-click went straight past the guard).
 */
export function sendStep(
  order: number[],
  judged: (index: number) => ShotVerdict | null | undefined,
  shownAt: number | null,
  now: number,
): { send: true } | { send: false; to: number; missing: number } | { send: false; tooSoon: true } {
  const missing = order.filter((i) => !judged(i)).length;
  if (!missing) return { send: true };
  if (shownAt === null) return { send: false, to: firstWithout(order, judged, 0), missing };
  return now - shownAt < SEND_GUARD_MS ? { send: false, tooSoon: true } : { send: true };
}

/**
 * Ctrl+Enter (Cmd+Enter on a Mac) sends verdicts. The key held down repeats: the view takes it, but only
 * a fresh press sends (#141 review round 2: a held key went past the guard after half a second).
 */
export interface KeyPress { ctrlKey: boolean; metaKey: boolean; key: string; repeat: boolean }
export const isSendKey = (e: Omit<KeyPress, 'repeat'>): boolean => (e.ctrlKey || e.metaKey) && e.key === 'Enter';
export const sendsVerdicts = (e: KeyPress): boolean => isSendKey(e) && !e.repeat;
