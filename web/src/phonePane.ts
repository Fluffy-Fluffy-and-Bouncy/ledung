// One pane at a time on a phone (issue #171, Martin 2026-10-17, Ledung question #240): the sidebar is the home
// screen, and anything opened from it fills the screen with a ← back to the list. Which of the two shows is the
// same address either way; only the CSS at phone width (styles.css) hides the other one. Pure helpers, kept apart
// from the components so they can be tested.

/** The class on .app that says what a phone shows: the list (nothing open) or the open pane. */
export const phoneClass = (openId: string | null): 'phone-list' | 'phone-pane' => (openId === null ? 'phone-list' : 'phone-pane');

/** What a history entry remembers for the ←: whether it was opened straight from the list. */
export type ListSteps = { ledungFromList?: boolean };

/**
 * Where the ← in a pane goes. Opened from the list, one step back, so the phone's own Back and the ← agree and the
 * list isn't stacked twice in history; a reload keeps that mark, and the list is still the step behind. Otherwise (a
 * link, a bookmark, Go to conversation) there is no list entry behind it, so the list is opened as a new step.
 */
export function backToList(state: ListSteps | null): { back: 1 } | { open: null } {
  return state?.ledungFromList === true ? { back: 1 } : { open: null };
}

/** Closing Waiting for you with no view before it: Usage → Sessions (the old Overview, issue #400) on a wide screen, the list on a phone. */
export const deskFallback = (phone: boolean): string | null => (phone ? null : 'overview');
