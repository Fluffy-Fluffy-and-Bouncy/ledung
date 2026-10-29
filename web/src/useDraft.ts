// The message box's text, held by the box itself so a key press redraws only the box, not the conversation
// (issue #323). It is still kept per session in this browser (issue #73), but written a moment after the last key
// rather than on every key, and at once when the session is left or the page hidden or closed.
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { readDraft, writeDraft, type DraftStore } from './drafts.ts';

/** How long after the last key the draft is written (issue #323). */
export const DRAFT_WRITE_DELAY = 300;

export function useDraft(sessionId: string, store: DraftStore = localStorage): [string, Dispatch<SetStateAction<string>>] {
  const [text, setText] = useState(() => readDraft(store, sessionId));
  /** The text as of the last render, for the writes that happen outside one (leaving, hiding). */
  const latest = useRef(text);
  /** What the store holds, so an unchanged draft is not written again. */
  const saved = useRef(text);
  useEffect(() => {
    latest.current = text;
  });
  const flush = useCallback(() => {
    if (latest.current === saved.current) return;
    saved.current = latest.current;
    writeDraft(store, sessionId, latest.current);
  }, [store, sessionId]);
  useEffect(() => {
    if (text === saved.current) return;
    const timer = setTimeout(flush, DRAFT_WRITE_DELAY);
    return () => clearTimeout(timer);
  }, [text, flush]);
  // Leaving the session unmounts the box; a phone may discard a hidden tab without a pagehide.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
      flush();
    };
  }, [flush]);
  return [text, setText];
}
