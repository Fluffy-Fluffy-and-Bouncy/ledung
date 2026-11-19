// The desktop app's own zoom keys on Windows and Linux (#389). No Electron in it, so the root tests run it
// (test/desktop.test.ts); main.ts wires it to the window.
//
// The View menu's Zoom In is on Ctrl+"Plus", which Electron turns into Ctrl+Shift and the "=" key: the US layout's
// "+", and no other. On a Swedish keyboard "+" is a key of its own, so Ctrl and "+" never matched (Martin, 2026-11-19
// 01:10 on #384: "ctrl + doesnt work"). The app reads the character the key gives instead, as a browser does.

/** What a key press means as zoom; the fields are those of Electron's before-input-event `input`. */
export interface KeyInput {
  type: string;
  key: string;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

/**
 * Zoom in for Ctrl and "+" (any layout, the number pad's too) or Ctrl and "=" (the US "+" key without Shift, as in a
 * browser); null for anything else. Ctrl+Alt is AltGr on Windows, which types characters, so it is never zoom. The Mac
 * keeps its menu's keys (#389: "The Mac is unchanged").
 */
export function zoomKey(input: KeyInput, platform: NodeJS.Platform = process.platform): 'in' | null {
  if (platform === 'darwin' || input.type !== 'keyDown') return null;
  if (!input.control || input.alt || input.meta) return null;
  return input.key === '+' || input.key === '=' ? 'in' : null;
}

/** One zoom step, the View menu's own: its Zoom In and Zoom Out move the zoom level by 0.5. */
export const ZOOM_STEP = 0.5;

/** The zoom level after one step in `direction`: Ctrl+"+" and Ctrl+wheel take the same steps as Ctrl+- (#389). */
export function zoomed(level: number, direction: 'in' | 'out'): number {
  return level + (direction === 'in' ? ZOOM_STEP : -ZOOM_STEP);
}
