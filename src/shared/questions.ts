// Structured questions (issue #59): the optional fields ask_user takes besides its Markdown text, and how
// the page's question desk shows any question, structured or plain. Modelled on the Master Question Desk.
// Every question has a tier from its project's list, which starts as the five below (issue #96).
import type { OrderQuestionDetails } from './orders.ts';
import type { QuestionInfo } from './protocol.ts';

/** An option of a structured question: its key ("a"), its text in Markdown (a **bold** start is its label), its cost. */
export interface QuestionOption {
  key: string;
  text: string;
  cost?: string;
  /** At a run's person step (#291): the block's outcome word this option's answer leads to. */
  outcome?: string;
  /**
   * A plain question's option label (ask_user's string options), set by Ledung when it stores the question (#509), never
   * by an asker: picking it answers exactly this, the label as offered, "(recommended)" and all. Its text is the label
   * as shown, whole. Absent: the answer is optionAnswer's "a — Label".
   */
  answer?: string;
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

/**
 * The tier of a workflow person step's question (#351, Simon 2026-11-17, question #2032): the block's own when it names
 * one of the project's tiers; else a review goes under the first tier (in the five, "Blocks a finished PR") and a
 * question under the second ("Blocks a card from Ready": the run's work waits on it, but nothing finished does).
 */
export function stepTier(projectTiers: readonly string[], ask: 'question' | 'review' | undefined, own?: string): string {
  const named = own?.trim() ? projectTiers.find((t) => t.toLowerCase() === own.trim().toLowerCase()) : undefined;
  if (named) return named;
  const first = projectTiers[0] ?? DEFAULT_TIERS[0]!;
  return ask === 'review' ? first : projectTiers[1] ?? first;
}

/**
 * One view on a question: who gave it, the option it picks (none: no pick among the options) and why. `who` empty is the
 * asker itself (the page names it): its pick as an older question gave it, as `recommended` or a "(recommended)" label (#509).
 */
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

/** One decision of a request (issue #502): its own title, short issue, options (with outcomes at a run step) and opinions. */
export interface Decision {
  key: string;
  title: string;
  issue?: string;
  options: QuestionOption[];
  opinions?: Opinion[];
}

/** A review: a person's functional sign-off on a finished change, in fixed sections (docs/steps/pr-review.md). */
export interface ReviewDetails {
  solving: string;
  done: string;
  notes?: string;
  evidence?: ReviewEvidence[];
}

/**
 * A stored screenshot or evidence file as people read it: a kept copy (a container's, issue #122, or any project's,
 * issue #306) by its path in the project; a file from a linked computer (issue #158) by its name, marked as from there.
 */
export function shownFile(file: string): string {
  return file.replace(/^(?:container|kept):[0-9a-f]{32}\//, '').replace(/^linked:[0-9a-f]{16}\//, LINKED_MARK);
}

/**
 * How a file from a linked computer is marked where it is shown, and the name its copy kept for a question has
 * ("kept:<hash>/linked: shot.png"), so the mark stays (Martin, 2026-11-12 23:02, Ledung question #2148: "a — Keep the mark").
 */
export const LINKED_MARK = 'linked: ';

/** Every kept copy a stored question names, by its hash, in the question's stored JSON (issues #122, #306). */
export const COPY_REFS = /(?:container|kept):([0-9a-f]{32})\//g;

/**
 * Waiting for you history (issue #306; Martin, 2026-11-12, Ledung question #2145): per project at least the last
 * 100 answered questions, and every question of the last 30 days if that is more.
 */
export const HISTORY_PER_PROJECT = 100;
export const HISTORY_DAYS = 30;
/** In a light question, each text cut to this many characters: what the history list shows, an excerpt of 180. */
export const LIGHT_TEXT_CHARS = 300;

/**
 * A question as Waiting for you history lists it (issue #306): without what it refers to, and every text of it, the
 * question's, the answer's and each of its fields', cut to LIGHT_TEXT_CHARS. Marked `light`: the page asks for it
 * whole when it is opened.
 */
export function lightQuestion(q: QuestionInfo): QuestionInfo {
  // A file's name (a screenshot's path, an evidence file) is never cut: the page shows the image by it.
  const cut = (v: unknown): unknown => {
    if (typeof v === 'string') return v.length > LIGHT_TEXT_CHARS ? `${v.slice(0, LIGHT_TEXT_CHARS)}…` : v;
    if (Array.isArray(v)) return v.map(cut);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'path' || k === 'file' ? x : cut(x)]));
    return v;
  };
  return {
    ...q, question: cut(q.question) as string, answer: cut(q.answer) as string | null, withdrawnReason: cut(q.withdrawnReason) as string | null,
    details: cut(q.details) as QuestionDetails | null, shots: cut(q.shots) as QuestionInfo['shots'], original: null, earlier: null, sources: null, light: true,
  };
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

