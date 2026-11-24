// One stored shape for every question (issue #509; Simon, 2026-11-24, Ledung question #2340: "Should we convert the old
// ones? Aren't we maintaining two standards now otherwise?"). Since #502 the request page draws a question from blocks;
// this turns the fields ask_user takes (options, opinions, recommended, why, reviewer, and a plain question's labels)
// into those blocks once, when the question is stored, and once for every question stored before (migration 64 in
// src/store/database.ts). What the page showed, and every answer's words, stay exactly as they were.
import { keepsItsShape, legacyDesk, ownDecision, ownText, type Opinion, type QuestionDetails, type QuestionOption } from './questions.ts';

/** A question as it is stored: what toBlocks reads. */
export interface StoredAsk {
  question: string;
  options: string[] | null;
  details: QuestionDetails | null;
  aboutRequest?: string | null;
}

/**
 * A question's details in the block shape, or null when there is nothing to change: Ledung's own permission-carrying
 * questions (they keep their shape, #509 point 2), a review, and a question already in blocks. Safe to run twice.
 *
 * An ordinary question becomes its context (title, issue, evidence, as its page showed them) and one decision with the
 * key "": its options as given, or its plain labels, each answering exactly its label as offered; its opinions in the
 * order the page drew them, the asker's own with an empty `who`. A request asked since #502 is already blocks; it only
 * takes the asker's own question text into its issue, where the page showed it.
 */
export function toBlocks(q: StoredAsk): QuestionDetails | null {
  if (keepsItsShape(q)) return null;
  const d = q.details ?? {};
  if (d.review || ownDecision(d)) return null;
  if (d.decisions?.length || d.signOff) {
    const own = ownText(q.question, d).trim();
    const addOwn = !!own && !(d.issue ?? '').includes(own);
    if (!addOwn && d.title) return null;
    return { ...d, title: d.title || legacyDesk(q).title, ...(addOwn ? { issue: [d.issue, own].filter(Boolean).join('\n\n') } : {}) };
  }
  const v = legacyDesk(q);
  const given = d.options?.length ? d.options : null;
  const options: QuestionOption[] = given ?? v.options.map((o) => ({ key: o.key, text: o.label, answer: o.answer }));
  const opinions: Opinion[] = v.opinions.map((o) => ({ who: o.who ?? '', ...(o.pick !== null ? { pick: o.pick } : {}), ...(o.why ? { why: o.why } : {}) }));
  const { options: _o, opinions: _p, recommended: _r, why: _w, reviewer: _v, issue: _i, title: _t, ...rest } = d;
  return {
    ...rest,
    title: v.title,
    ...(v.issue ? { issue: v.issue } : {}),
    ...(v.structured ? {} : { plain: true }),
    decisions: [{ key: '', title: v.title, options, ...(opinions.length ? { opinions } : {}) }],
  };
}

/** The question as it is stored: its details in blocks when they need converting, else as given. */
export function inBlocks<T extends StoredAsk>(q: T): T {
  const details = toBlocks(q);
  return details ? { ...q, details } : q;
}
