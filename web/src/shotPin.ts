// Whether the screenshot page pins its picture and verdict bar at the top on a narrow screen (issue #177). Pinned,
// the rest of the page scrolls under them; when they take most of the scrolling area (a phone held sideways, a short
// window), the slip under them, its note and Send, could never come out from under them (#191 review, finding 1), so
// they scroll away with the page instead. Kept apart from the component so it can be tested.

/** The share of the scrolling area the pinned part may take, leaving at least the rest for the slip. */
export const PIN_SHARE = 0.6;

/** Pin when the picture and bar together are at most PIN_SHARE of the area they scroll in. */
export const pinsShotTop = (topHeight: number, areaHeight: number): boolean => topHeight > 0 && areaHeight > 0 && topHeight <= areaHeight * PIN_SHARE;
