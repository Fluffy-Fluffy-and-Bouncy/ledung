import { useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { clampSize, NARROW_QUERY, parseStoredSize, sizeForKey, sizeLimits, type Axis } from '../sidebarSize.ts';

function read(axis: Axis): number | null {
  try {
    return parseStoredSize(localStorage.getItem(`ledung.sidebar.${axis}`));
  } catch {
    return null;
  }
}

function write(axis: Axis, px: number | null) {
  try {
    if (px == null) localStorage.removeItem(`ledung.sidebar.${axis}`);
    else localStorage.setItem(`ledung.sidebar.${axis}`, String(px));
  } catch {
    // Private mode: the size just isn't remembered.
  }
}

/** Drag handle between the sidebar and the chat. Sets --sidebar-w (side by side) or --sidebar-h (narrow screens) on .app. */
export function SidebarResizer() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  const [win, setWin] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [saved, setSaved] = useState<Record<Axis, number | null>>(() => ({ width: read('width'), height: read('height') }));
  const axis: Axis = narrow ? 'height' : 'width';

  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => { setNarrow(mq.matches); setWin({ w: window.innerWidth, h: window.innerHeight }); };
    mq.addEventListener('change', onChange);
    window.addEventListener('resize', onChange);
    return () => { mq.removeEventListener('change', onChange); window.removeEventListener('resize', onChange); };
  }, []);

  const { min, max, def } = sizeLimits(axis, narrow ? win.h : win.w);
  const size = clampSize(saved[axis] ?? def, min, max);

  // The sidebar's CSS reads the variable from .app.
  useEffect(() => {
    document.querySelector<HTMLElement>('.app')?.style.setProperty(narrow ? '--sidebar-h' : '--sidebar-w', `${size}px`);
  }, [size, narrow]);

  const set = (px: number | null) => {
    write(axis, px);
    setSaved((s) => ({ ...s, [axis]: px }));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const start = e.currentTarget.parentElement!.getBoundingClientRect();
    set(clampSize(narrow ? e.clientY - start.top : e.clientX - start.left, min, max));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = sizeForKey(e.key, axis, size, min, max);
    if (next == null) return;
    e.preventDefault();
    set(next);
  };

  return (
    <div
      className={`sidebar-resizer ${narrow ? 'horizontal' : 'vertical'}`}
      role="separator"
      aria-label="Resize the sidebar"
      aria-orientation={narrow ? 'horizontal' : 'vertical'}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onDoubleClick={() => set(null)}
      onKeyDown={onKeyDown}
    />
  );
}
