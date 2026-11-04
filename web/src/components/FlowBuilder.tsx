// The workflow builder (issue #311, part 2, docs/steps/workflow-builder.md, approved by Simon 2026-10-23, question
// #1072): the workflow page's Edit mode. A palette of block kinds to drag onto a React Flow canvas, arrows drawn from a
// block's edge, a panel with the selected block's fields, the standing rules, undo and redo, auto-arrange, part 1's
// checks live, and saving straight into the project's own .ledung/workflow (decision 4). On a phone it edits the
// blocks' words and the rules only: drawing is for a computer (the design's "The builder"). A project's flows (#447) are
// edited together, a tab each, with one undo history and one save; a flow is added, renamed and deleted here.
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Background, Controls, MarkerType, ReactFlow, ReactFlowProvider, useReactFlow, type Connection, type Edge, type Node, type NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api.ts';
import { usePlainTyping } from '../usePlainTyping.ts';
import { BLOCK_KINDS, DEFAULT_BRANCH, DEFAULT_FLOW, DEFAULT_TIDY, STOPPED_ENDING, FLOW_FILE, flowEndings, flowFileOf, MANAGER_FILE, outcomeName, runsSession, SUBSTEP_TO, SUBSTEP_WHEN, WRITABLE_FLOW_FILE, type BlockKind, type FlowBlock, type FlowProblem, type FlowSubstep, type FlowSubstepOutcome, type FlowView, type FlowWorktree, type Runs, type SubstepTo } from '../../../src/shared/flow.ts';
import { NAME_COLOURS, type NameColour } from '../../../src/shared/name-colours.ts';
import { actorLine, BLOCK_HEIGHT, BLOCK_WIDTH, blockSize, flowLine, KIND_LABEL, layoutFlow, outcomeHandles, substepText, substepToText, type PlacedKind, type Point } from '../flowLayout.ts';
import { addBlock, addEndings, addFlow, addFrame, addOutcome, addOverlay, addSubstep, amendedBy, arrange, boxRound, connect, deleteBlocks, deleteFlow, deleteFrame, deleteOutcome, deleteOverlay, deleteSubstep, flowNameProblem, flowOf, frameMembers, framesInside, moveBlock, moveFrame, moveSubstep, newBrief, newManagerFile, newOverlayFile, newSubstepBrief, outcomeKeys, PALETTE, pinned, renameFlow, setBlock, setFollow, setFlowTitle, setFrame, setManager, setOutcome, setOverlay, setSubstep, substepKeys, toggleAmends, wireOutcome, withDraft, workspaceBlocksSaving, workspaceProblems, workspaceWrites, type Draft, type DraftFlow, type Workspace } from '../flowEdit.ts';
import { setLeaveGuard } from '../flowNav.ts';
import { ARROW_COLOUR, continueHandles, EDGE_TYPES, FlowMiniMap, FlowTabs, frameColour, frameNode, NODE_TYPES, useMeasured, useOpeningView, withLabelSpots, type BlockData } from './FlowDiagram.tsx';

/**
 * What the panel shows: a block, an overlay (#318), the manager's file (#322) or a comment frame (#446); none: the
 * workflow's own fields. An outcome (#1184) shows as its block, with that outcome's word to give or change in focus;
 * `naming`, its block with a new outcome's name to give ("+ outcome" on the block, #446), new each time it is asked.
 */
type Selection = { kind: 'block' | 'overlay' | 'manager' | 'frame'; key: string; outcome?: number; naming?: number } | null;
type History = { past: Workspace[]; present: Workspace; future: Workspace[]; group: string | null };

/** The other flows a Run flow block can run (#447): by name, with their titles and how each can end. */
export interface FlowChoice {
  name: string;
  title: string;
  endings: string[];
}

/** The palette's word for each kind, under its name. */
const KIND_HINT: Record<BlockKind, string> = {
  work: 'a step someone does', check: 'a yes or no', person: 'a person decides', fork: 'split into parallel work', join: 'wait for all of it', timer: 'starts on a count or clock', flow: 'another flow, its end the outcome', wait: 'waits on CI, a queue, others',
};
/** The Runs as choices (#322), in the panel's words. */
const RUNS_LABEL: Record<Runs, string> = { manager: 'the manager', person: 'a person', 'new-session': 'a new session', continue: "an earlier block's session" };
const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
const DRAG_TYPE = 'application/x-ledung-block';
/** An outcome's place when it ends the flow (#447), in its select. */
const END = '(end)';
/** What the palette's frame (#446) is dragged as, beside the block kinds. */
const FRAME_DRAG = 'frame';
/** A frame's node id on the canvas, apart from the blocks' keys. */
const frameId = (key: string) => `frame:${key}`;

/** The block a problem is about ("blocks.code-review.outcomes" → "code-review"). */
const problemBlock = (p: FlowProblem) => /^blocks\.([a-z0-9][a-z0-9-]*)/.exec(p.at)?.[1] ?? null;

