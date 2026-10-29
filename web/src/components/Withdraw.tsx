// Withdraw on the question, review and screenshot pages (issue #173): on its own row, away from Send, and it asks
// first. Next to Send with no confirmation, one slip of a thumb on a phone took a question out of the queue.
import { useEffect, useRef, useState } from 'react';

export function Withdraw({ busy, onWithdraw }: { busy: boolean; onWithdraw: () => void }) {
  const [asking, setAsking] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  // The safe choice takes the focus, so an Enter straight after doesn't withdraw.
  useEffect(() => { if (asking) keep.current?.focus(); }, [asking]);
  if (!asking) {
    return (
      <div className="withdraw-row">
        <button className="small" disabled={busy} title="Withdraw it for the asker; it leaves the queue" onClick={() => setAsking(true)}>Withdraw…</button>
      </div>
    );
  }
  return (
    <div className="withdraw-row asking" role="group" aria-label="Withdraw the question">
      <span>Withdraw it for the asker? It leaves the queue.</span>
      <button className="small deny" disabled={busy} onClick={onWithdraw}>Yes, withdraw</button>
      <button ref={keep} className="small" disabled={busy} onClick={() => setAsking(false)}>Keep it</button>
    </div>
  );
}
