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

/** The page's address, as much of it as stopRefusal reads; spelled out so the tests need no DOM. */
type Place = { protocol: string; hostname: string; port: string };

/**
 * Why this page can't stop Ledung, or null when it can: only this computer's own page, not in another computer's frame,
 * stops it (the server's rule for POST /api/stop). Said in Settings instead of an empty section, which its search still
 * finds (2026-11-09). The port is the page's own when it came straight over the network; through the public name it is
 * not known here.
 */
export function stopRefusal(framed: boolean, at: Place): string | null {
  const local = at.hostname === '127.0.0.1' || at.hostname === 'localhost' || at.hostname === '[::1]';
  if (local && !framed) return null;
  const address = at.protocol === 'http:' && at.port ? `http://127.0.0.1:${at.port}` : 'http://127.0.0.1';
  return framed
    ? `This is another computer's page: Stop Ledung only works on the page at ${address} on the computer that Ledung runs on.`
    : `Stop Ledung only works on the page at ${address} on the computer Ledung runs on.`;
}

/** What the icon does, the same in the question and in Settings. */
export const SHORTCUT_ABOUT = "It opens this page, and starts Ledung first if it isn't running.";
