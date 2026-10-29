// The Compact sidebar slider in Settings (issue #153): four steps from none to max, matching the
// mockup's columns A–D (Martin, 2026-10-16 15:14: "in the settings menu have a slider that goes from
// none to max with live updates"). Kept per browser, like the status dot switch (#151). The ship is
// shown at every step (Martin, 15:04: "I always want to show the ascii art"); what a step hides
// from a row goes into the row's tooltip, so nothing is lost.

export const COMPACT_KEY = 'ledung.compactSidebar';

export type CompactStep = 1 | 2 | 3 | 4;

/** The slider's steps, in order, with the label Settings shows for each. */
export const COMPACT_STEPS: { step: CompactStep; label: string }[] = [
  { step: 1, label: 'None' },
  { step: 2, label: 'Less padding, no time row' },
  { step: 3, label: 'Name + ship' },
  { step: 4, label: 'Tightest' },
];

/** The parts of `localStorage` used here, so tests can pass their own. */
export type CompactStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const asStep = (n: number): CompactStep | null => (n === 1 || n === 2 || n === 3 || n === 4 ? n : null);

/** The step this browser keeps; None unless set, and None for anything it doesn't know. */
export function readCompact(store: CompactStore): CompactStep {
  try { return asStep(Number(store.getItem(COMPACT_KEY))) ?? 1; } catch { return 1; }
}

/** Saves the step; None is the default, so it removes the entry. */
export function saveCompact(store: CompactStore, step: CompactStep): void {
  try {
    if (step === 1) store.removeItem(COMPACT_KEY);
    else store.setItem(COMPACT_KEY, String(step));
  } catch { /* private mode: kept for this visit only */ }
}

/** What a session row and its project row show at a step. */
export interface CompactRows {
  /** The date and clock row. */
  time: boolean;
  /** Tokens, context, branch and the rest of the usage line. */
  usage: boolean;
  /** "+" and a smaller ⚙ instead of "+ Session" and ⚙. */
  plusOnly: boolean;
  /** The largest text size the ship is drawn at, or none: the size chosen by clicking a ship. */
  shipMax?: number;
}

/**
 * The same on a touch screen, where the hidden rows' tooltip can't be opened: the steps are opt-in, and keeping the
 * rows there left the phone's sidebar unchanged (issue #207, Martin 2026-10-18: "Steps work the same on the phone").
 */
export function compactRows(step: CompactStep): CompactRows {
  switch (step) {
    case 1: return { time: true, usage: true, plusOnly: false };
    case 2: return { time: false, usage: true, plusOnly: false };
    case 3: return { time: false, usage: false, plusOnly: true };
    case 4: return { time: false, usage: false, plusOnly: true, shipMax: 6 };
  }
}

/**
 * A row's tooltip: its status when the dot is off (#151), then from step 2 on the time and the usage
 * line, which carries the branch, so a compact row loses nothing. Undefined when there is nothing.
 */
export function rowTooltip(step: CompactStep, status: string | undefined, time: string, usage: string): string | undefined {
  const lines = [status ?? '', ...(step > 1 ? [time, usage] : [])].filter(Boolean);
  return lines.length ? lines.join('\n') : undefined;
}
