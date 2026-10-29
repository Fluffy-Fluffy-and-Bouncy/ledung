// "Waiting for you" as a question desk (issue #59), modelled on the Master Question Desk in Ledung's look:
// a queue grouped by what each answer unblocks (the tier), one question per page answered from the
// keyboard, and a One project / All filter. Permission prompts head the queue and the recently answered
// questions follow. What a manager is handling is not listed: the manager handles it (issue #96). Answers
// take the same path as the chat's question card.
import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CHATS, projectLabel, type ChatsInfo, type LinkPairingInfo, type NewComputerInfo, type PermissionInfo, type ProjectInfo, type QuestionInfo, type SessionInfo } from '../../../src/shared/protocol.ts';
import { disagree, MAX_BORDER_PARTS, mergeTiers, type DeskOpinion } from '../../../src/shared/questions.ts';
import { findTickets } from '../../../src/shared/tickets.ts';
import { api } from '../api.ts';
import { conversationOf } from '../conversation.ts';
import { readFilter, waitingLists, writeFilter, type Filter, type Item } from '../waitingLists.ts';
import { nameTint, questionLabel, withChatsColour } from '../nameTint.ts';
import { Markdown } from './Markdown.tsx';
import { formatTime } from './MessageList.tsx';
import { PermissionCard } from './PermissionCard.tsx';
import { RefersTo } from './RefersTo.tsx';
import { ReviewAnswer, ReviewEvidenceList, ReviewSections } from './ReviewView.tsx';
import { ScreenshotView, shotCount } from './ScreenshotView.tsx';
import { usePlainTyping } from '../usePlainTyping.ts';
import { Withdraw } from './Withdraw.tsx';
import { NewComputerCard } from './RelaySettings.tsx';
import { LinkPairingCard } from './LinkPairingCard.tsx';

export { waitingCount } from '../../../src/shared/waiting.ts';

const TIER_COLORS = ['var(--s2)', 'var(--s4)', 'var(--s1)', 'var(--s7)', 'var(--s5)', 'var(--s3)'];
const NO_TIER_COLOR = 'var(--s-other)';

