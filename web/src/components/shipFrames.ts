// The status line's ASCII ship: its drawings and the timelines that move it. Pure functions, so tests can
// check every frame without a browser. Previewed and picked by Martin before building (2026-10-12).

/** Three rows of boat over one row of water: four rows of 7px text fit the status line's 2rem height. */
export const ROWS = 4;
/** The status line's strip. Every timeline also takes a narrower one (10 works) for other places. */
export const WIDTH = 20;
const WAVES = '~-~~^~-~~~^-~~-~^~~-~^~-~~';

const SIDE = ['  |\\  ', '  |_\\ ', '\\____/'];
const SMALL = ['', ' |\\ ', '\\__/'];
const SMALL_LEFTWARD = ['', ' /| ', '\\__/'];
const QUARTER = ['   |\\ ', '  /|_\\', '  \\__/'];
const FRONT = ['   |  ', '  /|\\ ', '  \\_/ '];
/** Closer to the viewer, so one row lower: its hull sits in the water row. */
const FRONT_NEAR = ['    |   ', '   /|\\  ', '  /_|_\\ ', '  \\___/ '];

interface Sprite {
  rows: string[];
  x: number;
  y?: number;
  /** Extra x per row, to lean the mast. */
  shear?: number[];
  /** Draw rows that reach the water line instead of hiding them under the waves. */
  overWater?: boolean;
}

export interface Scene {
  width: number;
  sprites?: Sprite[];
  /** Water-row characters by column: wakes, splashes, bubbles. */
  water?: Record<number, string>;
  marks?: { x: number; y: number; ch: string }[];
}

/** A run of scenes; after the last one it repeats from loopFrom. */
export interface Timeline {
  scenes: Scene[];
  loopFrom: number;
  /** Plays to loopFrom before the ship follows a new mode (the change of watch). */
  oneShot?: boolean;
}

/** Draws one scene. The waves roll with the global step, independently of the timeline. */
export function render(scene: Scene, step: number): string {
  const width = scene.width;
  const grid = Array.from({ length: ROWS }, () => Array<string>(width).fill(' '));
  grid[ROWS - 1] = Array.from({ length: width }, (_, i) => WAVES[(i + step) % WAVES.length]!);
  for (const [i, ch] of Object.entries(scene.water ?? {})) {
    const x = Number(i);
    if (x >= 0 && x < width) grid[ROWS - 1]![x] = ch;
  }
  for (const s of scene.sprites ?? []) {
    s.rows.forEach((line, r) => {
      const y = (s.y ?? 0) + r;
      if (y >= ROWS || (y === ROWS - 1 && !s.overWater)) return;
      const x0 = s.x + (s.shear?.[r] ?? 0);
      for (let i = 0; i < line.length; i++) {
        const x = x0 + i;
        if (line[i] !== ' ' && x >= 0 && x < width) grid[y]![x] = line[i]!;
      }
    });
  }
  for (const m of scene.marks ?? []) if (m.x >= 0 && m.x < width && m.y >= 0 && m.y < ROWS) grid[m.y]![m.x] = m.ch;
  return grid.map((row) => row.join('')).join('\n');
}

const wake = (x: number): Record<number, string> => ({ [x - 1]: '=', [x - 2]: '=' });
const hold = (n: number, scene: Scene): Scene[] => Array<Scene>(n).fill(scene);

/** Positions on a strip of a given width: where a ship stops to face the viewer, and its stopped poses. */
function sea(width: number) {
  // Column 6 of 20; as central as it fits on narrower strips.
  const stop = Math.round((width - 6) / 2) - 1;
  const near: Scene = { width, sprites: [{ rows: FRONT_NEAR, x: stop - 1, overWater: true }] };
  const left = stop - 4;
  const right = stop + 4;
  const gathered: Scene = {
    width,
    sprites: [{ rows: FRONT, x: left, y: 1, overWater: true }, { rows: FRONT, x: right, y: 1, overWater: true }, ...near.sprites!],
  };
  return { width, stop, near, left, right, gathered, sideAt: (x: number): Scene => ({ width, sprites: [{ rows: SIDE, x }], water: wake(x) }) };
}
type Sea = ReturnType<typeof sea>;

