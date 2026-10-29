// The syntax colourer (highlight.ts) once it has loaded; null until then, and the code shows plain meanwhile.
import { useEffect, useState } from 'react';
import { loadHighlighter, type Highlighter } from './highlight.ts';

export function useHighlighter(): Highlighter | null {
  const [hl, setHl] = useState<{ fn: Highlighter } | null>(null);
  useEffect(() => {
    let live = true;
    loadHighlighter().then((fn) => live && setHl({ fn }), () => {});
    return () => { live = false; };
  }, []);
  return hl?.fn ?? null;
}
