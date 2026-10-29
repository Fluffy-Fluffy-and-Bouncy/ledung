// Sources a question attaches (issue #369): the asker names what its question points at, a session's reply, a PR
// or review comment, an earlier question, and Ledung fetches the text itself when it is asked and keeps it with the
// question, word for word. Nothing is dropped or reworded in a copy, and "the 12 points above" leads to the original
// on the question page (Martin, 2026-10-28, Ledung questions 313, 319 and 320; mockup passed on question 332).
//
// A source Ledung can't find or fetch doesn't stop the question: it is kept as a failed source saying why, and the
// asker is told. Only the asker's own replies and its own sessions', and questions it or its sessions asked or that
// went to it (as about_question, review of PR #373 finding 1); a comment only through the asker's own runner, the
// `gh` login its pull request poll already uses, and never for a nearly air-gapped project (lockdown B, issue #109).
import type { AttachedSource, FailedSource, QuestionInfo, SessionInfo, StoredMessage } from '../shared/protocol.ts';
import type { GhAnswer } from './pr-poll.ts';

/** What ask_user's `sources` takes, one of the three per entry. */
export type SourceInput = { reply: string; at?: string } | { comment: string } | { question: number };

export const MAX_SOURCES = 5;
/** Characters per source and for them all, as with the kept conversation (issue #368): a question stays small. */
export const SOURCE_CHARS = 20_000;
export const SOURCES_TOTAL_CHARS = 40_000;
const GH_TIMEOUT_MS = 15_000;
/** Messages looked through for a session's last reply: its report ends a turn, so it is near the end. */
const LAST_REPLY_LOOKBACK = 300;

/** What fetching needs from the asker's side, so the rules here are tested against a real store and real sessions. */
export interface SourceContext {
  askerId: string;
  getSession(id: string): SessionInfo | undefined;
  listSessions(): SessionInfo[];
  getQuestion(id: number): QuestionInfo | undefined;
  listMessages(sessionId: string, opts: { limit?: number }): StoredMessage[];
  /** The session's own replies (not a subagent's) stored between two times, oldest first. */
  repliesBetween(sessionId: string, from: number, to: number): StoredMessage[];
  /** Why the asker's project may not reach GitHub (lockdown B), or null. */
  offline(): string | null;
  /** `gh api` through the asker's own runner. */
  ghApi(args: string[], timeoutMs: number): Promise<GhAnswer>;
  now(): number;
}

/** Fetches every source in its order; never throws for one source, only for too many. */
export async function attachSources(inputs: readonly SourceInput[], ctx: SourceContext): Promise<AttachedSource[]> {
  if (inputs.length > MAX_SOURCES) throw new Error(`At most ${MAX_SOURCES} sources. Nothing was asked.`);
  const out: AttachedSource[] = [];
  for (const input of inputs) {
    try {
      out.push(await attachOne(input, ctx));
    } catch (e) {
      out.push(failed(input, (e as Error).message));
    }
  }
  return fit(out);
}

/** The line ask_user's reply gives for the sources that could not be attached, or ''. */
export function failedSourcesNote(sources: readonly AttachedSource[] | null | undefined): string {
  const bad = (sources ?? []).map((s, i) => ({ s, i })).filter((x): x is { s: FailedSource; i: number } => 'error' in x.s);
  if (!bad.length) return '';
  return ` ${bad.length === 1 ? 'One source' : `${bad.length} sources`} could not be attached, and the question says so: ` +
    bad.map(({ s, i }) => `source ${i + 1} (${s.named}): ${s.error.replace(/\.$/, '')}`).join('; ') +
    '. If it matters, put what it says in issue or evidence, or withdraw the question and ask again.';
}

function attachOne(input: SourceInput, ctx: SourceContext): AttachedSource | Promise<AttachedSource> {
  if ('reply' in input) return replySource(input.reply, input.at, ctx);
  if ('comment' in input) return commentSource(input.comment, ctx);
  return questionSource(input.question, ctx);
}

function failed(input: SourceInput, error: string): FailedSource {
  if ('reply' in input) return { kind: 'reply', named: input.at ? `${input.reply} at ${input.at}` : input.reply, error };
  if ('comment' in input) return { kind: 'comment', named: input.comment, error };
  return { kind: 'question', named: `#${input.question}`, error };
}

// --- A session's reply -----------------------------------------------------------------------------------------

