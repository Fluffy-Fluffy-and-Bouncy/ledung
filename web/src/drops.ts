// Files dropped or picked in the message box that Ledung can't attach as an image (issue #339): Ledung keeps a copy in
// the session's folder under .ledung/drops (src/sessions/drops.ts) and the box gets its path, so Claude can open it.
import { CHAT_IMAGE_TYPES } from './chatImages.ts';

/** The most a dropped file may have; Ledung refuses more (src/sessions/drops.ts). */
export const MAX_DROP_BYTES = 50 * 1024 * 1024;

/** What the box gets for a saved drop: the path relative to the folder the session works in. */
export const dropToken = (path: string): string => `[file: ${path}]`;

/** Why this file can't be dropped, or null. Checked before any upload, so a large file never starts one. */
export function dropProblem(file: { name: string; size: number }): string | null {
  return file.size > MAX_DROP_BYTES ? `${file.name || 'This file'} is too large: at most ${MAX_DROP_BYTES / 1024 / 1024} MB.` : null;
}

/** The images Ledung sends as images (as before, issue #128), and every other file, which is saved and linked. */
export function splitDropped<F extends { type: string }>(files: readonly F[]): { images: F[]; others: F[] } {
  const images: F[] = [];
  const others: F[] = [];
  for (const f of files) (CHAT_IMAGE_TYPES.includes(f.type) ? images : others).push(f);
  return { images, others };
}

/** `token` put into `text` at `at`, with a space on a side that touches other text; the caret after it. */
export function insertAt(text: string, at: number, token: string): { text: string; caret: number } {
  const where = Math.max(0, Math.min(at, text.length));
  const before = text.slice(0, where);
  const after = text.slice(where);
  const put = `${before && !/\s$/.test(before) ? ' ' : ''}${token}${after && !/^\s/.test(after) ? ' ' : ''}`;
  return { text: before + put + after, caret: before.length + put.length };
}
