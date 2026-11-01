// Settings' Claude Code (issue #341): which program each running session was started with. Pure helpers,
// kept apart from the component so they can be tested.
import type { ClaudeProgramInfo, SessionInfo } from '../../src/shared/protocol.ts';

export const PROGRAM_KIND: Record<ClaudeProgramInfo['kind'], string> = {
  installed: 'your installed Claude Code',
  path: 'the Claude Code the config names',
  bundled: "the copy that came with Ledung",
};

/** The installed one when it is the Claude desktop app's own copy (#455). */
export const APP_COPY = "the Claude desktop app's own Claude Code";

export interface RunningProgram {
  id: string;
  title: string;
  project: string;
  /** What it runs, in words; a container session runs the container's own. */
  runs: string;
  path: string | null;
  version: string | null;
}

/** Sessions with a Claude Code process now, each with the program it was started with, in the order given. */
export function runningPrograms(sessions: Pick<SessionInfo, 'id' | 'title' | 'project' | 'status' | 'runner' | 'claudeProgram' | 'claudeVersion'>[]): RunningProgram[] {
  return sessions.filter((s) => s.status !== 'ended').map((s) => ({
    id: s.id,
    title: s.title,
    project: s.project,
    runs: s.runner === 'docker' ? "the container's own" : s.claudeProgram ? PROGRAM_KIND[s.claudeProgram.kind] : 'not recorded (started before Ledung recorded it)',
    path: s.runner === 'docker' ? null : s.claudeProgram?.path ?? null,
    version: s.claudeVersion,
  }));
}

/**
 * What Check again says once it has answered (#455): that it did look, when, and what came of it, so a press
 * never passes without a reaction. A banner goes once its problem does; Settings, where all can be well before
 * and after, says so (test review of PR #10).
 */
export function checkAgainNote(still: boolean, at: Date): string {
  const time = [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  return still ? `Checked again at ${time}: still the same.` : `Checked again at ${time}: no problem found.`;
}

/** One piece of a Claude Code problem's text. */
export type ProblemPart = { kind: 'text' | 'code' | 'link'; text: string };

/** A Claude Code problem's text in parts: what to type is between backticks, and an address is a link. */
export function problemParts(text: string): ProblemPart[] {
  return text.split('`').flatMap((part, i): ProblemPart[] => (i % 2
    ? [{ kind: 'code', text: part }]
    : part.split(/(https:\/\/[^\s,)]+[^\s,).])/).filter(Boolean).map((p) => ({ kind: /^https:\/\//.test(p) ? 'link' : 'text', text: p }))));
}
