// Workflow nudges (#405, approved by Martin 2026-10-29, Ledung questions #913 and #915): a workflow's nudgesFile
// names thresholds and words, and Ledung says them on every prompt while they apply, right under "Your context".
// A rule left for the agent to remember is forgotten ("clear yourself at 200k" against a 521k average); the
// thresholds and texts are the workflow's, never Ledung's (repository stays generic). Read at every prompt, but
// parsed again only when the file changes, so an edit counts from the next prompt.
import fs from 'node:fs';
import { z } from 'zod';
import type { SessionRole } from '../shared/protocol.ts';
import { withoutComments } from './profiles.ts';

const Nudge = z.preprocess(withoutComments, z.object({
  role: z.enum(['manager', 'session'], { message: 'role must be "manager" or "session"' }),
  titlePrefix: z.string().min(1).optional(),
  contextAtLeast: z.number().int().positive(),
  // One line under the context line; a short sentence, not a second rules file.
  text: z.string().trim().min(1).max(500).refine((t) => !/[\r\n]/.test(t), 'text must be one line'),
}).strict());

const WorkflowNudgesFile = z.preprocess(withoutComments, z.object({
  version: z.literal(1, { message: 'version must be 1' }),
  nudges: z.array(Nudge),
}));

export type WorkflowNudge = z.infer<typeof Nudge>;

/** A workflow's nudges file as read: its nudges, or what is wrong with it. */
export type WorkflowNudgesRead = { file: string; nudges: WorkflowNudge[]; problem: null } | { file: string; problem: string };

/** Checks a nudges file's text; `file` is only for the messages. */
export function parseWorkflowNudges(file: string, text: string | null): WorkflowNudgesRead {
  if (text === null) return { file, problem: `The workflow's nudges file ${file} was not found.` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { file, problem: `The workflow's nudges file ${file} is not valid JSON: ${(e as Error).message}` };
  }
  const result = WorkflowNudgesFile.safeParse(raw);
  if (!result.success) {
    return { file, problem: `The workflow's nudges file ${file} has problems: ${result.error.issues.map((i) => `${i.path.join('.') || '(top level)'}: ${i.message}`).join('; ')}` };
  }
  return { file, nudges: result.data.nudges, problem: null };
}

// Per file, what was read and the stat it was read at: a prompt costs a stat, not a parse.
const cache = new Map<string, { stamp: string; read: WorkflowNudgesRead }>();

/** Reads a nudges file (a full path), again only when its size or time changed. */
export function readWorkflowNudges(file: string): WorkflowNudgesRead {
  let stamp: string;
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    cache.delete(file);
    return parseWorkflowNudges(file, null);
  }
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.read;
  let text: string | null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = null;
  }
  const read = parseWorkflowNudges(file, text);
  cache.set(file, { stamp, read });
  return read;
}

/**
 * The texts of every nudge that applies now, in the file's order: the session's role, its title's prefix if the
 * nudge names one, and a context at or over the threshold. None until the context has a size, and none again once
 * it is under the threshold (after a clear).
 */
export function matchingNudges(nudges: readonly WorkflowNudge[], s: { role: SessionRole; title: string; contextTokens: number | null }): string[] {
  if (s.contextTokens == null) return [];
  return nudges
    .filter((n) => n.role === s.role && (n.titlePrefix === undefined || s.title.startsWith(n.titlePrefix)) && s.contextTokens! >= n.contextAtLeast)
    .map((n) => n.text);
}

/** What a session is told when its workflow's nudges file can't be used: never a silent nothing (#298 decision 6). */
export function nudgesProblemLine(problem: string, role: SessionRole): string {
  // Only a manager reports it: every worker opening a question about it would be noise (as for the profiles file).
  return `${problem.replace(/\.?$/, '.')} No nudges are shown until it is fixed.${role === 'manager' ? ' Tell whoever you ask (ask_user) once.' : ''}`;
}

/**
 * The lines a prompt gets under "Your context", and the problem the session has now been told of. A problem is
 * told on the first prompt it is seen and again whenever it changes, not on every prompt: a manager told each
 * turn would ask each turn. Once the file is fine again, a later problem is told afresh.
 */
export function promptNudges(
  file: string | null | undefined,
  s: { role: SessionRole; title: string; contextTokens: number | null } | undefined,
  told: string | null,
  read: (file: string) => WorkflowNudgesRead = readWorkflowNudges,
): { lines: string[]; told: string | null } {
  if (!file || !s) return { lines: [], told };
  const r = read(file);
  if (r.problem !== null) return { lines: r.problem === told ? [] : [nudgesProblemLine(r.problem, s.role)], told: r.problem };
  return { lines: matchingNudges(r.nudges, s), told: null };
}