/** The lead ship's x in a scene, so the next timeline can pick up where this one is. It is drawn last, on top. */
export function leadX(scene: Scene | undefined): number {
  return scene?.sprites?.at(-1)?.x ?? -6;
}

/** Side-on from x to `to`, going round once more if x is already past it. */
function sailTo(s: Sea, x: number, to = s.stop): Scene[] {
  const scenes: Scene[] = [];
  if (x > to) {
    for (let at = x; at < s.width; at++) scenes.push(s.sideAt(at));
    x = -6;
  }
  for (let at = x; at <= to; at++) scenes.push(s.sideAt(at));
  return scenes;
}

/** Working: one ship, or a manager's lead ship with smaller ones for the sessions it runs. */
export function sailing(fromX: number, followers = 0, width = WIDTH): Timeline {
  // Close enough that a fleet of three fits the status line's strip.
  const behind = [7, 12].slice(0, Math.min(followers, 2));
  const span = 6 + (behind.at(-1) ?? 0);
  const scenes: Scene[] = [];
  for (let x = -6; x < width + span - 6; x++) {
    const water: Record<number, string> = {};
    for (const d of behind) water[x - d - 1] = '-';
    scenes.push({
      width,
      sprites: [...behind.map((d) => ({ rows: SMALL, x: x - d })), { rows: SIDE, x }],
      water: { ...water, ...wake(x) },
    });
  }
  const start = Math.max(0, Math.min(scenes.length - 1, fromX + 6));
  return { scenes: [...scenes.slice(start), ...scenes.slice(0, start)], loopFrom: 0 };
}

/**
 * What is around a stopped ship: nothing; work still going on behind it (background tasks, or sessions it
 * started that are working); or, for a manager whose sessions have all finished, its fleet gathered beside it.
 */
export type Behind = 'none' | 'busy' | 'fleet';

/** Waiting or idle: sail to the middle, turn the bow toward the viewer, come a little closer and stop. */
export function turnAndStop(fromX: number, behind: Behind, width = WIDTH): Timeline {
  const s = sea(width);
  const X = s.stop;
  const scenes = [
    ...sailTo(s, fromX),
    ...hold(3, { width, sprites: [{ rows: QUARTER, x: X }] }),
    ...hold(3, { width, sprites: [{ rows: FRONT, x: X }] }),
    ...hold(4, { width, sprites: [{ rows: FRONT, x: X }], water: { [X + 1]: '(', [X + 5]: ')' } }),
    ...hold(4, { ...s.near, water: { [X]: '(', [X + 7]: ')' } }),
  ];
  if (behind === 'fleet') return gathering(s, scenes);
  const loopFrom = scenes.length;
  scenes.push(...stopped(s, behind));
  return { scenes, loopFrom };
}

/** The fleet gathers: after `before`, the boats behind come up on each side of the stopped ship and turn to face the viewer. */
function gathering(s: Sea, before: Scene[] = []): Timeline {
  const scenes = [...before];
  const near = s.near.sprites!;
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const lx = -4 + Math.round(((s.left + 4) * i) / steps);
    const rx = s.width + Math.round(((s.right + 1 - s.width) * i) / steps);
    scenes.push({ width: s.width, sprites: [{ rows: SMALL, x: lx }, { rows: SMALL_LEFTWARD, x: rx }, ...near], water: { [lx - 1]: '-', [rx + 4]: '-' } });
  }
  scenes.push(...hold(3, { width: s.width, sprites: [s.gathered.sprites![0]!, { rows: SMALL_LEFTWARD, x: s.right + 1 }, ...near] }));
  const loopFrom = scenes.length;
  scenes.push(s.gathered);
  return { scenes, loopFrom };
}

