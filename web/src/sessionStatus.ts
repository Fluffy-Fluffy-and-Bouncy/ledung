// How the page shows a session's status: the label, and the look (colour of its dot and ship).
import type { SessionInfo } from '../../src/shared/protocol.ts';

// 'starting' is a session waiting for its first message (a resumed one waits there until spoken to): it is
// not working, so it reads and looks like an idle one (Martin, 2026-10-15, issue #97).
export const STATUS_LABEL: Record<SessionInfo['status'], string> = {
  starting: 'Ready',
  idle: 'Ready',
  queued: 'Waiting for a free place',
  running: 'Working',
  waiting: 'Needs your answer',
  stopping: 'Stopping',
  ended: 'Ended',
};

/** The class for its dot and ship: a paused session and one waiting for its first message look idle. */
export function statusLook(s: Pick<SessionInfo, 'status' | 'paused'>): SessionInfo['status'] {
  if (s.status === 'starting' || (s.paused && s.status === 'running')) return 'idle';
  return s.status;
}