/**
 * The structured fields of a question; every one is optional. Stored, a question has one shape, its blocks (#509): the
 * context (title, issue, evidence, refs; a review's sections), its decisions and a sign-off. An ordinary question is
 * one decision with the key "" (the question's own: it has no key of its own); a request has keyed decisions.
 * `options`, `recommended`, `why` and `reviewer`, and `opinions` outside a review or sign-off, are what ask_user takes:
 * Ledung turns them into that decision when it stores the question (toBlocks, src/shared/blocks.ts). Only Ledung's own
 * permission-carrying questions keep them as asked (keepsItsShape).
 */
export interface QuestionDetails {
  title?: string;
  issue?: string;
  evidence?: string;
  options?: QuestionOption[];
  /** Any number of views, in the order the asker gives them (issue #96). Stored beside a review or sign-off only. */
  opinions?: Opinion[];
  /** The older fixed pair, as askers may still give it; stored only in a permission-carrying question (#509). */
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
  /**
   * A request's decisions (issue #502, docs/steps/request-blocks.md): one or more questions on one page, each answered.
   * With them the top-level options and opinions are not given: they belong inside a decision.
   */
  decisions?: Decision[];
  /** A request asks for Accepted / Changes needed without a review's sections (issue #502); a review implies it. */
  signOff?: boolean;
  /** Asked with text and option labels only, no structured fields (#509): the page marks it "plain", as it always has. */
  plain?: boolean;
  /** A person block of a run asked it (workflow part 3b): the answer moves the run; shown with the question. */
  run?: QuestionRun;
  /** A manager's proposed workflow change (part 3e), by its number: the review page shows it before and after. */
  flowProposal?: number;
  /** The project a Ledung Helper's proposal is for (docs/steps/ledung-helper.md); a manager's is its own project's. */
  flowProject?: string;
  /**
   * A call the auto mode classifier refused, raised by Ledung itself (issue #104): never given by ask_user, which
   * builds its details from the fields above only. Answered "Allow once", it lets that exact call through one time.
   */
  refusal?: RefusalDetails;
  /**
   * Raised by Ledung about an order (issue #105): a proposed order to confirm, or one not done, "keep it?". Never given
   * by ask_user.
   */
  order?: OrderQuestionDetails;
  /**
   * The exact command an ask_user question puts to the person (issue #105, Martin 2026-11-03, Ledung question #1290 "a"):
   * shown on the question page, and the person's pick of `confirm` confirms an order for exactly it.
   */
  orderCommand?: OrderCommandDetails;
}

/** A command an ask_user question asks the person to confirm as an order (issue #105). */
export interface OrderCommandDetails {
  command: string;
  match: 'exact' | 'pattern';
  /** The answer that confirms it: what Ledung's own Confirm order option gives, as the page sends it (one of CONFIRM_ANSWERS). */
  confirm: string;
}

