// The status line's ship. It follows the session: sailing while it works (a small fleet for a manager whose
// sessions work), turning to face you and stopping when it waits or is done, setting off again when work
// resumes, and sinking when the session ends with an error. A manager whose sessions have all finished
// gathers its fleet beside it while it waits, and they depart together. While a clear counts down, the next watch
// waits beside it; the clear changes the watch, a cancel sends the boat on. Drawings and timelines are in shipFrames.ts.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionInfo } from '../../../src/shared/protocol.ts';
import {
  WIDTH, calmSea, depart, fleetLeaves, gather, leadX, render, sailing, sinking, standing, startAgain, turnAndStop,
  watchArrives, watchChanges, watchStandsDown, type Behind, type Timeline,
} from './shipFrames.ts';

/** clearedAt: when the session was last cleared, so leaving 'clearing' tells a clear from a cancel. */
export type ShipMode = { clearedAt?: number | null } & (
  | { kind: 'working'; followers: number }
  | { kind: 'stopped'; behind: Behind }
  | { kind: 'clearing' }
  | { kind: 'sunk' }
);

const STEP_MS = 180;

/**
 * What a session's ship does: sail while it works (a manager's with one small boat per working session,
 * two at most), stop facing you while it waits or is idle, sink once it has ended. A stopped manager has its
 * fleet gathered beside it while any session it started is still open (working, waiting or idle); when the
 * last one ends the fleet sails off, and resuming one brings it back. Null: no ship (queued).
 */
export function shipMode(session: SessionInfo, sessions: SessionInfo[]): ShipMode | null {
  const children = sessions.filter((s) => s.parentId === session.id);
  // 'starting' is a session waiting for its first message (a resumed one waits there until spoken to), so not working.
  const childrenWorking = children.filter((s) => s.status === 'running').length;
  // Its fleet: the sessions it started that have not ended. When the last one ends, the fleet sails off.
  const childrenActive = children.filter((s) => s.status !== 'ended').length;
  const clearedAt = session.clearedAt;
  if (session.clearDue != null && session.status !== 'ended') return { kind: 'clearing', clearedAt };
  const mode = baseMode();
  return mode && { ...mode, clearedAt };
  function baseMode(): ShipMode | null {
  switch (session.status) {
    case 'running':
      // A paused session keeps its status but does no work: its ship stands like an idle one's.
      if (!session.paused) return { kind: 'working', followers: session.role === 'manager' ? childrenWorking : 0 };
      return { kind: 'stopped', behind: stoppedBehind() };
    case 'stopping':
      return { kind: 'working', followers: session.role === 'manager' ? childrenWorking : 0 };
    case 'starting':
    case 'waiting':
    case 'idle':
      return { kind: 'stopped', behind: stoppedBehind() };
    case 'ended':
      return { kind: 'sunk' };
    default:
      return null;
  }
  }
  // Work still going on behind it, or a manager's fleet gathered beside it once its sessions have finished.
  function stoppedBehind(): Behind {
    return childrenWorking > 0 || session.backgroundTasks > 0 ? 'busy' : session.role === 'manager' && childrenActive > 0 ? 'fleet' : 'none';
  }
}

/** Text sizes a ship steps through when clicked; each choice is kept per browser, under its own key. */
const SIZES = [7, 6, 5, 4];
/** What a ship is drawn at until someone clicks it to another size. */
const DEFAULT_SIZE = 5;
const sizeAfter = (n: number) => SIZES[(SIZES.indexOf(n) + 1) % SIZES.length]!;

interface SizeStore {
  get(): number;
  set(n: number): void;
  subscribe(onChange: () => void): () => void;
}
const sizeStores = new Map<string, SizeStore>();

function sizeStore(key: string, fallback: number): SizeStore {
  const known = sizeStores.get(key);
  if (known) return known;
  const read = () => {
    try {
      const n = Number(localStorage.getItem(key));
      return SIZES.includes(n) ? n : fallback;
    } catch {
      return fallback;
    }
  };
  const listeners = new Set<() => void>();
  let size = read();
  const store: SizeStore = {
    get: () => size,
    set(n) {
      size = n;
      try {
        localStorage.setItem(key, String(n));
      } catch {
        // Not kept, but still used in this page.
      }
      for (const l of listeners) l();
    },
    subscribe(onChange) {
      listeners.add(onChange);
      // Another tab changed it.
      const onStorage = (e: StorageEvent) => {
        if (e.key === key) {
          size = read();
          onChange();
        }
      };
      window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(onChange);
        window.removeEventListener('storage', onStorage);
      };
    },
  };
  sizeStores.set(key, store);
  return store;
}

