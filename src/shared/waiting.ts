// What waits for the user: the rule the page's notifications (web/src/notify.ts) and phone push
// (src/server/push.ts, issue #246) share, so both tell about the same items.
import type { PermissionInfo, QuestionInfo } from './protocol.ts';

/** An open question addressed to the user, not one a manager handles. */
export const questionWaits = (q: QuestionInfo): boolean => q.status === 'open' && q.addressedTo === 'user';

/** A pending permission prompt addressed to the user, not one a manager handles. */
export const permissionWaits = (p: PermissionInfo): boolean => p.status === 'pending' && p.addressedTo === 'user';

/** What waits for the user: questions and permission prompts addressed to the user (also the count a linked computer's tab shows, #273). */
export function waitingCount(questions: QuestionInfo[], permissions: PermissionInfo[]): number {
  return questions.filter(questionWaits).length + permissions.filter(permissionWaits).length;
}

/**
 * Where a question goes in Waiting for you ahead of the tiers, highest first: 3 an order's keep-it question (issue #105),
 * 2 a proposed order to confirm (#105), 1 a refused call (issue #104), 0 any other. Shared by the page's queue and the
 * managers' waiting_for_you (issue #338), so both list in one order.
 */
export function waitingFirst(q: Pick<QuestionInfo, 'details'>): number {
  return q.details?.order ? (q.details.order.confirm ? 2 : 3) : q.details?.refusal ? 1 : 0;
}
