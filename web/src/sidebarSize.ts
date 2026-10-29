// Sidebar size: the width beside the chat, or the height above it on a narrow screen.
// Pure helpers, kept apart from the component so they can be tested.

export type Axis = 'width' | 'height';

export const NARROW_QUERY = '(max-width: 760px)';
export const KEY_STEP = 20;

/** Smallest, largest and default size in px for the window size along the axis. */
export function sizeLimits(axis: Axis, windowSize: number): { min: number; max: number; def: number } {
  if (axis === 'width') {
    // Half the window at most, so the chat stays usable; never below the minimum.
    const min = 220;
    const max = Math.max(min, Math.floor(windowSize / 2));
    return { min, max, def: Math.min(290, max) };
  }
  const min = 120;
  const max = Math.max(min, Math.floor(windowSize * 0.75));
  return { min, max, def: Math.min(max, Math.max(min, Math.floor(windowSize * 0.55))) };
}

export function clampSize(px: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, px)));
}

/** A stored value back into use: anything that is not a positive number means "default" (null). */
export function parseStoredSize(raw: string | null): number | null {
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The new size after a key press on the handle, or null when the key does nothing. */
export function sizeForKey(key: string, axis: Axis, size: number, min: number, max: number): number | null {
  const grow = axis === 'width' ? 'ArrowRight' : 'ArrowDown';
  const shrink = axis === 'width' ? 'ArrowLeft' : 'ArrowUp';
  if (key === grow) return clampSize(size + KEY_STEP, min, max);
  if (key === shrink) return clampSize(size - KEY_STEP, min, max);
  if (key === 'Home') return min;
  if (key === 'End') return max;
  return null;
}
