// The Files pane (issue #225, a test feature, decided by Martin 2026-10-18 22:46): beside the conversation, or full
// screen on a phone. Two tabs: Files, the folder tree of where the session works (or of the project folder), and
// Changes, what the session changed against main as a unified diff where a click on a line writes a comment. The
// comments are drafts until Send, which puts them in the open review's answer or, with none, in one message to the
// session's manager: the manager hands them on as a review round, so the process keeps its review step.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { QuestionInfo, SessionInfo } from '../../../src/shared/protocol.ts';
import type { DiffFile, DiffLine, PaneFolderKey, PaneFolders, SessionChanges, TreeEntry, TreeListing } from '../../../src/shared/files-pane.ts';
import { formatLineComments, lineCommentsMessage, openReviewFor, reviewAnswerWithComments } from '../../../src/shared/line-comments.ts';
import { CHATS } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { usePlainTyping } from '../usePlainTyping.ts';
import { colourDiff, languageOf } from '../highlight.ts';
import { useHighlighter } from '../useHighlighter.ts';
import { putLineDraft, readLineDrafts, sameLine, writeLineDrafts, type DraftComment } from '../lineCommentDrafts.ts';

const PHONE = '(max-width: 760px)';

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof matchMedia === 'function' && matchMedia(PHONE).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(PHONE);
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return phone;
}

export function FilesPane(props: {
  session: SessionInfo;
  sessions: SessionInfo[];
  questions: QuestionInfo[];
  userName: string;
  /** Hidden while a file from it is open, so the tree keeps its place for Back. */
  hidden: boolean;
  onOpenFile: (path: string, folder: PaneFolderKey) => void;
  onOpenQuestion: (id: number) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'files' | 'changes'>('files');
  const [drafts, setDrafts] = useState(() => readLineDrafts(localStorage, props.session.id));
  useEffect(() => writeLineDrafts(localStorage, props.session.id, drafts), [props.session.id, drafts]);
  return (
    <aside className="file-panel files-pane" aria-label="Files" hidden={props.hidden}>
      <header className="file-head">
        <strong>Files</strong>
        <span className="chip test-feature" title="A test feature: Martin is trying it out (issue #225). It may change or go.">Test feature</span>
        <span className="spacer" />
        <button className="small" onClick={props.onClose} aria-label="Close the Files pane">Close</button>
      </header>
      <div className="pane-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>Files</button>
        <button role="tab" aria-selected={tab === 'changes'} className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
          Changes{drafts.length ? <span className="chip draft">{drafts.length} draft</span> : null}
        </button>
      </div>
      {/* Both stay mounted, so switching tabs keeps the tree open and the diff where it was. */}
      <div className="pane-body" hidden={tab !== 'files'}>
        <FilesTab session={props.session} onOpenFile={props.onOpenFile} />
      </div>
      <div className="pane-body" hidden={tab !== 'changes'}>
        <ChangesTab {...props} drafts={drafts} setDrafts={setDrafts} active={tab === 'changes'} />
      </div>
    </aside>
  );
}

// --- Files ------------------------------------------------------------------------------------------------

type Loaded = TreeListing | { error: string };

function FilesTab(props: { session: SessionInfo; onOpenFile: (path: string, folder: PaneFolderKey) => void }) {
  const id = props.session.id;
  const [folders, setFolders] = useState<PaneFolders['folders'] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [folder, setFolder] = useState<PaneFolderKey>('session');
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const typing = usePlainTyping();

  useEffect(() => {
    api.paneFolders(id).then((f) => setFolders(f.folders), (e: Error) => setProblem(e.message));
  }, [id]);
  const load = (path: string) => {
    api.tree(id, folder, path).then(
      (l) => setLoaded((m) => ({ ...m, [path]: l })),
      (e: Error) => setLoaded((m) => ({ ...m, [path]: { error: e.message } })),
    );
  };
  // A new folder choice starts the tree again from its top.
  useEffect(() => {
    setLoaded({});
    setOpen(new Set());
    load('');
  }, [id, folder]);

  const toggle = (e: TreeEntry) => {
    if (!e.dir) return props.onOpenFile(e.path, folder);
    if (e.skipped) return;
    const next = new Set(open);
    if (next.has(e.path)) next.delete(e.path);
    else {
      next.add(e.path);
      if (!loaded[e.path]) load(e.path);
    }
    setOpen(next);
  };

  const rows: { e: TreeEntry; depth: number }[] = [];
  const walk = (path: string, depth: number) => {
    const l = loaded[path];
    if (!l || 'error' in l) return;
    for (const e of l.entries) {
      rows.push({ e, depth });
      if (e.dir && open.has(e.path)) walk(e.path, depth + 1);
    }
  };
  walk('', 0);
  const needle = filter.trim().toLowerCase();
  const found = needle
    ? Object.values(loaded).flatMap((l) => ('error' in l ? [] : l.entries)).filter((e) => e.name.toLowerCase().includes(needle))
      .sort((a, b) => a.path.localeCompare(b.path))
    : null;
  const top = loaded[''];
  const chosen = folders?.find((f) => f.key === folder);

  if (problem) return <p className="error pane-note">{problem}</p>;
  return (
    <>
      <div className="pane-tools">
        {folders && folders.length > 1 && (
          <div className="seg-control" role="radiogroup" aria-label="Which folder">
            {folders.map((f) => (
              <button key={f.key} role="radio" aria-checked={folder === f.key} className={folder === f.key ? 'on' : ''} onClick={() => setFolder(f.key)} title={f.path}>
                {f.label}
              </button>
            ))}
          </div>
        )}
        {chosen && <div className="muted mono pane-root" title={chosen.path}>{chosen.path}</div>}
        <input {...typing} className="pane-filter" type="search" placeholder="Filter by name…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter files by name" />
      </div>
      <div className="tree" role="tree">
        {top && 'error' in top && <p className="error pane-note">{top.error}</p>}
        {!top && <p className="muted pane-note">Loading…</p>}
        {found && (
          <>
            <p className="muted pane-note">{found.length} match{found.length === 1 ? '' : 'es'} in the folders opened so far.</p>
            {found.map((e) => <TreeRow key={e.path} e={e} depth={0} label={e.path} open={open.has(e.path)} onClick={() => toggle(e)} />)}
          </>
        )}
        {!found && rows.map(({ e, depth }) => (
          <Fragment key={e.path}>
            <TreeRow e={e} depth={depth} open={open.has(e.path)} onClick={() => toggle(e)} />
            {e.dir && open.has(e.path) && loaded[e.path] && 'error' in loaded[e.path]! && (
              <p className="error pane-note" style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}>{(loaded[e.path] as { error: string }).error}</p>
            )}
            {e.dir && open.has(e.path) && !loaded[e.path] && <p className="muted pane-note" style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}>Loading…</p>}
          </Fragment>
        ))}
        {top && !('error' in top) && top.truncated && <p className="muted pane-note">Only the first 1000 names are shown.</p>}
      </div>
      <p className="muted pane-foot">
        Read-only. Only what is inside this folder. Names starting with . or $ are not listed{props.session.project === CHATS ? ', nor folders where settings and sign-ins are kept' : ''}; node_modules and what .gitignore leaves out are greyed.
      </p>
    </>
  );
}

