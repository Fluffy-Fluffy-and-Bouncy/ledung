// Away mode (issue #35; decision of 2026-10-13): the user says they are away until HH:MM and allows a
// manager's merges, dev ships or both to go through without them. The sensitive list does not change:
// a manager's sensitive call of an allowed kind runs only when it is exactly one such command and,
// for a merge, every hard floor passes (the PR open, mergeable, no check failing or still running).
// A dev ship may also come from a session its manager started, and carry `cd <path> &&` before it and
// output redirects after it (issue #408). Everything else, and every other call of an ordinary session,
// still waits for the user exactly as before. Every decision away mode makes is recorded in the
// manager's record, for its morning report.
// Computer control (issue #328; Martin, 2026-10-27, question #813: "a"): an allowance that gates nothing,
// only tells managers they may take over this computer. When it ends (Back, the time, or a change that
// drops it), every manager gets a message saying so, so a session driving the computer stops at once.
import type { Store } from '../store/store.ts';
import { AWAY_KINDS, type AwayInfo, type AwayKind, type ServerEvent, type SessionInfo } from '../shared/protocol.ts';

const KEY = 'away';
/** How long a floor check may take (ask-martin's gate uses the same). */
export const FLOOR_TIMEOUT_MS = 20_000;

export const KIND_NAMES: Record<AwayKind, string> = { merge: 'merge', devShip: 'dev ship', computerControl: 'computer control' };
/** The kinds a sensitive call can be; computer control is none of them. */
const gated = (allow: AwayKind[]) => allow.filter((k) => k !== 'computerControl');

/** The next HH:MM from now (tomorrow when it has passed today), as epoch ms. */
export function untilFromHHMM(hhmm: string, now: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('Give the time as HH:MM, like 07:30.');
  const t = new Date(now);
  t.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (t.getTime() <= now) t.setDate(t.getDate() + 1);
  return t.getTime();
}

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const allowedText = (allow: AwayKind[]) => (allow.length ? allow.map((k) => KIND_NAMES[k]).join(', ') : 'nothing');

/** "Martin is away until 08:00; allowed: merge, dev ship." on every manager prompt while away. */
export function awayLine(a: AwayInfo | null, userName: string): string {
  return a ? `${userName} is away until ${hhmm(a.until)}; allowed: ${allowedText(a.allow)}.` : '';
}

/** The away line for a session's prompt: only a manager gets it, never an ordinary session. */
export function promptAwayLine(s: Pick<SessionInfo, 'role'> | undefined, a: AwayInfo | null, userName: string): string {
  return s?.role === 'manager' ? awayLine(a, userName) : '';
}

// ---------------------------------------------------------------- which command it is (pure)

export type Parsed =
  | { kind: 'merge'; pr: number; repo: string | null }
  | { kind: 'devShip' }
  /** shipLike: the dev ship pattern is somewhere in it, but not in a form away mode lets through (issue #408). */
  | { kind: 'other'; why?: string; shipLike?: true };

/**
 * The words of one plain command, or why it is not one: a chain, a pipe, a redirect, a loop or
 * anything the shell would compute (`$`, backticks) can't be judged from its text, so it is held.
 */
export function words(command: string): string[] | { why: string } {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === '$' || ch === '`' || ch === '\\')) return { why: 'it computes part of itself in the shell' };
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; inWord = true; continue; }
    if (ch === '$' || ch === '`' || ch === '\\') return { why: 'it computes part of itself in the shell' };
    if (';&|<>()\n\r{}*?~'.includes(ch)) return { why: 'it is more than one plain command' };
    if (ch === ' ' || ch === '\t') {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
      continue;
    }
    cur += ch;
    inWord = true;
  }
  if (quote) return { why: 'it has an unclosed quote' };
  if (inWord) out.push(cur);
  return out;
}

type Token = { word: string; start: number; end: number } | { op: string; start: number; end: number };

/**
 * Like words, with where each word stands, and the only operators a dev ship may carry (issue #408):
 * `&&` and output redirects (`>`, `>>`, `2>`, `2>&1`). Anything else that chains, pipes or computes refuses.
 */
