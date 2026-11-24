// One request page built from blocks (issue #502, docs/steps/request-blocks.md, approved by Simon 2026-11-23 with every
// recommended choice). A request is still a question in Ledung's records; only its contents grow. This module turns any
// stored question, today's or older, into its answerable parts, and turns the person's parts back into the one answer
// the asker reads. A preset (a plain question, a review, a screenshot question) answers byte-for-byte as it did before,
// so every asker, manager and workflow that reads answers today keeps working.
import type { QuestionInfo, QuestionShot, ShotVerdict } from './protocol.ts';
import {
  ACCEPTED, CHANGES_NEEDED, deskOpinions, deskQuestion, optionAnswer, reviewAnswer, splitOption,
  type Decision, type DeskOpinion, type DeskOption, type QuestionDetails, type QuestionOption,
} from './questions.ts';
import { oneLine, shotAnswer, VERDICTS } from './shots.ts';

/** At most this many decisions in one request (D8): more should be two requests. */
export const MAX_DECISIONS = 6;
/** At most this many files in one request, screenshots and evidence files together (D8). */
export const MAX_REQUEST_FILES = 40;
/** A decision's key: short, so the answer line stays readable ("d1", "layout", "side-chat"). */
export const DECISION_KEY = /^[a-z0-9][a-z0-9-]{0,19}$/;

/** One decision's answer: the option picked by its key, or the person's own words ("Other"). */
export interface DecisionAnswer {
  key: string;
  pick?: string;
  other?: string;
}

/**
 * A request's answer as data (column answer_parts): what a run, the #350 line and waiting_for_you read without parsing
 * text. The same as the answer text, part by part.
 */
export interface AnswerParts {
  decisions?: DecisionAnswer[];
  signOff?: { verdict: 'accept' | 'changes'; note?: string };
  /** By the shot's place in the question; a null verdict is a shot left unjudged. */
  shots?: { verdict: ShotVerdict | null; note?: string }[];
  /** The closing note to the asker. */
  note?: string;
}

/** A decision as the page shows it, with whether its answer moves a run (its options carry outcomes). */
export interface RequestDecision {
  key: string;
  title: string;
  issue: string;
  options: DeskOption[];
  opinions: DeskOpinion[];
  /** Its options carry a run's outcomes: this decision's pick moves the run (D6). */
  moves: boolean;
}

/** Which of today's pages a stored question matches; 'request' for anything that mixes parts. */
export type RequestPreset = 'question' | 'review' | 'shots' | 'request';

/** A question as the request page answers it: its decisions, whether it asks a sign-off, how many shots it judges. */
export interface RequestModel {
  preset: RequestPreset;
  decisions: RequestDecision[];
  signOff: boolean;
  shots: number;
  /** The answered parts: each decision, the sign-off, and the screenshots as one. */
  parts: number;
}

type Asked = Pick<QuestionInfo, 'id' | 'question' | 'options' | 'details' | 'shots'> & { aboutRequest?: string | null };

/**
 * Whether a stored question is a request: it has decisions or a sign-off of its own, or a review that also has screenshots
 * to judge. Everything else is a preset and answers as before.
 */
export function isRequest(q: Pick<QuestionInfo, 'details' | 'shots'>): boolean {
  const d = q.details;
  return !!(d?.decisions?.length || d?.signOff || (d?.review && q.shots?.length));
}

const deskOptions = (options: QuestionOption[]): DeskOption[] =>
  options.map((o) => ({ key: o.key, ...splitOption(o.text), cost: o.cost ?? '', answer: optionAnswer(o) }));

/** A request's decision as the page shows it. */
export function requestDecision(x: Decision): RequestDecision {
  return {
    key: x.key, title: x.title, issue: x.issue ?? '', options: deskOptions(x.options),
    opinions: deskOpinions({ opinions: x.opinions }, null), moves: x.options.some((o) => o.outcome !== undefined),
  };
}

/**
 * Any stored question as its answerable parts (design section 6). A plain or structured question is one decision (its
 * options; key "" since it has none of its own); a review is a sign-off; a screenshot question judges its shots, its
 * options shown but not answered, as today; a request is whatever it was asked with.
 */
export function requestModel(q: Asked): RequestModel {
  const d = q.details;
  const shots = q.shots?.length ?? 0;
  if (isRequest(q)) {
    const decisions = (d!.decisions ?? []).map(requestDecision);
    const signOff = !!(d!.review || d!.signOff);
    return { preset: 'request', decisions, signOff, shots, parts: decisions.length + (signOff ? 1 : 0) + (shots ? 1 : 0) };
  }
  if (d?.review) return { preset: 'review', decisions: [], signOff: true, shots: 0, parts: 1 };
  if (shots) return { preset: 'shots', decisions: [], signOff: false, shots, parts: 1 };
  const v = deskQuestion(q);
  const one: RequestDecision = {
    key: '', title: v.title, issue: '', options: v.options, opinions: v.opinions,
    moves: !!d?.run?.writeUp && (d.options ?? []).some((o) => o.outcome !== undefined),
  };
  return { preset: 'question', decisions: [one], signOff: false, shots: 0, parts: 1 };
}