/** The stopped pose; with work still going on, a small boat keeps sailing behind it. */
function stopped(s: Sea, behind: Behind): Scene[] {
  if (behind === 'fleet') return [s.gathered];
  if (behind === 'none') return [s.near];
  const scenes: Scene[] = [];
  // The small boat comes first, so the stopped boat is drawn over it where they overlap.
  for (let x = -5; x < s.width + 2; x++) scenes.push({ width: s.width, sprites: [{ rows: SMALL, x }, ...s.near.sprites!], water: { [x - 1]: '-' } });
  return scenes;
}

/** Already stopped (a session opened while waiting or idle): no turn, straight to the pose. */
export function standing(behind: Behind, width = WIDTH): Timeline {
  return { scenes: stopped(sea(width), behind), loopFrom: 0 };
}

/** A stopped ship's fleet finishes its work while it waits: the boats come up beside it. */
export function gather(width = WIDTH): Timeline {
  return gathering(sea(width));
}

/** Work starts again from the gathered fleet: all three turn side-on and sail off together, then sail on as usual. */
export function depart(followers = 0, width = WIDTH): Timeline {
  const s = sea(width);
  const X = s.stop;
  const left = s.left - 1;
  const right = s.right + 3;
  const beside = (d: number) => [{ rows: SMALL, x: left + d }, { rows: SMALL, x: right + d }];
  const scenes = [
    ...hold(3, { width, sprites: [s.gathered.sprites![0]!, s.gathered.sprites![1]!, { rows: FRONT, x: X }], water: { [X + 2]: '.', [X + 4]: '.' } }),
    ...hold(3, { width, sprites: [...beside(0), { rows: QUARTER, x: X }] }),
    ...hold(2, { width, sprites: [...beside(0), { rows: SIDE, x: X }] }),
  ];
  for (let d = 1; left + d < width; d++) {
    scenes.push({ width, sprites: [...beside(d), { rows: SIDE, x: X + d }], water: { [left + d - 1]: '-', [right + d - 1]: '-', ...wake(X + d) } });
  }
  const loopFrom = scenes.length;
  scenes.push(...sailing(-6, followers, width).scenes);
  return { scenes, loopFrom };
}

/**
 * A manager's last session ends while it is stopped: the gathered fleet sails off together, then the manager's
 * ship comes back on its own, turns to face the viewer and stops.
 */
export function fleetLeaves(width = WIDTH): Timeline {
  const away = depart(0, width);
  const back = turnAndStop(-6, 'none', width);
  return { scenes: [...away.scenes.slice(0, away.loopFrom), ...back.scenes], loopFrom: away.loopFrom + back.loopFrom };
}

/** Work starts again: back off, turn side-on and sail on. */
export function startAgain(followers = 0, width = WIDTH): Timeline {
  const X = sea(width).stop;
  const scenes = [
    ...hold(3, { width, sprites: [{ rows: FRONT, x: X }], water: { [X + 2]: '.', [X + 4]: '.' } }),
    ...hold(3, { width, sprites: [{ rows: QUARTER, x: X }] }),
    ...hold(2, { width, sprites: [{ rows: SIDE, x: X }] }),
  ];
  const loopFrom = scenes.length;
  scenes.push(...sailing(X + 1, followers, width).scenes);
  return { scenes, loopFrom };
}

