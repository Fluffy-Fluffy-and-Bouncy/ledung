// The `!` prefix in the message box (issue #212, decided 2026-10-18 by Martin, Ledung question #294): the
// person's command runs in the session's folder and its output goes into the conversation as context, in
// Claude Code's own bash-mode form, with no model turn. People only: no manager or session tool runs one.
import { projectFolders, within, type Lockdown } from '../projects/lockdown.ts';
import type { ShellResult } from '../runners/shell-run.ts';
import { SHELL_MAX_CHARS, SHELL_TIMEOUT_MS } from '../runners/shell-run.ts';

/**
 * What Claude gets: what Claude Code's input box adds for a `!` line (`<bash-input>`, then `<bash-stdout>` and
 * `<bash-stderr>`, strings in the bundled claude.exe), in one message. How it ended goes with stderr, as the
 * Bash tool reports a failing command's exit code.
 */
export function bashModeText(command: string, r: Pick<ShellResult, 'stdout' | 'stderr' | 'exitCode' | 'cut' | 'truncated'>, timeoutMs = SHELL_TIMEOUT_MS): string {
  const notes = [
    r.cut === 'timeout' ? `Command timed out after ${Math.round(timeoutMs / 1000)} s; it and everything it started were ended.` : null,
    r.cut === 'stopped' ? 'Command stopped by the user; it and everything it started were ended.' : null,
    r.exitCode !== null && r.exitCode !== 0 ? `Exit code ${r.exitCode}` : null,
    r.truncated ? `[Output cut at ${SHELL_MAX_CHARS} characters per stream.]` : null,
  ].filter(Boolean);
  const stderr = [r.stderr.replace(/\s+$/, ''), ...notes].filter(Boolean).join('\n');
  return `<bash-input>${command}</bash-input>\n<bash-stdout>${r.stdout.replace(/\s+$/, '')}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`;
}

export interface BangProject {
  name: string;
  runner: 'local' | 'docker';
  lockdown: Lockdown;
}

/**
 * Why `!` is refused in a session, or null (decision 5 of #212). A level B project's own sessions: their
 * shell would run outside the sandbox and network rules Claude Code's is kept in. A session of another
 * project on this computer whose folder is inside a locked project's folders, or holds one (a workspace
 * folder above it): Claude Code's deny rules keep the locked folders from its tools (issue #109), but not
 * from a shell Ledung starts, so a `!` there could put a locked project's files into the conversation.
 */
export function bangRefusal(project: BangProject, folder: string, others: { name: string; config: Parameters<typeof projectFolders>[0] }[]): string | null {
  if (project.lockdown.level === 'B') {
    return `"!" commands are off in "${project.name}": it is nearly air-gapped (lockdown level B), and a "!" command would run outside the sandbox and network rules Claude Code works in there.`;
  }
  // A container sees none of this computer's folders.
  if (project.runner !== 'local') return null;
  for (const other of others) {
    if (other.name === project.name) continue;
    const folders = projectFolders(other.config);
    const insideOf = folders.find((f) => within(f, folder));
    const holds = folders.find((f) => within(folder, f));
    if (insideOf || holds) {
      return `"!" commands are off in this session while "${other.name}" is locked: this session's folder ${folder} ${insideOf ? 'is inside' : 'holds'} its folder ${insideOf ?? holds}, and a "!" command runs outside the rules that keep a locked project's files from other sessions.`;
    }
  }
  return null;
}
