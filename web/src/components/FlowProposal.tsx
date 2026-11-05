// A manager's proposed workflow change on its review page (workflow part 3e): each flow that changes drawn before and
// after with the workflow page's own diagram, the texts that change, and what the checks find. Loaded only for such a
// review, so the diagram library stays out of the page's first load.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import type { FlowProposal, ProposalFlow } from '../../../src/shared/flow-proposal.ts';
import type { Flow } from '../../../src/shared/flow.ts';
import { layoutFlow } from '../flowLayout.ts';
import { Diagram } from './WorkflowView.tsx';
import { useNarrow } from './FlowDiagram.tsx';
import { Markdown } from './Markdown.tsx';

const NO_MARKS = { at: new Map(), counts: new Map(), path: new Map() };

/** The blocks of one side that the other doesn't have as they are: added or changed after, removed or changed before. */
function changedBlocks(side: Flow | null, other: Flow | null): Set<string> {
  const there = new Map((other?.blocks ?? []).map((b) => [b.id, JSON.stringify({ ...b, at: 0 })]));
  return new Set((side?.blocks ?? []).filter((b) => there.get(b.id) !== JSON.stringify({ ...b, at: 0 })).map((b) => b.id));
}

function Side({ label, side, other, narrow, titles }: { label: string; side: ProposalFlow | null; other: ProposalFlow | null; narrow: boolean; titles: Record<string, string> }) {
  const layout = useMemo(() => (side?.flow ? layoutFlow(side.flow) : null), [side]);
  // The blocks that change are outlined on both sides; briefs are named, not read, so none shows as missing.
  const marks = useMemo(() => ({ ...NO_MARKS, path: new Map([...changedBlocks(side?.flow ?? null, other?.flow ?? null)].map((id) => [id, 'here' as const])) }), [side, other]);
  const texts = useMemo(() => Object.fromEntries((side?.flow?.blocks ?? []).flatMap((b) => (b.brief ? [[b.brief, '']] : []))), [side]);
  // A block clicked lights its arrows (#124); a click on empty space or Esc clears it.
  const [selected, setSelected] = useState<string | null>(null);
  const clear = useCallback(() => setSelected(null), []);
  return (
    <div className="proposal-side">
      <h5>{label}</h5>
      {!side ? <p className="muted">{label === 'Before' ? 'A new flow.' : 'Removed.'}</p>
        : !side.flow || !layout ? <p className="flow-problem-inline">{side.file} doesn't read as a flow.</p>
        : <Diagram flow={side.flow} layout={layout} texts={texts} selected={selected} onSelect={setSelected} onClear={clear} narrow={narrow} flowTitle={(n) => titles[n]} marks={marks} fit still={narrow} />}
    </div>
  );
}

export default function FlowProposalView({ project, id }: { project: string; id: number }) {
  const [p, setP] = useState<FlowProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const narrow = useNarrow();
  useEffect(() => {
    let live = true;
    api.proposal(project, id).then((v) => live && setP(v), (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [project, id]);
  if (error) return <p className="flow-problem-inline">The proposal could not be read: {error}</p>;
  if (!p) return <p className="muted">Reading the proposal…</p>;
  const faults = p.problems.filter((x) => !x.hint);
  return (
    <section className="proposal">
      <h4>The workflow before and after</h4>
      <p className="muted">The blocks that change are outlined.</p>
      {p.state !== 'open' && <p className="muted">This proposal is {p.state === 'saved' ? 'saved' : p.state === 'declined' ? 'declined' : 'accepted but could not be saved'}.</p>}
      {p.flows.map((f) => (
        <div key={f.name} className="proposal-flow">
          <h5 className="proposal-flow-title">{f.after?.title ?? f.before?.title} <span className="muted mono">{f.after?.file ?? f.before?.file}</span></h5>
          <div className="proposal-sides">
            <Side label="Before" side={f.before} other={f.after} narrow={narrow} titles={p.titles ?? {}} />
            <Side label="After" side={f.after} other={f.before} narrow={narrow} titles={p.titles ?? {}} />
          </div>
        </div>
      ))}
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
