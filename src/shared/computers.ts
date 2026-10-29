// The computer tabs and the remote frame (issue #232, mockup variant A; docs/steps/relay-home.md). Each computer
// has a name and a colour; a tab opens that computer's own Ledung page at its public name, with its own sign-in.
// The list comes from the config for now; from the relay in a later slice. A name and colour can be changed in the
// page, and this Ledung keeps them over the config's (issue #240).

import { NAME_COLOURS, type NameColour } from './name-colours.ts';

/**
 * The colours a computer may have: the name colours without blue, the accent (lockdown A, focus, links), and red
 * (lockdown B, danger), so the remote frame never looks like a lockdown frame (mockup notes, "Colours"). In the
 * order they are handed out; orange, the nearest to red, last.
 */
export type ComputerColour = Exclude<NameColour, 'blue' | 'red'>;
export const COMPUTER_COLOURS: ComputerColour[] = ['green', 'purple', 'teal', 'amber', 'pink', 'orange'];

/** A computer colour's light and dark values, as the name colours have them (4.5:1 on the page's surfaces). */
export function computerColour(c: ComputerColour): { light: string; dark: string } {
  return NAME_COLOURS[c];
}

/** The longest name a computer may have, in the config and in the page. */
export const COMPUTER_NAME_MAX = 24;

/** A computer as the config lists it (`computers`). */
export interface ComputerSetting {
  name: string;
  colour?: ComputerColour;
  /** Its Ledung's public name (that Ledung's remote.publicName). */
  publicName: string;
  /** Its Ledung's port on that computer (config port); left out: 4317. */
  port?: number;
}

/** A computer as the page shows it. */
export interface ComputerInfo {
  /** Its public name in lower case, which names it for a rename; '' for this computer when it has none. */
  id: string;
  name: string;
  colour: ComputerColour;
  /** Its page, https://<publicName>/; null when its public name is not known (this computer without a relay). */
  url: string | null;
  /** This Ledung's own computer. */
  here: boolean;
  /** Linked with this one (issue #273): its frame can be paired through the link from this computer's own page. */
  linked?: boolean;
  /** How much waits for the user there (issue #273), as that computer told over the link; left out: not known, or offline. */
  waiting?: number;
  /** The name and colour from the config, under any the page changed (issue #240). */
  config: { name: string; colour: ComputerColour };
}

/** A name or colour changed in the page (issue #240); left out: the config's. */
export interface ComputerEdit {
  name?: string;
  colour?: ComputerColour;
}

/** The page's changes by computer id, as this Ledung keeps them. */
export type ComputerEdits = Record<string, ComputerEdit>;

/** This computer's name when the config gives none: its host name, without a ".local" or domain. */
export function shortHostName(host: string): string {
  return host.split('.')[0] || host || 'This computer';
}

/**
 * Every computer: this one first, then the others in the config's order (Martin, 2026-10-20 00:39, issue #240:
 * "I want the current computer to always be on the left most tab"). This one is the entry with its own public name,
 * so the same list can be copied to every computer; when no entry is this one, it is named after its host. An entry
 * with no colour gets the first one nobody has, in the config's order, so a computer has the same colour everywhere.
 */
export function computerList(settings: ComputerSetting[], ownPublicName: string | undefined, host: string): ComputerInfo[] {
  const own = ownPublicName?.toLowerCase();
  const entries: (Omit<ComputerSetting, 'publicName'> & { publicName?: string })[] = [...settings];
  if (!own || !settings.some((s) => s.publicName.toLowerCase() === own)) entries.unshift({ name: shortHostName(host), publicName: own });
  const taken = new Set(entries.flatMap((e) => (e.colour ? [e.colour] : [])));
  const free = COMPUTER_COLOURS.filter((c) => !taken.has(c));
  let next = 0;
  const list = entries.map((e): ComputerInfo => {
    const name = e.publicName?.toLowerCase();
    const colour = e.colour ?? free[next++ % Math.max(free.length, 1)] ?? COMPUTER_COLOURS[0]!;
    return { id: name ?? '', name: e.name, colour, url: name ? `https://${name}/` : null, here: name === own, config: { name: e.name, colour } };
  });
  return [...list.filter((c) => c.here), ...list.filter((c) => !c.here)];
}

const editOf = (edits: ComputerEdits, id: string): ComputerEdit | undefined => (Object.hasOwn(edits, id) ? edits[id] : undefined);

/** The list with the page's names and colours over the config's; an edit for a computer no longer listed is ignored. */
export function withEdits(list: ComputerInfo[], edits: ComputerEdits): ComputerInfo[] {
  return list.map((c) => {
    const e = editOf(edits, c.id);
    return { ...c, name: e?.name ?? c.config.name, colour: e?.colour ?? c.config.colour };
  });
}

