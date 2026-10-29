// Away mode on every view (issue #274): set from a phone or another computer's frame, it reached this page but showed
// only beside a manager's ⚙ (#81), so a page open on anything else looked as if it had not changed. A banner above
// every view says so now; a manager's own view keeps its marker instead (manager's decision on question #227).
import type { AwayInfo, SessionInfo } from '../../src/shared/protocol.ts';

/** Whether the away banner shows above the open view: whenever away is on, except on a manager, whose header has it. */
export function awayBannerShown(away: AwayInfo | null, open: Pick<SessionInfo, 'role'> | null): boolean {
  return !!away && open?.role !== 'manager';
}