/** A session that ended with an error: the ship lists, takes on water and goes under. Then calm sea. */
export function sinking(fromX: number, width = WIDTH): Timeline {
  const s = sea(width);
  const X = s.stop + 1;
  const at = (scene: Partial<Scene>): Scene => ({ width, ...scene });
  const scenes = [
    ...sailTo(s, fromX, X),
    ...hold(3, at({ sprites: [{ rows: SIDE, x: X, shear: [1, 0, 0] }] })),
    ...hold(3, at({ sprites: [{ rows: SIDE, x: X, shear: [2, 1, 0] }], marks: [{ x: X - 1, y: 2, ch: '~' }, { x: X + 6, y: 2, ch: '~' }] })),
    ...hold(3, at({ sprites: [{ rows: SIDE, x: X, y: 1, shear: [2, 1, 0] }], water: { [X]: '*', [X + 6]: '*' } })),
    ...hold(3, at({ sprites: [{ rows: SIDE, x: X, y: 2, shear: [2, 1, 0] }], water: { [X + 2]: 'o' } })),
    ...hold(2, at({ marks: [{ x: X + 3, y: 2, ch: 'o' }], water: { [X + 3]: '.' } })),
    ...hold(2, at({ marks: [{ x: X + 3, y: 1, ch: 'o' }, { x: X + 2, y: 2, ch: '.' }] })),
    ...hold(2, at({ marks: [{ x: X + 3, y: 0, ch: '.' }, { x: X + 2, y: 1, ch: 'o' }] })),
    ...hold(2, at({ marks: [{ x: X + 2, y: 0, ch: '.' }] })),
  ];
  const loopFrom = scenes.length;
  scenes.push(at({}));
  return { scenes, loopFrom };
}

/** Nothing on the water: what a sunk ship leaves, shown when a crashed session is opened later. */
export function calmSea(width = WIDTH): Timeline {
  return { scenes: [{ width }], loopFrom: 0 };
}

// --- Context clear. A session's context is about to be cleared (a warning that can be cancelled), then is
// cleared and goes on from a handoff. Picked by Martin: the change of watch (2026-10-12), shown for
// clear_session's countdown (SailingShip).

/** The clear is coming: a small boat, the next crew with the handoff, comes up beside the stopped ship and waits, lantern blinking. */
export function watchArrives(width = WIDTH): Timeline {
  const s = sea(width);
  // On a narrow strip there is no room beside the ship, so it waits half hidden behind it.
  const L = Math.max(s.left, 0);
  const scenes: Scene[] = [];
  for (let x = -4; x <= L; x++) scenes.push({ width, sprites: [{ rows: SMALL, x }, ...s.near.sprites!], water: { [x - 1]: '-' } });
  const loopFrom = scenes.length;
  const waiting = (lit: boolean): Scene => ({ width, sprites: [{ rows: SMALL, x: L }, ...s.near.sprites!], marks: lit ? [{ x: L + 1, y: 0, ch: '.' }] : [] });
  scenes.push(...hold(3, waiting(true)), ...hold(3, waiting(false)));
  return { scenes, loopFrom };
}

/** The clear happens: the old ship turns and sails off, the small boat moves into its place and comes forward. */
export function watchChanges(width = WIDTH): Timeline {
  const s = sea(width);
  const X = s.stop;
  const L = Math.max(s.left, 0);
  const small: Sprite = { rows: SMALL, x: L };
  const scenes: Scene[] = [
    ...hold(3, { width, sprites: [small, { rows: FRONT, x: X }], water: { [X + 2]: '.', [X + 4]: '.' } }),
    ...hold(3, { width, sprites: [small, { rows: QUARTER, x: X }] }),
    ...hold(2, { width, sprites: [small, { rows: SIDE, x: X }] }),
  ];
  for (let x = X + 1; x < width; x++) scenes.push({ width, sprites: [small, { rows: SIDE, x }], water: wake(x) });
  for (let x = L + 1; x <= X + 1; x++) scenes.push({ width, sprites: [{ rows: SMALL, x }], water: { [x - 1]: '-' } });
  scenes.push(
    ...hold(3, { width, sprites: [{ rows: FRONT, x: X }] }),
    ...hold(4, { width, sprites: [{ rows: FRONT, x: X }], water: { [X + 1]: '(', [X + 5]: ')' } }),
  );
  const loopFrom = scenes.length;
  scenes.push(s.near);
  return { scenes, loopFrom };
}

