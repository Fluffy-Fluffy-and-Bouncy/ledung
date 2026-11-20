// The desktop app's own keys: zoom on Windows and Linux (#389), and the find bar's on every system (#445, below). No
// Electron in it, so the root tests run it (test/desktop.test.ts); main.ts wires it to the window.
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

// The find bar's keys (#445). Electron has no find bar of its own; main.ts shows one (desktop/find-bar.html) and
// searches the page with webContents.findInPage. Ctrl+F (⌘F on the Mac) opens it from anywhere in the window, the
// composer too; in the bar, Enter and Shift+Enter step through the matches and Esc closes it, as in a browser.

/** A key press as the find bar reads it: Electron's before-input-event `input`, with Shift and the physical key. */
export interface FindKeyInput extends KeyInput {
  shift: boolean;
  /** The physical key ("KeyF"), for layouts whose F key types no Latin letter. */
  code?: string;
  /** An input method is composing: its Enter and Esc are its own, not the bar's. */
  isComposing?: boolean;
}

export type FindKey = 'open' | 'next' | 'previous' | 'close';

/**
 * The F of Ctrl+F: the key that types "f", or on a layout that types no Latin letter there (Cyrillic, Greek) the
 * physical F key, as a browser takes it. A layout that moves "f" (Dvorak) uses the key that types it.
 */
function isF(input: FindKeyInput): boolean {
  if (input.key.toLowerCase() === 'f') return true;
  return input.code === 'KeyF' && !/^[a-z]$/i.test(input.key);
}

/**
 * What a key press means to the find bar; null for anything else, which goes on to the page or the bar's text box.
 * Ctrl+F opens it on Windows and Linux, ⌘F on the Mac; Ctrl+Alt is AltGr on Windows, which types characters.
 * `inBar`: the bar has the focus, where Enter, Shift+Enter and Esc are its own; elsewhere they stay the page's.
 */
export function findKey(input: FindKeyInput, inBar: boolean, platform: NodeJS.Platform = process.platform): FindKey | null {
  if (input.type !== 'keyDown' || input.isComposing) return null;
  const command = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  if (command && !input.alt && !input.shift && isF(input)) return 'open';
  if (!inBar || input.control || input.meta || input.alt) return null;
  if (input.key === 'Enter') return input.shift ? 'previous' : 'next';
  if (input.key === 'Escape') return 'close';
  return null;
}
