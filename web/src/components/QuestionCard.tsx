// A question a session asked with ask_user: answerable while open, with its answer once answered.
// Shown in the chat and in the "Waiting for you" list; both stay in sync through the live connection.
import { useState } from 'react';
import { projectLabel, type QuestionInfo } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { Markdown } from './Markdown.tsx';
import { formatTime } from './MessageList.tsx';
import { imageUrl } from './ProjectImage.tsx';
import { shotCount } from './ScreenshotView.tsx';
import { usePlainTyping } from '../usePlainTyping.ts';
import { Withdraw } from './Withdraw.tsx';

export function QuestionCard(props: {
  question: QuestionInfo;
  userName: string;
  /** Shown in the list: which session asked, with a way to open it. */
  session?: { title: string; project: string; onOpen: () => void };
  /** A session's title by id, for managers. */
  titleOf?: (id: string) => string;
  onOpenFile?: (path: string) => void;
  /** In a manager's conversation: the session that asked it (issue #61). */
  from?: string;
  /** The question Go to conversation came for: highlighted briefly. */
  focus?: boolean;
  /** Opens it in Waiting for you. */
  onOpenInDesk?: () => void;
}) {
  const typing = usePlainTyping();
  const q = props.question;
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // A question with screenshots is judged in Waiting for you's screenshot view (issue #60), a review on a page
  // of its own there (docs/steps/pr-review.md): the card shows its title and a way to open it.
  const review = q.details?.review ? q.details : null;
  const shots = review ? null : shotCount(q);
  const judgeText = review ? (q.status === 'open' ? 'Open the review' : 'Show the review') : q.status === 'open' ? 'Judge in the screenshot view' : 'Show the screenshots';
  // A button when the page can open it as a step into Waiting for you, so its Close comes back here (issue #61).
  const judge = (shots || review) && (props.onOpenInDesk
    ? <button className="small" onClick={props.onOpenInDesk}>{judgeText}</button>
    : <a className="button-link" href={`#/waiting/q/${q.id}`}>{judgeText}</a>);
  const thumbs = q.shots?.length ? (
    <div className="chat-thumbs">
      {q.shots.map((s, i) => <img key={i} src={imageUrl(q.sessionId, s.path)} alt={s.path} title={`${s.group} · ${s.path}`} />)}
    </div>
  ) : null;

  const head = (
    <div className="card-head">
      <strong>Question #{q.id}</strong>
      {props.from && <> · from <strong>{props.from}</strong></>}
      {props.session && (
        <>
          {' · '}
          <button className="link" onClick={props.session.onOpen}>{props.session.title}</button>
          <span className="muted"> ({projectLabel(props.session.project)})</span>
        </>
      )}
      <span className="muted"> · {formatTime(q.askedAt)}</span>
      {q.addressedTo !== 'user' && <span className="muted"> · to manager "{props.titleOf?.(q.addressedTo) ?? 'manager'}"</span>}
      {q.aboutQuestion !== null && <span className="muted"> · about #{q.aboutQuestion}</span>}
      {shots && <> <span className="chip shot-chip">{shots}</span></>}
      {review && <> <span className="chip review-chip">Review</span></>}
    </div>
  );
  const text = review
    ? <div className="question-text"><strong>{review.title}</strong></div>
    : <div className="question-text"><Markdown text={q.question} onOpenFile={props.onOpenFile} /></div>;
  const answeredBy =
    q.answeredBy === 'user'
      ? q.forwardedFrom !== null ? `${props.userName} (passed on by the manager)` : props.userName
      : `Manager "${props.titleOf?.(q.answeredBy ?? '') ?? 'manager'}", under its standing grant`;

  if (q.status !== 'open') {
    return (
      <div id={`qc-${q.id}`} className={`card question-done ${q.status}${props.focus ? ' focus' : ''}`}>
        {head}
        {text}
        {thumbs}
        {q.status === 'answered' ? (
          <p>
            <strong>{answeredBy}:</strong> {shots || review ? <span className="shot-answer">{'\n'}{q.answer}</span> : q.answer}
            <span className="muted">
              {' · '}
              {q.deliveredAt ? `delivered ${formatTime(q.deliveredAt)}` : 'not delivered yet: it goes in as soon as the session is free'}
            </span>
          </p>
        ) : (
          <p className="muted">Withdrawn{q.withdrawnReason ? `: ${q.withdrawnReason}` : ''}</p>
        )}
        {judge && <div className="actions">{judge}</div>}
      </div>
    );
  }

  return (
    <div id={`qc-${q.id}`} className={`card question-open${props.focus ? ' focus' : ''}`}>
      {head}
      {text}
      {thumbs}
      {q.aboutRequest && (
        <p className="sensitive-note">
          <strong>Permission request</strong>: your answer decides it. "Allow once" allows it once; any other answer denies it, with your words as the reason.
        </p>
      )}
      {q.options && !judge && (
        <div className="question-options">
          {q.options.map((o) => (
            <button key={o} type="button" className={`option${answer === o ? ' on' : ''}`} onClick={() => setAnswer(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      {/* With screenshots the verdicts are the answer, given in the screenshot view, not typed here. */}
      {!judge && (
        <textarea {...typing}
          className="answer-box"
          placeholder={q.aboutRequest ? 'Choose above, or type why you deny it' : q.options ? 'Choose above or type your answer' : 'Type your answer'}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={2}
        />
      )}
      <div className="actions">
        {judge || (
          <button className="allow" disabled={busy || !answer.trim()} onClick={() => act(() => api.answerQuestion(q.id, answer))}>
            Answer
          </button>
        )}
        {props.onOpenInDesk && !judge && <button className="small" title="Open it in Waiting for you" onClick={props.onOpenInDesk}>Open in Waiting for you</button>}
      </div>
      {error && <p className="error">{error}</p>}
      <Withdraw busy={busy} onWithdraw={() => void act(() => api.withdrawQuestion(q.id))} />
    </div>
  );
}
