// A manager's proposed workflow change on its review page (workflow part 3e): each flow that changes drawn before and
// after with the workflow page's own diagram, the texts that change, and what the checks find. Loaded only for such a
// review, so the diagram library stays out of the page's first load. Each side can be maximised (#334): the flow over
// the whole window, with a Before / After switch that keeps the zoom and position.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.ts';
import type { FlowProposal, ProposalFlow } from '../../../src/shared/flow-proposal.ts';
import { layoutFlow } from '../flowLayout.ts';
import { changedBlocks, isMaxEntry, maxEntryAction, selectedIn, sideNote, staleMaxEntry, withMaxEntry, type SideName } from '../proposalSides.ts';
import { Diagram } from './WorkflowView.tsx';
import { useNarrow } from './FlowDiagram.tsx';
import { Markdown } from './Markdown.tsx';

type Changed = FlowProposal['flows'][number];

const NO_MARKS = { at: new Map(), counts: new Map(), path: new Map() };
const LABEL: Record<SideName, string> = { before: 'Before', after: 'After' };
// A Back taken to leave a stale big-view entry and not yet arrived, so it is taken once (React runs effects twice in
// development, and both would see the entry before the first Back lands).
let leavingStale = false;

/** What a side's diagram needs: its layout, its changed blocks outlined, and its briefs named. */
function useSideView(side: ProposalFlow | null, other: ProposalFlow | null) {
  const layout = useMemo(() => (side?.flow ? layoutFlow(side.flow) : null), [side]);
  // The blocks that change are outlined on both sides; briefs are named, not read, so none shows as missing.
  const marks = useMemo(() => ({ ...NO_MARKS, path: new Map([...changedBlocks(side?.flow ?? null, other?.flow ?? null)].map((id) => [id, 'here' as const])) }), [side, other]);
  const texts = useMemo(() => Object.fromEntries((side?.flow?.blocks ?? []).flatMap((b) => (b.brief ? [[b.brief, '']] : []))), [side]);
  return { flow: side?.flow ?? null, layout, marks, texts };
}

const MaxIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>
);

function Side({ name, side, other, narrow, titles, flowTitle, onMaximise }: { name: SideName; side: ProposalFlow | null; other: ProposalFlow | null; narrow: boolean; titles: Record<string, string>; flowTitle: string; onMaximise: (from: HTMLButtonElement) => void }) {
  const label = LABEL[name];
  const { flow, layout, marks, texts } = useSideView(side, other);
  // A block clicked lights its arrows (#124); a click on empty space or Esc clears it.
  const [selected, setSelected] = useState<string | null>(null);
  const clear = useCallback(() => setSelected(null), []);
  return (
    <div className="proposal-side">
      <div className="proposal-side-head">
        <h5>{label}</h5>
        {flow && layout && (
          <button className="small proposal-max-open" onClick={(e) => onMaximise(e.currentTarget)} aria-label={`Maximise ${label.toLowerCase()}: ${flowTitle}`} title="Show it over the whole window">
            <MaxIcon /> Maximise
          </button>
        )}
      </div>
      {!side ? <p className="muted">{label === 'Before' ? 'A new flow.' : 'Removed.'}</p>
        : !flow || !layout ? <p className="flow-problem-inline">{side.file} doesn't read as a flow.</p>
        : <Diagram flow={flow} layout={layout} texts={texts} selected={selected} onSelect={setSelected} onClear={clear} narrow={narrow} flowTitle={(n) => titles[n]} marks={marks} fit still={narrow} />}
    </div>
  );
}

const CloseIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
);

/**
 * One flow of the proposal over the whole window (#334). One diagram serves both sides and only its blocks are
 * swapped, so the switch keeps the zoom and position; a side without a diagram covers it with why, and the diagram
 * stays as it was for the way back. Escape, the close button and Back close it; while it is open the page behind takes
 * no keys, clicks or scrolling.
 */
function Maximised({ f, start, narrow, titles, decided, onClosed }: { f: Changed; start: SideName; narrow: boolean; titles: Record<string, string>; decided: string | null; onClosed: () => void }) {
  const [shown, setShown] = useState<SideName>(start);
  const [selected, setSelected] = useState<string | null>(null);
  const clear = useCallback(() => setSelected(null), []);
  const views = { before: useSideView(f.before, f.after), after: useSideView(f.after, f.before) };
  const note = sideNote(shown, f[shown]);
  // The side drawn: the one shown when it has a diagram, else the other, under the note.
  const drawn = note ? (shown === 'before' ? 'after' : 'before') : shown;
  const view = views[drawn];
  const box = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    // Opening added a history entry; going back takes it away, and the popstate below closes the view.
    if (isMaxEntry(history.state)) history.back();
    else onClosed();
  }, [onClosed]);
  useEffect(() => {
    closeButton.current?.focus();
    const onPop = () => { if (!isMaxEntry(history.state)) onClosed(); };
    // On the window and in capture, ahead of every page-wide handler: Escape closes, and no key reaches the page behind
    // (the review's own Escape, arrows and letters). Tab stays inside the view.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const all = [...box.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')];
      const i = all.indexOf(document.activeElement as HTMLElement);
      if (i === -1 || (e.shiftKey ? i === 0 : i === all.length - 1)) {
        e.preventDefault();
        all[e.shiftKey ? all.length - 1 : 0]?.focus();
      }
    };
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = 'hidden';
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey, true);
    return () => {
      root.style.overflow = overflow;
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [close, onClosed]);
  const title = f.after?.title ?? f.before?.title ?? f.name;
  return createPortal(
    <div className="proposal proposal-max" role="dialog" aria-modal="true" aria-label={`${title}, ${LABEL[shown].toLowerCase()}`} ref={box}>
      <div className="proposal-max-bar">
        <span className="proposal-max-title">{title}{decided && <span className="muted"> · {decided}</span>}</span>
        <div className="proposal-max-switch" role="group" aria-label="Which side">
          {(['before', 'after'] as const).map((s) => (
            <button key={s} className={shown === s ? 'on' : ''} aria-pressed={shown === s} onClick={() => setShown(s)}>{LABEL[s]}</button>
          ))}
        </div>
        <button ref={closeButton} className="icon" aria-label="Close: back to the review" title="Close (Esc)" onClick={close}><CloseIcon /></button>
      </div>
      <div className="proposal-max-stage">
        {view.flow && view.layout && (
          <div className={`proposal-max-diagram${note ? ' covered' : ''}`} inert={note ? true : undefined}>
            <Diagram flow={view.flow} layout={view.layout} texts={view.texts} selected={selectedIn(view.flow, selected)} onSelect={setSelected} onClear={clear} narrow={narrow} flowTitle={(n) => titles[n]} marks={view.marks} fit />
          </div>
        )}
        {note && <p className={`proposal-max-note${note.problem ? ' flow-problem-inline' : ''}`}>{note.text}</p>}
      </div>
    </div>,
    document.body,
  );
}

