// Structured questions (issue #59): the optional fields ask_user takes besides its Markdown text, and how
// the page's question desk shows any question, structured or plain. Modelled on the Master Question Desk.
// Every question has a tier from its project's list, which starts as the five below (issue #96).

/** An option of a structured question: its key ("a"), its text in Markdown (a **bold** start is its label), its cost. */
export interface QuestionOption {
  key: string;
  text: string;
  cost?: string;
}

/**
 * The tiers every project starts with, in order: the Question Desk's five (agent-workflow v84). A project
 * may change them, but its list is never empty (Martin, 2026-10-15, issue #96).
 */
export const DEFAULT_TIERS: readonly string[] = ['Blocks a finished PR', 'Blocks a card from Ready', 'Process', 'Housekeeping', 'Record only'];

/** A project's tiers: its own list, or the five when it has none. */
export function tiersOf(list: readonly string[] | null | undefined): string[] {
  const own = (list ?? []).map((t) => t.trim()).filter(Boolean);
  return own.length ? [...new Set(own)] : [...DEFAULT_TIERS];
}

/** The tier as the project spells it, or a message for the asker listing the project's tiers. */
export function checkTier(tier: string | undefined, projectTiers: readonly string[]): { tier: string } | { problem: string } {
  const list = projectTiers.map((t) => `"${t}"`).join(', ');
  const found = tier?.trim() ? projectTiers.find((t) => t.toLowerCase() === tier.trim().toLowerCase()) : undefined;
  if (found) return { tier: found };
  return {
    problem: (tier?.trim() ? `The tier "${tier.trim()}" is not one of this project's question tiers.` : 'Every question needs a tier.') +
      ` Give tier as one of: ${list}. Nothing was asked.`,
  };
}

/** The tier of a question Ledung asks itself, e.g. before a first board post: "Process" when the project has it, else its first. */
export function ledungTier(projectTiers: readonly string[]): string {
  return projectTiers.includes('Process') ? 'Process' : projectTiers[0] ?? DEFAULT_TIERS[2]!;
}

/** One view on a question: who gave it, the option it picks (none: no pick among the options) and why. */
export interface Opinion {
  who: string;
  pick?: string;
  why?: string;
}

/**
 * A file that demonstrates a reviewed change (docs/steps/pr-review.md): a screenshot or a text file such as
 * a log, from the asker's project folder or a "board:" file, with its caption. `kind` is set when Ledung
 * has checked it on asking, by its first bytes as for board attachments.
 */
export interface ReviewEvidence {
  file: string;
  caption: string;
  kind?: 'image' | 'text';
}

/** A review: a person's functional sign-off on a finished change, in fixed sections (docs/steps/pr-review.md). */
export interface ReviewDetails {
  solving: string;
  done: string;
  notes?: string;
  evidence?: ReviewEvidence[];
}

/** At most this many evidence files per review. */
export const MAX_REVIEW_EVIDENCE = 10;

/** The answer to a review is always one of two forms, so an asker or a workflow can act on it without interpreting it. */
export const ACCEPTED = 'Accepted.';
export const CHANGES_NEEDED = 'Changes needed:';

/** The answer the review page sends: Accepted with the note, if any, or Changes needed with the text, which it needs. */
export function reviewAnswer(verdict: 'accept' | 'changes', text: string): { answer: string } | { problem: string } {
  const t = text.trim();
  if (verdict === 'accept') return { answer: t ? `${ACCEPTED}\n\n${t}` : ACCEPTED };
  return t ? { answer: `${CHANGES_NEEDED} ${t}` } : { problem: 'Say what needs changing in the box first.' };
}

/** Why an answer is not one a review takes, or null. */
export function reviewAnswerProblem(answer: string): string | null {
  const a = answer.trim();
  if (a === ACCEPTED || /^Accepted\.\s/.test(a)) return null;
  if (a.startsWith(CHANGES_NEEDED) && a.slice(CHANGES_NEEDED.length).trim()) return null;
  return `A review is answered "${ACCEPTED}", optionally with a note after it, or "${CHANGES_NEEDED}" followed by what needs changing.`;
}

/** The structured fields of a question; every one is optional. */
export interface QuestionDetails {
  title?: string;
  issue?: string;
  evidence?: string;
  options?: QuestionOption[];
  /** Any number of views, in the order the asker gives them (issue #96). */
  opinions?: Opinion[];
  /** The older fixed pair, still read from questions stored before #96 and from askers not yet moved to opinions. */
  recommended?: string;
  why?: string;
  reviewer?: { pick?: string; who?: string; why?: string };
  tier?: string;
  /** Order within its tier, lowest first. */
  rank?: number;
  /** Tickets and pull requests it is about, linked through the project's ticket setting. */
  refs?: string[];
  /** A review instead of a question (docs/steps/pr-review.md): its sections, shown on a page of their own. */
  review?: ReviewDetails;
}

