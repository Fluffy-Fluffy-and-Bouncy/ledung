// A project's archived sessions (idle stop and archive): out of the sidebar, nothing deleted.
// Resume brings one back (and unarchives it); Unarchive puts it back in the sidebar, still ended.
import type { Overview, SessionInfo } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { formatTokens } from '../usage/charts.tsx';
import { formatTime } from './MessageList.tsx';

export function ArchivedView(props: {
  title: string;
  sessions: SessionInfo[];
  overview: Overview | null;
  run: (action: () => Promise<unknown>) => Promise<void>;
  onOpenSession: (id: string) => void;
}) {
  const sessions = [...props.sessions].sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
  return (
    <div className="waiting-view">
      <header className="session-head">
        <div className="session-head-text">
          <h2>Archived · {props.title}</h2>
          <div className="muted">{sessions.length ? `${sessions.length} archived; nothing is deleted. Writing to one resumes it.` : 'No archived sessions.'}</div>
        </div>
      </header>
      <div className="waiting-list">
        {sessions.map((s) => {
          const tokens = props.overview?.sessions[s.id]?.total;
          return (
            <div key={s.id} className="archived-row">
              <div className="archived-text">
                <button className="link" onClick={() => props.onOpenSession(s.id)}>{s.title}</button>
                <div className="muted">
                  {s.endedAt ? `ended ${formatTime(s.endedAt)}` : 'ended'}
                  {s.endReason ? ` · ${s.endReason}` : ''}
                  {tokens ? ` · ${formatTokens(tokens)}` : ''}
                </div>
              </div>
              <div className="archived-actions">
                {s.claudeSessionId && <button className="primary" onClick={() => props.run(() => api.resume(s.id))}>Resume</button>}
                <button onClick={() => props.run(() => api.unarchive(s.id))}>Unarchive</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