export function WaitingView(props: {
  questions: QuestionInfo[];
  permissions: PermissionInfo[];
  sessions: SessionInfo[];
  projects: ProjectInfo[];
  /** For the chats' name colour (issue #222). */
  chats: ChatsInfo | null;
  userName: string;
  /** The open question, or null for the queue. */
  questionId: number | null;
  onOpenQuestion: (id: number | null) => void;
  onOpenSession: (id: string) => void;
  /** The question in the conversation of the manager who owns it (issue #61), or in this session's (issue #368). */
  onGoToConversation: (id: number, sessionId?: string) => void;
  /** A session's conversation at one of its messages: an attached reply's link (issue #369). */
  onGoToMessage?: (sessionId: string, messageId: number) => void;
  onClose: () => void;
  /** A question with screenshots answered or withdrawn: back to the view it was opened from (issue #92). */
  onLeaveShots: () => void;
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
  /** Computers that joined the relay and wait for the admin's Approve (issue #237): no project, so never filtered. */
  newComputers: NewComputerInfo[];
  /** Pairings linked computers asked for (issue #273). */
  linkPairings: LinkPairingInfo[];
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const [filter, setFilterState] = useState(() => readFilter(localStorage));
  const setFilter = (f: Filter) => {
    setFilterState(f);
    writeFilter(localStorage, f);
  };

  const sessionOf = (id: string) => props.sessions.find((s) => s.id === id);
  const titleOf = (id: string) => sessionOf(id)?.title ?? 'unknown';
  const nameOf = (id: string) => { const s = sessionOf(id); return s?.role === 'manager' ? `Manager "${s.title}"` : s?.title ?? 'Unknown session'; };
  const projectOf = (sessionId: string) => sessionOf(sessionId)?.project ?? '';
  const settingsOf = (name: string) => props.projects.find((p) => p.name === name);
  // Each question in the colour of whoever asked it (issue #135), as the message box is in the colour of whom you write to (#133).
  const tintOf = (sessionId: string) => nameTint(sessionOf(sessionId), withChatsColour(props.projects, props.chats));
  // Chats (issue #211) are filtered like a project, once there is one.
  const projectNames = [...props.projects.map((p) => p.name), ...(props.sessions.some((s) => s.project === CHATS) ? [CHATS] : [])];
  const shown = (p: string) => (filter.mode === 'all' ? !filter.hidden.includes(p) : p === filter.one);

  // Tier colours follow every project's tiers, so a tier keeps its colour whatever the filter shows.
  const allTiers = mergeTiers(props.projects.map((p) => p.questionTiers));
  const tierColor = (t: string | null) => (t === null ? NO_TIER_COLOR : TIER_COLORS[allTiers.indexOf(t) % TIER_COLORS.length] ?? NO_TIER_COLOR);
  const visibleTiers = mergeTiers(props.projects.filter((p) => shown(p.name)).map((p) => p.questionTiers));

  const { items, forYou, done, listFor } = waitingLists(props.questions, projectOf, (p) => settingsOf(p)?.questionTiers ?? [], shown, visibleTiers);
  const permsForYou = props.permissions.filter((p) => p.status === 'pending' && p.addressedTo === 'user' && shown(projectOf(p.sessionId))).sort((a, b) => a.at - b.at);
  const waitingIn = (name: string) =>
    items.filter((i) => i.q.status === 'open' && i.q.addressedTo === 'user' && i.project === name).length +
    props.permissions.filter((p) => p.status === 'pending' && p.addressedTo === 'user' && projectOf(p.sessionId) === name).length;

  const current = props.questionId === null ? null : items.find((i) => i.q.id === props.questionId) ?? null;

  const header = (sub: ReactNode, controls: ReactNode, conv?: QuestionInfo) => (
    <header className="desk-head">
      <button className="icon sidebar-toggle" title={`${props.sidebarHidden ? 'Show' : 'Hide'} the sidebar (S)`} aria-label={`${props.sidebarHidden ? 'Show' : 'Hide'} the sidebar`} aria-pressed={props.sidebarHidden} onClick={props.onToggleSidebar}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><path d="M6 2.5v11" /></svg>
      </button>
      <div className="head-main">
        <div className="head-text"><h2>Waiting for you</h2><div className="muted">{sub}</div></div>
        <div className="head-controls">{controls}</div>
      </div>
      {conv && (
        <button className="small conv" title={`Go to conversation (C): ${nameOf(conversationOf(conv))}`} onClick={() => props.onGoToConversation(conv.id)}>
          <ConvIcon /><span className="conv-text">Go to conversation</span>
        </button>
      )}
      <button className="icon" title="Close: back to the view before" aria-label="Close" onClick={props.onClose}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
      </button>
    </header>
  );

  const ctx: DeskContext = { props, nameOf, titleOf, tierColor, tintOf, settingsOf, header };

  if (props.questionId !== null) {
    if (!current) {
      return (
        <div className="waiting-view desk-view">
          {header('', <button onClick={() => props.onOpenQuestion(null)}>← Queue</button>)}
          <div className="desk"><div className="desk-body"><div className="empty-box">Question #{props.questionId} is not here: it may be older than the recent ones Ledung keeps in view.</div></div></div>
        </div>
      );
    }
    const list = listFor(current);
    const after = (id: number) => {
      // After an answer, the next open question: the next in the same list, else the first one waiting for you.
      const rest = list.filter((i) => i.q.id !== id && i.q.status === 'open');
      const next = rest[Math.max(0, list.findIndex((i) => i.q.id === id))] ?? forYou.find((i) => i.q.id !== id);
      props.onOpenQuestion(next ? next.q.id : null);
    };
    // A question with screenshots opens straight into the screenshot view (issue #60); sending leaves it for the
    // view it was opened from, not the next question (Martin, issue #92).
    if (current.v.review) return <ReviewPage key={current.q.id} ctx={ctx} item={current} list={list} onAnswered={after} />;
    if (current.q.shots) return <ShotPage key={current.q.id} ctx={ctx} item={current} list={list} onAnswered={props.onLeaveShots} />;
    return <QuestionPage key={current.q.id} ctx={ctx} item={current} list={list} onAnswered={after} />;
  }

  return (
    <Queue
      ctx={ctx}
      filter={filter}
      setFilter={setFilter}
      projectNames={projectNames}
      waitingIn={waitingIn}
      forYou={forYou}
      done={done}
      permsForYou={permsForYou}
      tiers={visibleTiers}
    />
  );
}

interface DeskContext {
  props: Parameters<typeof WaitingView>[0];
  nameOf: (sessionId: string) => string;
  titleOf: (sessionId: string) => string;
  tierColor: (t: string | null) => string;
  tintOf: (sessionId: string) => CSSProperties | undefined;
  settingsOf: (project: string) => ProjectInfo | undefined;
  header: (sub: ReactNode, controls: ReactNode, conv?: QuestionInfo) => ReactNode;
}

const ConvIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></svg>
);