/** The edits as kept, read leniently: a name or colour a later version may allow and this one doesn't reads as the config's. */
export function readComputerEdits(raw: string | null): ComputerEdits {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const edits: ComputerEdits = {};
  for (const [id, e] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof e !== 'object' || e === null) continue;
    const { name, colour } = e as Record<string, unknown>;
    const edit: ComputerEdit = {};
    if (typeof name === 'string' && name.trim() && name.trim().length <= COMPUTER_NAME_MAX) edit.name = name.trim();
    if (COMPUTER_COLOURS.includes(colour as ComputerColour)) edit.colour = colour as ComputerColour;
    if (edit.name || edit.colour) edits[id] = edit;
  }
  return edits;
}

/**
 * One computer's name or colour from the page: a name of at most 24 characters, a computer colour, or null (an
 * empty name too) for the config's again. Returns the edits to keep; throws with the reason, for a 400.
 */
export function editComputer(edits: ComputerEdits, list: ComputerInfo[], body: Record<string, unknown>): ComputerEdits {
  const computer = typeof body.id === 'string' ? list.find((c) => c.id === body.id) : undefined;
  if (!computer) throw new Error('No such computer.');
  const edit: ComputerEdit = { ...editOf(edits, computer.id) };
  if (body.name !== undefined) {
    if (body.name !== null && typeof body.name !== 'string') throw new Error('name must be text.');
    const name = (body.name ?? '').trim();
    if (name.length > COMPUTER_NAME_MAX) throw new Error(`A computer's name is at most ${COMPUTER_NAME_MAX} characters.`);
    if (name && name !== computer.config.name) edit.name = name;
    else delete edit.name;
  }
  if (body.colour !== undefined) {
    if (body.colour !== null && !COMPUTER_COLOURS.includes(body.colour as ComputerColour)) throw new Error(`colour is one of ${COMPUTER_COLOURS.join(', ')}.`);
    if (body.colour && body.colour !== computer.config.colour) edit.colour = body.colour as ComputerColour;
    else delete edit.colour;
  }
  const next = { ...edits };
  if (edit.name || edit.colour) next[computer.id] = edit;
  else delete next[computer.id];
  return next;
}

/** The port a computer's Ledung listens on when its entry gives none: Ledung's default. */
export const DEFAULT_PORT = 4317;

/** The other computers in the list: every entry but this Ledung's own (by its public name). */
export function otherComputers(settings: ComputerSetting[], ownPublicName: string | undefined): ComputerSetting[] {
  const own = ownPublicName?.toLowerCase();
  return settings.filter((s) => s.publicName.toLowerCase() !== own);
}

/**
 * The pages that may show this Ledung in a frame (issue #241, docs/steps/computer-tabs-in-page.md): each other
 * computer's page through its public name, and its local page on that computer. Exact origins only, never a wildcard,
 * so no other site can frame this one (no clickjacking of Allow).
 */
export function framingPages(others: ComputerSetting[]): string[] {
  return [...new Set(others.flatMap((c) => {
    const port = c.port ?? DEFAULT_PORT;
    return [`https://${c.publicName.toLowerCase()}`, `http://127.0.0.1:${port}`, `http://localhost:${port}`];
  }))];
}

/**
 * The frames between this Ledung and the other computers' (issue #241): `sources`, their pages this one's page may
 * show (https://<their name>); `ancestors`, the pages that may show this one (framingPages).
 */
export function computerFrames(settings: ComputerSetting[], ownPublicName: string | undefined): { sources: string[]; ancestors: string[] } {
  const others = otherComputers(settings, ownPublicName);
  return { sources: others.map((c) => `https://${c.publicName.toLowerCase()}`), ancestors: framingPages(others) };
}

/** A linked computer as the computer list needs it (#245): its name there, its public name and the port it told. */
export interface LinkedSetting {
  name: string;
  publicName: string;
  port?: number;
}

/**
 * The computers this Ledung knows (issue #273, docs/steps/computer-tabs-link.md part 1): the config's, then every
 * linked computer the config doesn't list, matched by public name. The config wins for name, colour and port; a
 * linked one's colour is the first nobody has, as for a config entry without one.
 */
export function knownComputers(settings: ComputerSetting[], linked: LinkedSetting[]): ComputerSetting[] {
  const listed = new Set(settings.map((s) => s.publicName.toLowerCase()));
  const extra = linked.filter((l) => !listed.has(l.publicName.toLowerCase()))
    // A link's name may be longer than a tab's (40 characters there).
    .map((l): ComputerSetting => ({ name: l.name.slice(0, COMPUTER_NAME_MAX).trim() || l.publicName.split('.')[0]!, publicName: l.publicName.toLowerCase(), ...(l.port ? { port: l.port } : {}) }));
  return [...settings, ...extra];
}
