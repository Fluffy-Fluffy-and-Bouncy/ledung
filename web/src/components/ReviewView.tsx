// A review (docs/steps/pr-review.md, issue #145): a person's functional sign-off on a finished change, on a
// page of its own in Waiting for you. Its fixed sections, its evidence (screenshots as thumbnails that open
// large, text files folded to their first lines), and one overall answer: Accept, or Changes needed.
import { useEffect, useRef, useState } from 'react';
import type { QuestionInfo } from '../../../src/shared/protocol.ts';
import { ACCEPTED, CHANGES_NEEDED, reviewAnswer, type ReviewDetails, type ReviewEvidence } from '../../../src/shared/questions.ts';
import { api } from '../api.ts';
import { Markdown } from './Markdown.tsx';
import { formatTime } from './MessageList.tsx';
import { imageUrl, ProjectImage } from './ProjectImage.tsx';
import { usePlainTyping } from '../usePlainTyping.ts';
import { coarsePointer } from '../coarsePointer.ts';
import { Withdraw } from './Withdraw.tsx';

/** A folded text file shows this many lines. */
const FOLDED_LINES = 8;

/** The review's sections: what we were solving, what was done, and the notes when there are any. */
export function ReviewSections({ review, sessionId }: { review: ReviewDetails; sessionId: string }) {
  const md = (text: string) => <div className="issue prose"><Markdown text={text} sessionId={sessionId} /></div>;
  return (
    <>
      <section className="block"><h4>What we were solving</h4>{md(review.solving)}</section>
      <section className="block"><h4>What was done</h4>{md(review.done)}</section>
      {review.notes && <section className="block"><h4>Notes</h4>{md(review.notes)}</section>}
    </>
  );
}

/**
 * The evidence: screenshots as thumbnails in a row (wrapping on a phone) that open large, text files as
 * folded blocks. `shown` is the screenshot open large, by its place among the images; the page owns it so
 * its keys can go to the large view first.
 */
