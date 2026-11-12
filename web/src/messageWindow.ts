// Which part of a long conversation is drawn (issue #233, audit O10). A session with thousands of messages drew
// every one it had loaded, so opening it or scrolling on a phone laid out all of them. Now the page draws the end
// of the conversation, where it opens and where new messages arrive, and draws earlier ones a batch at a time as
// the reader scrolls up to them; back at the end, the earlier ones are let go again.

/** How many of the latest items are drawn: several screens, so a short scroll up never waits. */
export const TAIL = 300;
/** How many more each step up draws. */
export const STEP = 200;
/** How near the top (px) the reader gets before the next batch up is drawn. */
export const NEAR_TOP = 600;

/** The first item drawn when the conversation is shown from its end. */
export function tailStart(count: number): number {
  return Math.max(0, count - TAIL);
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
export function stepUp(start: number): number {
  return Math.max(0, start - STEP);
}
