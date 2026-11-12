// The Machine panel's resource limits (docs/steps/resource-limits.md), kept apart from the component for tests:
// where a limit's line sits on its bar, and the number typed for it. CPU and GPU limits are % (1–100), memory in GB.

const GB = 1024 ** 3;
const isMemory = (dim: string) => dim === 'ram' || dim.startsWith('vram:');

/** The limit as a share of its bar (0–1): % of 100 for CPU and GPU, bytes of the total for memory. Null: no limit. */
export function limitShare(limit: number | undefined, dim: string, total: number): number | null {
  if (limit === undefined) return null;
  if (!isMemory(dim)) return Math.min(1, Math.max(0, limit / 100));
  return total > 0 ? Math.min(1, Math.max(0, limit / total)) : null;
}

/** The limit as it is typed: "50" (%), "48" or "12.5" (GB). */
export function limitText(dim: string, limit: number): string {
  if (!isMemory(dim)) return String(Math.round(limit));
  const gb = limit / GB;
  return String(Math.round(gb * 10) / 10);
}

/** The typed number as the API takes it (% or GB); undefined when it can't be a limit. "No limit" is its own button. */
export function parseLimitInput(dim: string, text: string): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n)) return undefined;
  if (isMemory(dim)) return n > 0 && n <= 65536 ? n : undefined;
  return n >= 1 && n <= 100 ? Math.round(n) : undefined;
}
