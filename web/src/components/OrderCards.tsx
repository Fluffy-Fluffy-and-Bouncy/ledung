// Orders on record (issue #105): each order with the person's own words, where they said them, the command it allows
// and its status, the process's GOAL.md statuses. The person cancels one here; it then allows nothing.
import { inForce, sourceText, statusText, type OrderInfo } from '../../../src/shared/orders.ts';
import { projectLabel } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';

export function OrderCard({ order, userName, sessionTitle, onOpenSession, run }: {
  order: OrderInfo;
  userName: string;
  sessionTitle: (id: string) => string;
  onOpenSession: (id: string) => void;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const o = order;
  const live = inForce(o) || o.status === 'waiting';
  return (
    <div className={`order-card status-${o.status}`}>
      <div className="order-head">
        <b>Order #{o.id}</b>
        <span className={`pill${live ? '' : ' grey'}`}>{statusText(o, userName)}</span>
        <span className="muted">
          {projectLabel(o.project)} · <button className="link" onClick={() => onOpenSession(o.sessionId)}>{sessionTitle(o.sessionId)}</button>
          {o.awaySince !== null && ' · given while you were away'}
        </span>
      </div>
      <blockquote className="order-words">{o.words}</blockquote>
      <div className="muted order-source">Your words: {sourceText(o)}. Allows {o.match === 'exact' ? 'exactly' : 'the pattern'}, {o.until === 'once' ? 'once' : 'until marked done'}{o.runs ? ` · ran ${o.runs}×` : ''}:</div>
      <pre className="order-command">{o.command}</pre>
      {o.note && o.status !== 'refused' && o.status !== 'dropped' && <div className="muted">Last problem: {o.note}</div>}
      {live && <button className="small" onClick={() => void run(() => api.cancelOrder(o.id))}>Cancel order</button>}
    </div>
  );
}
