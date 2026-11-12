// What a session's ship does, from its status and the sessions it started. Apart from SailingShip.tsx so the tests
// reach it (issue #233).
import type { SessionInfo } from '../../../src/shared/protocol.ts';
import type { Behind } from './shipFrames.ts';

/** clearedAt: when the session was last cleared, so leaving 'clearing' tells a clear from a cancel. */
export type ShipMode = { clearedAt?: number | null } & (
  | { kind: 'working'; followers: number }
  | { kind: 'stopped'; behind: Behind }
  | { kind: 'clearing' }
  | { kind: 'sunk' }
);

/**
 * What a session's ship does: sail while it works (a manager's with one small boat per working session,
 * two at most), stop facing you while it waits or is idle, sink once it has ended. A stopped manager has its
 * fleet gathered beside it while any session it started is still open (working, waiting or idle); when the
 * last one ends the fleet sails off, and resuming one brings it back. Null: no ship (queued). children: the
 * sessions it started, looked up once per list rather than by a scan per row (issue #233).
 */
export function shipMode(session: SessionInfo, children: readonly SessionInfo[]): ShipMode | null {
  // 'starting' is a session waiting for its first message (a resumed one waits there until spoken to), so not working.
  const childrenWorking = children.filter((s) => s.status === 'running').length;
  // Its fleet: the sessions it started that have not ended. When the last one ends, the fleet sails off.
  const childrenActive = children.filter((s) => s.status !== 'ended').length;
  const clearedAt = session.clearedAt;
  if (session.clearDue != null && session.status !== 'ended') return { kind: 'clearing', clearedAt };
  const mode = baseMode();
  return mode && { ...mode, clearedAt };
  function baseMode(): ShipMode | null {
  switch (session.status) {
    case 'running':
      // A paused session keeps its status but does no work: its ship stands like an idle one's.
      if (!session.paused) return { kind: 'working', followers: session.role === 'manager' ? childrenWorking : 0 };
      return { kind: 'stopped', behind: stoppedBehind() };
    case 'stopping':
      return { kind: 'working', followers: session.role === 'manager' ? childrenWorking : 0 };
    case 'starting':
    case 'waiting':
    case 'idle':
      return { kind: 'stopped', behind: stoppedBehind() };
    case 'ended':
      return { kind: 'sunk' };
    default:
      return null;
  }
  }
  // Work still going on behind it, or a manager's fleet gathered beside it once its sessions have finished.
  function stoppedBehind(): Behind {
    return childrenWorking > 0 || session.backgroundTasks > 0 ? 'busy' : session.role === 'manager' && childrenActive > 0 ? 'fleet' : 'none';
  }
}
