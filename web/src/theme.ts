// The page's colour scheme (issue #113): Dark or Light, per browser. Dark is the default whatever the computer's
// setting, and Light is kept as a basic option; there is no System choice (issue #345, Simon 2026-11-17, question
// #2026). New colours get a designed dark value and a light value that only has to be readable.
// The stylesheet does the rest through `color-scheme` on the root (styles.css), so a choice switches the page
// without a reload.

export type Theme = 'light' | 'dark';

/** The default for a browser that never chose. If it is ever flipped, flip the stylesheet's `:root` and index.html's meta too. */
export const DEFAULT_THEME: Theme = 'dark';

export const THEMES: { id: Theme; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light (basic)' },
];

export const THEME_KEY = 'ledung.theme';

/** The parts of `localStorage` and the root element used here, so tests can pass their own. */
export type ThemeStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type ThemeRoot = { setAttribute(name: string, value: string): void; removeAttribute(name: string): void };

/**
 * A stored value back into use: Light or Dark as stored; nothing, a "system" from before #345, or anything unknown
 * is the default.
 */
export function parseTheme(raw: string | null): Theme {
  return raw === 'light' || raw === 'dark' ? raw : DEFAULT_THEME;
}

export function readTheme(store: ThemeStore): Theme {
  try { return parseTheme(store.getItem(THEME_KEY)); } catch { return DEFAULT_THEME; }
}

/** Saves the choice by name, the default too, so a later change of default leaves a person's choice alone. */
export function saveTheme(store: ThemeStore, theme: Theme): void {
  try { store.setItem(THEME_KEY, theme); } catch { /* private mode: kept for this visit only */ }
}

/** Marks the root with the choice. With no mark (before this runs) the stylesheet is dark, so the first paint is dark (#345). */
export function applyTheme(root: ThemeRoot, theme: Theme): void {
  root.setAttribute('data-theme', theme);
}
