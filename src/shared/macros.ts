// Macros (issue #410, Martin 2026-10-29 in Ledung question #425: placement B): text a person sends often, as a chip in
// a session's info bar, a keybind, or both, for every project or one. Pure rules shared by the server (what it keeps)
// and the page (the chips, the keys, the form's warnings), so both read a macro the same way.
import { projectLabel, type SessionInfo } from './protocol.ts';

export interface Macro {
  id: string;
  /** The chip's label. */
  name: string;
  text: string;
  /** Sends it at once; false: puts it in the message box. */
  send: boolean;
  /** "Ctrl+Shift+1", modifiers in KEY_MODIFIERS order; null: no keybind. */
  key: string | null;
  /** Shown as a chip; false: keybind only (Martin 2026-10-29 13:46: "I dont want it to have to be a chip to have a macro keybinded"). */
  chip: boolean;
  /** One project's (CHATS for the chats); null: global (Martin 2026-10-29 13:46: "global or per project"). */
  project: string | null;
}

export const MAX_MACROS = 50;
export const MAX_MACRO_NAME = 40;
export const MAX_MACRO_TEXT = 4000;
const KEY_MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Cmd'] as const;
/** A letter or a digit: matched on the physical key (KeyboardEvent.code), so the keyboard layout doesn't change it. */
const KEY_RE = /^(?:(?:Ctrl|Alt|Shift|Cmd)\+)+(?:[A-Z]|[0-9])$/;

export interface KeyPress { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }

/** The keybind a key press makes, or null for a key a macro can't have (not a letter or digit, or no modifier). */
export function keyOf(e: KeyPress): string | null {
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code);
  if (!m) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Cmd'].filter(Boolean);
  if (!mods.length) return null;
  return `${mods.join('+')}+${m[1] ?? m[2]}`;
}

export function validKey(key: string): boolean {
  if (!KEY_RE.test(key)) return false;
  const mods = key.split('+').slice(0, -1);
  // Each once, in order.
  return mods.every((m, i) => i === 0 || KEY_MODIFIERS.indexOf(m as never) > KEY_MODIFIERS.indexOf(mods[i - 1] as never));
}

/** A keybind as a person reads it on this computer: the Mac's symbols there, words elsewhere. */
export function keyLabel(key: string, mac: boolean): string {
  if (!mac) return key;
  const glyph: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘' };
  const parts = key.split('+');
  return parts.slice(0, -1).map((m) => glyph[m] ?? m).join('') + parts[parts.length - 1];
}

/**
 * What stands in a keybind's way. `refused`: it can't be saved, it would not reach Ledung or would take a key someone
 * needs. `warning`: it can be saved, but on some computers it takes a character or doesn't arrive. Every Ledung shares
 * one list, so the rules cover the Mac and Windows both, not only this browser.
 */
export function keyProblem(key: string, macros: Macro[], ownId: string | null): { refused: string } | { warning: string } | null {
  if (!validKey(key)) return { refused: 'A keybind is Ctrl, Alt or Cmd with a letter or a digit.' };
  const mods = new Set(key.split('+').slice(0, -1));
  const k = key.split('+').pop()!;
  const digit = /^[0-9]$/.test(k);
  const other = macros.find((m) => m.key === key && m.id !== ownId);
  if (other) return { refused: `“${other.name}” has this keybind.` };
  if (!mods.has('Ctrl') && !mods.has('Alt') && !mods.has('Cmd')) return { refused: 'Shift alone types; add Ctrl or Alt.' };
  if (mods.has('Cmd')) return { refused: 'Cmd keys belong to the browser and the Mac, and Windows has none.' };
  // AltGr arrives as Ctrl+Alt on Windows: it types @ { [ ] } \ $ on many keyboards, the Swedish among them.
  if (mods.has('Ctrl') && mods.has('Alt')) return { refused: 'Ctrl+Alt is AltGr on Windows, which types @, { and [ on many keyboards.' };
  if (key === 'Ctrl+O') return { refused: 'Ctrl+O shows and hides tool calls in Ledung.' };
  if (mods.has('Ctrl') && !digit) return { refused: `${key} is the browser's or the message box's (new tab, copy, find, developer tools…).` };
  if (mods.has('Ctrl') && !mods.has('Shift')) return { warning: `On Windows and Linux ${key} switches browser tabs: there it does nothing.` };
  if (mods.has('Alt') && !mods.has('Shift') && ['D', 'E', 'F'].includes(k)) return { refused: `${key} opens the browser's menu or address bar on Windows.` };
  if (mods.has('Alt')) {
    return { warning: `On a Mac ⌥ types a character with this key (⌥2 is @ on a Swedish keyboard): the keybind takes it away there.${digit && !mods.has('Shift') ? ' On Linux Alt+1–9 switch browser tabs.' : ''}` };
  }
  return null;
}