export function FlowBuilder({ project, view, initial, shown, onShowFlow, onRenamedFlow, profiles, narrow, onCancel, onSaved }: {
  project: string; view: FlowView; initial: Workspace; profiles: string[]; narrow: boolean;
  /** The flow shown, by name, from the address (#447): switching is a history step, a rename replaces it. */
  shown: string; onShowFlow: (name: string) => void; onRenamedFlow: (name: string) => void;
  onCancel: () => void; onSaved: (view: FlowView, files: number, shown: string) => void;
}) {
  const [h, setH] = useState<History>({ past: [], present: initial, future: [], group: null });
  const ws = h.present;
  // The flow being edited (#447), by its key; one undo took away shows the default one.
  const [current, setCurrent] = useState(() => initial.flows.find((f) => f.name === shown)?.key ?? initial.flows[0]!.key);
  const entry = ws.flows.find((f) => f.key === current) ?? ws.flows[0]!;
  const draft = entry.draft;
  /** A change, one undo step; typing in one field (`group`) is one step until something else changes. */
  const commitWs = (next: Workspace, group?: string) => setH((s) => {
    if (next === s.present) return s;
    if (group && group === s.group) return { ...s, present: next };
    return { past: [...s.past, s.present].slice(-200), present: next, future: [], group: group ?? null };
  });
  /** A change to the flow being edited; its texts and rules are every flow's. */
  const commit = (next: Draft, group?: string) => commitWs(withDraft(ws, entry.key, next), group && `${entry.key}:${group}`);
  const undo = () => setH((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1]!, future: [s.present, ...s.future], group: null } : s));
  const redo = () => setH((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0]!, future: s.future.slice(1), group: null } : s));
  const [selection, setSelection] = useState<Selection>(null);
  // A flow undo or redo took away: the default one is shown, with nothing chosen, as block keys are per flow (review of #447).
  useEffect(() => {
    if (!ws.flows.some((f) => f.key === current)) {
      setCurrent(ws.flows[0]!.key);
      setSelection(null);
    }
  }, [ws, current]);
  const [confirm, setConfirm] = useState<'save' | 'leave' | 'fork' | null>(null);
  // ledung#110: the person agreed that this save gives the project its own copy of the shared flow.
  const [forkAgreed, setForkAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(true);
  const byFlow = useMemo(() => workspaceProblems(ws, profiles), [ws, profiles]);
  const all = byFlow.get(entry.key) ?? [];
  // Hints (#1184) are shown apart and don't ask before saving.
  const problems = useMemo(() => all.filter((p) => !p.hint), [all]);
  const hints = useMemo(() => all.filter((p) => p.hint), [all]);
  const allProblems = useMemo(() => [...byFlow.values()].reduce((n, ps) => n + ps.filter((p) => !p.hint).length, 0), [byFlow]);
  const writes = useMemo(() => workspaceWrites(ws), [ws]);
  const cantSave = useMemo(() => workspaceBlocksSaving(ws), [ws]);
  const dirty = writes.length > 0;
  // What a Run flow block may run (#447): the other flows, and how each can end.
  const choices = useMemo<FlowChoice[]>(() => ws.flows.map((f) => ({ name: f.name, title: f.draft.title ?? f.name, endings: f.draft.blocks.length ? flowEndings(flowOf(f.draft)) : [] })), [ws]);
  // Another flow is shown through the address (#447), a history step, so Back returns to the one before.
  const showFlow = (name: string) => {
    setSelection(null);
    if (name !== entry.name) onShowFlow(name);
  };
  const openFlow = (name: string) => {
    if (ws.flows.some((x) => x.name === name)) showFlow(name);
  };
  // The move off the page the builder holds while it asks, to make if the changes are discarded (#447).
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const wsRef = useRef(ws);
  wsRef.current = ws;
  // The address names another flow (a tab, Back, Forward): show it; a name no flow has shows the default one.
  useEffect(() => {
    const key = wsRef.current.flows.find((f) => f.name === shown)?.key ?? wsRef.current.flows[0]!.key;
    setCurrent((was) => {
      if (was !== key) setSelection(null);
      return key;
    });
    // A leave held back is asked about where it was held: going on from another flow, its Back would go elsewhere.
    setLeaving(null);
    setConfirm((c) => (c === 'leave' ? null : c));
  }, [shown]);
  // The flow shown renamed (its panel, or its title while its name follows it): its entry follows, so Back still finds it.
  const named = useRef({ key: entry.key, name: entry.name });
  // A name that follows a title being typed changes at each key: the address follows once typing stops (review of
  // #447: Safari allows 100 history changes in 30 seconds).
  useEffect(() => {
    if (named.current.key !== entry.key) {
      named.current = { key: entry.key, name: entry.name };
      return;
    }
    if (named.current.name === entry.name) return;
    const was = named.current.name;
    const timer = setTimeout(() => {
      if (shown === was) onRenamedFlow(entry.name);
      named.current = { key: entry.key, name: entry.name };
    }, 400);
    return () => clearTimeout(timer);
  }, [entry.key, entry.name, shown]);
  // Unsaved changes: leaving the workflow page (Back, the sidebar) asks first, as Cancel does (#447).
  useEffect(() => {
    if (!dirty) return;
    setLeaveGuard({ project, ask: (proceed) => { setLeaving(() => proceed); setConfirm('leave'); } });
    return () => setLeaveGuard(null);
  }, [dirty, project]);

  const selectedBlock = selection?.kind === 'block' ? draft.blocks.find((b) => b.key === selection.key) ?? null : null;
  const selectedManager = selection?.kind === 'manager' && draft.manager !== undefined;
  const selectedOverlay = selection?.kind === 'overlay' ? draft.overlays.find((o) => o.key === selection.key) ?? null : null;
  const selectedFrame = selection?.kind === 'frame' ? draft.frames.find((f) => f.key === selection.key) ?? null : null;
  // What undo took away is selected no more (review of #311, finding 8).
  useEffect(() => {
    if (selection && !selectedBlock && !selectedManager && !selectedOverlay && !selectedFrame) setSelection(null);
  }, [selection, selectedBlock, selectedManager, selectedOverlay, selectedFrame]);

  const removeSelected = () => {
    if (narrow) return;
    if (selectedBlock) commit(deleteBlocks(draft, [selectedBlock.key]));
    else if (selectedFrame) commit(deleteFrame(draft, selectedFrame.key));
    else return;
    setSelection(null);
  };
  /** A new frame (#446): round the chosen block, else where it is dropped, else below everything; its title next. */
  const newFrame = (at?: { x: number; y: number }) => {
    // Below the blocks where they are drawn: a flow the page laid out has no positions of its own yet (review of #446).
    const drawn = pinned(draft).blocks.map((b) => ({ ...b.block.at!, height: blockSize(b.block).height }));
    const below = { x: Math.min(0, ...drawn.map((b) => b.x)), y: Math.max(0, ...drawn.map((b) => b.y + b.height)) + 60 };
    const made = addFrame(draft, 'New frame', at ? { at } : selectedBlock ? { blocks: [selectedBlock.key] } : { at: below });
    if (typeof made === 'string') return;
    commit(made.draft);
    setSelection({ kind: 'frame', key: made.key });
  };

  // Undo, redo and delete from the keyboard, except while typing in a field.
  const keys = useRef({ undo, redo, removeSelected });
  keys.current = { undo, redo, removeSelected: () => !confirm && removeSelected() };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]'))) return;
      // Delete only from the canvas or the page itself, not a focused button (review of #311, finding 7).
      const onCanvas = !t || t === document.body || !!t.closest('.react-flow');
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) keys.current.redo();
        else keys.current.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        keys.current.redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && onCanvas) {
        keys.current.removeSelected();
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  // Changes not saved are not lost to a closed tab without a word.
  useEffect(() => {
    if (!dirty) return;
    const on = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', on);
    return () => window.removeEventListener('beforeunload', on);
  }, [dirty]);

  const save = async (anyway: boolean, agreed = forkAgreed) => {
    setError(null);
    // ledung#110: the first save of a shared workflow's flow forks the project off it, so it asks first.
    if (ws.flows.some((f) => f.base.copy) && !agreed) {
      setConfirm('fork');
      return;
    }
    if (cantSave) {
      const empty = ws.flows.find((f) => !f.draft.blocks.length);
      setError(empty
        ? `A flow needs at least one block before it can be saved ("${empty.draft.title ?? empty.name}").`
        : "A flow would not be a flow, so it can't be saved: fix the problems marked as the file's own (an empty title or word, an id that isn't lower case) in the flow whose tab has them.");
      return;
    }
    if (allProblems && !anyway) {
      setConfirm('save');
      return;
    }
    setConfirm(null);
    setSaving(true);
    try {
      onSaved(await api.saveFlow(project, writes), writes.length, entry.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  /** Cancel: the address names the flow shown as it was read, or the default one for a flow made here (review of #447). */
  const cancel = () => {
    const read = initial.flows.find((f) => f.key === entry.key)?.name ?? DEFAULT_FLOW;
    if (read !== shown) onRenamedFlow(read);
    onCancel();
  };
  const leave = () => (dirty ? setConfirm('leave') : cancel());

  const where = view.saveTo ?? '';
  const ownFolder = (
    <div className="muted flow-where">
      Saves into this project's own folder, <code>{where}</code>; never into a shared workflow's folder.
      {entry.base.copy && view.source?.workflow && <> This flow is the shared workflow "{view.source.workflow}"'s: saving makes a copy of it, with its other flows, briefs and rules, that counts for {project} from then on; the shared one is not changed.</>}
    </div>
  );

  const problemList = problems.length > 0 && (
    <div className="flow-problems" role="status">
      <button className="link" onClick={() => setShowProblems((v) => !v)} aria-expanded={showProblems}>
        <strong>{problems.length === 1 ? 'One problem' : `${problems.length} problems`} so far</strong> {showProblems ? '▾' : '▸'}
      </button>
      {showProblems && (
        <ul>{problems.map((p, i) => {
          const id = problemBlock(p);
          const b = id ? draft.blocks.find((x) => x.block.id === id) : undefined;
          return <li key={i}>{b ? <button className="link" onClick={() => setSelection({ kind: 'block', key: b.key })}><code>{p.at}</code></button> : <code>{p.at}</code>} {p.message}</li>;
        })}</ul>
      )}
    </div>
  );
  const hintList = hints.length > 0 && (
    <details className="flow-hints">
      <summary>{hints.length === 1 ? 'One hint' : `${hints.length} hints`}</summary>
      <ul>{hints.map((p, i) => {
        const id = problemBlock(p);
        const b = id ? draft.blocks.find((x) => x.block.id === id) : undefined;
        return <li key={i}>{b ? <button className="link" onClick={() => setSelection({ kind: 'block', key: b.key })}><code>{p.at}</code></button> : <code>{p.at}</code>} {p.message}</li>;
      })}</ul>
    </details>
  );

  const close = () => setSelection(null);
  const panel = selectedBlock
    ? <BlockFields key={`${entry.key}:${selectedBlock.key}`} draft={draft} entry={selectedBlock} focus={selection?.outcome} naming={selection?.naming} profiles={profiles} narrow={narrow} commit={commit} onDelete={removeSelected} onClose={close} onSelect={setSelection} choices={choices.filter((c) => c.name !== entry.name)} onOpenFlow={openFlow} />
    : selectedManager
        ? <ManagerFields draft={draft} narrow={narrow} commit={commit} onClose={close} onSelect={setSelection} />
        : selectedOverlay
          ? <OverlayFields draft={draft} overlayKey={selectedOverlay.key} narrow={narrow} commit={commit} onClose={close} />
          : selectedFrame
            ? <FrameFields key={selectedFrame.key} draft={draft} frameKey={selectedFrame.key} narrow={narrow} commit={commit} onClose={close} onSelect={setSelection} />
            : <FlowFields key={entry.key} draft={draft} commit={commit} narrow={narrow} onSelect={setSelection} ws={ws} flow={entry} commitWs={commitWs} onDeleted={() => { setSelection(null); onRenamedFlow(DEFAULT_FLOW); }} />;

  return (
    <div className={`page-view workflow-view flow-builder${narrow ? ' narrow' : ''}`}>
      <header className="session-head">
        <div className="session-head-text"><h2>{project}: editing the workflow{draft.title ? ` · ${draft.title}` : ''}</h2>{ownFolder}</div>
        <div className="session-corner flow-tools">
          <button className="small" onClick={undo} disabled={!h.past.length} title="Undo (Ctrl+Z)">↶ Undo</button>
          <button className="small" onClick={redo} disabled={!h.future.length} title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
          {!narrow && <button className="small" onClick={() => commit(arrange(draft))} disabled={!draft.blocks.length} title="Lay the blocks out top to bottom">Auto-arrange</button>}
          {!narrow && <button className="small" onClick={removeSelected} disabled={!selectedBlock && !selectedFrame} title="Delete the selected block or frame (Delete); an arrow is an outcome, taken out in its block's panel">Delete</button>}
          <span className={`flow-check-count${allProblems ? ' bad' : ''}`} title={ws.flows.length > 1 ? 'In all the flows' : undefined}>{allProblems ? `⚠ ${allProblems}` : '✓ No problems'}</span>
          <button className="small primary" onClick={() => save(false)} disabled={saving || !dirty} title={dirty ? 'Write the files into the project folder' : 'Nothing has changed'}>{saving ? 'Saving…' : 'Save'}</button>
          <button className="small" onClick={leave} disabled={saving}>Cancel</button>
        </div>
      </header>
      {confirm === 'save' && (
        <div className="flow-confirm" role="alertdialog">
          <span>The workflow has {allProblems === 1 ? 'a problem' : `${allProblems} problems`} ({ws.flows.length > 1 ? 'each listed under its flow\'s tab' : 'listed below'}). Save it as a draft anyway? It is saved as it is, and the problems show on the workflow page until they are fixed.</span>
          <span className="flow-confirm-buttons"><button className="small primary" onClick={() => save(true)}>Save anyway</button><button className="small" onClick={() => setConfirm(null)}>Keep editing</button></span>
        </div>
      )}
      {confirm === 'fork' && (
        <div className="flow-confirm" role="alertdialog">
          <span>{project} follows the shared workflow "{view.source?.workflow}". Saving gives {project} its own copy of it in {where}: from then on {project} follows that copy and no longer gets changes made to "{view.source?.workflow}". The workflow page offers "Back to shared" later. Save a copy?</span>
          <span className="flow-confirm-buttons"><button className="small primary" onClick={() => { setForkAgreed(true); void save(false, true); }}>Save a copy</button><button className="small" onClick={() => setConfirm(null)}>Keep editing</button></span>
        </div>
      )}
      {confirm === 'leave' && (
        <div className="flow-confirm" role="alertdialog">
          <span>Leave without saving? The changes made here are lost.</span>
          <span className="flow-confirm-buttons"><button className="small deny" onClick={() => (leaving ? leaving() : cancel())}>Discard changes</button><button className="small" onClick={() => { setConfirm(null); setLeaving(null); }}>Keep editing</button></span>
        </div>
      )}
      {error && <div className="flow-confirm flow-error" role="alert"><span>{error}</span><span className="flow-confirm-buttons"><button className="small" onClick={() => setError(null)}>OK</button></span></div>}
      <FlowTabs
        flows={ws.flows.map((f) => ({ name: f.key, title: f.draft.title || f.name, bad: (byFlow.get(f.key) ?? []).filter((p) => !p.hint).length }))}
        shown={entry.key} onShow={(key) => showFlow(ws.flows.find((f) => f.key === key)?.name ?? entry.name)}
      >
        {!narrow && <NewFlow onAdd={(title) => {
          const made = addFlow(ws, title);
          if (typeof made === 'string') return made;
          commitWs(made.ws);
          showFlow(made.ws.flows.find((f) => f.key === made.key)!.name);
          return null;
        }} />}
      </FlowTabs>
      {problemList}
      {hintList}
      {narrow ? (
        <div className="flow-main">
          {selection
            ? <aside className="flow-panel">{panel}</aside>
            : (
              <>
                <BlockChooser draft={draft} problems={problems} choices={choices} onSelect={(key) => setSelection({ kind: 'block', key })} />
                <aside className="flow-panel">{panel}</aside>
              </>
            )}
        </div>
      ) : (
        <div className="flow-main flow-main-edit">
          <Palette onAdd={(kind, at) => {
            // A new Run flow block runs the first other flow (#447).
            const made = addBlock(draft, kind, at, choices.find((c) => c.name !== entry.name)?.name);
            commit(made.draft);
            setSelection({ kind: 'block', key: made.key });
          }} onFrame={() => newFrame()} />
          <ReactFlowProvider>
            <Canvas key={entry.key} draft={draft} selection={selection} problems={problems} commit={commit} onSelect={setSelection} onFrame={newFrame} choices={choices} />
          </ReactFlowProvider>
          <aside className="flow-panel">{panel}</aside>
        </div>
      )}
    </div>
  );
}

/** The kinds to drag onto the canvas, or click to add one below the rest; and a comment frame (#446). */
function Palette({ onAdd, onFrame }: { onAdd: (kind: BlockKind, at?: { x: number; y: number }) => void; onFrame: () => void }) {
  return (
    <div className="flow-palette" aria-label="Blocks">
      <div className="muted flow-palette-head">Drag onto the canvas</div>
      {PALETTE.map((kind) => (
        <button
          key={kind} className={`flow-palette-item kind-${kind}`} draggable
          onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, kind); e.dataTransfer.effectAllowed = 'copy'; }}
          onClick={() => onAdd(kind)} title={`Add a ${KIND_LABEL[kind].toLowerCase()} block (or drag it where it goes)`}
        >
          <span className="flow-kind">{KIND_LABEL[kind]}</span>
          <span className="flow-palette-hint">{KIND_HINT[kind]}</span>
        </button>
      ))}
      <button
        className="flow-palette-item flow-palette-frame" draggable
        onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, FRAME_DRAG); e.dataTransfer.effectAllowed = 'copy'; }}
        onClick={onFrame} title="Add a comment frame round the chosen block (or drag it where it goes)"
      >
        <span className="flow-kind">Frame</span>
        <span className="flow-palette-hint">a titled group of blocks</span>
      </button>
      <div className="muted flow-palette-help">
        Each <strong>outcome</strong> is a pin on its block's right edge: drag the pin to the block it leads to. <strong>+ outcome</strong> on a block names a new one. Dragging a block's <strong>bottom</strong> dot to another block adds one too, and the panel asks for its word. A count ("× 3": where the 3rd one goes) is set in the panel.
      </div>
    </div>
  );
}

