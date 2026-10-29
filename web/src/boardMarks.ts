// How the message board shows in the page (docs/steps/message-board.md): the chip in the sidebar and the
// marks on board posts in a manager's chat. Pure helpers, kept apart from the components so they can be tested.
import type { BoardStatus } from '../../src/shared/protocol.ts';

export interface BoardChipView {
  text: string;
  /** ok: green; warn: amber (error, backing off); idle: grey. */
  level: 'ok' | 'warn' | 'idle';
  title: string;
}

/**
 * The page's connection to Ledung, shown as the border of a footer chip instead of a "Connected" word (Martin, Ledung
 * question #397: "Lets keep it at one row but the move the "connected" status, that should be shown by changing the
 * "board"-button boarder from green to red."). Green only while connected; reconnecting counts as down. The border is
 * the connection's, over the board's own colour, so red always means disconnected; the board's state stays in its text.
 */
export function connectionMark(connection: 'connecting' | 'open' | 'closed'): { className: string; text: string } {
  if (connection === 'open') return { className: 'conn-up', text: 'Connected to Ledung.' };
  return { className: 'conn-down', text: connection === 'connecting' ? 'Connecting to Ledung…' : 'Disconnected from Ledung, retrying…' };
}

/**
 * The chip for the sidebar; null when no project names a board (nothing to show). Several repos
 * ("Per project"): the worst state of those some project has on, and the counts added up.
 */
export function boardChip(b: BoardStatus | null | undefined, now = Date.now()): BoardChipView | null {
  if (!b?.configured) return null;
  const on = b.boards.filter((r) => r.state !== 'off');
  const unread = Object.values(b.unread).reduce((n, v) => n + v, 0);
  const ignored = Object.values(b.projects).reduce((n, p) => n + p.ignored.reduce((m, i) => m + i.count, 0), 0);
  const paused = b.boards.reduce((n, r) => n + r.paused.length, 0);
  const counts = [unread ? `${unread} unread` : '', ignored ? `${ignored} ignored` : '', paused ? `${paused} paused` : ''].filter(Boolean);
  const tail = counts.length ? ` · ${counts.join(' · ')}` : '';
  const repos = on.map((r) => r.repo).join(', ');
  const failing = on.filter((r) => r.state === 'error');
  // Not signed in shows on every repo as off with the sign-in sentence.
  const signin = b.boards.find((r) => r.state === 'off' && r.error);
  if (!on.length) return { text: 'Board off', level: 'idle', title: signin?.error ?? 'No project has the board on.' };
  if (failing.length) return { text: `Board: problem${tail}`, level: 'warn', title: `${failing.map((r) => `${r.repo}: ${r.error ?? 'the last check failed.'}`).join(' ')} Trying again.` };
  if (on.some((r) => r.state === 'starting')) return { text: 'Board starting…', level: 'idle', title: `Connecting to ${repos}.` };
  const last = Math.min(...on.map((r) => r.lastPollAt ?? 0));
  const polled = last ? `last checked ${Math.max(0, Math.round((now - last) / 1000))} s ago` : 'not checked yet';
  return { text: `Board${tail}`, level: 'ok', title: `${repos}${b.identity ? ` as @${b.identity}` : ''}; ${polled}.` };
}

/** A board post as the chat shows it. */
export interface BoardMark {
  /** out: this Ledung's manager posted it; ledung: from another Ledung; typed: a person typing on the service. */
  kind: 'out' | 'ledung' | 'typed';
  service: string;
  author: string;
  /** The project the sender's header names, if any. */
  project: string | null;
  threadId: string;
  title: string;
  to: string;
  text: string;
  /** Ledung's own instructions that came with it (not part of the post). */
  note: string;
}

export type DeliverySegment = { type: 'text'; text: string } | { type: 'board'; mark: BoardMark };

