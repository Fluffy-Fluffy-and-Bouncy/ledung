// A session's ⚙ menu (issue #81): its settings move behind one cog at the top right of the header,
// where a manager's Away control was. What is urgent or tied to a state stays in the header (lead's
// call on the issue, 2026-10-14): Start now, the clear and compact notices, Resume and
// Archive/Unarchive. Interrupt left the header for the stop sign above Send (issue #89).
import type { SessionInfo } from '../../src/shared/protocol.ts';

/** In the order the menu shows them; a new setting is one more entry here and one block in the menu. */
export type MenuControl = 'away' | 'permissions' | 'priority' | 'toolCalls' | 'usage' | 'pause' | 'stop' | 'version';
export type HeaderControl = 'startNow' | 'clear' | 'compacting' | 'resume' | 'archive';

type Shown = Pick<SessionInfo, 'role' | 'status' | 'clearDue' | 'compacting' | 'claudeSessionId' | 'claudeVersion'>;

/** Which controls a session's ⚙ menu holds and which stay in its header, in the order they are shown. */
export function sessionControls(s: Shown): { menu: MenuControl[]; header: HeaderControl[] } {
  const ended = s.status === 'ended';
  const live = !ended && s.status !== 'stopping';
  const menu: MenuControl[] = [
    ...(s.role === 'manager' ? ['away' as const] : []),
    'permissions',
    ...(s.role === 'session' ? ['priority' as const] : []),
    'toolCalls',
    'usage',
    ...(live ? ['pause' as const, 'stop' as const] : []),
    // Read-only, out of the header's status line (Martin, 15:24 2026-10-14, on issue #81).
    ...(s.claudeVersion ? ['version' as const] : []),
  ];
  const header: HeaderControl[] = [
    ...(s.status === 'queued' ? ['startNow' as const] : []),
    ...(s.clearDue != null && !ended ? ['clear' as const] : []),
    ...(s.compacting && !ended ? ['compacting' as const] : []),
    ...(ended && s.claudeSessionId ? ['resume' as const] : []),
    ...(ended && s.role === 'session' ? ['archive' as const] : []),
  ];
  return { menu, header };
}

/**
 * Whether the menu lists the session's MCP servers (issue #118): only while Claude Code runs, which is
 * what answers. Apart from sessionControls, whose list is pinned by #81's tests.
 */
export const showsMcp = (s: Pick<SessionInfo, 'status'>): boolean => s.status !== 'ended' && s.status !== 'stopping';

/** A server's status in words for the menu; Claude Code's own word for one this page doesn't know. */
export const MCP_STATUS_LABEL: Record<string, string> = {
  connected: 'connected', failed: 'failed', 'needs-auth': 'needs sign-in', pending: 'starting', disabled: 'disabled',
};

/**
 * Whether the stop sign above Send can be pressed: exactly when the header's Interrupt used to show
 * (Martin, 16:10 2026-10-14, issue #89). Otherwise it stays in place, greyed out.
 */
export const canInterrupt = (s: Pick<SessionInfo, 'status'>): boolean => s.status === 'running' || s.status === 'waiting';

/** The part of a KeyboardEvent read here, spelled out so the tests (no DOM types) can pass their own. */
type Key = { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean };

/** What the menu shows next to Show tool calls. */
export const TOOL_CALLS_KEY = 'Ctrl+O';

/**
 * Ctrl+O toggles Show tool calls anywhere on a session's page, the message box included: the key
 * Claude Code uses to expand tool output (lead's choice on issue #81). Ctrl on a Mac too, never ⌘,
 * so ⌘O stays the browser's. By the letter typed, so Dvorak and Colemak get it on their own O and
 * keep Ctrl+R and Ctrl+Y (PR #84 review); by the physical key only where that key types no Latin
 * letter at all (Cyrillic, Greek), which would otherwise have no Ctrl+O.
 */
export const isToolCallsKey = (e: Key): boolean =>
  e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.isComposing &&
  (/^[a-z]$/i.test(e.key) ? e.key.toLowerCase() === 'o' : e.code === 'KeyO');

/**
 * Escape closes an open menu unless it was already marked used. The menu listens in the capture
 * phase, so it hears Escape first and marks it used, and Settings' own Escape (issue #78) leaves it alone.
 */
export const escapeClosesMenu = (e: { key: string; defaultPrevented: boolean; isComposing: boolean }): boolean =>
  e.key === 'Escape' && !e.defaultPrevented && !e.isComposing;