/**
 * The canvas: blocks where they are put, arrows from their outcomes' pins, comment frames behind (#446); drop a kind
 * to add it, drag a pin or the bottom dot to connect, drag a frame's title to move it with its blocks.
 */
function Canvas({ draft, selection, problems, commit, onSelect, onFrame, choices }: {
  draft: Draft; selection: Selection; problems: FlowProblem[]; commit: (next: Draft, group?: string) => void; onSelect: (s: Selection) => void;
  onFrame: (at: { x: number; y: number }) => void; choices: FlowChoice[];
}) {
  const flowTitle = (name: string) => choices.find((c) => c.name === name)?.title;
  const flow = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<Record<string, { x: number; y: number }>>({});
  // A frame being resized (#446), and the one being dragged with the blocks it held when the drag began.
  const [resizing, setResizing] = useState<Record<string, { x: number; y: number; width: number; height: number }>>({});
  const frameDrag = useRef<{ key: string; held: { blocks: string[]; frames: string[] }; from: { x: number; y: number }; starts: Record<string, { x: number; y: number }> } | null>(null);
  const [sizes, onMeasured] = useMeasured();
  const layout = useMemo(() => (draft.blocks.length ? layoutFlow(flowOf(draft)) : null), [draft]);
  const bad = useMemo(() => new Set(problems.map(problemBlock).filter((x): x is string => !!x)), [problems]);
  const start = draft.start ?? draft.blocks[0]?.block.id;
  // Each block's overlays as a badge, and those the overlay being edited amends marked (#318).
  const amended = useMemo(() => amendedBy(draft.overlays.map((o) => o.overlay)), [draft.overlays]);
  const editedOverlay = selection?.kind === 'overlay' ? draft.overlays.find((o) => o.key === selection.key)?.overlay : undefined;

  const placed = new Map(layout?.blocks.map((p) => [p.block, p]) ?? []);
  // Arrows use ids; the canvas uses keys, which stay while an id is typed. A second block with the same id (a
  // problem the checks name) gets no arrows.
  const keyOf = new Map<string, string>();
  for (const b of draft.blocks) if (!keyOf.has(b.block.id)) keyOf.set(b.block.id, b.key);
  const idOf = new Map(draft.blocks.map((b) => [b.key, b.block.id]));
  const titleOf = (id: string) => draft.blocks.find((b) => b.block.id === id)?.block.title ?? id;

  const focusOf = (b: Draft['blocks'][number]) => (selection?.kind === 'block' && selection.key === b.key && selection.outcome !== undefined && selection.outcome < (b.block.outcomes?.length ?? 0) ? selection.outcome : undefined);
  const blockNodes: Node<BlockData>[] = draft.blocks.map((b, i) => {
    const p = placed.get(b.block);
    const focus = focusOf(b);
    return {
      id: b.key, type: 'block', ...(sizes[b.key] ? { measured: sizes[b.key] } : {}),
      position: dragging[b.key] ?? (p ? { x: p.x, y: p.y } : b.block.at ?? { x: 0, y: i * 120 }),
      data: {
        block: b.block, hasBrief: !!b.block.brief && draft.texts[b.block.brief] !== undefined, selected: selection?.kind === 'block' && selection.key === b.key, problem: bad.has(b.block.id), start: b.block.id === start, overlays: amended.get(b.block.id), marked: !!editedOverlay?.blocks.includes(b.block.id), ...(b.block.continues ? { continuesTitle: titleOf(b.block.continues) } : {}),
        ...(focus !== undefined ? { focusOutcome: focus } : {}),
        runsFlow: flowLine(b.block, flowTitle),
        // "+ outcome" (#446): its name is asked for in the panel, then its pin is drawn to a block.
        onAddOutcome: () => onSelect({ kind: 'block', key: b.key, naming: Date.now() }),
      },
    };
  });
  // Frames behind the blocks (#446); while one is dragged or resized, where it is now.
  const frameNodes = draft.frames.map((f) => frameNode(frameId(f.key), f.frame, {
    editable: true, selected: selection?.kind === 'frame' && selection.key === f.key,
    onResize: (p) => setResizing((r) => ({ ...r, [f.key]: p })),
    onResizeEnd: (p) => {
      commit(setFrame(draft, f.key, { at: { x: p.x, y: p.y }, size: { width: p.width, height: p.height } }));
      setResizing(({ [f.key]: _, ...rest }) => rest);
    },
  }, resizing[f.key] ?? dragging[frameId(f.key)]));
  const nodes: Node[] = [...frameNodes, ...blockNodes];

  // An outcome's arrow as the layout placed it: its kind (on the way, back, counted), by block and place.
  const placedOf = (from: string, index: number, to: string) => layout?.arrows.find((a) => a.kind !== 'continue' && a.from === from && a.index === index && a.to === to);
  const position = new Map(blockNodes.map((n) => [n.id, n.position]));
  const edge = (id: string, from: string, to: string, kind: PlacedKind, handles: [string, string, number?], text: string | null, chosen: boolean, route?: Point[] | null): Edge | null => {
    const source = keyOf.get(from);
    const target = keyOf.get(to);
    if (!source || !target) return null;
    const [sourceHandle, targetHandle, offset] = handles;
    return {
      id, source, target, sourceHandle, targetHandle,
      className: `flow-arrow arrow-${kind}${chosen ? ' chosen' : ''}`, interactionWidth: 18,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: chosen ? 'var(--accent)' : ARROW_COLOUR[kind] },
      ...(route && offset !== undefined ? { type: 'routed', data: { route, offset } } : { type: 'stepped', data: { text, ...(offset ? { offset } : {}) } }),
    };
  };
  const drawn = [
    // Each block's outcomes (#1184) from their own pins (#446), the one in focus marked; one not drawn to a block yet
    // has no arrow; a second block with an id already used draws none.
    ...draft.blocks.filter((b) => keyOf.get(b.block.id) === b.key).flatMap((b) => (b.block.outcomes ?? []).map((o, j) => {
      if (o.to === undefined) return null;
      const placed = o.to === b.block.id ? undefined : placedOf(b.block.id, j, o.to);
      const kind: PlacedKind = placed?.kind ?? (o.times ? 'counted' : 'way');
      const focus = focusOf(b);
      const chosen = selection?.kind === 'block' && selection.key === b.key && (focus === undefined || focus === j);
      return edge(`out:${b.key}:${j}`, b.block.id, o.to, kind, outcomeHandles(kind, j, b.block.outcomes!.length), null, chosen, placed?.route);
    })),
    // Its session goes on (#322): from the side of the block whose it is that faces the other; clicking it opens the
    // block that continues it.
    ...draft.blocks.flatMap((b) => {
      if (b.block.runs !== 'continue' || !b.block.continues || b.block.continues === b.block.id) return [];
      const from = keyOf.get(b.block.continues);
      return [edge(`continue:${b.key}`, b.block.continues, b.block.id, 'continue', continueHandles(from ? position.get(from) : undefined, position.get(b.key)), 'same session', selection?.kind === 'block' && selection.key === b.key)];
    }),
  ].filter((e): e is Edge => e !== null);
  // The arrows' words (a continued session's) clear of the others' and of the blocks and their pins (#1184, #446).
  const edges = withLabelSpots(nodes, drawn);

  /**
   * A frame's drag (#446): its blocks and the frames inside it, as it held them when the drag began, move with it;
   * dropped, one change.
   */
  const dragFrame = (key: string, at: { x: number; y: number } | undefined, done: boolean) => {
    const f = draft.frames.find((x) => x.key === key)?.frame;
    if (!f) return;
    if (!frameDrag.current || frameDrag.current.key !== key) {
      const held = { blocks: frameMembers(draft, f), frames: framesInside(draft, key) };
      const starts = {
        ...Object.fromEntries(held.blocks.map((m) => [m, position.get(m) ?? { x: 0, y: 0 }])),
        ...Object.fromEntries(held.frames.map((k) => [frameId(k), draft.frames.find((x) => x.key === k)!.frame.at])),
      };
      frameDrag.current = { key, held, from: f.at, starts };
    }
    const d = frameDrag.current;
    const to = at ?? dragging[frameId(key)];
    if (done) {
      if (to) commit(moveFrame(draft, key, to, d.held));
      frameDrag.current = null;
      setDragging((was) => Object.fromEntries(Object.entries(was).filter(([k]) => k !== frameId(key) && !(k in d.starts))));
      return;
    }
    if (!to) return;
    const dx = to.x - d.from.x;
    const dy = to.y - d.from.y;
    setDragging((was) => ({ ...was, [frameId(key)]: to, ...Object.fromEntries(Object.entries(d.starts).map(([k, p]) => [k, { x: p.x + dx, y: p.y + dy }])) }));
  };

  const onNodesChange = (given: NodeChange<Node>[]) => {
    const changes = onMeasured(given) as NodeChange<Node>[];
    for (const c of changes) {
      if (c.type !== 'position') continue;
      if (c.id.startsWith('frame:')) {
        // A resize moves its corner too, with no drag: that is the resizer's, given when it ends.
        if (c.dragging === true) dragFrame(c.id.slice(6), c.position, false);
        else if (c.dragging === false) dragFrame(c.id.slice(6), c.position, true);
        continue;
      }
      if (c.dragging && c.position) {
        const at = c.position;
        setDragging((d) => ({ ...d, [c.id]: at }));
      } else if (!c.dragging) {
        const at = c.position ?? dragging[c.id];
        if (at) commit(moveBlock(draft, c.id, at));
        setDragging((d) => {
          const { [c.id]: _, ...rest } = d;
          return rest;
        });
      }
    }
  };
  const onConnect = (c: Connection) => {
    const from = idOf.get(c.source);
    const to = idOf.get(c.target);
    if (!from || !to) return;
    // A pin drawn to a block: its outcome leads there (#446).
    const pin = /^o(\d+)$/.exec(c.sourceHandle ?? '');
    if (pin) {
      const index = Number(pin[1]);
      commit(wireOutcome(draft, c.source, index, to));
      onSelect({ kind: 'block', key: c.source, outcome: index });
      return;
    }
    // The bottom dot: a new outcome, its word asked for in the panel (#1184).
    const made = connect(draft, from, to);
    if (!made) return;
    commit(made.draft);
    onSelect({ kind: 'block', key: made.key, outcome: made.index });
  };
  const onDrop = (e: DragEvent) => {
    const kind = e.dataTransfer.getData(DRAG_TYPE) as BlockKind | typeof FRAME_DRAG;
    if (kind === FRAME_DRAG) {
      e.preventDefault();
      onFrame(flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      return;
    }
    if (!BLOCK_KINDS.includes(kind)) return;
    e.preventDefault();
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const made = addBlock(draft, kind, { x: p.x - BLOCK_WIDTH / 2, y: p.y - BLOCK_HEIGHT / 2 });
    commit(made.draft);
    onSelect({ kind: 'block', key: made.key });
  };

  // As on the workflow page, a flow too large to see fitted opens from its start, with a map (#318); decided once,
  // on opening, so drawing never moves the view. A lower least zoom than the page's: drawing wants more of the flow
  // in view, and the canvas is narrower between palette and panel.
  const opening = useOpeningView(box, [...blockNodes.map((n) => ({ ...n.position, ...blockSize(n.data.block) })), ...draft.frames.map((f) => ({ ...f.frame.at, ...f.frame.size }))], blockNodes.find((n) => n.data.start)?.position, { padding: 0.2, minZoom: 0.5 });
  return (
    <div className="flow-canvas" ref={box} onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={onDrop}>
      {!draft.blocks.length && <div className="flow-canvas-empty muted">Drag a block here from the left, or click one there.</div>}
      {opening && <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} minZoom={0.2} maxZoom={2}
        {...(opening.fit ? { fitView: true, fitViewOptions: { padding: 0.2 } } : { defaultViewport: opening })}
        nodesDraggable nodesConnectable elementsSelectable={false} edgesFocusable={false} deleteKeyCode={null} connectionRadius={40}
        isValidConnection={(c) => c.source !== c.target && !c.source.startsWith('frame:') && !c.target.startsWith('frame:')}
        onNodesChange={onNodesChange} onConnect={onConnect}
        onNodeClick={(_, n) => onSelect(n.type === 'frame' ? { kind: 'frame', key: n.id.slice(6) } : { kind: 'block', key: n.id })}
        onEdgeClick={(_, e) => {
          const [what, key, index] = e.id.split(':');
          onSelect({ kind: 'block', key: key!, ...(what === 'out' ? { outcome: Number(index) } : {}) });
        }}
        onPaneClick={() => onSelect(null)}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
        {!opening.fit && <FlowMiniMap />}
      </ReactFlow>}
    </div>
  );
}