function replySource(name: string, at: string | undefined, ctx: SourceContext): AttachedSource {
  const session = ownSession(name, ctx);
  let m: StoredMessage | undefined;
  if (at === undefined) {
    m = ctx.listMessages(session.id, { limit: LAST_REPLY_LOOKBACK }).filter((x) => replyText(x)).at(-1);
    if (!m) throw new Error(`"${session.title}" has no reply in its conversation.`);
  } else {
    const window = replyTime(at, ctx.now());
    if (!window) throw new Error(`"${at}" is not a time Ledung reads: give it as 14:05, 14:05:30 or 2026-10-28 14:05.`);
    m = ctx.repliesBetween(session.id, window.from, window.to).filter((x) => replyText(x)).at(-1);
    if (!m) throw new Error(`"${session.title}" has no reply at ${at}.`);
  }
  const { text, cut } = capped(replyText(m)!);
  return { kind: 'reply', named: at ? `${name} at ${at}` : name, sessionId: session.id, messageId: m.id, at: m.at, text, ...(cut ? { cut } : {}) };
}

/**
 * The asker itself or one of its sessions, by id or title. Anything else, including a session that doesn't exist,
 * gets the same answer, so the error doesn't tell whether another manager's session is there.
 */
function ownSession(name: string, ctx: SourceContext): SessionInfo {
  const n = name.trim();
  const mine = (s: SessionInfo) => s.id === ctx.askerId || s.parentId === ctx.askerId;
  const byId = ctx.getSession(n);
  if (byId) {
    if (mine(byId)) return byId;
    throw new Error(`"${n}" is not this session or one of its sessions, so its replies can't be attached.`);
  }
  const lower = n.toLowerCase();
  const titled = ctx.listSessions().filter((s) => mine(s) && s.title.toLowerCase() === lower);
  if (titled.length === 1) return titled[0]!;
  if (titled.length > 1) throw new Error(`${titled.length} of your sessions are called "${n}": name it by its id (${titled.map((s) => s.id).join(', ')}).`);
  throw new Error(`"${n}" is not this session or one of its sessions, so its replies can't be attached.`);
}

/** A stored message's text when it is the session's own reply (not a subagent's, not only tool calls); else null. */
export function replyText(m: StoredMessage): string | null {
  if (m.kind !== 'sdk' || m.data?.type !== 'assistant' || m.data.parent_tool_use_id) return null;
  const text = (m.data.message?.content ?? [])
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim())
    .map((b: any) => b.text.trim())
    .join('\n\n');
  return text || null;
}

/**
 * The span of time a reply's time names, in this computer's time zone as the conversation shows it: "14:05" is
 * that minute today, "14:05:30" that second, and a date before either makes it that day. Null: not a time.
 */
export function replyTime(at: string, now: number): { from: number; to: number } | null {
  const m = /^\s*(?:(\d{4})-(\d{2})-(\d{2})[ T])?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(at);
  if (!m) return null;
  const day = new Date(now);
  const [y, mo, d] = m[1] ? [Number(m[1]), Number(m[2]) - 1, Number(m[3])] : [day.getFullYear(), day.getMonth(), day.getDate()];
  const h = Number(m[4]), min = Number(m[5]), sec = m[6] === undefined ? null : Number(m[6]);
  if (h > 23 || min > 59 || (sec !== null && sec > 59)) return null;
  const from = new Date(y, mo, d, h, min, sec ?? 0).getTime();
  return { from, to: from + (sec === null ? 60_000 : 1000) };
}

// --- A PR or review comment ------------------------------------------------------------------------------------

/** What a comment link names: a PR's (or issue's) conversation comment, a review's comment on a line, or a review. */
export interface CommentLink {
  owner: string; name: string; number: number;
  what: 'comment' | 'review comment' | 'review';
  id: number;
}

/**
 * A GitHub comment link as the page's "Copy link" gives it; null for anything else. Only github.com: the session
 * chooses the link, so any other host, an Enterprise one or a lookalike, would let it make Ledung contact a server
 * of its choosing with no prompt (code review of PR #378, finding 1). Owner and name as GitHub allows them, so
 * nothing else reaches the API path (finding 2).
 */
export function parseCommentLink(url: string): CommentLink | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull|issues)\/(\d+)(?:\/files|\/changes)?\/?#(issuecomment|discussion_r|pullrequestreview)-?(\d+)$/
    .exec(url.trim());
  if (!m || [m[1], m[2]].some((part) => part === '.' || part === '..')) return null;
  const what = m[5] === 'issuecomment' ? 'comment' : m[5] === 'discussion_r' ? 'review comment' : 'review';
  // A review and a review comment belong to pull requests only.
  if (what !== 'comment' && m[3] !== 'pull') return null;
  return { owner: m[1]!, name: m[2]!, number: Number(m[4]), what, id: Number(m[6]) };
}

