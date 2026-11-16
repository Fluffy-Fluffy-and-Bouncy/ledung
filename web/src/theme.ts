// The page's colour scheme (issue #113): Dark, Light or System, which follows the computer.
// Dark is the default whatever the computer's setting, and Light is kept as a basic option (issue #345, Simon
// 2026-11-17): new colours get a designed dark value and a light value that only has to be readable.
// Kept per browser like the page's other choices; the stylesheet does the rest through `color-scheme` on the root
// (styles.css), so a choice switches the page without a reload.

export type Theme = 'system' | 'light' | 'dark';

export const THEMES: { id: Theme; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light (basic)' },
  { id: 'system', label: 'System' },
];

export const THEME_KEY = 'ledung.theme';

/** The parts of `localStorage` and the root element used here, so tests can pass their own. */
export type ThemeStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type ThemeRoot = { setAttribute(name: string, value: string): void; removeAttribute(name: string): void };

/**
 * A stored value back into use. Nothing stored, or anything unknown, is Dark, the default (#345). Before #345 an
 * explicit System was stored as nothing, the same as never choosing; it is stored as "system" now.
 */
export function parseTheme(raw: string | null): Theme {
  return raw === 'light' || raw === 'system' ? raw : 'dark';
}

export function readTheme(store: ThemeStore): Theme {
  try { return parseTheme(store.getItem(THEME_KEY)); } catch { return 'dark'; }
}

/** Saves the choice, every one of them by name, so a later change of default leaves it alone. */
export function saveTheme(store: ThemeStore, theme: Theme): void {
  try { store.setItem(THEME_KEY, theme); } catch { /* private mode: kept for this visit only */ }
}

/**
 * Marks the root with the choice. With no mark (before this runs) the stylesheet is dark, so the first paint is
 * already dark (#345); System's mark hands the scheme to the computer.
 */
export function applyTheme(root: ThemeRoot, theme: Theme): void {
  root.setAttribute('data-theme', theme);
}
