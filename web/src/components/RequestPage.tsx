// One request page built from blocks (issue #502, docs/steps/request-blocks.md; Simon approved the design 2026-11-23,
// question #2262). Blocks in a fixed order (D1): Context, Evidence, Decisions, Sign-off. Answered parts fold to one line
// with a Change link, so what is left stays in view; a rail on the right (a bar at the bottom on a phone) says what is
// still open and holds the note and Send. Everything is sent at once (D3: every decision and the sign-off first); the
// draft is kept in Ledung as the person goes (D4). Everything a session wrote is shown as text or through Markdown,
// never as HTML (design section 8).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { projectLabel, type QuestionInfo } from '../../../src/shared/protocol.ts';
import { disagree, type DeskOpinion } from '../../../src/shared/questions.ts';
import { isRequest, requestKinds, requestModel, type RequestDecision } from '../../../src/shared/requests.ts';
import { VERDICT_LABEL, VERDICTS } from '../../../src/shared/shots.ts';
import { findTickets } from '../../../src/shared/tickets.ts';
import { api } from '../api.ts';
import { questionLabel } from '../nameTint.ts';
import { draftParts, emptyRequestDraft, isEmptyDraft, mergeDrafts, nextOpen, openParts, readDraft, requestDrafts, type RequestDraft } from '../requestDraft.ts';
import { emptyDraft as emptyShotDraft, type ShotDraft } from '../shotDrafts.ts';
import { usePlainTyping } from '../usePlainTyping.ts';
import type { Item } from '../waitingLists.ts';
import { RunLine } from './FlowRuns.tsx';
import { Markdown } from './Markdown.tsx';
import { formatTime } from './MessageList.tsx';
import { imageUrl } from './ProjectImage.tsx';
import { RefersTo } from './RefersTo.tsx';
import { ReviewEvidenceList, ReviewSections } from './ReviewView.tsx';
import { ScreenshotView } from './ScreenshotView.tsx';
import { Withdraw } from './Withdraw.tsx';
import type { DeskContext } from './WaitingView.tsx';

/** How long the page waits after the last change before it keeps the draft in Ledung. */
const SAVE_AFTER_MS = 600;

