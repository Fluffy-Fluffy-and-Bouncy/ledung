// The workflow page (issue #310, part 1, docs/steps/workflow-builder.md): a project's flow drawn read-only with React
// Flow, each block's brief a click away, the standing rules beside it and the checks' problems on top. A narrow
// screen gets the blocks as a list instead (the diagram is a choice there), since a diagram is hard to read at 390 px.
// The manager's file (#322) is linked beside the standing rules; a block shows who runs it and its sub-steps. A project
// with several flows (#447) gets a tab for each; a Run flow block opens the flow it runs.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api.ts';
import { DEFAULT_FLOW, FLOW_FILE, type Flow, type FlowBlock, type FlowEntry, type FlowView } from '../../../src/shared/flow.ts';
import { actorLine, arrowsFrom, flowLine, frameOf, KIND_LABEL, layoutFlow, outcomeHandles, readingOrder, substepText, type FlowLayout } from '../flowLayout.ts';
import { amendedBy, newDraft, single, workspaceFromView, type Workspace } from '../flowEdit.ts';
import { ARROW_COLOUR, continueHandles, EDGE_TYPES, FlowMiniMap, FlowTabs, frameColour, frameNode, NODE_TYPES, useMeasured, useNarrow, useOpeningView, withLabelSpots, type BlockData } from './FlowDiagram.tsx';
import { FlowBuilder } from './FlowBuilder.tsx';
import { Markdown } from './Markdown.tsx';

/** A block's title by its id, for "continues Build". */
const titles = (flow: Flow) => (id: string) => flow.blocks.find((b) => b.id === id)?.title ?? id;

/** Every flow of the view (#447), the default one (flow.json) first; its problems are the shared ones too. */
export function flowsOf(view: FlowView): FlowEntry[] {
  return [{ name: DEFAULT_FLOW, file: FLOW_FILE, flow: view.flow, raw: view.raw, problems: view.problems }, ...view.flows];
}

/** A flow's title by its name, as a tab and a Run flow block say it; undefined: no such flow. */
const flowTitles = (flows: readonly FlowEntry[]) => (name: string): string | undefined => {
  const f = flows.find((x) => x.name === name);
  return f ? f.flow?.title ?? f.name : undefined;
};