/** On a phone: the blocks as a list to pick one from. */
function BlockChooser({ draft, problems, choices, onSelect }: { draft: Draft; problems: FlowProblem[]; choices: FlowChoice[]; onSelect: (key: string) => void }) {
  const bad = new Set(problems.map(problemBlock));
  const titleOf = (id: string) => draft.blocks.find((b) => b.block.id === id)?.block.title ?? id;
  const flowTitle = (name: string) => choices.find((c) => c.name === name)?.title;
  return (
    <ol className="flow-list">
      {draft.blocks.map((b) => (
        <li key={b.key}>
          <button className={`flow-list-item kind-${b.block.kind}${bad.has(b.block.id) ? ' has-problem' : ''}`} onClick={() => onSelect(b.key)}>
            <span className="flow-block-top"><span className="flow-kind">{KIND_LABEL[b.block.kind]}</span></span>
            <span className="flow-block-title">{b.block.title}</span>
            {actorLine(b.block, titleOf) && <span className="flow-block-actor">{actorLine(b.block, titleOf)}</span>}
            {flowLine(b.block, flowTitle) && <span className="flow-block-actor flow-block-runs">▸ {flowLine(b.block, flowTitle)}</span>}
            {!!b.block.substeps?.length && <span className="flow-list-substep">{b.block.substeps.length === 1 ? 'one sub-step' : `${b.block.substeps.length} sub-steps`}</span>}
          </button>
        </li>
      ))}
    </ol>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flow-field">
      <span className="flow-field-label">{label}</span>
      {children}
      {hint && <span className="muted flow-field-hint">{hint}</span>}
    </label>
  );
}

/** Words: an emptied optional field is taken out of the file. */
const optional = (v: string) => (v === '' ? undefined : v);

