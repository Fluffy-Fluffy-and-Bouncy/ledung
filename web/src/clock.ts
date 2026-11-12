// One shared clock per period for everything on the page that ticks (issue #233, audit O11): every ship, the
// working line's seconds, a clear's countdown. Before it, each mounted one ran its own timer, so a sidebar of
// 50 working sessions ran 50 timers that each redrew on their own; now they share one, and React draws them in
// one pass per tick. The timer runs only while something listens.
import { useEffect, useState } from 'react';

type Ticker = { timer: ReturnType<typeof setInterval>; listeners: Set<() => void> };
const tickers = new Map<number, Ticker>();

/** Calls fn every `periodMs` from the clock shared by everything with that period; returns the unsubscribe. */
export function onTick(periodMs: number, fn: () => void): () => void {
  let t = tickers.get(periodMs);
  if (!t) {
    const listeners = new Set<() => void>();
    // A copy, so a listener that unsubscribes (or subscribes another) on a tick doesn't change this tick's round.
    t = { listeners, timer: setInterval(() => { for (const l of [...listeners]) l(); }, periodMs) };
    tickers.set(periodMs, t);
  }
  const ticker = t;
  // A Set: the same function twice is one listener; wrapped, so each subscription is its own.
  const own = () => fn();
  ticker.listeners.add(own);
  return () => {
    ticker.listeners.delete(own);
    if (ticker.listeners.size === 0 && tickers.get(periodMs) === ticker) {
      clearInterval(ticker.timer);
      tickers.delete(periodMs);
    }
  };
}

/** How many shared timers run now: for the tests. */
export function runningClocks(): number {
  return tickers.size;
}

/** The time now, redrawn every `periodMs` by the shared clock while `active`. */
export function useNow(periodMs: number, active = true): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    return onTick(periodMs, () => setNow(Date.now()));
  }, [periodMs, active]);
  return now;
}