function Diagram({ flow, layout, texts, selected, onSelect, narrow, flowTitle }: { flow: Flow; layout: FlowLayout; texts: Record<string, string>; selected: string | null; onSelect: (id: string) => void; narrow: boolean; flowTitle: (name: string) => string | undefined }) {
  const amended = amendedBy(flow.overlays);
  const [sizes, onMeasured] = useMeasured();
  const title = titles(flow);
  const at = new Map(layout.blocks.map((p) => [p.block.id, p]));
  // Comment frames (#446) first, behind the blocks; their ids apart from the blocks'.
  const nodes: Node[] = [
    ...flow.frames.map((f, i) => frameNode(`frame:${i}`, f)),
    ...layout.blocks.map(({ block, x, y }): Node<BlockData> => ({
      id: block.id, type: 'block', position: { x, y }, ...(sizes[block.id] ? { measured: sizes[block.id] } : {}),
      data: { block, hasBrief: !!block.brief && texts[block.brief] !== undefined, selected: block.id === selected, overlays: amended.get(block.id), runsFlow: flowLine(block, flowTitle), ...(block.continues ? { continuesTitle: title(block.continues) } : {}) },
    })),
  ];
  const drawn: Edge[] = layout.arrows.map((a) => {
    // An outcome leaves from its own pin, which says its word (#446); a continued session from the side facing the other.
    const [sourceHandle, targetHandle, offset]: [string, string, number?] = a.kind === 'continue'
      ? continueHandles(at.get(a.from), at.get(a.to))
      : outcomeHandles(a.kind, a.index ?? 0, at.get(a.from)?.block.outcomes?.length ?? 0);
    return {
      id: a.id, source: a.from, target: a.to, sourceHandle, targetHandle,
      className: `flow-arrow arrow-${a.kind}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: ARROW_COLOUR[a.kind] },
      // Round the blocks along the layout's route from its pin; one it couldn't route (a block placed by hand, an arrow
      // to itself, a continued session) as a step path.
      ...(a.route && offset !== undefined
        ? { type: 'routed', data: { route: a.route, offset } }
        : { type: 'stepped', data: { text: a.kind === 'continue' ? a.text : null, ...(offset ? { offset } : {}) } }),
    };
  });
  // Each arrow's words clear of the others' (#1184).
  const edges = withLabelSpots(nodes, drawn);
  // A small flow opens fitted; a large one at a readable zoom from its start, with a map to find the rest (#318).
  const box = useRef<HTMLDivElement>(null);
  const startId = flow.start && layout.blocks.some((p) => p.block.id === flow.start) ? flow.start : layout.blocks[0]?.block.id;
  const opening = useOpeningView(box, [...layout.blocks, ...flow.frames.map((f) => ({ ...f.at, ...f.size }))], layout.blocks.find((p) => p.block.id === startId));
  return (
    <div className="flow-canvas" ref={box}>
      {opening && (
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} minZoom={0.2} maxZoom={2}
          {...(opening.fit ? { fitView: true, fitViewOptions: { padding: 0.15 } } : { defaultViewport: opening })}
          nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} elementsSelectable={false}
          onNodeClick={(_, n) => n.type === 'block' && onSelect(n.id)} onNodesChange={onMeasured}
        >
          <Background gap={24} />
          {/* A phone zooms with two fingers; the buttons would cover the drawing there. */}
          {!narrow && <Controls showInteractive={false} />}
          {!opening.fit && <FlowMiniMap small={narrow} />}
        </ReactFlow>
      )}
    </div>
  );
}

function BlockList({ flow, layout, texts, onSelect, flowTitle }: { flow: Flow; layout: FlowLayout; texts: Record<string, string>; onSelect: (id: string) => void; flowTitle: (name: string) => string | undefined }) {
  const title = titles(flow);
  // A frame's title (#446) above the first of its blocks in the list, when the one before was in no frame or another.
  const frames = frameOf(layout.blocks, flow.frames);
  const order = readingOrder(layout);
  return (
    <ol className="flow-list">
      {order.map(({ block: b }, i) => (
        <Fragment key={b.id}>
        {frames.get(b.id) && frames.get(b.id) !== frames.get(order[i - 1]?.block.id ?? '') && (
          <li role="presentation" className={`flow-list-frame${frames.get(b.id)!.colour ? ' coloured' : ''}`} style={frameColour(frames.get(b.id)!)}>{frames.get(b.id)!.title}</li>
        )}
        <li>
          <button className={`flow-list-item kind-${b.kind}`} onClick={() => onSelect(b.id)}>
            <span className="flow-block-top"><span className="flow-kind">{KIND_LABEL[b.kind]}</span></span>
            <span className="flow-block-title">{b.title}</span>
            {actorLine(b, title) && <span className="flow-block-actor">{actorLine(b, title)}</span>}
            {flowLine(b, flowTitle) && <span className="flow-block-actor flow-block-runs">▸ {flowLine(b, flowTitle)}</span>}
            {(b.substeps ?? []).map((s, i) => {
              const t = substepText(b, s);
              return <span key={`s${i}`} className="flow-list-substep">{t.head} · {t.detail}{t.outcomes ? ` · ${t.outcomes}` : ''}{t.note ? ` · ${t.note}` : ''}</span>;
            })}
            {arrowsFrom(layout, b.id).map((line, i) => <span key={i} className="flow-list-arrow">{line}</span>)}
            {b.brief && texts[b.brief] !== undefined && <span className="flow-block-brief">📄 {b.brief.split('/').pop()}</span>}
          </button>
        </li>
        </Fragment>
      ))}
    </ol>
  );
}

/** A brief, folded: its file and its text, or that it is missing. */
function Brief({ file, texts, open = false }: { file: string; texts: Record<string, string>; open?: boolean }) {
  const text = texts[file];
  if (text === undefined) return <p className="flow-problem-inline">Its brief {file} is missing.</p>;
  return (
    <details className="flow-overlay" open={open}>
      <summary className="mono">{file}</summary>
      <Markdown text={text} />
    </details>
  );
}

/** The selected block: who runs it, where its arrows go, its sub-steps and its brief; for a Run flow block, the flow it runs. */
function BlockPanel({ block, flow, layout, texts, onBlock, onClose, flowTitle, onFlow }: { block: FlowBlock; flow: Flow; layout: FlowLayout; texts: Record<string, string>; onBlock: (id: string) => void; onClose: () => void; flowTitle: (name: string) => string | undefined; onFlow: (name: string) => void }) {
  const amended = flow.overlays.filter((o) => o.blocks.includes(block.id));
  const title = titles(flow);
  const continuedBy = flow.blocks.filter((b) => b.runs === 'continue' && b.continues === block.id);
  return (
    <div className="flow-panel-body">
      <div className="flow-panel-head">
        <h3>{block.title}</h3>
        <button className="small" onClick={onClose} aria-label="Close the block">×</button>
      </div>
      <p className="muted">{KIND_LABEL[block.kind]}{actorLine(block, title) ? ` · ${actorLine(block, title)}` : ''}</p>
      {block.kind === 'flow' && (block.flow !== undefined && flowTitle(block.flow) !== undefined
        ? <p>Starts the flow <button className="link" onClick={() => onFlow(block.flow!)}>{flowTitle(block.flow)}</button> for a piece of work of its own and waits for it to end; the word it ends with is this block's outcome.</p>
        : <p className="flow-problem-inline">{flowLine(block, flowTitle)}.</p>)}
      {block.runs === 'continue' && block.continues && <p className="muted">Runs in the session of <button className="link" onClick={() => onBlock(block.continues!)}>{title(block.continues)}</button>, which knows the work.</p>}
      {continuedBy.length > 0 && <p className="muted">Its session goes on in {continuedBy.map((b, i) => <span key={b.id}>{i ? ', ' : ''}<button className="link" onClick={() => onBlock(b.id)}>{b.title}</button></span>)}.</p>}
      {arrowsFrom(layout, block.id).length > 0 && <ul className="flow-panel-arrows">{arrowsFrom(layout, block.id).map((l, i) => <li key={i}>{l}</li>)}</ul>}
      {amended.length > 0 && <p className="muted">◇ Amended by {amended.map((o) => o.title).join(', ')}.</p>}
      {!!block.substeps?.length && <>
        <h4>Sub-steps</h4>
        <p className="muted flow-field-hint">Subagents {block.runs === 'manager' ? 'the manager starts' : "this block's session starts"}, in this order; the block's outcome counts once those that run when it is done are done.</p>
        <ol className="flow-panel-substeps">
          {block.substeps.map((s, i) => {
            const t = substepText(block, s);
            return (
              <li key={i}>
                <div><strong>{t.head}</strong></div>
                <div className="muted">{t.detail}</div>
                {t.outcomes && <div className="muted">{t.outcomes}</div>}
                {t.note && <div className="flow-substep-note">{t.note}: a check of the block's own work, so its findings go back to whoever did it.</div>}
                {s.brief && <Brief file={s.brief} texts={texts} />}
              </li>
            );
          })}
        </ol>
      </>}
      {block.brief ? <><h4>Brief</h4><Brief file={block.brief} texts={texts} open /></> : block.kind !== 'flow' && <p className="muted">No brief.</p>}
    </div>
  );
}

/** The manager's file (#322): its standing procedures between steps. */
function ManagerPanel({ flow, texts, onClose }: { flow: Flow; texts: Record<string, string>; onClose: () => void }) {
  const runs = flow.blocks.filter((b) => b.runs === 'manager');
  return (
    <div className="flow-panel-body">
      <div className="flow-panel-head">
        <h3>The manager</h3>
        <button className="small" onClick={onClose} aria-label="Close the manager's file">×</button>
      </div>
      <p className="muted">What the manager does between steps{runs.length ? `, and in ${runs.map((b) => b.title).join(', ')}, which it runs itself` : ''}. Its instructions name this file.</p>
      {flow.manager && <Brief file={flow.manager} texts={texts} open />}
    </div>
  );
}

function Rules({ view, onManager }: { view: FlowView; onManager: () => void }) {
  // Every flow's overlays (#447), each said with its flow's title when there are several.
  const flows = flowsOf(view);
  const overlays = flows.flatMap((f) => (f.flow?.overlays ?? []).map((o) => ({ o, f: f.flow! })));
  const several = flows.length > 1;
  const manager = view.flow?.manager;
  return (
    <div className="flow-panel-body">
      {/* A rules file that starts with its own heading stands in for this one. */}
      {!/^\s*#\s/.test(view.rules ?? '') && <h3>Standing rules</h3>}
      {view.rules != null ? <Markdown text={view.rules} /> : <p className="muted">No rules.md: no standing rules.</p>}
      {manager && <>
        <h3>The manager</h3>
        <p className="flow-role-link">
          <button className="link" onClick={onManager}>📋 Its standing procedures between steps</button>
          {view.texts[manager] === undefined ? <span className="flow-problem-inline"> · {manager} is missing</span> : <span className="muted mono"> · {manager}</span>}
        </p>
      </>}
      {overlays.length > 0 && <>
        <h3>Overlays</h3>
        {overlays.map(({ o, f }, i) => (
          <details key={i} className="flow-overlay">
            <summary>{o.title} <span className="muted">· changes {o.blocks.map(titles(f)).join(', ')}{several ? ` in ${f.title ?? 'its flow'}` : ''}</span></summary>
            {view.texts[o.file] !== undefined ? <Markdown text={view.texts[o.file]!} /> : <p className="flow-problem-inline">Its file {o.file} is missing.</p>}
          </details>
        ))}
      </>}
    </div>
  );
}

/** Why the flow can't be edited here, or null when it can (#311). */
function notEditable(view: FlowView): string | null {
  if (!view.saveTo) return view.readOnly ?? "Ledung can't write into this project's folder.";
  if (view.source && !view.flow) return "flow.json can't be read as a flow, so the builder can't open it: fix it by hand first (the problems above say what).";
  // The builder edits all the flows together (#447), so each must be one.
  const bad = view.flows.find((f) => !f.flow);
  if (bad) return `${bad.file} can't be read as a flow, so the builder can't open the workflow: fix it by hand first (its tab's problems say what).`;
  return null;
}

export function WorkflowView({ project, profiles, onSettings, shownFlow, onShowFlow, onRenamedFlow }: {
  project: string; profiles: string[]; onSettings: () => void;
  /**
   * The flow shown, from the address (#447): null for the default one. Showing another is a history entry
   * (`onShowFlow`), so Back steps through the flows viewed; a flow renamed in the builder replaces its entry.
   */
  shownFlow: string | null; onShowFlow: (name: string) => void; onRenamedFlow: (name: string) => void;
}) {
  const [view, setView] = useState<FlowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The manager's file in the panel (#322); choosing a block shows the block instead.
  const [manager, setManager] = useState(false);
  const select = (id: string | null) => { setSelected(id); setManager(false); };
  const openManager = () => { setManager(true); setSelected(null); };
  const narrow = useNarrow();
  const [diagramOnPhone, setDiagramOnPhone] = useState(false);
  // The builder (#311): open with the flows it edits (#447) and the one shown first.
  const [editing, setEditing] = useState<Workspace | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // The flow shown (#447), by name; one that is gone shows the default one, and says so.
  const shownName = shownFlow ?? DEFAULT_FLOW;
  useEffect(() => {
    let live = true;
    api.flow(project).then((v) => live && setView(v), (e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [project]);
  const flows = useMemo(() => (view ? flowsOf(view) : []), [view]);
  const shown = flows.find((f) => f.name === shownName) ?? flows[0];
  const flowTitle = useMemo(() => flowTitles(flows), [flows]);
  const show = (name: string) => {
    select(null);
    if (name !== shownName) onShowFlow(name);
  };
  // Back or Forward to another flow: nothing of the one before stays chosen.
  useEffect(() => { select(null); }, [shownName]);
  const unknown = view && shownFlow !== null && !flows.some((f) => f.name === shownFlow) ? shownFlow : null;
  const flow = shown?.flow ?? null;
  const layout = useMemo(() => (flow ? layoutFlow(flow) : null), [flow]);
  const block = flow?.blocks.find((b) => b.id === selected) ?? null;
  const managerShown = manager && !!view?.flow?.manager;
  const showDiagram = !narrow || diagramOnPhone;
  const source = view?.source;
  const cannot = view ? notEditable(view) : null;
  const faults = shown?.problems.filter((p) => !p.hint) ?? [];
  const hints = shown?.problems.filter((p) => p.hint) ?? [];
  // A Run flow block opens the flow it runs (#447); any other block, its panel.
  const choose = (id: string) => {
    const b = flow?.blocks.find((x) => x.id === id);
    if (b?.kind === 'flow' && b.flow !== undefined && flowTitle(b.flow) !== undefined) show(b.flow);
    else select(id);
  };
  const edit = () => {
    const opened = view && workspaceFromView(view);
    if (opened) {
      setSaved(null);
      setEditing(opened);
    }
  };
  if (view && editing) {
    return (
      <FlowBuilder
        project={project} view={view} initial={editing} shown={shownName} onShowFlow={onShowFlow} onRenamedFlow={onRenamedFlow} profiles={profiles} narrow={narrow}
        onCancel={() => setEditing(null)}
        onSaved={(v, files, shownThen) => {
          setView(v);
          setEditing(null);
          // The flow the builder showed, by its name as saved (review of #447: a renamed one would fall back to the default).
          if (shownThen !== shownName) onRenamedFlow(shownThen);
          select(null);
          setSaved(`Saved ${files === 1 ? 'one change' : `${files} changes`} into ${v.saveTo ?? 'the project'}.`);
        }}
      />
    );
  }
  return (
    <div className="page-view workflow-view">
      <header className="session-head"><div className="session-head-text"><h2>{project}: workflow{flow?.title ? ` · ${flow.title}` : ''}</h2>
        {source && <div className="muted mono">{source.kind === 'project' ? "From the project's folder: " : `From the shared workflow "${source.workflow}": `}{source.folder}</div>}</div>
        <div className="session-corner">
          {view?.flow && !cannot && <button className="small" onClick={edit} title={narrow ? "Change the blocks' words and the rules; drawing is for a computer" : 'Draw and change the workflow'}>Edit</button>}
          <button className="small" onClick={onSettings}>Project settings</button>
        </div>
      </header>
      {error && <div className="page-body"><p className="flow-problem-inline">{error}</p></div>}
      {!view && !error && <div className="page-body"><p className="muted">Reading the workflow…</p></div>}
      {saved && <div className="flow-saved" role="status">{saved} <button className="small" onClick={() => setSaved(null)} aria-label="Close">×</button></div>}
      {view && <FlowTabs flows={flows.map((f) => ({ name: f.name, title: f.flow?.title ?? f.name, bad: f.problems.filter((p) => !p.hint).length }))} shown={shown?.name ?? DEFAULT_FLOW} onShow={show} />}
      {unknown && <p className="muted flow-note">This project has no flow "{(() => { try { return decodeURIComponent(unknown); } catch { return unknown; } })()}"; showing {flows[0]?.flow?.title ?? 'the default flow'} instead.</p>}
      {view && faults.length > 0 && (
        <div className="flow-problems" role="alert">
          <strong>{faults.length === 1 ? 'One problem' : `${faults.length} problems`} in {shown && shown.name !== DEFAULT_FLOW ? shown.file : 'the workflow files'}{flow ? '' : ', so there is nothing to draw'}:</strong>
          <ul>{faults.map((p, i) => <li key={i}><code>{p.at}</code> {p.message}</li>)}</ul>
        </div>
      )}
      {/* Hints (#1184) are suggestions, folded away: a block that leads nowhere, a session with no brief. */}
      {view && hints.length > 0 && (
        <details className="flow-hints">
          <summary>{hints.length === 1 ? 'One hint' : `${hints.length} hints`}</summary>
          <ul>{hints.map((p, i) => <li key={i}><code>{p.at}</code> {p.message}</li>)}</ul>
        </details>
      )}
      {view && view.source && cannot && <p className="muted flow-note">{cannot}</p>}
      {view && !view.source && (
        <div className="page-body flow-empty">
          <p>{project} has no drawn workflow yet.</p>
          {cannot ? <p className="muted">{cannot}</p> : (
            <>
              <div className="flow-start">
                <button onClick={() => { const n = newDraft(true, view); setEditing(single(n.base, n.draft)); }}><strong>Start a workflow</strong><span className="muted">from a starter: Issue → Build → Code review → Fix → Person → Merge</span></button>
                {!narrow && <button onClick={() => { const n = newDraft(false, view); setEditing(single(n.base, n.draft)); }}><strong>Start from an empty canvas</strong><span className="muted">drag blocks on and connect them</span></button>}
              </div>
              {narrow && <p className="muted">Drawing a workflow from nothing is for a computer; on a phone the starter can be changed block by block.</p>}
              <p className="muted">It is saved as files in <code>{view.saveTo}</code>, the project's own folder: <code>flow.json</code>, the standing rules in <code>rules.md</code>, the manager's in <code>manager.md</code> and the briefs, how each step is done, in <code>briefs/</code>, so a change shows in git like any other. The format is described in docs/steps/workflow-builder.md in Ledung's repository.</p>
            </>
          )}
        </div>
      )}
      {view && layout && (
        <div className={`flow-main${(block || managerShown) && narrow ? ' block-open' : ''}`}>
          <div className="flow-drawing">
            {narrow && (
              <div className="flow-switch" role="group" aria-label="Show as">
                <button className={`small${showDiagram ? '' : ' on'}`} aria-pressed={!showDiagram} onClick={() => setDiagramOnPhone(false)}>List</button>
                <button className={`small${showDiagram ? ' on' : ''}`} aria-pressed={showDiagram} onClick={() => setDiagramOnPhone(true)}>Diagram</button>
              </div>
            )}
            {showDiagram
              ? <Diagram key={`${view.project}:${shown?.name}`} flow={flow!} layout={layout} texts={view.texts} selected={selected} onSelect={choose} narrow={narrow} flowTitle={flowTitle} />
              : <BlockList flow={flow!} layout={layout} texts={view.texts} onSelect={choose} flowTitle={flowTitle} />}
          </div>
          <aside className="flow-panel">
            {block
              ? <BlockPanel block={block} flow={flow!} layout={layout} texts={view.texts} onBlock={select} onClose={() => select(null)} flowTitle={flowTitle} onFlow={show} />
              : managerShown
                ? <ManagerPanel flow={view.flow!} texts={view.texts} onClose={() => setManager(false)} />
                : <Rules view={view} onManager={openManager} />}
          </aside>
        </div>
      )}
    </div>
  );
}