/** Keybinds free for a new or changed macro: Ctrl+Shift with a digit types nothing on the Mac or Windows. */
export function freeKeys(macros: Macro[], ownId: string | null, count = 3): string[] {
  const out: string[] = [];
  for (const d of '123456789') {
    const key = `Ctrl+Shift+${d}`;
    if (!keyProblem(key, macros, ownId)) out.push(key);
    if (out.length === count) break;
  }
  return out;
}

/** The macros a session has, in the list's order: the global ones and its project's. */
export function macrosFor(macros: Macro[], project: string): Macro[] {
  return macros.filter((m) => m.project === null || m.project === project);
}

export const PLACEHOLDERS = ['issue', 'branch', 'pr', 'project', 'session'] as const;

/**
 * The text with its placeholders filled from the session. `missing`: placeholders it has no value for, left as written;
 * a macro with one is put in the message box instead of sent, so nothing half-filled goes out.
 */
export function fillMacro(text: string, s: Pick<SessionInfo, 'project' | 'title' | 'branch' | 'pr' | 'tickets'>): { text: string; missing: string[] } {
  const branchIssue = s.branch ? /(?:^|[/_-])(\d+)(?=$|[/_-])/.exec(s.branch)?.[1] : undefined;
  const values: Record<string, string | undefined> = {
    issue: s.tickets[0]?.id ?? (branchIssue ? `#${branchIssue}` : undefined),
    branch: s.branch ?? undefined,
    pr: s.pr ? `#${s.pr.number}` : undefined,
    project: projectLabel(s.project),
    session: s.title,
  };
  const missing: string[] = [];
  const out = text.replace(/\{(issue|branch|pr|project|session)\}/g, (all, name: string) => {
    const v = values[name];
    if (v === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return all;
    }
    return v;
  });
  return { text: out, missing };
}

/**
 * What using a macro does: send it, or put it in the message box. `other` (Shift+click) does the other one. A "!" line
 * always goes to the box, where the shell command's own check runs (#212), and so does one with an unfilled placeholder.
 */
export function macroAction(m: Macro, filled: { text: string; missing: string[] }, other: boolean): 'send' | 'insert' {
  const send = other ? !m.send : m.send;
  if (!send || filled.missing.length || filled.text.trimStart().startsWith('!')) return 'insert';
  return 'send';
}

/** The list with the macro at `from` moved to `to` (Settings' drag and ↑). */
export function moved<T>(list: T[], from: number, to: number): T[] {
  const out = list.slice();
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

/** Why this list can't be kept, or null. The server checks every save; the page shows the same words. */
export function macrosProblem(list: Macro[]): string | null {
  if (list.length > MAX_MACROS) return `At most ${MAX_MACROS} macros.`;
  const ids = new Set<string>();
  const keys = new Map<string, string>();
  for (const m of list) {
    if (!/^[a-z0-9-]{1,40}$/.test(m.id) || ids.has(m.id)) return 'A macro has no id of its own.';
    ids.add(m.id);
    const name = m.name.trim();
    if (!name || name.length > MAX_MACRO_NAME) return `A macro's name is 1 to ${MAX_MACRO_NAME} characters.`;
    if (!m.text.trim() || m.text.length > MAX_MACRO_TEXT) return `“${name}”: the text is 1 to ${MAX_MACRO_TEXT} characters.`;
    if (!m.chip && !m.key) return `“${name}” has neither a chip nor a keybind, so nothing could use it.`;
    if (m.key !== null) {
      const p = keyProblem(m.key, [], null);
      if (p && 'refused' in p) return `“${name}”: ${p.refused}`;
      const other = keys.get(m.key);
      if (other) return `“${name}” and “${other}” have the same keybind.`;
      keys.set(m.key, name);
    }
  }
  return null;
}
