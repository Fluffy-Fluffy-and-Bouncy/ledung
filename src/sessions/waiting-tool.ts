// waiting_for_you (issue #338): what waits for the person from the manager's own project, as Waiting for you lists it
// with "One project" selected, plus what waits for the manager itself and what the person answered lately. Read-only:
// it answers, decides and marks nothing. Only the manager's own project, whatever its lockdown (as work_history,
// issue #254), so nothing crosses projects and a locked project's items never reach another project's manager.
import { CHATS, type PermissionInfo, type QuestionInfo, type SessionInfo } from '../shared/protocol.ts';
import { deskCompare, deskQuestion, tierOf, tiersOf } from '../shared/questions.ts';
import { permissionWaits, questionWaits, waitingFirst } from '../shared/waiting.ts';
import type { Store } from '../store/store.ts';
import { span } from './elapsed.ts';

const HOUR = 60 * 60 * 1000;
/** The answered window when none is given: the last day (issue #338, Done looks like 3). */
export const ANSWERED_HOURS = 24;
/** An answer longer than this is cut, with a note; the whole one is in the asker's conversation. */
const ANSWER_CHARS = 1500;

export interface WaitingInput {
  store: Store;
  managerId: string;
  userName: string;
  /** The project's question tiers, as its settings give them (tiersOf). */
  tiers: (project: string) => string[] | null | undefined;
  /** The request as the person sees it (management.ts requestText). */
  request: (p: PermissionInfo) => string;
  /** Hours back for the answered list; 0 leaves it out. */
  answeredHours?: number;
  now?: number;
}

const oneLine = (text: string, n = 120) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const indent = (text: string) => text.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');

