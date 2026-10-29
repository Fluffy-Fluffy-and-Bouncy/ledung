// Fills in usage for sessions that ran before usage was recorded (step 5): the stored messages hold
// each call's usage. Runs once; records are keyed by call, so running it again changes nothing.
import type { Store } from '../store/store.ts';
import { UsageRecorder, type Trigger } from './recorder.ts';

const DONE = 'usage-backfilled';

/** Returns how many model calls were filled in. */
export function backfillUsage(store: Store): number {
  if (store.getMeta(DONE)) return 0;
  const before = store.usageCount();
  for (const s of store.listSessions()) {
    const recorder = new UsageRecorder();
    const parent = s.parentId ? store.getSession(s.parentId) : undefined;
    const facts = {
      sessionId: s.id, project: s.project, role: s.role,
      team: s.role === 'manager' ? s.id : parent?.role === 'manager' ? parent.id : null,
      branch: null,
    };
    for (const m of store.allMessages(s.id)) {
      if (m.kind === 'user') {
        const trigger: Trigger = m.data.from === 'ledung' ? (m.data.answerTo?.length ? 'answer' : 'ledung') : 'user';
        recorder.startTurn(trigger);
      } else if (m.kind === 'sdk') {
        const out = recorder.feed(m.data, m.at, facts);
        if (out.usage) store.addUsage(out.usage);
      }
    }
  }
  store.setMeta(DONE, new Date().toISOString());
  return store.usageCount() - before;
}