function TreeRow(props: { e: TreeEntry; depth: number; open: boolean; label?: string; onClick: () => void }) {
  const { e } = props;
  const dot = e.name.lastIndexOf('.');
  const name = props.label ?? e.name;
  return (
    <button
      role="treeitem"
      aria-expanded={e.dir && !e.skipped ? props.open : undefined}
      className={`tree-row${e.skipped ? ' skipped' : ''}${e.dir ? ' dir' : ''}`}
      style={{ paddingLeft: `${props.depth * 14 + 8}px` }}
      onClick={props.onClick}
      disabled={e.dir && !!e.skipped}
      title={e.skipped === 'heavy' ? 'Not listed: a heavy folder' : e.skipped === 'ignored' ? 'Left out by .gitignore' : e.path}
    >
      <span className="tree-caret" aria-hidden="true">{e.dir ? (e.skipped ? '·' : props.open ? '▾' : '▸') : ''}</span>
      {e.dir
        ? <span>{name}/</span>
        : dot > 0 && !props.label ? <span>{e.name.slice(0, dot)}<span className="ext">{e.name.slice(dot)}</span></span> : <span>{name}</span>}
      {e.skipped && <span className="tree-note">{e.skipped === 'heavy' ? 'not listed' : 'ignored'}</span>}
    </button>
  );
}

// --- Changes ----------------------------------------------------------------------------------------------

/** The line a comment goes on: deleted lines by their old number, the rest by their new one. */
const anchorOf = (l: DiffLine): { line: number; side: 'new' | 'old' } => (l.kind === 'del' ? { line: l.old!, side: 'old' } : { line: l.new!, side: 'new' });

