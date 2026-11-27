// A project's signature (issue #513, docs/steps/project-signature.md): a text per place that Ledung adds to what
// sessions post in the person's name. Shared by the core (Claude Code's attribution per session) and the page (the
// project's Signature settings), so both read the same default, fill-ins and states.

/** The places a signature goes, in the order the settings show them. */
export const SIGNATURE_PLACES = ['pr', 'commit', 'newIssue', 'issueComment', 'prComment', 'trackers'] as const;
export type SignaturePlace = (typeof SIGNATURE_PLACES)[number];
export type SignatureTexts = Record<SignaturePlace, string>;

export const PLACE_LABELS: Record<SignaturePlace, string> = {
  pr: 'PR descriptions',
  commit: 'Commits',
  newIssue: 'New issues',
  issueComment: 'Issue comments',
  prComment: 'PR comments and reviews',
  trackers: 'Other trackers',
};

/**
 * Ledung's default (open choice 4a, approved 2026-11-27): Ledung's line on PRs, new issues and other trackers, the
 * co-author trailer kept on commits, conversations (comments, reviews) quiet.
 */
export const LEDUNG_DEFAULT_SIGNATURE: SignatureTexts = {
  pr: '— via Ledung for {user}',
  commit: 'Co-Authored-By: {model} <noreply@anthropic.com>',
  newIssue: '— via Ledung for {user}',
  issueComment: '',
  prComment: '',
  trackers: '— via Ledung for {user}',
};

/** The only fill-ins there are: nothing private (session titles, folders, accounts) can be put in a signature. */
export const FILL_INS = ['user', 'project', 'run', 'workflow', 'model'] as const;
export type FillIn = (typeof FILL_INS)[number];
export type FillInValues = Record<FillIn, string>;

/** The longest text a place takes. */
export const SIGNATURE_MAX = 1000;

/** A project's setting as the config keeps it; none: Ledung's default. A place missing from `texts`: its default. */
export interface SignatureSetting {
  off?: boolean;
  texts?: Partial<SignatureTexts>;
}

export type SignatureState = 'default' | 'edited' | 'off';

/** The texts a setting gives each place: Off empties them all. */
export function signatureTexts(setting: SignatureSetting | null | undefined): SignatureTexts {
  if (setting?.off) return emptyTexts();
  return { ...LEDUNG_DEFAULT_SIGNATURE, ...setting?.texts };
}

export function signatureState(setting: SignatureSetting | null | undefined): SignatureState {
  if (setting?.off) return 'off';
  return sameTexts(signatureTexts(setting), LEDUNG_DEFAULT_SIGNATURE) ? 'default' : 'edited';
}

export const emptyTexts = (): SignatureTexts => Object.fromEntries(SIGNATURE_PLACES.map((p) => [p, ''])) as SignatureTexts;

export const sameTexts = (a: SignatureTexts, b: SignatureTexts) => SIGNATURE_PLACES.every((p) => a[p] === b[p]);

/**
 * What is stored for the form's state: nothing while it is Ledung's default, so a later change to the default reaches
 * every project still on it; Off alone; or the edited texts.
 */
export function signatureSettingOf(off: boolean, texts: SignatureTexts): SignatureSetting | undefined {
  if (off) return { off: true };
  return sameTexts(texts, LEDUNG_DEFAULT_SIGNATURE) ? undefined : { texts: { ...texts } };
}

const FILL_IN = /\{([A-Za-z_]+)\}/g;

/** The first fill-in a text names that doesn't exist, as written ("{session}"); null: none. */
export function unknownFillIn(text: string): string | null {
  for (const m of text.matchAll(FILL_IN)) if (!(FILL_INS as readonly string[]).includes(m[1]!)) return m[0];
  return null;
}

/**
 * A place's text filled in. A line that uses a fill-in with no value (outside a run, {run} and {workflow}) is left
 * out, so "Ledung-Run: {run}" never leaves a bare "Ledung-Run:". Empty lines at either end go; the result may be "".
 */
export function fillSignature(text: string, values: FillInValues): string {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let empty = false;
    const filled = line.replace(FILL_IN, (all, name: string) => {
      if (!(FILL_INS as readonly string[]).includes(name)) return all;
      const v = values[name as FillIn];
      if (!v) empty = true;
      return v;
    });
    if (!empty) lines.push(filled.trimEnd());
  }
  const out = lines.join('\n').replace(/^(\s*\n)+/, '').replace(/(\n\s*)+$/, '');
  return out.trim() ? out : '';
}

/**
 * A model id as Claude Code names the model in its own trailer: "claude-opus-5-5" → "Claude Opus 5.5",
 * "claude-haiku-4-5-20251001" → "Claude Haiku 4.5", "claude-3-5-sonnet-20241022" → "Claude Sonnet 3.5", an alias
 * ("sonnet") → "Claude Sonnet". Anything else, or no model: "Claude".
 */
export function modelDisplayName(id: string | null | undefined): string {
  if (!id) return 'Claude';
  // Context-window and provider decorations: "[1m]", "us.anthropic." in front, "-v1:0" or "@20250514" behind.
  const bare = id.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/^.*?(?=claude-)/, '').replace(/(-v\d+(:\d+)?|@\d+)$/, '');
  const word = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  const alias = /^(opus|sonnet|haiku|fable)$/.exec(bare);
  if (alias) return `Claude ${word(alias[1]!)}`;
  const named = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(bare);
  if (named) return `Claude ${word(named[1]!)} ${named[2]}${named[3] ? `.${named[3]}` : ''}`;
  const older = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(bare);
  if (older) return `Claude ${word(older[3]!)} ${older[1]}${older[2] ? `.${older[2]}` : ''}`;
  return 'Claude';
}

/** What a session's signature is worked out from (issue #513): the project's texts or Off, and the fill-ins but the model. */
export interface SignatureLaunch {
  off: boolean;
  texts: SignatureTexts;
  values: Omit<FillInValues, 'model'>;
}

/**
 * Claude Code's `attribution` setting for a session: false when Off (no line at all, Claude Code's included), else the
 * project's commit and PR texts filled in, where an empty text gives no line in that place (checked 2026-11-27 with
 * Claude Code 2.1.319: the session's settings win over the person's and the project's own `attribution`).
 */
export function attributionSetting(launch: SignatureLaunch, model: string): false | { commit: string; pr: string } {
  if (launch.off) return false;
  const values = { ...launch.values, model };
  return { commit: fillSignature(launch.texts.commit, values), pr: fillSignature(launch.texts.pr, values) };
}

/** Whether two settings sign the same way: a change that only reorders or restates the default is none. */
export function sameSignature(a: SignatureSetting | null | undefined, b: SignatureSetting | null | undefined): boolean {
  return !!a?.off === !!b?.off && sameTexts(signatureTexts(a), signatureTexts(b));
}
