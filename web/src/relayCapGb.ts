// The monthly cap field in Settings → Relay → Owners (issue #161): the relay keeps caps in bytes, the page shows and
// takes GB, 1 GB = 1024³ bytes. Kept apart from the component so the conversion is tested (test review of PR #173).

export const GB = 1024 ** 3;
/** The largest cap the relay takes, 10¹⁵ bytes (about 931 322 GB); above it Set cap stays off rather than being refused. */
export const MAX_CAP_BYTES = 1e15;

/** A cap in bytes as the field shows it: whole GB from 100 up, three significant figures below, so a small cap doesn't read as 0. */
export function capGbText(cap: number | null): string {
  if (cap === null) return '';
  const gb = cap / GB;
  return String(gb >= 100 ? Math.round(gb) : Number(gb.toPrecision(3)));
}

/** What was typed, as a cap in bytes; null when it isn't at least one byte or is over the relay's ceiling, so Set cap stays off. */
export function capFromGb(text: string): number | null {
  if (text.trim() === '') return null;
  const gb = Number(text);
  if (!Number.isFinite(gb) || gb <= 0) return null;
  const bytes = Math.round(gb * GB);
  return bytes >= 1 && bytes <= MAX_CAP_BYTES ? bytes : null;
}
