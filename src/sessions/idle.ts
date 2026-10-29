// Stopping idle sessions (docs/steps/idle-stop-and-archive.md): when a session may be stopped to
// free its Claude Code process. Kept apart from Session so every rule is tested on its own.
import type { SessionInfo } from '../shared/protocol.ts';

/** What Claude Code's Stop hook said at the end of the last turn; kept in the database across restarts. */
export interface IdleFacts {
  /** Background tasks in flight, ambient ones (Monitor, watchers) included. */
  backgroundTasks: number;
  /** Scheduled wake-ups (/loop, ScheduleWakeup, CronCreate); null: this Claude Code doesn't say. */
  crons: number | null;
}

/** A fresh Claude Code process has nothing running in the background and nothing scheduled. */
export const FRESH_FACTS: IdleFacts = { backgroundTasks: 0, crons: 0 };

export interface IdleState {
  info: Pick<SessionInfo, 'role' | 'status' | 'paused'>;
  /** A turn is under way (between its start and its result). */
  turnOpen: boolean;
  pendingPermissions: number;
  openQuestions: number;
  /** Simon's held messages, undelivered answers and inbox messages. */
  waitingDeliveries: number;
  /** Live background tasks, ambient ones included (from background_tasks_changed). */
  backgroundTasks: number;
  facts: IdleFacts | null;
  lastActivity: number;
}

/**
 * Why the session may not be stopped now, or null if it may: a session, between turns, with nothing
 * waiting, nothing in the background, nothing scheduled, and no activity for the whole idle time.
 */
export function idleStopBlocker(s: IdleState, now: number, idleMs: number): string | null {
  if (s.info.role !== 'session') return 'a manager';
  if (s.info.status !== 'idle' && s.info.status !== 'starting') return `status ${s.info.status}`;
  if (s.info.paused) return 'paused';
  if (s.turnOpen) return 'in a turn';
  if (s.pendingPermissions) return 'a permission prompt is waiting';
  if (s.openQuestions) return 'it has an open question';
  if (s.waitingDeliveries) return 'a message is waiting for it';
  if (s.backgroundTasks) return 'background work';
  if (!s.facts) return 'not known whether anything runs in the background';
  if (s.facts.backgroundTasks) return 'background work';
  if (s.facts.crons === null) return 'not known whether anything is scheduled';
  if (s.facts.crons) return 'a wake-up is scheduled';
  if (now - s.lastActivity < idleMs) return 'active recently';
  return null;
}

/**
 * Why a turn that just ended is a pause, not the end of the work (decided 2026-10-13): something still runs in
 * the background (every task, ambient ones included) or is scheduled to wake the session, so Claude Code will
 * start a turn by itself. Null: nothing does, so the session is done or waits for someone. Claude Code's Stop
 * hook (facts) runs before the turn's result; `liveTasks` is the count from background_tasks_changed. A
 * Claude Code that doesn't report its schedule (crons null) counts as nothing scheduled: the manager is woken.
 */
export function pauseReason(liveTasks: number, facts: IdleFacts | null): string | null {
  if (liveTasks > 0 || (facts?.backgroundTasks ?? 0) > 0) return 'background work is still running';
  if ((facts?.crons ?? 0) > 0) return 'a wake-up is scheduled';
  return null;
}

/** "1 h", "90 min", "2 h": for the end reason. */
export function idleLabel(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

export const idleReason = (minutes: number) => `Stopped after ${idleLabel(minutes)} idle.`;