function ChangesTab(props: {
  session: SessionInfo;
  sessions: SessionInfo[];
  questions: QuestionInfo[];
  userName: string;
  active: boolean;
  drafts: DraftComment[];
  setDrafts: (f: (d: DraftComment[]) => DraftComment[]) => void;
  onOpenFile: (path: string, folder: PaneFolderKey) => void;
  onOpenQuestion: (id: number) => void;
}) {
  const id = props.session.id;
  const phone = usePhone();
  const [changes, setChanges] = useState<SessionChanges | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [editing, setEditing] = useState<{ path: string; line: DiffLine } | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const loadedOnce = useRef(false);
  const refresh = () => {
    setProblem(null);
    api.changes(id).then((c) => { setChanges(c); setAt((i) => Math.min(i, Math.max(0, c.files.length - 1))); }, (e: Error) => setProblem(e.message));
  };
  // Loaded when the tab is first shown: a diff runs git, the tree does not need it.
  useEffect(() => {
    if (props.active && !loadedOnce.current) {
      loadedOnce.current = true;
      refresh();
    }
  }, [props.active]);

  const files = changes?.files ?? [];
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const shown = phone ? files.slice(at, at + 1) : files;
  const save = (c: DraftComment) => {
    props.setDrafts((d) => putLineDraft(d, c));
    setEditing(null);
    setSent(null);
  };

  if (problem) return <p className="error pane-note">{problem} <button className="small" onClick={refresh}>Try again</button></p>;
  if (!changes) return <p className="muted pane-note">Loading the changes…</p>;
  return (
    <div className="changes-tab">
      <div className="changes-head">
        <span>
          {changes.problem ?? <>
            <strong>{files.length} file{files.length === 1 ? '' : 's'}</strong> <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
            <span className="muted"> · {changes.branch ?? 'HEAD'} against {changes.base} · at <span className="mono">{changes.head?.slice(0, 7)}</span></span>
          </>}
        </span>
        <button className="small" onClick={refresh} title="Read the changes again">Refresh</button>
      </div>
      {changes.truncated && <p className="warn pane-note">The diff is larger than 1 MB, so it is cut: only the files above the cut are shown, the last one perhaps in part.</p>}
      {!changes.problem && !files.length && <p className="muted pane-note">No changes yet: this branch has no commits of its own. Uncommitted edits are not shown.</p>}
      {phone && files.length > 0 && (
        <div className="file-step">
          <button className="small" aria-label="Previous file" disabled={at === 0} onClick={() => setAt(at - 1)}>‹</button>
          <select value={at} onChange={(e) => setAt(Number(e.target.value))} aria-label="Changed file">
            {files.map((f, i) => <option key={f.path} value={i}>{f.path} · {i + 1} of {files.length}</option>)}
          </select>
          <button className="small" aria-label="Next file" disabled={at >= files.length - 1} onClick={() => setAt(at + 1)}>›</button>
        </div>
      )}
      {!phone && files.length > 1 && (
        <ul className="changed-files">
          {files.map((f) => {
            const n = props.drafts.filter((d) => d.path === f.path).length;
            return (
              <li key={f.path}>
                <button className="link mono" onClick={() => document.getElementById(fileAnchor(id, f.path))?.scrollIntoView({ block: 'start' })}>{f.path}</button>
                {n > 0 && <span className="chip draft">{n}</span>}
                <span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span>
              </li>
            );
          })}
        </ul>
      )}
      {shown.map((f) => (
        <DiffFileView
          key={f.path} sessionId={id} file={f} head={changes.head ?? ''} userName={props.userName} drafts={props.drafts.filter((d) => d.path === f.path)}
          editing={editing?.path === f.path ? editing.line : null}
          onEdit={(line) => setEditing(line ? { path: f.path, line } : null)}
          onSave={save}
          onRemove={(d) => props.setDrafts((all) => all.filter((x) => x.id !== d.id))}
          onWhole={() => props.onOpenFile(f.path, 'session')}
        />
      ))}
      <SendBar {...props} sending={sending} setSending={setSending} sent={sent} setSent={setSent} />
    </div>
  );
}

const fileAnchor = (sessionId: string, path: string) => `diff-${sessionId}-${path}`;

