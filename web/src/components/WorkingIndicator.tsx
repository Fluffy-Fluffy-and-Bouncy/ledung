// The line above the message box that says whether the session is working, waiting for Simon, or done.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SessionInfo, StoredMessage } from '../../../src/shared/protocol.ts';
import { toolSummary } from './ToolPreview.tsx';
import { formatTime } from './MessageList.tsx';
import { SailingShip, shipMode } from './SailingShip.tsx';
import { elevates, UAC_HINT } from '../../../src/shared/elevation.ts';

/**
 * When the current turn started, and what the session is doing right now. uac: its elevated commands raise
 * UAC on the PC, so one that runs may be waiting there for a click (#213).
 */
function currentActivity(messages: StoredMessage[], uac: boolean): { since: number | null; doing: string; uacWait: boolean; finishedAt: number | null } {
  let since: number | null = null;
  let finishedAt: number | null = null;
  const openTools = new Map<string, { label: string; uacWait: boolean }>();
  let lastWasText = false;
  for (const m of messages) {
    if (m.kind === 'user') {
      since = m.at;
      finishedAt = null;
      openTools.clear();
      lastWasText = false;
    }
    if (m.kind !== 'sdk') continue;
    const s = m.data;
    if (s.type === 'assistant' && s.parent_tool_use_id == null) {
      for (const b of s.message?.content ?? []) {
        if (b.type === 'tool_use') {
          const summary = toolSummary(b.name, b.input ?? {});
          openTools.set(b.id, { label: summary ? `${b.name}: ${summary}` : b.name, uacWait: uac && elevates(b.name, b.input ?? {}) });
          lastWasText = false;
        } else if (b.type === 'text' && b.text.trim()) {
          lastWasText = true;
        }
      }
    } else if (s.type === 'user' && Array.isArray(s.message?.content)) {
      for (const b of s.message.content) if (b.type === 'tool_result') openTools.delete(b.tool_use_id);
    } else if (s.type === 'result' && s.num_turns > 0) {
      finishedAt = m.at;
      openTools.clear();
    }
  }
  const last = [...openTools.values()].pop();
  const doing = last ? `Running ${last.label}` : lastWasText ? 'Writing' : 'Thinking';
  return { since, doing, uacWait: !!last?.uacWait, finishedAt };
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** Ended by a failure rather than by someone stopping it: Claude Code exiting with an error or the host dying. */
export function endedWithError(session: SessionInfo): boolean {
  return session.status === 'ended' && /exited with code [1-9]|stopped unexpectedly/.test(session.endReason ?? '');
}

/** extra: drawn at the bar's right end, the session's macro chips (issue #410). */
export function WorkingIndicator({ session, sessions, messages, extra }: { session: SessionInfo; sessions: SessionInfo[]; messages: StoredMessage[]; extra?: ReactNode }) {
  const activity = useMemo(() => currentActivity(messages, !!session.uac), [messages, session.uac]);
  const [now, setNow] = useState(Date.now());
  // 'starting' waits for its first message: not working (#97).
  const active = session.status === 'running' || session.status === 'stopping';
  const childrenWorking = sessions.filter((s) => s.parentId === session.id && s.status === 'running').length;
  const mode = shipMode(session, sessions);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  // One element for every state, so the ship keeps its place and can animate from one state to the next.
  let kind: string;
  let content: ReactNode;
  if (session.status === 'waiting') {
    kind = 'waiting';
    content = 'Waiting for your answer above';
  } else if (active) {
    kind = 'working';
    const label = session.status === 'stopping' ? 'Stopping' : activity.doing;
    content = (
      <>
        <span className="working-label">{label}</span>
        {/* Outside the label, which a long command cuts short. */}
        {session.status === 'running' && activity.uacWait && <span className="uac-hint"> · {UAC_HINT}</span>}
        {session.status === 'running' && activity.since && <span className="muted"> · {elapsed(now - activity.since)}</span>}
      </>
    );
  } else if (session.status === 'starting') {
    kind = 'done';
    content = <span className="working-label">Ready</span>;
  } else if (session.status === 'idle') {
    kind = 'done';
    content = (
      <span className="working-label">
        Done{activity.finishedAt ? ` at ${formatTime(activity.finishedAt)}` : ''}
        {session.backgroundTasks > 0 ? ` · ${session.backgroundTasks} background task(s) still running` : ''}
        {childrenWorking > 0 ? ` · ${childrenWorking} session(s) still working` : ''}
      </span>
    );
  } else if (session.status === 'ended') {
    // Stopped or crashed, the ship goes down either way; the line says which.
    const error = endedWithError(session);
    kind = error ? 'failed' : 'done';
    const at = session.endedAt ? ` at ${formatTime(session.endedAt)}` : '';
    content = (
      <span className="working-label">
        {error ? `Ended with an error${at}` : `Ended${at}${session.endReason ? ` · ${session.endReason.split('\n')[0]}` : ''}`}
      </span>
    );
  } else {
    return null;
  }
  if (!mode) return null;
  return (
    <div className={`status-line ${kind}`} role="status" aria-live="polite">
      <SailingShip mode={mode} />
      {content}
      {extra}
    </div>
  );
}
