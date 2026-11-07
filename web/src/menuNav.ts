// Arrow keys in a small pop-up menu (issue #186: the macros' ＋ menu, Martin 2026-11-07 in Ledung question #671).
// Kept apart from the component so the rule can be tested without a page.

/**
 * Where the focus goes from item `from` on `key`, skipping disabled items: Down and Up move one and wrap around,
 * Home and End go to the first and last. `from` -1 (nothing focused yet) lands Down/Home on the first, Up/End on
 * the last. null: not a moving key, or nothing in the menu can be picked.
 */
export function menuStep(enabled: readonly boolean[], from: number, key: string): number | null {
  const n = enabled.length;
  if (!enabled.some(Boolean)) return null;
  const scan = (start: number, dir: 1 | -1): number => {
    for (let k = 0, i = start; k < n; k++, i = (i + dir + n) % n) if (enabled[i]) return i;
    return -1;
  };
  switch (key) {
    case 'ArrowDown': return scan(from < 0 ? 0 : (from + 1) % n, 1);
    case 'ArrowUp': return scan(from < 0 ? n - 1 : (from - 1 + n) % n, -1);
    case 'Home': return scan(0, 1);
    case 'End': return scan(n - 1, -1);
    default: return null;
  }
}