/** Keys pressed while the page is open (as the desk's own pages take them). */
function useKeys(handler: (e: KeyboardEvent, inText: boolean) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      ref.current(e, !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT'));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

const partId = (key: string) => `d:${key}`;

export function RequestPage({ ctx, item, list, onAnswered }: { ctx: DeskContext; item: Item; list: Item[]; onAnswered: (id: number) => void }) {
  const typing = usePlainTyping();
  const { props, nameOf, titleOf, tintOf, settingsOf, header } = ctx;
  const { q, v, project, tier } = item;
  const open = q.status === 'open';
  const m = useMemo(() => requestModel(q), [q.id, q.details, q.shots]);
  const kept = isRequest(q);
  const [draft, setDraftState] = useState<RequestDraft>(() => requestDrafts.get(q.id) ?? emptyRequestDraft());
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(!kept || !open);
  // Why the draft kept in Ledung couldn't be read, and the try it is on: nothing is saved until a read succeeds, so a
  // refused or failed read never overwrites the draft (acceptance round 1 found it overwritten while "Draft saved" showed).
  const [readError, setReadError] = useState('');
  const [readTry, setReadTry] = useState(0);
  const touched = useRef(false);
  const draftNow = useRef(draft);
  draftNow.current = draft;
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});
  const [shotsAt, setShotsAt] = useState<number | null>(null);
  const [evidenceShown, setEvidenceShown] = useState<number | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const idx = list.findIndex((i) => i.q.id === q.id);
  const step = (d: number) => { const t = list[idx + d]; if (idx >= 0 && t) props.onOpenQuestion(t.q.id); };

  const setDraft = (d: RequestDraft) => {
    touched.current = true;
    requestDrafts.set(q.id, d);
    setDraftState(d);
    setErr('');
  };
  // The draft kept in Ledung (D4): read on opening. What the person already did here before it arrived stays on top of it.
  useEffect(() => {
    if (!kept || !open) return;
    let live = true;
    api.requestDraft(q.id).then((r) => {
      if (!live) return;
      const d = readDraft(r.data);
      if (d) {
        const next = touched.current ? mergeDrafts(d, draftNow.current) : d;
        requestDrafts.set(q.id, next);
        setDraftState(next);
        if (!touched.current) setSavedAt(r.at);
      }
      setReadError('');
      setLoaded(true);
    }, (e: unknown) => { if (live) setReadError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [q.id, readTry]);
  // Saved only once the kept draft was read, and never as an empty one, so it can't wipe what another device kept.
  useEffect(() => {
    if (!kept || !open || !loaded || !touched.current || isEmptyDraft(draft)) return;
    const t = setTimeout(() => {
      api.saveRequestDraft(q.id, draft).then(() => setSavedAt(Date.now()), (e: unknown) => setReadError(e instanceof Error ? e.message : String(e)));
    }, SAVE_AFTER_MS);
    return () => clearTimeout(t);
  }, [draft, loaded]);

  const left = openParts(m, draft);
  const order = [...m.decisions.map((x) => partId(x.key)), ...(m.signOff ? ['sign-off'] : [])];
  const judged = Object.values(draft.judged).filter((j) => j?.verdict).length;

  const pick = (key: string, option: string) => {
    setDraft({ ...draft, decisions: { ...draft.decisions, [key]: { pick: option } } });
    setUnfolded({ ...unfolded, [key]: false });
  };
  const setOther = (key: string, other: string) => setDraft({ ...draft, decisions: { ...draft.decisions, [key]: { other } } });
  const setSignOff = (s: RequestDraft['signOff']) => setDraft({ ...draft, signOff: s });

  const send = async () => {
    if (!open || busy) return;
    if (left.length) {
      setErr(`${left.length} to answer first.`);
      jump(nextOpen(order, left, null, 1));
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await api.answerRequest(q.id, draftParts(m, draft));
      requestDrafts.delete(q.id);
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
      requestDrafts.delete(q.id);
      onAnswered(q.id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  /** Scrolls to a part and puts the focus in it: its first button, or its box. */
  const jump = (id: string | null) => {
    if (!id) return;
    if (id.startsWith('d:')) setUnfolded((u) => ({ ...u, [id.slice(2)]: true }));
    setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-part="${CSS.escape(id)}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el?.querySelector<HTMLElement>('button.opt, button.allow, textarea')?.focus({ preventScroll: true });
    });
  };
  const currentPart = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-part]')?.dataset.part ?? null;

  useKeys((e, inText) => {
    // The large views take the keys while they are open (they close with Esc).
    if (shotsAt !== null) return;
    if (evidenceShown !== null) {
      if (e.key === 'Escape') { e.preventDefault(); setEvidenceShown(null); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void send(); return; }
    if (e.key === 'Escape') {
      if (inText) (document.activeElement as HTMLElement).blur(); else props.onOpenQuestion(null);
      return;
    }
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      jump(nextOpen(order, left.length ? left : order, currentPart(), e.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (inText || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const part = currentPart();
    // Inside a decision, its option keys pick; inside the sign-off, A and C (design section 5).
    if (open && part?.startsWith('d:') && /^[1-9]$/.test(e.key)) {
      const x = m.decisions.find((d) => partId(d.key) === part);
      const n = Number(e.key);
      if (x && n <= x.options.length) { e.preventDefault(); pick(x.key, x.options[n - 1]!.key); jump(nextOpen(order, left.filter((p) => p !== part), part, 1)); }
      else if (x && n === x.options.length + 1) { e.preventDefault(); setOther(x.key, draft.decisions[x.key]?.other ?? ''); setTimeout(() => document.querySelector<HTMLElement>(`[data-part="${CSS.escape(part)}"] textarea`)?.focus()); }
      return;
    }
    if (open && part === 'sign-off' && (k === 'a' || k === 'c')) {
      e.preventDefault();
      setSignOff({ ...draft.signOff, verdict: k === 'a' ? 'accept' : 'changes' });
      if (k === 'c') setTimeout(() => document.querySelector<HTMLElement>('[data-part="sign-off"] textarea')?.focus());
      return;
    }
    const nothingFocused = !document.activeElement || document.activeElement === document.body;
    if (k === 's') props.onToggleSidebar();
    else if (k === 'c') props.onGoToConversation(q.id);
    else if (k === 'n' && open) { e.preventDefault(); setNoteOpen(true); setTimeout(() => noteRef.current?.focus()); }
    // ← / → move between requests only when nothing on the page has focus (design section 5).
    else if (nothingFocused && e.key === 'ArrowRight') step(1);
    else if (nothingFocused && e.key === 'ArrowLeft') step(-1);
  });

  const asker = nameOf(q.sessionId);
  const tickets = settingsOf(project)?.tickets ?? undefined;
  const refLink = (r: string) => findTickets([r], tickets)[0]?.url;
  const md = (text: string) => <Markdown text={text} sessionId={q.sessionId} />;
  const posText = open
    ? q.addressedTo === 'user' ? `${idx + 1} of ${list.length} waiting` : `Manager "${titleOf(q.addressedTo)}" is handling it`
    : q.status === 'answered' ? 'Answered' : 'Withdrawn';
  const answeredBy = q.answeredBy === 'user'
    ? q.forwardedFrom !== null ? `${props.userName} (passed on by the manager)` : props.userName
    : `Manager "${titleOf(q.answeredBy ?? '')}", under its standing grant`;
  const sent = q.answerParts ?? null;
  const shots = q.shots ?? [];
  const review = q.details?.review ?? null;
  const evidenceFiles = review?.evidence ?? [];
  const kinds = requestKinds(q);
  const signOffOpinions = (q.details?.review || q.details?.signOff ? q.details?.opinions ?? [] : []);

  // The shots' large view works on a screenshot draft; its verdicts are the request's (judged by the shot's place).
  const shotDraft: ShotDraft = { ...emptyShotDraft(shots, project), judged: draft.judged };
  const verdictCount = (src: Record<number, { verdict: string | null } | undefined>) => VERDICTS
    .map((x) => [VERDICT_LABEL[x], shots.filter((_, i) => src[i]?.verdict === x).length] as const).filter(([, n]) => n > 0).map(([l, n]) => `${n} ${l}`).join(' · ');
  const sentJudged = Object.fromEntries((sent?.shots ?? []).map((s, i) => [i, s]));

  const contextBlock = (
    <section className="req-block req-context">
      <div className={`qhead name-tinted${tintOf(q.sessionId) ? ' tinted' : ''}`} style={tintOf(q.sessionId)}>
        <span className="border-label">{questionLabel(tier, project)}</span>
        <div className="meta">
          <strong>{m.preset === 'review' ? 'Review' : m.preset === 'request' ? 'Request' : 'Question'} #{q.id}</strong>
          <span className="chip">{projectLabel(project)}</span>
          <span className="muted">· <button className="link" onClick={() => props.onOpenSession(q.sessionId)}>{asker}</button> · asked {formatTime(q.askedAt)}</span>
          {q.addressedTo !== 'user' && <span className="muted">· to manager "{titleOf(q.addressedTo)}"</span>}
        </div>
        <h3>{v.title}</h3>
        <div className="refs">
          {review && <span className="chip review-chip">Review</span>}
          {open && m.parts > 1 && left.length > 0 && <span className="chip to-answer-chip">{left.length} to answer</span>}
          {shots.length > 0 && <span className="chip shot-chip">{open ? `${judged} of ${shots.length} judged` : `${shots.length} screenshot${shots.length === 1 ? '' : 's'}`}</span>}
          {v.refs.map((r) => { const url = refLink(r); return url ? <a key={r} className="chip" href={url} target="_blank" rel="noreferrer noopener">{r}</a> : <span key={r} className="chip">{r}</span>; })}
        </div>
        {q.details?.run && <RunLine run={q.details.run} project={project} />}
      </div>
      {open && q.addressedTo !== 'user' && (
        <div className="handled">Manager "{titleOf(q.addressedTo)}" is handling this. Answer it here yourself and the manager is told.</div>
      )}
      <RefersTo q={q} userName={props.userName} nameOf={nameOf} tintOf={tintOf} onOpenConversation={(s, id) => props.onGoToConversation(id, s)} onOpenMessage={props.onGoToMessage} onOpenQuestion={(id) => props.questions.some((x) => x.id === id) ? () => props.onOpenQuestion(id) : null} />
      {review ? <ReviewSections review={review} sessionId={q.sessionId} /> : v.issue && <section className="block"><h4>The issue</h4><div className="issue prose">{md(v.issue)}</div></section>}
      {/* A screenshot question's options are shown, not answered: its verdicts are the answer, as on its own page. */}
      {m.preset === 'shots' && v.options.length > 0 && (
        <section className="block">
          <h4>Options <span className="opt-in">(shown; the verdicts are the answer)</span></h4>
          <ol className="slip-options">{v.options.map((o) => <li key={o.key}><strong>{o.label.replace(/\*\*/g, '')}</strong>{o.detail && <div className="prose">{md(o.detail)}</div>}</li>)}</ol>
        </section>
      )}
    </section>
  );

  const evidenceBlock = (v.evidence || evidenceFiles.length > 0 || shots.length > 0) && (
    <section className="req-block">
      <h4 className="req-head">Evidence</h4>
      {v.evidence && <details className="ev"><summary>What was checked</summary><div className="prose">{md(v.evidence)}</div></details>}
      {evidenceFiles.length > 0 && <ReviewEvidenceList q={q} evidence={evidenceFiles} shown={evidenceShown} onShow={setEvidenceShown} heading={false} />}
      {shots.length > 0 && (
        <div className="req-shots-row">
          <div className="req-shot-thumbs">
            {shots.map((s, i) => {
              const j = open ? draft.judged[i] : sentJudged[i];
              return (
                <button key={i} className="thumb" aria-label={`Open large to judge: ${s.group} ${s.path}`} onClick={() => setShotsAt(i)}>
                  <img src={imageUrl(q.sessionId, s.path)} alt="" />
                  <span className={`vdot${j?.verdict ? ` ${j.verdict}` : ''}${j?.note?.trim() ? ' n' : ''}`} />
                </button>
              );
            })}
          </div>
          <span className="muted">{verdictCount(open ? draft.judged : sentJudged) || (open ? 'Not judged yet: open one to judge' : 'No verdicts sent')}</span>
          <button className="small" onClick={() => setShotsAt(0)}>{open ? 'Judge the screenshots' : 'Show the screenshots'}</button>
        </div>
      )}
    </section>
  );

  const decisionBlock = (x: RequestDecision, n: number) => {
    const a = open ? draft.decisions[x.key] : sent?.decisions?.find((d) => d.key === x.key);
    const picked = a?.pick !== undefined ? x.options.find((o) => o.key === a.pick) : undefined;
    const folded = (!open && (picked || a?.other)) || (open && picked && !unfolded[x.key]);
    const label = picked ? `${picked.key} — ${picked.label.replace(/\*\*/g, '')}` : a?.other ? `Other: ${a.other}` : '';
    const heading = m.preset === 'question' ? 'Options' : `Decision ${n + 1} · ${x.title}`;
    if (folded) {
      return (
        <section key={x.key} className="req-block req-folded" data-part={partId(x.key)}>
          <span className="req-check" aria-hidden="true">✓</span>
          <span className="req-folded-text"><b>{heading}</b> — {label}</span>
          {open && <button className="link" onClick={() => jump(partId(x.key))} aria-label={`Change decision ${n + 1}`}>Change</button>}
        </section>
      );
    }
    const whoOf = (o: DeskOpinion) => o.who ?? asker;
    const otherKey = x.options.length + 1;
    const otherOn = open && a?.pick === undefined && a?.other !== undefined;
    return (
      <section key={x.key} className="req-block" data-part={partId(x.key)}>
        <h4 className="req-head">{heading}{disagree(x.opinions) && <span className="split">They disagree</span>}</h4>
        {m.preset !== 'question' && x.issue && <div className="issue prose">{md(x.issue)}</div>}
        <div className="opts" role="radiogroup" aria-label={x.title}>
          {x.options.map((o, i) => {
            const on = picked?.key === o.key;
            const by = x.opinions.filter((op) => op.pick === o.key).map(whoOf);
            return (
              <button key={o.key} className={`opt${on ? ' on' : ''}`} role="radio" aria-checked={on} disabled={!open} onClick={() => pick(x.key, o.key)}>
                <span className="k">{i + 1}</span>
                <span className="lab"><span className="letter">{o.key}</span>{o.label.replace(/\*\*/g, '')}</span>
                {o.detail && <span className="det prose">{md(o.detail)}</span>}
                {o.cost && <span className="cost muted"><b>Cost</b> · {o.cost}</span>}
                {by.length > 0 && <span className="picked-by"><b>Picked by</b> {by.join(', ')}</span>}
              </button>
            );
          })}
          {open && (
            <button className={`opt${otherOn ? ' on' : ''}`} role="radio" aria-checked={otherOn} onClick={() => setOther(x.key, a?.other ?? '')}>
              <span className="k">{otherKey}</span>
              <span className="lab">Other answer</span>
              <span className="det">Say it in your own words, or "not sure yet".</span>
            </button>
          )}
        </div>
        {otherOn && <textarea {...typing} className="box" aria-label={`Your answer to ${x.title}`} placeholder="Your answer, in your own words" value={a?.other ?? ''} onChange={(e) => setOther(x.key, e.target.value)} />}
        {x.opinions.some((o) => o.why) && (
          <div className="req-opinions">
            {x.opinions.map((o, j) => (
              <div key={j} className="req-opinion"><b>{whoOf(o)}</b>{o.pick ? <> · {o.pick}</> : null}{o.why ? <div className="prose">{md(o.why)}</div> : null}</div>
            ))}
          </div>
        )}
      </section>
    );
  };

  const signOffBlock = m.signOff && (() => {
    const s = open ? draft.signOff : sent?.signOff ? { verdict: sent.signOff.verdict, note: sent.signOff.note ?? '' } : null;
    return (
      <section className="req-block" data-part="sign-off">
        <h4 className="req-head">Sign-off</h4>
        {signOffOpinions.length > 0 && (
          <div className="req-opinions">{signOffOpinions.map((o, j) => <div key={j} className="req-opinion"><b>{o.who}</b>{o.why ? <div className="prose">{md(o.why)}</div> : null}</div>)}</div>
        )}
        {open ? (
          <>
            <div className="send">
              {/* A choice here, not a send: only the chosen one is coloured (Send is in the rail). */}
              <button className={s?.verdict === 'accept' ? 'allow on' : 'sign-choice'} aria-pressed={s?.verdict === 'accept'} onClick={() => setSignOff({ ...draft.signOff, verdict: 'accept' })}>Accepted</button>
              <button className={s?.verdict === 'changes' ? 'deny on' : 'sign-choice'} aria-pressed={s?.verdict === 'changes'} onClick={() => setSignOff({ ...draft.signOff, verdict: 'changes' })}>Changes needed</button>
            </div>
            <label className="muted rev-box-label" htmlFor={`req-sign-${q.id}`}>{s?.verdict === 'changes' ? 'What needs changing (required)' : 'A note with the sign-off (optional)'}</label>
            <textarea {...typing} id={`req-sign-${q.id}`} className="box" value={draft.signOff.note} onChange={(e) => setSignOff({ ...draft.signOff, note: e.target.value })} />
          </>
        ) : s ? (
          <div className={`rev-verdict ${s.verdict === 'accept' ? 'accepted' : 'changes'}`}>
            <strong>{s.verdict === 'accept' ? 'Accepted' : 'Changes needed'}</strong>
            {s.note && <div className="rev-verdict-text">{s.note}</div>}
          </div>
        ) : null}
      </section>
    );
  })();

  const doneBlock = !open && (
    <section className="req-block">
      <h4 className="req-head">{q.status === 'answered' ? 'Answer' : 'Withdrawn'}</h4>
      {q.status === 'answered' ? (
        <div className="answered-box">
          <div><strong>{answeredBy}</strong> · {formatTime(q.answeredAt ?? q.askedAt)} · {q.deliveredAt ? `delivered ${formatTime(q.deliveredAt)}` : 'not delivered yet: it goes in as soon as the session is free'}</div>
          {sent?.note && <div className="prose">Note: {sent.note}</div>}
          {/* Without parts (answered in words, or before #502) the text is all there is. */}
          {!sent && <pre className="shot-answer">{q.answer}</pre>}
        </div>
      ) : <div className="answered-box withdrawn"><div className="muted">Withdrawn{q.withdrawnReason ? `: ${q.withdrawnReason}` : ''}</div></div>}
    </section>
  );

  const sendButton = (cls = '') => (
    <button className={`primary${cls}`} disabled={busy} aria-disabled={left.length > 0} onClick={() => void send()}>Send</button>
  );
  const noteBox = (
    <textarea {...typing} className="box" aria-label="Note to the asker" placeholder="Anything to go with the answer" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
  );
  const draftStatus: ReactNode = kept && open && readError ? (
    <div className="error req-saved" role="alert">
      {loaded ? "The draft couldn't be saved" : "The draft kept in Ledung couldn't be read, so nothing here is saved yet"}: {readError}{' '}
      {!loaded && <button type="button" className="link" onClick={() => { setReadError(''); setReadTry(readTry + 1); }}>Try again</button>}
    </div>
  ) : kept && <div className="muted req-saved">{savedAt ? `Draft saved ${formatTime(savedAt)}` : loaded ? 'Draft kept as you go' : 'Reading the draft…'}</div>;
  const rail: ReactNode = open && (
    <aside className="req-rail" aria-label="Your answer">
      <h4 className="req-head">Your answer</h4>
      <ul className="req-parts">
        {shots.length > 0 && <li className={judged === shots.length ? 'done' : ''}><span aria-hidden="true">{judged === shots.length ? '✓' : '○'}</span> Screenshots {judged} of {shots.length}</li>}
        {m.decisions.map((x, n) => {
          const done = !left.includes(partId(x.key));
          const a = draft.decisions[x.key];
          return (
            <li key={x.key} className={done ? 'done' : ''}>
              <button className="link" onClick={() => jump(partId(x.key))}><span aria-hidden="true">{done ? '✓' : '○'}</span> {m.preset === 'question' ? 'Your pick' : x.title}{done && a?.pick ? `: ${a.pick}` : done ? ': other' : ''}</button>
            </li>
          );
        })}
        {m.signOff && (
          <li className={left.includes('sign-off') ? '' : 'done'}>
            <button className="link" onClick={() => jump('sign-off')}><span aria-hidden="true">{left.includes('sign-off') ? '○' : '✓'}</span> Sign-off{draft.signOff.verdict && !left.includes('sign-off') ? `: ${draft.signOff.verdict === 'accept' ? 'Accepted' : 'Changes needed'}` : ''}</button>
          </li>
        )}
      </ul>
      <label className="lbl" htmlFor={`req-note-${q.id}`}>Note to the asker</label>
      <textarea {...typing} id={`req-note-${q.id}`} ref={noteRef} className="box" placeholder="Optional" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
      {draftStatus}
      <div className="send">
        {sendButton()}
        {left.length > 0 && <span className="muted">needs {left.length} more</span>}
      </div>
      <span className="muted send-hint"><kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd> sends</span>
      {err && <p className="status error" role="status">{err}</p>}
      <Withdraw busy={busy} onWithdraw={() => void withdraw()} />
    </aside>
  );

  return (
    <div className="waiting-view desk-view request-view">
      {header(posText, (
        <div className="qbar">
          <button onClick={() => props.onOpenQuestion(null)}>← Queue</button>
          <button disabled={idx <= 0} aria-label="Previous" title="Previous (←)" onClick={() => step(-1)}>←</button>
          <button disabled={idx < 0 || idx >= list.length - 1} aria-label="Next" title="Next (→)" onClick={() => step(1)}>→</button>
        </div>
      ), q)}
      <div className={`desk${shotsAt !== null || evidenceShown !== null ? ' locked' : ''}`}>
        <div className="req">
          <div className="req-blocks">
            {contextBlock}
            {evidenceBlock}
            {q.details?.flowProposal === undefined && m.decisions.map(decisionBlock)}
            {signOffBlock}
            {doneBlock}
            {/* On a phone the note opens from the bar; on a wide screen it is in the rail. */}
            {open && noteOpen && <section className="req-block req-phone-note"><label className="lbl">Note to the asker</label>{noteBox}</section>}
            {/* The rail's draft line and Withdraw, which a phone hides with the rail (acceptance round 1: Withdraw out of reach at 390 px). */}
            {open && <div className="req-phone-only">{draftStatus}<Withdraw busy={busy} onWithdraw={() => void withdraw()} /></div>}
            <div className="keys">
              {open && <span><kbd>Alt</kbd>+<kbd>↓</kbd><kbd>↑</kbd> next / previous open part</span>}
              {open && <span>In a decision <kbd>1</kbd>–<kbd>9</kbd> pick</span>}
              {open && m.signOff && <span>In the sign-off <kbd>A</kbd> accepted, <kbd>C</kbd> changes</span>}
              {open && <span><kbd>N</kbd> note</span>}
              <span><kbd>←</kbd><kbd>→</kbd> previous / next</span><span><kbd>C</kbd> conversation</span><span><kbd>Esc</kbd> queue</span><span><kbd>S</kbd> sidebar</span>
            </div>
          </div>
          {rail}
        </div>
      </div>
      {open && (
        <div className="req-bar" role="group" aria-label="Your answer">
          <span className={`send-pick${left.length ? '' : ' muted'}`}>{left.length ? `${left.length} to answer` : 'All answered'}{kinds.length ? <span className="muted"> · {kinds.join(', ')}</span> : null}</span>
          <button className={`small${noteOpen ? ' on' : ''}`} aria-pressed={noteOpen} onClick={() => setNoteOpen(!noteOpen)}>Note</button>
          {sendButton()}
          {err && <span className="status" role="status">{err}</span>}
        </div>
      )}
      {shotsAt !== null && shots.length > 0 && (
        <div className="req-large" role="dialog" aria-modal="true" aria-label="Screenshots">
          <ScreenshotView
            key={shotsAt}
            startAt={shotsAt}
            question={{ ...q, shots }}
            title={v.title}
            issue={review ? review.solving : v.issue}
            userName={props.userName}
            session={{ title: asker, project, onOpen: () => props.onOpenSession(q.sessionId) }}
            onClose={() => setShotsAt(null)}
            withdrawnIds={[]}
            control={open ? { draft: shotDraft, onDraft: (d) => setDraft({ ...draft, judged: d.judged }) } : undefined}
          />
        </div>
      )}
    </div>
  );
}

/** For the list: "3 to answer" from this tab's draft of it, or every part when there is none (issue #502). */
export function toAnswerChip(q: QuestionInfo): string | null {
  if (q.status !== 'open' || !isRequest(q)) return null;
  const m = requestModel(q);
  if (m.parts < 2) return null;
  const n = openParts(m, requestDrafts.get(q.id) ?? emptyRequestDraft()).length;
  return n ? `${n} to answer` : null;
}