function shipTokens(command: string): Token[] | { why: string } {
  const out: Token[] = [];
  let cur = '';
  let start = -1;
  let quoted = false;
  let quote: '"' | "'" | null = null;
  const push = (end: number) => {
    if (start >= 0) out.push({ word: cur, start, end });
    cur = '';
    start = -1;
    quoted = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === '$' || ch === '`' || ch === '\\')) return { why: 'it computes part of itself in the shell' };
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      if (start < 0) start = i;
      continue;
    }
    if (ch === '$' || ch === '`' || ch === '\\') return { why: 'it computes part of itself in the shell' };
    if (ch === '&' && command[i + 1] === '&') {
      push(i);
      out.push({ op: '&&', start: i, end: i + 2 });
      i++;
      continue;
    }
    if (ch === '>') {
      // The 2 of 2> belongs to the redirect, not to a word; so would a 5 of 5>, which the shell would not
      // pass to the ship, so the text the pattern matched would not be what runs (review 1 of PR #409).
      let from = i;
      let op = '>';
      if (start >= 0 && !quoted && /^\d+$/.test(cur) && cur !== '1' && cur !== '2') return { why: `it redirects file descriptor ${cur}` };
      if (start >= 0 && !quoted && (cur === '1' || cur === '2')) {
        from = start;
        op = cur + op;
        cur = '';
        start = -1;
      } else push(i);
      let j = i + 1;
      if (command[j] === '>') op += command[j++];
      else if (command[j] === '&') {
        if ((command[j + 1] !== '1' && command[j + 1] !== '2') || (j + 2 < command.length && !/\s/.test(command[j + 2]!))) return { why: 'it is more than one plain command' };
        op += command.slice(j, j + 2);
        j += 2;
      }
      out.push({ op, start: from, end: j });
      i = j - 1;
      continue;
    }
    if (';&|<>()\n\r{}*?~'.includes(ch)) return { why: 'it is more than one plain command' };
    if (ch === ' ' || ch === '\t') {
      push(i);
      continue;
    }
    if (start < 0) start = i;
    cur += ch;
  }
  if (quote) return { why: 'it has an unclosed quote' };
  push(command.length);
  return out;
}

/** What a held dev ship should change to go through (issue #408). */
export const SHIP_FORM = 'send it as one plain command, with an optional `cd <path> &&` before it and an output redirect (`> file`, `2> file`, `2>&1`) after it';

/**
 * The dev ship itself, out of `cd <path> && <ship> > file 2>&1` (issue #408; Martin, 2026-10-29: "in away mode
 * shipping to dev is free"): the text the pattern must match in full, or why the command is not that shape.
 */
export function shipCore(command: string): { core: string } | { why: string } {
  const t = shipTokens(command);
  if (!Array.isArray(t)) return t;
  const word = (i: number) => { const x = t[i]; return x && 'word' in x ? x.word : null; };
  const op = (i: number) => { const x = t[i]; return x && 'op' in x ? x.op : null; };
  let from = 0;
  let to = t.length;
  if (word(0) === 'cd' && word(1) !== null && op(2) === '&&') from = 3;
  // Redirects at the end: 2>&1, or > / >> / 2> to one plain file.
  for (;;) {
    const last = op(to - 1);
    if (to - 1 > from && last?.includes('>&')) to -= 1;
    else if (to - 2 > from && word(to - 1) !== null && op(to - 2)?.includes('>') && !op(to - 2)!.includes('&')) to -= 2;
    else break;
  }
  const body = t.slice(from, to);
  if (!body.length || body.some((x) => 'op' in x)) return { why: 'it is more than one plain command' };
  return { core: command.slice(body[0]!.start, body.at(-1)!.end) };
}

/** The pattern found anywhere in the command, its own ^ and $ aside: it looks like a dev ship (issue #408). */
function shipLike(command: string, pattern: string): boolean {
  try {
    return new RegExp(pattern.replace(/^\^/, '').replace(/(?<!\\)\$$/, ''), 'i').test(command);
  } catch {
    return false;
  }
}

