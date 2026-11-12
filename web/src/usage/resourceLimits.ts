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

/** How long a job has been over: seconds under a minute (acceptance test, finding 14), then minutes. */
export function overFor(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  return sec < 60 ? `${sec} s` : `${Math.round(sec / 60)} min`;
}

// Dragging a bar's limit line (issue #295): values are in the API's unit (% or GB), snapped to a step; the far right
// end of a bar is "no limit" (null), so the line can be dragged off.

/** One step of a drag or an arrow key: 5 % for CPU and GPU load, 1 GB for memory and GPU memory (point 2). */
export function dragStep(dim: string): number {
  return isMemory(dim) ? 1 : 5;
}

/** The far end of the bar in the API's unit: 100 %, or the total in whole GB. Reaching it means no limit. */
export function dragMax(dim: string, total: number): number {
  return isMemory(dim) ? Math.max(1, Math.floor(total / GB)) : 100;
}

/** A limit in bytes or % (as the page gets it) in the API's unit; null: none. */
export function limitUnits(dim: string, limit: number | undefined): number | null {
  if (limit === undefined) return null;
  return isMemory(dim) ? limit / GB : limit;
}

/** The value at `fraction` (0–1) of the bar, snapped to the step; null at the far end (point 4). Never below one step. */
export function dragValue(dim: string, fraction: number, total: number): number | null {
  const step = dragStep(dim);
  const max = dragMax(dim, total);
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 1));
  const raw = isMemory(dim) ? (f * total) / GB : f * 100;
  const v = Math.round(raw / step) * step;
  return v >= max ? null : Math.max(step, v);
}

/** One arrow key from `value` (null: the far end), onto the step grid; reaching the far end gives null (point 7). */
export function stepDrag(dim: string, value: number | null, dir: -1 | 1, total: number): number | null {
  const step = dragStep(dim);
  const max = dragMax(dim, total);
  const cur = value ?? max;
  const next = dir > 0 ? Math.floor(cur / step + 1e-9) * step + step : Math.ceil(cur / step - 1e-9) * step - step;
  return next >= max ? null : Math.max(step, next);
}

/** Where a value sits on its bar (0–1); no limit sits at the far end. */
export function valueShare(dim: string, value: number | null, total: number): number {
  if (value === null) return 1;
  if (!isMemory(dim)) return Math.min(1, Math.max(0, value / 100));
  return total > 0 ? Math.min(1, Math.max(0, (value * GB) / total)) : 1;
}

/** The value as a person reads it while dragging: "50%", "48 GB", "No limit". */
export function dragText(dim: string, value: number | null): string {
  if (value === null) return 'No limit';
  return isMemory(dim) ? `${Math.round(value * 10) / 10} GB` : `${Math.round(value)}%`;
}
