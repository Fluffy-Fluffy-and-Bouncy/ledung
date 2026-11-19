// Which part of a long conversation is drawn (issue #233, audit O10). A session with thousands of messages drew
// every one it had loaded, so opening it or scrolling on a phone laid out all of them. Now the page draws the end
// of the conversation, where it opens and where new messages arrive, and draws earlier ones a batch at a time as
// the reader scrolls up to them; back at the end, the earlier ones are let go again.

/**
 * How many of the latest shown messages are drawn when a conversation opens (issue #329): counted in what is on
 * screen, not in items, since hidden tool calls are items too. 300 items drew up to 300 long replies, 1.9-3.9 s at
 * 4x CPU; 40 is still several screens on a phone.
 */
export const TAIL = 40;
/** How many more shown messages each step up draws. */
export const STEP = 40;
/** How near the top (px) the reader gets before the next batch up is drawn. */
export const NEAR_TOP = 600;
/** At most this many items in one batch, however few of them show (a long run of hidden tool calls). */
export const MAX_ITEMS = 1000;

/** Whether item i draws anything; without one, every item does. */
export type Shows = (i: number) => boolean;

/** Back from `from` until `n` shown items are passed, or MAX_ITEMS items, or the first item. */
function back(from: number, n: number, shows: Shows): number {
  let i = Math.max(0, from), seen = 0;
  const stop = Math.max(0, from - MAX_ITEMS);
  while (i > stop && seen < n) {
    i -= 1;
    if (shows(i)) seen += 1;
  }
  return i;
}

/** The first item drawn when the conversation is shown from its end. */
export function tailStart(count: number, shows: Shows = () => true): number {
  return back(count, TAIL, shows);
}

/**
 * Where drawing starts: never later than `start` already is, nor than a message that must be on screen (the question
 * or reply it was opened at), a few items before it so it doesn't sit at the very top. -1 for `must`: none.
 */
export function windowStart(start: number, count: number, must: number): number {
  const s = Math.min(Math.max(0, start), Math.max(0, count - 1));
  return must >= 0 ? Math.max(0, Math.min(s, must - 20)) : s;
}

/** One batch further up from `start`. */
export function stepUp(start: number, shows: Shows = () => true): number {
  return back(start, STEP, shows);
}
