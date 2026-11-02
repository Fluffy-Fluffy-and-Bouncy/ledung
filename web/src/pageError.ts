// What went wrong when a page loaded on demand fails (review of #310, finding 4; #447): a part the page asked for that
// isn't there any more (the page was left open across Restart Ledung), or an error while drawing it. Told apart, so a
// drawing error isn't taken for a stale page and its words are there to report.

/** Whether an error is a part of the page that couldn't be fetched, as browsers say it, rather than an error in it. */
export function isStalePageError(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk \S+ failed|Unable to preload CSS/i.test(text);
}

/** An error's words for the page's details: its message and, when there is one, where it happened. */
export function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return e.stack && e.stack.includes(e.message) ? e.stack : `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ''}`;
}