const SEPARATOR = '\n\n---\n\n';
// Written by Board.postText (src/board/board.ts): the first line, the post fenced, then Ledung's own note.
const HEAD = /^Board message in thread (\S+) "(.*)", (posted by this Ledung[^\n]*?|from \S+ user [^\n]*?|typed on \S+ by [^\n]*?)\. To: ([^\n]*?)\.\n\n(`{3,})\n/;

function whoOf(who: string): Pick<BoardMark, 'kind' | 'service' | 'author' | 'project'> | null {
  let m = /^posted by this Ledung(?: \(project "(.*?)"\))? as @(\S+)$/.exec(who);
  if (m) return { kind: 'out', service: '', author: m[2]!, project: m[1] ?? null };
  m = /^from (\S+) user @(\S+?)'s Ledung(?: \(project "(.*?)", as its header says\))?;/.exec(who);
  if (m) return { kind: 'ledung', service: m[1]!, author: m[2]!, project: m[3] ?? null };
  m = /^typed on (\S+) by @(\S+?), not through/.exec(who);
  if (m) return { kind: 'typed', service: m[1]!, author: m[2]!, project: null };
  return null;
}

/** One delivered item as a board mark, or null when it isn't a board post. */
export function parseBoardItem(item: string): BoardMark | null {
  const head = HEAD.exec(item);
  if (!head) return null;
  const who = whoOf(head[3]!);
  if (!who) return null;
  const fence = head[5]!;
  const rest = item.slice(head[0].length);
  // The closing fence is the last line of the same length, so a post with fences of its own still ends where Ledung closed it.
  const close = rest.indexOf(`\n${fence}`);
  if (close < 0) return null;
  const after = rest.slice(close + 1 + fence.length);
  if (after && !after.startsWith('\n')) return null;
  return { ...who, threadId: head[1]!, title: head[2]!, to: head[4]!, text: rest.slice(0, close), note: after.trim() };
}

/**
 * A delivery's attached context split into plain text and board posts. Items are separated by a rule line;
 * a post's own text is fenced, so a rule inside it doesn't split it.
 */
export function splitDelivery(context: string): DeliverySegment[] {
  const out: DeliverySegment[] = [];
  const pending: string[] = [];
  const flush = () => {
    if (pending.length) out.push({ type: 'text', text: pending.join(SEPARATOR) });
    pending.length = 0;
  };
  let i = 0;
  while (i <= context.length) {
    const here = context.slice(i);
    const mark = parseBoardWhole(here);
    if (mark) {
      flush();
      out.push({ type: 'board', mark: mark.mark });
      i += mark.length;
      if (i >= context.length) break;
      i += SEPARATOR.length;
      continue;
    }
    const next = here.indexOf(SEPARATOR);
    pending.push(next < 0 ? here : here.slice(0, next));
    if (next < 0) break;
    i += next + SEPARATOR.length;
  }
  flush();
  return out;
}

/**
 * The parts of a message from Ledung that show as a delivery, given the text the chat shows for it (`text`: the
 * fixed sentence already left out unless technical messages are shown); null when it shows as a message with the
 * user's words. A delivery with none of them shows only its board posts and what the session's own manager told it
 * unless technical messages are shown (issue #94; Martin, 2026-10-15 10:23: "hide them … if they contain relevant
 * information we already summarize it in the next message"); empty means nothing shows. The model still receives
 * all of it.
 */
export function deliveryParts(byLedung: boolean, text: string, context: string | null, showTechnical: boolean): DeliverySegment[] | null {
  if (!byLedung || text) return null;
  const segments = splitDelivery(context ?? '');
  return showTechnical ? segments : segments.filter((s) => s.type === 'board' || s.text.split(SEPARATOR).some(fromOwnManager));
}

// A session's task and its manager's later messages (src/sessions/manager.ts, management.ts): nobody sums those up
// in that chat, so they stay (lead's call on #94, question #72). The heading line ends in the words that introduce
// the manager's message, after a sentence on how a clear or compact went (review of PR #95: the compact note
// carries it mid-line). Any item of a text run counts, so a message from the manager is never hidden for sharing
// the run with a hidden one.
const OWN_MANAGER_HEADING = /^(?:.*\. )?(?:Your task, from your manager|Message from your manager)(?: ".*")?:$/;
const fromOwnManager = (item: string) => OWN_MANAGER_HEADING.test(item.split('\n', 1)[0]!);

/** A board item at the start of `text`, found by its fence so a rule line inside the post doesn't cut it. */
function parseBoardWhole(text: string): { mark: BoardMark; length: number } | null {
  const head = HEAD.exec(text);
  if (!head) return null;
  const fence = head[5]!;
  const bodyStart = head[0].length;
  const close = text.indexOf(`\n${fence}`, bodyStart);
  if (close < 0) return null;
  const afterClose = close + 1 + fence.length;
  const end = text.indexOf(SEPARATOR, afterClose);
  const length = end < 0 ? text.length : end;
  const mark = parseBoardItem(text.slice(0, length));
  return mark ? { mark, length } : null;
}

/** "mcp__ledung__board_post" and the like: the manager's own post. */
export const isBoardPostTool = (name: string): boolean => /(^|__)board_post$/.test(name);

/** What a board_post call said, for the chat: where it went and what it was. */
export function boardPostMark(input: Record<string, unknown>): { to: string; title: string; text: string; threadId: string } {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const to = Array.isArray(input.to) ? input.to.map(String).join(', ') : s('to');
  return { to, title: s('title'), text: s('text'), threadId: s('thread') };
}