const REPO = /^(?:[\w.-]+\/)?[\w.-]+\/[\w.-]+$/;
// gh pr merge's options that take a value, and the ones that don't, that away mode lets through.
// --admin (past branch protection) and --auto (judged later, not now) are held; so is anything unknown.
const WITH_VALUE = new Set(['-R', '--repo', '-t', '--subject', '-b', '--body', '--match-head-commit', '-A', '--author-email']);
const FLAGS = new Set(['-s', '--squash', '-m', '--merge', '-r', '--rebase', '-d', '--delete-branch']);

function parseMerge(w: string[]): Parsed {
  let pr: number | null = null;
  let repo: string | null = null;
  let linked: string | null = null;
  for (let i = 3; i < w.length; i++) {
    const a = w[i]!;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (WITH_VALUE.has(flag)) {
      const value = eq > 0 ? a.slice(eq + 1) : w[++i];
      if (value === undefined) return { kind: 'other', why: `${flag} has no value` };
      if (flag === '-R' || flag === '--repo') {
        if (!REPO.test(value)) return { kind: 'other', why: `the repository "${value}" is not owner/name` };
        repo = value;
      }
      continue;
    }
    if (FLAGS.has(a)) continue;
    if (a.startsWith('-')) return { kind: 'other', why: `away mode does not let ${a} through` };
    if (pr !== null) return { kind: 'other', why: 'it names more than one pull request' };
    const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/.exec(a);
    if (url) {
      pr = Number(url[2]);
      linked = url[1]!;
    } else if (/^\d+$/.test(a)) pr = Number(a);
    else return { kind: 'other', why: `"${a}" is not a pull request number` };
  }
  if (pr === null) return { kind: 'other', why: 'it names no pull request number' };
  if (repo && linked && repo.toLowerCase() !== linked.toLowerCase()) return { kind: 'other', why: 'its -R and its link name different repositories' };
  return { kind: 'merge', pr, repo: repo ?? linked };
}

/** Which kind of away-allowable command this is: one `gh pr merge <n>`, the project's dev ship, or other. */
export function classify(command: string, devShipPattern?: string | null): Parsed {
  const w = words(command);
  if (/\bgh\s+pr\s+merge\b/.test(command)) {
    if (!Array.isArray(w)) return { kind: 'other', why: w.why };
    if (w[0] !== 'gh' || w[1] !== 'pr' || w[2] !== 'merge') return { kind: 'other', why: 'it is not a plain gh pr merge' };
    return parseMerge(w);
  }
  if (devShipPattern) {
    // The whole command, never a part: a part would let a force-push that mentions it through (review 1, PR #42).
    // Only an optional `cd <path> &&` before it and output redirects after it are set aside (issue #408).
    const shape = shipCore(command);
    if ('core' in shape && new RegExp(`^(?:${devShipPattern})$`, 'i').test(shape.core)) return { kind: 'devShip' };
    if (shipLike(command, devShipPattern)) {
      const why = 'why' in shape ? shape.why : "it is not the project's dev ship command in full";
      return { kind: 'other', why: `${why}; ${SHIP_FORM}`, shipLike: true };
    }
  }
  if (!Array.isArray(w)) return { kind: 'other', why: w.why };
  return { kind: 'other' };
}

// ---------------------------------------------------------------- the floors (pure)

export interface Floor {
  floor: string;
  ok: boolean;
  detail: string;
}