/** The selected block's fields, as the design's table has them. */
function BlockFields({ draft, entry, focus, naming, profiles, narrow, commit, onDelete, onClose, onSelect, choices, onOpenFlow }: {
  draft: Draft; entry: Draft['blocks'][number]; focus?: number; naming?: number; profiles: string[]; narrow: boolean;
  commit: (next: Draft, group?: string) => void; onDelete: () => void; onClose: () => void; onSelect: (s: Selection) => void;
  /** The flows a Run flow block may run (#447): the others. */
  choices: FlowChoice[]; onOpenFlow: (name: string) => void;
}) {
  const b = entry.block;
  const typing = usePlainTyping();
  const key = entry.key;
  const set = (patch: Partial<FlowBlock>, group?: string) => commit(setBlock(draft, key, patch), group && `${group}:${key}`);
  const others = draft.blocks.filter((x) => x.key !== key);
  const [id, setId] = useState(b.id);
  const [idProblem, setIdProblem] = useState<string | null>(null);
  useEffect(() => { setId(b.id); setIdProblem(null); }, [b.id, key]);
  const applyId = () => {
    if (id === b.id) return;
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) setIdProblem('Lower case letters, digits and "-" (at most 48), starting with a letter or digit.');
    else if (others.some((x) => x.block.id === id)) setIdProblem(`Another block is "${id}" already.`);
    else {
      setIdProblem(null);
      set({ id });
    }
  };
  const briefs = Object.keys(draft.texts).filter((f) => f.startsWith('briefs/')).sort();
  const [briefName, setBriefName] = useState('');
  const [briefProblem, setBriefProblem] = useState<string | null>(null);
  const briefText = b.brief ? draft.texts[b.brief] : undefined;
  const timerMode = b.timer && 'every' in b.timer ? 'every' : 'clock';
  const start = (draft.start ?? draft.blocks[0]?.block.id) === b.id;
  // What "continues" may name: the other blocks that run as a session; the checks say when one doesn't come first (#322).
  const sessions = others.filter((x) => runsSession(x.block));
  return (
    <div className="flow-panel-body flow-fields">
      <div className="flow-panel-head">
        <h3>{narrow ? <button className="link" onClick={onClose}>← All blocks</button> : KIND_LABEL[b.kind]}</h3>
        {!narrow && <button className="small" onClick={onClose} aria-label="Close the block">×</button>}
      </div>
      <Field label="Title"><input {...typing} value={b.title} onChange={(e) => set({ title: e.target.value }, 'title')} /></Field>
      <Field label="Id" hint={idProblem ?? (entry.autoId ? 'Follows the title until you change it. Arrows use it.' : 'Arrows use it; changing it changes them too.')}>
        <input {...typing} className="mono" value={id} onChange={(e) => setId(e.target.value)} onBlur={applyId} onKeyDown={(e) => e.key === 'Enter' && applyId()} aria-invalid={!!idProblem} />
      </Field>
      <Field label="Kind">
        <select value={b.kind} onChange={(e) => {
          const kind = e.target.value as BlockKind;
          // A person block is a person's, and a fork or join nobody's (#322); work leaving a person's hands goes to a session.
          const runs = kind === 'person' ? 'person' : kind === 'fork' || kind === 'join' || kind === 'flow' || kind === 'wait' ? undefined : b.kind === 'person' && b.runs === 'person' ? 'new-session' : b.runs;
          // A Run flow block (#447) is done by its flow: nobody here runs it, with no brief, model or sub-steps.
          const flowed = kind === 'flow' ? { flow: b.flow ?? choices[0]?.name, model: undefined, profile: undefined, brief: undefined, substeps: undefined, parallel: undefined } : { flow: undefined, session: undefined };
          // A wait (part 3d) waits on something outside: nobody here runs it or starts subagents.
          const waited = kind === 'wait' ? { model: undefined, profile: undefined, substeps: undefined, parallel: undefined } : {};
          set({ kind, runs, ...(runs === 'continue' ? {} : { continues: undefined, context: undefined }), ...(kind === 'person' ? { ask: b.ask ?? 'question' } : { ask: undefined }), ...(kind === 'timer' ? { timer: b.timer ?? { clock: 'daily' } } : { timer: undefined }), ...(kind === 'person' ? {} : { person: undefined }), ...flowed, ...waited });
        }}>
          {BLOCK_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </Field>
      {b.kind === 'person' && (
        <Field label="Asks with">
          <select value={b.ask ?? ''} onChange={(e) => set({ ask: (optional(e.target.value) as FlowBlock['ask']) })}>
            <option value="">(not said)</option>
            <option value="question">a question (ask_user)</option>
            <option value="review">a review page</option>
          </select>
        </Field>
      )}
      {b.kind === 'person' && (
        <Field label="Whose call" hint="Who decides, e.g. the owner or a code owner. Ledung still asks you; it tells you whose decision you make.">
          <input {...typing} value={b.person ?? ''} placeholder="(yours)" maxLength={80} onChange={(e) => set({ person: optional(e.target.value) }, 'person')} />
        </Field>
      )}
      {b.kind === 'wait' && <span className="muted flow-field-hint">The work waits here on something outside the flow (a merge queue, CI, someone else's approval) until the manager reports how it came out; the workflow page shows how long. The brief may say what it waits for.</span>}
      {b.kind === 'timer' && (
        <div className="flow-field-row">
          <Field label="Starts">
            <select value={timerMode} onChange={(e) => set({ timer: e.target.value === 'every' ? { every: 30, of: 'merges' } : { clock: 'daily' } })}>
              <option value="clock">on the clock</option>
              <option value="every">after a count</option>
            </select>
          </Field>
          {b.timer && 'clock' in b.timer && (
            <Field label="Every">
              <select value={b.timer.clock} onChange={(e) => set({ timer: { clock: e.target.value as 'hourly' | 'daily' | 'weekly' } })}>
                {['hourly', 'daily', 'weekly'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
          )}
          {b.timer && 'every' in b.timer && (
            <>
              <Field label="Every"><input type="number" min={1} max={100000} value={b.timer.every} onChange={(e) => set({ timer: { every: Math.min(100000, Math.max(1, Math.floor(Number(e.target.value) || 1))), of: (b.timer as { of: string }).of } }, 'every')} /></Field>
              <Field label="Of"><input {...typing} value={b.timer.of} onChange={(e) => set({ timer: { every: (b.timer as { every: number }).every, of: e.target.value } }, 'of')} /></Field>
            </>
          )}
        </div>
      )}
      {b.kind === 'flow' && <RunFlowFields draft={draft} entry={entry} choices={choices} commit={commit} onOpenFlow={onOpenFlow} />}
      {b.kind !== 'fork' && b.kind !== 'join' && b.kind !== 'flow' && b.kind !== 'wait' && (
        <div className="flow-field-row">
          <Field label="Runs as">
            <select value={b.runs ?? ''} disabled={b.kind === 'person'} onChange={(e) => {
              const runs = optional(e.target.value) as Runs | undefined;
              set({ runs, continues: runs === 'continue' ? b.continues ?? sessions[0]?.block.id : undefined });
            }}>
              <option value="">(not said)</option>
              {(Object.keys(RUNS_LABEL) as Runs[]).map((r) => <option key={r} value={r}>{RUNS_LABEL[r]}</option>)}
            </select>
          </Field>
          {b.runs === 'continue' && (
            <Field label="Whose">
              <select value={b.continues ?? ''} onChange={(e) => set({ continues: optional(e.target.value) })}>
                <option value="">(not said)</option>
                {sessions.map((x) => <option key={x.key} value={x.block.id}>{x.block.title}</option>)}
                {b.continues && !sessions.some((x) => x.block.id === b.continues) && <option value={b.continues}>{b.continues} (not a session)</option>}
              </select>
            </Field>
          )}
        </div>
      )}
      {b.kind !== 'fork' && b.kind !== 'join' && b.kind !== 'flow' && b.kind !== 'wait' && <span className="muted flow-field-hint">{b.runs === 'continue' ? 'The session that did that block takes this step too: it knows the work.' : 'Who does this step; its brief says how.'}</span>}
      {b.kind !== 'flow' && b.kind !== 'wait' && <div className="flow-field-row">
        <Field label="Model">
          <input {...typing} list="flow-models" value={b.model ?? ''} onChange={(e) => set({ model: optional(e.target.value) }, 'model')} />
        </Field>
        <datalist id="flow-models">{MODELS.map((m) => <option key={m} value={m} />)}</datalist>
        <Field label="Profile">
          <select value={b.profile ?? ''} onChange={(e) => set({ profile: optional(e.target.value) })}>
            <option value="">(none)</option>
            {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
            {b.profile && !profiles.includes(b.profile) && <option value={b.profile}>{b.profile} (not available here)</option>}
          </select>
        </Field>
      </div>}
      <div className="flow-field-row">
        <Field label="Runs at once" hint="In this block; more wait before it, in line. Empty: no limit.">
          <input type="number" min={1} max={100} value={b.limit ?? ''} placeholder="no limit" onChange={(e) => set({ limit: e.target.value ? Math.min(100, Math.max(1, Math.floor(Number(e.target.value)))) : undefined }, 'limit')} />
        </Field>
        {b.runs === 'continue' && (
          <Field label="Its session first">
            <select value={b.context ?? ''} onChange={(e) => set({ context: optional(e.target.value) as FlowBlock['context'] })}>
              <option value="">as it is</option>
              <option value="compact">compacted</option>
              <option value="clear">cleared (the step is its handoff)</option>
            </select>
          </Field>
        )}
      </div>
      <Outcomes draft={draft} entry={entry} focus={focus} naming={naming} commit={commit} onFocus={(outcome) => onSelect({ kind: 'block', key, ...(outcome === undefined ? {} : { outcome }) })} />
      {b.kind !== 'flow' && <fieldset className="flow-fieldset">
        <legend>Brief</legend>
        <Field label="File">
          <select value={b.brief ?? ''} onChange={(e) => set({ brief: optional(e.target.value) })}>
            <option value="">(no brief)</option>
            {briefs.map((f) => <option key={f} value={f}>{f}</option>)}
            {b.brief && !briefs.includes(b.brief) && <option value={b.brief}>{b.brief}{briefText === undefined ? ' (missing)' : ''}</option>}
          </select>
        </Field>
        <div className="flow-field-row flow-new-brief">
          <input {...typing} placeholder="new-brief-name" value={briefName} onChange={(e) => { setBriefName(e.target.value); setBriefProblem(null); }} aria-label="A new brief's name" />
          <button className="small" onClick={() => {
            const made = newBrief(draft, key, briefName || b.id);
            if (typeof made === 'string') setBriefProblem(made);
            else {
              commit(made);
              setBriefName('');
            }
          }}>New brief</button>
        </div>
        {briefProblem && <p className="flow-problem-inline">{briefProblem}</p>}
        {b.brief && briefText !== undefined && (
          <Field label={`Its text (${b.brief})`} hint={WRITABLE_FLOW_FILE.test(b.brief) ? 'Markdown: what counts as done here, what to look for.' : 'In a sub-folder: the builder edits briefs in briefs/ only.'}>
            <textarea {...typing} className="mono" rows={narrow ? 8 : 12} value={briefText} readOnly={!WRITABLE_FLOW_FILE.test(b.brief)}
              onChange={(e) => commit({ ...draft, texts: { ...draft.texts, [b.brief!]: e.target.value } }, `brief:${b.brief}`)} />
          </Field>
        )}
      </fieldset>}
      {b.kind !== 'flow' && <Substeps draft={draft} entry={entry} narrow={narrow} commit={commit} />}
      <label className="flow-check"><input type="checkbox" checked={start} disabled={start && !draft.start} onChange={(e) => commit({ ...draft, start: e.target.checked ? b.id : undefined })} /> Work starts here{start && !draft.start ? ' (the first block, as no other is said)' : ''}</label>
      {!narrow && <button className="small" onClick={() => {
        const made = addFrame(draft, 'New frame', { blocks: [key] });
        if (typeof made === 'string') return;
        commit(made.draft);
        onSelect({ kind: 'frame', key: made.key });
      }} title="A titled, coloured frame round this block; drag its edges to take in more">Put a frame round it</button>}
      {!narrow && <button className="small deny flow-delete" onClick={onDelete}>Delete this block</button>}
    </div>
  );
}

/**
 * A Run flow block's own fields (#447): which flow it runs, opening that flow, and adding an outcome for each way that
 * flow ends that the block has none for yet.
 */
function RunFlowFields({ draft, entry, choices, commit, onOpenFlow }: { draft: Draft; entry: Draft['blocks'][number]; choices: FlowChoice[]; commit: (next: Draft, group?: string) => void; onOpenFlow: (name: string) => void }) {
  const b = entry.block;
  const runs = choices.find((c) => c.name === b.flow);
  const missing = runs ? runs.endings.filter((e) => !(b.outcomes ?? []).some((o) => o.word.trim().toLowerCase() === e.trim().toLowerCase())) : [];
  return (
    <fieldset className="flow-fieldset">
      <legend>Runs</legend>
      <Field label="The flow" hint="It starts that flow for a piece of work of its own and waits for it to end; the word it ends with is this block's outcome.">
        <select value={b.flow ?? ''} onChange={(e) => commit(setBlock(draft, entry.key, { flow: optional(e.target.value) }))}>
          {b.flow === undefined && <option value="">(none yet)</option>}
          {choices.map((c) => <option key={c.name} value={c.name}>{c.title}{c.name === DEFAULT_FLOW ? ' (the default flow)' : ''}</option>)}
          {b.flow !== undefined && !runs && <option value={b.flow}>{b.flow} (not a flow here)</option>}
        </select>
      </Field>
      {!choices.length && <span className="muted flow-field-hint">This project has no other flow yet: add one with "+ Flow" by the tabs.</span>}
      <label className="toggle">
        <input type="checkbox" checked={b.session === 'caller'} onChange={(e) => commit(setBlock(draft, entry.key, { session: e.target.checked ? 'caller' : undefined }))} />
        {' '}<span>Hands it the session before it <span className="muted">(its session steps continue that session instead of starting their own)</span></span>
      </label>
      {runs && <span className="muted flow-field-hint">{runs.endings.length ? `"${runs.title}" ends with ${runs.endings.map((e) => `"${e}"`).join(', ')}.` : `"${runs.title}" has no end yet: every block of it leads on.`}</span>}
      <div className="flow-field-row flow-new-brief">
        {runs && <button className="small" onClick={() => onOpenFlow(runs.name)}>Open "{runs.title}"</button>}
        {missing.length > 0 && <button className="small" onClick={() => commit(addEndings(draft, entry.key, missing))} title="An outcome for each, a pin to draw to where the work goes then">Add its endings ({missing.length})</button>}
      </div>
    </fieldset>
  );
}

/** A new flow's title, by the tabs (#447). */
function NewFlow({ onAdd }: { onAdd: (title: string) => string | null }) {
  const typing = usePlainTyping();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  if (!open) return <span className="flow-tab-add"><button className="small" onClick={() => setOpen(true)} title="Add another flow: its own diagram, sharing the briefs and rules">+ Flow</button></span>;
  const add = () => {
    const p = onAdd(title);
    setProblem(p);
    if (!p) {
      setTitle('');
      setOpen(false);
    }
  };
  return (
    <span className="flow-tab-add">
      <input {...typing} autoFocus placeholder="Its title, e.g. Asset" value={title} onChange={(e) => { setTitle(e.target.value); setProblem(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') add(); else if (e.key === 'Escape') setOpen(false); }} aria-label="A new flow's title" aria-invalid={!!problem} title={problem ?? undefined} />
      <button className="small primary" onClick={add}>Add</button>
      <button className="small" onClick={() => { setOpen(false); setProblem(null); }} aria-label="Don't add a flow">×</button>
    </span>
  );
}

const WHEN_LABEL: Record<(typeof SUBSTEP_WHEN)[number], string> = { done: "when the block's work is done", start: 'as the block starts', brief: 'where the brief says' };

/** An outcome with its count set, or taken out. */
function withTimes<T extends { times?: number }>(o: T, times: number | undefined): T {
  const { times: _, ...rest } = o;
  return (times === undefined ? rest : { ...rest, times }) as T;
}

/** The small optional "× N" of an outcome: on which occurrence of its word it is taken (#1184). */
function TimesInput({ times, onChange }: { times?: number; onChange: (times: number | undefined) => void }) {
  return (
    <label className="flow-outcome-times" title="On which time of this word it is taken instead (empty: every other time)">
      <span className="muted">×</span>
      <input type="number" min={1} max={100} value={times ?? ''} placeholder="–" aria-label="Its count"
        onChange={(e) => onChange(e.target.value === '' ? undefined : Math.min(100, Math.max(1, Math.floor(Number(e.target.value)) || 1)))} />
    </label>
  );
}

/**
 * A block's outcomes (#1184): each a row, its word, an optional count ("× 3": the 3rd time of that word goes here
 * instead) and where it leads; each is a pin on the block (#446), drawn to the block it leads to. A person block's
 * are the answers it offers. A new one drawn on the canvas comes with its word field in focus; "+ outcome" names one,
 * here or on the block, whose pin is then drawn to a block (or its place picked here).
 */
function Outcomes({ draft, entry, focus, naming, commit, onFocus }: { draft: Draft; entry: Draft['blocks'][number]; focus?: number; naming?: number; commit: (next: Draft, group?: string) => void; onFocus: (outcome?: number) => void }) {
  const typing = usePlainTyping();
  const b = entry.block;
  const key = entry.key;
  const outs = b.outcomes ?? [];
  const keys = outcomeKeys(entry);
  const others = draft.blocks.filter((x) => x.key !== key);
  const focused = useRef<HTMLInputElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  useEffect(() => {
    focused.current?.focus();
    focused.current?.select();
  }, [focus]);
  useEffect(() => {
    if (naming) nameField.current?.focus();
  }, [naming]);
  const addNamed = () => {
    if (!name.trim()) return nameField.current?.focus();
    const made = addOutcome(draft, key, undefined, name);
    commit(made.draft);
    setName('');
    onFocus(undefined);
  };
  return (
    <fieldset className="flow-fieldset">
      <legend>{b.kind === 'person' ? 'Outcomes: the answers it offers' : 'Outcomes'}</legend>
      <span className="muted flow-field-hint">Where the work goes next, by its result. The manager reads the result against these words; Ledung counts each word for a piece of work, so a count ("× 3") sends the 3rd one elsewhere.</span>
      {outs.map((o, j) => (
        <div key={keys[j] ?? j} className="flow-outcome-row">
          <input {...typing} ref={j === focus ? focused : undefined} value={o.word} placeholder="its word, e.g. Approved" aria-label="The outcome's word" aria-invalid={!o.word.trim()}
            onChange={(e) => commit(setOutcome(draft, key, j, { word: e.target.value }), `out-word:${key}:${keys[j]}`)} />
          <TimesInput times={o.times} onChange={(times) => commit(setOutcome(draft, key, j, { times }), `out-times:${key}:${keys[j]}`)} />
          <select value={o.end ? END : o.to ?? ''} aria-label="Where it leads" aria-invalid={o.to === undefined && !o.end}
            onChange={(e) => commit(setOutcome(draft, key, j, e.target.value === END ? { to: undefined, end: true } : { to: optional(e.target.value), end: undefined }))}>
            {o.to === undefined && !o.end && <option value="">→ nowhere yet: drag its pin</option>}
            <option value={END}>■ ends the flow</option>
            {others.map((x) => <option key={x.key} value={x.block.id}>→ {x.block.title}</option>)}
            {o.to === b.id && <option value={o.to}>→ this block (round to itself)</option>}
            {o.to !== undefined && o.to !== b.id && !others.some((x) => x.block.id === o.to) && <option value={o.to}>→ {o.to} (not a block)</option>}
          </select>
          <button className="small deny" onClick={() => { commit(deleteOutcome(draft, key, j)); if (focus !== undefined) onFocus(undefined); }} aria-label={`Remove the outcome ${outcomeName(o)}`} title="Remove this outcome">×</button>
          {o.times && o.word.trim() && <span className="flow-outcome-name">Shown as "{outcomeName(o)}"</span>}
        </div>
      ))}
      <div className={`flow-field-row flow-new-brief${naming ? ' naming' : ''}`}>
        <input {...typing} ref={nameField} placeholder="Name a new one, e.g. Failed" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addNamed()} aria-label="A new outcome's word" />
        <button className="small" onClick={addNamed}>+ outcome</button>
      </div>
      <span className="muted flow-field-hint">{others.length ? 'A new outcome is a pin on the block\'s right edge: drag it to the block it leads to, or pick that above.' : 'Add another block to lead to.'}</span>
      {!outs.length && <span className="muted flow-field-hint">No outcomes: the work ends here{b.title.trim() ? `, and the flow ends with "${b.title}"` : ''}.</span>}
    </fieldset>
  );
}

/**
 * A block's sub-steps (#322): the subagents its one starts, in the order they run; each added, changed, moved and taken
 * out here. A person, a fork or a join starts none, so those get no Add.
 */
function Substeps({ draft, entry, narrow, commit }: { draft: Draft; entry: Draft['blocks'][number]; narrow: boolean; commit: (next: Draft, group?: string) => void }) {
  const typing = usePlainTyping();
  const b = entry.block;
  const key = entry.key;
  const subs = b.substeps ?? [];
  const [briefName, setBriefName] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<{ at: string; text: string } | null>(null);
  const set = (i: number, patch: Partial<FlowSubstep>, group?: string) => commit(setSubstep(draft, key, i, patch), group && `sub-${group}:${key}:${substepKeyOf(entry, i)}`);
  /** A sub-step's outcomes changed (#1185): none left takes the field out. */
  const setOuts = (i: number, outs: FlowSubstepOutcome[], group?: string) => set(i, { outcomes: outs.length ? outs : undefined }, group);
  const briefs = Object.keys(draft.texts).filter((f) => f.startsWith('briefs/')).sort();
  const canStart = b.kind !== 'person' && b.kind !== 'fork' && b.kind !== 'join' && b.kind !== 'wait' && b.runs !== 'person';
  return (
    <fieldset className="flow-fieldset">
      <legend>Sub-steps</legend>
      <span className="muted flow-field-hint">Subagents {b.runs === 'manager' ? 'the manager' : "this block's session"} starts, {b.parallel ? 'all at once' : 'in this order'}; each returns to it. The block's outcome counts once those that run when it is done have passed.</span>
      {(subs.length > 1 || b.parallel) && (
        <label className="toggle">
          <input type="checkbox" checked={!!b.parallel} onChange={(e) => commit(setBlock(draft, key, { parallel: e.target.checked ? true : undefined }))} />
          {' '}<span>Run them at once <span className="muted">(their results merged into one report, as four reviewers in parallel)</span></span>
        </label>
      )}
      {subs.map((s, i) => {
        const t = substepText(b, s);
        const text = s.brief ? draft.texts[s.brief] : undefined;
        const sk = substepKeyOf(entry, i);
        return (
          <div key={sk} className="flow-substep-edit">
            <div className="flow-substep-edit-head">
              <span className="flow-substep-edit-title">{i + 1}. {s.title}</span>
              <span className="flow-substep-edit-tools">
                <button className="small" onClick={() => commit(moveSubstep(draft, key, i, -1))} disabled={i === 0} aria-label={`Move ${s.title} earlier`} title="Earlier">↑</button>
                <button className="small" onClick={() => commit(moveSubstep(draft, key, i, 1))} disabled={i === subs.length - 1} aria-label={`Move ${s.title} later`} title="Later">↓</button>
                <button className="small deny" onClick={() => commit(deleteSubstep(draft, key, i))} aria-label={`Remove ${s.title}`} title="Remove this sub-step">×</button>
              </span>
            </div>
            <span className="muted flow-field-hint">{t.head} · {t.detail}</span>
            {t.note && <span className="flow-substep-note">{t.note}: a check of this block's own work, so its findings go back to whoever did it.</span>}
            <div className="flow-field-row">
              <Field label="Title"><input {...typing} value={s.title} onChange={(e) => set(i, { title: e.target.value }, 'title')} /></Field>
              <Field label="Kind">
                <select value={s.kind} onChange={(e) => set(i, { kind: e.target.value as FlowSubstep['kind'] })}>
                  <option value="check">check</option>
                  <option value="work">work</option>
                </select>
              </Field>
            </div>
            <Field label="Runs">
              <select value={s.when ?? 'done'} onChange={(e) => set(i, { when: e.target.value as FlowSubstep['when'] })}>
                {SUBSTEP_WHEN.map((w) => <option key={w} value={w}>{WHEN_LABEL[w]}</option>)}
              </select>
            </Field>
            <div className="flow-field-row">
              <Field label="Brief">
                <select value={s.brief ?? ''} onChange={(e) => set(i, { brief: optional(e.target.value) })}>
                  <option value="">(no brief)</option>
                  {briefs.map((f) => <option key={f} value={f}>{f}</option>)}
                  {s.brief && !briefs.includes(s.brief) && <option value={s.brief}>{s.brief}{text === undefined ? ' (missing)' : ''}</option>}
                </select>
              </Field>
              <Field label="Model"><input {...typing} list="flow-models" value={s.model ?? ''} onChange={(e) => set(i, { model: optional(e.target.value) }, 'model')} /></Field>
            </div>
            <div className="flow-field-row flow-new-brief">
              <input {...typing} placeholder="new-brief-name" value={briefName[sk] ?? ''} onChange={(e) => { setBriefName((n) => ({ ...n, [sk]: e.target.value })); setProblem(null); }} aria-label={`A new brief's name for ${s.title}`} />
              <button className="small" onClick={() => {
                const made = newSubstepBrief(draft, key, i, briefName[sk] || s.id);
                if (typeof made === 'string') setProblem({ at: sk, text: made });
                else {
                  commit(made);
                  setBriefName((n) => ({ ...n, [sk]: '' }));
                }
              }}>New brief</button>
            </div>
            {problem?.at === sk && <p className="flow-problem-inline">{problem.text}</p>}
            {s.brief && text !== undefined && WRITABLE_FLOW_FILE.test(s.brief) && (
              <details className="flow-substep-brief">
                <summary>Its brief's text ({s.brief}{draft.blocks.some((x) => x.block.brief === s.brief) ? ', also a block\'s' : ''})</summary>
                <textarea {...typing} className="mono" rows={narrow ? 6 : 8} value={text} onChange={(e) => commit({ ...draft, texts: { ...draft.texts, [s.brief!]: e.target.value } }, `brief:${s.brief}`)} />
              </details>
            )}
            <div className="flow-field-label">Outcomes</div>
            {(s.outcomes ?? []).map((o, j) => (
              <div key={j} className="flow-outcome-row">
                <input {...typing} value={o.word} placeholder="its word" aria-label="The outcome's word" onChange={(e) => setOuts(i, (s.outcomes ?? []).map((x, k) => (k === j ? { ...x, word: e.target.value } : x)), `out-word-${j}`)} />
                <TimesInput times={o.times} onChange={(times) => setOuts(i, (s.outcomes ?? []).map((x, k) => (k === j ? withTimes(x, times) : x)), `out-times-${j}`)} />
                <select value={o.to} aria-label="Where it leads" onChange={(e) => setOuts(i, (s.outcomes ?? []).map((x, k) => (k === j ? { ...x, to: e.target.value as SubstepTo } : x)))}>
                  {SUBSTEP_TO.map((t) => <option key={t} value={t}>{substepToText(b, t)}</option>)}
                </select>
                <button className="small deny" onClick={() => setOuts(i, (s.outcomes ?? []).filter((_, k) => k !== j))} aria-label={`Remove the outcome ${outcomeName(o)}`} title="Remove this outcome">×</button>
              </div>
            ))}
            <div><button className="small" onClick={() => setOuts(i, [...(s.outcomes ?? []), { word: '', to: 'owner' }])}>Add an outcome</button></div>
            <span className="muted flow-field-hint">"✗ … fixes" sends it back to this block's one, and the sub-step runs again; with a count ("× 3") the 3rd time goes elsewhere, to report or ask the manager.</span>
          </div>
        );
      })}
      {canStart
        ? <div className="flow-field-row flow-new-brief"><button className="small" onClick={() => commit(addSubstep(draft, key, 'check').draft)}>Add a check sub-step</button><button className="small" onClick={() => commit(addSubstep(draft, key, 'work').draft)}>Add a work sub-step</button></div>
        : <span className="muted flow-field-hint">{b.kind === 'fork' || b.kind === 'join' ? 'A fork or join starts no subagents.' : 'A person starts no subagents: sub-steps go in a block the manager or a session runs.'}</span>}
    </fieldset>
  );
}

/** A sub-step's React key: its draft key, so a moved one keeps its fields' state. */
const substepKeyOf = (entry: Draft['blocks'][number], i: number) => substepKeys(entry)[i] ?? `r${i}`;

/**
 * A comment frame (#446): its title and colour, the blocks it holds, fitting it round them, and taking it out. Moved by
 * its title on the canvas, with its blocks; resized by its edges.
 */
function FrameFields({ draft, frameKey, narrow, commit, onClose, onSelect }: {
  draft: Draft; frameKey: string; narrow: boolean; commit: (next: Draft, group?: string) => void; onClose: () => void; onSelect: (s: Selection) => void;
}) {
  const typing = usePlainTyping();
  const f = draft.frames.find((x) => x.key === frameKey)?.frame;
  const title = useRef<HTMLInputElement>(null);
  // A new frame comes with its title to give.
  useEffect(() => {
    if (f?.title === 'New frame') title.current?.select();
  }, [frameKey]);
  if (!f) return null;
  const members = frameMembers(draft, f);
  const fit = boxRound(draft, members);
  return (
    <div className="flow-panel-body flow-fields">
      <div className="flow-panel-head">
        <h3>{narrow ? <button className="link" onClick={onClose}>← The workflow</button> : 'Frame'}</h3>
        {!narrow && <button className="small" onClick={onClose} aria-label="Close the frame">×</button>}
      </div>
      <span className="muted flow-field-hint">A titled group drawn behind its blocks, for whoever reads the diagram; the flow and the manager pass it by.{narrow ? '' : ' Drag its title to move it with the blocks in it, its edges to resize it.'}</span>
      <Field label="Title"><input {...typing} ref={title} value={f.title} onChange={(e) => commit(setFrame(draft, frameKey, { title: e.target.value }), `frame-title:${frameKey}`)} aria-invalid={!f.title.trim()} /></Field>
      <fieldset className="flow-fieldset">
        <legend>Colour</legend>
        <div className="flow-swatches" role="radiogroup" aria-label="Its colour">
          <button className={`flow-swatch none${f.colour ? '' : ' on'}`} role="radio" aria-checked={!f.colour} onClick={() => commit(setFrame(draft, frameKey, { colour: undefined }))} title="No colour">∅</button>
          {(Object.keys(NAME_COLOURS) as NameColour[]).map((c) => (
            <button key={c} className={`flow-swatch named${f.colour === c ? ' on' : ''}`} role="radio" aria-checked={f.colour === c} style={frameColour({ ...f, colour: c })} onClick={() => commit(setFrame(draft, frameKey, { colour: c }))} title={NAME_COLOURS[c].label} aria-label={NAME_COLOURS[c].label} />
          ))}
        </div>
      </fieldset>
      <p className="muted">{members.length
        ? <>Holds {members.map((m, i) => {
          const b = draft.blocks.find((x) => x.key === m)!;
          return <span key={m}>{i ? ', ' : ''}<button className="link" onClick={() => onSelect({ kind: 'block', key: m })}>{b.block.title}</button></span>;
        })}.</>
        : 'Holds no block yet: move it over some, or resize it round them.'}</p>
      {!narrow && fit && <button className="small" onClick={() => commit(setFrame(draft, frameKey, fit))}>Fit it round its blocks</button>}
      <button className="small deny flow-delete" onClick={() => { commit(deleteFrame(draft, frameKey)); onClose(); }}>Delete this frame</button>
      <span className="muted flow-field-hint">Its blocks stay where they are.</span>
    </div>
  );
}

/**
 * With nothing selected: the flow's title, its name and deleting it (#447), the standing rules, the manager's file
 * (#322), the overlays (#318) and the frames (#446).
 */
/** Endings as a person types them: "Merged, Rejected". */
const endingsText = (list: string[] | undefined) => (list ?? []).join(', ');
const endingsOf = (text: string) => [...new Set(text.split(',').map((e) => e.trim()).filter(Boolean))];

/**
 * How Ledung follows the flow (part 3f, Simon 2026-11-03, question #1593): a worktree per run, at most N at once, what
 * happens to a run's sessions when it ends, and one run per ref. Only the last two are on unless set.
 */
function FollowFields({ draft, commit }: { draft: Draft; commit: (next: Draft, group?: string) => void }) {
  const typing = usePlainTyping();
  const w = draft.worktree;
  const removeMode = !w?.remove ? 'every' : w.remove === 'never' ? 'never' : w.remove.on ? 'on' : 'every';
  const tidy = draft.tidy ?? DEFAULT_TIDY;
  const tidyMode = typeof tidy === 'string' ? tidy : tidy.sessions;
  const tidyOn = typeof tidy === 'string' ? undefined : tidy.on;
  const endings = flowEndings(flowOf(draft));
  const setWt = (patch: Partial<FlowWorktree>, group?: string) => {
    const next = { ...w, ...patch };
    for (const k of Object.keys(patch) as (keyof FlowWorktree)[]) if (patch[k] === undefined) delete next[k];
    commit(setFollow(draft, { worktree: next }), group);
  };
  return (
    <fieldset className="flow-fieldset">
      <legend>Following it</legend>
      <span className="muted flow-field-hint">What Ledung does for each run (a piece of work going through this flow). One run per ref and archiving at the end are on unless switched off; the rest is off unless set.</span>
      <label className="toggle">
        <input type="checkbox" checked={!!w} onChange={(e) => commit(setFollow(draft, { worktree: e.target.checked ? {} : undefined }))} />
        {' '}<span><span className="field-name">A git worktree per run</span> <span className="muted">(made when it starts, in .ledung/worktrees; every session of the run works there)</span></span>
      </label>
      {w && (
        <>
          <div className="flow-field-row">
            <Field label="From branch"><input {...typing} className="mono" value={w.base ?? ''} placeholder="the one the project is on" onChange={(e) => setWt({ base: optional(e.target.value) }, 'wt-base')} /></Field>
            <Field label="Branch"><input {...typing} className="mono" value={w.branch ?? ''} placeholder={DEFAULT_BRANCH} onChange={(e) => setWt({ branch: optional(e.target.value) }, 'wt-branch')} /></Field>
          </div>
          <Field label="Removed when the run ends" hint="Only if nothing is uncommitted and its branch is merged or pushed; otherwise Ledung keeps it and says why. The project's setup command (its settings, Workflow) runs in each new one.">
            <select value={removeMode} onChange={(e) => setWt({ remove: e.target.value === 'never' ? 'never' : e.target.value === 'on' ? { on: endings.length ? endings.slice(0, 1) : [STOPPED_ENDING] } : undefined })}>
              <option value="every">on every ending</option>
              <option value="on">only on these endings…</option>
              <option value="never">never</option>
            </select>
          </Field>
          {removeMode === 'on' && w.remove !== 'never' && (
            <Field label="Endings" hint={`Its endings: ${[...endings, STOPPED_ENDING].join(', ')}.`}>
              <input {...typing} value={endingsText(w.remove?.on)} onChange={(e) => { const on = endingsOf(e.target.value); setWt({ remove: on.length ? { on } : undefined }, 'wt-on'); }} />
            </Field>
          )}
        </>
      )}
      <Field label="Runs at once" hint="More wait at the start, in line; Ledung starts the next when one ends. Empty: no limit.">
        <input type="number" min={1} max={100} value={draft.limit ?? ''} placeholder="no limit" onChange={(e) => commit(setFollow(draft, { limit: e.target.value ? Math.min(100, Math.max(1, Math.floor(Number(e.target.value)))) : undefined }), 'limit')} />
      </Field>
      <Field label="When a run ends, its sessions are">
        <select value={tidyMode} onChange={(e) => {
          const mode = e.target.value as 'archive' | 'stop' | 'keep';
          commit(setFollow(draft, { tidy: mode === 'keep' || !tidyOn ? (mode === DEFAULT_TIDY ? undefined : mode) : { sessions: mode, on: tidyOn } }));
        }}>
          <option value="archive">stopped and archived (the default)</option>
          <option value="stop">stopped</option>
          <option value="keep">kept as they are</option>
        </select>
      </Field>
      {tidyMode !== 'keep' && (
        <Field label="Only on these endings" hint="Empty: on every ending, a stop too.">
          <input {...typing} value={endingsText(tidyOn)} placeholder="every ending" onChange={(e) => {
            const on = endingsOf(e.target.value);
            commit(setFollow(draft, { tidy: on.length ? { sessions: tidyMode as 'archive' | 'stop', on } : tidyMode === DEFAULT_TIDY ? undefined : tidyMode }), 'tidy-on');
          }} />
        </Field>
      )}
      <label className="toggle">
        <input type="checkbox" checked={draft.oneRunPerRef !== false} onChange={(e) => commit(setFollow(draft, { oneRunPerRef: e.target.checked ? undefined : false }))} />
        {' '}<span><span className="field-name">One run per issue or PR</span> <span className="muted">(a second flow_start for the same ref is refused, unless asked again)</span></span>
      </label>
    </fieldset>
  );
}

function FlowFields({ draft, commit, narrow, onSelect, ws, flow, commitWs, onDeleted }: {
  draft: Draft; commit: (next: Draft, group?: string) => void; narrow: boolean; onSelect: (s: Selection) => void;
  ws: Workspace; flow: DraftFlow; commitWs: (next: Workspace, group?: string) => void; onDeleted: () => void;
}) {
  const typing = usePlainTyping();
  const [overlayTitle, setOverlayTitle] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const isDefault = flow.key === ws.flows[0]!.key;
  const [name, setName] = useState(flow.name);
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => { setName(flow.name); setNameProblem(null); }, [flow.name]);
  const applyName = () => {
    if (name === flow.name) return;
    const p = flowNameProblem(name, ws, flow.key);
    setNameProblem(p);
    if (!p) commitWs(renameFlow(ws, flow.key, name));
  };
  const runBy = ws.flows.flatMap((f) => f.draft.blocks.filter((b) => b.block.kind === 'flow' && b.block.flow === flow.name).map((b) => `"${b.block.title}" in ${f.draft.title ?? f.name}`));
  const title = (id: string) => draft.blocks.find((b) => b.block.id === id)?.block.title ?? id;
  const addOne = () => {
    // A new overlay amends the first block to begin with: an overlay amends at least one.
    const made = addOverlay(draft, overlayTitle, draft.blocks.slice(0, 1).map((b) => b.block.id));
    if (typeof made === 'string') return setProblem(made);
    setProblem(null);
    commit(made.draft);
    setOverlayTitle('');
    onSelect({ kind: 'overlay', key: made.key });
  };
  return (
    <div className="flow-panel-body flow-fields">
      <h3>{ws.flows.length > 1 ? (isDefault ? 'This flow, the default one' : 'This flow') : 'The workflow'}</h3>
      <Field label="Title"><input {...typing} value={draft.title ?? ''} onChange={(e) => commitWs(setFlowTitle(ws, flow.key, optional(e.target.value)), `${flow.key}:flow-title`)} /></Field>
      {isDefault
        ? ws.flows.length > 1 && <span className="muted flow-field-hint">In {FLOW_FILE}: where work goes unless the manager or the person picks another flow. Run flow blocks name it "{DEFAULT_FLOW}".</span>
        : (
          <>
            <Field label="Name" hint={nameProblem ?? `Its file is ${flowFileOf(flow.name)}; Run flow blocks name it so, and changing it changes them too.${flow.autoName ? ' Follows the title until you change it.' : ''}`}>
              <input {...typing} className="mono" value={name} onChange={(e) => setName(e.target.value)} onBlur={applyName} onKeyDown={(e) => e.key === 'Enter' && applyName()} aria-invalid={!!nameProblem} />
            </Field>
            {!narrow && (deleting
              ? <div className="flow-confirm" role="alertdialog">
                  <span>Delete the flow "{draft.title ?? flow.name}"? Saving removes {flowFileOf(flow.name)}{runBy.length ? `, and ${runBy.join(', ')} will run a flow that isn't there` : ''}. Its briefs stay.</span>
                  <span className="flow-confirm-buttons"><button className="small deny" onClick={() => { commitWs(deleteFlow(ws, flow.key)); onDeleted(); }}>Delete it</button><button className="small" onClick={() => setDeleting(false)}>Keep it</button></span>
                </div>
              : <button className="small deny flow-delete" onClick={() => setDeleting(true)}>Delete this flow</button>)}
          </>
        )}
      <FollowFields draft={draft} commit={commit} />
      <Field label="Standing rules (rules.md)" hint={`Markdown every session of the project reads: rules that belong to no single step${ws.flows.length > 1 ? '; the same for every flow' : ''}.`}>
        <textarea {...typing} className="mono" rows={narrow ? 10 : 16} value={draft.rules ?? ''} placeholder={draft.rules === null ? 'No rules.md yet: what you write here is saved as one.' : undefined}
          onChange={(e) => commit({ ...draft, rules: e.target.value }, 'rules')} />
      </Field>
      {isDefault ? <fieldset className="flow-fieldset">
        <legend>The manager</legend>
        <span className="muted flow-field-hint">Its standing procedures between steps (status briefs, sweeps, how it asks), in one file its instructions name. How a block's step is done is that block's brief.</span>
        {draft.manager !== undefined
          ? <p><button className="link" onClick={() => onSelect({ kind: 'manager', key: 'manager' })}>📋 {draft.manager}</button>{draft.texts[draft.manager] === undefined && <span className="flow-problem-inline"> (missing)</span>}</p>
          : <div className="flow-field-row flow-new-brief"><button className="small" onClick={() => { commit(newManagerFile(draft)); onSelect({ kind: 'manager', key: 'manager' }); }}>Add the manager's file</button></div>}
      </fieldset> : <p className="muted">The manager's file is the default flow's, for all flows: its tab has it.</p>}
      <fieldset className="flow-fieldset">
        <legend>Overlays</legend>
        <span className="muted flow-field-hint">Switchable additions that amend several blocks at once (e.g. "tests on Windows" for Build and Fix).</span>
        {draft.overlays.length > 0 && (
          <ul className="flow-roles">
            {draft.overlays.map(({ key, overlay: o }) => (
              <li key={key}><button className="link" onClick={() => onSelect({ kind: 'overlay', key })}>◇ {o.title}</button><span className="muted"> · amends {o.blocks.map(title).join(', ')}</span></li>
            ))}
          </ul>
        )}
        <div className="flow-field-row flow-new-brief">
          <input {...typing} placeholder="Tests on Windows" value={overlayTitle} onChange={(e) => { setOverlayTitle(e.target.value); setProblem(null); }} onKeyDown={(e) => e.key === 'Enter' && addOne()} aria-label="A new overlay's title" />
          <button className="small" onClick={addOne}>Add an overlay</button>
        </div>
        {problem && <p className="flow-problem-inline">{problem}</p>}
      </fieldset>
      <fieldset className="flow-fieldset">
        <legend>Frames</legend>
        <span className="muted flow-field-hint">Titled, coloured groups of blocks ("Planning", "Building"), drawn behind them.{narrow ? '' : ' Add one from the palette, or round a block from its panel.'}</span>
        {draft.frames.length > 0 && (
          <ul className="flow-roles">
            {draft.frames.map(({ key, frame: f }) => (
              <li key={key}><button className={`link${f.colour ? ' named' : ''}`} style={frameColour(f)} onClick={() => onSelect({ kind: 'frame', key })}>▢ {f.title}</button></li>
            ))}
          </ul>
        )}
      </fieldset>
      {!narrow && <p className="muted">Click a block or an arrow (one of its outcomes) to change it.</p>}
    </div>
  );
}

/** The manager's file (#322): which file, its text, and the blocks the manager runs itself. */
function ManagerFields({ draft, narrow, commit, onClose, onSelect }: {
  draft: Draft; narrow: boolean; commit: (next: Draft, group?: string) => void; onClose: () => void; onSelect: (s: Selection) => void;
}) {
  const typing = usePlainTyping();
  const file = draft.manager;
  if (file === undefined) return null;
  const files = [...new Set([MANAGER_FILE, ...Object.keys(draft.texts).filter((f) => f === MANAGER_FILE || f.startsWith('briefs/'))])].filter((f) => draft.texts[f] !== undefined).sort();
  const text = draft.texts[file];
  const runs = draft.blocks.filter((b) => b.block.runs === 'manager');
  return (
    <div className="flow-panel-body flow-fields">
      <div className="flow-panel-head">
        <h3>{narrow ? <button className="link" onClick={onClose}>← The workflow</button> : 'The manager'}</h3>
        {!narrow && <button className="small" onClick={onClose} aria-label="Close the manager's file">×</button>}
      </div>
      <p className="muted">{runs.length
        ? <>Runs {runs.map((b, i) => <span key={b.key}>{i ? ', ' : ''}<button className="link" onClick={() => onSelect({ kind: 'block', key: b.key })}>{b.block.title}</button></span>)} itself, and between steps does what this file says.</>
        : 'Runs no block itself: this file is what it does between steps.'}</p>
      <Field label="File">
        <select value={file} onChange={(e) => commit(setManager(draft, e.target.value))}>
          {files.map((f) => <option key={f} value={f}>{f}</option>)}
          {!files.includes(file) && <option value={file}>{file}{text === undefined ? ' (missing)' : ''}</option>}
        </select>
      </Field>
      {file !== MANAGER_FILE && draft.texts[MANAGER_FILE] === undefined && <button className="small" onClick={() => commit(newManagerFile(draft))}>New {MANAGER_FILE}</button>}
      {text !== undefined && (
        <Field label={`Its text (${file})`} hint={WRITABLE_FLOW_FILE.test(file) ? 'Markdown: what the manager does between steps (status briefs, sweeps, the question format).' : 'In a sub-folder: the builder edits manager.md and briefs/ only.'}>
          <textarea {...typing} className="mono" rows={narrow ? 10 : 16} value={text} readOnly={!WRITABLE_FLOW_FILE.test(file)}
            onChange={(e) => commit({ ...draft, texts: { ...draft.texts, [file]: e.target.value } }, `brief:${file}`)} />
        </Field>
      )}
      <button className="small deny flow-delete" onClick={() => { commit(setManager(draft, undefined)); onClose(); }}>Remove the manager's file from the flow</button>
      <span className="muted flow-field-hint">Removing it takes it out of the flow; the file stays in the folder.</span>
    </div>
  );
}

/** An overlay (#318): its title and id, which blocks it amends, its file and text. */
function OverlayFields({ draft, overlayKey, narrow, commit, onClose }: {
  draft: Draft; overlayKey: string; narrow: boolean; commit: (next: Draft, group?: string) => void; onClose: () => void;
}) {
  const typing = usePlainTyping();
  const entry = draft.overlays.find((o) => o.key === overlayKey);
  const o = entry?.overlay;
  const [id, setId] = useState(o?.id ?? '');
  const [idProblem, setIdProblem] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  useEffect(() => { setId(o?.id ?? ''); setIdProblem(null); }, [o?.id, overlayKey]);
  if (!o) return null;
  const applyId = () => {
    if (id === o.id) return;
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) setIdProblem('Lower case letters, digits and "-" (at most 48), starting with a letter or digit.');
    else if (draft.overlays.some((x) => x.key !== overlayKey && x.overlay.id === id)) setIdProblem(`Another overlay is "${id}" already.`);
    else {
      setIdProblem(null);
      commit(setOverlay(draft, overlayKey, { id }));
    }
  };
  const files = Object.keys(draft.texts).filter((f) => f.startsWith('overlays/')).sort();
  const text = draft.texts[o.file];
  return (
    <div className="flow-panel-body flow-fields">
      <div className="flow-panel-head">
        <h3>{narrow ? <button className="link" onClick={onClose}>← The workflow</button> : 'Overlay'}</h3>
        {!narrow && <button className="small" onClick={onClose} aria-label="Close the overlay">×</button>}
      </div>
      <Field label="Title"><input {...typing} value={o.title} onChange={(e) => commit(setOverlay(draft, overlayKey, { title: e.target.value }), `overlay-title:${overlayKey}`)} /></Field>
      <Field label="Id" hint={idProblem ?? 'Its name in flow.json.'}>
        <input {...typing} className="mono" value={id} onChange={(e) => setId(e.target.value)} onBlur={applyId} onKeyDown={(e) => e.key === 'Enter' && applyId()} aria-invalid={!!idProblem} />
      </Field>
      <fieldset className="flow-fieldset">
        <legend>Amends</legend>
        {draft.blocks.map((b) => {
          const on = o.blocks.includes(b.block.id);
          const last = on && o.blocks.length === 1;
          return (
            <label key={b.key} className="flow-check" title={last ? 'An overlay amends at least one block' : undefined}>
              <input type="checkbox" checked={on} disabled={last} onChange={() => commit(toggleAmends(draft, overlayKey, b.block.id))} /> {b.block.title}
            </label>
          );
        })}
        {o.blocks.filter((idOf) => !draft.blocks.some((b) => b.block.id === idOf)).map((gone) => <span key={gone} className="flow-problem-inline">"{gone}" is not a block any more.</span>)}
      </fieldset>
      <Field label="File">
        <select value={o.file} onChange={(e) => commit(setOverlay(draft, overlayKey, { file: e.target.value }))}>
          {files.map((f) => <option key={f} value={f}>{f}</option>)}
          {!files.includes(o.file) && <option value={o.file}>{o.file}{text === undefined ? ' (missing)' : ''}</option>}
        </select>
      </Field>
      <div className="flow-field-row flow-new-brief">
        <input {...typing} placeholder="new-overlay-name" value={fileName} onChange={(e) => { setFileName(e.target.value); setFileProblem(null); }} aria-label="A new overlay file's name" />
        <button className="small" onClick={() => {
          const made = newOverlayFile(draft, overlayKey, fileName || o.id);
          if (typeof made === 'string') setFileProblem(made);
          else {
            commit(made);
            setFileName('');
          }
        }}>New file</button>
      </div>
      {fileProblem && <p className="flow-problem-inline">{fileProblem}</p>}
      {text !== undefined && (
        <Field label={`Its text (${o.file})`} hint={WRITABLE_FLOW_FILE.test(o.file) ? 'Markdown: what changes in the blocks it amends when it is on.' : 'In a sub-folder: the builder edits overlays in overlays/ only.'}>
          <textarea {...typing} className="mono" rows={narrow ? 8 : 12} value={text} readOnly={!WRITABLE_FLOW_FILE.test(o.file)}
            onChange={(e) => commit({ ...draft, texts: { ...draft.texts, [o.file]: e.target.value } }, `brief:${o.file}`)} />
        </Field>
      )}
      <button className="small deny flow-delete" onClick={() => { commit(deleteOverlay(draft, overlayKey)); onClose(); }}>Delete this overlay</button>
      <span className="muted flow-field-hint">Its file stays in the folder.</span>
    </div>
  );
}
