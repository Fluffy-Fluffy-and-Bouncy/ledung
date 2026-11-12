// "What it refers to" on a question's page (issue #368): what a question can point at, each in a folded box, so
// "its full question is above" or "the 12 points above" always leads to something on the page (Martin, 2026-10-28,
// Ledung questions 313 and 320; mockups passed on question 332). The original question a manager's question is
// about, the sources the asker attached (issue #369), and, when it attached none, its conversation just before it
// asked. Each item is one entry in `items` below.
import type { CSSProperties, ReactNode } from 'react';
import type { AttachedSource, ConversationLine, FailedSource, OriginalQuestion, QuestionInfo } from '../../../src/shared/protocol.ts';
import { deskQuestion } from '../../../src/shared/questions.ts';
import { Markdown } from './Markdown.tsx';
import { formatTime } from './MessageList.tsx';

export function RefersTo(props: {
  q: QuestionInfo;
  userName: string;
  /** "Manager "Lead"" or a session's title. */
  nameOf: (sessionId: string) => string;
  tintOf: (sessionId: string) => CSSProperties | undefined;
  /** Opens a session's conversation at one of its questions. */
  onOpenConversation: (sessionId: string, questionId: number) => void;
  /** Opens a session's conversation at one of its messages (an attached reply); none: no link. */
  onOpenMessage?: (sessionId: string, messageId: number) => void;
  /** How to open an attached question here, or null when the page hasn't loaded it. */
  onOpenQuestion?: (id: number) => (() => void) | null;
}) {
  const { q, nameOf } = props;
  const items: ReactNode[] = [];
  const nav: SourceNav = { userName: props.userName, nameOf, onOpenMessage: props.onOpenMessage, onOpenQuestion: props.onOpenQuestion };
  if (q.original) items.push(<OriginalBox key="original" o={q.original} nav={nav} tint={props.tintOf(q.original.sessionId)} />);
  (q.sources ?? []).forEach((src, i) => items.push(
    <SourceBox key={`source-${i}`} src={src} askedAt={q.askedAt} {...nav} />,
  ));
  // With something attached the asker named what it points at, so its conversation is left out (issue #369).
  const attached = (q.sources ?? []).some((src) => !('error' in src));
  if (q.earlier?.length && !attached) items.push(<EarlierBox key="earlier" q={q} lines={q.earlier} userName={props.userName} nameOf={nameOf} onOpen={() => props.onOpenConversation(q.sessionId, q.id)} />);
  if (!items.length && q.aboutQuestion === null) return null;
  // What the boxes don't say: where the answer goes.
  const note = q.aboutQuestion === null ? null : q.original
    ? <>Your answer goes to <strong>{nameOf(q.sessionId)}</strong>, which passes it on to {nameOf(q.original.sessionId)}.</>
    : <>Asked by <strong>{nameOf(q.sessionId)}</strong> about question #{q.aboutQuestion}, which can't be shown here: it is gone, or not from one of its sessions. Your answer goes to the manager.</>;
  return (
    <section className="block refers">
      <h4>What it refers to</h4>
      {note && <div className="refers-note muted">{note}</div>}
      {items}
    </section>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The original question, the asker's own words: folded to one line, opened to its title, issue, options, opinions and evidence. */
/** What a source box needs besides its source: names, and the links it may follow. */
type SourceNav = {
  userName: string;
  nameOf: (id: string) => string;
  onOpenMessage?: (sessionId: string, messageId: number) => void;
  onOpenQuestion?: (id: number) => (() => void) | null;
};

function OriginalBox({ o, nav, tint }: { o: OriginalQuestion; nav: SourceNav; tint: CSSProperties | undefined }) {
  const { nameOf } = nav;
  const v = deskQuestion(o);
  const summary = [`asked ${formatTime(o.askedAt)}`, v.options.length ? plural(v.options.length, 'option') : '', v.opinions.length ? plural(v.opinions.length, 'opinion') : '', o.status === 'open' ? '' : o.status]
    .filter(Boolean).join(' · ');
  return (
    <details className={`ref-box original name-tinted${tint ? ' tinted' : ''}`} style={tint}>
      <summary><strong>Original question #{o.id}</strong> <span className="muted">from {nameOf(o.sessionId)} · {summary}</span></summary>
      <QuestionBody o={o} nav={nav} />
    </details>
  );
}

/**
 * A question's own words: its title, issue, options with who picked each, opinions, its evidence folded, and the
 * sources it attached as the same boxes (the manager's decision a on PR #378's review).
 */
function QuestionBody({ o, nav, children }: { o: OriginalQuestion; nav: SourceNav; children?: ReactNode }) {
  const { nameOf } = nav;
  const v = deskQuestion(o);
  const asker = nameOf(o.sessionId);
  const whoOf = (who: string | null) => who ?? asker;
  const md = (text: string) => <Markdown text={text} sessionId={o.sessionId} />;
  return (
    <div className="ref-body">
      <h5 className="ref-title">{v.title}</h5>
      {v.issue && <><h6>The issue</h6><div className="prose">{md(v.issue)}</div></>}
      {v.options.length > 0 && (
        <>
          <h6>Options</h6>
          <ul className="ref-opts">
            {v.options.map((opt) => {
              const by = v.opinions.filter((op) => op.pick === opt.key).map((op) => whoOf(op.who));
              return (
                <li key={opt.key} className={by.length ? 'picked' : ''}>
                  <b>{v.structured ? `${opt.key} · ` : ''}{opt.label.replace(/\*\*/g, '')}</b>
                  {/* The asker's detail often opens with its own dash ("**Label** — the rest"): one dash, not two. */}
                  {opt.detail && <> — <span className="prose inline">{md(opt.detail.replace(/^[—–-]\s*/, ''))}</span></>}
                  {opt.cost && <span className="muted"> Cost: {opt.cost}</span>}
                  {by.length > 0 && <span className="ref-pick"> {by.map((w) => `${w}'s pick`).join(', ')}</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {v.opinions.length > 0 && (
        <>
          <h6>Opinions</h6>
          <ul className="ref-ops">
            {v.opinions.map((op, i) => (
              <li key={i}>
                <b>{whoOf(op.who)}</b> {op.pick ? `picks ${op.pick}` : 'no pick among the options'}{op.why ? ': ' : ''}
                {op.why && <span className="prose inline">{md(op.why)}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {v.evidence && <details className="ev"><summary>Evidence</summary><div className="prose">{md(v.evidence)}</div></details>}
      {o.sources?.length ? <><h6>What it refers to</h6>{o.sources.map((src, i) => <SourceBox key={i} src={src} askedAt={o.askedAt} {...nav} />)}</> : null}
      {children}
    </div>
  );
}

/**
 * A source the asker attached (issue #369), as the mockup Martin passed on question 332 has it: its kind and origin
 * on the folded line with a link to the original, the text word for word inside, as Ledung fetched it when asked.
 */
function SourceBox({ src, askedAt, ...nav }: SourceNav & { src: AttachedSource; askedAt: number }) {
  const { userName, nameOf, onOpenMessage, onOpenQuestion } = nav;
  if ('error' in src) return <FailedBox src={src} />;
  // In the summary, so it is there folded too; a click on it follows the link, it doesn't open the box.
  const link = (label: string, go: () => void) => <button className="link" onClick={(e) => { e.preventDefault(); go(); }}>{label}</button>;
  const cut = (where: string) => <div className="muted ref-cut">Cut here: the rest is {where}.</div>;
  if (src.kind === 'reply') {
    const who = nameOf(src.sessionId);
    return (
      <details className="ref-box source reply">
        <summary>
          <strong>Reply from {who}</strong>{' '}
          <span className="muted">· its reply of {formatTime(src.at)}, word for word{onOpenMessage ? ' · ' : ''}</span>
          {onOpenMessage && link('open in its conversation', () => onOpenMessage(src.sessionId, src.messageId))}
        </summary>
        <div className="ref-body">
          <div className="prose ref-source"><Markdown text={src.text} sessionId={src.sessionId} /></div>
          {src.cut && cut('in its conversation')}
        </div>
      </details>
    );
  }
  if (src.kind === 'comment') {
    const kind = src.what === 'review' ? 'Review' : src.what === 'review comment' ? 'Review comment' : 'Comment';
    const place = src.path ? ` · ${src.path}${src.line ? `:${src.line}` : ''}` : '';
    const written = src.at ? ` · written ${formatTime(Date.parse(src.at))}` : '';
    return (
      <details className="ref-box source comment">
        <summary>
          <strong>{kind} on {/\/pull\/\d+/.test(src.url) ? 'PR ' : ''}#{src.number}</strong>{' '}
          <span className="muted">· {src.repo.split('/')[1]} · by {src.author}{written}{place} · fetched {formatTime(askedAt)} · </span>
          <a href={src.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>open on GitHub</a>
        </summary>
        <div className="ref-body">
          <div className="prose ref-source">{src.text.trim() ? <Markdown text={src.text} /> : <span className="muted">(no text)</span>}</div>
          {src.cut && cut('on GitHub')}
        </div>
      </details>
    );
  }
  const o = src.question;
  const answeredBy = o.answeredBy === null ? null : o.answeredBy === 'user' ? userName : nameOf(o.answeredBy);
  const state = o.status === 'answered' ? `answered${answeredBy ? ` by ${answeredBy}` : ''} ${formatTime(o.answeredAt ?? o.askedAt)}`
    : o.status === 'open' ? 'still open when attached' : o.status;
  const open = onOpenQuestion?.(o.id) ?? null;
  return (
    <details className="ref-box source question">
      <summary>
        <strong>Earlier question #{o.id}</strong>{' '}
        <span className="muted">· from {nameOf(o.sessionId)} · asked {formatTime(o.askedAt)} · {state}{open ? ' · ' : ''}</span>
        {open && link('open it', open)}
      </summary>
      <QuestionBody o={o} nav={nav}>
        {o.answer !== null && <><h6>The answer</h6><div className="ref-line"><div className="ref-who">{answeredBy ?? 'Answer'}</div><div className="plain">{o.answer}</div></div></>}
      </QuestionBody>
    </details>
  );
}

/** A source Ledung couldn't find or fetch, or not let the asker have: what was named and why, open so it is seen. */
function FailedBox({ src }: { src: FailedSource }) {
  const kind = src.kind === 'reply' ? "A session's reply" : src.kind === 'comment' ? 'A GitHub comment' : 'An earlier question';
  return (
    <details className="ref-box source failed" open>
      <summary><strong>{kind} could not be attached</strong> <span className="muted">· {src.named}</span></summary>
      <div className="ref-body"><div className="ref-failed">{src.error}</div></div>
    </details>
  );
}

/** The asker's last messages before it asked, word for word, as they were then. */
function EarlierBox({ q, lines, userName, nameOf, onOpen }: {
  q: QuestionInfo; lines: ConversationLine[]; userName: string; nameOf: (id: string) => string; onOpen: () => void;
}) {
  const asker = nameOf(q.sessionId);
  const who = (l: ConversationLine) => l.kind === 'reply' ? asker : l.kind === 'user' ? userName : `Delivered to ${asker} by Ledung`;
  return (
    <details className="ref-box earlier">
      <summary>
        <strong>Earlier in the conversation</strong>{' '}
        <span className="muted">· the {lines.length === 1 ? 'message' : `${lines.length} messages`} {asker} had just before asking · </span>
        {/* In the summary, so it is there folded too; a click on it opens the conversation, not the box. */}
        <button className="link" onClick={(e) => { e.preventDefault(); onOpen(); }}>open the conversation</button>
      </summary>
      <div className="ref-body">
        {lines.map((l, i) => (
          <div key={i} className={`ref-line ${l.kind}`}>
            <div className="ref-who">{who(l)} · {formatTime(l.at)}</div>
            <div className="prose"><Markdown text={l.text} sessionId={q.sessionId} /></div>
            {l.cut && <div className="muted ref-cut">Cut here: the rest is in the conversation.</div>}
          </div>
        ))}
      </div>
    </details>
  );
}
