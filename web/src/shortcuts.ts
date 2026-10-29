// Shortcuts that start Ledung (issue #415): when the page asks its first-run question and what it says. Pure, kept
// apart from the components so they can be tested. Asked once, Yes or No (Martin, 2026-10-29 13:58, Ledung question
// #939: "I want a question the first time Ledung is run if you want a startup icon on your desktop (or in the
// applications folder for mac). With an option to add that from the settings menu later on.").
import type { ShortcutsView } from '../../src/shared/protocol.ts';

/**
 * The first-run question shows on this computer's own page (a framed page is another computer's) while it has not
 * been answered and none of the shortcuts is there yet.
 */
export function asksFirstRun(view: ShortcutsView | null, framed: boolean): boolean {
  return !!view && !framed && view.available && !view.asked && view.places.length > 0 && !view.places.some((p) => p.present);
}

/** "Desktop and Start menu", "Applications". */
export function placesText(view: ShortcutsView): string {
  const labels = view.places.map((p) => p.label);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0] ?? '';
}

/** The question: "Add a Ledung icon to your Desktop and Start menu?" on Windows, "… to Applications?" on macOS. */
export function questionText(view: ShortcutsView): string {
  return view.kind === 'mac' ? `Add a Ledung icon to ${placesText(view)}?` : `Add a Ledung icon to your ${placesText(view)}?`;
}

const WHERE: Record<string, string> = { desktop: 'on your Desktop', 'start-menu': 'in the Start menu', applications: 'in Applications' };

/** Settings' line: "A Ledung icon on your Desktop and in the Start menu.", "A Ledung icon in Applications." */
export function settingsText(view: ShortcutsView): string {
  const parts = view.places.map((p) => WHERE[p.id] ?? `in ${p.label}`);
  const where = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? '';
  return `A Ledung icon ${where}.`;
}

/** What the icon does, the same in the question and in Settings. */
export const SHORTCUT_ABOUT = "It opens this page, and starts Ledung first if it isn't running.";
