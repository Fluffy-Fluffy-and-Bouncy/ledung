// Screenshots attached to a question (issue #60): the words for verdicts, and the answer the verdicts
// become. Shared by the page, which sends the answer, and the tests.
import type { QuestionShot, ShotVerdict } from './protocol.ts';

export const VERDICTS: ShotVerdict[] = ['pass', 'fail', 'unsure'];

/** The buttons' words. */
export const VERDICT_LABEL: Record<ShotVerdict, string> = { pass: 'Pass', fail: 'Fail', unsure: 'Unsure' };

/** How someone else's opinion reads, as on the Shot Judge. */
export const OPINION_WORDS: Record<ShotVerdict, string> = { pass: 'looks right', fail: 'looks off', unsure: "can't tell" };

/**
 * A session's text on one line. The answer is one line per shot, so a group, a file name (a file name can
 * hold a newline) or a note with line breaks must not be able to add lines the user never gave.
 */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

export interface ShotJudgement {
  verdict: ShotVerdict | null;
  note: string;
}

/**
 * The answer to a question with screenshots: a count line, one line per shot in the order they were
 * attached (its verdict, then its note), then the note to the asker. A shot left unjudged says so.
 */
export function shotAnswer(shots: QuestionShot[], judged: Record<number, ShotJudgement | undefined>, note = ''): string {
  const verdictOf = (i: number) => judged[i]?.verdict ?? null;
  const counts = VERDICTS.map((v) => [VERDICT_LABEL[v], shots.filter((_, i) => verdictOf(i) === v).length] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}`);
  const unjudged = shots.filter((_, i) => !verdictOf(i)).length;
  if (unjudged) counts.push(`no verdict ${unjudged}`);
  const lines = shots.map((s, i) => {
    const v = verdictOf(i);
    const n = oneLine(judged[i]?.note ?? '');
    return `- ${oneLine(s.group)} · ${oneLine(s.path)}: ${v ? VERDICT_LABEL[v] : 'no verdict'}${n ? ` — ${n}` : ''}`;
  });
  const extra = note.trim();
  return [`Screenshot verdicts: ${counts.join(' · ')}`, ...lines, ...(extra ? ['', extra] : [])].join('\n');
}
