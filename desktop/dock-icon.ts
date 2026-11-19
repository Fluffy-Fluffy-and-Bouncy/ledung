// The Mac Dock's icon (#404). macOS draws an icon given to the Dock as it is, edge to edge, while every app icon on the
// Mac carries its own transparent margin: Apple's icon grid puts the body in 824 of 1024 px, 100 px clear on each side.
// The page's icon-512.png is full-bleed (#384), so the Dock showed it larger than every other app. This pads it the
// same way. No Electron in this file, so the root tests check it (test/desktop.test.ts); main.ts does the resize.

/** The share of the canvas the icon's body fills: Apple's 824 of 1024. */
export const DOCK_ICON_BODY = 824 / 1024;

/** The body's side and the clear margin on each side, for a square canvas of `canvas` px. */
export function dockIconLayout(canvas: number): { body: number; margin: number } {
  const body = Math.round(canvas * DOCK_ICON_BODY);
  return { body, margin: Math.floor((canvas - body) / 2) };
}

/**
 * A `body`-px square bitmap centred on a transparent `canvas`-px square, 4 bytes a pixel. The byte order (BGRA or
 * RGBA) is kept as given: only whole pixels are copied, and the margin is all zero, transparent in either.
 */
export function padBitmap(bitmap: Uint8Array, body: number, canvas: number): Buffer {
  if (bitmap.length !== body * body * 4) throw new Error(`a ${body} px bitmap has ${body * body * 4} bytes, not ${bitmap.length}`);
  if (body > canvas) throw new Error(`a ${body} px body does not fit a ${canvas} px canvas`);
  const out = Buffer.alloc(canvas * canvas * 4);
  const margin = Math.floor((canvas - body) / 2);
  const row = body * 4;
  for (let y = 0; y < body; y++) {
    out.set(bitmap.subarray(y * row, (y + 1) * row), ((y + margin) * canvas + margin) * 4);
  }
  return out;
}
