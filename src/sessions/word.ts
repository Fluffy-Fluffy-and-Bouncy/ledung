// The user's own word for a manager's Settings action (issue #263). Settings' page-only buttons (the relay's
// address and admin key, link codes, inviting a computer) are manager tools too, always the user's to approve,
// unless the user's own words already tell the manager to do that: "it shouldnt differ if I type to you or press
// the buttons myself" (Martin, 2026-10-20).
//
// An allow-list, failing closed by construction (lead's review of #263, round 3): three rounds of word lists for
// holds and doubts each missed a phrasing. Words count only when every part of them is a known instruction form or
// plain filler; anything else, of any kind, and the action asks. Missing an instruction costs one tap; a false
// allow costs a key.

/** Words that hold an action back: such a line or answer never counts as a yes (shared with the merge gate). */
export const HOLDS_BACK = /\b(don'?t|do not|not yet|no\b|hold|wait|later|stop|cancel|close)\b/i;
/** The Settings gate's extra net over the whole of the user's words, behind the allow-list: holds and retractions. */
const RETRACTS = /\b(?:not|never|leave it|second thought|never ?mind|scratch that|forget (?:it|that)|actually|maybe|instead|rather|keep|unless|if)\b/i;

/** The Settings actions, by their tool's short name; each is a sensitive call (SETTINGS_RULE). */
export const SETTINGS_ACTIONS = ['relay_address', 'relay_admin_key', 'link_code', 'link_computer', 'invite_computer'] as const;
export type SettingsAction = typeof SETTINGS_ACTIONS[number];

/** The rule a Settings action's prompt names. */
export const SETTINGS_RULE = 'a Settings action, always yours to approve unless you told your manager to do it';

/** The action a full tool name (mcp__ledung__relay_admin_key) stands for, or null. */
export function settingsAction(toolName: string): SettingsAction | null {
  const m = /^mcp__ledung__(\w+)$/.exec(toolName);
  return m && (SETTINGS_ACTIONS as readonly string[]).includes(m[1]!) ? m[1] as SettingsAction : null;
}

/** An option of the manager's question as the desk shows it: its key, its whole text (label, detail, cost) and the answer its button gives. */
export interface WordOption { key: string; label: string; detail: string; cost: string; answer: string }

/** A piece of the user's own words: what they typed, or their answer to one of the manager's questions. */
export interface Word {
  /** Unique within the session (m<message id>, q<question id>). */
  key: string;
  text: string;
  /** For an answer: the question's options. Its prose and the manager's picks are never read (round 4). */
  ask?: { options: WordOption[] };
}

/** An instruction the allow-list knows, with the arguments it names. */
interface Instruction { action: SettingsAction; relay?: string; code?: string; owner?: string; name?: string }

/** Every part of the user's words: lines, sentences, ";" and "and" / "then" parts, without "please" and end marks. */
export function clauses(text: string): string[] {
  return text.split(/\n|;|(?<=[.!?])\s+|,\s*(?:and\s+)?then\s+|\s+and\s+then\s+|,?\s+and\s+/i)
    .map((c) => c.trim().replace(/[.!]+$/, '').replace(/^(?:(?:please|now|also|then|so)\s+)+/i, '').replace(/\s+(?:please|now)$/i, '').trim())
    .filter(Boolean);
}

/** Parts that say nothing but may stand beside an instruction. */
const FILLER = /^(?:please|thanks|thank you|ok(?:ay)?|go|go ahead|do it|now|tell me (?:its|the) (?:hash|code|join code|link code|results?)|report back)$/i;

const host = (relay: string) => relay.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '').toLowerCase();
/** Words that are never anyone's name, so no line passes as an invite for "a" (review of #263, finding 3). */
const NOT_A_NAME = /^(?:a|an|the|for|to|of|my|me|it|this|that|computer|pc|one|new|please|invite|and|or)$/i;
const NAME = String.raw`[A-Za-z][\w.'-]*`;
const FORMS: [RegExp, (m: RegExpExecArray) => Instruction | null][] = [
  [/^(?:make|create|generate)\s+(?:a\s+|the\s+)?(?:new\s+)?(?:relay\s+)?admin[- ]key(?:\s+for\s+(?:the|my)\s+relay)?$/i, () => ({ action: 'relay_admin_key' })],
  [/^(?:make|create|generate|give me)\s+(?:a\s+|the\s+)?(?:new\s+)?link(?:ing)?[- ]code$/i, () => ({ action: 'link_code' })],
  [/^(?:set|change|point)\s+(?:the\s+)?relay(?:'s)?(?:\s+address)?\s+to\s+(\S+)$/i, (m) => ({ action: 'relay_address', relay: host(m[1]!) })],
  [/^link\s+(?:this\s+computer\s+)?(?:with|to)\s+(\S{10,})(?:\s+(?:as|named|called)\s+"?([^"]{1,60}?)"?)?$/i, (m) => ({ action: 'link_computer', code: m[1]!, name: m[2] })],
  [new RegExp(String.raw`^invite\s+(?:(?:a\s+(?:new\s+)?computer|([\w-]+))\s+for\s+(${NAME}(?:\s${NAME})?)|(${NAME})'s\s+computer)(?:\s+as\s+([\w-]+))?(?:\s+to\s+the\s+relay)?$`, 'i'),
    (m) => {
      const owner = (m[2] ?? m[3])!;
      return owner.length < 2 || NOT_A_NAME.test(owner) ? null : { action: 'invite_computer', owner, name: m[1] ?? m[4] };
    }],
];

/** The instruction a part of the user's words is, or null when it is anything else. */
export function instructionIn(clause: string): Instruction | null {
  for (const [re, make] of FORMS) {
    const m = re.exec(clause);
    if (m) return make(m);
  }
  return null;
}

/** The instruction is for exactly this call: the action, and the arguments as the user gave them. */
function isCall(i: Instruction, action: SettingsAction, input: Record<string, unknown>): boolean {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
  const same = (a: string | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();
  if (i.action !== action) return false;
  switch (action) {
    case 'relay_address': return !!str('relay') && i.relay === host(str('relay'));
    case 'relay_admin_key': case 'link_code': return true;
    case 'link_computer': return same(i.code, str('code')) && (!i.name || same(i.name, str('name')));
    case 'invite_computer': return same(i.owner, str('owner')) && same(i.name, str('name'));
  }
}

/**
 * Whether the user's text tells the manager to run this call: every part of it is a known instruction or filler,
 * one of them is exactly this call, and no hold or retraction stands anywhere in it. Anything else asks.
 */
export function namesAction(action: SettingsAction, input: Record<string, unknown>, text: string): boolean {
  if (HOLDS_BACK.test(text) || RETRACTS.test(text)) return false;
  const parts = clauses(text);
  let found = false;
  for (const c of parts) {
    if (FILLER.test(c)) continue;
    const i = instructionIn(c);
    if (!i) return false;
    if (isCall(i, action, input)) found = true;
  }
  return found;
}

const plainText = (s: string) => s.replace(/\*\*|`/g, '').trim();
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Whether an answer to the manager's question tells it to run this call: the answer is exactly one of its options
 * as a button press sends it (its label or its button's answer, never a bare key, with nothing else but "please" or
 * "thanks"), and that option's whole text, label, detail and cost, is exactly this call. No bare yes, whatever the
 * manager recommended, and no free text (lead's review of #263, rounds 4 and 5): anything else asks.
 */
function answerAllows(action: SettingsAction, input: Record<string, unknown>, w: Word): boolean {
  const answer = w.text.replace(/\(recommended\)/gi, '').trim()
    .replace(/^(?:ok(?:ay)?|please)[,\s]+/i, '').replace(/[,.!\s]+(?:please|thanks|thank you)$/i, '').replace(/[.!]+$/, '').trim();
  // Never a bare key: a manager could key an option "yes" or "ok", and a typed yes would press it (round 5).
  const chosen = w.ask?.options.find((o) => [plainText(o.label), plainText(o.answer).replace(/\(recommended\)/gi, '').trim(), `${o.key} — ${plainText(o.label)}`].some((s) => eq(answer, s)));
  if (!chosen) return false;
  return namesAction(action, input, [chosen.label, chosen.detail, chosen.cost].map(plainText).filter(Boolean).join('\n'));
}

/**
 * Every one of the user's words that tells the manager to run this call. The caller uses up all of them at once,
 * so one instruction said twice (typed, then picked in the manager's question) still runs once (round 1, finding 2).
 */
export function wordsFor(action: SettingsAction, input: Record<string, unknown>, words: Word[]): Word[] {
  return words.filter((w) => (w.ask === undefined ? namesAction(action, input, w.text) : answerAllows(action, input, w)));
}