export function ReviewEvidenceList(props: { q: QuestionInfo; evidence: ReviewEvidence[]; shown: number | null; onShow: (i: number | null) => void }) {
  const { q, evidence } = props;
  const images = evidence.filter((e) => e.kind !== 'text');
  return (
    <section className="block">
      <h4>Evidence</h4>
      {images.length > 0 && (
        <div className="rev-thumbs">
          {images.map((e, i) => (
            <figure key={i}>
              <Thumb q={q} ev={e} onOpen={() => props.onShow(i)} />
              <figcaption>{e.caption}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {evidence.map((e, n) => (e.kind === 'text' ? <TextEvidence key={n} q={q} n={n} ev={e} /> : null))}
      {props.shown !== null && images[props.shown] && (
        <ImageLarge q={q} images={images} at={props.shown} onShow={props.onShow} />
      )}
    </section>
  );
}

/** A screenshot's thumbnail; one that can't be shown says so, and opening it large gives the reason. */
function Thumb({ q, ev, onOpen }: { q: QuestionInfo; ev: ReviewEvidence; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <button className="rev-thumb" aria-label={`Open large: ${ev.caption}`} onClick={onOpen}>
      {broken ? <span className="rev-thumb-problem">Can't be shown</span> : <img src={imageUrl(q.sessionId, ev.file)} alt="" onError={() => setBroken(true)} />}
    </button>
  );
}

/** A screenshot large, over the page, with arrows to the others; closing it is back on the review. */
function ImageLarge(props: { q: QuestionInfo; images: ReviewEvidence[]; at: number; onShow: (i: number | null) => void }) {
  const { images, at } = props;
  const e = images[at]!;
  const go = (d: number) => props.onShow((at + d + images.length) % images.length);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  return (
    <div className="rev-large" role="dialog" aria-modal="true" aria-label={e.caption} onClick={(ev) => { if (ev.target === ev.currentTarget) props.onShow(null); }}>
      <div className="rev-large-bar">
        <span className="rev-large-caption">{e.caption} <span className="muted">· {at + 1} / {images.length}</span></span>
        <button ref={close} className="icon" aria-label="Close: back to the review" title="Close (Esc)" onClick={() => props.onShow(null)}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
        </button>
      </div>
      <div className="rev-large-stage">
        <ProjectImage key={e.file} sessionId={props.q.sessionId} path={e.file} alt={e.caption} />
        {images.length > 1 && (
          <>
            <button className="nav l" onClick={() => go(-1)} aria-label="Previous screenshot">‹</button>
            <button className="nav r" onClick={() => go(1)} aria-label="Next screenshot">›</button>
          </>
        )}
      </div>
    </div>
  );
}

/** A text file: its first lines in a fixed-width font, unfolding to the whole file in a scrolling box. */
function TextEvidence({ q, n, ev }: { q: QuestionInfo; n: number; ev: ReviewEvidence }) {
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    api.evidenceText(q.id, n).then((f) => live && setText(f.content), (e: Error) => live && setProblem(e.message));
    return () => { live = false; };
  }, [q.id, n]);
  const lines = text === null ? [] : text.replace(/\n$/, '').split('\n');
  const more = lines.length > FOLDED_LINES;
  return (
    <div className="rev-text">
      <div className="rev-text-head">
        <span className="rev-text-caption">{ev.caption}</span>
        <span className="chip mono">{ev.file.replace(/^board:[^/]+\/[^/]+\//, 'board: ')}</span>
        {text !== null && <span className="muted">{lines.length} line{lines.length === 1 ? '' : 's'}</span>}
      </div>
      {problem ? <p className="error">{problem}</p> : text === null ? <p className="muted">Loading…</p> : (
        <>
          <pre className={`rev-text-body${open ? ' open' : ''}`} tabIndex={open ? 0 : undefined}>{open ? text : lines.slice(0, FOLDED_LINES).join('\n')}</pre>
          {more && (
            <button className="small rev-text-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? 'Fold' : `Show all ${lines.length} lines`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The answer: Accept, or Changes needed with what to change; one box serves both. Answered, it shows which,
 * with the note or text.
 */
export function ReviewAnswer(props: {
  q: QuestionInfo;
  /** Who answered, as the desk names them. */
  answeredBy: string;
  noteFocus: number;
  onAnswered: () => void;
}) {
  const typing = usePlainTyping();
  const { q } = props;
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const [focusAt] = useState(props.noteFocus);
  useEffect(() => { if (props.noteFocus !== focusAt) box.current?.focus(); }, [props.noteFocus]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setErr('');
    try {
      await action();
      props.onAnswered();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const send = (verdict: 'accept' | 'changes') => {
    if (busy) return;
    const r = reviewAnswer(verdict, text);
    if ('problem' in r) { setErr(r.problem); box.current?.focus(); return; }
    void act(() => api.answerQuestion(q.id, r.answer));
  };

  if (q.status === 'answered') {
    const answer = q.answer ?? '';
    const accepted = answer.startsWith(ACCEPTED);
    const rest = accepted ? answer.slice(ACCEPTED.length).trim() : answer.startsWith(CHANGES_NEEDED) ? answer.slice(CHANGES_NEEDED.length).trim() : answer;
    return (
      <section className="block">
        <h4>Answer</h4>
        <div className={`rev-verdict ${accepted ? 'accepted' : 'changes'}`}>
          <strong>{accepted ? 'Accepted' : 'Changes needed'}</strong>
          {rest && <div className="rev-verdict-text">{rest}</div>}
          <div className="muted">
            {props.answeredBy} · {formatTime(q.answeredAt ?? q.askedAt)} · {q.deliveredAt ? `delivered ${formatTime(q.deliveredAt)}` : 'not delivered yet: it goes in as soon as the session is free'}
          </div>
        </div>
      </section>
    );
  }
  if (q.status === 'withdrawn') {
    return <section className="block"><h4>Withdrawn</h4><div className="answered-box withdrawn"><div className="muted">Withdrawn{q.withdrawnReason ? `: ${q.withdrawnReason}` : ''}</div></div></section>;
  }
  return (
    <section className="block">
      <h4>Your answer</h4>
      <label className="muted rev-box-label" htmlFor={`rev-${q.id}`}>A note with Accept (optional), or what needs changing (required for Changes needed)</label>
      <textarea {...typing} id={`rev-${q.id}`} ref={box} className="box" placeholder={coarsePointer() ? 'Write here' : 'N to write, Esc to leave'} value={text} onChange={(e) => { setText(e.target.value); setErr(''); }} />
      <div className="send">
        <button className="allow" disabled={busy} onClick={() => send('accept')}>Accept</button>
        <button className="deny" disabled={busy} onClick={() => send('changes')}>Changes needed</button>
        <span className="status" role="status">{err}</span>
      </div>
      <Withdraw busy={busy} onWithdraw={() => void act(() => api.withdrawQuestion(q.id))} />
    </section>
  );
}
