// The sidebar's GitHub line (issue #252): what is left of the budget the pull request poll uses, and how
// the poll runs at it. One line per login and host; nearly always just this computer's on github.com.
import type { GitHubBudget } from '../../src/shared/protocol.ts';

/** "GitHub: 4,210 of 5,000 left until 11:03", with the poll's state when it is slowed or stopped. */
export function githubBudgetLine(b: GitHubBudget, time: (ms: number) => string): string {
  const whose = [b.container, b.host === 'github.com' ? null : b.host].filter(Boolean).join(', ');
  const n = (v: number) => v.toLocaleString('en-US');
  const poll = b.polling === 'slow' ? ' · PRs checked every 10 min' : b.polling === 'stopped' ? ' · PRs not checked until then' : '';
  return `GitHub${whose ? ` (${whose})` : ''}: ${n(b.remaining)} of ${n(b.limit)} left until ${time(b.resetAt)}${poll}`;
}

/**
 * The lines still true at `now`: a reading is published only when a round reads one, so with no session
 * to look up the last one would otherwise stay up, "0 left" in red, past its reset (review of #252, finding 3).
 */
export function githubBudgetsShown(budgets: GitHubBudget[], now: number): GitHubBudget[] {
  return budgets.filter((b) => b.resetAt > now);
}

/** The line's colour class: as the poll's state. */
export function githubBudgetClass(b: GitHubBudget): string {
  return b.polling === 'stopped' ? 'critical' : b.polling === 'slow' ? 'warning' : '';
}