/** The clear is cancelled: the small boat sails on, passing behind the ship, which stays. */
export function watchStandsDown(width = WIDTH): Timeline {
  const s = sea(width);
  const scenes: Scene[] = [];
  for (let x = Math.max(s.left, 0) + 1; x < width; x++) scenes.push({ width, sprites: [{ rows: SMALL, x }, ...s.near.sprites!], water: { [x - 1]: '-' } });
  const loopFrom = scenes.length;
  scenes.push(s.near);
  return { scenes, loopFrom };
}

// --- Spare animations: previewed with the change of watch and kept, with no use yet. Each is a warning
// (looping, or for the fog stretched over `frames`, 30 s by default) and what follows it, ending on a
// fresh ship that has sailed in and stopped.

/** 30 seconds of frames at the status line's 180 ms step. */
const WARNING_FRAMES = 166;
const freshShip = (width: number): Scene[] => turnAndStop(-6, 'none', width).scenes;
const repaint = (rows: string[], ch: (r: number, i: number) => string) => rows.map((line, r) => [...line].map((c, i) => (c === ' ' ? ' ' : ch(r, i))).join(''));

/** Radiate, warning: rings pulse out from the stopped ship and the mast top flickers. */
export function radiating(width = WIDTH): Timeline {
  const s = sea(width);
  const L = s.stop + 1;
  const R = s.stop + 6;
  const ring = (d: number, open = '(', close = ')') => [1, 2].flatMap((y) => [{ x: L - d, y, ch: open }, { x: R + d, y, ch: close }]);
  const at = (marks: Scene['marks']): Scene => ({ ...s.near, marks });
  return {
    scenes: [
      ...hold(2, at([...ring(1), { x: s.stop + 3, y: 0, ch: '*' }])),
      ...hold(2, at(ring(2))),
      ...hold(2, at(ring(3))),
      ...hold(2, at(ring(4, '.', '.'))),
      ...hold(4, s.near),
    ],
    loopFrom: 0,
  };
}

/** Radiate, then: the ship flashes to stars, breaks up into dots and is gone; a fresh ship sails in. */
export function burstAndReplace(width = WIDTH): Timeline {
  const s = sea(width);
  const ship = (ch: (r: number, i: number) => string): Scene => ({ width, sprites: [{ ...s.near.sprites![0]!, rows: repaint(FRONT_NEAR, ch) }] });
  const scenes = [
    ...hold(2, ship(() => '*')),
    ...hold(2, ship((r, i) => ((r + i) % 2 ? '*' : '.'))),
    ...hold(2, ship((r, i) => ((r + i) % 2 ? '.' : ' '))),
    ...hold(2, ship((r, i) => ((r + i) % 3 ? ' ' : '.'))),
    ...hold(4, { width }),
  ];
  const fresh = freshShip(width);
  return { scenes: [...scenes, ...fresh], loopFrom: scenes.length + fresh.length - 1 };
}

/** Sink and replace, warning: the stopped ship rocks with spray at its sides, settling lower over `frames`. */
export function rocking(width = WIDTH, frames = WARNING_FRAMES): Timeline {
  const s = sea(width);
  const X = s.stop;
  const tilt = [[1, 1, 0, 0], [0, 0, 0, 0], [-1, -1, 0, 0], [0, 0, 0, 0]];
  const scenes: Scene[] = [];
  for (let i = 0; i < frames; i++) {
    const k = Math.floor(i / 3) % tilt.length;
    const y = i < (frames * 2) / 3 ? 0 : 1;
    scenes.push({ width, sprites: [{ ...s.near.sprites![0]!, y, shear: tilt[k] }], water: k % 2 ? {} : { [X]: '^', [X + 7]: '^' } });
  }
  return { scenes, loopFrom: scenes.length - 12 };
}