interface CheckItem {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** The hard floors for a merge, from `gh pr view --json state,mergeable,statusCheckRollup`. */
export function floorsOf(pr: number, json: string): Floor[] {
  let v: { state?: string; mergeable?: string; statusCheckRollup?: CheckItem[] };
  try {
    v = JSON.parse(json);
  } catch {
    return [{ floor: 'readable', ok: false, detail: `PR #${pr}: GitHub's answer could not be read` }];
  }
  const failing: string[] = [];
  const pending: string[] = [];
  const checks = v.statusCheckRollup ?? [];
  for (const c of checks) {
    const name = c.name || c.context || 'a check';
    if (c.__typename === 'StatusContext' || (c.state && !c.status)) {
      if (c.state === 'PENDING' || c.state === 'EXPECTED') pending.push(name);
      else if (c.state !== 'SUCCESS') failing.push(name);
    } else if (c.status !== 'COMPLETED') pending.push(name);
    // An unknown conclusion counts as failing: a floor fails closed.
    else if (!GREEN.has(c.conclusion ?? '')) failing.push(name);
  }
  const state = (v.state ?? 'UNKNOWN').toUpperCase();
  const mergeable = (v.mergeable ?? 'UNKNOWN').toUpperCase();
  return [
    { floor: 'open', ok: state === 'OPEN', detail: state === 'OPEN' ? 'open' : `PR #${pr} is ${state.toLowerCase()}` },
    {
      floor: 'mergeable', ok: mergeable === 'MERGEABLE',
      detail: mergeable === 'MERGEABLE' ? 'mergeable'
        : mergeable === 'CONFLICTING' ? `PR #${pr} has merge conflicts` : `GitHub has not confirmed PR #${pr} merges clean (${mergeable.toLowerCase()})`,
    },
    { floor: 'no failing checks', ok: !failing.length, detail: failing.length ? `failing checks: ${failing.join(', ')}` : 'no failing checks' },
    {
      floor: 'no checks running', ok: !pending.length,
      detail: pending.length ? `checks still running: ${pending.join(', ')}` : checks.length ? `${checks.length} check${checks.length === 1 ? '' : 's'} green` : 'no checks at all',
    },
  ];
}

// ---------------------------------------------------------------- the decision

export interface AwayDecision {
  kind: AwayKind | 'other';
  allowed: boolean;
  /** For the record, the page and the session: why it went through or was held. */
  reason: string;
  pr: number | null;
  repo: string | null;
  floors: Floor[];
}

/** `gh pr view <n> [-R repo] --json <fields>` where the session runs: its output, or why there is none. */
export type ViewPr = (pr: number, repo: string | null, fields: string) => Promise<{ json: string } | { error: string }>;

export const PR_FLOOR_FIELDS = 'state,mergeable,statusCheckRollup';

/**
 * What away mode says about a manager's sensitive Bash call, or about a dev ship (or what looks like one)
 * from a session its manager started (issue #408). Never called for an ordinary session's other calls.
 */
export async function decide(a: AwayInfo, userName: string, command: string, devShip: string | null | undefined, viewPr: ViewPr): Promise<AwayDecision> {
  const p = classify(command, devShip);
  const held = (reason: string, extra: Partial<AwayDecision> = {}): AwayDecision =>
    ({ kind: p.kind, allowed: false, reason: `held for ${userName}: ${reason}`, pr: null, repo: null, floors: [], ...extra });
  if (p.kind === 'other') {
    if (p.shipLike) {
      return held(a.allow.includes('devShip') ? `${userName} is away, and this is not a dev ship away mode lets through: ${p.why}` : `${userName} is away and did not allow dev ship`);
    }
    return held(p.why ? `${userName} is away, and away mode can't judge this command: ${p.why}` : `${userName} is away and only ${allowedText(gated(a.allow))} can run without them`);
  }
  if (!a.allow.includes(p.kind)) return held(`${userName} is away and did not allow ${KIND_NAMES[p.kind]}`);
  if (p.kind === 'devShip') {
    return { kind: 'devShip', allowed: true, reason: `Allowed by away mode: ${userName} allowed dev ship, and this is the project's dev ship command`, pr: null, repo: null, floors: [] };
  }
  const where = { pr: p.pr, repo: p.repo };
  const view = await viewPr(p.pr, p.repo, PR_FLOOR_FIELDS);
  if ('error' in view) {
    return held(`PR #${p.pr} could not be read (${view.error})`, { ...where, floors: [{ floor: 'readable', ok: false, detail: view.error }] });
  }
  const floors = floorsOf(p.pr, view.json);
  const failed = floors.filter((f) => !f.ok);
  if (failed.length) return held(failed.map((f) => f.detail).join('; '), { ...where, floors });
  return { kind: 'merge', allowed: true, reason: `Allowed by away mode: PR #${p.pr} ${floors.map((f) => f.detail).join(', ')}`, ...where, floors };
}

// ---------------------------------------------------------------- the state and the record

export interface AwayRecord {
  id: number;
  at: number;
  sessionId: string;
  kind: string;
  command: string;
  pr: number | null;
  repo: string | null;
  floors: Floor[];
  allowed: boolean;
  reason: string;
}

/** What a period was set to before a change made while away (issue #328). */
interface Change {
  at: number;
  until: number;
  allow: AwayKind[];
}

interface Stored extends AwayInfo {
  /** Set by Back; a period that ran to its time has none. */
  endedAt?: number;
  /** Earlier settings of this period, oldest first: away set again while away changes it. */
  changes?: Change[];
  /** The managers were told this period ran out with computer control on; told once, across restarts. */
  endNoted?: boolean;
}

const STOP_DRIVING = 'Stop driving this computer now (mouse, keyboard, programs you started) and tell your sessions that do';

/** "merge and dev ship wait for Martin again", or nothing when neither was allowed. */
function waitAgain(allow: AwayKind[], userName: string): string {
  const g = gated(allow).map((k) => KIND_NAMES[k]);
  return g.length ? `${g.join(' and ')} wait${g.length === 1 ? 's' : ''} for ${userName} again` : '';
}

const sentence = (head: string, ...parts: string[]) => `Ledung: ${head}: ${parts.filter(Boolean).join('; ')}.`;

/** What every manager is told when the user presses Back (issue #328). */
export function backText(a: AwayInfo, userName: string, at: number): string {
  const head = `${userName} is back (pressed Back at ${hhmm(at)})`;
  return a.allow.includes('computerControl')
    ? sentence(head, `computer control ended. ${STOP_DRIVING}`, waitAgain(a.allow, userName))
    : sentence(head, 'away mode ended', waitAgain(a.allow, userName));
}

/** What every manager is told when a period with computer control runs out (issue #328); none without it. */
export function ranOutText(a: AwayInfo, userName: string): string {
  return sentence(`${userName}'s away time ended at ${hhmm(a.until)}`, `computer control ended. ${STOP_DRIVING}`, waitAgain(a.allow, userName));
}

/** What every manager is told when a change while away drops computer control (issue #328). */
export function droppedText(a: AwayInfo, userName: string, at: number): string {
  return sentence(`${userName} changed away mode at ${hhmm(at)}`, `computer control ended. ${STOP_DRIVING}`, `${userName} is still away until ${hhmm(a.until)}; allowed: ${allowedText(a.allow)}`);
}

/** away_log's line about the last period: when it ran, how it ended, what was allowed, and its changes. */
export function periodText(s: Stored | null, now: number): string {
  if (!s) return '';
  const end = s.endedAt ? `${hhmm(s.endedAt)}, ended early by Back`
    : now >= s.until ? `${hhmm(s.until)}, ran to its time` : `${hhmm(s.until)}, still on`;
  return [
    `Last away period: ${hhmm(s.since)}–${end}; allowed: ${allowedText(s.allow)}.`,
    ...(s.changes ?? []).map((c) => `  Changed at ${hhmm(c.at)}; before that: until ${hhmm(c.until)}, allowed: ${allowedText(c.allow)}.`),
  ].join('\n');
}

export interface AwayOptions {
  userName: string;
  /** Tells every manager (issue #328). */
  notify: (text: string) => void;
}

/** The away state, kept in the database so it survives a restart, and the record of decisions. */
export class Away {
  private readonly store: Store;
  private readonly publish: (event: ServerEvent) => void;
  private readonly opts: AwayOptions | undefined;
  private timer: NodeJS.Timeout | null = null;

