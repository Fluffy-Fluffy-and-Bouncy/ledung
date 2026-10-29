// A question with screenshots, judged one shot at a time (issue #60): modelled on the Shot Judge, in
// Ledung's own look. A large image with a strip of thumbnails grouped by issue on the left; the slip on
// the right with the question, the shot's facts, what to look for, what others thought, and Pass / Fail /
// Unsure with a note. Sending turns the verdicts into the question's answer through the ordinary answer.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { projectLabel, type QuestionInfo, type QuestionShot, type ShotVerdict } from '../../../src/shared/protocol.ts';
import { OPINION_WORDS, shotAnswer, VERDICT_LABEL, VERDICTS } from '../../../src/shared/shots.ts';
import type { DeskOption } from '../../../src/shared/questions.ts';
import { api } from '../api.ts';
import { afterVerdict, isSendKey, sendStep, sendsVerdicts } from '../deskNav.ts';
import { carriedFrom, emptyDraft, fillGaps, shotDrafts as drafts, verdictCount, type ShotDraft as Draft } from '../shotDrafts.ts';
import { Markdown } from './Markdown.tsx';
import { formatTime } from './MessageList.tsx';
import { imageUrl, ProjectImage } from './ProjectImage.tsx';
import { usePlainTyping } from '../usePlainTyping.ts';
import { pinsShotTop } from '../shotPin.ts';
import { coarsePointer } from '../coarsePointer.ts';
import { Withdraw } from './Withdraw.tsx';

const ORDER_KEY = 'ledung-shots-order';

/** "Looks off first": by what the others thought, worst first; else as attached. */
function rank(s: QuestionShot): number {
  const v = s.opinions.find((o) => o.verdict)?.verdict;
  return v === 'fail' ? 0 : v === 'unsure' ? 1 : v === 'pass' ? 3 : 2;
}

