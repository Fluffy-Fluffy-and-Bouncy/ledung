// Usage → Sessions, once the Overview (step 5; moved into Usage by issue #400, Martin's answer to Ledung question
// #393): where every live session stands, without opening a chat. Grouped by manager; on a phone each session is a card.
import { projectLabel, type MachineInfo, type Overview, type SessionInfo } from '../../../src/shared/protocol.ts';
import { formatBytes, formatCores, PRIORITY_LABEL } from './MachinePanel.tsx';
import { formatTime } from '../components/MessageList.tsx';
import { STATUS_LABEL, statusLook } from '../sessionStatus.ts';
import { formatCost, formatTokens, pct, prLabel } from './charts.tsx';
import { contextSize } from '../../../src/shared/context-size.ts';

const STATUS: Record<SessionInfo['status'], string> = { ...STATUS_LABEL, waiting: 'Needs an answer' };

export function contextShare(s: SessionInfo): number | null {
  return s.contextTokens && s.contextWindow ? s.contextTokens / s.contextWindow : null;
}

export function SessionsTab(props: {
  sessions: SessionInfo[];
  overview: Overview | null;
  machine: MachineInfo | null;
  waitingBySession: Record<string, number>;
  onOpenSession: (id: string) => void;
}) {
  const ids = new Set(props.sessions.map((s) => s.id));
  // Ended sessions are left out; a manager stays while any of its sessions runs.
  const live = (s: SessionInfo) => s.status !== 'ended';
  const top = props.sessions.filter((s) => (!s.parentId || !ids.has(s.parentId)) && (live(s) || props.sessions.some((c) => c.parentId === s.id && live(c))));
  const order = (a: SessionInfo, b: SessionInfo) => Number(b.role === 'manager') - Number(a.role === 'manager') || b.createdAt - a.createdAt;
  const rows = top.sort(order).flatMap((s) => [s, ...props.sessions.filter((c) => c.parentId === s.id && live(c)).sort(order)]);
  const ended = props.sessions.filter((s) => s.status === 'ended').length;

  return (
    <div className="overview">
      <div className="overview-list">
        <div className="muted">
          {props.overview ? `${formatTokens(props.overview.todayTokens)} tokens today` : ''}
          {ended ? ` · ${ended} ended session${ended === 1 ? '' : 's'} not shown` : ''}
        </div>
        {!rows.length && <p className="muted">No sessions are running.</p>}
        {rows.map((s) => {
          const u = props.overview?.sessions[s.id];
          const ctx = contextShare(s);
          const child = !!s.parentId && ids.has(s.parentId);
          return (
            // A clickable panel rather than a button: it contains links (pull request, tickets).
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              className={`overview-card${child ? ' child' : ''}`}
              onClick={() => props.onOpenSession(s.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onOpenSession(s.id); } }}
            >
              <div className="overview-top">
                <span className={`dot ${statusLook(s)}`} />
                <span className="overview-title">{s.role === 'manager' && <span className="chip">Manager</span>} {s.title}</span>
                {props.waitingBySession[s.id] ? <span className="badge">{props.waitingBySession[s.id]}</span> : null}
              </div>
              <div className="overview-facts">
                <span>
                  {STATUS[s.status]}
                  {props.machine && props.machine.line.includes(s.id) ? `: number ${props.machine.line.indexOf(s.id) + 1}` : ''}
                  {s.paused ? ' · paused' : ''}
                </span>
                {s.priority !== 'normal' && <span className={`chip prio-${s.priority}`} title={s.priorityNote ?? undefined}>{PRIORITY_LABEL[s.priority]}</span>}
                {props.machine?.sessions[s.id] && (
                  <span title="CPU and memory of everything this session runs">
                    {formatCores(props.machine.sessions[s.id]!.cores)} · {formatBytes(props.machine.sessions[s.id]!.memBytes)}
                  </span>
                )}
                <span>{projectLabel(s.project)}</span>
                {s.branch && <span className="mono">{s.branch}</span>}
                {s.pr && (
                  <a href={s.pr.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} title={`${s.pr.title} — checks ${s.pr.checks}`}>
                    {prLabel(s.pr)}
                  </a>
                )}
                {s.tickets.map((t) => (
                  <a key={t.id} href={t.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{t.id}</a>
                ))}
                {u && <span title="Tokens today / in total">{formatTokens(u.today)} today · {formatTokens(u.total)} total · {formatCost(u.costTotal)}</span>}
                {/* The size as the prompt line says it, after how full it is, so the large sessions show (issue #405). */}
                {s.contextTokens != null && (
                  <span className={ctx != null && ctx > 0.8 ? 'ctx-high' : ''} title="How full the context window is, and its size in tokens">
                    context {ctx != null ? `${pct(ctx)} · ` : ''}{contextSize(s.contextTokens, s.contextWindow)}
                  </span>
                )}
                {s.backgroundTasks > 0 && <span>{s.backgroundTasks} in background</span>}
              </div>
              {u?.lastReply && (
                <div className="overview-last">
                  <span className="muted">{u.lastReplyAt ? formatTime(u.lastReplyAt) : ''}</span> {u.lastReply.split('\n')[0]}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