/** Sink and replace, then: the low-lying ship goes down, bubbles rise, and a fresh ship sails in. */
export function founderAndReplace(width = WIDTH): Timeline {
  const s = sea(width);
  const X = s.stop;
  const near = s.near.sprites![0]!;
  const scenes: Scene[] = [
    ...hold(3, { width, sprites: [{ ...near, y: 1, shear: [1, 1, 0, 0] }], water: { [X + 1]: 'o', [X + 6]: 'o' } }),
    ...hold(3, { width, sprites: [{ ...near, y: 2, shear: [1, 0, 0, 0], overWater: false }], water: { [X + 2]: '*', [X + 5]: '*' } }),
    ...hold(2, { width, marks: [{ x: X + 3, y: 2, ch: 'o' }], water: { [X + 3]: '.' } }),
    ...hold(2, { width, marks: [{ x: X + 3, y: 1, ch: 'o' }, { x: X + 2, y: 2, ch: '.' }] }),
    ...hold(2, { width, marks: [{ x: X + 3, y: 0, ch: '.' }] }),
    ...hold(4, { width }),
  ];
  const fresh = freshShip(width);
  return { scenes: [...scenes, ...fresh], loopFrom: scenes.length + fresh.length - 1 };
}

const THIN_FOG = ".  :  ' .   :.  '  . ";
const THICK_FOG = ":.:':.::'.:.':.::'.:.";
function fog(width: number, from: number, to: number, pattern: string, k: number): { x: number; y: number; ch: string }[] {
  const marks = [];
  for (let y = 0; y < ROWS - 1; y++) {
    for (let x = Math.max(0, from); x < Math.min(width, to); x++) {
      const ch = pattern[(x * 3 + y * 7 + k) % pattern.length]!;
      if (ch !== ' ') marks.push({ x, y, ch });
    }
  }
  return marks;
}

/** Fog bank, warning: thin fog rolls in from the left over `frames`, so it doubles as a countdown. */
export function fogRollsIn(width = WIDTH, frames = WARNING_FRAMES): Timeline {
  const s = sea(width);
  const scenes: Scene[] = [];
  for (let i = 0; i < frames; i++) scenes.push({ ...s.near, marks: fog(width, 0, Math.round(((i + 1) / frames) * width), THIN_FOG, i) });
  return { scenes, loopFrom: scenes.length - 1 };
}

/** Fog bank, then: the fog thickens over the ship, lifts on empty sea, and a fresh ship sails in. */
export function fogLifts(width = WIDTH): Timeline {
  const s = sea(width);
  const scenes: Scene[] = [];
  for (let k = 0; k < 6; k++) scenes.push({ ...s.near, marks: fog(width, 0, width, THICK_FOG, k) });
  for (let k = 0; k < 6; k++) scenes.push({ width, marks: fog(width, 0, width, THICK_FOG, k) });
  for (let k = 0; k <= width; k += 2) scenes.push({ width, marks: fog(width, k, width, k < width / 2 ? THICK_FOG : THIN_FOG, k) });
  scenes.push(...hold(3, { width }));
  const fresh = freshShip(width);
  return { scenes: [...scenes, ...fresh], loopFrom: scenes.length + fresh.length - 1 };
}

// --- The ship as a bar, for the plan's usage limits: its place on the strip is the value, and from 90% it
// breaks down, one stage every 2%. Picked by Martin from the previews (2026-10-12).

/** Strip widths the bar comes in; it takes the widest that fits. */
export const BAR_WIDTHS = [50, 33, 25, 20, 10];