/** The refused call (issue #104): the tool, its input as the session sent it, the classifier's reason and the call's id. */
export interface RefusalDetails {
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
  toolUseId: string;
  /**
   * The call was a subagent's, not the session's own (issue #146): its Allow once covers only a subagent's retry, and
   * the session's own Allow once never a subagent's identical call. Absent on questions raised before: the session's own.
   */
  byAgent?: boolean;
  /**
   * Allow once can't get this call past Claude Code (Project-Ledung#470), so the person is asked to make it by hand
   * instead: `protected`, it writes a path Claude Code guards itself; `retried`, an Allow once was used and the retry
   * was refused again. Absent: Allow once is offered.
   */
  byHand?: 'protected' | 'retried';
  /** With `retried`: the question whose Allow once the retry used. */
  retryOf?: number;
  /**
   * Allow always was offered (issue #225): `plain`, or `sensitive` with its own button when the command is on the
   * project's sensitive list. Absent: not offered (not a shell command, by hand, or asked before #225).
   */
  always?: 'plain' | 'sensitive';
  /** With `sensitive`: the sensitive rule the command matched, as the question named it. */
  sensitiveRule?: string;
  /**
   * Not refused by the classifier but held by away mode (issue #262): a manager's own sensitive call, denied at once
   * so its turn and inbox go on, and asked here instead of as a prompt. `reason` is then away mode's. Grants, Allow
   * always and the passkey on the phone work as for a refusal. Absent: the classifier refused it.
   * `prompt` (issue #308): a manager's own settings change or sensitive non-shell call, which would have been a
   * permission prompt; `reason` is then the rule the prompt would have shown, and a settings change's retry is let
   * through only while it still loosens exactly that.
   */
  held?: 'away' | 'prompt';
  /**
   * What the tool does, its own description's first sentence, when Ledung knew it (issue #399): a call to an MCP tool
   * is otherwise only a name and its input. Shown to the person; never part of what makes it the same call.
   */
  description?: string;
}

/** The run and block a person block's question belongs to (workflow part 3b), with their titles as asked. */
export interface QuestionRun {
  run: string;
  block: string;
  runTitle: string;
  blockTitle: string;
  /** Whose call it is, as the block names them (part 3d); none: the person using Ledung. */
  person?: string;
  /** The flow it runs in, for the link to the workflow page (part 3c). */
  flow?: string;
  /** The coordinator's own write-up (#291), not Ledung's card: its options carry their outcomes, and a note may follow a pick. */
  writeUp?: boolean;
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
  return o.answer ?? `${o.key} — ${plain(splitOption(o.text).label)}`;
}

/** A stored option as the desk shows it: a plain label whole (#509), else its bold start as the label. */
export function deskOption(o: QuestionOption): DeskOption {
  return o.answer !== undefined
    ? { key: o.key, label: o.text, detail: '', cost: o.cost ?? '', answer: o.answer }
    : { key: o.key, ...splitOption(o.text), cost: o.cost ?? '', answer: optionAnswer(o) };
}

/** Stored opinions as the desk shows them; an empty `who` is the asker (#509). */
export function decisionOpinions(opinions: readonly Opinion[] | undefined): DeskOpinion[] {
  return (opinions ?? []).map((o) => ({ who: o.who || null, pick: o.pick ?? null, why: o.why ?? '' }));
}

/**
 * Ledung's own questions that carry permissions keep the shape they were asked in (#509, point 2): a permission question
 * (about_request), a refused or held call, an order, an order command and a workflow proposal. They have their own
 * pages, and their answers allow things, so they are never rewritten.
 */
export function keepsItsShape(q: { details: QuestionDetails | null; aboutRequest?: string | null }): boolean {
  const d = q.details;
  return !!q.aboutRequest || !!d?.refusal || !!d?.order || !!d?.orderCommand || d?.flowProposal !== undefined;
}

