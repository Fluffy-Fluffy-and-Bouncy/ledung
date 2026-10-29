// The divider after a compact, shared by the page and the tests.

/** "Compacted: 70k → 2.4k in 16 s." from the boundary's figures (clear-and-compact plan); "Compacted." without them. */
export function compactedLabel(meta: { pre_tokens?: number; post_tokens?: number; duration_ms?: number } | undefined): string {
  const k = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : `${(n / 1000).toFixed(1)}k`);
  if (typeof meta?.pre_tokens !== 'number' || typeof meta.post_tokens !== 'number') return 'Compacted.';
  const secs = typeof meta.duration_ms === 'number' ? ` in ${Math.round(meta.duration_ms / 1000)} s` : '';
  return `Compacted: ${k(meta.pre_tokens)} → ${k(meta.post_tokens)}${secs}.`;
}
