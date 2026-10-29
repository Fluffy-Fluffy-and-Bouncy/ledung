// The message board in the page (docs/steps/message-board.md): the sidebar chip, the Board section of
// Settings (what is app-wide: who this Ledung posts as, each repo's state), a project's board settings
// (repo, allowlist, channels, front desk, who can read the repo; "Per project", 2026-10-14), and the marks
// on posts in a chat.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { BoardOwnersView, BoardPeopleView, BoardRepoChoicesView, BoardRepoStatus, BoardStatus, ProjectInfo } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { boardChip, type BoardMark } from '../boardMarks.ts';
import { pickerGroups, suggestBoardName } from '../boardRepos.ts';
import { usePlainTyping } from '../usePlainTyping.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;

/**
 * `open`: the board or one of its threads is showing, so the chip looks selected (the top Board button did, issue #400).
 * `connection`: the page's connection, which the chip's border shows (connectionMark, Ledung question #397).
 * The tooltip starts with the chip's own text: a narrow footer cuts it with "…" (issue #403).
 */
export function BoardChip({ board, open, connection, onClick }: { board: BoardStatus | null; open?: boolean; connection?: { className: string; text: string }; onClick: () => void }) {
  const chip = boardChip(board);
  if (!chip) return null;
  return (
    <button className={`board-chip ${chip.level}${connection ? ` ${connection.className}` : ''}${open ? ' on' : ''}`} title={`${connection ? `${connection.text} ` : ''}${chip.text} — ${chip.title}`} aria-pressed={open} onClick={onClick}>
      {chip.text}
    </button>
  );
}

const ago = (at: number | null) => {
  if (!at) return 'not yet';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};

/** A login as typed: "@magto" and "magto" are the same. */
const loginOf = (s: string) => s.trim().replace(/^@/, '');

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const stateWord = (r: BoardRepoStatus) => (r.state === 'ok' ? 'On' : r.state === 'starting' ? 'Starting' : r.state === 'error' ? 'Problem' : 'Off');

