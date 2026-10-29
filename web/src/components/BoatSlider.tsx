// The Compact sidebar slider's look (issue #155): the page's ASCII ship is the handle, on a strip of water
// with a buoy and a label at each step. The range input itself stays, laid over the drawing with its thumb
// as wide as the ship, so dragging, clicking, the arrow keys and what a screen reader hears are the
// input's own (#153). Changing step, the ship sails there; without motion it is simply there.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ROWS, SLIDER_SHIP, SLIDER_WIDTH, buoyX, render, sliderScene, sliderX } from './shipFrames.ts';

const SAIL_MS = 45;

/** children: the range input. labels: one per step, in order; clicking one picks that step. */
export function BoatSlider({ step, labels, onPick, children }: { step: number; labels: string[]; onPick: (step: number) => void; children: ReactNode }) {
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const count = labels.length;
  const target = sliderX(step, count);
  const [x, setX] = useState(target);
  const facing = useRef<'right' | 'left'>('right');
  const waves = useRef(0);

  useEffect(() => {
    if (x === target) return;
    if (still) { setX(target); return; }
    const timer = setTimeout(() => {
      waves.current += 1;
      setX((at) => at + Math.sign(target - at));
    }, SAIL_MS);
    return () => clearTimeout(timer);
  }, [x, target, still]);

  // It faces the way it last sailed, and keeps facing it at rest.
  if (x !== target) facing.current = target > x ? 'right' : 'left';
  const rows = render(sliderScene(x, count, facing.current, x !== target), waves.current).split('\n');
  return (
    <span className="boat-slider" style={{ '--boat-width': SLIDER_WIDTH, '--boat-ship': SLIDER_SHIP } as CSSProperties}>
      <span className="boat-track">
        <pre className="sailing-ship" aria-hidden="true">
          {rows.slice(0, ROWS - 1).join('\n')}{'\n'}<span className="boat-water">{rows[ROWS - 1]}</span>
        </pre>
        {children}
      </span>
      <span className="boat-marks" aria-hidden="true">
        {labels.map((label, i) => (
          <span key={label} className={i + 1 === step ? 'on' : undefined} style={{ '--at': (buoyX(i + 1, count) + 0.5) / SLIDER_WIDTH } as CSSProperties}
            onClick={(e) => { e.preventDefault(); onPick(i + 1); }}>{label}</span>
        ))}
      </span>
    </span>
  );
}
