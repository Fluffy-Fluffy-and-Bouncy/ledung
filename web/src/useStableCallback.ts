import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A function that keeps its identity across renders but calls the latest `fn`, so a memoized child is not redrawn
 * only because its parent made a new closure (issue #323). Only for handlers called on an event, never during a
 * render: a render reading through it would not be redone when `fn` changes. Nor from a child's effect, which runs
 * before this one has stored the new `fn`.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