export default function FlowProposalView({ project, id }: { project: string; id: number }) {
  const [p, setP] = useState<FlowProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const narrow = useNarrow();
  // The side maximised, and the button that opened it, which takes the focus back on closing (#334).
  const [max, setMax] = useState<{ flow: string; side: SideName } | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const maxOpen = useRef(false);
  useEffect(() => {
    // A big view's entry with no big view open (a reload, Forward, or the review redrawn while it was open) is left
    // with Back: otherwise the next close lands on it and does nothing, and the review's own Close lands one short.
    const tidy = () => {
      if (leavingStale || !staleMaxEntry(history.state, maxOpen.current)) return;
      leavingStale = true;
      history.back();
    };
    const onPop = () => { leavingStale = false; tidy(); };
    tidy();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    let live = true;
    api.proposal(project, id).then((v) => live && setP(v), (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [project, id]);
  const maximise = (flow: string, side: SideName, from: HTMLButtonElement) => {
    opener.current = from;
    // An entry of its own, at the same address, so Back closes the big view instead of leaving the review.
    // One entry only: on a stale one (not yet left) it is reused, so a single Back still closes the view.
    if (maxEntryAction(history.state) === 'replace') history.replaceState(withMaxEntry(history.state), '');
    else history.pushState(withMaxEntry(history.state), '');
    maxOpen.current = true;
    setMax({ flow, side });
  };
  const closed = useCallback(() => {
    maxOpen.current = false;
    setMax(null);
    opener.current?.focus({ preventScroll: true });
  }, []);
  if (error) return <p className="flow-problem-inline">The proposal could not be read: {error}</p>;
  if (!p) return <p className="muted">Reading the proposal…</p>;
  const faults = p.problems.filter((x) => !x.hint);
  const decided = p.state === 'open' ? null : p.state === 'saved' ? 'saved' : p.state === 'declined' ? 'declined' : 'accepted but could not be saved';
  const maxFlow = max && p.flows.find((f) => f.name === max.flow);
  return (
    <section className="proposal">
      <h4>The workflow before and after</h4>
      <p className="muted">The blocks that change are outlined.</p>
      {decided && <p className="muted">This proposal is {decided}.</p>}
      {p.flows.map((f) => {
        const title = f.after?.title ?? f.before?.title ?? f.name;
        return (
          <div key={f.name} className="proposal-flow">
            <h5 className="proposal-flow-title">{f.after?.title ?? f.before?.title} <span className="muted mono">{f.after?.file ?? f.before?.file}</span></h5>
            <div className="proposal-sides">
              <Side name="before" side={f.before} other={f.after} narrow={narrow} titles={p.titles ?? {}} flowTitle={title} onMaximise={(b) => maximise(f.name, 'before', b)} />
              <Side name="after" side={f.after} other={f.before} narrow={narrow} titles={p.titles ?? {}} flowTitle={title} onMaximise={(b) => maximise(f.name, 'after', b)} />
            </div>
          </div>
        );
      })}
      {maxFlow && max && <Maximised f={maxFlow} start={max.side} narrow={narrow} titles={p.titles ?? {}} decided={decided && `This proposal is ${decided}.`} onClosed={closed} />}
      {faults.length > 0 && (
        <div className="flow-problems" role="alert">
          <strong>{faults.length === 1 ? 'One problem' : `${faults.length} problems`} in the workflow as it would be:</strong>
          <ul>{faults.map((x, i) => <li key={i}><code>{x.at}</code> {x.message}</li>)}</ul>
        </div>
      )}
      {p.texts.map((t) => (
        <details key={t.file} className="flow-overlay">
          <summary className="mono">{t.file} <span className="muted">· {t.before === null ? 'new' : t.after === null ? 'removed' : 'changed'}</span></summary>
          {t.after !== null && <Markdown text={t.after} />}
          {t.before !== null && t.after !== null && <details className="flow-overlay"><summary className="muted">As it was</summary><Markdown text={t.before} /></details>}
        </details>
      ))}
    </section>
  );
}
