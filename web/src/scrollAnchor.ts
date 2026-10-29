/** Keeps the chat's place when its scroller is resized or hidden (tab moved to a new window, phone rotated). */

const STICK_WITHIN = 80;

/** Distance from the bottom, or null while the scroller has no height: the browser clamps scrollTop to 0 then, which says nothing about where the reader was. */
export function distanceFromBottom(scrollHeight: number, scrollTop: number, clientHeight: number): number | null {
  if (clientHeight <= 0) return null;
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export function isStuck(distance: number): boolean {
  return distance < STICK_WITHIN;
}

/** The scrollTop that restores the reader's place after a resize: the bottom if stuck, else the same distance from the bottom. */
export function restoredScrollTop(stuck: boolean, distance: number, scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight - (stuck ? 0 : distance));
}