/** What the request holds, in words: "review, 2 decisions, 3 screenshots" (waiting_for_you, notifications). */
export function requestKinds(q: Asked): string[] {
  const m = requestModel(q);
  const d = q.details;
  const out: string[] = [];
  if (d?.review) out.push('review');
  else if (m.signOff) out.push('sign-off');
  if (m.preset === 'request' && m.decisions.length) out.push(`${m.decisions.length} decision${m.decisions.length === 1 ? '' : 's'}`);
  if (m.shots) out.push(`${m.shots} screenshot${m.shots === 1 ? '' : 's'}`);
  return out;
}

/** How many of a request's decisions and sign-off a draft still leaves open (the "3 to answer" chip); shots are counted apart. */
export function leftToAnswer(m: RequestModel, parts: AnswerParts | null | undefined): number {
  const done = (x: RequestDecision) => {
    const a = parts?.decisions?.find((y) => y.key === x.key);
    return !!a && ((a.pick !== undefined && x.options.some((o) => o.key === a.pick)) || !!a.other?.trim());
  };
  const signOffDone = !!parts?.signOff && (parts.signOff.verdict === 'accept' || !!parts.signOff.note?.trim());
  return m.decisions.filter((x) => !done(x)).length + (m.signOff && !signOffDone ? 1 : 0);
}

/**
 * What is wrong with the parts as sent, or null: they come from the page as JSON, so a caller could send any shape, and a
 * wrong one gets a plain refusal rather than a server error (code review of PR #504, finding 3).
 */
export function answerPartsProblem(parts: unknown): string | null {
  const bad = 'The answer is malformed';
  const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const optString = (x: unknown) => x === undefined || typeof x === 'string';
  if (!isObject(parts)) return `${bad}: its parts are not an object.`;
  if (!optString(parts.note)) return `${bad}: the note is not text.`;
  if (parts.decisions !== undefined) {
    if (!Array.isArray(parts.decisions)) return `${bad}: the decisions are not a list.`;
    for (const x of parts.decisions) {
      if (!isObject(x) || typeof x.key !== 'string' || !optString(x.pick) || !optString(x.other)) return `${bad}: a decision's answer is not a key with a pick or text.`;
    }
  }
  if (parts.signOff !== undefined) {
    const s = parts.signOff;
    if (!isObject(s) || (s.verdict !== 'accept' && s.verdict !== 'changes') || !optString(s.note)) return `${bad}: the sign-off is not Accepted or Changes needed with a note.`;
  }
  if (parts.shots !== undefined) {
    if (!Array.isArray(parts.shots)) return `${bad}: the screenshot verdicts are not a list.`;
    for (const x of parts.shots) {
      if (x === null) continue;
      if (!isObject(x) || !(x.verdict === undefined || x.verdict === null || typeof x.verdict === 'string') || !optString(x.note)) return `${bad}: a screenshot's verdict is not a verdict with a note.`;
    }
  }
  return null;
}

/** Simon's own text kept with its line breaks, each later line indented so it stays inside its part. */
const kept = (text: string) => text.trim().split('\n').map((l, i) => (i ? `  ${l}` : l)).join('\n');

/**
 * The person's parts as the one answer the asker reads, or what is still missing. A preset's answer is exactly
 * today's (the option's "a — Label" with "Note: …", "Accepted." with its note, "Screenshot verdicts: …"); only an
 * answer of more than one part takes the request form (design section 2). Every line a session wrote (a title, a
 * label, a file name) is put on one line, so it can't add lines the person never gave.
 */
