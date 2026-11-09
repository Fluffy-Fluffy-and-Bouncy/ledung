// The widths of the panels on the right (issue #198): the Files and Workflow panes beside a chat, the workflow page's
// side panel and the builder's. Pure helpers, kept apart from the component so they can be tested.
import { clampSize, KEY_STEP } from './sidebarSize.ts';

export type PaneKind = 'chat-pane' | 'flow-panel' | 'builder-panel';

export interface PaneSpec {
  /** The narrowest the panel goes, in px. */
  min: number;
  /** The room in px the area beside it keeps: the chat, or the diagram. */
  room: number;
  /** The element beside the panel that gives up the width, a child of the panel's parent. */
  beside: string;
  /** The panels of this kind, which share the width it sets (a Files pane and a file opened beside the chat). */
  same: string;
  /** The CSS variable set on the panel's parent; the CSS falls back to the panel's standard width without it. */
  variable: string;
}

export const PANES: Record<PaneKind, PaneSpec> = {
  'chat-pane': { min: 280, room: 360, beside: '.chat-column', same: '.file-panel', variable: '--chat-pane-w' },
  'flow-panel': { min: 256, room: 320, beside: '.flow-drawing', same: '.flow-panel', variable: '--flow-panel-w' },
  'builder-panel': { min: 272, room: 320, beside: '.flow-canvas', same: '.flow-panel', variable: '--builder-panel-w' },
};

export const storageKey = (kind: PaneKind) => `ledung.pane.${kind}`;

/**
 * Smallest and largest width for a panel in a row with `shared` px left for it and the area beside it (the row less
 * everything else in it), with `count` panels of its kind showing, all at the width it sets: the area keeps its room;
 * the panel never goes below its minimum.
 */
export function paneLimits(spec: PaneSpec, shared: number, count = 1): { min: number; max: number } {
  return { min: spec.min, max: Math.max(spec.min, Math.floor((shared - spec.room) / Math.max(1, count))) };
}

/** The width while dragging the handle on the panel's left edge: from the pointer to the panel's right edge. */
export function dragWidth(right: number, pointerX: number, min: number, max: number): number {
  return clampSize(right - pointerX, min, max);
}

/** The new width after a key press on the handle, or null when the key does nothing; the handle is on the left, so ← widens. */
export function paneWidthForKey(key: string, width: number, min: number, max: number): number | null {
  if (key === 'ArrowLeft') return clampSize(width + KEY_STEP, min, max);
  if (key === 'ArrowRight') return clampSize(width - KEY_STEP, min, max);
  if (key === 'Home') return min;
  if (key === 'End') return max;
  return null;
}
