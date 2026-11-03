// Orders on record (issue #105; Martin 2026-11-03, Ledung questions #1273 "a" and #1278 "a — Orders in the goal"). A
// manager attaches an order to start_session or send_message: a command, exactly or as a pattern, and where the person
// said it. Ledung checks the source against its own record: only the person's own words count, the same as for a
// Settings action on their word (settingsOnWord): an answer they gave on this computer to that manager's own question,
// or a message they typed into it on this computer, in the last two days. Then Ledung's PreToolUse hook allows that
// command in the manager and in the session the order went to, which the classifier can't see past: on 2026-11-03 it
// refused an ordered deploy in a session the manager started, because only the manager's transcript held the words.
//
// The page shows every order with its words and source, and the person can cancel it there. While they are away, an
// order recorded during the away period runs only when away mode allows "ordered"; when the period ends, every order
// from it that is not done asks whether it stays ("a failed goal/order couldnt stay forever", question #1278).
import type { Store } from '../store/store.ts';
import type { AwayInfo, ServerEvent } from '../shared/protocol.ts';
import { DROP, KEEP, inForce, sourceText, statusText, type OrderInfo, type OrderSource } from '../shared/orders.ts';
import type { QuestionDetails } from '../shared/questions.ts';
import type { QuestionInfo } from '../shared/protocol.ts';
import { words as plainWords } from './away.ts';
import { exercisedLine } from '../platform/exercised.ts';

/** How far back the person's words count: two days, as for a merge or a Settings action on their word. */
export const WORDS_WINDOW_MS = 2 * 24 * 3600 * 1000;
/** How long a finished order stays on the page. */
export const SHOWN_FINISHED_MS = 24 * 3600 * 1000;

/** The shells an order's command is for. */
const SHELLS = ['Bash', 'PowerShell'];
/** Input fields of a shell call that don't change what runs; any other set field (a sandbox switch, say) is another call. */
const HARMLESS = new Set(['command', 'description', 'timeout', 'run_in_background']);

/** What a manager sends: the command, how it matches, how long it holds, and where the person said it. */
export interface OrderSpec {
  command: string;
  match?: 'exact' | 'pattern';
  until?: 'once' | 'done';
  /** The number of the manager's own question the person answered. */
  question?: number;
  /**
   * Or words the person typed, as they typed them, with the time they typed them ("07:56" or an ISO time). They only
   * find the message: the order records and quotes the whole message.
   */
  typed?: { words: string; at: string };
}

/** The checked source: what Ledung's own record says the person said, and when. */
export interface Attested {
  source: OrderSource;
  words: string;
  wordsAt: number;
}

let exercised = false;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Why the command can't be an order, or null. A pattern must start with a plain word and use only `*`. */
export function commandProblem(command: string, match: 'exact' | 'pattern'): string | null {
  const c = command.trim();
  if (!c) return 'The order has no command.';
  if (c.length > 2000) return 'The command is longer than 2000 characters.';
  if (match === 'exact') return null;
  if (!c.includes('*')) return 'A pattern needs a `*` where any text may stand; for one command, give match "exact".';
  // The program and its first word are the person's, never a wildcard: "*" alone would allow anything.
  if (!/^[^\s*]+\s+[^\s*]/.test(c)) return 'A pattern must start with the program and at least one word of it, plain, before any `*`.';
  if (/[;&|<>`$\\\n\r(){}]/.test(c)) return 'A pattern can only be one plain command: no chaining, pipes, redirects or shell expansions in it.';
  return null;
}

/**
 * Whether the order covers this call: a shell call whose command is exactly the ordered one, or, for a pattern, one
 * plain command (nothing chained, piped, redirected or computed) that the pattern matches in full. Any other set input
 * field makes it another call.
 */
export function covers(o: Pick<OrderInfo, 'command' | 'match'>, toolName: string, input: Record<string, unknown>): boolean {
  if (!SHELLS.includes(toolName) || typeof input.command !== 'string') return false;
  for (const [k, v] of Object.entries(input)) if (!HARMLESS.has(k) && v !== undefined && v !== false && v !== null) return false;
  const command = input.command.trim();
  if (o.match === 'exact') return command === o.command.trim();
  if (!Array.isArray(plainWords(command))) return false;
  const pattern = o.command.trim().split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${pattern}$`).test(command);
}

/** The time a manager gave for typed words: "HH:MM" (the latest such minute in the window) or a full date and time. */
function typedAt(at: string): ((t: number) => boolean) | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (m) return (t) => new Date(t).getHours() === Number(m[1]) && new Date(t).getMinutes() === Number(m[2]);
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return null;
  return (t) => Math.abs(t - ms) < 60_000;
}