  constructor(store: Store, publish: (event: ServerEvent) => void, opts?: AwayOptions) {
    this.store = store;
    this.publish = publish;
    this.opts = opts;
  }

  /**
   * Arms the timer for a period stored before a restart. Called once the surviving sessions are attached
   * and the rest marked ended: a note sent earlier woke no idle manager and reached dead ones (review 1 of #328).
   */
  begin(): void {
    this.schedule();
  }

  private notify(text: (userName: string) => string): void {
    if (this.opts) this.opts.notify(text(this.opts.userName));
  }

  /** The last period, ended or not. */
  private stored(): Stored | null {
    const raw = this.store.getMeta(KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Stored;
    } catch {
      // Unreadable state must not let anything through: treat it as off.
      return null;
    }
  }

  /** The user is away now: until has not passed and Back was not pressed. */
  current(now = Date.now()): AwayInfo | null {
    const s = this.stored();
    if (!s || s.endedAt || now >= s.until) return null;
    return { since: s.since, until: s.until, allow: s.allow };
  }

  /** Away until HH:MM; while away already, a change of the same period (Martin, 2026-10-27, question #813). */
  start(until: string, allow: AwayKind[], now = Date.now()): AwayInfo {
    const kinds = AWAY_KINDS.filter((k) => allow.includes(k));
    const prev = this.current(now) ? this.stored() : null;
    const a: AwayInfo = { since: prev?.since ?? now, until: untilFromHHMM(until, now), allow: kinds };
    const stored: Stored = prev ? { ...a, changes: [...(prev.changes ?? []), { at: now, until: prev.until, allow: prev.allow }] } : a;
    this.store.setMeta(KEY, JSON.stringify(stored));
    this.changed();
    if (prev?.allow.includes('computerControl') && !kinds.includes('computerControl')) this.notify((u) => droppedText(a, u, now));
    return a;
  }

