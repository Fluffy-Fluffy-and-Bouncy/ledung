// The first start and the Ledung Helper (docs/steps/ledung-helper.md): the setup's steps and what the page and the
// helper see of them. Ledung keeps the steps, not the AI: a step is done when the thing really exists (a project, a
// name, the check-in notice answered), or when the person marked it done or skipped. Shared by the core and the page.

export const SETUP_STEPS = [
  { id: 'name', label: 'Your name', skippable: false },
  { id: 'accounts', label: 'Claude accounts', skippable: true },
  { id: 'project', label: 'First project', skippable: false },
  { id: 'basics', label: 'Model, effort and mode', skippable: true },
  { id: 'sensitive', label: 'Sensitive list', skippable: true },
  { id: 'grant', label: "Its manager's grant", skippable: true },
  { id: 'workflow', label: 'A workflow', skippable: true },
  { id: 'shortcuts', label: 'Shortcuts and start at sign-in', skippable: true },
  { id: 'phone', label: 'Phone', skippable: true },
  { id: 'checkin', label: 'Anonymous check-in', skippable: false },
] as const;

export type SetupStepId = typeof SETUP_STEPS[number]['id'];
export const SETUP_STEP_IDS: readonly SetupStepId[] = SETUP_STEPS.map((s) => s.id);
export const isSetupStep = (v: unknown): v is SetupStepId => typeof v === 'string' && (SETUP_STEP_IDS as readonly string[]).includes(v);

/**
 * Where the first start is. none: never in setup (a Ledung that had projects or sessions before the helper existed);
 * welcome and claude: the plain screens; helper: the helper walks the steps; done: finished or left.
 */
export type SetupPhase = 'none' | 'welcome' | 'claude' | 'helper' | 'done';

/** What is kept in Ledung's data (meta), not the config. */
export interface SetupState {
  phase: SetupPhase;
  /** Steps the person marked, through the helper or a card. */
  marks: Partial<Record<SetupStepId, 'done' | 'skipped'>>;
  /** The project this setup is about, once one was added or created. */
  project: string | null;
  /** The project whose workflow review the person accepted in this setup (a container project's files aren't looked at). */
  flowSaved?: string;
}

/** What Ledung can see for itself, so a step that names a thing is done only when the thing is there. */
export interface SetupFacts {
  /** A name was given (in Ledung or the config). */
  named: boolean;
  /** The setup's project is there. */
  project: boolean;
  /** The setup's project has a workflow (.ledung/workflow/flow.json). */
  workflow: boolean;
  /** The shortcuts question was answered (Add or No), or this computer gets none. */
  shortcuts: boolean;
  /** The check-in notice was answered. */
  checkin: boolean;
}

export type StepState = 'done' | 'skipped' | 'open';

export interface SetupStepView { id: SetupStepId; label: string; skippable: boolean; state: StepState }

export interface SetupView {
  phase: SetupPhase;
  steps: SetupStepView[];
  /** The first step not done or skipped; null: all are, the setup can finish. */
  current: SetupStepId | null;
  /** 1-based place of the current step; steps.length + 1 when all are through. */
  index: number;
  total: number;
  project: string | null;
}

/** The Ledung Helper as the page sees it. */
export interface HelperInfo {
  /** The helper's conversation (the newest not archived), null before the first. */
  sessionId: string | null;
  /** Its model, from Settings; Sonnet unless changed. */
  model: string;
  setup: SetupView;
  /** The name sessions use for the person (the config's, or the one given in setup). */
  userName: string;
  /** The setup's workflow review while it is open: the workflow step's card opens it; null: none. */
  review?: number | null;
  /** The step the helper's latest turn was for ("through" when all are): its card waits for the helper's words on it. */
  spokeFor?: string;
}

/** Steps whose thing Ledung can see: marking them done is refused until it is there. */
const SEEN: Partial<Record<SetupStepId, keyof SetupFacts>> = {
  name: 'named', project: 'project', workflow: 'workflow', shortcuts: 'shortcuts', checkin: 'checkin',
};

/** Steps about the setup's project: they wait for it. */
export const NEEDS_PROJECT: readonly SetupStepId[] = ['basics', 'sensitive', 'grant', 'workflow'];

export function stepState(id: SetupStepId, state: SetupState, facts: SetupFacts): StepState {
  const fact = SEEN[id];
  if (fact && facts[fact]) return 'done';
  const mark = state.marks[id];
  if (mark === 'skipped') return 'skipped';
  // A mark can't stand in for a thing Ledung can see (the project, the notice), only for the person's word.
  if (mark === 'done' && !fact) return NEEDS_PROJECT.includes(id) && !facts.project ? 'open' : 'done';
  return 'open';
}

export function setupView(state: SetupState, facts: SetupFacts): SetupView {
  const steps = SETUP_STEPS.map((s) => ({ id: s.id, label: s.label, skippable: s.skippable, state: stepState(s.id, state, facts) }));
  const at = steps.findIndex((s) => s.state === 'open');
  return {
    phase: state.phase, steps, current: at < 0 ? null : steps[at]!.id, index: at < 0 ? steps.length + 1 : at + 1, total: steps.length, project: state.project,
  };
}

/** Why a step can't be marked so now, or null. */
export function markProblem(id: SetupStepId, mark: 'done' | 'skipped', facts: SetupFacts): string | null {
  const step = SETUP_STEPS.find((s) => s.id === id)!;
  if (mark === 'skipped' && !step.skippable) return `"${step.label}" can't be skipped.`;
  const fact = SEEN[id];
  if (mark === 'done' && fact && !facts[fact]) {
    return {
      named: 'No name was given yet: use set_user_name.',
      project: 'No project was added or created in this setup yet.',
      workflow: "The project has no workflow yet: it is there once the person accepts the workflow's review.",
      shortcuts: 'The shortcuts question was not answered yet: the person adds them or says no on the card.',
      checkin: 'The check-in notice was not answered yet: the person answers it on the card.',
    }[fact];
  }
  if (mark === 'done' && NEEDS_PROJECT.includes(id) && !facts.project) return 'This step is about the setup\'s project, and there is none yet.';
  return null;
}

/** The step bar's words: "Setting up · step 3 of 10: First project". */
export function stepLine(v: SetupView): string {
  if (!v.current) return 'Setting up · all steps done';
  const step = v.steps.find((s) => s.id === v.current)!;
  return `Setting up · step ${v.index} of ${v.total}: ${step.label}`;
}