/** The question's own decision (key ""): an ordinary question's options and opinions (#509). */
export function ownDecision(d: Pick<QuestionDetails, 'decisions'> | null | undefined): Decision | undefined {
  return d?.decisions?.find((x) => x.key === '');
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
  // A request (issue #502): its decisions and sign-off follow the context, so the chat and the manager read every part.
  const requestTail = () => {
    for (const x of d.decisions ?? []) {
      parts.push(`**Decision ${x.key}: ${x.title}**${x.issue ? `\n\n${x.issue}` : ''}`);
      parts.push(x.options.map((o) => `- ${o.key}) ${o.text}${o.cost ? ` Cost: ${o.cost}` : ''}`).join('\n'));
      for (const o of x.opinions ?? []) parts.push(`${o.who}: ${o.pick ?? 'no pick among the options'}${o.why ? `. ${o.why}` : ''}`);
    }
    if (!d.review && !d.signOff) return;
    for (const o of d.opinions ?? []) parts.push(`${o.who}: ${o.why ?? ''}`);
    parts.push(d.decisions?.length
      ? `Answered on the request page: each decision, and "${ACCEPTED}" or "${CHANGES_NEEDED} …" as the sign-off.`
      : `Answered "${ACCEPTED}" or "${CHANGES_NEEDED} …" on the review page.`);
  };
  if (d.review) {
    const r = d.review;
    if (d.title) parts.push(`**Review: ${d.title}**`);
    parts.push(`**What we were solving**\n\n${r.solving}`, `**What was done**\n\n${r.done}`);
    if (r.notes) parts.push(`**Notes**\n\n${r.notes}`);
    if (r.evidence?.length) parts.push(`**Evidence**\n\n${r.evidence.map((e) => `- ${e.caption} (\`${shownFile(e.file).replace(/`/g, "'")}\`)`).join('\n')}`);
    requestTail();
    return parts.join('\n\n');
  }
  if (d.title) parts.push(`**${d.title}**`);
  if (d.issue) parts.push(d.issue);
  if (d.evidence) parts.push(`**Evidence**\n\n${d.evidence}`);
  if (d.decisions?.length || d.signOff) {
    requestTail();
    return parts.join('\n\n');
  }
  if (d.options?.length) parts.push(d.options.map((o) => `- ${o.key}) ${o.text}${o.cost ? ` Cost: ${o.cost}` : ''}`).join('\n'));
  if (d.recommended) parts.push(`Recommended: ${d.recommended}${d.why ? `. ${d.why}` : ''}`);
  if (d.reviewer) parts.push(`${d.reviewer.who || 'Reviewer'}: ${d.reviewer.pick ?? 'no pick among the options'}${d.reviewer.why ? `. ${d.reviewer.why}` : ''}`);
  for (const o of d.opinions ?? []) parts.push(`${o.who}: ${o.pick ?? 'no pick among the options'}${o.why ? `. ${o.why}` : ''}`);
  return parts.join('\n\n');
}

type Stored = { question: string; options: string[] | null; details: QuestionDetails | null; aboutRequest?: string | null };

/**
 * A question as the desk shows it, read from its blocks (#509): the context as stored, and the options and opinions of
 * its own decision. Ledung's own permission-carrying questions keep their shape and are read as asked (legacyDesk).
 */
export function deskQuestion(q: Stored): DeskQuestion {
  if (keepsItsShape(q)) return legacyDesk(q);
  const d = q.details ?? {};
  const own = ownDecision(d);
  return {
    structured: !d.plain,
    title: d.title || titleFrom(d.review?.solving ?? q.question),
    issue: d.review ? '' : d.issue ?? '',
    evidence: d.evidence ?? '',
    options: (own?.options ?? []).map(deskOption),
    opinions: decisionOpinions(own?.opinions),
    tier: d.tier ?? null,
    rank: d.rank ?? null,
    refs: d.refs ?? [],
    review: d.review ?? null,
  };
}

/**
 * A question read from the fields as asked: what Ledung's own permission-carrying questions keep, and what toBlocks
 * writes down as blocks (#509). A plain one degrades: its text is The issue, a "(recommended)" option the asker's pick.
 */
export function legacyDesk(q: Stored): DeskQuestion {
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
      options: d.options?.length ? d.options.map(deskOption) : plainOptions(q.options).options,
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
export function ownText(question: string, d: QuestionDetails): string {
  const q = question.trim();
  // An exact match, not a prefix: askers often open their own text with the bold title (review of PR #295).
  if (!q || q === d.issue?.trim() || q === d.title?.trim() || q === questionText(undefined, d).trim()) return '';
  return question;
}

/**
 * The opinions in the order the desk splits the border: the older pair first as it was shown (the
 * reviewer's on the left, the asker's on the right), then the list (issue #96).
 */
export function deskOpinions(d: Pick<QuestionDetails, 'reviewer' | 'recommended' | 'why' | 'opinions'>, plainPick: string | null): DeskOpinion[] {
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
