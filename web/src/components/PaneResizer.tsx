import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { clampSize, NARROW_QUERY, parseStoredSize } from '../sidebarSize.ts';
import { dragWidth, paneLimits, paneWidthForKey, PANES, storageKey, type PaneKind } from '../paneSize.ts';
import { ResizeHandle } from './ResizeHandle.tsx';

// Two panels of a kind can be up at once (the Files pane, hidden, under a file opened from it); a change to one
// tells the other, so its handle starts from the width shown.
const CHANGED = 'ledung-pane-width';

function read(kind: PaneKind): number | null {
  try {
    return parseStoredSize(localStorage.getItem(storageKey(kind)));
  } catch {
    return null;
  }
}

function write(kind: PaneKind, px: number | null) {
  try {
    if (px == null) localStorage.removeItem(storageKey(kind));
    else localStorage.setItem(storageKey(kind), String(px));
  } catch {
    // Private mode: the width just isn't remembered.
  }
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: kind }));
}

const LABEL: Record<PaneKind, string> = {
  'chat-pane': 'Resize the panel beside the chat',
  'flow-panel': 'Resize the side panel',
  'builder-panel': 'Resize the side panel',
};

/**
 * A panel on the right made as wide as the person drags it (issue #198), as the sidebar is: `ref` goes on the panel,
 * `handle` inside it (or beside it, in a grid). The width goes into a CSS variable on the panel's parent; with none
 * stored the CSS keeps the standard width. On a phone there is no handle and the layout is as before.
 */
export function usePaneWidth<T extends HTMLElement>(kind: PaneKind) {
  const spec = PANES[kind];
  // A callback ref: the workflow page's panel comes after the flow has loaded.
  const [panel, ref] = useState<T | null>(null);
  const [saved, setSaved] = useState<number | null>(() => read(kind));
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  const [limits, setLimits] = useState<{ min: number; max: number; width: number } | null>(null);

  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onNarrow = () => setNarrow(mq.matches);
    const onChanged = (e: Event) => { if ((e as CustomEvent).detail === kind) setSaved(read(kind)); };
    mq.addEventListener('change', onNarrow);
    window.addEventListener(CHANGED, onChanged);
    return () => { mq.removeEventListener('change', onNarrow); window.removeEventListener(CHANGED, onChanged); };
  }, [kind]);

  // The row less everything else showing in it, which is for the panels of this kind and the area beside them; not the
  // panel's own width, which can overflow the row after the window shrinks. A hidden panel measures nothing.
  const measure = useCallback(() => {
    const box = panel?.parentElement;
    if (!panel || !box || panel.offsetWidth === 0 || !box.querySelector(`:scope > ${spec.beside}`)) return null;
    const cs = getComputedStyle(box);
    let shared = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    let count = 0;
    for (const child of Array.from(box.children) as HTMLElement[]) {
      if (child.matches(spec.same)) { if (child.offsetWidth > 0) count++; }
      else if (!child.matches(`${spec.beside}, .pane-resizer`)) shared -= child.offsetWidth;
    }
    return { ...paneLimits(spec, shared, count), width: panel.offsetWidth };
  }, [panel, spec]);

  // Before the first paint, and again when the window, the sidebar or anything else changes the room.
  useLayoutEffect(() => {
    const box = panel?.parentElement;
    if (narrow || !box) return;
    const update = () => {
      const m = measure();
      if (m) setLimits((was) => (was && was.min === m.min && was.max === m.max && was.width === m.width ? was : m));
    };
    update();
    // The area beside changes too when a panel next to it opens or closes, and while dragging (the handle's value).
    const ro = new ResizeObserver(update);
    ro.observe(box);
    const beside = box.querySelector(`:scope > ${spec.beside}`);
    if (beside) ro.observe(beside);
    return () => ro.disconnect();
  }, [panel, measure, narrow, spec]);

  const width = saved == null ? null : limits ? clampSize(saved, limits.min, limits.max) : saved;

  useLayoutEffect(() => {
    const box = panel?.parentElement;
    if (!box) return;
    if (narrow || width == null) box.style.removeProperty(spec.variable);
    else box.style.setProperty(spec.variable, `${width}px`);
  }, [panel, width, narrow, spec]);

  const set = (px: number | null) => {
    write(kind, px);
    setSaved(px);
  };

  const drag = useRef<{ right: number; min: number; max: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const m = measure();
    if (e.button !== 0 || !m || !panel) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    drag.current = { right: panel.getBoundingClientRect().right, min: m.min, max: m.max };
    setLimits(m);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    set(dragWidth(d.right, e.clientX, d.min, d.max));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const m = measure();
    if (!m) return;
    const next = paneWidthForKey(e.key, width ?? m.width, m.min, m.max);
    if (next == null) return;
    e.preventDefault();
    set(next);
  };

  const handle = narrow || !limits ? null : (
    <ResizeHandle
      orientation="vertical"
      className="pane-resizer"
      label={LABEL[kind]}
      value={width ?? limits.width}
      min={limits.min}
      max={limits.max}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerEnd={() => { drag.current = null; }}
      onKeyDown={onKeyDown}
      onReset={() => set(null)}
    />
  );
  return { ref, handle };
}
