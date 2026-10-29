// The `!` prefix in the message box (issue #212): what the page and Ledung both need to know of it.
import type { ShellBlock } from './protocol.ts';

/** The line under a "!" command's block in the chat: how it ended, where it ran, and whether Claude has it. */
export function shellFooter(b: ShellBlock): { text: string; problem: boolean } {
  const ended = b.cut === 'timeout' ? `Cut off: it ran past its time limit (${Math.round(b.durationMs / 1000)} s), and it and everything it started were ended.`
    : b.cut === 'stopped' ? 'Stopped: it and everything it started were ended.'
      : b.cut === 'restart' ? 'Ended by Restart Ledung.'
        : `Exit code ${b.exitCode ?? 'unknown'}.`;
  const parts = [
    ended,
    b.truncated ? 'The output was cut to its first part.' : null,
    `${b.shell} · ${b.cwd} · ${(b.durationMs / 1000).toFixed(1)} s.`,
    b.toClaude ? 'Claude gets it with your next message.' : 'Claude did not get it.',
  ];
  return { text: parts.filter(Boolean).join(' '), problem: !!b.cut || b.exitCode !== 0 || !b.toClaude };
}

/** The command a message-box line runs, or null when it is an ordinary message ("!" alone is one too). */
export function bangCommand(text: string): string | null {
  const t = text.trimStart();
  if (!t.startsWith('!')) return null;
  const command = t.slice(1).trim();
  return command ? command : null;
}

/** The page's ask before a command on the sensitive list runs (decision 3 of #212): "This matches <rule>; run it?". */
export function bangAsk(rule: string): string {
  // A pattern without a suggested name is named "command matches /x/" (sensitive.ts); said once here.
  return `This matches ${rule.replace(/^command matches /, '')}; run it?`;
}

/** Where a "!" command runs, in the box's hint (decision 6 of #212). */
export function bangHint(shell: string, runner: 'local' | 'docker'): string {
  const where = runner === 'docker' ? "in the project's container" : `in ${shell}`;
  return `Runs ${where} in the session's folder. The command and its output go to Claude as context, with no reply, and are kept in the history: don't print secrets.`;
}
