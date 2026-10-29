// The page's colour scheme (issue #113): System follows the computer, Light and Dark override it.
// Kept per browser like the page's other choices; the stylesheet does the rest through
// `color-scheme` on the root (styles.css), so a choice switches the page without a reload.

export type Theme = 'system' | 'light' | 'dark';

export const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export const THEME_KEY = 'ledung.theme';

/** The parts of `localStorage` and the root element used here, so tests can pass their own. */
export type ThemeStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type ThemeRoot = { setAttribute(name: string, value: string): void; removeAttribute(name: string): void };

/** A stored value back into use: anything but Light or Dark is System, the default. */
export function parseTheme(raw: string | null): Theme {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function readTheme(store: ThemeStore): Theme {
  try { return parseTheme(store.getItem(THEME_KEY)); } catch { return 'system'; }
}

/** Saves the choice; System is the default, so it removes the entry. */
export function saveTheme(store: ThemeStore, theme: Theme): void {
  try {
    if (theme === 'system') store.removeItem(THEME_KEY);
    else store.setItem(THEME_KEY, theme);
  } catch { /* private mode: kept for this visit only */ }
}

/** Marks the root with the choice; no mark leaves the scheme to the computer. */
export function applyTheme(root: ThemeRoot, theme: Theme): void {
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
