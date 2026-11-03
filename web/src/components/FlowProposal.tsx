// A manager's proposed workflow change on its review page (workflow part 3e): each flow that changes drawn before and
// after with the workflow page's own diagram, the texts that change, and what the checks find. Loaded only for such a
// review, so the diagram library stays out of the page's first load.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import type { FlowProposal, ProposalFlow } from '../../../src/shared/flow-proposal.ts';
import { layoutFlow } from '../flowLayout.ts';
import { Diagram } from './WorkflowView.tsx';
import { useNarrow } from './FlowDiagram.tsx';
import { Markdown } from './Markdown.tsx';

const NO_MARKS = { at: new Map(), counts: new Map(), path: new Map() };

function Side({ label, side, narrow }: { label: string; side: ProposalFlow | null; narrow: boolean }) {
  const layout = useMemo(() => (side?.flow ? layoutFlow(side.flow) : null), [side]);
  return (
    <div className="proposal-side">
      <h5>{label}</h5>
      {!side ? <p className="muted">{label === 'Before' ? 'A new flow.' : 'Removed.'}</p>
        : !side.flow || !layout ? <p className="flow-problem-inline">{side.file} doesn't read as a flow.</p>
        : <Diagram flow={side.flow} layout={layout} texts={{}} selected={null} onSelect={() => {}} narrow={narrow} flowTitle={() => undefined} marks={NO_MARKS} />}
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
      {p.state !== 'open' && <p className="muted">This proposal is {p.state === 'saved' ? 'saved' : p.state === 'declined' ? 'declined' : 'accepted but could not be saved'}.</p>}
      {p.flows.map((f) => (
        <div key={f.name} className="proposal-flow">
          <h5 className="proposal-flow-title">{f.after?.title ?? f.before?.title} <span className="muted mono">{f.after?.file ?? f.before?.file}</span></h5>
          <div className="proposal-sides">
            <Side label="Before" side={f.before} narrow={narrow} />
            <Side label="After" side={f.after} narrow={narrow} />
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
