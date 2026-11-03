// The flow a workflow page shows, in the address (#447, Simon: "if I click on a sub-flow so I can see it, and then
// press back on the mouse, I get too far back"): #/wf/<project> for the default flow, #/wf/<project>/<flow> for another,
// each flow opened a history entry of its own, so Back and Forward step through the flows viewed. And the builder's
// unsaved changes: leaving the workflow page while there are some asks first. Pure helpers, apart from the components.

/** The default flow's name (src/shared/flow.ts DEFAULT_FLOW): it has no part of its own in the address. */
const DEFAULT = 'main';

/** The address of a project's workflow page showing `flow` (none, or the default one: the page itself). */
export function workflowHash(project: string, flow?: string | null): string {
  const page = `#/wf/${encodeURIComponent(project)}`;
  return flow && flow !== DEFAULT ? `${page}/${flow}` : page;
}

/** The project and flow an address shows (flow null: the default one); null when it is no workflow page. */
export function workflowFromHash(hash: string): { project: string; flow: string | null } | null {
  const m = /^#\/wf\/([^/]+)(?:\/([^/]+))?$/.exec(hash);
  if (!m) return null;
  let project: string;
  try {
    project = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  // A name no flow has (or can have) is the page's to say: it shows the default flow with a note.
  return { project, flow: m[2] === undefined || m[2] === DEFAULT ? null : m[2] };
}

/**
 * What keeps unsaved changes from being dropped by leaving: the builder sets it while it has some, for its project's
 * workflow page; `ask` shows its question and calls `proceed` when the person discards them.
 */
export interface LeaveGuard {
  project: string;
  ask: (proceed: () => void) => void;
}

let guard: LeaveGuard | null = null;

export function setLeaveGuard(g: LeaveGuard | null): void {
  guard = g;
}

/** The guard that holds a move to `toHash` back (it leaves the guarded project's workflow page), or null. */
export function guardFor(toHash: string): LeaveGuard | null {
  if (!guard) return null;
  return workflowFromHash(toHash)?.project === guard.project ? null : guard;
}

/**
 * When a guard last held a move back (it put the page back with an entry of its own): the mouse's back button, which
 * Ledung takes itself where the browser doesn't (Safari), must not take it again a moment later.
 */
let heldAt = 0;
export const noteHeld = (): void => { heldAt = Date.now(); };
export const heldRecently = (ms = 1000): boolean => Date.now() - heldAt < ms;
