// Verdicts given in the screenshot view and not sent yet (issues #60, #138). Kept outside the view, so
// leaving a question and coming back keeps them; a reload starts over. Pure apart from the map, for tests.
import type { QuestionShot } from '../../src/shared/protocol.ts';
import type { ShotJudgement } from '../../src/shared/shots.ts';

export interface ShotDraft {
  /** By the shot's place in its question. */
  judged: Record<number, ShotJudgement>;
  note: string;
  /** The question's shot files by place, so verdicts can follow a file to another question. */
  paths: string[];
  /** The asking session's project: verdicts only follow a file within it (#141 review, finding 3). */
  project: string;
  /** Places whose verdict was carried over, with the question it came from; marked until judged here. */
  carried: Record<number, number>;
  /** Places the person gave or took away a verdict on here: never filled from elsewhere. */
  touched: Record<number, true>;
}

export const shotDrafts = new Map<number, ShotDraft>();

export const emptyDraft = (shots: QuestionShot[], project: string): ShotDraft =>
  ({ judged: {}, note: '', paths: shots.map((s) => s.path), project, carried: {}, touched: {} });

/**
 * Fills the shots of question `id` that have no verdict with the verdicts given on the same files in
 * questions of the same project that were withdrawn before they were sent (issue #138: a session withdrew
 * its question and asked again with the same shots while the user was judging, and the verdicts given
 * were silently gone). Runs when a question opens and whenever another is withdrawn while it is open, so
 * a question asked before the old one was withdrawn gets them too (#141 review, finding 2). Only gaps:
 * never a shot with a verdict, one the person judged or un-marked here, or one filled before. The latest
 * withdrawn question wins for a file. The same draft back when nothing was filled.
 */
export function fillGaps(id: number, draft: ShotDraft, drafts: ReadonlyMap<number, ShotDraft>, withdrawn: (id: number) => boolean): ShotDraft {
  const older = [...drafts.entries()]
    .filter(([other, d]) => other !== id && withdrawn(other) && d.project === draft.project)
    .sort(([a], [b]) => b - a);
  if (!older.length) return draft;
  const judged = { ...draft.judged };
  const carried = { ...draft.carried };
  let filled = false;
  draft.paths.forEach((path, i) => {
    if (judged[i]?.verdict || draft.touched[i] || carried[i] !== undefined) return;
    for (const [other, d] of older) {
      const j = d.paths.indexOf(path);
      const given = j >= 0 ? d.judged[j] : undefined;
      if (!given?.verdict) continue;
      judged[i] = { verdict: given.verdict, note: judged[i]?.note.trim() ? judged[i]!.note : given.note };
      carried[i] = other;
      filled = true;
      break;
    }
  });
  return filled ? { ...draft, judged, carried } : draft;
}

/** The questions a draft's carried verdicts came from, lowest first. */
export const carriedFrom = (d: ShotDraft): number[] => [...new Set(Object.values(d.carried))].sort((a, b) => a - b);

/** Verdicts in a draft. */
export const verdictCount = (d: ShotDraft): number => Object.values(d.judged).filter((j) => j.verdict).length;