  /** Back: away mode ends now. */
  end(now = Date.now()): void {
    const s = this.stored();
    if (!s || s.endedAt || now >= s.until) return;
    this.store.setMeta(KEY, JSON.stringify({ ...s, endedAt: now }));
    this.changed();
    this.notify((u) => backText(s, u, now));
  }

  /** The period's time has come: with computer control, every manager is told, once. */
  private ranOut(): void {
    const s = this.stored();
    if (s && !s.endedAt && !s.endNoted && Date.now() >= s.until && s.allow.includes('computerControl')) {
      this.store.setMeta(KEY, JSON.stringify({ ...s, endNoted: true }));
      this.notify((u) => ranOutText(s, u));
    }
    this.changed();
  }

  private changed(): void {
    this.schedule();
    this.publish({ type: 'away', away: this.current() });
  }

  /**
   * Tells the page when the period ends by itself, and the managers when it had computer control: also
   * when Ledung was not running at the time, so right after a restart.
   */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const s = this.stored();
    if (!s || s.endedAt || s.endNoted) return;
    if (Date.now() >= s.until && !s.allow.includes('computerControl')) return;
    // setTimeout holds at most about 24.8 days; a period ends within one.
    this.timer = setTimeout(() => this.ranOut(), Math.max(0, s.until - Date.now()) + 50);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  record(sessionId: string, command: string, d: AwayDecision, now = Date.now()): void {
    this.store.addAwayRecord({ at: now, sessionId, kind: d.kind, command, pr: d.pr, repo: d.repo, floors: d.floors, allowed: d.allowed, reason: d.reason });
  }

  /** The decisions on this session's calls since `since` (default: the start of the last period). */
  log(sessionId: string, since?: number): { since: number | null; records: AwayRecord[] } {
    const from = since ?? this.stored()?.since ?? null;
    return { since: from, records: from === null ? [] : this.store.awayRecords(sessionId, from) };
  }

  /** The last period for away_log (issue #328). */
  period(now = Date.now()): string {
    return periodText(this.stored(), now);
  }
}

/** away_log's text for the manager. */
export function formatLog(log: { since: number | null; records: AwayRecord[] }, a: AwayInfo | null, userName: string, period = ''): string {
  const head = [a ? awayLine(a, userName) : `${userName} is not away now.`, period].filter(Boolean).join('\n');
  if (log.since === null) return `${head}\nNo away period has been set yet, so nothing is recorded.`;
  const since = new Date(log.since).toString();
  if (!log.records.length) return `${head}\nNo sensitive call of yours was decided by away mode since ${since}.`;
  const lines = log.records.map((r) => [
    `- ${new Date(r.at).toString()}: ${r.allowed ? 'ALLOWED' : 'HELD'} · ${r.kind === 'other' ? 'other' : KIND_NAMES[r.kind as AwayKind]}${r.pr !== null ? ` · PR #${r.pr}${r.repo ? ` (${r.repo})` : ''}` : ''}`,
    `  command: ${r.command}`,
    ...(r.floors.length ? [`  floors: ${r.floors.map((f) => `${f.ok ? 'pass' : 'FAIL'} ${f.detail}`).join('; ')}`] : []),
    `  ${r.reason}`,
  ].join('\n'));
  return `${head}\nAway-mode decisions on your sensitive calls since ${since} (${log.records.length}):\n${lines.join('\n')}`;
}
