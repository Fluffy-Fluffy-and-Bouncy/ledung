// How the line under a usage meter fits a narrow sidebar (issue #284). Pure, so the order is tested without a browser.

/** The line's words from longest to shortest: the head ("22% · 76% to stop") joined to each reset variant. */
export function meterLineVariants(head: string | null, resets: string[]): string[] {
  if (!resets.length) return head ? [head] : [];
  return resets.map((r) => (head ? `${head} · ${r}` : r));
}

/**
 * Which variant to show and where the forecast goes, from the measured widths (px). The longest variant that fits
 * beside the forecast keeps the forecast on the line (Martin: "should be on the same line ... if possible"); when
 * none does, the forecast moves up beside the ship's water line and the longest variant that fits alone is shown;
 * when none fits even then, the shortest, which wraps only between its parts.
 */
export function meterLineLayout(o: { widths: number[]; forecast: number; room: number; gap: number; besideShip: boolean }): { variant: number; forecastInline: boolean } {
  if (!o.widths.length) return { variant: -1, forecastInline: true };
  const beside = o.forecast > 0 ? o.forecast + o.gap : 0;
  const inline = o.widths.findIndex((w) => w + beside <= o.room);
  if (inline >= 0) return { variant: inline, forecastInline: true };
  // The ship can't make room for it (its strip would lose its figure): it stays on the line, which wraps between parts.
  if (o.forecast > 0 && !o.besideShip) return { variant: o.widths.length - 1, forecastInline: true };
  const alone = o.widths.findIndex((w) => w <= o.room);
  return { variant: alone >= 0 ? alone : o.widths.length - 1, forecastInline: o.forecast === 0 };
}

/**
 * The ship strip's width in columns: the widest that fits the box, as before; with `room` px wanted beside it for the
 * forecast, the widest that also leaves that room, but only one that still shows the ship's figure when the full width
 * does (a narrower strip can lose it: #284, the 220 px shot). `roomMade` false: the forecast must go elsewhere.
 */
export function stripWidth(o: { widths: number[]; charPx: number; boxPx: number; roomPx: number; figureAt: (cols: number) => boolean }): { cols: number; roomMade: boolean } {
  const full = o.widths.find((w) => w * o.charPx <= o.boxPx) ?? o.widths.at(-1)!;
  if (o.roomPx <= 0) return { cols: full, roomMade: true };
  const needFigure = o.figureAt(full);
  const cols = o.widths.find((w) => w * o.charPx + o.roomPx <= o.boxPx && (!needFigure || o.figureAt(w)));
  return cols === undefined ? { cols: full, roomMade: false } : { cols, roomMade: true };
}