export function waitingForYou(i: WaitingInput): string {
  const { store, managerId, userName } = i;
  const now = i.now ?? Date.now();
  const me = store.getSession(managerId);
  if (!me) return 'Ledung does not know this manager.';
  const project = me.project;
  // Chats are never listed for a manager (Done looks like 5): they belong to no project.
  if (project === CHATS) return `Chats have no list here: waiting_for_you lists a project's items, and Chats belong to no project.`;

  const sessions = new Map<string, SessionInfo | undefined>();
  const sessionOf = (id: string) => {
    if (!sessions.has(id)) sessions.set(id, store.getSession(id));
    return sessions.get(id);
  };
  // A question's or prompt's project is its asking session's, as the page groups them (waitingLists).
  const ours = (sessionId: string) => sessionOf(sessionId)?.project === project;
  const who = (sessionId: string) => {
    if (sessionId === managerId) return 'you';
    const s = sessionOf(sessionId);
    return s?.role === 'manager' ? `manager "${s.title}"` : `"${s?.title ?? 'unknown session'}"`;
  };
  const ago = (at: number) => `${span(now - at)} ago`;

  const tiers = tiersOf(i.tiers(project));
  const open = store.listQuestions(0, false).filter((q) => q.status === 'open' && ours(q.sessionId));
  const order = deskCompare(tiers);
  const tierFor = (q: QuestionInfo) => tierOf(deskQuestion(q).tier, tiers);
  // The page's queue order (waitingLists): its first groups, then tier, rank and age.
  const forUser = open.filter(questionWaits).sort((a, b) => waitingFirst(b) - waitingFirst(a)
    || order({ tier: tierFor(a), rank: deskQuestion(a).rank, askedAt: a.askedAt }, { tier: tierFor(b), rank: deskQuestion(b).rank, askedAt: b.askedAt }));
  const pending = store.pendingPermissions().filter((p) => ours(p.sessionId));
  const permsForUser = pending.filter(permissionWaits).sort((a, b) => a.at - b.at);

  const describe = (q: QuestionInfo): string => {
    const v = deskQuestion(q);
    const d = q.details;
    const kind = d?.flowProposal !== undefined ? `workflow proposal ${d.flowProposal}`
      : d?.review ? 'review'
      : d?.refusal ? `${d.refusal.held ? 'held' : 'refused'} call (${d.refusal.toolName})`
      : d?.order ? (d.order.confirm ? 'order to confirm' : 'order: keep it?')
      : 'question';
    const step = d?.run ? `, person step of ${d.run.run} "${oneLine(d.run.runTitle, 60)}" at "${oneLine(d.run.blockTitle, 60)}"${d.run.person ? ` (for ${d.run.person})` : ''}` : '';
    const parts = [`${kind}${step}`, `asked by ${who(q.sessionId)} ${ago(q.askedAt)}`];
    if (v.refs.length) parts.push(`refs ${v.refs.join(', ')}`);
    if (q.aboutQuestion) parts.push(`about question #${q.aboutQuestion}`);
    if (q.aboutRequest) parts.push(`about request ${q.aboutRequest}`);
    return `#${q.id} "${oneLine(v.title || q.question)}": ${parts.join('; ')}`;
  };
  const prompt = (p: PermissionInfo, tail = '') => {
    const s = p.sensitive ? ` [sensitive: ${p.sensitive}]` : '';
    const head = `- request ${p.id} from ${who(p.sessionId)}, ${ago(p.at)}${p.title ? `: ${oneLine(p.title)}` : ''}${s}${tail}`;
    return `${head}\n${indent(i.request(p))}`;
  };

  const out: string[] = [];
  const total = forUser.length + permsForUser.length;
  out.push(total
    ? `Waiting for ${userName} from "${project}": ${total} (as Waiting for you lists them with One project "${project}"; the numbers are its places).`
    : `Nothing from "${project}" is waiting for ${userName}.`);

  // In the page's order (WaitingView): orders to keep, orders to confirm, refused calls, permission prompts, then each tier.
  let place = 0;
  const group = (title: string, qs: QuestionInfo[]) => {
    if (!qs.length) return;
    out.push('', `${title} (${qs.length}):`, ...qs.map((q) => `${++place}. ${describe(q)}`));
  };
  group('Orders from the away time: keep them?', forUser.filter((q) => waitingFirst(q) === 3));
  group('Orders to confirm', forUser.filter((q) => waitingFirst(q) === 2));
  group('Calls refused or held', forUser.filter((q) => waitingFirst(q) === 1));
  if (permsForUser.length) out.push('', `Permission prompts (${permsForUser.length}):`, ...permsForUser.map((p) => prompt(p)));
  const plain = forUser.filter((q) => waitingFirst(q) === 0);
  for (const t of [...tiers, null]) group(t ?? 'Older, without a tier', plain.filter((q) => tierFor(q) === t));

  // What waits for this manager, not the person (Done looks like 2): its sessions' questions and prompts.
  const mineQ = open.filter((q) => q.addressedTo === managerId);
  const mineP = pending.filter((p) => p.addressedTo === managerId).sort((a, b) => a.at - b.at);
  if (mineQ.length || mineP.length) {
    out.push('', `Waiting for you, not ${userName} (${mineQ.length + mineP.length}): from your sessions; answer_question or decide_permission within your grant, else ask ${userName} with about_question or about_request.`);
    for (const q of mineQ) out.push(`- ${describe(q)}`);
    for (const p of mineP) out.push(prompt(p));
  }

  const hours = i.answeredHours ?? ANSWERED_HOURS;
  if (hours > 0) {
    const answered = store.answeredAfter(now - hours * HOUR).filter((q) => q.answeredBy === 'user' && ours(q.sessionId));
    out.push('', answered.length
      ? `Answered by ${userName} in the last ${hours} h (${answered.length}), newest first:`
      : `${userName} answered nothing from "${project}" in the last ${hours} h.`);
    for (const q of answered) {
      const a = (q.answer ?? '').trim();
      const text = a.length > ANSWER_CHARS ? `${a.slice(0, ANSWER_CHARS)}… (${a.length - ANSWER_CHARS} more characters; the whole answer went to the asker)` : a;
      out.push(`- #${q.id} "${oneLine(deskQuestion(q).title || q.question)}", asked by ${who(q.sessionId)}; answered ${ago(q.answeredAt!)}:\n${indent(text)}`);
    }
  }

  if (forUser.some((q) => q.sessionId === managerId)) out.push('', 'withdraw_question withdraws one of yours that is no longer needed.');
  return out.join('\n');
}
