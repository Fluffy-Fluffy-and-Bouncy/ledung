// The sidebar's right-click menu (Simon, 2026-11-06): on a chat, session or manager row, and on a project's heading.
// It offers only what makes sense for that row, each item the action the page already has for it. Shift+right-click
// keeps the browser's own menu; a long press opens it on a phone, the menu key or Shift+F10 from the keyboard.
import { MODEL_CHOICES, type ModelChoice, type SessionInfo } from '../../src/shared/protocol.ts';

/** In the order the menu shows them. */
export type SessionAction =
  | 'rename' | 'workflow' | 'model' | 'priority' | 'pause' | 'unpause' | 'stop' | 'resume' | 'compact' | 'clear' | 'copyId' | 'archive' | 'stopArchive';
export type GroupAction = 'newSession' | 'newChat' | 'settings' | 'workflow' | 'collapseAll' | 'expandAll';

type Shown = Pick<SessionInfo, 'role' | 'status' | 'paused' | 'claudeSessionId' | 'archivedAt' | 'compacting' | 'clearDue'>;

/**
 * What a session's, chat's or manager's row offers. A manager is the same minus Archive (it can't be archived), plus
 * its project's workflow when there is one. Priority is a session's only: a manager never waits in line (manager.ts,
 * mayStart), as in its ⚙ menu.
 */
export function sessionActions(s: Shown, hasWorkflow: boolean): SessionAction[] {
  const ended = s.status === 'ended';
  const live = !ended && s.status !== 'stopping';
  // Claude Code's session id: a conversation to resume, compact or clear.
  const talked = !!s.claudeSessionId;
  const busy = !!s.compacting || s.clearDue != null;
  return [
    'rename',
    ...(s.role === 'manager' && hasWorkflow ? ['workflow' as const] : []),
    // Running: from the next reply; ended: for its resume, so only one that can be resumed.
    ...(live || (ended && talked) ? ['model' as const] : []),
    ...(s.role === 'session' && !ended ? ['priority' as const] : []),
    ...(live ? [s.paused ? 'unpause' as const : 'pause' as const, 'stop' as const] : []),
    ...(ended && talked ? ['resume' as const] : []),
    ...(live && talked && !busy ? ['compact' as const, 'clear' as const] : []),
    'copyId',
    // Ended: archived at once, as nothing is deleted; running: stopped first, asked first.
    // Not while starting: a stop then may come before Claude Code is up and leave it unended (review finding 6).
    ...(s.role === 'session' && !s.archivedAt ? (ended ? ['archive' as const] : live && s.status !== 'starting' ? ['stopArchive' as const] : []) : []),
  ];
}

/**
 * What a group's heading offers: a project's New session, Settings and Workflow, Chats' New chat and Settings, and
 * folding every group at once. No model here: the project's default stays in its Settings (Simon, 2026-11-06).
 */
export function groupActions(kind: 'project' | 'chats' | 'removed', hasWorkflow: boolean, allFolded: boolean): GroupAction[] {
  return [
    ...(kind === 'project' ? ['newSession' as const, 'settings' as const, ...(hasWorkflow ? ['workflow' as const] : [])] : []),
    ...(kind === 'chats' ? ['newChat' as const, 'settings' as const] : []),
    allFolded ? 'expandAll' : 'collapseAll',
  ];
}

/** The models offered, the project's default (null) first; one it was started with outside these is listed too, ticked. */
export function modelChoices(requested: string | null): { model: string | null; label: string }[] {
  const offered = [null, ...MODEL_CHOICES].map((m) => ({ model: m, label: m ? m[0]!.toUpperCase() + m.slice(1) : "Project's default" }));
  return requested && !MODEL_CHOICES.includes(requested as ModelChoice) ? [...offered, { model: requested, label: requested }] : offered;
}

/** Whether a key opens the menu on a focused row: the menu key, or Shift+F10 (both the keyboard's way to it). */
export const opensMenu = (e: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean =>
  !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey));

/** The item a key moves the focus to among `count`, wrapping round; null for a key that doesn't move it. */
export function moveFocus(key: string, at: number, count: number): number | null {
  if (!count) return null;
  if (key === 'ArrowDown') return at < 0 ? 0 : (at + 1) % count;
  if (key === 'ArrowUp') return at < 0 ? count - 1 : (at - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/** Where the menu goes: its corner at the point, moved in so all of it stays on the screen. */
export function menuPlace(x: number, y: number, w: number, h: number, vw: number, vh: number, margin = 4): { left: number; top: number } {
  const left = x + w + margin > vw ? Math.max(margin, vw - w - margin) : x;
  // Not enough room below: above the point if it fits there, else as low as it fits.
  const top = y + h + margin <= vh ? y : y - h >= margin ? y - h : Math.max(margin, vh - h - margin);
  return { left, top };
}
