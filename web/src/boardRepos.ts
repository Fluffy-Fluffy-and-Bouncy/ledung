// The board repo picker's lists (decision 2026-10-14): boards other projects here use first, then the
// repos the GitHub login can reach, filtered by what is typed. Pure, so the order and the search are tested.
import type { BoardRepoChoicesView } from '../../src/shared/protocol.ts';

export interface PickerRow { repo: string; private: boolean | null; projects: string[] }
export interface PickerGroups { used: PickerRow[]; others: PickerRow[]; hidden: number }

/** Shown at most this many reachable repos at once; typing narrows the rest (a long list is unusable on a phone). */
export const SHOWN = 60;

/** "owner/name" typed with or without spaces, case ignored; every word must appear. */
export function matches(repo: string, query: string): boolean {
  const q = query.toLowerCase().split(/\s+/).filter(Boolean);
  return q.every((w) => repo.toLowerCase().includes(w));
}

export function pickerGroups(choices: BoardRepoChoicesView | null, query: string): PickerGroups {
  if (!choices) return { used: [], others: [], hidden: 0 };
  const privacy = new Map(choices.repos.map((r) => [r.repo.toLowerCase(), r.private]));
  const used = choices.used.filter((u) => matches(u.repo, query))
    .map((u) => ({ repo: u.repo, private: privacy.get(u.repo.toLowerCase()) ?? null, projects: u.projects }));
  // A repo already listed as used is not listed again below.
  const taken = new Set(choices.used.map((u) => u.repo.toLowerCase()));
  const rest = choices.repos.filter((r) => !taken.has(r.repo.toLowerCase()) && matches(r.repo, query))
    .map((r) => ({ repo: r.repo, private: r.private, projects: [] as string[] }));
  return { used, others: rest.slice(0, SHOWN), hidden: Math.max(0, rest.length - SHOWN) };
}

/** A suggestion for a new board's name: "<project>-board" as GitHub spells names (letters, digits, - _ .). */
export function suggestBoardName(project: string): string {
  const slug = project.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/-{2,}/g, '-');
  return `${slug || 'ledung'}-board`.slice(0, 100);
}
