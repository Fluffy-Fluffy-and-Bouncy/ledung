// The stand-in `gh` (issue #513 part 2, docs/steps/project-signature.md "GitHub: the stand-in gh"). A session's
// `gh` script runs this for `gh issue`, `gh pr` and `gh api` only; every other call goes straight to the real gh.
// It signs a new issue, an issue comment, a PR comment and a review when the project has a text for that place,
// records what went out to the session's journal, and otherwise hands the call to the real gh untouched.
//
// It runs inside the session, from a copy in a temp folder (install.ts), so it imports nothing but Node's own
// modules: no other Ledung file is there. It never prints anything of its own: a fault means an unrecorded call
// (its reason in the journal), never a failed one. The signature is a courtesy line, not a security boundary.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The exit code that tells the shell script to run the real gh itself, with the original arguments. */
export const PASS_TO_SHELL = 197;

/** What Ledung writes for a session (install.ts): already filled in, nothing private but the run's name. */
export interface StandInSession {
  /** The real gh: its full path, and in tests the arguments before the call's own. */
  real: string[];
  /** The texts per place, filled in; "" means nothing is added there. `pr` only tells whether a PR got its line. */
  texts: { newIssue: string; issueComment: string; prComment: string; pr: string };
  /** Whether outside posts are recorded (the project's Record outside posts). */
  record: boolean;
  /** The run, for the marker; null outside a run. */
  run: string | null;
}

export type Place = 'newIssue' | 'issueComment' | 'prComment';
export type CallKind = 'issue' | 'issue-comment' | 'issue-edit' | 'pr' | 'pr-comment' | 'pr-review' | 'pr-edit' | 'api';

/** A call worth recording, and where its body would be signed; null: neither (everything else). */
export interface Call {
  kind: CallKind;
  /** The place whose text signs it; null: recorded only (edits, `pr create`, `gh api`, a comment edit). */
  place: Place | null;
  /** The -R/--repo given, if any. */
  repo: string | null;
  /** For `gh api`: the method and path. */
  api?: { method: string; path: string };
}

/** Flags of the issue and pr commands that take a value, so their value isn't read as a flag or a subcommand. */
const VALUE_FLAGS = new Set(['-R', '--repo', '-t', '--title', '-l', '--label', '-p', '--project', '-m', '--milestone', '-T', '--template', '--recover', '-B', '--base', '-H', '--head', '-r', '--reviewer', '-a', '--assignee', '--add-label', '--remove-label', '--add-assignee', '--remove-assignee', '--add-project', '--remove-project', '--add-reviewer', '--remove-reviewer', '-b', '--body', '-F', '--body-file']);
/** In `gh pr review`, -a, -c and -r are switches (approve, comment, request changes), not values. */
const REVIEW_SWITCHES = new Set(['-a', '--approve', '-c', '--comment', '-r', '--request-changes']);

/** A flag's name and its value when written as one argument: "--body=x" → ["--body", "x"], "-bx" → ["-b", "x"]. */
function splitFlag(arg: string): [string, string | null] {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    return eq < 0 ? [arg, null] : [arg.slice(0, eq), arg.slice(eq + 1)];
  }
  if (arg.startsWith('-') && arg.length > 2) return [arg.slice(0, 2), arg.slice(2).replace(/^=/, '')];
  return [arg, null];
}

/** The repo named with -R/--repo, if any. */
function repoOf(args: readonly string[]): string | null {
  let repo: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') break;
    const [name, value] = splitFlag(args[i]!);
    if (name === '-R' || name === '--repo') repo = value ?? args[++i] ?? null;
  }
  return repo;
}

/** The subcommand of `gh issue` or `gh pr`, skipping a -R/--repo given before it. */
function subcommand(args: readonly string[]): { sub: string | null; rest: string[] } {
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-R' || a === '--repo') { i++; continue; }
    if (a.startsWith('-R') || a.startsWith('--repo=')) continue;
    if (a.startsWith('-')) return { sub: null, rest: [] };
    return { sub: a, rest: [...args.slice(1, i), ...args.slice(i + 1)] };
  }
  return { sub: null, rest: [] };
}

