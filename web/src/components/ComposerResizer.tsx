import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { clampSize } from '../sidebarSize.ts';
import { dragHeight, heightForKey, heightLimits, readHeight, standardHeight, writeHeight } from '../composerSize.ts';

function store(): Storage | null {
  try { return localStorage; } catch { return null; }
}

/**
 * The message box's height (issue #123): `box` goes on .composer, `area` on its text box, and the grip on top of
 * the box. One height for every session, kept in this browser; none stored is the default three rows.
 */
export function useComposerHeight() {
  const box = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [saved, setSaved] = useState<number | null>(() => { const s = store(); return s ? readHeight(s) : null; });
  const [limits, setLimits] = useState<{ min: number; max: number } | null>(null);

  // The limits follow the chat column: a smaller window lowers the maximum, so the transcript keeps its share.
  const measure = useCallback(() => {
    const el = box.current;
    const ta = area.current;
    const column = el?.parentElement;
    if (!el || !ta || !column) return null;
    const cs = getComputedStyle(el);
    const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    // The floor is the box's standard height, not its CSS minimum, which is shorter than Stop + Send (issue #125).
    const ts = getComputedStyle(ta);
    const lineHeight = parseFloat(ts.lineHeight) || parseFloat(ts.fontSize) * 1.2;
    const buttons = el.querySelector<HTMLElement>('.composer-buttons')?.offsetHeight ?? 0;
    const min = standardHeight(
      parseFloat(ts.minHeight) || 0, lineHeight, ta.rows,
      parseFloat(ts.paddingTop) + parseFloat(ts.paddingBottom), parseFloat(ts.borderTopWidth) + parseFloat(ts.borderBottomWidth), buttons,
    );
    return heightLimits(min, column.clientHeight, chrome);
  }, []);

  // Before the first paint, so a stored height below the standard one (saved before issue #125) never shows.
  useLayoutEffect(() => {
    const column = box.current?.parentElement;
    if (!column) return;
    const update = () => setLimits(measure());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(column);
    return () => ro.disconnect();
  }, [measure]);

  const height = saved == null ? null : limits ? clampSize(saved, limits.min, limits.max) : saved;

  const set = (px: number | null) => {
    const s = store();
    if (s) writeHeight(s, px);
    setSaved(px);
  };

  const drag = useRef<{ y: number; h: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !area.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    drag.current = { y: e.clientY, h: area.current.offsetHeight };
    setLimits(measure());
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !limits || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    set(dragHeight(d.h, d.y, e.clientY, limits.min, limits.max));
  };
  const onPointerEnd = () => { drag.current = null; };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const l = measure();
    if (!l || !area.current) return;
    const next = heightForKey(e.key, area.current.offsetHeight, l.min, l.max);
    if (next == null) return;
    e.preventDefault();
    set(next);
  };

  const grip = (
    <div
      className="composer-grip"
      role="separator"
      aria-label="Resize the message box"
      aria-orientation="horizontal"
      aria-valuenow={height ?? undefined}
      aria-valuemin={limits?.min}
      aria-valuemax={limits?.max}
      tabIndex={0}
      title="Drag up to make the message box taller, double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={() => set(null)}
      onKeyDown={onKeyDown}
    />
  );

  return { box, area, style: height == null ? undefined : { height }, grip };
}