/**
 * The person's words the order rests on, checked against Ledung's own record, or why they don't count. Only the
 * person's own words to this manager: an answer to one of its questions, given on this computer and not passed on by
 * a manager, or a message typed into it on this computer (no `from`: Ledung's deliveries and other sessions' words
 * carry one), in the last two days. Ledung's own questions (a refused call, a keep-it) are no source.
 */
export function attest(store: Store, managerId: string, spec: Pick<OrderSpec, 'question' | 'typed'>, now: number): Attested | { error: string } {
  const since = now - WORDS_WINDOW_MS;
  if ((spec.question === undefined) === (spec.typed === undefined)) {
    return { error: 'Give the source of the order as exactly one of: question (the number of your question the person answered) or typed (their words and the time they typed them).' };
  }
  if (spec.question !== undefined) {
    const q = store.getQuestion(spec.question);
    const why = !q || q.sessionId !== managerId ? `question #${spec.question} is not one of your own questions`
      : q.status !== 'answered' || q.answer === null ? `question #${q.id} has no answer`
      : q.answeredBy !== 'user' || q.forwardedFrom !== null ? `question #${q.id} was not answered by the person themself`
      : q.aboutRequest || q.details?.refusal || q.details?.order ? `question #${q.id} is about a single request, not an order`
      : (q.answeredAt ?? 0) <= since ? `the answer to question #${q.id} is more than two days old`
      : !store.answeredHere(q.id) ? `question #${q.id} was not answered on this computer`
      : null;
    if (why) return { error: `Ledung can't attest this order: ${why}.` };
    return { source: { kind: 'question', questionId: q!.id }, words: q!.answer!, wordsAt: q!.answeredAt! };
  }
  const t = spec.typed!;
  const want = squash(t.words ?? '');
  if (want.length < 3) return { error: 'Ledung can\'t attest this order: give the person\'s typed words, as they typed them.' };
  const when = typedAt(t.at ?? '');
  if (!when) return { error: `Ledung can't attest this order: "${t.at}" is not a time; give it as HH:MM, as the message shows it.` };
  const hit = store.listMessages(managerId, { limit: 400 }).reverse()
    .find((m) => m.kind === 'user' && !m.data.from && m.data.here === true && typeof m.data.text === 'string' && m.at > since && when(m.at)
      && squash(m.data.text as string).includes(want));
  if (!hit) {
    return { error: `Ledung can't attest this order: no message the person typed into you on this computer at ${t.at}, in the last two days, has those words.` };
  }
  // The whole message as Ledung has it, never the manager's piece of it: a piece can drop the "Do not" in front
  // (review of PR #107, finding 2). The manager's words only find the message.
  return { source: { kind: 'typed', messageId: hit.id }, words: (hit.data.text as string).trim(), wordsAt: hit.at };
}

/** What the order allows, in a sentence. */
function allowsText(o: Pick<OrderInfo, 'match' | 'until'>, where: 'session' | 'manager'): string {
  const what = o.match === 'exact' ? 'exactly this command' : 'commands that match this pattern in full (`*` is any text; one plain command only)';
  const place = where === 'session' ? 'here and in your manager' : 'in you and in that session';
  return `${what} to run without a prompt, ${place}, ${o.until === 'once' ? 'once' : `until ${where === 'session' ? 'your manager marks' : 'you mark'} the order done`}`;
}

