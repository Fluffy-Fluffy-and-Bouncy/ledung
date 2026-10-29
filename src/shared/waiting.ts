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