async function commentSource(url: string, ctx: SourceContext): Promise<AttachedSource> {
  const link = parseCommentLink(url);
  if (!link) throw new Error('not a GitHub comment link: give one as GitHub\'s "Copy link" on a comment or review gives it, such as https://github.com/owner/repo/pull/12#issuecomment-345.');
  const offline = ctx.offline();
  if (offline) throw new Error(offline);
  const repo = `${link.owner}/${link.name}`;
  const path = link.what === 'comment' ? `repos/${repo}/issues/comments/${link.id}`
    : link.what === 'review comment' ? `repos/${repo}/pulls/comments/${link.id}`
    : `repos/${repo}/pulls/${link.number}/reviews/${link.id}`;
  const answer = await ctx.ghApi([path], GH_TIMEOUT_MS);
  if (!answer.ok) throw new Error(`GitHub did not give it: ${ghReason(answer)}`);
  let c: any;
  try {
    c = JSON.parse(answer.stdout);
  } catch {
    throw new Error('GitHub\'s answer could not be read.');
  }
  // The comment must sit where the link says: GitHub's answer names its PR or issue, and it is the link's (finding 2).
  const parent = String(c?.issue_url ?? c?.pull_request_url ?? '');
  if (!parent.endsWith(`/${link.number}`)) throw new Error(`that comment is not on #${link.number}.`);
  const { text, cut } = capped(String(c?.body ?? ''));
  return {
    // GitHub's own link to it when that is a github.com one; else the link as given.
    kind: 'comment', named: url.trim(), url: typeof c?.html_url === 'string' && c.html_url.startsWith('https://github.com/') ? c.html_url : url.trim(),
    what: link.what, repo, number: link.number,
    author: String(c?.user?.login ?? 'someone'), at: String(c?.submitted_at ?? c?.created_at ?? ''), text, ...(cut ? { cut } : {}),
    ...(link.what === 'review comment' ? { path: c?.path ?? null, line: c?.line ?? c?.original_line ?? null } : {}),
  };
}

/** gh's own reason in a few words, or GitHub's message from what it printed. */
function ghReason(a: Extract<GhAnswer, { ok: false }>): string {
  try {
    const message = JSON.parse(a.stdout)?.message;
    if (typeof message === 'string' && message) return message;
  } catch { /* gh's reason below */ }
  return a.error;
}

// --- An earlier question ---------------------------------------------------------------------------------------

/** The asker's own question, one of its sessions', or one that went to it: the rule about_question follows. */
function questionSource(id: number, ctx: SourceContext): AttachedSource {
  const q = ctx.getQuestion(id);
  if (!q || (q.sessionId !== ctx.askerId && q.addressedTo !== ctx.askerId && ctx.getSession(q.sessionId)?.parentId !== ctx.askerId)) {
    throw new Error(`question #${id} is not from this session or one of its sessions, nor went to it.`);
  }
  const { id: qid, sessionId, askedAt, question, options, details, status, answer, answeredAt, answeredBy } = q;
  // With the sources it attached; a question among them without its own, so copies don't nest without end.
  const sources = q.sources?.map((s) => s.kind === 'question' && !('error' in s) ? { ...s, question: { ...s.question, sources: null } } : s);
  return {
    kind: 'question', named: `#${id}`,
    question: { id: qid, sessionId, askedAt, question, options, details, status, ...(sources?.length ? { sources } : {}), answer, answeredAt, answeredBy },
  };
}

// --- Limits ----------------------------------------------------------------------------------------------------

function capped(text: string): { text: string; cut: boolean } {
  return text.length > SOURCE_CHARS ? { text: text.slice(0, SOURCE_CHARS), cut: true } : { text, cut: false };
}

/** Within the total, the first sources as given whole as far as they go; a later text that no longer fits is cut. */
function fit(sources: AttachedSource[]): AttachedSource[] {
  let left = SOURCES_TOTAL_CHARS;
  return sources.map((s) => {
    if (s.kind === 'question' || 'error' in s) return s;
    const room = Math.max(left, 0);
    left -= s.text.length;
    return s.text.length > room ? { ...s, text: s.text.slice(0, room), cut: true } : s;
  });
}
