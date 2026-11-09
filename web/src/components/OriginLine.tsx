// "Based on Team process v3 by Ana" (docs/steps/workflow-origin.md, Simon 2026-11-06, question #1680): a copy's credit
// to the workflow it was copied from, and through it to the first author. Text only: nothing is enforced.
import type { FlowOrigin } from '../../../src/shared/flow.ts';
import { firstAuthor, originName } from '../../../src/shared/flow-origin.ts';

/** The details a person may want and the line has no room for: the hash, the day, the remote. */
export function originTooltip(o: FlowOrigin): string {
  return [
    o.hash && `Version ${o.hash}`,
    o.copiedAt ? `copied ${o.copiedAt}` : o.adopted && `recorded ${o.adopted}, after the copy was made`,
    o.repo && `from ${o.repo}`,
    `shared workflow "${o.workflow}" on the computer it was copied on`,
  ].filter(Boolean).join(' · ');
}

/** The line itself; `compact` for the Workflow pane: the name and release, the rest in the tooltip. */
export function OriginLine({ origin, compact = false }: { origin: FlowOrigin; compact?: boolean }) {
  const first = firstAuthor(origin);
  const tip = originTooltip(origin);
  if (compact) {
    return <span className="muted flow-origin" title={[origin.author && `by ${origin.author}`, tip].filter(Boolean).join(' · ')}>based on {originName(origin)}</span>;
  }
  return (
    <div className="flow-origin" title={tip}>
      Based on <strong>{originName(origin)}</strong>
      {!origin.release && origin.copiedAt && <>, copied {origin.copiedAt},</>}
      {origin.author && <> by {origin.author}</>}
      {first && first !== origin.author && <span className="muted"> · first by {first}</span>}
    </div>
  );
}
