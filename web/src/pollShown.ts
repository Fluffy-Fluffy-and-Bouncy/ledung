// Polls that rest while the page is hidden (issue #233, audit O12). The usage panels reload their whole data on a
// timer; on a phone with the page in the background, or a tab behind others, nobody sees it, so nothing is loaded
// then. Shown again, they load at once if their period has passed meanwhile, and go on as before.

/** The part of `document` this needs, so the tests can hand in their own. */
export interface Page {
  visibilityState: string;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

/**
 * Calls `load` now and every `periodMs` while the page is shown; none while it is hidden, and once on being shown
 * again when the last load is older than the period. Returns the stop.
 */
export function pollWhileShown(load: () => unknown, periodMs: number, page: Page = document, now: () => number = Date.now): () => void {
  let last = now();
  const run = () => {
    last = now();
    void load();
  };
  run();
  const timer = setInterval(() => {
    // Not again just after the load on being shown (review of #237, finding 3): the timer keeps its own phase. Half a
    // period, not a whole one, so a timer that fires a little early still loads on its regular round.
    if (page.visibilityState === 'visible' && now() - last >= periodMs / 2) run();
  }, periodMs);
  const onShown = () => {
    if (page.visibilityState === 'visible' && now() - last >= periodMs) run();
  };
  page.addEventListener('visibilitychange', onShown);
  return () => {
    clearInterval(timer);
    page.removeEventListener('visibilitychange', onShown);
  };
}