/** One option as the desk shows it. `answer` is the text the session gets when it is picked. */
export interface DeskOption {
  key: string;
  label: string;
  detail: string;
  cost: string;
  answer: string;
}

/** An opinion as the desk shows it; `who` null is the asker itself (the page names it). */
export interface DeskOpinion {
  who: string | null;
  pick: string | null;
  why: string;
}

/** Any question in one shape for the desk. */
export interface DeskQuestion {
  structured: boolean;
  title: string;
  issue: string;
  evidence: string;
  options: DeskOption[];
  opinions: DeskOpinion[];
  tier: string | null;
  rank: number | null;
  refs: string[];
  /** A review's sections; null: an ordinary question. */
  review: ReviewDetails | null;
}

const RECOMMENDED = /\s*\(recommended\)\s*$/i;
const plain = (s: string) => s.replace(/\*\*|`/g, '');

/** An option's text → its bold start as the label and the rest as detail, as on the Desk. */
export function splitOption(text: string): { label: string; detail: string } {
  const m = text.match(/^\*\*(.+?)\*\*[.:]?\s*([\s\S]*)$/);
  return m ? { label: m[1]!.replace(/\.$/, ''), detail: m[2]!.trim() } : { label: text, detail: '' };
}

/** The answer a structured option gives, and its button in the chat: "a — Merge as one PR". */
export function optionAnswer(o: QuestionOption): string {
  return `${o.key} — ${plain(splitOption(o.text).label)}`;
}

/** Checks the fields ask_user got; the message is what the asker reads. */
export function detailsProblem(d: QuestionDetails): string | null {
  const keys = (d.options ?? []).map((o) => o.key);
  if (new Set(keys).size !== keys.length) return 'Each option needs its own key.';
  const notKey = (field: string, pick: string) => `${field} is "${pick}", which is not one of the option keys (${keys.join(', ') || 'none'}).`;
  if (d.recommended && !keys.includes(d.recommended)) return notKey('recommended', d.recommended);
  if (d.reviewer?.pick && !keys.includes(d.reviewer.pick)) return notKey('reviewer.pick', d.reviewer.pick);
  const bad = (d.opinions ?? []).findIndex((o) => o.pick && !keys.includes(o.pick));
  if (bad >= 0) return notKey(`opinions[${bad}].pick`, d.opinions![bad]!.pick!);
  return null;
}

/** Whether anything structured was given. */
export function hasDetails(d: QuestionDetails): boolean {
  return Object.values(d).some((v) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));
}

/**
 * The question as Markdown, for everything that shows a question as text: the chat, the manager it goes
 * to, notifications. The asker's own text when given; otherwise written from the fields.
 */
export function questionText(question: string | undefined, d: QuestionDetails): string {
  if (question?.trim()) return question;
  const parts: string[] = [];
  if (d.review) {
    const r = d.review;
    if (d.title) parts.push(`**Review: ${d.title}**`);
    parts.push(`**What we were solving**\n\n${r.solving}`, `**What was done**\n\n${r.done}`);
    if (r.notes) parts.push(`**Notes**\n\n${r.notes}`);
    if (r.evidence?.length) parts.push(`**Evidence**\n\n${r.evidence.map((e) => `- ${e.caption} (\`${e.file.replace(/`/g, "'")}\`)`).join('\n')}`);
    parts.push(`Answered "${ACCEPTED}" or "${CHANGES_NEEDED} …" on the review page.`);
    return parts.join('\n\n');
  }
  if (d.title) parts.push(`**${d.title}**`);
  if (d.issue) parts.push(d.issue);
  if (d.evidence) parts.push(`**Evidence**\n\n${d.evidence}`);
  if (d.options?.length) parts.push(d.options.map((o) => `- ${o.key}) ${o.text}${o.cost ? ` Cost: ${o.cost}` : ''}`).join('\n'));
  if (d.recommended) parts.push(`Recommended: ${d.recommended}${d.why ? `. ${d.why}` : ''}`);
  if (d.reviewer) parts.push(`${d.reviewer.who || 'Reviewer'}: ${d.reviewer.pick ?? 'no pick among the options'}${d.reviewer.why ? `. ${d.reviewer.why}` : ''}`);
  for (const o of d.opinions ?? []) parts.push(`${o.who}: ${o.pick ?? 'no pick among the options'}${o.why ? `. ${o.why}` : ''}`);
  return parts.join('\n\n');
}

/** A question as the desk shows it. A plain one degrades: its text is The issue, a "(recommended)" option the asker's pick. */
export function deskQuestion(q: { question: string; options: string[] | null; details: QuestionDetails | null }): DeskQuestion {
  const d = q.details;
  if (d?.review) {
    return {
      structured: true, title: d.title || titleFrom(d.review.solving), issue: '', evidence: '', options: [], opinions: [],
      tier: d.tier ?? null, rank: d.rank ?? null, refs: d.refs ?? [], review: d.review,
    };
  }
  if (d && (d.options?.length || d.issue || d.title)) {
    return {
      structured: true,
      title: d.title || titleFrom(d.issue || q.question),
      issue: [d.issue, ownText(q.question, d)].filter(Boolean).join('\n\n') || (d.title ? '' : q.question),
      evidence: d.evidence ?? '',
      options: d.options?.length
        ? d.options.map((o) => ({ key: o.key, ...splitOption(o.text), cost: o.cost ?? '', answer: optionAnswer(o) }))
        : plainOptions(q.options).options,
      opinions: deskOpinions(d, d.options?.length ? null : plainOptions(q.options).recommended),
      tier: d.tier ?? null,
      rank: d.rank ?? null,
      refs: d.refs ?? [],
      review: null,
    };
  }
  const { options, recommended } = plainOptions(q.options);
  return {
    structured: false, title: titleFrom(q.question), issue: q.question, evidence: '', options,
    opinions: recommended ? [{ who: null, pick: recommended, why: '' }] : [],
    tier: d?.tier ?? null, rank: d?.rank ?? null, refs: d?.refs ?? [], review: null,
  };
}

/**
 * The asker's own question text, or '' when the stored text was written from the fields (questionText).
 * A title or an issue beside it must not hide it: the chat shows it, and the desk showed only the
 * title and buttons (issue #294).
 */
function ownText(question: string, d: QuestionDetails): string {
  const q = question.trim();
  // An exact match, not a prefix: askers often open their own text with the bold title (review of PR #295).
  if (!q || q === d.issue?.trim() || q === d.title?.trim() || q === questionText(undefined, d).trim()) return '';
  return question;
}

/**
 * The opinions in the order the desk splits the border: the older pair first as it was shown (the
 * reviewer's on the left, the asker's on the right), then the list (issue #96).
 */
function deskOpinions(d: QuestionDetails, plainPick: string | null): DeskOpinion[] {
  const out: DeskOpinion[] = [];
  if (d.reviewer) out.push({ who: d.reviewer.who || 'Reviewer', pick: d.reviewer.pick ?? null, why: d.reviewer.why ?? '' });
  const askerPick = d.recommended ?? plainPick;
  if (askerPick || d.why) out.push({ who: null, pick: askerPick, why: d.why ?? '' });
  for (const o of d.opinions ?? []) out.push({ who: o.who, pick: o.pick ?? null, why: o.why ?? '' });
  return out;
}

/** Whether the opinions pick different options. */
export function disagree(opinions: readonly DeskOpinion[]): boolean {
  return new Set(opinions.map((o) => o.pick).filter((p) => p !== null)).size > 1;
}

/** Up to this many opinions split an option's border; more are named in writing only (Martin, 2026-10-15, issue #96). */
export const MAX_BORDER_PARTS = 5;

function plainOptions(labels: string[] | null): { options: DeskOption[]; recommended: string | null } {
  let recommended: string | null = null;
  const options = (labels ?? []).map((l, i) => {
    const key = String(i + 1);
    if (RECOMMENDED.test(l) && !recommended) recommended = key;
    // The answer is the label as offered, so the session reads back exactly what it wrote.
    return { key, label: l.replace(RECOMMENDED, ''), detail: '', cost: '', answer: l };
  });
  return { options, recommended };
}

/** A title for a question that has none: its first line when that stands alone, else its first sentence. */
export function titleFrom(text: string): string {
  const lines = text.split('\n');
  if (lines.length > 2 && lines[0]!.trim().length <= 110 && !lines[1]!.trim()) return plain(lines[0]!.trim()).replace(/^#+\s*/, '');
  const flat = plain(text).replace(/\s+/g, ' ').trim();
  const s = flat.match(/^(.{10,110}?[.?!])(\s|$)/);
  return s ? s[1]! : flat.slice(0, 100) + (flat.length > 100 ? '…' : '');
}

/** The group a question goes in: its tier when its project's list names it, else none (questions from before #96, last). */
export function tierOf(tier: string | null, projectTiers: readonly string[]): string | null {
  return tier && projectTiers.includes(tier) ? tier : null;
}

/** Tiers across projects: each project's list in the given order, merged by name. */
export function mergeTiers(lists: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const list of lists) for (const t of list) if (!out.includes(t)) out.push(t);
  return out;
}

/** Queue order: tier (in `tiers`' order, none last), then rank (none last), then oldest first. */
export function deskCompare(tiers: readonly string[]) {
  const place = (t: string | null) => (t === null ? tiers.length : tiers.indexOf(t));
  return (a: { tier: string | null; rank: number | null; askedAt: number }, b: { tier: string | null; rank: number | null; askedAt: number }) =>
    place(a.tier) - place(b.tier) || (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.askedAt - b.askedAt;
}