/** Whether a flag (by its names) is given among the arguments, before any `--`. */
function hasFlag(args: readonly string[], names: readonly string[], review = false): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') return false;
    const [name, value] = splitFlag(a);
    if (names.includes(name)) return true;
    if (value === null && VALUE_FLAGS.has(name) && !(review && REVIEW_SWITCHES.has(name))) i++;
  }
  return false;
}

/** What a gh call is: recorded or not, and signed where. Reads only the arguments. */
export function classify(args: readonly string[]): Call | null {
  const top = args[0];
  if (top === 'api') return apiCall(args.slice(1));
  if (top !== 'issue' && top !== 'pr') return null;
  const { sub, rest } = subcommand(args);
  const repo = repoOf(args);
  if (!sub) return null;
  // A comment that edits or deletes the last one is an edit: never signed (no second signature on an edited post).
  const editsLast = hasFlag(rest, ['--edit-last', '--delete-last']);
  if (top === 'issue') {
    if (sub === 'create' || sub === 'new') return { kind: 'issue', place: 'newIssue', repo };
    if (sub === 'comment') return { kind: editsLast ? 'issue-edit' : 'issue-comment', place: editsLast ? null : 'issueComment', repo };
    if (sub === 'edit') return { kind: 'issue-edit', place: null, repo };
    return null;
  }
  if (sub === 'create' || sub === 'new') return { kind: 'pr', place: null, repo };
  if (sub === 'comment') return { kind: editsLast ? 'pr-edit' : 'pr-comment', place: editsLast ? null : 'prComment', repo };
  if (sub === 'review') {
    // Signed only as a comment, approval or change request; without one gh asks interactively.
    const kinded = hasFlag(rest, [...REVIEW_SWITCHES], true);
    return { kind: 'pr-review', place: kinded ? 'prComment' : null, repo };
  }
  if (sub === 'edit') return { kind: 'pr-edit', place: null, repo };
  return null;
}

/** `gh api` that writes: an explicit POST, PATCH, PUT or DELETE, or fields without a method (gh then posts). */
export function apiCall(args: readonly string[]): Call | null {
  let method: string | null = null;
  let fields = false;
  let mutation = false;
  let endpoint: string | null = null;
  let repo: string | null = null;
  const valued = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '--input', '-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') { endpoint ??= args[i + 1] ?? null; break; }
    if (!a.startsWith('-') || a === '-') { endpoint ??= a; continue; }
    const [name, inline] = splitFlag(a);
    const value = inline ?? (valued.has(name) ? args[++i] ?? '' : null);
    if (name === '-X' || name === '--method') method = (value ?? '').toUpperCase();
    if (['-f', '--raw-field', '-F', '--field', '--input'].includes(name)) {
      fields = true;
      if (/^query=/.test(value ?? '') && /\bmutation\b/.test(value ?? '')) mutation = true;
    }
    if (name === '-R' || name === '--repo') repo = value;
  }
  if (!endpoint) return null;
  const effective = method ?? (fields ? 'POST' : 'GET');
  // A GraphQL query is a POST too; only a mutation writes.
  const writes = endpoint === 'graphql' ? mutation || (method !== null && method !== 'POST' && method !== 'GET') : ['POST', 'PATCH', 'PUT', 'DELETE'].includes(effective);
  return writes ? { kind: 'api', place: null, repo, api: { method: effective, path: endpoint } } : null;
}

/** Where a call's body comes from: one --body or --body-file, at these argument positions. */
export interface BodySource {
  kind: 'text' | 'file' | 'stdin';
  value: string;
  /** The positions of the flag (and its value when separate) in the arguments. */
  start: number;
  count: number;
}

