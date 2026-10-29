// The line for a free place (step 6b): priority first (critical, high, normal), then who waited longest.
import type { Priority } from '../shared/protocol.ts';

const RANK: Record<Priority, number> = { critical: 0, high: 1, normal: 2 };

export interface LineEntry {
  id: string;
  priority: Priority;
  /** When it started waiting. */
  since: number;
}

export function lineOrder(entries: LineEntry[]): string[] {
  return [...entries].sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.since - b.since).map((e) => e.id);
}

/**
 * May `id` start a turn now? Only if there is a free place for it after everyone ahead of it in line
 * (those who started waiting earlier at the same priority, or have a higher one).
 */
export function mayStart(id: string, working: number, limit: number, line: LineEntry[]): boolean {
  const order = lineOrder(line);
  const place = order.indexOf(id);
  const ahead = place < 0 ? order.length : place;
  return working + ahead < limit;
}
