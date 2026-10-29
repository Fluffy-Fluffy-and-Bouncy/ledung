// Browser notifications for what waits for the user: the decisions of which items notify, which are new
// and which to close, kept free of the browser so they can be tested.
import type { PermissionInfo, QuestionInfo, UsageStopInfo } from '../../src/shared/protocol.ts';
import { permissionWaits, questionWaits } from '../../src/shared/waiting.ts';

export interface WaitingItem {
  /** Also the notification's tag, so several open tabs don't stack duplicates. */
  id: string;
  sessionId: string;
  title: string;
  body: string;
}

const firstLine = (text: string, max = 140): string => {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** What a permission prompt asks for, in one line. */
function permissionBody(p: PermissionInfo): string {
  const asked = p.input.questions;
  const first = Array.isArray(asked) ? (asked[0] as { question?: unknown } | undefined)?.question : undefined;
  return firstLine(text(first) || p.title || text(p.input.command) || text(p.input.file_path) || p.reason || '');
}

/** The open questions and permission prompts addressed to the user (not those a manager handles). */
export function waitingItems(questions: QuestionInfo[], permissions: PermissionInfo[], sessionTitle: (id: string) => string): WaitingItem[] {
  return [
    ...questions.filter(questionWaits).map((q) => ({
      id: `q${q.id}`,
      sessionId: q.sessionId,
      title: `Question from ${sessionTitle(q.sessionId)}`,
      body: firstLine(q.question),
    })),
    ...permissions.filter(permissionWaits).map((p) => {
      const body = permissionBody(p);
      return {
        id: `p${p.id}`,
        sessionId: p.sessionId,
        title: p.toolName === 'AskUserQuestion' ? `Question from ${sessionTitle(p.sessionId)}` : `Permission: ${p.toolName} in ${sessionTitle(p.sessionId)}`,
        body: p.sensitive ? `Sensitive${body ? `: ${body}` : ''}` : body,
      };
    }),
  ];
}

const WINDOW_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' };

/**
 * A usage stop that holds work (issue #278), once per stop and window: its id carries the window's reset, so the
 * next window's stop is new again. Clicking it opens Settings, where it is lifted or raised.
 */
export function stopItems(stops: UsageStopInfo[]): WaitingItem[] {
  return stops.filter((s) => s.holding).map((s) => ({
    id: `stop:${s.account}:${s.kind}:${s.resetsAt ?? ''}`,
    sessionId: 'settings',
    title: `Usage stop reached: ${WINDOW_NAMES[s.kind] ?? s.kind} ${s.percent}%`,
    body: `New turns${s.account === 'default' ? '' : ` on account ${s.account}`} are held until you lift it in Settings${s.resetsAt ? ' or the window resets' : ''}.`,
  }));
}

/**
 * Compares the waiting items with the ones before. `previous` is null until the first full list has
 * arrived: what is already there then is not new. Items still open after a reconnect are not new either.
 */
export function planNotifications(previous: ReadonlySet<string> | null, items: WaitingItem[]): { show: WaitingItem[]; close: string[]; open: Set<string> } {
  const open = new Set(items.map((i) => i.id));
  if (!previous) return { show: [], close: [], open };
  return { show: items.filter((i) => !previous.has(i.id)), close: [...previous].filter((id) => !open.has(id)), open };
}
