// When the page's live connection tries again after it closed (#488). It used to back off from 0.5 s to 10 s, so a page
// whose Ledung was stopped, updated and started again could sit up to 10 s on "Failed to fetch" with no update banner,
// and a desktop window hidden through all of that came back showing just that. Martin, 2026-11-21 21:25 (Ledung
// question #112 on tubal-cain, "c — Banner only"): "retry faster (every 0.5 s while the server is away)", and the
// banner, never a reload by itself (decision of 2026-10-13). A page shown again, or brought to the front, tries at once.

/** How long the page waits before each new try while Ledung is away: the same every time, no back-off. */
export const RETRY_MS = 500;

/** The part of `document` and `window` this listens on, so the tests can hand in their own. */
export interface Events {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface Retry {
  /** The connection closed: try again in RETRY_MS, or at once when the page is shown or focused first. */
  closed(): void;
  /** A try that waits is not needed any more (the page connects now by itself). */
  cancel(): void;
  /** The page is going: no more tries, no more listening. */
  stop(): void;
}

/**
 * Calls `connect` RETRY_MS after each `closed()`, and at once instead when, while it waits, the page becomes visible,
 * the window gets the focus (the desktop app's hidden window is shown and focused; it stays "visible" while hidden,
 * desktop/main.ts backgroundThrottling) or the network comes back. Nothing happens on those while connected.
 */
export function retryConnection(connect: () => void, page: Events & { visibilityState: string } = document, win: Events = window): Retry {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting = false;
  let stopped = false;
  const go = () => {
    clearTimeout(timer);
    waiting = false;
    connect();
  };
  const now = () => {
    if (waiting && !stopped) go();
  };
  const shown = () => {
    if (page.visibilityState === 'visible') now();
  };
  page.addEventListener('visibilitychange', shown);
  win.addEventListener('focus', now);
  win.addEventListener('online', now);
  return {
    closed() {
      if (stopped) return;
      clearTimeout(timer);
      waiting = true;
      timer = setTimeout(go, RETRY_MS);
    },
    cancel() {
      clearTimeout(timer);
      waiting = false;
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      waiting = false;
      page.removeEventListener('visibilitychange', shown);
      win.removeEventListener('focus', now);
      win.removeEventListener('online', now);
    },
  };
}