/** A ship's text size, shared by every ship with the same key, and the next size a click steps to. */
export function useShipSize(key: string, fallback: number): { size: number; next: number; step: () => void } {
  const store = sizeStore(key, fallback);
  const size = useSyncExternalStore(store.subscribe, store.get);
  return { size, next: sizeAfter(size), step: () => store.set(sizeAfter(size)) };
}

/** Where the ship goes next, given where it is and what it was doing. Null before: the session was just opened. */
function next(mode: ShipMode, before: ShipMode | null, at: Timeline | null, index: number, width: number): Timeline {
  const x = leadX(at?.scenes[index]);
  // Out of a countdown: a new clearedAt means the clear happened (the watch changes), else it was cancelled.
  if (before?.kind === 'clearing' && mode.kind !== 'clearing' && mode.kind !== 'sunk') {
    return mode.clearedAt != null && mode.clearedAt !== before.clearedAt ? watchChanges(width) : watchStandsDown(width);
  }
  switch (mode.kind) {
    case 'clearing':
      return watchArrives(width);
    case 'working':
      if (before?.kind === 'stopped') return before.behind === 'fleet' ? depart(mode.followers, width) : startAgain(mode.followers, width);
      return sailing(before ? x : -6, mode.followers, width);
    case 'stopped':
      if (before?.kind === 'working') return turnAndStop(x, mode.behind, width);
      if (before?.kind === 'stopped' && before.behind !== 'fleet' && mode.behind === 'fleet') return gather(width);
      if (before?.kind === 'stopped' && before.behind === 'fleet' && mode.behind === 'none') return fleetLeaves(width);
      return standing(mode.behind, width);
    case 'sunk':
      return before && before.kind !== 'sunk' ? sinking(x, width) : calmSea(width);
  }
}

const sameMode = (a: ShipMode | null, b: ShipMode) => JSON.stringify(a) === JSON.stringify(b);

/**
 * width: columns of sea (the session list uses a narrow 10). sizeButton: clicking the ship steps its size; off
 * where the ship sits inside another button. hideWhenSunk: show nothing once a ship has gone under, so the
 * session list isn't full of empty sea. maxSize: the largest text size it is drawn at, whatever size was
 * chosen (the tightest compact sidebar, #153).
 */
export function SailingShip({ mode, width = WIDTH, sizeButton = true, hideWhenSunk = false, maxSize }: { mode: ShipMode; width?: number; sizeButton?: boolean; hideWhenSunk?: boolean; maxSize?: number }) {
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const timeline = useRef<Timeline | null>(null);
  const index = useRef(0);
  const shown = useRef<ShipMode | null>(null);
  const [step, setStep] = useState(0);
  const { size, next: nextSize, step: stepSize } = useShipSize('ledung.shipSize', DEFAULT_SIZE);

  const playingOut = (timeline.current?.oneShot ?? false) && index.current < timeline.current!.loopFrom;
  if (!sameMode(shown.current, mode) && !playingOut) {
    // Without motion the ship shows the pose it ends in; sailing shows it mid-crossing.
    const to = still && mode.kind === 'working' ? sailing(4, mode.followers, width) : next(mode, shown.current, timeline.current, index.current, width);
    const leavingClear = shown.current?.kind === 'clearing' && mode.kind !== 'clearing' && mode.kind !== 'sunk';
    timeline.current = to;
    index.current = still ? to.loopFrom : 0;
    // The change of watch plays out, ending on a ship that stands; from there it follows whatever the session does by then.
    if (leavingClear) to.oneShot = true;
    shown.current = leavingClear ? { kind: 'stopped', behind: 'none', clearedAt: mode.clearedAt } : mode;
  }

  useEffect(() => {
    if (still) return;
    const timer = setInterval(() => {
      const t = timeline.current;
      if (t) index.current = index.current + 1 < t.scenes.length ? index.current + 1 : t.loopFrom;
      setStep((s) => s + 1);
    }, STEP_MS);
    return () => clearInterval(timer);
  }, [still]);

  const t = timeline.current!;
  if (hideWhenSunk && mode.kind === 'sunk' && index.current >= t.loopFrom) return null;
  const scene = t.scenes[index.current]!;
  const drawing = <pre className="sailing-ship" style={{ fontSize: `${maxSize ? Math.min(size, maxSize) : size}px` }} aria-hidden="true">{render(scene, still ? 0 : step)}</pre>;
  if (!sizeButton) return drawing;
  return (
    <button type="button" className="ship-button" title={`Ship size ${size}px: click for ${nextSize}px`} onClick={stepSize}>
      {drawing}
    </button>
  );
}