/** The call's one body source; null when there is none or more than one (gh then decides, unsigned). */
export function bodySource(args: readonly string[], review = false): BodySource | null {
  const found: BodySource[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') break;
    const [name, inline] = splitFlag(a);
    const isBody = name === '-b' || name === '--body';
    const isFile = name === '-F' || name === '--body-file';
    if (isBody || isFile) {
      const value = inline ?? args[i + 1];
      if (value === undefined) return null;
      const count = inline === null ? 2 : 1;
      found.push({ kind: isBody ? 'text' : value === '-' ? 'stdin' : 'file', value, start: i, count });
      i += count - 1;
      continue;
    }
    if (inline === null && VALUE_FLAGS.has(name) && !(review && REVIEW_SWITCHES.has(name))) i++;
  }
  return found.length === 1 ? found[0]! : null;
}

/** The marker that says a body was signed (open to HTML comments on GitHub): no second signature. */
export function marker(run: string | null): string {
  return run ? `<!-- ledung ${run} -->` : '<!-- ledung -->';
}

/** The body signed: the text after a blank line, then the marker; null when it is empty or already signed. */
export function signBody(body: string, text: string, run: string | null): string | null {
  if (!text.trim() || !body.trim()) return null;
  if (body.includes('<!-- ledung')) return null;
  // Signed by hand, or copied from a post Ledung signed where the marker was lost.
  if (body.trimEnd().endsWith(text.trim())) return null;
  return `${body.replace(/\s+$/, '')}\n\n${text}\n${marker(run)}\n`;
}

/** One line of the session's journal (issue #513, for the Outbox in part 4): no body is kept. */
export interface JournalLine {
  at: string;
  kind?: CallKind;
  repo?: string | null;
  url?: string | null;
  api?: { method: string; path: string };
  signed?: boolean;
  /** For `pr create`: whether the body holds the project's PR text (Claude Code adds it). */
  prLine?: boolean;
  exit?: number;
  /** A call the stand-in couldn't handle, passed to the real gh unchanged: why. */
  passedThrough?: string;
}

/** The session's journal, next to its file. */
export const journalOf = (sessionFile: string) => path.join(path.dirname(sessionFile), 'journal.jsonl');