/** Keys pressed outside a text box (or Escape anywhere), while the view is open. */
function useKeys(handler: (e: KeyboardEvent, inText: boolean) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const inText = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT');
      ref.current(e, inText);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';
const excerpt = (text: string) => text.replace(/\*\*|`|^#+\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, 180);

function Queue(p: {
  ctx: DeskContext;
  filter: Filter;
  setFilter: (f: Filter) => void;
  projectNames: string[];
  waitingIn: (name: string) => number;
  forYou: Item[];
  done: Item[];
  permsForYou: PermissionInfo[];
  tiers: string[];
}) {
  const { props, nameOf, titleOf, tierColor, tintOf, header } = p.ctx;
  const { filter, setFilter } = p;
  const setMode = (mode: Filter['mode']) => setFilter({ ...filter, mode, one: p.projectNames.includes(filter.one) ? filter.one : p.projectNames[0] ?? '' });
  const nextProject = () => {
    const ps = p.projectNames;
    if (ps.length) setFilter({ ...filter, mode: 'one', one: ps[(ps.indexOf(filter.one) + 1) % ps.length]! });
  };

  useKeys((e, inText) => {
    if (e.key === 'Escape') {
      if (inText) (document.activeElement as HTMLElement).blur(); else props.onClose();
      return;
    }
    if (inText || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 's') props.onToggleSidebar();
    else if (e.key === 'Enter' && p.forYou[0] && document.activeElement?.tagName !== 'BUTTON' && document.activeElement?.tagName !== 'A') {
      e.preventDefault();
      props.onOpenQuestion(p.forYou[0].q.id);
    } else if (/^[1-9]$/.test(e.key) && p.forYou[Number(e.key) - 1]) props.onOpenQuestion(p.forYou[Number(e.key) - 1]!.q.id);
    else if (k === 'a') setMode(filter.mode === 'all' ? 'one' : 'all');
    else if (k === 'p') nextProject();
  });

  const waiting = p.forYou.length + p.permsForYou.length + props.newComputers.length + props.linkPairings.length;
  const answered = p.done.filter((i) => i.q.status === 'answered').length;
  const row = (i: Item, place: number | null) => {
    const { q, v } = i;
    const isDone = q.status !== 'open';
    // The asker's colour, answered or not: the place mark and the pill say it is answered or withdrawn (issue #135).
    const tint = tintOf(q.sessionId);
    return (
      <div key={q.id} className="qrow-wrap">
        <button className={`qrow name-tinted${tint ? ' tinted' : ''}${isDone ? ' done' : ''}`} style={tint} onClick={() => props.onOpenQuestion(q.id)}>
          <span className="border-label">{questionLabel(i.tier, i.project)}</span>
          <span className="place">{isDone ? (q.status === 'answered' ? '✓' : '–') : place ?? '·'}</span>
          <span className="t">{v.title}{disagree(v.opinions) && !isDone && <> <span className="split">They disagree</span></>}</span>
          {isDone
            ? q.status === 'answered'
              ? <span className="pill">{q.answeredBy === 'user' ? 'You' : 'Manager'} · {formatTime(q.answeredAt ?? q.askedAt)}</span>
              : <span className="pill grey">Withdrawn</span>
            : <span className="when">{formatTime(q.askedAt)}</span>}
          <span className="meta">
            <span>#{q.id}</span><span>{nameOf(q.sessionId)}</span>
            {q.aboutQuestion !== null && <span>· about #{q.aboutQuestion}</span>}
            {!v.structured && <span className="chip">plain</span>}
            {v.review && <span className="chip review-chip">Review</span>}
            {q.shots && <span className="chip shot-chip">{shotCount(q)}</span>}
          </span>
          {/* A review's excerpt is the first line of what we were solving (docs/steps/pr-review.md). */}
          <span className="excerpt">{isDone ? (q.status === 'answered' ? excerpt(q.answer ?? '') : q.withdrawnReason ?? '') : excerpt(v.review ? firstLine(v.review.solving) : v.issue)}</span>
        </button>
        <button className="icon conv-row" title={`Go to conversation: ${nameOf(conversationOf(q))}`} aria-label={`Go to conversation of question #${q.id}`} onClick={() => props.onGoToConversation(q.id)}>
          <ConvIcon />
        </button>
      </div>
    );
  };
  const permission = (perm: PermissionInfo) => (
    <div key={perm.id} className="waiting-permission">
      <div className="waiting-from">
        <button className="link" onClick={() => props.onOpenSession(perm.sessionId)}>{titleOf(perm.sessionId)}</button>
        <span className="muted"> ({projectLabel(props.sessions.find((s) => s.id === perm.sessionId)?.project ?? '')}) · {formatTime(perm.at)}</span>
      </div>
      <PermissionCard permission={perm} />
    </div>
  );
  const groupHead = (label: string, color: string, count?: number) => (
    <h3 className="group-head" style={{ '--c': color } as CSSProperties}><i />{label}{count !== undefined && <span className="count">{count}</span>}</h3>
  );

  const filterControls = (
    <div className="filter">
      <div className="seg-control" role="group" aria-label="Show">
        <button className={filter.mode === 'one' ? 'on' : ''} aria-pressed={filter.mode === 'one'} onClick={() => setMode('one')}>One project</button>
        <button className={filter.mode === 'all' ? 'on' : ''} aria-pressed={filter.mode === 'all'} onClick={() => setMode('all')}>All</button>
      </div>
      <div className="projs">
        {p.projectNames.map((name) => {
          const on = filter.mode === 'all' ? !filter.hidden.includes(name) : name === filter.one;
          const click = () => filter.mode === 'one'
            ? setFilter({ ...filter, one: name })
            : setFilter({ ...filter, hidden: filter.hidden.includes(name) ? filter.hidden.filter((x) => x !== name) : [...filter.hidden, name] });
          return (
            <button key={name} className={`proj ${on ? 'on' : 'off'}`} aria-pressed={on} onClick={click}>
              {filter.mode === 'all' && <span className="box">{on ? '✓' : ''}</span>}
              {projectLabel(name)} <b>{p.waitingIn(name)}</b>
            </button>
          );
        })}
      </div>
    </div>
  );

  let place = 0;
  return (
    <div className="waiting-view desk-view">
      {header(<span className="tally"><b>{waiting}</b> waiting · <b>{answered}</b> answered</span>, filterControls)}
      <div className="desk">
        <div className="desk-body">
          <p className="lede muted">Ordered by what each answer unblocks, and each answer takes you to the next.<span className="kbd-hint"> <kbd>Enter</kbd> opens the first question.</span></p>
          {!waiting && <div className="empty-box">Nothing is waiting for you{filter.mode === 'one' && filter.one ? ` in ${filter.one}` : ''}. New questions appear here as they are asked.</div>}
          {props.newComputers.length > 0 && <>{groupHead('New computers', 'var(--warn-border)', props.newComputers.length)}{props.newComputers.map((c) => <NewComputerCard key={c.name} computer={c} run={props.run} />)}</>}
          {props.linkPairings.length > 0 && <>{groupHead('Paired through the link', 'var(--warn-border)', props.linkPairings.length)}{props.linkPairings.map((l) => <LinkPairingCard key={l.id} pairing={l} run={props.run} />)}</>}
          {p.permsForYou.length > 0 && <>{groupHead('Permission prompts', 'var(--warn-border)', p.permsForYou.length)}{p.permsForYou.map(permission)}</>}
          {[...p.tiers, null].map((t) => {
            const qs = p.forYou.filter((i) => i.tier === t);
            if (!qs.length) return null;
            return (
              <div key={t ?? ''} className="group">
                {/* Only questions from before every question needed a tier (issue #96) have none. */}
                {groupHead(t ?? 'Older, without a tier', tierColor(t), qs.length)}
                {qs.map((i) => row(i, ++place))}
              </div>
            );
          })}
          {p.done.length > 0 && <>{groupHead('Answered recently', 'var(--ok)')}{p.done.map((i) => row(i, null))}</>}
          <div className="keys">
            <span><kbd>Enter</kbd> first question</span><span><kbd>1</kbd>–<kbd>9</kbd> open by place</span><span><kbd>P</kbd> next project</span>
            <span><kbd>A</kbd> one project / all</span><span><ConvIcon /> on a row: its conversation</span>
            <span><kbd>S</kbd> hide / show sidebar</span><span><kbd>Esc</kbd> close</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A review (docs/steps/pr-review.md): the desk's header, then its sections top to bottom, its evidence, and
 * Accept or Changes needed. A screenshot open large takes the keys until it closes, back on the review.
 */
function ReviewPage({ ctx, item, list, onAnswered }: { ctx: DeskContext; item: Item; list: Item[]; onAnswered: (id: number) => void }) {
  const { props, nameOf, titleOf, tintOf, settingsOf, header } = ctx;
  const { q, v, project, tier } = item;
  const review = v.review!;
  const evidence = review.evidence ?? [];
  const images = evidence.filter((e) => e.kind !== 'text');
  const [shown, setShown] = useState<number | null>(null);
  const [noteFocus, setNoteFocus] = useState(0);
  const idx = list.findIndex((i) => i.q.id === q.id);
  const step = (d: number) => { const t = list[idx + d]; if (idx >= 0 && t) props.onOpenQuestion(t.q.id); };

  /** Opens or closes the large view; closing puts the focus back on the thumbnail it was opened from. */
  const show = (i: number | null) => {
    const was = shown;
    setShown(i);
    if (i === null && was !== null) setTimeout(() => document.querySelectorAll<HTMLElement>('.rev-thumb')[was]?.focus());
  };

  useKeys((e, inText) => {
    if (shown !== null) {
      if (e.key === 'Escape') show(null);
      else if (e.key === 'ArrowRight') show((shown + 1) % images.length);
      else if (e.key === 'ArrowLeft') show((shown - 1 + images.length) % images.length);
      else if (e.key === 'Tab') {
        // The large view is a dialog: Tab stays in it, so Enter can't answer the review behind it (review finding 5).
        const inside = [...document.querySelectorAll<HTMLElement>('.rev-large button')];
        const at = inside.indexOf(document.activeElement as HTMLElement);
        inside[(at + (e.shiftKey ? -1 : 1) + inside.length) % inside.length]?.focus();
      } else return;
      e.preventDefault();
      return;
    }
    // An unfolded text file scrolls with the arrow keys: they move in it, not to another question (review finding 1).
    const inLog = !!(document.activeElement as HTMLElement | null)?.closest('.rev-text-body');
    if (e.key === 'Escape') {
      if (inText || inLog) (document.activeElement as HTMLElement).blur(); else props.onOpenQuestion(null);
      return;
    }
    if (inText || inLog || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 's') props.onToggleSidebar();
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (k === 'c') props.onGoToConversation(q.id);
    else if (k === 'n' && q.status === 'open') { e.preventDefault(); setNoteFocus((n) => n + 1); }
  });

  const asker = nameOf(q.sessionId);
  const tickets = settingsOf(project)?.tickets ?? undefined;
  const refLink = (r: string) => findTickets([r], tickets)[0]?.url;
  const answeredBy = q.answeredBy === 'user'
    ? q.forwardedFrom !== null ? `${props.userName} (passed on by the manager)` : props.userName
    : `Manager "${titleOf(q.answeredBy ?? '')}", under its standing grant`;
  const posText = q.status === 'open'
    ? q.addressedTo === 'user' ? `${idx + 1} of ${list.length} waiting` : `Manager "${titleOf(q.addressedTo)}" is handling it`
    : q.status === 'answered' ? 'Answered' : 'Withdrawn';

  return (
    <div className="waiting-view desk-view">
      {header(posText, (
        <div className="qbar">
          <button onClick={() => props.onOpenQuestion(null)}>← Queue</button>
          <button disabled={idx <= 0} aria-label="Previous question" title="Previous question (←)" onClick={() => step(-1)}>←</button>
          <button disabled={idx < 0 || idx >= list.length - 1} aria-label="Next question" title="Next question (→)" onClick={() => step(1)}>→</button>
        </div>
      ), q)}
      <div className={`desk${shown !== null ? " locked" : ""}`}>
        <div className="desk-body review">
          <div className={`qhead name-tinted${tintOf(q.sessionId) ? ' tinted' : ''}`} style={tintOf(q.sessionId)}>
            <span className="border-label">{questionLabel(tier, project)}</span>
            <div className="meta">
              <span className="chip review-chip">Review</span>
              <strong>#{q.id}</strong>
              <span className="chip">{projectLabel(project)}</span>
              <span className="muted">· <button className="link" onClick={() => props.onOpenSession(q.sessionId)}>{asker}</button> · asked {formatTime(q.askedAt)}</span>
              {q.addressedTo !== 'user' && <span className="muted">· to manager "{titleOf(q.addressedTo)}"</span>}
            </div>
            <h3>{v.title}</h3>
            {v.refs.length > 0 && (
              <div className="refs">
                {v.refs.map((r) => { const url = refLink(r); return url ? <a key={r} className="chip" href={url} target="_blank" rel="noreferrer noopener">{r}</a> : <span key={r} className="chip">{r}</span>; })}
              </div>
            )}
          </div>
          {q.status === 'open' && q.addressedTo !== 'user' && (
            <div className="handled">Manager "{titleOf(q.addressedTo)}" is handling this. Answer it here yourself and the manager is told.</div>
          )}
          <RefersTo q={q} userName={props.userName} nameOf={nameOf} tintOf={tintOf} onOpenConversation={(s, id) => props.onGoToConversation(id, s)} onOpenMessage={props.onGoToMessage} onOpenQuestion={(id) => props.questions.some((x) => x.id === id) ? () => props.onOpenQuestion(id) : null} />
          <ReviewSections review={review} sessionId={q.sessionId} />
          {evidence.length > 0 && <ReviewEvidenceList q={q} evidence={evidence} shown={shown} onShow={show} />}
          <ReviewAnswer q={q} answeredBy={answeredBy} noteFocus={noteFocus} onAnswered={() => onAnswered(q.id)} />
          <div className="keys">
            {q.status === 'open' && <span><kbd>N</kbd> note</span>}
            <span><kbd>←</kbd><kbd>→</kbd> previous / next</span><span><kbd>C</kbd> conversation</span><span><kbd>Esc</kbd> queue</span><span><kbd>S</kbd> sidebar</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A question with screenshots: the desk's header, then the screenshot view. */
function ShotPage({ ctx, item, list, onAnswered }: { ctx: DeskContext; item: Item; list: Item[]; onAnswered: () => void }) {
  const { props, nameOf, titleOf, header } = ctx;
  const { q, v, project } = item;
  const idx = list.findIndex((i) => i.q.id === q.id);
  const step = (d: number) => { const t = list[idx + d]; if (idx >= 0 && t) props.onOpenQuestion(t.q.id); };
  const posText = q.status === 'open'
    ? q.addressedTo === 'user' ? `${idx + 1} of ${list.length} waiting` : `Manager "${titleOf(q.addressedTo)}" is handling it`
    : q.status === 'answered' ? 'Answered' : 'Withdrawn';
  return (
    <div className="waiting-view desk-view">
      {header(posText, (
        <div className="qbar">
          <button onClick={() => props.onOpenQuestion(null)}>← Queue</button>
          <button disabled={idx <= 0} aria-label="Previous question" title="Previous question" onClick={() => step(-1)}>←</button>
          <button disabled={idx < 0 || idx >= list.length - 1} aria-label="Next question" title="Next question" onClick={() => step(1)}>→</button>
        </div>
      ), q)}
      <ScreenshotView
        question={{ ...q, shots: q.shots! }}
        title={v.title}
        issue={v.issue}
        evidence={v.evidence}
        options={v.options}
        opinions={v.opinions.map((o) => ({ ...o, who: o.who ?? nameOf(q.sessionId) }))}
        userName={props.userName}
        session={{ title: nameOf(q.sessionId), project, onOpen: () => props.onOpenSession(q.sessionId) }}
        onClose={() => props.onOpenQuestion(null)}
        onDone={onAnswered}
        onToggleSidebar={props.onToggleSidebar}
        onGoToConversation={() => props.onGoToConversation(q.id)}
        withdrawnIds={props.questions.filter((o) => o.status === 'withdrawn').map((o) => o.id)}
        refersTo={<RefersTo q={q} userName={props.userName} nameOf={nameOf} tintOf={ctx.tintOf} onOpenConversation={(s, id) => props.onGoToConversation(id, s)} onOpenMessage={props.onGoToMessage} onOpenQuestion={(id) => props.questions.some((x) => x.id === id) ? () => props.onOpenQuestion(id) : null} />}
      />
    </div>
  );
}

/** What the pick marks on the options mean, for the opinions this question has. */
function Legend({ opinions, whoOf }: { opinions: DeskOpinion[]; whoOf: (o: DeskOpinion) => string }) {
  const n = opinions.length;
  if (!n) return null;
  if (n === 1) return <div className="legend"><span>Green border: {whoOf(opinions[0]!)}'s pick</span></div>;
  if (n > MAX_BORDER_PARTS) return <div className="legend"><span>{n} opinions: each option says who picked it</span></div>;
  return (
    <div className="legend">
      <span>Green border in {n} parts, one per opinion, left to right:</span>
      {opinions.map((o, i) => <span key={i}><PartKey i={i} n={n} />{whoOf(o)}</span>)}
      <span>Whole border: they all agree</span>
    </div>
  );
}

/** A small border split in `n`, part `i` lit: which part of an option's border is this opinion's. */
const PartKey = ({ i, n }: { i: number; n: number }) => (
  <span className="part-key" aria-hidden="true">{Array.from({ length: n }, (_, j) => <i key={j} className={j === i ? 'on' : ''} />)}</span>
);

function QuestionPage({ ctx, item, list, onAnswered }: { ctx: DeskContext; item: Item; list: Item[]; onAnswered: (id: number) => void }) {
  const typing = usePlainTyping();
  const { props, nameOf, titleOf, tintOf, settingsOf, header } = ctx;
  const { q, v, project, tier } = item;
  const open = q.status === 'open';
  const [sel, setSel] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const idx = list.findIndex((i) => i.q.id === q.id);
  const otherKey = v.options.length + 1;
  // A question about a permission request is decided by its exact answer, so no note goes with it (issue #51).
  const takesNote = !q.aboutRequest;

  useEffect(() => { if (sel === 'other') otherRef.current?.focus(); }, [sel]);

  const step = (d: number) => { const t = list[idx + d]; if (idx >= 0 && t) props.onOpenQuestion(t.q.id); };
  const pick = (key: string) => { setSel(key); setErr(''); };
  const send = async () => {
    if (!open || busy) return;
    if (!sel) return setErr('Pick an option first.');
    if (sel === 'other' && !other.trim()) { setErr('Write your answer in the box first.'); otherRef.current?.focus(); return; }
    const chosen = sel === 'other' ? other.trim() : v.options.find((o) => o.key === sel)!.answer;
    const answer = takesNote && note.trim() ? `${chosen}\n\nNote: ${note.trim()}` : chosen;
    setBusy(true);
    setErr('');
    try {
      await api.answerQuestion(q.id, answer);
      onAnswered(q.id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const withdraw = async () => {
    setBusy(true);
    try {
      await api.withdrawQuestion(q.id);
      onAnswered(q.id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  useKeys((e, inText) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void send(); return; }
    if (e.key === 'Escape') {
      if (inText) (document.activeElement as HTMLElement).blur(); else props.onOpenQuestion(null);
      return;
    }
    if (inText || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 's') props.onToggleSidebar();
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (k === 'c') props.onGoToConversation(q.id);
    else if (!open) return;
    else if (/^[1-9]$/.test(e.key)) {
      // preventDefault: otherwise the digit also lands in the Other box that picking it focuses.
      const n = Number(e.key);
      if (n <= v.options.length) { e.preventDefault(); pick(v.options[n - 1]!.key); }
      else if (n === otherKey) { e.preventDefault(); pick('other'); }
    } else if (k === 'n' && takesNote) { e.preventDefault(); noteRef.current?.focus(); }
  });

  const asker = nameOf(q.sessionId);
  const tickets = settingsOf(project)?.tickets ?? undefined;
  const refLink = (r: string) => findTickets([r], tickets)[0]?.url;
  const chosenKey = q.status === 'answered' && q.answer !== null
    ? v.options.find((o) => q.answer === o.answer || q.answer!.startsWith(`${o.answer}\n\nNote: `))?.key ?? null
    : null;
  const answeredBy = q.answeredBy === 'user'
    ? q.forwardedFrom !== null ? `${props.userName} (passed on by the manager)` : props.userName
    : `Manager "${titleOf(q.answeredBy ?? '')}", under its standing grant`;
  const pickLabel = (key: string) => {
    const i = v.options.findIndex((o) => o.key === key);
    return i < 0 ? key : `${i + 1} · ${v.options[i]!.label.replace(/\*\*/g, '')}`;
  };
  const posText = q.status === 'open'
    ? q.addressedTo === 'user' ? `${idx + 1} of ${list.length} waiting` : `Manager "${titleOf(q.addressedTo)}" is handling it`
    : q.status === 'answered' ? 'Answered' : 'Withdrawn';
  const mdText = (text: string) => <Markdown text={text} sessionId={q.sessionId} />;
  const ops = v.opinions;
  // Up to five opinions split each option's border, one part each; more are named in writing (issue #96).
  const split = ops.length <= MAX_BORDER_PARTS;
  const whoOf = (o: DeskOpinion) => o.who ?? asker;
  const part = (i: number) => ({ '--i': i, '--n': ops.length }) as CSSProperties;

  return (
    <div className="waiting-view desk-view">
      {header(posText, (
        <div className="qbar">
          <button onClick={() => props.onOpenQuestion(null)}>← Queue</button>
          <button disabled={idx <= 0} aria-label="Previous question" title="Previous question (←)" onClick={() => step(-1)}>←</button>
          <button disabled={idx < 0 || idx >= list.length - 1} aria-label="Next question" title="Next question (→)" onClick={() => step(1)}>→</button>
        </div>
      ), q)}
      <div className="desk">
        <div className="desk-body">
          <div className={`qhead name-tinted${tintOf(q.sessionId) ? ' tinted' : ''}`} style={tintOf(q.sessionId)}>
            <span className="border-label">{questionLabel(tier, project)}</span>
            <div className="meta">
              <strong>Question #{q.id}</strong>
              <span className="muted">· <button className="link" onClick={() => props.onOpenSession(q.sessionId)}>{asker}</button> · asked {formatTime(q.askedAt)}</span>
              {q.addressedTo !== 'user' && <span className="muted">· to manager "{titleOf(q.addressedTo)}"</span>}
              {!v.structured && <span className="chip" title="Asked with text and option labels only">plain question</span>}
              {!v.structured && <span className="muted touch-only">· asked with text and option labels only</span>}
            </div>
            <h3>{v.title}</h3>
            {v.refs.length > 0 && (
              <div className="refs">
                {v.refs.map((r) => { const url = refLink(r); return url ? <a key={r} className="chip" href={url} target="_blank" rel="noreferrer noopener">{r}</a> : <span key={r} className="chip">{r}</span>; })}
              </div>
            )}
          </div>

          {open && q.addressedTo !== 'user' && (
            <div className="handled">Manager "{titleOf(q.addressedTo)}" is handling this. Answer it here yourself and the manager is told.</div>
          )}
          {q.aboutRequest && open && (
            <p className="sensitive-note"><strong>Permission request</strong>: your answer decides it. The first option allows it once; any other answer denies it, with your words as the reason.</p>
          )}
          <RefersTo q={q} userName={props.userName} nameOf={nameOf} tintOf={tintOf} onOpenConversation={(s, id) => props.onGoToConversation(id, s)} onOpenMessage={props.onGoToMessage} onOpenQuestion={(id) => props.questions.some((x) => x.id === id) ? () => props.onOpenQuestion(id) : null} />

          {v.issue && <section className="block"><h4>The issue</h4><div className="issue prose">{mdText(v.issue)}</div></section>}
          {v.evidence && <section className="block"><details className="ev"><summary>Evidence</summary><div className="prose">{mdText(v.evidence)}</div></details></section>}

          {q.status === 'answered' && (
            <section className="block">
              <h4>Answer</h4>
              <div className="answered-box">
                <div><strong>{answeredBy}:</strong> {q.answer}</div>
                <div className="muted">answered {formatTime(q.answeredAt ?? q.askedAt)} · {q.deliveredAt ? `delivered ${formatTime(q.deliveredAt)}` : 'not delivered yet: it goes in as soon as the session is free'}</div>
              </div>
            </section>
          )}
          {q.status === 'withdrawn' && (
            <section className="block"><h4>Withdrawn</h4><div className="answered-box withdrawn"><div className="muted">Withdrawn{q.withdrawnReason ? `: ${q.withdrawnReason}` : ''}</div></div></section>
          )}

          {(v.options.length > 0 || open) && (
            <section className="block opts-block">
              <h4>Options</h4>
              {v.options.length > 0 && <Legend opinions={ops} whoOf={whoOf} />}
              <div className="opts" role="radiogroup" aria-label="Options">
                {v.options.map((o, i) => {
                  const on = open ? sel === o.key : chosenKey === o.key;
                  return (
                    <button key={o.key} className={`opt${on ? ' on' : ''}`} role="radio" aria-checked={on} disabled={!open} onClick={() => pick(o.key)}>
                      <span className="k">{i + 1}</span>
                      <span className="lab">{v.structured && <span className="letter">{o.key}</span>}{o.label.replace(/\*\*/g, '')}</span>
                      {o.detail && <span className="det prose">{mdText(o.detail)}</span>}
                      {o.cost && <span className="cost muted"><b>Cost</b> · {o.cost}</span>}
                      {split && ops.map((op, j) => op.pick === o.key && (
                        <Fragment key={j}>
                          <span className={`edge${j === 0 ? ' first' : ''}${j === ops.length - 1 ? ' last' : ''}`} style={part(j)} />
                          <span className="tag who" style={part(j)} title={whoOf(op)}>{whoOf(op)}</span>
                        </Fragment>
                      ))}
                      {/* The tags on the border cut long names short, the full name in a tooltip a phone can't open (#176). */}
                      {ops.some((op) => op.pick === o.key) && (
                        <span className={`picked-by${split ? ' touch-only' : ''}`}><b>Picked by</b> {ops.filter((op) => op.pick === o.key).map(whoOf).join(', ')}</span>
                      )}
                      {!open && on && <span className="tag answer">Answer</span>}
                    </button>
                  );
                })}
                {open && (
                  <button className={`opt${sel === 'other' ? ' on' : ''}`} role="radio" aria-checked={sel === 'other'} onClick={() => pick('other')}>
                    <span className="k">{otherKey}</span>
                    <span className="lab">Other answer</span>
                    <span className="det">{q.aboutRequest ? 'Deny it, saying why in your own words.' : 'Say it in your own words.'}</span>
                  </button>
                )}
              </div>
              {open && sel === 'other' && (
                <textarea {...typing} ref={otherRef} className="box" placeholder="Your answer, in your own words" value={other} onChange={(e) => setOther(e.target.value)} />
              )}
            </section>
          )}

          {(v.structured || ops.length > 0) && (
            <section className="block">
              <h4>Opinions{disagree(ops) && <span className="split">They disagree</span>}</h4>
              {ops.length ? (
                <div className="recs">
                  {ops.map((op, j) => (
                    <div key={j}>
                      <div className="rec-label muted">
                        {split && ops.length > 1 && <PartKey i={j} n={ops.length} />}
                        {whoOf(op)}{op.who === null && ' (asker)'}
                      </div>
                      <div className={`rec${op.pick ? '' : ' empty'}`}>
                        <div className="pick">{op.pick ? pickLabel(op.pick) : 'No pick among the options'}</div>
                        <div className="prose">{op.why ? mdText(op.why) : <span className="none">{v.structured ? 'No reason given.' : 'Marked "(recommended)"; a plain question gives no reason.'}</span>}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : <div className="rec empty"><div className="none">No opinions given.</div></div>}
            </section>
          )}

          {open && (
            <section className="block note-block">
              {takesNote && (
                <>
                  <h4>Note <span className="opt-in">(optional, goes with the answer)</span></h4>
                  <textarea {...typing} ref={noteRef} className="box" placeholder="Anything to go with the answer" value={note} onChange={(e) => setNote(e.target.value)} />
                </>
              )}
              <div className="send">
                <button className="primary" disabled={!sel || busy} onClick={() => void send()}>Send answer</button>
                <span className="muted send-hint"><kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd> sends</span>
                <span className="status" role="status">{err}</span>
              </div>
              <Withdraw busy={busy} onWithdraw={() => void withdraw()} />
            </section>
          )}
          <div className="keys">
            {open && <span><kbd>1</kbd>–<kbd>{otherKey}</kbd> pick ({otherKey}: other)</span>}
            {open && takesNote && <span><kbd>N</kbd> note</span>}
            <span><kbd>←</kbd><kbd>→</kbd> previous / next</span><span><kbd>C</kbd> conversation</span><span><kbd>Esc</kbd> queue</span><span><kbd>S</kbd> sidebar</span>
          </div>
        </div>
      </div>
      {/* On a phone Send sat two screens down, so a bar pinned under the page holds it with the pick (issue #173);
          the Send above is hidden there, and this bar is hidden wider. */}
      {open && (
        <div className="send-bar">
          <span className={`send-pick${sel ? '' : ' muted'}`}>{sel === null ? 'No option picked yet' : sel === 'other' ? `${otherKey} · Other answer` : pickLabel(sel)}</span>
          <button className="primary" disabled={!sel || busy} onClick={() => void send()}>Send answer</button>
          {err && <span className="status" role="status">{err}</span>}
        </div>
      )}
    </div>
  );
}
