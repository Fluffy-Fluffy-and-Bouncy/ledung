// A plan usage limit (5-hour, weekly) drawn as a ship: its place on the strip is how much is used, it
// glides slowly to each new value, and from 90% it breaks down a stage every 2%, a wreck at 100%. When the
// window resets it turns round and sails off left, and a fresh ship sails in at 0%. Drawings in shipFrames.ts.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BAR_WIDTHS, WRECK, barArriving, barLeaving, barScene, barValue, barX, damageStage, render, type Hull, type Mark, type Scene } from './shipFrames.ts';
import { useShipSize } from './SailingShip.tsx';
import { shownPercent } from '../../../src/shared/usage-stop-text.ts';

const STEP_MS = 180;

/** Draws a scene with the ship's own cells and the number's in spans, so they take the damage colour while the sea doesn't. */
function Drawing({ scene, step, number, cls }: { scene: Scene; step: number; number: Mark[]; cls: string }): ReactNode {
  const all = render(scene, step);
  const sea = render({ ...scene, sprites: [] }, step);
  const own = new Set(number.map((m) => m.y * (scene.width + 1) + m.x));
  const out: ReactNode[] = [];
  let plain = '';
  for (let i = 0; i < all.length; i++) {
    const marked = own.has(i) || (all[i] !== sea[i] && all[i] !== '\n');
    if (!marked) {
      plain += all[i];
      continue;
    }
    if (plain) out.push(plain);
    plain = '';
    out.push(<span key={i} className={cls}>{all[i]}</span>);
  }
  if (plain) out.push(plain);
  return out;
}

/** The width of one column at a given text size, measured with the ship's own font. */
function charWidth(el: Element, size: number): number {
  const canvas = document.createElement('canvas').getContext('2d');
  if (!canvas) return size * 0.6;
  const font = getComputedStyle(el).fontFamily;
  canvas.font = `600 ${size}px ${font}`;
  return canvas.measureText('~'.repeat(50)).width / 50;
}

type Motion = { mode: 'leaving' | 'arriving' | null; x: number; stage: number; shown: number; at: number };

/** utilization: 0–1. hull: the ship, or a fleet's smaller boat. The strip takes the widest width that fits its box. */
export function LimitShip({ utilization, label, hull = 'ship' }: { utilization: number; label: string; hull?: Hull }) {
  const { size, next, step: stepSize } = useShipSize('ledung.limitShipSize', 5);
  const box = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(BAR_WIDTHS.at(-1)!);
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [step, setStep] = useState(0);

  useLayoutEffect(() => {
    const el = box.current?.parentElement;
    if (!el || !box.current) return;
    const fit = () => {
      const cw = charWidth(box.current!, size);
      setWidth(BAR_WIDTHS.find((w) => w * cw <= el.clientWidth) ?? BAR_WIDTHS.at(-1)!);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [size]);

  const shown = barValue(utilization * 100, width, hull);
  const motion = useRef<Motion | null>(null);
  const m = motion.current ?? (motion.current = { mode: null, x: barX(shown, width, hull), stage: damageStage(shown), shown, at: -1 });
  // Usage only goes down when the window resets: the old ship leaves and a new one comes.
  if (m.mode === null && shown < m.shown && !still) m.mode = 'leaving';
  if (m.mode === null) m.shown = shown;

  useEffect(() => {
    if (still) return;
    const timer = setInterval(() => setStep((s) => s + 1), STEP_MS);
    return () => clearInterval(timer);
  }, [still]);

  // Move one frame: fast off to the left on a reset, then in from the edge; otherwise a column every other frame toward the value.
  // Moves once per tick, however often the page re-renders.
  const moves = m.at !== step;
  m.at = step;
  let scene: Scene;
  let number: Mark[] = [];
  let stage = m.stage;
  if (m.mode === 'leaving') {
    scene = barLeaving(width, m.stage, m.x, hull);
    if (moves) m.x -= 2;
    if (m.x < -10) Object.assign(m, { mode: 'arriving', x: -6, stage: 0 });
  } else if (m.mode === 'arriving') {
    scene = barArriving(width, m.x, hull);
    stage = 0;
    if (moves) m.x += 1;
    if (m.x >= 0) Object.assign(m, { mode: null, x: 0, shown: 0 });
  } else {
    const target = barX(shown, width, hull);
    if (still || Math.abs(target - m.x) > width) m.x = target;
    else if (moves && step % 2 === 0 && m.x !== target) m.x += Math.sign(target - m.x);
    stage = m.stage = damageStage(shown);
    // The number is exact, rounded down, even though the hull moves in steps of 2 or 5.
    ({ scene, number } = barScene(width, stage, m.x, `${shownPercent(utilization)}%`, hull));
  }
  const cls = stage >= WRECK ? 'limit-ship-hull wreck' : stage > 0 ? 'limit-ship-hull breaking' : 'limit-ship-hull';

  return (
    <button ref={box} type="button" className="ship-button limit-ship" title={`${label}: ${Math.round(utilization * 100)}% used. Ship size ${size}px: click for ${next}px`} onClick={stepSize}>
      <pre className="sailing-ship" style={{ fontSize: `${size}px` }} aria-hidden="true">
        <Drawing scene={scene} step={still ? 0 : step} number={number} cls={cls} />
      </pre>
    </button>
  );
}