export function ScreenshotView(props: {
  question: QuestionInfo & { shots: QuestionShot[] };
  /**
   * The question desk's title, issue, evidence and options for it (issue #59): shown with the shots, not
   * folded away, so the shots are judged in their context (docs/steps/pr-review.md, "the generic fix").
   * The options are what the asker offered; the verdicts are still the answer.
   */
  title: string;
  issue: string;
  evidence?: string;
  options?: DeskOption[];
  /** Who picked which option; `who` already named. */
  opinions?: { who: string; pick: string | null }[];
  userName: string;
  /** Which session asked, with a way to open it. */
  session: { title: string; project: string; onOpen: () => void };
  /** Back to the queue (Esc). */
  onClose: () => void;
  /** After a send or a withdraw: back to the view it was opened from (issue #92). */
  onDone?: () => void;
  onToggleSidebar?: () => void;
  /** The question in its manager's conversation (C, issue #61). */
  onGoToConversation?: () => void;
  /** The questions withdrawn so far: verdicts given on them follow their files here (issue #138). */
  withdrawnIds: number[];
  /** What the question refers to (issue #368), under its title. */
  refersTo?: ReactNode;
}) {
  const typing = usePlainTyping();
  const q = props.question;
  const open = q.status === 'open';
  // Leaving a question (Back, the queue, another question) and coming back keeps the verdicts given so far;
  // shots without one take those given on the same file in a withdrawn question of the project.
  const fill = (d: Draft) => (open ? fillGaps(q.id, d, drafts, (id) => props.withdrawnIds.includes(id)) : d);
  const [draft, setDraftState] = useState<Draft>(() => {
    const d = fill(drafts.get(q.id) ?? emptyDraft(q.shots, props.session.project));
    drafts.set(q.id, d);
    return d;
  });
  const [offFirst, setOffFirst] = useState(() => {
    try {
      return localStorage.getItem(ORDER_KEY) === 'off-first';
    } catch {
      return false;
    }
  });
  // Shots are kept by their place in the question (attachment order), shown in the chosen order.
  const order = useMemo(() => {
    const all = q.shots.map((_, i) => i);
    return offFirst ? all.sort((a, b) => rank(q.shots[a]!) - rank(q.shots[b]!) || a - b) : all;
  }, [q.shots, offFirst]);
  // Opens on the first shot without a verdict: on a judged one, the same verdict again would take it away (issue #138).
  const [cur, setCur] = useState(() => {
    const first = sendStep(order, (i) => draft.judged[i]?.verdict, null, 0);
    return 'to' in first ? first.to : 0;
  });
  const [noteFocus, setNoteFocus] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** When Send showed the shots still without a verdict (issue #138); a later send sends them as "no verdict". */
  const [missingShownAt, setMissingShownAt] = useState<number | null>(null);

  const setDraft = (d: Draft) => {
    drafts.set(q.id, d);
    setDraftState(d);
    setMissingShownAt(null);
  };
  // A question withdrawn while this one is open: its verdicts fill this one's gaps now (#141 review, finding 2).
  const withdrawnKey = props.withdrawnIds.join(',');
  useEffect(() => {
    const current = drafts.get(q.id) ?? draft;
    const next = fill(current);
    if (next !== current) setDraft(next);
  }, [withdrawnKey]);

  const k = Math.min(cur, order.length - 1);
  const index = order[k]!;
  const shot = q.shots[index]!;
  const mine = draft.judged[index];
  const judgedCount = q.shots.filter((_, i) => draft.judged[i]?.verdict).length;

  const go = (to: number) => setCur((to + order.length) % order.length);
  /** ↑/↓: the first shot of the next or previous group. */
  const jumpGroup = (dir: 1 | -1) => {
    const group = shot.group;
    let j = k;
    do j = (j + dir + order.length) % order.length;
    while (q.shots[order[j]!]!.group === group && j !== k);
    while (dir < 0 && j > 0 && q.shots[order[j - 1]!]!.group === q.shots[order[j]!]!.group) j--;
    go(j);
  };
  /** A key or a click marks the shot and moves on to the next one not judged; the same verdict again un-marks (issue #92). */
  const setVerdict = (v: ShotVerdict) => {
    if (!open) return;
    const { verdict, to } = afterVerdict(order, (i) => draft.judged[i]?.verdict, k, mine?.verdict, v);
    // Judged here: no longer marked as carried, and never filled from elsewhere again.
    const carried = { ...draft.carried };
    delete carried[index];
    setDraft({ ...draft, judged: { ...draft.judged, [index]: { verdict, note: mine?.note ?? '' } }, carried, touched: { ...draft.touched, [index]: true } });
    if (to !== k) go(to);
  };
  const setShotNote = (note: string) => setDraft({ ...draft, judged: { ...draft.judged, [index]: { verdict: mine?.verdict ?? null, note } } });
  const toggleOrder = () => {
    const now = !offFirst;
    try {
      localStorage.setItem(ORDER_KEY, now ? 'off-first' : 'as-taken');
    } catch {
      // Not remembered; still switched.
    }
    setOffFirst(now);
    const all = q.shots.map((_, i) => i);
    const next = now ? all.sort((a, b) => rank(q.shots[a]!) - rank(q.shots[b]!) || a - b) : all;
    setCur(Math.max(0, next.indexOf(index)));
  };

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      drafts.delete(q.id);
      props.onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const send = () => {
    if (busy) return;
    if (!judgedCount) return setError('Judge at least one shot first.');
    const step = sendStep(order, (i) => draft.judged[i]?.verdict, missingShownAt, Date.now());
    if ('tooSoon' in step) return;
    if ('to' in step) {
      setMissingShownAt(Date.now());
      setError(null);
      go(step.to);
      return;
    }
    void act(() => api.answerQuestion(q.id, shotAnswer(q.shots, draft.judged, draft.note)));
  };
  const missing = q.shots.length - judgedCount;
  const missingShown = missingShownAt !== null && missing > 0;
  const carried = carriedFrom(draft);
  const carriedHere = draft.carried[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inText = /^(TEXTAREA|INPUT|SELECT)$/.test((document.activeElement as HTMLElement | null)?.tagName ?? '');
      if (isSendKey(e) && open) {
        e.preventDefault();
        if (sendsVerdicts(e)) send();
        return;
      }
      if (e.key === 'Escape') {
        if (inText) (document.activeElement as HTMLElement).blur();
        else props.onClose();
        return;
      }
      if (inText || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key;
      if (key === 'ArrowRight') go(k + 1);
      else if (key === 'ArrowLeft') go(k - 1);
      else if (key === 'ArrowDown') jumpGroup(1);
      else if (key === 'ArrowUp') jumpGroup(-1);
      else if (key === '1' || key === '2' || key === '3') setVerdict(VERDICTS[Number(key) - 1]!);
      else if ((key === 'n' || key === 'N') && open) setNoteFocus((n) => n + 1);
      else if (key === 'o' || key === 'O') toggleOrder();
      else if ((key === 's' || key === 'S') && props.onToggleSidebar) props.onToggleSidebar();
      else if ((key === 'c' || key === 'C') && props.onGoToConversation) props.onGoToConversation();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Narrow screen: on the next shot, its heading comes back up under the pinned image when it had scrolled away,
  // so what to look for is in view without scrolling back (issue #177).
  const area = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Pinned only while it leaves room for the slip under it (#191 review, finding 1); measured again on every resize.
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const a = area.current;
    const t = top.current;
    if (!a || !t) return;
    // Without the padding the pinned rule adds, or pinning could tip it over the line and back, on every resize.
    const measure = () => {
      const s = getComputedStyle(t);
      setPinned(pinsShotTop(t.getBoundingClientRect().height - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom), a.clientHeight));
    };
    const watch = new ResizeObserver(measure);
    watch.observe(a);
    watch.observe(t);
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    const t = top.current;
    const h = heading.current;
    if (!t || !h || getComputedStyle(t).position !== 'sticky') return;
    const below = t.getBoundingClientRect().bottom;
    const gap = h.getBoundingClientRect().top - below;
    if (gap < 0) t.closest('.shots')?.scrollBy({ top: gap - 8 });
  }, [index]);

  // The strip: one group per issue, each with its judged count.
  const groups: { name: string; items: number[] }[] = [];
  order.forEach((i, j) => {
    const g = q.shots[i]!.group;
    if (groups.at(-1)?.name === g) groups.at(-1)!.items.push(j);
    else groups.push({ name: g, items: [j] });
  });

  // Shown in the slip on a wide screen and in the bar under the image on a narrow one; CSS shows one of them.
  const verdicts = (
    <>
      {carriedHere !== undefined && <p className="carried-hint">Carried over from #{carriedHere}, withdrawn: check it still holds for this picture.</p>}
      <div className="vbtns">
        {VERDICTS.map((v, j) => (
          <button key={v} className={`${v}${mine?.verdict === v ? ' on' : ''}`} aria-pressed={mine?.verdict === v} onClick={() => setVerdict(v)}>
            {VERDICT_LABEL[v]}<kbd>{j + 1}</kbd>
          </button>
        ))}
      </div>
    </>
  );

  return (
    <div className={`shots${pinned ? ' pin' : ''}`} ref={area}>
      <div className="shot-main">
        {/* On a narrow screen the image and a verdict bar under it stay at the top while the slip scrolls (issue #177). */}
        <div className="shot-top" ref={top}>
          <div className="stage">
            <ProjectImage key={`${q.id}:${index}`} sessionId={q.sessionId} path={shot.path} alt={`${shot.group} ${shot.path}`} />
            {order.length > 1 && (
              <>
                <button className="nav l" onClick={() => go(k - 1)} aria-label="Previous screenshot">‹</button>
                <button className="nav r" onClick={() => go(k + 1)} aria-label="Next screenshot">›</button>
              </>
            )}
          </div>
          {open && <div className="shot-vbar" role="group" aria-label="Your verdict">{verdicts}</div>}
        </div>
        <nav className="strip" aria-label="Screenshots">
          {groups.map((g) => (
            <div className="sgrp" key={g.name + g.items[0]}>
              <span>{g.name} · {g.items.filter((j) => draft.judged[order[j]!]?.verdict).length}/{g.items.length}</span>
              <div>
                {g.items.map((j) => {
                  const i = order[j]!;
                  const v = draft.judged[i];
                  return (
                    <button key={i} className="thumb" aria-current={j === k} aria-label={`${g.name} ${q.shots[i]!.path}`} onClick={() => go(j)}>
                      <img src={imageUrl(q.sessionId, q.shots[i]!.path)} alt="" />
                      <span className={`vdot${v?.verdict ? ` ${v.verdict}` : ''}${v?.note.trim() ? ' n' : ''}${draft.carried[i] !== undefined ? ' c' : ''}`}
                        title={draft.carried[i] !== undefined ? `Carried over from #${draft.carried[i]}: give it a second look` : undefined} />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>
      <aside className="slip" aria-live="polite">
        <div className="meta">
          <strong>Question #{q.id}</strong>
          <span className="chip">{projectLabel(props.session.project)}</span>
          <span className="muted">{formatTime(q.askedAt)}</span>
          <button className="link slip-session" onClick={props.session.onOpen}>{props.session.title}</button>
        </div>
        <div className="slip-question">
          <strong className="slip-title">{props.title}</strong>
          {props.refersTo}
          <div className="question-text prose"><Markdown text={props.issue || q.question} sessionId={q.sessionId} /></div>
          {props.evidence && (
            <div className="sblk"><span className="lbl">Evidence</span><div className="question-text prose"><Markdown text={props.evidence} sessionId={q.sessionId} /></div></div>
          )}
          {!!props.options?.length && (
            <div className="sblk">
              <span className="lbl">Options</span>
              <ol className="slip-options">
                {props.options.map((o) => {
                  const by = (props.opinions ?? []).filter((op) => op.pick === o.key).map((op) => op.who);
                  return (
                    <li key={o.key}>
                      <strong>{o.label.replace(/\*\*/g, '')}</strong>
                      {o.detail && <div className="prose"><Markdown text={o.detail} sessionId={q.sessionId} /></div>}
                      {o.cost && <div className="muted"><b>Cost</b> · {o.cost}</div>}
                      {by.length > 0 && <div className="picked-by"><b>Picked by</b> {by.join(', ')}</div>}
                    </li>
                  );
                })}
              </ol>
              <span className="muted hint">Your verdicts on the shots are the answer.</span>
            </div>
          )}
        </div>
        <h3 ref={heading}>{shot.group}</h3>
        <div className="meta">
          <span className="chip">{k + 1} / {order.length}</span>
          {shot.facts.map((f) => <span key={f} className="chip">{f}</span>)}
          <span className="chip mono">{shot.path}</span>
        </div>
        <div className="sblk"><span className="lbl">Look for</span><p>{shot.lookFor}</p></div>
        {shot.doneWhen && <div className="sblk"><span className="lbl">Judge against (the done-condition)</span><p>{shot.doneWhen}</p></div>}
        {shot.opinions.length > 0 && (
          <div className="sblk">
            <span className="lbl">What the others thought</span>
            {shot.opinions.map((o, j) => (
              <div key={j} className={`op${o.verdict ? ` ${o.verdict}` : ''}`}>
                <small>{o.who}</small>
                {o.verdict && <strong className={o.verdict}>{OPINION_WORDS[o.verdict]}</strong>}
                <p>{o.text}</p>
              </div>
            ))}
          </div>
        )}
        {open ? (
          <>
            <div className="sblk slip-verdict">
              <span className="lbl">Your verdict</span>
              {verdicts}
            </div>
            <div className="sblk">
              <label className="lbl" htmlFor="shot-note">Note on this shot</label>
              <ShotNote key={`${q.id}:${index}`} value={mine?.note ?? ''} focus={noteFocus} onChange={setShotNote} />
            </div>
            <div className="send-blk">
              <div className={missing ? 'shot-count missing' : 'muted'}>
                {judgedCount} of {q.shots.length} judged{missing > 0 && ` · ${missing} without a verdict`}
              </div>
              {carried.length > 0 && (
                <p className="muted">{Object.keys(draft.carried).length} verdict{Object.keys(draft.carried).length === 1 ? '' : 's'} carried over from {carried.map((n) => `#${n}`).join(', ')}, withdrawn while you judged {carried.length === 1 ? 'it' : 'them'}; ringed on the strip until you judge {Object.keys(draft.carried).length === 1 ? 'it' : 'them'} here.</p>
              )}
              <label className="lbl" htmlFor="shot-answer-note">Note to the asker (optional)</label>
              <textarea {...typing} id="shot-answer-note" className="answer-box" rows={2} placeholder="Anything to go with the verdicts" value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
              <div className="actions">
                <button className={missingShown ? 'deny' : 'allow'} disabled={busy || !judgedCount} onClick={send}>
                  {missingShown ? `Send with ${missing} without a verdict` : 'Send verdicts'}
                </button>
              </div>
              {missingShown && missing > 0 ? (
                <p className="error">
                  {missing === 1 ? '1 shot has' : `${missing} shots have`} no verdict yet; this is the first. Give {missing === 1 ? 'it' : 'them'} one, or press "Send with {missing} without a verdict" to send {missing === 1 ? 'it' : 'them'} as "no verdict".
                </p>
              ) : (
                <span className="muted hint">
                  {judgedCount > 0 && missing > 0 && `Send shows the shots without a verdict first. `}
                  <span className="kbd-hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> sends</span>
                </span>
              )}
              {error && <p className="error">{error}</p>}
              <Withdraw busy={busy} onWithdraw={() => void act(() => api.withdrawQuestion(q.id))} />
            </div>
          </>
        ) : (
          <div className="send-blk">
            {q.status === 'answered' ? (
              <>
                <span className="lbl">Answer{q.answeredBy === 'user' ? ` from ${props.userName}` : ''}</span>
                <pre className="shot-answer">{q.answer}</pre>
                <span className="muted">{q.deliveredAt ? `delivered ${formatTime(q.deliveredAt)}` : 'not delivered yet: it goes in as soon as the session is free'}</span>
              </>
            ) : (
              <>
                <p className="muted">Withdrawn{q.withdrawnReason ? `: ${q.withdrawnReason}` : ''}</p>
                {verdictCount(draft) > 0 && (
                  <p className="error">
                    It was withdrawn while you judged it: your {verdictCount(draft)} verdict{verdictCount(draft) === 1 ? ' was' : 's were'} not sent. In this tab, until it is reloaded, a question of this project with the same shots takes them where it has no verdict yet.
                  </p>
                )}
              </>
            )}
          </div>
        )}
        <div>
          <button className={`small${offFirst ? ' on' : ''}`} aria-pressed={offFirst} onClick={toggleOrder} title="Order (O)">Looks off first</button>
        </div>
        <div className="keys">
          <span><kbd>←</kbd><kbd>→</kbd> shot</span>
          <span><kbd>↑</kbd><kbd>↓</kbd> issue</span>
          {open && <span><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> verdict, then next</span>}
          {open && <span><kbd>N</kbd> note</span>}
          <span><kbd>O</kbd> order</span>
          {props.onGoToConversation && <span><kbd>C</kbd> conversation</span>}
          {props.onToggleSidebar && <span><kbd>S</kbd> sidebar</span>}
          <span><kbd>Esc</kbd> queue</span>
        </div>
      </aside>
    </div>
  );
}

/** The note on one shot; N focuses it (each press bumps `focus`). */
function ShotNote(props: { value: string; focus: number; onChange: (note: string) => void }) {
  const typing = usePlainTyping();
  const [el, setEl] = useState<HTMLTextAreaElement | null>(null);
  // Only a press while this shot shows; moving to the next shot doesn't take the focus along.
  const [shownAt] = useState(props.focus);
  useEffect(() => {
    if (props.focus !== shownAt) el?.focus();
  }, [props.focus]);
  return (
    <textarea {...typing} id="shot-note" ref={setEl} className="answer-box" rows={2} placeholder={coarsePointer() ? 'Write here' : 'N to write, Esc to leave'} value={props.value}
      onChange={(e) => props.onChange(e.target.value)} />
  );
}

/** For lists: "3 screenshots". */
export const shotCount = (q: QuestionInfo): string | null => (q.shots?.length ? `${q.shots.length} screenshot${q.shots.length === 1 ? '' : 's'}` : null);