/** A fenced block that the text can't close early. */
function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((s) => s.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

/** What starts the task or message the order goes with: the person's words verbatim, then what Ledung recorded. */
export function orderPreamble(o: OrderInfo, userName: string): string {
  return [
    o.words,
    `— ${userName}'s own words (${sourceText(o)}), checked by Ledung against its own record and recorded as order #${o.id}. It allows ${allowsText(o, 'session')}:`,
    fenced(o.command),
    'Any other command, or this one with anything chained onto it, is asked as usual.',
    '---',
  ].join('\n\n');
}

/** What the manager is told when its order was recorded. */
export function orderRecorded(o: OrderInfo): string {
  return `Order #${o.id} recorded (${sourceText(o)}): it allows ${allowsText(o, 'manager')}. The session's message starts with the person's words. ` +
    `The order shows on the page, where the person can cancel it.${o.until === 'done' ? ' Mark it done with order_done when it is.' : ''}`;
}

/** The note after an ordered call: the words and their source. */
export function orderNote(o: OrderInfo, userName: string): string {
  return `Ledung allowed this call under order #${o.id}: ${userName}'s own words, "${squash(o.words)}" (${sourceText(o)}). Nobody was asked.`;
}

/**
 * The "keep it?" question: at the end of an away period (issue #105, "After away"), or for a once-order whose run never
 * reported back (`lost`, review of PR #107 finding 4).
 */
export function keepQuestion(o: OrderInfo, userName: string, tier: string | undefined, lost?: string): { question: string; options: string[]; details: QuestionDetails } {
  const why = lost ? ` Its run never reported back: ${lost}. It may have run.`
    : o.note ? ` The last ${o.status === 'refused' ? 'refusal' : 'problem'}: ${o.note}.` : o.runs === 0 ? ' It did not run.' : '';
  const title = lost ? `Order #${o.id}'s run never reported back: keep it?` : `Order #${o.id} was not done while you were away: keep it?`;
  const issue = [
    `Your order, in your own words (${sourceText(o)}):`,
    o.words.split('\n').map((l) => `> ${l}`).join('\n'),
    `It allows ${o.match === 'exact' ? 'exactly this command' : 'commands of this pattern'}, ${o.until === 'once' ? 'once' : 'until it is marked done'}:`,
    fenced(o.command),
    `**Not done.**${why} Ran ${o.runs} time${o.runs === 1 ? '' : 's'}.`,
    `**${KEEP}** puts it back in force: your manager goes on with it as the top item. **${DROP}** ends it; nothing more runs under it. Until you answer, it allows nothing (waiting on your word).`,
  ].join('\n\n');
  return { question: `**${title}**\n\n${issue}`, options: [KEEP, DROP], details: { title, issue, ...(tier ? { tier } : {}), rank: 0, order: { orderId: o.id } } };
}

/** What the manager is told when the person answered a keep-it question. */
export function keepAnswerText(q: QuestionInfo, o: OrderInfo | undefined, userName: string): string {
  const a = (q.answer ?? '').trim();
  const head = `${userName} answered Ledung's question #${q.id} about order #${q.details!.order!.orderId}`;
  if (!o) return `${head}, which no longer exists: ${a}`;
  if (a.startsWith(KEEP)) return `${head}: keep it. Order #${o.id} is open again and is your top item; it allows ${allowsText(o, 'manager')}:\n\n${fenced(o.command)}${note(a, KEEP)}`;
  if (a.startsWith(DROP)) return `${head}: drop it. Order #${o.id} is dropped; nothing more runs under it.${note(a, DROP)}`;
  return `${head} without keeping or dropping it, so it stays waiting on their word and allows nothing:\n\n${a}`;
}

const note = (answer: string, button: string) => {
  const n = answer.slice(button.length).replace(/^\s*Note:\s*/, '').trim();
  return n ? `\n\nTheir note: ${n}` : '';
};

export interface OrdersOptions {
  store: Store;
  userName: string;
  publish: (event: ServerEvent) => void;
  /** The first of the project's question tiers, for a keep-it question. */
  tierOf: (managerId: string) => string | undefined;
  /** A note to a session from Ledung, and a wake. */
  tell: (sessionId: string, text: string) => void;
}

/** The record of orders: kept in the database, so a restart neither loses nor repeats one. */
export class Orders {
  private readonly o: OrdersOptions;

  constructor(o: OrdersOptions) {
    this.o = o;
  }

  /** What the page shows: everything not finished, and what finished in the last day. */
  list(now = Date.now()): OrderInfo[] {
    return this.o.store.ordersForPage(now - SHOWN_FINISHED_MS);
  }

  private changed(): void {
    this.o.publish({ type: 'orders', orders: this.list() });
  }

  /**
   * Checks and records an order (before its session exists, for start_session: `sessionId` null, attached later).
   * Returns why it is refused instead, for the manager.
   */
  record(managerId: string, sessionId: string | null, spec: OrderSpec, away: AwayInfo | null, now = Date.now()): OrderInfo | { error: string } {
    const match = spec.match ?? 'exact';
    const until = spec.until ?? 'once';
    const bad = commandProblem(spec.command ?? '', match);
    if (bad) return { error: `Order refused: ${bad}` };
    const word = attest(this.o.store, managerId, spec, now);
    if ('error' in word) return word;
    const o = this.o.store.addOrder({
      managerId, sessionId: sessionId ?? '', command: spec.command.trim(), match, until, ...word, createdAt: now, awaySince: away?.since ?? null,
    });
    if (sessionId) this.changed();
    return o;
  }

  /** The session start_session made for the order. */
  attach(id: number, sessionId: string): void {
    this.o.store.setOrderSession(id, sessionId);
    this.changed();
  }

  /** start_session failed: the order never was. */
  discard(id: number): void {
    this.o.store.deleteOrder(id);
  }

  /** The order in force for this session that covers this call, if any. */
  covering(sessionId: string, toolName: string, input: Record<string, unknown>): OrderInfo | null {
    if (!SHELLS.includes(toolName)) return null;
    return this.o.store.ordersInForce(sessionId).find((o) => covers(o, toolName, input)) ?? null;
  }

  /** Takes one run of the order; false when it is used up or no longer in force. */
  take(o: OrderInfo, now = Date.now()): boolean {
    const ok = this.o.store.takeOrder(o.id, now);
    if (ok) {
      if (!exercised) {
        exercised = true;
        exercisedLine('EXERCISED #105 an ordered command allowed by the order on record');
      }
      this.changed();
    }
    return ok;
  }

  /** How the run ended: a once-order that ran is done; one that failed may run again, its error noted. */
  ran(id: number, ok: boolean, error: string | null, now = Date.now()): void {
    this.o.store.orderRan(id, ok, ok ? null : (error ?? 'the call failed').slice(0, 300), now);
    this.changed();
  }

  /** Held by away mode (the "ordered" kind off): refused, with the reason, until it runs or the person decides. */
  refused(id: number, reason: string, now = Date.now()): void {
    if (this.o.store.setOrderStatus(id, 'refused', reason, now, ['open', 'refused'])) this.changed();
  }

  /** The manager marks its own order done (order_done). */
  done(managerId: string, id: number, now = Date.now()): string {
    const o = this.o.store.getOrder(id);
    if (!o || o.managerId !== managerId) return `Order #${id} is not one of yours.`;
    if (!inForce(o)) return `Order #${id} is already ${statusText(o, this.o.userName)}.`;
    this.o.store.setOrderStatus(id, 'done', null, now, ['open', 'refused']);
    this.changed();
    return `Order #${id} is done; it allows nothing more.`;
  }

  /** The person cancels an order on the page: dropped, and its manager and session are told. */
  cancel(id: number, now = Date.now()): OrderInfo {
    const o = this.o.store.getOrder(id);
    if (!o) throw new Error(`There is no order #${id}.`);
    const note = `cancelled by ${this.o.userName} on the page at ${hhmm(now)}`;
    if (!this.o.store.setOrderStatus(id, 'dropped', note, now, ['open', 'refused', 'waiting'])) throw new Error(`Order #${id} is already ${statusText(o, this.o.userName)}.`);
    const text = `Ledung: ${this.o.userName} cancelled order #${id} on the page at ${hhmm(now)}. It is dropped: nothing runs under it any more.\n\n${fenced(o.command)}`;
    this.o.tell(o.managerId, text);
    if (o.sessionId && o.sessionId !== o.managerId) this.o.tell(o.sessionId, text);
    this.changed();
    return this.o.store.getOrder(id)!;
  }

  /**
   * The end of an away period (issue #105, "After away"): every order recorded or run in it that is not done now waits
   * on the person's word, asked first in Waiting for you: keep it or drop it. Done ones are shown as done on the page.
   */
  settleAway(since: number, end: number, now = Date.now()): QuestionInfo[] {
    const asked: QuestionInfo[] = [];
    for (const o of this.o.store.ordersBetween(since, end)) {
      if (inForce(o)) asked.push(this.askKeep(o, o.note, now));
    }
    if (asked.length) this.changed();
    return asked;
  }

  /** Puts an order in force to waiting on the person's word, with a keep-it question first in Waiting for you. */
  private askKeep(o: OrderInfo, note: string | null, now: number, lost?: string): QuestionInfo {
    const k = keepQuestion(o, this.o.userName, this.o.tierOf(o.managerId), lost);
    const q = this.o.store.createQuestion({ sessionId: o.managerId, question: k.question, options: k.options, addressedTo: 'user', details: k.details });
    this.o.store.setOrderStatus(o.id, 'waiting', note, now, ['open', 'refused'], q.id);
    this.o.publish({ type: 'question', question: q });
    return q;
  }

  /**
   * A once-order whose run never reported back (review of PR #107, finding 4): the session ended, or Ledung restarted,
   * between the allow and the result. It stays taken, so it would read open and never run again; instead it waits on
   * the person's word, with why. Not given back by itself: the run may have happened, and a deploy shouldn't run twice
   * unasked.
   */
  lost(id: number, reason: string, now = Date.now()): QuestionInfo | null {
    const o = this.o.store.getOrder(id);
    if (!o || o.until !== 'once' || !inForce(o) || !this.o.store.orderTaken(id)) return null;
    const q = this.askKeep(o, `its run never reported back: ${reason}`, now, reason);
    this.changed();
    return q;
  }

  /** At Ledung's start: a once-order still taken has lost its run, whose result went to the Ledung that stopped. */
  recover(now = Date.now()): QuestionInfo[] {
    return this.o.store.takenOnceOrders().map((id) => this.lost(id, 'Ledung restarted while it ran', now)).filter((q) => q !== null);
  }

  /** The person's answer to a keep-it question: Keep puts it back in force, Drop ends it; anything else leaves it waiting. */
  answered(q: QuestionInfo, now = Date.now()): void {
    const id = q.details?.order?.orderId;
    if (id === undefined || q.answeredBy !== 'user' || q.forwardedFrom !== null) return;
    const a = (q.answer ?? '').trim();
    const changed = a.startsWith(KEEP) ? this.o.store.setOrderStatus(id, 'open', null, now, ['waiting'], null)
      : a.startsWith(DROP) ? this.o.store.setOrderStatus(id, 'dropped', `dropped on ${this.o.userName}'s word`, now, ['waiting'], null)
      : false;
    if (changed) this.changed();
  }
}