export function requestAnswer(q: Asked, parts: AnswerParts, userName: string): { answer: string; parts: AnswerParts } | { problem: string } {
  const malformed = answerPartsProblem(parts);
  if (malformed) return { problem: malformed };
  const m = requestModel(q);
  const note = parts.note?.trim() ?? '';
  // D3: every decision and the sign-off before Send; "Other" with typed text is always there for "not sure yet".
  const decisions: DecisionAnswer[] = [];
  const lines: string[] = [];
  for (const x of m.decisions) {
    const a = parts.decisions?.find((y) => y.key === x.key);
    const option = a?.pick !== undefined ? x.options.find((o) => o.key === a.pick) : undefined;
    const other = a?.other?.trim() ?? '';
    if (!option && !other) return { problem: `Answer ${m.preset === 'question' ? 'the question' : `decision "${oneLine(x.title)}"`} first: pick an option, or write your own answer.` };
    decisions.push(option ? { key: x.key, pick: option.key } : { key: x.key, other });
    lines.push(`Decision ${oneLine(x.key)} — ${oneLine(x.title)}: ${option ? oneLine(option.answer) : `Other: ${kept(other)}`}`);
  }
  let signOff: AnswerParts['signOff'];
  let signOffText = '';
  if (m.signOff) {
    const s = parts.signOff;
    if (!s) return { problem: 'Give the sign-off first: Accepted, or Changes needed with what to change.' };
    // A review alone has one box: its note and the closing note are the same words.
    const own = m.parts === 1 ? [s.note?.trim(), note].filter(Boolean).join('\n\n') : s.note?.trim() ?? '';
    const r = reviewAnswer(s.verdict, own);
    if ('problem' in r) return { problem: `Sign-off: ${r.problem}` };
    signOff = { verdict: s.verdict, ...(s.note?.trim() ? { note: s.note.trim() } : {}) };
    signOffText = r.answer;
  }
  let shots: AnswerParts['shots'];
  let shotText = '';
  if (m.shots) {
    const given = parts.shots ?? [];
    shots = q.shots!.map((_, i) => {
      const v = given[i]?.verdict;
      return { verdict: v && VERDICTS.includes(v) ? v : null, ...(given[i]?.note?.trim() ? { note: given[i]!.note!.trim() } : {}) };
    });
    // Today's screenshot page sends nothing unjudged; in a request, shots may stay unjudged when the rest is answered.
    if (m.parts === 1 && !shots.some((s) => s.verdict)) return { problem: 'Judge at least one shot first.' };
    const judged = Object.fromEntries(shots.map((s, i) => [i, { verdict: s.verdict, note: s.note ?? '' }]));
    shotText = shotAnswer(q.shots as QuestionShot[], judged, m.parts === 1 ? note : '');
  }
  const stored: AnswerParts = {
    ...(m.decisions.length ? { decisions } : {}), ...(signOff ? { signOff } : {}), ...(shots ? { shots } : {}), ...(note ? { note } : {}),
  };
  if (m.parts === 1) {
    if (signOff) return { answer: signOffText, parts: stored };
    if (shots) return { answer: shotText, parts: stored };
    // One question, as its page sends it: the option's answer, or the typed words, then the note.
    const x = m.decisions[0]!;
    const d = decisions[0]!;
    const chosen = d.pick !== undefined ? x.options.find((o) => o.key === d.pick)!.answer : d.other!;
    // A question about a permission request is decided by its exact answer, so no note goes with it (issue #51).
    return { answer: note && !q.aboutRequest ? `${chosen}\n\nNote: ${note}` : chosen, parts: stored };
  }
  const title = oneLine(deskQuestion(q).title);
  const out = [`Answer to request #${q.id} "${title}" (${m.parts} parts)`, ''];
  // The sign-off first (it is the overall verdict), then the decisions in the asked order, the shots, the note.
  if (signOff) out.push(`Sign-off: ${kept(signOffText.replace(/\n\n/g, ' '))}`);
  out.push(...lines);
  if (shotText) out.push(shotText);
  if (note) out.push('', `${userName}'s note: ${kept(note)}`);
  return { answer: out.join('\n'), parts: stored };
}

/**
 * The answer that moves a run, from the stored parts (D6): the sign-off for a review step, the one decision whose options
 * carry outcomes for a question step. Its options come back too, so answerWord reads the pick as it reads a write-up's.
 * Null when the parts hold no moving block: the run then reads the answer text, as for an answer stored before #502.
 */
export function movingAnswer(q: Pick<QuestionInfo, 'details' | 'answerParts'>): { answer: string; options?: QuestionOption[] } | null {
  const p = q.answerParts;
  const d = q.details;
  if (!p || !d) return null;
  // Only a review step is moved by the sign-off; at a question step the decision with outcomes moves it, even beside a
  // sign-off asked before the step refused one (code review of PR #504, finding 1).
  if (d.review && p.signOff) {
    return { answer: p.signOff.verdict === 'accept' ? ACCEPTED : `${CHANGES_NEEDED} ${p.signOff.note ?? ''}`.trim() };
  }
  const moving = (d.decisions ?? []).find((x) => x.options.some((o) => o.outcome !== undefined));
  if (!moving) return null;
  const a = p.decisions?.find((x) => x.key === moving.key);
  const option = a?.pick !== undefined ? moving.options.find((o) => o.key === a.pick) : undefined;
  return { answer: option ? optionAnswer(option) : a?.other ?? '', options: moving.options };
}

/** The decisions of a stored question that carry outcomes; a run's question step needs exactly one (D6). */
export function movingDecisions(d: Pick<QuestionDetails, 'decisions'>): Decision[] {
  return (d.decisions ?? []).filter((x) => x.options.some((o) => o.outcome !== undefined));
}
