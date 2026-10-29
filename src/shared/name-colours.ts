// Name colours per project (issue #83): one for its manager's name, one for its sessions'. Only
// colours from this palette can be chosen, so every name stays readable: each has a light and a
// dark value with at least 4.5:1 contrast (WCAG AA for text) against the page's light and dark
// surfaces (test/name-colours.test.ts checks it). Shared by the server, which refuses any other value,
// and the page.

export const NAME_COLOURS = {
  red: { label: 'Red', light: '#b3261e', dark: '#f28b82' },
  orange: { label: 'Orange', light: '#a94600', dark: '#f5a35c' },
  amber: { label: 'Amber', light: '#865d00', dark: '#e6c34d' },
  green: { label: 'Green', light: '#1d7a2c', dark: '#81c995' },
  teal: { label: 'Teal', light: '#00766a', dark: '#4fd1c5' },
  blue: { label: 'Blue', light: '#2457c5', dark: '#8ab4f8' },
  purple: { label: 'Purple', light: '#6d3fb8', dark: '#c3a6ff' },
  pink: { label: 'Pink', light: '#ab2c6b', dark: '#f48fb1' },
} as const;

export type NameColour = keyof typeof NAME_COLOURS;

/**
 * A project's name colours. `manager`: null, no colour. `sessions`: 'same' follows the manager's
 * (the default), 'none' is no colour even when the manager has one.
 */
export interface ProjectColours {
  manager: NameColour | null;
  sessions: NameColour | 'same' | 'none';
}

export const NO_COLOURS: ProjectColours = { manager: null, sessions: 'same' };

export function isNameColour(v: unknown): v is NameColour {
  return typeof v === 'string' && Object.hasOwn(NAME_COLOURS, v);
}

/** Checks a value from the page or the database; throws on anything outside the palette. */
export function parseColours(v: unknown): ProjectColours {
  const o = (v ?? {}) as Record<string, unknown>;
  const manager = o.manager ?? null;
  const sessions = o.sessions ?? 'same';
  if (manager !== null && !isNameColour(manager)) throw new Error('That is not one of the name colours.');
  if (sessions !== 'same' && sessions !== 'none' && !isNameColour(sessions)) throw new Error('That is not one of the name colours.');
  return { manager, sessions };
}

/** One colour, the chats' (issue #222): null or 'none' is no colour; throws on anything outside the palette. */
export function parseNameColour(v: unknown): NameColour | null {
  if (v === null || v === undefined || v === 'none') return null;
  if (!isNameColour(v)) throw new Error('That is not one of the name colours.');
  return v;
}

/** The colour a session's name shows in: its project's manager colour for a manager, else its sessions' colour. */
export function nameColourFor(colours: ProjectColours | undefined, role: 'manager' | 'session'): NameColour | null {
  if (!colours) return null;
  if (role === 'manager') return colours.manager;
  return colours.sessions === 'same' ? colours.manager : colours.sessions === 'none' ? null : colours.sessions;
}
