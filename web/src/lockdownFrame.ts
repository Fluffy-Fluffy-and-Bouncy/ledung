// A locked project's ASCII "vault" border (issue #129, Vault 1 of the lockdown mockups; Martin, 2026-10-16
// 11:21: "I like Valut 1 the best, it's clear and not overly done"), still, no animation. Level A (nobody
// reaches in, it can reach out): a single riveted frame with a deposit slot » on the right, out only. Level B
// (almost air-gapped): a heavy double frame, rivets on the outer one, the lock in red. Pure, so a test can draw it.

export type LockLevel = 'off' | 'A' | 'B';

/** Colour classes of the border's cells: '' the frame's own colour, 'a' accent, 'd' danger. */
export type CellKind = '' | 'a' | 'd';

/** What each level means, for the chip in a locked project's chat header (the settings' own words). */
export const LOCK_HINT: Record<'A' | 'B', string> = {
  A: 'Lockdown level A: nothing reaches in; it may still reach out',
  B: 'Lockdown level B, nearly air-gapped: nothing reaches in or out',
};

/** The frame's thickness in cells on every side. */
export function frameThickness(level: 'A' | 'B'): number {
  return level === 'A' ? 1 : 2;
}

/** The level a project's frame is drawn at; a removed project (null) or one with no lockdown has none. */
export function frameLevel(project: { lockdown?: { level: LockLevel } | null } | null | undefined): 'A' | 'B' | null {
  const l = project?.lockdown?.level;
  return l === 'A' || l === 'B' ? l : null;
}

/** The border as rows of cells, `cols` wide and `rows` tall; spaces inside, where the framed piece shows through. */
export function vaultBorder(level: 'A' | 'B', cols: number, rows: number): { ch: string[][]; kind: CellKind[][] } {
  const ch = Array.from({ length: rows }, () => Array<string>(cols).fill(' '));
  const kind = Array.from({ length: rows }, () => Array<CellKind>(cols).fill(''));
  const put = (x: number, y: number, c: string, k: CellKind = '') => {
    if (x >= 0 && y >= 0 && x < cols && y < rows) { ch[y]![x] = c; kind[y]![x] = k; }
  };
  const text = (x: number, y: number, s: string, k: CellKind = '') => [...s].forEach((c, i) => put(x + i, y, c, k));
  // s: horizontal, vertical, then the corners top-left, top-right, bottom-left, bottom-right.
  const box = (i: number, s: string, rivets: boolean) => {
    const x0 = i, y0 = i, x1 = cols - 1 - i, y1 = rows - 1 - i;
    for (let x = x0; x <= x1; x++) {
      const r = rivets && (x - x0) % 6 === 3;
      put(x, y0, r ? 'o' : s[0]!);
      put(x, y1, r ? 'o' : s[0]!);
    }
    for (let y = y0; y <= y1; y++) {
      const r = rivets && (y - y0) % 3 === 2 && y < y1 - 1;
      put(x0, y, r ? 'o' : s[1]!);
      put(x1, y, r ? 'o' : s[1]!);
    }
    put(x0, y0, s[2]!); put(x1, y0, s[3]!); put(x0, y1, s[4]!); put(x1, y1, s[5]!);
  };
  const b = level === 'B';
  if (b) {
    box(0, '━┃┏┓┗┛', true);
    box(1, '─│┌┐└┘', false);
  } else {
    box(0, '─│┌┐└┘', true);
  }
  text(3, 0, `┤ LOCK ${level} ├`, b ? 'd' : 'a');
  // The dial, top right.
  text(cols - 7, 0, '(|)', b ? 'd' : '');
  if (!b) put(cols - 1, Math.floor(rows / 2), '»', 'a');
  return { ch, kind };
}

/** The border's rows as runs of one colour each, for drawing as spans in a <pre>. */
export function borderRuns(border: { ch: string[][]; kind: CellKind[][] }): { text: string; kind: CellKind }[][] {
  return border.ch.map((row, y) => {
    const runs: { text: string; kind: CellKind }[] = [];
    row.forEach((c, x) => {
      const k = border.kind[y]![x]!;
      const last = runs[runs.length - 1];
      if (last && last.kind === k) last.text += c;
      else runs.push({ text: c, kind: k });
    });
    return runs;
  });
}