/** The ship by damage stage: whole below 90%, then 90, 92, 94, 96, 98 and, at 100%, a wreck. */
const BROKEN_SHIP = [
  SIDE,
  ['  |\\  ', '  |.\\ ', '\\____/'], // a hole in the sail
  ['  |\\  ', '  | \\ ', '\\_.__/'], // the sail tears, the hull cracks
  ['  |   ', '  |\\  ', '\\_.__/'], // the sail hangs loose
  ['  /   ', '  |\\  ', '\\_. _/'], // the mast cracks, a plank is gone
  ['  ,   ', ' /|   ', '\\_. ./'], // mast broken, sail gone, hull holed
  ['      ', '   ,  ', '\\_.  /'], // a wreck, low in the water
];
/** The same stages for the small boat of a fleet. */
const BROKEN_BOAT = [
  SMALL,
  ['', ' |\\ ', '\\_./'], // the hull cracks
  ['', ' |. ', '\\_./'], // the sail tears
  ['', ' |  ', '\\_./'], // the sail is gone
  ['', ' /  ', '\\_./'], // the mast leans
  ['', ' ,  ', '\\. /'], // mast broken, hull holed
  ['', '    ', ' ._,'], // a wreck: only wreckage on the water
];
export const WRECK = BROKEN_SHIP.length - 1;
/** Which hull draws the bar: the ship, or the smaller boat of a fleet. */
export type Hull = 'ship' | 'boat';
const HULLS: Record<Hull, { stages: string[][]; length: number }> = { ship: { stages: BROKEN_SHIP, length: 6 }, boat: { stages: BROKEN_BOAT, length: 4 } };
/** Facing the other way: each row reversed, slants swapped. */
const mirror = (rows: string[], length: number) => rows.map((r) => [...r.padEnd(length)].reverse().map((c) => (c === '/' ? '\\' : c === '\\' ? '/' : c)).join(''));
const LEFTWARD: Record<Hull, string[][]> = { ship: BROKEN_SHIP.map((r) => mirror(r, 6)), boat: BROKEN_BOAT.map((r) => mirror(r, 4)) };

const ROUND_STEPS = [1, 2, 5, 10, 20, 25];
/** Below 90%: the smallest round step that is at least half a column, so a wider strip updates more often. */
export const barStepFor = (width: number, hull: Hull = 'ship') => ROUND_STEPS.find((n) => n >= 50 / (width - HULLS[hull].length)) ?? 25;

/** The percentage the bar shows for a value (0–100): rounded down to the strip's step below 90, to 2 from 90. */
export function barValue(percent: number, width: number, hull: Hull = 'ship'): number {
  const v = Math.max(0, Math.min(100, percent));
  if (v >= 100) return 100;
  if (v >= 90) return 90 + Math.floor((v - 90) / 2) * 2;
  const step = barStepFor(width, hull);
  return Math.floor(v / step) * step;
}

/** 0 below 90%; 1–5 from 90 to 98; WRECK at 100. */
export const damageStage = (shown: number) => (shown < 90 ? 0 : Math.min(WRECK, Math.floor((shown - 90) / 2) + 1));
/** The hull's x for a shown value: 0% at the left edge, 100% with its bow at the right. */
export const barX = (shown: number, width: number, hull: Hull = 'ship') => Math.round((shown / 100) * (width - HULLS[hull].length));

const debris = (stage: number, x: number): Record<number, string> => ({
  ...(stage >= 3 ? { [x - 3]: '.', [x - 5]: ',' } : {}),
  ...(stage >= 5 ? { [x - 7]: '.' } : {}),
  ...(stage >= WRECK ? { [x + 1]: 'o', [x + 5]: 'o', [x - 9]: ',' } : {}),
});
const filled = (to: number): Record<number, string> => Object.fromEntries(Array.from({ length: Math.max(0, to) }, (_, i) => [i, '_']));

/** Seven-segment digits, three rows tall, so the number stands as high as the ship. */
const DIGITS: Record<string, string[]> = {
  0: [' _ ', '| |', '|_|'], 1: [' ', '|', '|'], 2: [' _ ', ' _|', '|_ '], 3: [' _ ', ' _|', ' _|'], 4: ['   ', '|_|', '  |'],
  5: [' _ ', '|_ ', ' _|'], 6: [' _ ', '|_ ', '|_|'], 7: [' _ ', '  |', '  |'], 8: [' _ ', '|_|', '|_|'], 9: [' _ ', '|_|', ' _|'],
  '%': ['   ', 'o/ ', '/o '],
};
const bigText = (text: string) => [0, 1, 2].map((r) => [...text].map((c) => DIGITS[c]?.[r] ?? '').join(' '));

export type Mark = { x: number; y: number; ch: string };