function note(sessionFile: string, line: Omit<JournalLine, 'at'>): void {
  try {
    fs.appendFileSync(journalOf(sessionFile), `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
  } catch {
    // Not writable: the call stays unrecorded, and nothing else changes.
  }
}

interface Plan {
  args: string[];
  /** The stdin the real gh gets: the caller's own, or what the stand-in already read from it. */
  stdin: 'inherit' | Buffer;
  call: Call | null;
  signed: boolean;
  /** The PR body, for whether it got the PR line. */
  prBody?: string | null;
  /** A temporary file with the signed body, removed afterwards. */
  temp?: string;
}

/** Everything the stand-in decides before the real gh runs; throws on anything unexpected (the caller passes through). */
function planCall(args: string[], session: StandInSession, readStdin: () => Buffer): Plan {
  const call = classify(args);
  const plain: Plan = { args, stdin: 'inherit', call: session.record ? call : null, signed: false };
  if (!call) return plain;
  const review = call.kind === 'pr-review';
  if (call.kind === 'pr') {
    const src = bodySource(args);
    plain.prBody = src?.kind === 'text' ? src.value : src?.kind === 'file' ? readText(src.value) : null;
    return plain;
  }
  const text = call.place ? session.texts[call.place] : '';
  if (!text) return plain;
  const src = bodySource(args, review);
  // No body of its own (--fill, --web, --editor, a prompt): passed through, recorded.
  if (!src) return plain;
  let body: string | null;
  let stdin: Plan['stdin'] = 'inherit';
  if (src.kind === 'text') body = src.value;
  else if (src.kind === 'file') body = readText(src.value);
  else {
    const read = readStdin();
    stdin = read;
    body = read.toString('utf8');
  }
  // A file gh can't read either: gh says so itself.
  if (body === null) return { ...plain, stdin };
  const signed = signBody(body, text, session.run);
  if (signed === null) return { ...plain, stdin };
  const temp = path.join(os.tmpdir(), `ledung-gh-body-${crypto.randomBytes(6).toString('hex')}.md`);
  fs.writeFileSync(temp, signed, { encoding: 'utf8', mode: 0o600 });
  const out = [...args.slice(0, src.start), '--body-file', temp, ...args.slice(src.start + src.count)];
  // The body came from stdin and is in the file now: gh gets an empty stdin, as it would after reading it.
  return { args: out, stdin: src.kind === 'stdin' ? Buffer.alloc(0) : 'inherit', call: plain.call, signed: true, temp };
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** How much of gh's output is kept to find the post's link. */
const KEEP = 64 * 1024;

/** Runs the real gh; its exit code, or null when it couldn't be started at all. */
function runReal(session: StandInSession, plan: Plan, keepOutput: boolean): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const [command, ...lead] = session.real;
    // Its output goes to the caller as it comes. It is read through a pipe only when it isn't a terminal, where a
    // pipe changes nothing for gh (Claude Code's shell is never one); on a terminal gh keeps it, and no link is kept.
    const pipeOut = keepOutput && !process.stdout.isTTY;
    let child;
    try {
      child = spawn(command!, [...lead, ...plan.args], { stdio: [plan.stdin === 'inherit' ? 'inherit' : 'pipe', pipeOut ? 'pipe' : 'inherit', 'inherit'] });
    } catch {
      resolve({ code: null, out: '' });
      return;
    }
    let out = '';
    child.stdout?.on('data', (d: Buffer) => {
      process.stdout.write(d);
      if (out.length < KEEP) out += d.toString('utf8');
    });
    if (plan.stdin !== 'inherit') {
      child.stdin?.on('error', () => {});
      child.stdin?.end(plan.stdin);
    }
    // Ctrl-C reaches gh too (same terminal): the stand-in waits for gh's own answer to it.
    const ignore = () => {};
    process.on('SIGINT', ignore);
    process.on('SIGTERM', ignore);
    let started = false;
    child.on('spawn', () => { started = true; });
    child.on('error', () => { if (!started) resolve({ code: null, out: '' }); });
    child.on('close', (code, signal) => {
      process.off('SIGINT', ignore);
      process.off('SIGTERM', ignore);
      if (!started) return;
      const finish = () => resolve({ code: code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1), out });
      // What gh wrote is out before the stand-in exits.
      if (pipeOut && process.stdout.writableLength) process.stdout.once('drain', finish);
      else finish();
    });
  });
}

/**
 * The stand-in: the session's file, then gh's own arguments. Its exit code is the real gh's, or PASS_TO_SHELL when
 * the real gh couldn't be started from here and nothing of the call was used yet, so the shell script runs it.
 */
export async function main(sessionFile: string, args: string[]): Promise<number> {
  let session: StandInSession;
  try {
    session = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as StandInSession;
    if (!Array.isArray(session.real) || !session.real.length || !session.texts) throw new Error('not a session file');
  } catch (e) {
    note(sessionFile, { passedThrough: `session file: ${(e as Error).message}` });
    return PASS_TO_SHELL;
  }
  let read: Buffer | null = null;
  const readStdin = () => (read ??= fs.readFileSync(0));
  let plan: Plan;
  try {
    plan = planCall(args, session, readStdin);
  } catch (e) {
    // Whatever went wrong, the call goes out as it was, with any stdin already read.
    note(sessionFile, { passedThrough: (e as Error).message || String(e) });
    plan = { args, stdin: read ?? 'inherit', call: null, signed: false };
  }
  const { code, out } = await runReal(session, plan, plan.call !== null);
  if (plan.temp) {
    try {
      fs.rmSync(plan.temp, { force: true });
    } catch {
      // Left in the temp folder.
    }
  }
  if (code === null) return read === null ? PASS_TO_SHELL : 1;
  if (plan.call) {
    try {
      const c = plan.call;
      const url = /https:\/\/\S+/.exec(out)?.[0] ?? null;
      const prLine = c.kind === 'pr' && session.texts.pr ? !!plan.prBody?.includes(session.texts.pr) : undefined;
      note(sessionFile, { kind: c.kind, repo: c.repo, url: c.api ? null : url, ...(c.api ? { api: c.api } : {}), signed: plan.signed, ...(prLine === undefined ? {} : { prLine }), exit: code });
    } catch {
      // Recording never changes the answer.
    }
  }
  return code;
}
