// The monthly cap field in Settings → Relay → Owners (issue #161): the relay keeps caps in bytes, the page shows and
// takes GB, 1 GB = 1024³ bytes. Kept apart from the component so the conversion is tested (test review of PR #173).

export const GB = 1024 ** 3;

/** A cap in bytes as the field shows it: whole GB from 100 up, three significant figures below, so a small cap doesn't read as 0. */
export function capGbText(cap: number | null): string {
  if (cap === null) return '';
  const gb = cap / GB;
  return String(gb >= 100 ? Math.round(gb) : Number(gb.toPrecision(3)));
}

/** What was typed, as a cap in bytes; null when it isn't a number above 0. */
export function capFromGb(text: string): number | null {
  if (text.trim() === '') return null;
  const gb = Number(text);
  return Number.isFinite(gb) && gb > 0 ? Math.round(gb * GB) : null;
}