/** Settings → Message board: only what is the same for every project; each project sets its own board. */
export function BoardSettings({ board }: { board: BoardStatus | null }) {
  if (!board?.configured) {
    return (
      <section>
        <h3>Message board</h3>
        <p className="muted">Managers can talk to managers in other people's Ledungs through a shared board (a GitHub repository). No project uses one yet: each project chooses its board, who may post to it and its channels in its own settings, under Message board.</p>
      </section>
    );
  }
  return (
    <section className="board-settings">
      <h3>Message board</h3>
      <p className="muted">
        {board.identity ? <>Every board posts as <strong>@{board.identity}</strong>, the GitHub login of this computer (<span className="mono">gh</span>).</> : <>Boards post as this computer's GitHub login (<span className="mono">gh</span>).</>}
        {' '}Each project chooses its board and who may post to its manager in its own settings.
      </p>
      {board.boards.map((r) => <RepoState key={r.repo} repo={r} board={board} />)}
    </section>
  );
}

function RepoState({ repo: r, board }: { repo: BoardRepoStatus; board: BoardStatus }) {
  const level = r.state === 'ok' ? 'ok' : r.state === 'error' ? 'warn' : 'idle';
  return (
    <div className="board-block">
      <p className="board-state">
        <span className={`board-dot ${level}`} aria-hidden="true" />
        <span>
          <span className="mono">{r.repo}</span>{' · '}{stateWord(r)}
          {r.state === 'ok' || r.state === 'error' ? <> · checked {ago(r.lastPollAt)}</> : null}
        </span>
      </p>
      {r.error && <p className="board-error">{r.error}</p>}
      <p className="muted">
        Projects: {r.projects.map((p, i) => (
          <span key={p}>{i ? ', ' : ''}{p}{board.projects[p]?.enabled ? '' : ' (off)'}{r.frontDesk === p ? ' (front desk)' : ''}</span>
        ))}
        {r.frontDesk ? null : <> · no front desk: posts to just @{board.identity ?? 'you'} reach nobody</>}
      </p>
      {(r.ignored.length > 0 || r.quiet > 0 || r.paused.length > 0) && (
        <ul className="board-counts">
          {r.ignored.map((i) => <li key={i.login}>{i.count} post{i.count === 1 ? '' : 's'} from <strong>@{i.login}</strong> ignored: no project here allows them (last {ago(i.lastAt)}).</li>)}
          {r.quiet > 0 && <li>{r.quiet} post{r.quiet === 1 ? '' : 's'} in the last day reached no manager (no front desk, or the project's board is off).</li>}
          {r.paused.map((p) => <li key={`${p.project}/${p.threadId}`}>Thread {p.threadId} no longer wakes {p.project} until {new Date(p.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (too many wakes in an hour).</li>)}
        </ul>
      )}
    </div>
  );
}

export interface BoardForm { enabled: boolean; repo: string; allow: string[]; channels: string; frontDesk: boolean }
type Form = BoardForm;

export const boardFormOf = (board: BoardStatus | null, project: string): Form => {
  const s = board?.projects[project];
  const repo = s?.repo ?? '';
  return {
    enabled: s?.enabled ?? false, repo, allow: s?.allow ?? [], channels: (s?.channels ?? []).join(' '),
    frontDesk: !!repo && board?.boards.find((b) => b.repo === repo)?.frontDesk === project,
  };
};

const plainChannels = (s: string) => s.split(/[\s,]+/).filter(Boolean).map((c) => c.replace(/^#/, '').toLowerCase()).join(' ');

/** How many of the board's fields differ from what is saved: they count in the project tab's Save bar (issue #366). */
export function boardChanges(form: Form, current: Form): number {
  const repo = form.repo.trim();
  return [
    form.enabled !== current.enabled, repo !== current.repo, form.frontDesk !== current.frontDesk,
    plainChannels(form.channels) !== plainChannels(current.channels),
    form.allow.length !== current.allow.length || form.allow.some((l) => !current.allow.some((c) => sameLogin(c, l))),
  ].filter(Boolean).length;
}

/** Why the board's changes can't be saved yet, or null. */
export function boardBlocked(form: Form): string | null {
  const repo = form.repo.trim();
  if (repo && !REPO.test(repo)) return 'The board repository is owner/name.';
  if (form.enabled && !repo) return 'Name the board repository to turn the board on.';
  return null;
}

/** Saves a project's board settings, as its own Save button did before the project tab's one Save bar (issue #366). */
export function saveBoard(project: string, form: Form): Promise<unknown> {
  const repo = form.repo.trim();
  return api.setBoardProject(project, { enabled: form.enabled, repo: repo || null, allow: form.allow, channels: form.channels.split(/[\s,]+/).filter(Boolean), frontDesk: form.frontDesk && !!repo });
}

/**
 * A project's board settings: its own repo, allowlist, channels and front desk. Since #366 the project tab holds what is
 * typed here and saves it with the rest of the tab.
 */
export function ProjectBoard({ board, project, projects, form, onChange }: { board: BoardStatus | null; project: string; projects: ProjectInfo[]; form: Form; onChange: (f: Form) => void }) {
  const typing = usePlainTyping();
  const current = boardFormOf(board, project);
  const change = (f: Partial<Form>) => onChange({ ...form, ...f });
  const repo = form.repo.trim();
  const repoOk = !repo || REPO.test(repo);
  const others = projects.map((p) => p.name).filter((n) => n !== project && board?.projects[n]?.repo);
  const repoState = board?.boards.find((b) => b.repo === repo);
  const sharing = (repoState?.projects ?? []).filter((n) => n !== project);
  const desk = repoState?.frontDesk ?? null;
  const ignored = board?.projects[project]?.ignored ?? [];
  const copyFrom = (name: string) => {
    const s = board?.projects[name];
    if (!s) return;
    // Repo, allowlist and channels; this project keeps its front desk if the repo stays the same (the desk is never copied).
    change({ repo: s.repo ?? '', allow: [...s.allow], channels: s.channels.join(' '), frontDesk: (s.repo ?? '') === form.repo.trim() && form.frontDesk });
  };

  return (
    <div className="board-settings">
      <p className="muted">Lets this project's manager read and post to managers in other people's Ledungs, on a board (a GitHub repository) and only with the people you allow here. Off by default.</p>
      <label className="toggle"><input type="checkbox" checked={form.enabled} onChange={(e) => change({ enabled: e.target.checked })} /> Use the board in this project</label>
      {others.length > 0 && (
        <label className="board-channels">Copy from another project
          <select aria-label="Copy the board settings from" value="" onChange={(e) => copyFrom(e.target.value)}>
            <option value="">Choose a project…</option>
            {others.map((n) => <option key={n} value={n}>{n} ({board!.projects[n]!.repo})</option>)}
          </select>
        </label>
      )}
      <RepoPicker project={project} value={form.repo} ok={repoOk} onChange={(r) => change({ repo: r })} />
      {repo && repoOk && (
        <div className="board-warning">
          <strong>Everyone with access to {repo} can read every post on it</strong>, whichever project or Ledung wrote it.
          The list below only decides who can reach this project's manager, not who can read. A sensitive project should have a board repository of its own.
          {' '}<strong>Files attached to posts</strong> (screenshots, logs) can be read and copied by the same people; Ledung asks you before any leaves.
          Pruning takes them off the board's branch after their thread closes, but can't take back a copy someone made, and unreachable commits and cached views of them can remain on GitHub until GitHub Support removes them.
          {sharing.length > 0 && <> Also on this board here: {sharing.join(', ')}.</>}
        </div>
      )}
      {repo && repoOk && (
        <Allowlist project={project} savedRepo={current.repo} repo={repo} allow={form.allow} active={repoState?.state === 'ok'} onChange={(allow) => change({ allow })} />
      )}
      {ignored.length > 0 && (
        <ul className="board-counts">
          {ignored.map((i) => (
            <li key={i.login}>
              {i.count} post{i.count === 1 ? '' : 's'} to this project ignored from <strong>@{i.login}</strong>, who isn't on its list (last {ago(i.lastAt)}).{' '}
              {!form.allow.some((l) => sameLogin(l, i.login)) && <button className="small" onClick={() => change({ allow: [...form.allow, i.login] })}>Allow @{i.login}</button>}
            </li>
          ))}
        </ul>
      )}
      <label className="toggle"><input type="checkbox" checked={form.frontDesk} disabled={!repo || !repoOk} onChange={(e) => change({ frontDesk: e.target.checked })} /> <span>Front desk on this board: gets posts addressed to just <span className="mono">@{board?.identity ?? 'you'}</span></span></label>
      {desk && desk !== project && form.frontDesk && <p className="muted">{desk} is the front desk now; saving moves it here.</p>}
      {desk && desk !== project && !form.frontDesk && <p className="muted">The front desk on this board is {desk}.</p>}
      <label className="board-channels">Channels it follows
        <input {...typing} value={form.channels} disabled={!form.enabled} placeholder="#ledung #ops" onChange={(e) => change({ channels: e.target.value })} />
      </label>
      <p className="muted">A channel's posts wake nobody; the manager reads them when it looks. A running manager gets the board's tools at its next start or resume.</p>
      {form.enabled && !repo && <p className="muted">Name the board repository to turn it on.</p>}
    </div>
  );
}

/**
 * The board repository (decision 2026-10-14): type owner/name, or pick from boards other projects here use and
 * from the repos the GitHub login can reach (searched by what is typed), or create a new private one. The
 * list is read when the box is first opened; typing a name that is not in it still works.
 */
export function RepoPicker({ project, value, ok, onChange, load, label = 'Board repository', newName }: {
  project: string; value: string; ok: boolean; onChange: (repo: string) => void;
  /** Where the choices come from; the board's own route by default. Publishing usage reads them without a project (#363). */
  load?: (refresh: boolean) => Promise<BoardRepoChoicesView>;
  label?: ReactNode;
  /** The name a new repo is offered under; "<project>-board" by default. */
  newName?: string;
}) {
  const typing = usePlainTyping();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [choices, setChoices] = useState<BoardRepoChoicesView | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The box always shows the value; it searches only once the person has typed in it (opening it shows the whole list).
  const [edited, setEdited] = useState(false);
  const query = edited ? value : '';
  const read = useCallback((refresh: boolean) => {
    setLoading(true);
    setProblem(null);
    (load ?? ((r: boolean) => api.boardRepos(project, r)))(refresh).then(setChoices, (e: Error) => setProblem(e.message)).finally(() => setLoading(false));
  }, [project, load]);
  useEffect(() => { setChoices(null); setOpen(false); setCreating(false); }, [project]);
  const show = () => { setOpen(true);  if (!choices && !loading) read(false); };
  const pick = (repo: string) => { onChange(repo); setEdited(false); setOpen(false); setCreating(false); };
  const groups = pickerGroups(choices, query);
  const typed = query.trim();
  const typedOk = REPO.test(typed) && !groups.used.some((r) => r.repo.toLowerCase() === typed.toLowerCase()) && !groups.others.some((r) => r.repo.toLowerCase() === typed.toLowerCase());

  return (
    <div className="repo-picker" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setOpen(false); setEdited(false); } }} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
      <label className="board-channels">{label}
        <input {...typing}
          className="mono" value={value} placeholder="Choose, search or type owner/name"
          aria-invalid={!ok} aria-expanded={open} role="combobox" aria-controls="repo-picker-list" autoComplete="off" spellCheck={false}
          onFocus={show} onClick={show}
          onChange={(e) => { setOpen(true); setEdited(true); onChange(e.target.value); if (!choices && !loading) read(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && open) { e.preventDefault(); const first = groups.used[0] ?? groups.others[0]; if (typedOk) pick(typed); else if (first) pick(first.repo); else setOpen(false); } }}
        />
      </label>
      {open && !creating && (
        <div className="repo-list" id="repo-picker-list" role="listbox">
          <div className="board-block-head">
            <span className="muted">{loading ? 'Reading your repositories…' : choices ? `${choices.repos.length}${choices.truncated ? '+' : ''} repositories you can reach` : ''}</span>
            <button type="button" className="small" disabled={loading} onClick={() => read(true)} title="Read the list from GitHub again">Refresh</button>
          </div>
          {problem && <p className="board-error">{problem}</p>}
          {choices?.error && <p className="board-error">{choices.error} You can still type owner/name.</p>}
          {groups.used.length > 0 && <p className="repo-head">Boards your other projects use</p>}
          {groups.used.map((r) => <RepoRow key={`u${r.repo}`} row={r} onPick={pick} />)}
          {groups.others.length > 0 && <p className="repo-head">Your GitHub repositories</p>}
          {groups.others.map((r) => <RepoRow key={r.repo} row={r} onPick={pick} />)}
          {groups.hidden > 0 && <p className="muted">{groups.hidden} more: type to narrow the list.</p>}
          {typedOk && <button type="button" role="option" className="repo-row" onClick={() => pick(typed)}><span className="mono">Use {typed}</span><span className="muted"> (typed; checked when you save)</span></button>}
          {choices && !choices.error && !groups.used.length && !groups.others.length && !typedOk && <p className="muted">Nothing matches. Type the whole name as owner/name to use a repository that isn't listed.</p>}
          <button type="button" className="small repo-create" onClick={() => setCreating(true)}>Create a new private {newName ? '' : 'board '}repo…</button>
        </div>
      )}
      {!ok && !open && <p className="board-error">Write the repository as owner/name.</p>}
      {open && creating && <CreateRepo project={project} name={newName} onCancel={() => setCreating(false)} onCreated={pick} />}
    </div>
  );
}

function RepoRow({ row, onPick }: { row: { repo: string; private: boolean | null; projects: string[] }; onPick: (repo: string) => void }) {
  return (
    <button type="button" role="option" className="repo-row" onClick={() => onPick(row.repo)}>
      <span className="mono repo-name">{row.repo}</span>
      {row.private !== null && <span className={`chip ${row.private ? '' : 'warn'}`}>{row.private ? 'private' : 'public'}</span>}
      {row.projects.length > 0 && <span className="muted"> used by {row.projects.join(', ')}</span>}
    </button>
  );
}

/** The one GitHub write: shows owner and name, creates only after Confirm; always private. */
function CreateRepo({ project, name: offered, onCancel, onCreated }: { project: string; name?: string; onCancel: () => void; onCreated: (repo: string) => void }) {
  const typing = usePlainTyping();
  const [owners, setOwners] = useState<BoardOwnersView['owners'] | null>(null);
  const [owner, setOwner] = useState('');
  const [name, setName] = useState(() => offered ?? suggestBoardName(project));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.boardOwners().then((o) => { setOwners(o.owners); setOwner(o.owners[0]?.login ?? ''); }, (e: Error) => setProblem(e.message));
  }, []);
  const nameOk = /^[A-Za-z0-9_.-]{1,100}$/.test(name) && name !== '.' && name !== '..';
  const confirm = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const made = await api.createBoardRepo(owner, name);
      onCreated(made.repo);
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="repo-list repo-create-form" role="dialog" aria-label={`Create a new private ${offered ? '' : 'board '}repository`}>
      <h4>Create a new private {offered ? '' : 'board '}repository</h4>
      <p className="muted">This creates a new <strong>private</strong> repository on GitHub, as your <span className="mono">gh</span> login. Only you can see it until you add people on GitHub.</p>
      <label className="board-channels">Owner
        <select value={owner} disabled={!owners || busy} onChange={(e) => setOwner(e.target.value)}>
          {!owners && <option>Reading your accounts…</option>}
          {(owners ?? []).map((o) => <option key={o.login} value={o.login}>{o.login}{o.kind === 'user' ? ' (you)' : ' (organisation)'}</option>)}
        </select>
      </label>
      <label className="board-channels">Name
        <input {...typing} className="mono" value={name} disabled={busy} aria-invalid={!nameOk} onChange={(e) => setName(e.target.value.trim())} />
      </label>
      {!nameOk && <p className="board-error">Use letters, digits, - _ and . only.</p>}
      {problem && <p className="board-error">{problem}</p>}
      <div className="board-add">
        <button type="button" disabled={busy || !owner || !nameOk} onClick={() => void confirm()}>{busy ? 'Creating…' : `Confirm: create ${owner}/${name}`}</button>
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Who may post to this project's manager: picked from the people with access to its repo, or typed (decision 5). */
function Allowlist({ project, savedRepo, repo, allow, active, onChange }: { project: string; savedRepo: string; repo: string; allow: string[]; active: boolean; onChange: (allow: string[]) => void }) {
  const typing = usePlainTyping();
  const [people, setPeople] = useState<BoardPeopleView | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  // The list is of the saved repo; a repo typed but not saved is read after Save.
  const readable = !!savedRepo && savedRepo === repo;
  const refresh = useCallback(() => {
    setLoading(true);
    setProblem(null);
    api.boardPeople(project).then(setPeople, (e: Error) => setProblem(e.message)).finally(() => setLoading(false));
  }, [project]);
  useEffect(() => { setPeople(null); if (readable) refresh(); }, [readable, savedRepo, active, refresh]);

  const has = (login: string) => allow.some((l) => sameLogin(l, login));
  const toggle = (login: string) => onChange(has(login) ? allow.filter((l) => !sameLogin(l, login)) : [...allow, login]);
  const lost = new Set((people?.lostAccess ?? []).map((l) => l.toLowerCase()));
  const listed = new Set((people?.people ?? []).map((p) => p.id.toLowerCase()));
  // Allowlisted logins the list doesn't show (typed in, or no access any more) stay visible and removable.
  const extra = allow.filter((l) => !listed.has(l.toLowerCase()));
  const add = () => {
    const login = loginOf(typed);
    if (!login) return;
    setTyped('');
    if (!has(login)) onChange([...allow, login]);
  };

  return (
    <div className="board-block">
      <div className="board-block-head">
        <h4>Who may post to this project's manager</h4>
        <button className="small" disabled={loading || !readable} onClick={refresh} title="Read the list of people with access to the board again">{loading ? 'Reading…' : 'Refresh'}</button>
      </div>
      {problem && <p className="board-error">{problem}</p>}
      {!readable && <p className="muted">Save to see who has access to {repo}.</p>}
      {people?.note && <p className="muted">{people.note}</p>}
      {people && people.source !== 'none' && (
        <p className="muted">{people.source === 'collaborators' ? `People with access to ${repo}: they can all read its posts.` : `Members of ${repo.split('/')[0]}: people with access to ${repo} can read its posts.`} Having access doesn't let anyone reach this manager: tick the people you trust.</p>
      )}
      <ul className="board-people">
        {(people?.people ?? []).map((p) => (
          <li key={p.id}>
            <label className="toggle">
              <input type="checkbox" checked={has(p.id)} onChange={() => toggle(p.id)} />
              {p.avatarUrl ? <img className="avatar" src={p.avatarUrl} alt="" width={28} height={28} loading="lazy" /> : <span className="avatar blank" aria-hidden="true" />}
              <span className="person"><span>{p.name ?? p.id}</span>{p.name && <span className="muted"> @{p.id}</span>}</span>
              {lost.has(p.id.toLowerCase()) && <span className="chip warn" title="On the list, but no longer has access to the board repository">lost access</span>}
            </label>
          </li>
        ))}
        {extra.map((l) => (
          <li key={l}>
            <label className="toggle">
              <input type="checkbox" checked onChange={() => toggle(l)} />
              <span className="avatar blank" aria-hidden="true" />
              <span className="person"><span>@{l}</span></span>
              {people?.source === 'collaborators' && <span className="chip warn" title="On the list, but not among the people with access to the board repository">lost access</span>}
            </label>
          </li>
        ))}
        {readable && people && !people.people.length && !extra.length && <li className="muted">No one is listed. Type a login below.</li>}
      </ul>
      <div className="board-add">
        <input {...typing} value={typed} placeholder="GitHub login, e.g. magto" aria-label="GitHub login to allow" onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
        <button className="small" disabled={!loginOf(typed)} onClick={add}>Allow</button>
      </div>
    </div>
  );
}

const WHO_KIND: Record<BoardMark['kind'], string> = { out: 'Post from this manager', ledung: 'Board message', typed: 'Typed on the board' };

/** A board post in a manager's chat: who really sent it (from the service, never the text), the thread, and the text. */
export function BoardPostCard({ mark, time, onOpenThread }: { mark: BoardMark; time?: ReactNode; onOpenThread?: (threadId: string) => void }) {
  const from = mark.kind === 'out'
    ? <>to {mark.to}</>
    : mark.kind === 'ledung'
      ? <>from <strong>@{mark.author}</strong>'s Ledung{mark.project ? ` (project ${mark.project})` : ''}</>
      : <>typed on {mark.service || 'the board'} by <strong>@{mark.author}</strong></>;
  return (
    <div className={`msg board-post ${mark.kind}`}>
      <div className="msg-meta">
        <span className="who">{WHO_KIND[mark.kind]}</span>
        <span className="board-from">{from}</span>
        {time}
      </div>
      <div className="board-thread">Thread {mark.threadId ? `#${mark.threadId} ` : ''}{mark.title && <>“{mark.title}”</>}{onOpenThread && mark.threadId && <> · <button className="link" onClick={() => onOpenThread(mark.threadId)}>Open in Board</button></>}{mark.kind !== 'out' && mark.to && <span className="muted"> · to {mark.to}</span>}</div>
      <div className="msg-body plain">{mark.text}</div>
      <div className="muted board-trust">
        {mark.kind === 'out' ? 'Sent from this Ledung.' : mark.kind === 'ledung' ? "Sender verified by the board service; not from you. A post can't approve anything." : 'Sender verified by the board service. Typed by that person, not through a Ledung; not from you.'}
      </div>
    </div>
  );
}
