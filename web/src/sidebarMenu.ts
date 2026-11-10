// The sidebar's right-click menu (Simon, 2026-11-06): on a chat, session or manager row, and on a project's heading.
// It offers only what makes sense for that row, each item the action the page already has for it. Shift+right-click
// keeps the browser's own menu; a long press opens it on a phone, the menu key or Shift+F10 from the keyboard.
import { EFFORT_LEVELS, MODEL_CHOICES, type EffortLevel, type ModelChoice, type ProjectInfo, type SessionInfo } from '../../src/shared/protocol.ts';

/** In the order the menu shows them. */
export type SessionAction =
  | 'rename' | 'workflow' | 'model' | 'priority' | 'pause' | 'unpause' | 'stop' | 'resume' | 'compact' | 'clear' | 'copyId' | 'archive' | 'stopArchive';
export type GroupAction = 'newSession' | 'newChat' | 'account' | 'settings' | 'workflow' | 'collapseAll' | 'expandAll';

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
 * What a group's heading offers: a project's New session, Account (only with more than one to pick, Simon
 * 2026-11-08), Settings and Workflow, Chats' New chat and Settings, and folding every group at once. The heading has
 * no + or ⚙ of its own any more: they are here. No model: the project's default stays in its Settings (2026-11-06).
 */
export function groupActions(kind: 'project' | 'chats' | 'removed', hasWorkflow: boolean, allFolded: boolean, accountChoices = 0): GroupAction[] {
  return [
    ...(kind === 'project'
      ? ['newSession' as const, ...(accountChoices > 1 ? ['account' as const] : []), 'settings' as const, ...(hasWorkflow ? ['workflow' as const] : [])]
      : []),
    ...(kind === 'chats' ? ['newChat' as const, 'settings' as const] : []),
    allFolded ? 'expandAll' : 'collapseAll',
  ];
}

/** The models offered, the project's default (null) first; one it was started with outside these is listed too, ticked. */
export function modelChoices(requested: string | null): { model: string | null; label: string }[] {
  const offered = [null, ...MODEL_CHOICES].map((m) => ({ model: m, label: m ? m[0]!.toUpperCase() + m.slice(1) : "Project's default" }));
  return requested && !MODEL_CHOICES.includes(requested as ModelChoice) ? [...offered, { model: requested, label: requested }] : offered;
}

/** The effort levels as the page names them (issue #202). */
export const EFFORT_LABEL: Record<EffortLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

/** The efforts offered beside the models, the project's default (null) first. */
export function effortChoices(): { effort: EffortLevel | null; label: string }[] {
  return [null, ...EFFORT_LEVELS].map((e) => ({ effort: e, label: e ? EFFORT_LABEL[e] : "Project's default" }));
}

/** The project's effort for a session of this role, as the server works it out (defaultEffortFor); null: Claude Code's own. */
export function projectEffort(project: Pick<ProjectInfo, 'effort' | 'managerEffort'> | undefined, role: SessionInfo['role']): EffortLevel | null {
  return (role === 'manager' && project?.managerEffort) || project?.effort || null;
}

/**
 * What a session's info says of its effort: the level Claude Code says it runs with once that is known (its first
 * tool call), until then the level it was asked to run with, marked as asked. Null: none asked for and none known.
 */
export function effortShown(s: Pick<SessionInfo, 'effort' | 'requestedEffort'>, projectDefault: EffortLevel | null): { text: string; hint: string } | null {
  if (s.effort) return { text: `effort ${s.effort}`, hint: 'The effort Claude Code runs it with' };
  const asked = s.requestedEffort ?? projectDefault;
  return asked ? { text: `effort ${asked} (asked)`, hint: 'The effort it was asked to run with; its history says which level it got after its first tool call' } : null;
}

/**
 * Where a submenu goes beside its row: to the right of the menu, or to its left when it doesn't fit there; level
 * with its row, moved up so all of it stays on the screen.
 */
export function subMenuPlace(item: { left: number; right: number; top: number }, w: number, h: number, vw: number, vh: number, margin = 4): { left: number; top: number } {
  const left = item.right + w + margin <= vw ? item.right : Math.max(margin, item.left - w);
  const top = Math.max(margin, Math.min(item.top, vh - h - margin));
  return { left, top };
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
