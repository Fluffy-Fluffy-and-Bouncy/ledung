// Where a chat was left by a "Waiting for you" line's Open (issue #350, acceptance round 1 point 2: Back came to the
// chat's end, not to the line). Kept per chat while the page runs, and taken once: the chat shown again puts the line
// back where it was on screen.

export interface ReturnPlace {
  /** The line's item key in the chat. */
  key: string;
  /** How far below the top of the chat's scroller the line was, in pixels. */
  offset: number;
}

const places = new Map<string, ReturnPlace>();

export function keepReturnPlace(sessionId: string, place: ReturnPlace): void {
  places.set(sessionId, place);
}

export function peekReturnPlace(sessionId: string): ReturnPlace | undefined {
  return places.get(sessionId);
}

export function dropReturnPlace(sessionId: string): void {
  places.delete(sessionId);
}

/** The scrollTop that puts an element now `elementOffset` below the scroller's top back at `offset` below it. */
export function returnScrollTop(scrollTop: number, elementOffset: number, offset: number): number {
  return Math.max(0, scrollTop + elementOffset - offset);
}
