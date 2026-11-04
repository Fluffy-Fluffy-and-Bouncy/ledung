// Runs on the workflow page (workflow part 3c, docs/steps/workflow-follow.md): a marker on each block with the runs in
// it, a counted pin's progress ("Failed 2 of 3"), and the Runs list beside the rules, each run's flow, block, state and
// history; choosing one marks its path through the diagram.
import { useEffect, useState } from 'react';
import type { FlowRun } from '../../../src/shared/flow-run.ts';
import { openRun as open, placeInLine } from '../flowRuns.ts';
import type { QuestionRun } from '../../../src/shared/questions.ts';
import { workflowHash } from '../flowNav.ts';
import { formatTime } from './MessageList.tsx';

/** How long ago, in a few words: "5 min", "3 h", "2 days". */
function since(at: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - at) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

function stateLine(r: FlowRun, blockTitle: (flow: string, id: string) => string, runs: readonly FlowRun[]): string {
  if (r.state === 'ended') return r.ending ? `ended "${r.ending}"` : 'ended';
  if (r.state === 'stopped') return r.ending ? `stopped: ${r.ending}` : 'stopped';
  const at = r.at ? blockTitle(r.flow, r.at) : '?';
  // In line (part 3f): to start, or before a block that takes only so many at once.
  if (r.state === 'queued') return `${r.queue === 'flow' ? 'queued to start' : `queued before ${at}`}, number ${placeInLine(runs, r)} in line, for ${since(r.atSince)}`;
  return r.state === 'waiting' ? `waiting at ${at} for ${since(r.atSince)}` : `at ${at}`;
}

/** The Runs list (part 3c): open ones first, then the latest ended; a run chosen shows its history and marks its path. */
export function RunsPanel({ runs, chosen, onChoose, flowTitle, blockTitle, error, heading = true, follow, onStart, onStop }: {
  runs: readonly FlowRun[]; chosen: string | null; onChoose: (id: string | null) => void;
  flowTitle: (name: string) => string; blockTitle: (flow: string, id: string) => string;
  /** The runs could not be read: said, rather than shown as none. */
  error?: string | null;
  /** False where a fold above it says "Runs" already (a phone). */
  heading?: boolean;
  /** How the shown flow is followed, in a line (part 3f); empty: nothing set. */
  follow?: string;
  /** "Start anyway" for a queued run (part 3f): the error, if it couldn't. */
  onStart?: (id: string) => Promise<string | null>;
  /** Stop for a run under way (final review of part 3): the error, if it couldn't. */
  onStop?: (id: string) => Promise<string | null>;
}) {
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState<{ id: string; text: string } | null>(null);
  /** The run whose Stop is being confirmed, or being sent. */
  const [stopping, setStopping] = useState<{ id: string; sent: boolean } | null>(null);
  // "Waiting for 5 min" goes on counting while the page is open (review of 3c).
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  if (error && !runs.length) {
    return (
      <div className="flow-panel-body flow-runs">
        <h3>Runs</h3>
        <p className="flow-problem-inline">The runs could not be read: {error}</p>
      </div>
    );
  }
  if (!runs.length) {
    return (
      <div className="flow-panel-body flow-runs">
        <h3>Runs</h3>
        <p className="muted">No work has gone through this workflow yet. The manager starts a run with flow_start, or any session when you ask it to run the workflow on something.</p>
      </div>
    );
  }
  // The chosen one always, so its path can be unmarked again (review of 3c).
  const ended = runs.filter((r) => !open(r));
  const h = heading ? <h3>Runs</h3> : null;
  const shown = [...runs.filter(open), ...ended.slice(0, 10), ...ended.slice(10).filter((r) => r.id === chosen)];
  return (
    <div className="flow-panel-body flow-runs">
      {h}
      {follow && <p className="muted flow-follow-line">{follow}</p>}
      <ol className="flow-run-list">
        {shown.map((r) => (
          <li key={r.id} className={`flow-run state-${r.state}${r.id === chosen ? ' chosen' : ''}`}>
            <button className="flow-run-head" aria-pressed={r.id === chosen} onClick={() => onChoose(r.id === chosen ? null : r.id)} title={r.id === chosen ? 'Stop marking its path' : 'Mark its path on the diagram'}>
              <span className="flow-run-title"><span className="mono">{r.id}</span> {r.title}{r.ref ? <span className="chip">{r.ref}</span> : null}</span>
              <span className="muted">{flowTitle(r.flow)} · {stateLine(r, blockTitle, runs)}{r.parent ? ` · for ${r.parent.run}` : ''}</span>
            </button>
            {open(r) && ((r.state === 'queued' && onStart) || (onStop && r.id === chosen)) && (
              <div className="flow-run-actions">
                {r.state === 'queued' && onStart && (
                  <button className="small" disabled={starting === r.id} title="Start it now, past the limit" onClick={async () => {
                    setStarting(r.id);
                    const problem = await onStart(r.id);
                    setStarting(null);
                    setStartError(problem ? { id: r.id, text: problem } : null);
                  }}>{starting === r.id ? 'Starting…' : 'Start anyway'}</button>
                )}
                {/* Stop, asked once more: it stops its sessions' part in it and tidies as the flow says. */}
                {onStop && r.id === chosen && (stopping?.id === r.id
                  ? <>
                    <span className="muted">Stop {r.id}? Its coordinator is told.</span>
                    <button className="small deny" disabled={stopping.sent} onClick={async () => {
                      setStopping({ id: r.id, sent: true });
                      const problem = await onStop(r.id);
                      setStopping(null);
                      setStartError(problem ? { id: r.id, text: problem } : null);
                    }}>{stopping.sent ? 'Stopping…' : 'Stop the run'}</button>
                    <button className="small" disabled={stopping.sent} onClick={() => setStopping(null)}>Keep it</button>
                  </>
                  : <button className="small" title="Stop this run where it is" onClick={() => setStopping({ id: r.id, sent: false })}>Stop…</button>)}
                {startError?.id === r.id && <span className="flow-problem-inline">{startError.text}</span>}
              </div>
            )}
            {r.id === chosen && r.worktree && <p className="muted flow-run-note">Worktree <span className="mono">{r.worktree.path}</span>, branch <span className="mono">{r.worktree.branch}</span>{r.worktree.own ? '' : ` (${r.parent?.run}'s)`}</p>}
            {r.id === chosen && (
              r.history.length
                ? <ol className="flow-run-history">
                  {r.history.map((h, i) => (
                    <li key={i}>
                      <span className="muted">{formatTime(h.at)}</span> {blockTitle(r.flow, h.block)}: <strong>{h.word}</strong>{h.n > 1 ? ` (${h.n}×)` : ''} <span className="muted">by {h.by}</span> → {h.to === null ? 'end' : blockTitle(r.flow, h.to)}
                      {h.note && <div className="muted flow-run-note">{h.note}</div>}
                    </li>
                  ))}
                </ol>
                : <p className="muted">No steps yet: it is at its first block.</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A person block's question or review (part 3c): its run and block, linked to the workflow page, and whose call it is. */
export function RunLine({ run, project }: { run: QuestionRun; project: string }) {
  return (
    <div className="muted run-line">
      Workflow: <a href={workflowHash(project, run.flow)} title="Open the workflow page, where the Runs list shows the run">{run.run} "{run.runTitle}" · {run.blockTitle}</a>
      {run.person ? <> · <span className="chip" title="Whose call this is, as the workflow says">{run.person}'s call</span></> : null}
      {' '}· your answer moves the run
    </div>
  );
}
