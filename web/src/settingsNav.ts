// Leaving Settings (issue #78): Escape or a second press of the ⚙ goes back to the screen Settings
// was opened from, past Accounts and Add project when they were opened through it.
// Pure helpers, kept apart from the component so they can be tested.

/** The views the ⚙ shows as selected: Settings and the pages reached through it (chats' settings: issue #211). */
export const SETTINGS_VIEWS = ['settings', 'accounts', 'add', 'chats'];

/**
 * A Settings view, or one of the Ledung or Chats tab's groups ("settings:remote", issue #365; "chats:look", #366): each
 * group is a step of its own. A project's tab and its groups ("ps:<name>", "ps:<name>/<group>") stay outside, as the
 * project page was before #366 (the #78 test keeps it so): Escape there doesn't leave.
 */
export const isSettingsView = (id: string | null): boolean => !!id && (SETTINGS_VIEWS.includes(id) || /^(settings|chats):/.test(id));

/** Where a history entry is in Settings: how many steps since the screen before it, and whether there was one. */
export type SettingsSteps = { depth: number; root: boolean };

/**
 * The steps of the entry `to` opens, coming from `from` with steps `fromSteps`. Each Settings page
 * opened from another one is one step further; entering from outside is the first step.
 */
export function stepsInto(from: string | null, fromSteps: SettingsSteps, to: string | null): SettingsSteps {
  if (!isSettingsView(to)) return { depth: 0, root: false };
  if (isSettingsView(from)) return { depth: fromSteps.depth + 1, root: fromSteps.root };
  return { depth: 1, root: false };
}

/** Where leaving Settings goes: that many steps back in history, or the start page when Settings was opened directly. */
export function leaveSettings(steps: SettingsSteps): { back: number } | { start: true } {
  return steps.depth > 0 && !steps.root ? { back: steps.depth } : { start: true };
}

/** Escape leaves Settings unless something on the page (a field, a menu) already used it. */
export const escapeLeaves = (e: { key: string; defaultPrevented: boolean; isComposing: boolean }): boolean =>
  e.key === 'Escape' && !e.defaultPrevented && !e.isComposing;
