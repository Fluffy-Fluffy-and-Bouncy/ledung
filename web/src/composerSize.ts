// The message box's height, set by dragging its top edge (issue #123). One height for every session,
// kept in this browser. Pure helpers, kept apart from the component so they can be tested.

import { clampSize, KEY_STEP, parseStoredSize } from './sidebarSize.ts';

export const COMPOSER_HEIGHT_KEY = 'ledung.composer.height';

/** The share of the chat column the whole message box may take, so the transcript never disappears. */
export const MAX_SHARE = 0.75;

/** The part of `localStorage` used here, so tests can pass their own. */
export type HeightStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The text box's standard height in px, the one it has with no height chosen (issue #125): its `rows` lines with
 * its padding and border (the box is border-box), or its CSS minimum, stretched by the row to the Stop + Send column
 * beside it when that is taller. Dragging never goes below it. Whole pixels, rounded up, as the drag rounds its heights
 * and a rounded-down floor would leave the box a fraction shorter than standard.
 */
export function standardHeight(cssMin: number, lineHeight: number, rows: number, paddingY: number, borderY: number, buttons: number): number {
  return Math.ceil(Math.max(cssMin, lineHeight * rows + paddingY + borderY, buttons));
}

/**
 * Smallest and largest height of the text box in px. `min` is its standard height, `column` the chat
 * column's height and `chrome` what the message box takes around the text box (padding, border).
 */
export function heightLimits(min: number, column: number, chrome: number): { min: number; max: number } {
  return { min, max: Math.max(min, Math.floor(column * MAX_SHARE - chrome)) };
}

/** The height after a drag that started at `startY` with the box `startHeight` tall: up is taller. */
export function dragHeight(startHeight: number, startY: number, y: number, min: number, max: number): number {
  return clampSize(startHeight + (startY - y), min, max);
}

/** The new height after a key press on the grip, or null when the key does nothing. Up grows, as dragging up does. */
export function heightForKey(key: string, height: number, min: number, max: number): number | null {
  if (key === 'ArrowUp') return clampSize(height + KEY_STEP, min, max);
  if (key === 'ArrowDown') return clampSize(height - KEY_STEP, min, max);
  if (key === 'Home') return min;
  if (key === 'End') return max;
  return null;
}

/** The stored height, or null for the default (three rows). */
export function readHeight(store: HeightStore): number | null {
  try {
    return parseStoredSize(store.getItem(COMPOSER_HEIGHT_KEY));
  } catch {
    return null;
  }
}

/** null goes back to the default and removes the entry. */
export function writeHeight(store: HeightStore, px: number | null): void {
  try {
    if (px == null) store.removeItem(COMPOSER_HEIGHT_KEY);
    else store.setItem(COMPOSER_HEIGHT_KEY, String(px));
  } catch {
    // Private mode: the height is kept for this visit only.
  }
}
