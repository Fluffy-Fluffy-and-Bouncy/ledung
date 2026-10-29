// The note under a tool result Ledung stored cut (issue #349, src/store/trim.ts), shared by the page and the tests.

/** "Ledung kept only the start of this output (about 1.2 MB more was cut). …" from the characters cut. */
export function cutNote(chars: number): string {
  const size = chars >= 1024 * 1024 ? `${(chars / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(chars / 1024))} KB`;
  return `Ledung kept only the start of this output (about ${size} more was cut). The full output is in Claude Code's own transcript of the session.`;
}

/** The characters cut from a stored tool result block, or 0. */
export function cutChars(block: unknown): number {
  const n = Number((block as { ledung_cut?: { chars?: unknown } } | null)?.ledung_cut?.chars ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
