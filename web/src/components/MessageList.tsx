// A session's history, from Ledung's own copy of every message (want 10), each with its time (want 9).
// Technical messages (tool calls, results, turn summaries) can be hidden per session (want 8).
import { memo, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { PermissionInfo, QuestionInfo, ShellBlock, StoredMessage } from '../../../src/shared/protocol.ts';
import { shellFooter } from '../../../src/shared/bang.ts';
import { quietTexts, type TurnEntry } from '../../../src/shared/quiet-reply.ts';
import { compactedLabel } from '../../../src/shared/compact-label.ts';
import { cutChars, cutNote } from '../../../src/shared/cut-note.ts';
import { withoutContextSentence } from '../../../src/shared/delivery.ts';
import { boardPostMark, isBoardPostTool, deliveryParts } from '../boardMarks.ts';
import { BoardPostCard } from './BoardViews.tsx';
import { Markdown } from './Markdown.tsx';
import { PermissionCard } from './PermissionCard.tsx';
import { QuestionCard } from './QuestionCard.tsx';
import { toolSummary } from './ToolPreview.tsx';
import { distanceFromBottom, isStuck, restoredScrollTop } from '../scrollAnchor.ts';
import { insertByTime, shownWoven, wovenQuestions } from '../conversation.ts';

type Item =
  | { key: string; at: number; type: 'user'; text: string; byLedung: boolean; context: string | null }
  | { key: string; at: number; type: 'question'; questionId: number }
  | { key: string; at: number; type: 'assistant'; text: string; sub: boolean; quiet?: boolean; anchor?: number }
  | { key: string; at: number; type: 'event'; text: string }
  | { key: string; at: number; type: 'shell'; block: ShellBlock }
  | { key: string; at: number; type: 'divider'; text: string }
  | { key: string; at: number; type: 'tool'; name: string; input: Record<string, any>; result: ToolResult | null; sub: boolean }
  | { key: string; at: number; type: 'permission'; permissionId: string; toolName: string; input: Record<string, any> }
  | { key: string; at: number; type: 'note'; text: string; technical: boolean };

interface ToolResult {
  text: string;
  isError: boolean;
  /** Characters Ledung did not store of it (issue #349); 0: stored whole. */
  cut: number;
}

export function formatTime(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

function toItems(messages: StoredMessage[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { type: 'tool' }>>();
  for (const m of messages) {
    const base = { at: m.at };
    if (m.kind === 'user') items.push({ ...base, key: `${m.id}`, type: 'user', text: m.data.text, byLedung: m.data.from === 'ledung' || !!m.data.answerTo, context: m.data.context ?? null });
    else if (m.kind === 'question') items.push({ ...base, key: `${m.id}`, type: 'question', questionId: m.data.questionId });
    else if (m.kind === 'event') items.push({ ...base, key: `${m.id}`, type: 'event', text: m.data.text });
    else if (m.kind === 'shell') items.push({ ...base, key: `${m.id}`, type: 'shell', block: m.data });
    else if (m.kind === 'permission') {
      items.push({ ...base, key: `${m.id}`, type: 'permission', permissionId: m.data.permissionId, toolName: m.data.toolName, input: m.data.input });
    } else if (m.kind === 'sdk') {
      const s = m.data;
      const sub = s.parent_tool_use_id != null;
      if (s.type === 'assistant') {
        let anchored = false;
        (s.message?.content ?? []).forEach((b: any, i: number) => {
          if (b.type === 'text' && b.text.trim()) {
            // The message's first text is where an attached reply's link lands (issue #369).
            items.push({ ...base, key: `${m.id}.${i}`, type: 'assistant', text: b.text, sub, ...(anchored ? {} : { anchor: m.id }) });
            anchored = true;
          }
          if (b.type === 'tool_use') {
            const item = { ...base, key: `${m.id}.${i}`, type: 'tool' as const, name: b.name, input: b.input ?? {}, result: null, sub };
            tools.set(b.id, item);
            items.push(item);
          }
        });
      } else if (s.type === 'user' && Array.isArray(s.message?.content)) {
        for (const b of s.message.content) {
          const tool = b.type === 'tool_result' ? tools.get(b.tool_use_id) : undefined;
          if (tool) tool.result = { text: resultText(b.content), isError: !!b.is_error, cut: cutChars(b) };
        }
      } else if (s.type === 'system' && s.subtype === 'init') {
        items.push({ ...base, key: `${m.id}`, type: 'note', technical: true, text: `Claude Code ${s.claude_code_version} · ${s.model} · ${s.cwd}` });
      } else if (s.type === 'system' && s.subtype === 'compact_boundary') {
        items.push({ ...base, key: `${m.id}`, type: 'divider', text: `${compactedLabel(s.compact_metadata)} Everything above stays here, but the session itself now only has a summary of it.` });
      } else if (s.type === 'system' && s.subtype === 'task_notification') {
        items.push({ ...base, key: `${m.id}`, type: 'note', technical: true, text: `Background task ${s.status ?? 'finished'}: ${s.summary ?? s.task_id ?? ''}` });
      } else if (s.type === 'result') {
        const secs = s.duration_ms ? ` in ${(s.duration_ms / 1000).toFixed(0)} s` : '';
        if (s.subtype === 'success') {
          if (s.num_turns > 0) items.push({ ...base, key: `${m.id}`, type: 'note', technical: true, text: `Turn finished${secs}` });
        } else {
          const why = s.subtype === 'error_during_execution' ? 'Turn stopped' : `Turn ended: ${String(s.subtype).replace(/_/g, ' ')}`;
          items.push({ ...base, key: `${m.id}`, type: 'note', technical: false, text: why });
        }
      }
    }
  }
  // The short line forced after ask_user repeats the question card: hidden like technical messages.
  const entries: TurnEntry[] = items.map((it) =>
    it.type === 'assistant' ? { kind: 'text', text: it.text, sub: it.sub }
      : it.type === 'tool' ? { kind: 'tool', name: it.name, sub: it.sub }
      : it.type === 'user' || it.type === 'note' ? { kind: 'end' }
      : { kind: 'other' });
  const quiet = quietTexts(entries);
  items.forEach((it, i) => {
    if (it.type === 'assistant' && quiet.has(i)) it.quiet = true;
  });
  return items;
}

type Decision = { behavior: string; by: string; message: string | null; scope?: string | null; at: number };

function decisionsFrom(messages: StoredMessage[]): Map<string, Decision> {
  const map = new Map();
  for (const m of messages) if (m.kind === 'decision') map.set(m.data.permissionId, { ...m.data, at: m.at });
  return map;
}

const DECIDED: Record<string, string> = { allowed: 'Allowed', denied: 'Denied', cancelled: 'Withdrawn' };

export const MessageList = memo(function MessageList(props: {
  messages: StoredMessage[];
  permissions: Record<string, PermissionInfo>;
  showTechnical: boolean;
  hasEarlier: boolean;
  onLoadEarlier: () => void;
  /** Opens a file link from a message in the file viewer. */
  onOpenFile?: (path: string) => void;
  questions: Record<number, QuestionInfo>;
  userName: string;
  /** Puts a message into the message box as a quote (want 11). */
  onQuote?: (who: string, at: number, text: string) => void;
  titleOf?: (id: string) => string;
  /** The session whose history this is. */
  sessionId?: string;
  /** A question to scroll to and highlight, from Go to conversation (issue #61). */
  focusQuestion?: number | null;
  /** A message to scroll to and highlight, from an attached reply's link (issue #369). */
  focusMessage?: number | null;
  /** Opens a question in Waiting for you. */
  onOpenQuestion?: (id: number) => void;
  /** Opens a board thread of this conversation's project in the Board view; none: the project has no board. */
  onOpenBoardThread?: (threadId: string) => void;
  /** The session's name colour (issue #269): its own messages get the message box's tint; undefined: no tint. */
  tint?: CSSProperties;
}) {
  const { messages, permissions, showTechnical, sessionId, hasEarlier } = props;
  // A manager's conversation also shows the questions of its sessions it handles, by when they were asked (issue #61),
  // with technical messages or when opened at one (issue #112).
  const earliest = hasEarlier ? messages[0]?.at ?? null : null;
  const base = useMemo(() => toItems(messages), [messages]);
  const focus = props.focusQuestion ?? null;
  const woven = useMemo(
    () => (sessionId ? shownWoven(wovenQuestions(Object.values(props.questions), sessionId, earliest), showTechnical, focus) : []),
    [props.questions, sessionId, earliest, showTechnical, focus],
  );
  const items = useMemo(
    () => insertByTime(base, woven.map((q): Item => ({ key: `q${q.id}`, at: q.askedAt, type: 'question', questionId: q.id }))),
    [base, woven],
  );
  const decisions = useMemo(() => decisionsFrom(messages), [messages]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** The question already scrolled to, so later messages don't pull the view away again or back to it. */
  const focused = useRef<string | null>(null);
  const focusMessage = props.focusMessage ?? null;
  const target = focus !== null ? `#qc-${focus}` : focusMessage !== null ? `#mc-${focusMessage}` : null;
  /** The first message "Load earlier" was asked from while looking for the question, so it is asked once per batch. */
  const loadingFrom = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Only once the history is in: before that the cards of other sessions are all there is, and the place would be lost.
    if (target !== null && focused.current !== target && messages.length > 0) {
      const card = el.querySelector(target);
      if (card) {
        focused.current = target;
        stick.current = false;
        card.scrollIntoView({ block: 'center' });
        return;
      }
      // Not loaded yet: load earlier messages until it is, or there are none left.
      const first = messages[0]?.id ?? null;
      if (first !== null && hasEarlier && loadingFrom.current !== first) {
        loadingFrom.current = first;
        props.onLoadEarlier();
      }
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [items, showTechnical, target, hasEarlier]);

  useEffect(() => {
    // A conversation opened at a question stays there; any other opens at its end.
    stick.current = focused.current === null;
  }, [messages.length === 0]);

  // Moving the tab to another window or rotating a phone resizes the scroller, briefly to no height; keep the reader's place.
  const distance = useRef(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (el.clientHeight <= 0) return;
      el.scrollTop = restoredScrollTop(stick.current, distance.current, el.scrollHeight, el.clientHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className="messages"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        const d = distanceFromBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
        if (d === null) return;
        distance.current = d;
        stick.current = isStuck(d);
      }}
    >
      {props.hasEarlier && (
        <button className="load-earlier" onClick={props.onLoadEarlier}>Load earlier messages</button>
      )}
      {items.map((item) => (
        <MessageItem
          key={item.key}
          item={item}
          showTechnical={showTechnical}
          userName={props.userName}
          tint={props.tint}
          sessionId={sessionId}
          onQuote={props.onQuote}
          onOpenFile={props.onOpenFile}
          onOpenBoardThread={props.onOpenBoardThread}
          onOpenQuestion={props.onOpenQuestion}
          titleOf={item.type === 'question' || item.type === 'permission' ? props.titleOf : undefined}
          question={item.type === 'question' ? props.questions[item.questionId] : undefined}
          focused={item.type === 'question' ? item.questionId === focus : item.type === 'assistant' && item.anchor !== undefined && item.anchor === focusMessage}
          live={item.type === 'permission' ? permissions[item.permissionId] : undefined}
          decision={item.type === 'permission' ? decisions.get(item.permissionId) : undefined}
        />
      ))}
    </div>
  );
});

interface ItemProps {
  item: Item;
  showTechnical: boolean;
  userName: string;
  tint?: CSSProperties;
  sessionId?: string;
  onQuote?: (who: string, at: number, text: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenBoardThread?: (threadId: string) => void;
  onOpenQuestion?: (id: number) => void;
  titleOf?: (id: string) => string;
  /** The question of a question item, as it is now. */
  question?: QuestionInfo;
  /** A question item's question is the one to scroll to (issue #61), or an assistant item's message is (issue #369). */
  focused: boolean;
  /** A permission item's live request, while there is one. */
  live?: PermissionInfo;
  /** A permission item's decision, once made. */
  decision?: Decision;
}

/** Same keys with the same values; a tool's result one level down, since each history rebuild makes it anew. */
function sameFields(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length
    && keys.every((k) => x[k] === y[k] || (k === 'result' && sameFields(x[k] as object | undefined, y[k] as object | undefined)));
}

/**
 * The history's items are built anew whenever a message arrives; a message is redrawn only when what it shows
 * changed (issue #323), not on every new message or key press.
 */
function sameItem(a: ItemProps, b: ItemProps): boolean {
  const keys = Object.keys(a) as (keyof ItemProps)[];
  return keys.length === Object.keys(b).length
    && keys.every((k) => (k === 'item' || k === 'decision' ? sameFields(a[k], b[k]) : a[k] === b[k]));
}

const MessageItem = memo(function MessageItem(props: ItemProps) {
  const { item, showTechnical, sessionId } = props;
  const time = <time className="time">{formatTime(item.at)}</time>;
  const quote = (who: string, text: string) =>
    props.onQuote && (
      <button className="quote-button" title="Quote this message in your reply" onClick={() => props.onQuote!(who, item.at, text)}>
        Quote
      </button>
    );
  switch (item.type) {
    case 'user': {
      // Ledung's fixed sentence is for the model, not the reader (issue #64): shown only with technical
      // messages. A delivery with nothing else in its user text shows the delivered content as its body,
      // without the user's colour since none of it is the user's words.
      const text = item.byLedung && !showTechnical ? withoutContextSentence(item.text) : item.text;
      const body = text || item.context || '';
      // Board posts in a delivery get their own marked cards: who sent it, in which thread. The rest of a
      // delivery with no words from the user shows only with technical messages (issue #94).
      const segments = deliveryParts(item.byLedung, text, item.context, showTechnical);
      if (segments && !segments.length) return null;
      if (segments?.some((s) => s.type === 'board')) {
        return (
          <div className="board-delivery">
            {segments.map((s, i) => s.type === 'board'
              ? <BoardPostCard key={i} mark={s.mark} time={time} onOpenThread={props.onOpenBoardThread} />
              : (
                <div key={i} className="msg delivery answer">
                  <div className="msg-meta"><span className="who">Delivered by Ledung</span>{time}</div>
                  <div className="msg-body plain">{s.text}</div>
                </div>
              ))}
          </div>
        );
      }
      return (
        <div className={`msg ${text ? 'user' : 'delivery'}${item.byLedung ? ' answer' : ''}`}>
          <div className="msg-meta">
            <span className="who">{item.byLedung ? 'Delivered by Ledung' : props.userName}</span>
            {time}
            {quote(item.byLedung ? 'Ledung' : props.userName, body)}
          </div>
          <div className="msg-body plain">{body}</div>
          {item.context && text && (
            <details className="delivered-context">
              <summary>Attached context (not from {props.userName})</summary>
              <div className="plain">{item.context}</div>
            </details>
          )}
        </div>
      );
    }
    case 'assistant':
      if ((item.sub || item.quiet) && !showTechnical) return null;
      return (
        <div
          id={item.anchor !== undefined ? `mc-${item.anchor}` : undefined}
          className={`msg assistant${item.sub ? ' sub' : ''}${props.tint ? ' tinted' : ''}${props.focused ? ' focus' : ''}`}
          style={props.tint}
        >
          <div className="msg-meta">
            <span className="who">{item.sub ? 'Subagent' : 'Claude'}</span>
            {time}
            {quote(item.sub ? 'Subagent' : 'Claude', item.text)}
          </div>
          <div className="msg-body"><Markdown text={item.text} onOpenFile={props.onOpenFile} /></div>
        </div>
      );
    case 'event':
      return <div className="event">{item.text} {time}</div>;
    // A "!" command and its output, as Claude got it (issue #212).
    case 'shell': {
      const b = item.block;
      const footer = shellFooter(b);
      return (
        <div className="msg user shell">
          <div className="msg-meta"><span className="who">{props.userName} ran</span>{time}</div>
          <pre className="shell-output"><span className="shell-command">$ {b.command}</span>{b.stdout ? `
${b.stdout.replace(/\s+$/, '')}` : ''}{b.stderr ? <span className="shell-stderr">{`
${b.stderr.replace(/\s+$/, '')}`}</span> : null}</pre>
          <div className={`shell-footer${footer.problem ? ' problem' : ''}`}>{footer.text}</div>
        </div>
      );
    }
    case 'question': {
      const q = props.question;
      if (!q) return null;
      return (
        <QuestionCard
          question={q}
          userName={props.userName}
          onOpenFile={props.onOpenFile}
          titleOf={props.titleOf}
          from={sessionId && q.sessionId !== sessionId ? props.titleOf?.(q.sessionId) ?? 'another session' : undefined}
          focus={props.focused}
          onOpenInDesk={props.onOpenQuestion && (() => props.onOpenQuestion!(q.id))}
        />
      );
    }
    case 'divider':
      return <div className="divider"><span>{item.text}</span> {time}</div>;
    case 'note':
      if (item.technical && !showTechnical) return null;
      return <div className={`note${item.technical ? ' technical' : ''}`}>{item.text} {time}</div>;
    case 'tool':
      // The manager's own board posts are always shown (marked), not only with the technical messages.
      if (isBoardPostTool(item.name) && !item.sub) {
        const post = boardPostMark(item.input);
        const mark = { kind: 'out' as const, service: '', author: '', project: null, threadId: post.threadId, title: post.title, to: post.to || 'the thread', text: post.text, note: '' };
        return (
          <div className={`board-delivery${item.result?.isError ? ' failed' : ''}`}>
            <BoardPostCard mark={mark} time={time} onOpenThread={props.onOpenBoardThread} />
            {item.result && <div className={`note board-result${item.result.isError ? ' failed' : ''}`}>{item.result.text.slice(0, 400)}</div>}
          </div>
        );
      }
      if (!showTechnical) return null;
      return (
        <details className={`tool${item.result?.isError ? ' failed' : ''}`}>
          <summary>
            <span className="tool-name">{item.name}</span> <span className="tool-summary">{toolSummary(item.name, item.input)}</span> {time}
          </summary>
          <pre className="tool-input">{JSON.stringify(item.input, null, 2)}</pre>
          {item.result && <pre className="tool-result">{item.result.text.slice(0, 20000)}</pre>}
          {item.result && item.result.cut > 0 && <div className="note technical tool-cut">{cutNote(item.result.cut)}</div>}
        </details>
      );
    case 'permission': {
      const live = props.live;
      if (live?.status === 'pending') return <PermissionCard permission={live} managerTitle={props.titleOf?.(live.addressedTo)} />;
      const d = props.decision;
      if (!showTechnical && d?.behavior !== 'denied') return null;
      const by = d && d.by !== 'user' && d.by !== 'simon' && d.by !== 'ledung' ? ` by manager "${props.titleOf?.(d.by) ?? 'manager'}"` : '';
      const label = d ? `${DECIDED[d.behavior] ?? d.behavior}${d.scope === 'session' ? ' for this session' : ''}${by}` : 'Asked';
      return (
        <div className={`note decision ${d?.behavior ?? ''}`}>
          {label}: {item.toolName} <span className="tool-summary">{toolSummary(item.toolName, item.input)}</span>
          {d?.message && d.behavior === 'denied' ? ` (“${d.message}”)` : ''} {time}
        </div>
      );
    }
  }
}, sameItem);
