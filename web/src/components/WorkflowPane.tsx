// The Workflow pane (Simon, 2026-11-04): beside a chat, as the Files pane is, or full screen on a phone. A small fitted
// diagram with the runs' markers and the Runs list; in a run's session, its run is chosen (its path marked) and its
// block selected. "Open full page" goes to the workflow page, where the blocks' briefs, the rules and the builder are.
// One pane at a time beside a chat: Files has tabs of its own, and a session's files and its workflow are read apart.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import { DEFAULT_FLOW, type FlowView } from '../../../src/shared/flow.ts';
import type { FlowRun } from '../../../src/shared/flow-run.ts';
import type { SessionInfo } from '../../../src/shared/protocol.ts';
import { layoutFlow } from '../flowLayout.ts';
import { blockRuns, followLine, pinCounts, runPath, type RunMarks } from '../flowRuns.ts';
import { workflowHash } from '../flowNav.ts';
import { FlowTabs, useNarrow } from './FlowDiagram.tsx';
import { RunsPanel } from './FlowRuns.tsx';
import { OriginLine } from './OriginLine.tsx';
import { Diagram, flowsOf } from './WorkflowView.tsx';

export function WorkflowPane({ session, liveRuns, connected, onClose }: {
  session: SessionInfo;
  /** The project's runs as the live connection last sent them; none yet: those read on opening. */
  liveRuns?: FlowRun[];
  /** The live connection's hellos: a reconnect reads them again. */
  connected: number;
  onClose: () => void;
}) {
  const project = session.project;
  const own = session.runBlock;
  const [view, setView] = useState<FlowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    api.flow(project).then((v) => live && setView(v), (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [project, connected]);
  const [readRuns, setReadRuns] = useState<FlowRun[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.runs(project).then((r) => { if (live) { setReadRuns(r); setRunsError(null); } }, (e: Error) => live && setRunsError(e.message));
    return () => { live = false; };
  }, [project, connected]);
  const runs = liveRuns ?? readRuns;
  // The session's own run chosen, and its flow shown, until another is picked.
  const [chosenRun, setChosenRun] = useState<string | null>(own?.run ?? null);
  const [shownName, setShownName] = useState(own?.flow ?? DEFAULT_FLOW);
  useEffect(() => { setChosenRun(own?.run ?? null); setShownName(own?.flow ?? DEFAULT_FLOW); }, [session.id, own?.run, own?.flow]);
  const narrow = useNarrow();
  const flows = useMemo(() => (view ? flowsOf(view) : []), [view]);
  const shown = flows.find((f) => f.name === shownName) ?? flows[0];
  const flow = shown?.flow ?? null;
  const layout = useMemo(() => (flow ? layoutFlow(flow) : null), [flow]);
  const flowTitle = (name: string) => { const f = flows.find((x) => x.name === name); return f ? f.flow?.title ?? f.name : undefined; };
  const chosen = runs.find((r) => r.id === chosenRun) ?? null;
  const marks = useMemo<RunMarks>(() => {
    const name = shown?.name ?? DEFAULT_FLOW;
    return { at: blockRuns(runs, name), counts: pinCounts(flow, runs, name, chosen), path: chosen && chosen.flow === name ? runPath(chosen) : new Map() };
  }, [runs, chosen, flow, shown?.name]);
  // Its own block, in its own run's flow.
  // Its own block marked as it was; one clicked lights its arrows (#124), until a click on empty space or Esc.
  const selected = own && own.flow === (shown?.name ?? DEFAULT_FLOW) ? own.block : null;
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [session.id, shown?.name]);
  const clear = useCallback(() => setPicked(null), []);
  const choose = (id: string | null) => {
    setChosenRun(id);
    const r = runs.find((x) => x.id === id);
    if (r) setShownName(r.flow);
  };
  const full = workflowHash(project, shown && shown.name !== DEFAULT_FLOW ? shown.name : null);
  return (
    <aside className="file-panel workflow-pane" aria-label="Workflow">
      <header className="file-head">
        <strong>Workflow</strong>
        {flow?.title && <span className="muted workflow-pane-title">{flow.title}</span>}
        {view?.flow?.origin && <OriginLine origin={view.flow.origin} compact />}
        <span className="spacer" />
        <a className="workflow-pane-full" href={full} title="The workflow page: briefs, rules, the builder">Open full page</a>
        <button className="small" onClick={onClose} aria-label="Close the Workflow pane">Close</button>
      </header>
      <div className="pane-body workflow-pane-body">
        {error && <p className="flow-problem-inline">{error}</p>}
        {!view && !error && <p className="muted">Reading the workflow…</p>}
        {view && !flow && <p className="muted">{view.source ? "The flow can't be read here: the full page says why." : `${project} has no drawn workflow.`}</p>}
        {flows.length > 1 && <FlowTabs flows={flows.map((f) => ({ name: f.name, title: f.flow?.title ?? f.name, bad: 0 }))} shown={shown?.name ?? DEFAULT_FLOW} onShow={setShownName} />}
        {view && flow && layout && (
          <div className="workflow-pane-diagram">
            <Diagram key={`${project}:${shown?.name}`} flow={flow} layout={layout} texts={view.texts} selected={selected} lit={picked} onSelect={setPicked} onClear={clear} narrow={narrow} flowTitle={flowTitle} marks={marks} fit />
          </div>
        )}
        {view && (
          <RunsPanel runs={runs} chosen={chosenRun} onChoose={choose} flowTitle={(n) => flowTitle(n) ?? n} error={runsError} follow={followLine(flow)}
            onStart={(id) => api.startRun(project, id).then(() => null, (e: Error) => e.message)}
            onStop={(id) => api.stopRun(project, id).then(() => null, (e: Error) => e.message)}
            blockTitle={(f, id) => flows.find((x) => x.name === f)?.flow?.blocks.find((b) => b.id === id)?.title ?? id} />
        )}
      </div>
    </aside>
  );
}
