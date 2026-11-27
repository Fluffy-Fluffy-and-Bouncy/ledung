// The question desk's options and opinions (issue #96), one component for every page that asks a choice: a question
// of Ledung's own, a plain question and each decision of a request (issue #502). Simon, 2026-11-24, after trying the
// preview: "I like the existing options we have, where we put border based on who recommends what. I think the
// decisions should use the same layout, and be able to stack multiple of them."
import { Fragment, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { disagree, MAX_BORDER_PARTS, type DeskOpinion, type DeskOption } from '../../../src/shared/questions.ts';
import { usePlainTyping } from '../usePlainTyping.ts';

/** What the pick marks on the options mean, for the opinions this question has. */
export function Legend({ opinions, whoOf }: { opinions: DeskOpinion[]; whoOf: (o: DeskOpinion) => string }) {
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
export const PartKey = ({ i, n }: { i: number; n: number }) => (
  <span className="part-key" aria-hidden="true">{Array.from({ length: n }, (_, j) => <i key={j} className={j === i ? 'on' : ''} />)}</span>
);

export interface OptionsDeskProps {
  /** "Options" on a question; a decision's title on a request. */
  heading: ReactNode;
  /** A decision's own issue, under its heading. */
  intro?: ReactNode;
  options: DeskOption[];
  opinions: DeskOpinion[];
  /** Asked with ask_user's fields (letters on the options); a plain question has labels only. */
  structured: boolean;
  /** Who an opinion without a name is: the asker. */
  asker: string;
  open: boolean;
  /** While open: the option picked, "other", or null. */
  selected: string | null;
  /** Once answered: the option that was the answer, if one was. */
  chosen: string | null;
  onPick: (key: string) => void;
  /** The Other answer's words while open. */
  other: string;
  onOther: (text: string) => void;
  otherHint: string;
  /** Show the Opinions section with none given ("No opinions given."), as the desk does for a structured question. */
  opinionsWhenNone: boolean;
  md: (text: string) => ReactNode;
  /** Where the section's first button and box are, for the page's keys. */
  ariaLabel?: string;
}

/** The options with their opinion borders and legend, Other answer, then the Opinions under them. */
export function OptionsDesk(p: OptionsDeskProps) {
  const typing = usePlainTyping();
  const otherRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (p.selected === 'other') otherRef.current?.focus(); }, [p.selected]);
  const ops = p.opinions;
  // Up to five opinions split each option's border, one part each; more are named in writing (issue #96).
  const split = ops.length <= MAX_BORDER_PARTS;
  const whoOf = (o: DeskOpinion) => o.who ?? p.asker;
  const part = (i: number) => ({ '--i': i, '--n': ops.length }) as CSSProperties;
  const otherKey = p.options.length + 1;
  const pickLabel = (key: string) => {
    const i = p.options.findIndex((o) => o.key === key);
    return i < 0 ? key : `${i + 1} · ${p.options[i]!.label.replace(/\*\*/g, '')}`;
  };
  return (
    <>
      {(p.options.length > 0 || p.open) && (
        <section className="block opts-block">
          <h4>{p.heading}</h4>
          {p.intro}
          {p.options.length > 0 && <Legend opinions={ops} whoOf={whoOf} />}
          <div className="opts" role="radiogroup" aria-label={p.ariaLabel ?? 'Options'}>
            {p.options.map((o, i) => {
              const on = p.open ? p.selected === o.key : p.chosen === o.key;
              return (
                <button key={o.key} className={`opt${on ? ' on' : ''}`} role="radio" aria-checked={on} disabled={!p.open} onClick={() => p.onPick(o.key)}>
                  <span className="k">{i + 1}</span>
                  <span className="lab">{p.structured && <span className="letter">{o.key}</span>}{o.label.replace(/\*\*/g, '')}</span>
                  {o.detail && <span className="det prose">{p.md(o.detail)}</span>}
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
                  {!p.open && on && <span className="tag answer">Answer</span>}
                </button>
              );
            })}
            {p.open && (
              <button className={`opt${p.selected === 'other' ? ' on' : ''}`} role="radio" aria-checked={p.selected === 'other'} onClick={() => p.onPick('other')}>
                <span className="k">{otherKey}</span>
                <span className="lab">Other answer</span>
                <span className="det">{p.otherHint}</span>
              </button>
            )}
          </div>
          {p.open && p.selected === 'other' && (
            <textarea {...typing} ref={otherRef} className="box" aria-label="Your answer, in your own words" placeholder="Your answer, in your own words" value={p.other} onChange={(e) => p.onOther(e.target.value)} />
          )}
        </section>
      )}
      {(ops.length > 0 || p.opinionsWhenNone) && (
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
                    <div className="prose">{op.why ? p.md(op.why) : <span className="none">{p.structured ? 'No reason given.' : 'Marked "(recommended)"; a plain question gives no reason.'}</span>}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="rec empty"><div className="none">No opinions given.</div></div>}
        </section>
      )}
    </>
  );
}