/**
 * One frame of the bar: the ship at x, calm filled water behind it. The number goes top left: in big digits
 * when the ship has left room for them, small until then, not at all before that. The marks are the number's cells.
 */
export function barScene(width: number, stage: number, x: number, label: string, hull: Hull = 'ship'): { scene: Scene; number: Mark[] } {
  const big = bigText(label);
  // Room is judged by the widest number that could come next ("00%", or "100%"), not this one: digits differ
  // in width, and a big number that showed at 41% must not drop back to the small one at 42%.
  const widest = label === '100%' ? '100%' : '00%';
  let number: Mark[] = [];
  if (bigText(widest)[0]!.length + 1 <= x) big.forEach((row, y) => [...row].forEach((ch, i) => { if (ch !== ' ') number.push({ x: i, y, ch }); }));
  else if (widest.length <= x) number = [...label].map((ch, i) => ({ x: i, y: 0, ch }));
  const sprite: Sprite = { rows: HULLS[hull].stages[stage]!, x, shear: stage === 4 && hull === 'ship' ? [1, 0, 0] : [] };
  return { scene: { width, sprites: [sprite], water: { ...filled(x), ...(stage >= WRECK ? {} : wake(x)), ...debris(stage, x) }, marks: number }, number };
}

/** A reset (a new window): the ship as it is turns round and sails off left, taking the filled water with it. */
export function barLeaving(width: number, stage: number, x: number, hull: Hull = 'ship'): Scene {
  const n = HULLS[hull].length;
  const trail = { ...(stage >= WRECK ? {} : { [x + n]: '=', [x + n + 1]: '=' }), ...(stage >= 3 ? { [x + n + 2]: '.', [x + n + 4]: ',' } : {}) };
  return { width, sprites: [{ rows: LEFTWARD[hull][stage]!, x, shear: stage === 4 && hull === 'ship' ? [-1, 0, 0] : [] }], water: { ...filled(x), ...trail } };
}

/** Then a fresh ship sails in from the left edge to 0%. */
export function barArriving(width: number, x: number, hull: Hull = 'ship'): Scene {
  return { width, sprites: [{ rows: HULLS[hull].stages[0]!, x }], water: hull === 'ship' ? wake(x) : { [x - 1]: '-' } };
}

// --- The ship as the Compact sidebar slider's handle (issue #155): it sails along a strip of water to the
// step chosen, a buoy marking each step. Martin, 2026-10-16 15:38: "Can we make the slider be a boat?"

/** The slider's strip in columns: drawn at 5px (Martin, 16:51: "make it smaller though. try size 5"), this many keep it wide enough for the four step labels under it. */
export const SLIDER_WIDTH = 96;
/** The ship's width, which is also the range input's thumb width, so the ship sits where the thumb is. */
export const SLIDER_SHIP = 6;

/** The ship's x at a step of `count`: the first at the left edge, the last with its bow at the right, as a range thumb moves. */
export const sliderX = (step: number, count: number, width = SLIDER_WIDTH) => Math.round(((step - 1) / (count - 1)) * (width - SLIDER_SHIP));
/** The column of a step's buoy: under the middle of the hull when the ship is there. */
export const buoyX = (step: number, count: number, width = SLIDER_WIDTH) => sliderX(step, count, width) + SLIDER_SHIP / 2 - 1;

/** One frame: the ship at x facing its way, a buoy at each of `count` steps, and a wake behind it while it sails. */
export function sliderScene(x: number, count: number, facing: 'right' | 'left', sailing: boolean, width = SLIDER_WIDTH): Scene {
  const water: Record<number, string> = sailing ? (facing === 'right' ? wake(x) : { [x + SLIDER_SHIP]: '=', [x + SLIDER_SHIP + 1]: '=' }) : {};
  // The buoys go on last: a step mark stays visible under the ship and its wake.
  for (let s = 1; s <= count; s++) water[buoyX(s, count, width)] = 'o';
  return { width, sprites: [{ rows: facing === 'right' ? SIDE : LEFTWARD.ship[0]!, x }], water };
}