function DiffFileView(props: {
  sessionId: string;
  file: DiffFile;
  head: string;
  userName: string;
  drafts: DraftComment[];
  editing: DiffLine | null;
  onEdit: (line: DiffLine | null) => void;
  onSave: (c: DraftComment) => void;
  onRemove: (c: DraftComment) => void;
  onWhole: () => void;
}) {
  const f = props.file;
  // Syntax colour on the text; the green and red line backgrounds stay (Martin on question #346).
  const hl = useHighlighter();
  const coloured = useMemo(() => colourDiff(f, hl), [f, hl]);
  return (
    <section className="diff-file" id={fileAnchor(props.sessionId, f.path)}>
      <header className="diff-file-head">
        <span className="mono diff-path" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>{f.oldPath ? `${f.oldPath} → ` : ''}{f.path}</span>
        {f.status !== 'modified' && <span className="chip">{f.status}</span>}
        <span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span>
        {f.status !== 'deleted' && !f.binary && <button className="small" onClick={props.onWhole} title="Open the whole file, read-only">Whole file</button>}
      </header>
      {f.binary && <p className="muted pane-note">A binary file: not shown.</p>}
      {!f.binary && !f.hunks.length && <p className="muted pane-note">Renamed or its mode changed; no lines differ.</p>}
      <table className="diff-table">
        <colgroup><col className="c-ln" /><col className="c-ln" /><col /></colgroup>
        <tbody>
          {f.hunks.map((h, hi) => (
            <Fragment key={hi}>
              <tr className="hunk"><td colSpan={3} className="mono">{h.header}</td></tr>
              {h.lines.map((l, li) => {
                const anchor = anchorOf(l);
                const here = props.drafts.filter((d) => sameLine(d, { path: f.path, ...anchor }));
                const editingHere = props.editing === l;
                return (
                  <Fragment key={li}>
                    <tr
                      className={`dl ${l.kind}${here.length ? ' commented' : ''}${editingHere ? ' editing' : ''}`}
                      onClick={() => props.onEdit(editingHere ? null : l)}
                      title="Click to comment on this line"
                    >
                      <td className="ln">{l.old ?? ''}</td>
                      <td className="ln">{l.new ?? ''}</td>
                      <td className="code hl"><span className="mark">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>{coloured?.has(l) ? <span dangerouslySetInnerHTML={{ __html: coloured.get(l)! }} /> : l.text}</td>
                    </tr>
                    {here.map((d) => (
                      <tr key={d.id} className="comment-row"><td colSpan={3}>
                        <div className="line-comment">
                          <div className="line-comment-head">
                            <strong>{props.userName}</strong> <span className="chip draft">draft</span> <span className="muted">line {d.line}{d.side === 'old' ? ' (old)' : ''}</span>
                            <span className="spacer" />
                            <button className="small" onClick={() => props.onEdit(l)}>Edit</button>
                            <button className="small" onClick={() => props.onRemove(d)}>Delete</button>
                          </div>
                          <div className="line-comment-body">{d.body}</div>
                        </div>
                      </td></tr>
                    ))}
                    {editingHere && (
                      <tr className="comment-row"><td colSpan={3}>
                        <CommentEditor
                          path={f.path} line={l} head={props.head} existing={here[0] ?? null}
                          onCancel={() => props.onEdit(null)} onSave={props.onSave}
                        />
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The box a click on a line opens: it quotes the line, and keeps the comment as a draft. On a phone, a sheet from the bottom. */
function CommentEditor(props: { path: string; line: DiffLine; head: string; existing: DraftComment | null; onCancel: () => void; onSave: (c: DraftComment) => void }) {
  const [body, setBody] = useState(props.existing?.body ?? '');
  const typing = usePlainTyping();
  const box = useRef<HTMLTextAreaElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  // Into view whole, buttons included: focusing the box alone leaves them under the Send bar (a sheet on a phone).
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
    frame.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  const anchor = anchorOf(props.line);
  const hl = useHighlighter();
  const language = languageOf(props.path);
  const quoted = hl && language ? hl(props.line.text, language)[0] ?? null : null;
  const save = () => {
    if (!body.trim()) return props.existing ? props.onSave({ ...props.existing, body: '' }) : props.onCancel();
    props.onSave({
      id: props.existing?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      path: props.path, ...anchor, lineText: props.line.text, commit: props.head, body,
    });
  };
  return (
    <div ref={frame} className="comment-editor" role="dialog" aria-label={`Comment on line ${anchor.line}`} onClick={(e) => e.stopPropagation()}>
      <div className="comment-editor-head">
        <strong>Comment on line {anchor.line}{anchor.side === 'old' ? ' (old)' : ''}</strong>
        <span className="muted mono">{props.path}</span>
      </div>
      <pre className={`quoted-line hl ${props.line.kind}`}>{props.line.kind === 'add' ? '+ ' : props.line.kind === 'del' ? '− ' : '  '}{quoted !== null ? <span dangerouslySetInnerHTML={{ __html: quoted }} /> : props.line.text}</pre>
      <textarea
        {...typing} ref={box} className="box" value={body} placeholder="What should the worker look at here?"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); props.onCancel(); }
        }}
      />
      <p className="muted">Kept as a draft until you send; nothing reaches the worker yet.</p>
      <div className="send">
        <button onClick={props.onCancel}>Cancel</button>
        <button className="primary" onClick={save}>{props.existing ? 'Save comment' : 'Add comment'}</button>
      </div>
    </div>
  );
}

/** The drafts' count and Send: into the open review's answer, or one message to the session's manager. */
function SendBar(props: {
  session: SessionInfo;
  sessions: SessionInfo[];
  questions: QuestionInfo[];
  userName: string;
  drafts: DraftComment[];
  setDrafts: (f: (d: DraftComment[]) => DraftComment[]) => void;
  onOpenQuestion: (id: number) => void;
  sending: boolean;
  setSending: (b: boolean) => void;
  sent: string | null;
  setSent: (s: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<'changes' | 'accept'>('changes');
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const typing = usePlainTyping();
  const review = useMemo(() => openReviewFor(props.session.id, props.questions), [props.session.id, props.questions]);
  const manager = props.session.parentId ? props.sessions.find((s) => s.id === props.session.parentId) ?? null : null;
  const n = props.drafts.length;
  const list = n ? formatLineComments(props.drafts, props.session.title) : '';
  const preview = review ? reviewAnswerWithComments(verdict, text, list) : lineCommentsMessage(props.userName, text, list, manager ? props.session.title : null);
  const send = async () => {
    props.setSending(true);
    setErr('');
    try {
      const comments = props.drafts.map(({ id: _id, ...c }) => c);
      await api.sendLineComments(props.session.id, { verdict: review ? verdict : null, text, comments });
      props.setDrafts(() => []);
      props.setSent(review ? `Sent with your ${verdict === 'accept' ? 'Accept' : '"Changes needed"'} on the review.` : `Sent to ${manager?.title ?? props.session.title}.`);
      setOpen(false);
      setText('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      props.setSending(false);
    }
  };
  return (
    <div className="comment-bar">
      {open && n > 0 && (
        <div className="send-panel">
          <h4>Send {n} comment{n === 1 ? '' : 's'}</h4>
          {review ? (
            <>
              <p className="muted">
                With your answer to the open review{' '}
                <button className="link" onClick={() => props.onOpenQuestion(review.id)}>{review.details?.title ?? `#${review.id}`}</button>.
              </p>
              <label className="radio"><input type="radio" checked={verdict === 'changes'} onChange={() => setVerdict('changes')} /> <span><strong>As “Changes needed”</strong><br /><span className="muted">The manager hands them to the worker as a review round; each one is a finding to check, not an order.</span></span></label>
              <label className="radio"><input type="radio" checked={verdict === 'accept'} onChange={() => setVerdict('accept')} /> <span><strong>As notes with “Accept”</strong><br /><span className="muted">Small things the worker may take or leave; the change can go ahead.</span></span></label>
            </>
          ) : (
            <p className="muted">
              No review is open for this session, so they go {manager ? <>to its manager <strong>{manager.title}</strong></> : <>to <strong>{props.session.title}</strong> itself</>} as one message from you{manager ? ', to hand on as a review round' : ''}.
            </p>
          )}
          <textarea {...typing} className="box" placeholder="A note above the comments (optional)" value={text} onChange={(e) => setText(e.target.value)} />
          <details className="send-preview"><summary>What goes</summary><pre>{preview}</pre></details>
          <div className="send">
            <button onClick={() => setOpen(false)}>Cancel</button>
            <button className="primary" disabled={props.sending} onClick={() => void send()}>{review ? (verdict === 'accept' ? 'Send with Accept' : 'Send changes needed') : 'Send'}</button>
            <span className="status" role="status">{err}</span>
          </div>
        </div>
      )}
      <div className="comment-bar-row">
        <span>{n ? <><strong>{n} comment{n === 1 ? '' : 's'}</strong> <span className="chip draft">draft</span></> : <span className="muted">{props.sent ?? 'Click a line to comment on it.'}</span>}</span>
        <button className="primary" disabled={!n} onClick={() => setOpen(!open)} aria-expanded={open}>Send{review ? ' with review' : ''} ▾</button>
      </div>
    </div>
  );
}
