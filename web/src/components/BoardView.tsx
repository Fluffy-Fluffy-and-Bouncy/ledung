// The Board view (docs/steps/message-board.md): every thread this Ledung holds, and one thread read like a
// chat. Read-only: nothing is posted from here and nothing is marked read (that stays with the managers).
import { useEffect, useMemo, useState } from 'react';
import type { BoardPostView, BoardStatus, BoardThreadsView, BoardThreadSummary, BoardThreadView, ProjectInfo } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { deliveryMarks, filterThreads, hasUndelivered, NO_FILTERS, senderLabel, threadOpenId, unreadIn, type ThreadFilters } from '../boardView.ts';
import { formatTime } from './MessageList.tsx';
import { imageUrl } from './ProjectImage.tsx';

/** Only a link the server built (https) is followed. */
const safe = (url: string | null): string | null => (url && /^https:\/\//.test(url) ? url : null);

function useBoardData<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null } {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    load().then((data) => live && setState({ data, error: null }), (e: Error) => live && setState((s) => ({ data: s.data, error: e.message })));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/** The filters stay while a thread is open and the list comes back. */
let savedFilters: ThreadFilters = NO_FILTERS;

const short = (people: string[]) => (people.length > 4 ? `${people.slice(0, 4).join(', ')} +${people.length - 4}` : people.join(', '));

export function BoardListView(props: { board: BoardStatus | null; onOpen: (id: string) => void; onOpenSettings: () => void }) {
  // The page pushes the board's status after every check and delivery, so the list follows it.
  const { data, error } = useBoardData<BoardThreadsView>(() => api.boardThreads(), [props.board]);
  const [filters, setFilters] = useState<ThreadFilters>(savedFilters);
  const change = (f: Partial<ThreadFilters>) => setFilters((old) => (savedFilters = { ...old, ...f }));
  const projects = useMemo(() => Object.keys(props.board?.projects ?? {}).filter((n) => props.board!.projects[n]!.repo).sort(), [props.board]);
  const repos = (props.board?.boards ?? []).map((b) => b.repo);
  const shown = useMemo(() => filterThreads(data?.threads ?? [], filters), [data, filters]);
  const filtered = filters.project || filters.repo || filters.unreadOnly || filters.notDelivered;

  return (
    <div className="waiting-view board-view">
      <header className="session-head">
        <div className="session-head-text">
          <h2>Board</h2>
          <div className="muted">Read-only. The managers' messages with other people's Ledungs, newest first. Looking here posts nothing and marks nothing read.</div>
        </div>
        <div className="session-corner"><button className="small" onClick={props.onOpenSettings}>Board settings</button></div>
      </header>
      <div className="board-filters" role="group" aria-label="Filter threads">
        {projects.length > 1 && (
          <label>Project
            <select value={filters.project} onChange={(e) => change({ project: e.target.value })}>
              <option value="">All projects</option>
              {projects.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
        {repos.length > 1 && (
          <label>Board
            <select value={filters.repo} onChange={(e) => change({ repo: e.target.value })}>
              <option value="">All boards</option>
              {repos.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        )}
        <label className="toggle"><input type="checkbox" checked={filters.unreadOnly} onChange={(e) => change({ unreadOnly: e.target.checked })} /> Unread only</label>
        <label className="toggle" title="Threads with a post that reached no manager: dropped (sender not allowed), refused by a project's allowlist, or for nobody's inbox"><input type="checkbox" checked={filters.notDelivered} onChange={(e) => change({ notDelivered: e.target.checked })} /> Not delivered</label>
        {filtered && <button className="small" onClick={() => { savedFilters = NO_FILTERS; setFilters(NO_FILTERS); }}>Clear filters</button>}
      </div>
      <div className="waiting-list board-list">
        {error && <p className="board-error">{error}</p>}
        {!data && !error && <p className="muted">Reading the board…</p>}
        {data && shown.length === 0 && <p className="muted">{filtered ? 'No thread matches these filters.' : 'No threads yet. Posts from the board appear here once Ledung has seen them.'}</p>}
        {shown.map((t) => <ThreadCard key={`${t.repo}#${t.id}`} t={t} filters={filters} onOpen={props.onOpen} showRepo={repos.length > 1} />)}
        {data?.truncated && <p className="muted">Only the {data.threads.length} most recent threads are listed.</p>}
      </div>
    </div>
  );
}

function ThreadCard({ t, filters, onOpen, showRepo }: { t: BoardThreadSummary; filters: ThreadFilters; onOpen: (id: string) => void; showRepo: boolean }) {
  const unread = unreadIn(t, filters.project);
  const flags = [
    t.dropped ? `${t.dropped} dropped (sender not allowed)` : '',
    t.refused ? `${t.refused} refused by a project's allowlist` : '',
    t.unsent ? `${t.unsent} reached no manager` : '',
  ].filter(Boolean);
  const last = t.last;
  const who = last ? (last.mine ? `${last.fromProject ?? 'this Ledung'}` : last.viaLedung ? `@${last.author}'s Ledung` : `@${last.author}`) : '';
  return (
    <button className={`board-thread-card${unread ? ' unread' : ''}`} onClick={() => onOpen(threadOpenId(t.repo, t.id))}>
      <span className="board-thread-top">
        <span className="board-thread-title">{unread > 0 && <span className="unread-dot" aria-label="unread" />}{t.onlyDropped ? `Thread ${t.id} (dropped posts only)` : t.title}</span>
        <span className="muted board-thread-time">{formatTime(t.updatedAt)}</span>
      </span>
      <span className="board-thread-meta muted">
        <span className="mono">{showRepo ? `${t.repo} #${t.id}` : `#${t.id}`}</span>
        {t.participants.length > 0 && <> · {short(t.participants)}</>}
      </span>
      <span className="board-thread-chips">
        {unread > 0 && <span className="chip accent">{unread} unread</span>}
        {t.projects.map((p) => <span key={p} className="chip">{p}</span>)}
        {flags.map((f) => <span key={f} className="chip warn">{f}</span>)}
      </span>
      {last && <span className="board-thread-last"><strong>{who}:</strong> {last.text || '(empty)'}</span>}
    </button>
  );
}

export function BoardThreadPage(props: { repo: string; id: string; board: BoardStatus | null; projects: ProjectInfo[]; onOpen: (id: string) => void; onBack: () => void }) {
  const { data, error } = useBoardData<BoardThreadView>(() => api.boardThread(props.repo, props.id), [props.repo, props.id, props.board]);
  const managerOf = (project: string) => props.projects.find((p) => p.name === project)?.managerId ?? null;
  const url = safe(data?.url ?? null);
  return (
    <div className="waiting-view board-view">
      <header className="session-head">
        <div className="session-head-text">
          <h2>{data && !data.missing ? data.title : `Thread ${props.id}`}</h2>
          <div className="muted"><span className="mono">{props.repo} #{props.id}</span>{data && data.participants.length > 0 && <> · {short(data.participants)}</>}</div>
        </div>
        <div className="session-corner">
          <button className="small" onClick={props.onBack}>← Board</button>
        </div>
      </header>
      <div className="waiting-list board-thread-page">
        <p className="muted board-readonly">
          Read-only: nothing is posted from here and opening this does not mark anything read.
          {url && <> <a href={url} target="_blank" rel="noopener noreferrer">Open the thread on {data?.service ?? 'the board'}</a>.</>}
        </p>
        {error && <p className="board-error">{error}</p>}
        {!data && !error && <p className="muted">Reading the thread…</p>}
        {data?.missing && <p className="muted">Ledung holds no posts of this thread. It may be older than the board's first check here, or on a board no project here uses.</p>}
        {data?.truncated && <p className="muted">Only the latest {data.posts.length} posts are shown.</p>}
        {data?.posts.map((p) => <PostCard key={p.id} p={p} service={data.service} managerOf={managerOf} onOpen={props.onOpen} />)}
      </div>
    </div>
  );
}

/** A post's evidence files: images as thumbnails that open full size, the rest by name and why it isn't here. */
function Attachments({ files }: { files: BoardPostView['attachments'] }) {
  return (
    <ul className="board-attachments">
      {files.map((a, i) => {
        const size = a.size >= 1048576 ? `${(a.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(a.size / 1024))} KB`;
        const label = `${a.name} · ${a.kind === 'text' ? 'text' : a.kind.toUpperCase()} · ${size}`;
        if (a.file && a.kind !== 'text') {
          const src = imageUrl('', a.file);
          return <li key={i}><a href={src} target="_blank" rel="noopener noreferrer"><img src={src} alt={a.name} /></a><span>{label}</span></li>;
        }
        const why = a.pruned ? 'pruned' : a.error ? `not fetched: ${a.error}` : 'in the board cache';
        return <li key={i} className="muted"><span>{label} · {why}</span></li>;
      })}
    </ul>
  );
}

function PostCard({ p, service, managerOf, onOpen }: { p: BoardPostView; service: string; managerOf: (project: string) => string | null; onOpen: (id: string) => void }) {
  const kind = p.mine ? 'out' : p.viaLedung ? 'ledung' : 'typed';
  const unread = p.deliveries.some((d) => !d.read);
  const url = safe(p.url);
  return (
    <div className={`msg board-post board-post-card ${kind}${p.text === null ? ' dropped' : ''}${unread ? ' unread' : ''}`}>
      <div className="msg-meta">
        <span className="who">{senderLabel(p, service)}</span>
        {unread && <span className="chip accent">unread</span>}
        <time className="time">{formatTime(p.at)}</time>
        {url && <a className="board-post-link" href={url} target="_blank" rel="noopener noreferrer">on {service}</a>}
      </div>
      {p.recipients.length > 0 && <div className="board-thread">To {p.recipients.join(', ')}</div>}
      {p.text === null
        ? <div className="msg-body muted">Dropped: no project here allows @{p.author}, so Ledung kept only that this post exists, not its text.</div>
        : <div className="msg-body plain">{p.text}</div>}
      {p.attachments.length > 0 && <Attachments files={p.attachments} />}
      <ul className="board-delivery-list">
        {deliveryMarks(p).map((m, i) => {
          const manager = m.project ? managerOf(m.project) : null;
          return (
            <li key={i} className={`delivery-${m.level}`}>
              {m.text}
              {manager && <> · <button className="link" onClick={() => onOpen(manager)}>{m.project}'s manager chat</button></>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
