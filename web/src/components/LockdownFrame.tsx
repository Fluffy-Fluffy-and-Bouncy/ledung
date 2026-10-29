import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { borderRuns, frameThickness, vaultBorder } from '../lockdownFrame.ts';

/** A cell of the border is one character of the frame's font: 10 px tall (its line height), as wide as the font says. */
const LINE_PX = 10;

let measured = 0;
/** One character's width in the border's font, measured once the fonts are in. */
function cellWidth(): number {
  if (measured) return measured;
  const probe = document.createElement('span');
  probe.className = 'lframe-probe';
  probe.textContent = '0'.repeat(100);
  document.body.append(probe);
  const w = probe.getBoundingClientRect().width / 100;
  probe.remove();
  if (w > 0 && document.fonts?.status !== 'loading') measured = w;
  return w || 6;
}

interface Geometry { cols: number; rows: number; cw: number; padX: number; padY: number; extra: number }

/**
 * A locked project's vault border round its children (issue #129); a level of null leaves them exactly as they are.
 * `fill`: the frame takes the room its parent gives it (the chat panel) and the children fill it as a column;
 * otherwise it fits round its children (a sidebar entry). The border is one <pre> behind them, a whole number of
 * cells, redrawn whenever the frame or what it holds changes size.
 */
export function LockdownFrame({ level, fill, children }: { level: 'A' | 'B' | null; fill?: boolean; children: ReactNode }) {
  if (!level) return <>{children}</>;
  return <Frame level={level} fill={!!fill}>{children}</Frame>;
}

function Frame({ level, fill, children }: { level: 'A' | 'B'; fill: boolean; children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const th = frameThickness(level);

  useLayoutEffect(() => {
    const measure = () => {
      const e = el.current;
      const i = inner.current;
      if (!e || !i) return;
      const cw = cellWidth();
      const w = e.clientWidth;
      const cols = Math.max(2 * th + 12, Math.floor(w / cw));
      const padX = Math.max(0, (w - cols * cw) / 2);
      let rows: number, padY = 0, extra = 0;
      if (fill) {
        const h = e.clientHeight;
        rows = Math.max(2 * th + 3, Math.floor(h / LINE_PX));
        padY = Math.max(0, (h - rows * LINE_PX) / 2);
      } else {
        // The children's own height, without the padding that rounds it up to whole rows.
        const h = i.clientHeight - (parseFloat(getComputedStyle(i).paddingBottom) || 0);
        const innerRows = Math.max(1, Math.ceil(h / LINE_PX - 0.01));
        rows = innerRows + 2 * th;
        extra = Math.max(0, innerRows * LINE_PX - h);
      }
      const next = { cols, rows, cw, padX, padY, extra };
      setGeo((g) => (g && g.cols === cols && g.rows === rows && g.cw === cw && Math.abs(g.padX - padX) < 0.5 && Math.abs(g.padY - padY) < 0.5 && Math.abs(g.extra - extra) < 0.5 ? g : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el.current!);
    ro.observe(inner.current!);
    let live = true;
    void document.fonts?.ready.then(() => { if (live) { measured = 0; measure(); } });
    return () => { live = false; ro.disconnect(); };
  }, [level, fill, th]);

  const cw = geo?.cw ?? 6;
  const mx = (geo?.padX ?? 0) + th * cw;
  const my = (geo?.padY ?? 0) + th * LINE_PX;
  return (
    <div ref={el} className={`lframe ${level.toLowerCase()}${fill ? ' fill' : ''}`} data-lock={level}>
      <pre className="lframe-border" aria-hidden="true" style={geo ? { left: geo.padX, top: geo.padY, width: geo.cols * cw, height: geo.rows * LINE_PX } : undefined}>
        {geo && borderRuns(vaultBorder(level, geo.cols, geo.rows)).map((runs, y) => (
          <span key={y}>
            {y > 0 && '\n'}
            {runs.map((r, n) => (r.kind ? <span key={n} className={`k-${r.kind}`}>{r.text}</span> : r.text))}
          </span>
        ))}
      </pre>
      <div ref={inner} className="lframe-inner" style={{ margin: `${my}px ${mx}px`, paddingBottom: geo?.extra || undefined }}>
        {children}
      </div>
    </div>
  );
}
