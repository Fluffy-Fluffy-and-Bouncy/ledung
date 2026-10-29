// Says what a passkey prompt is for before the phone shows it, and offers a retry when a check didn't go
// through (#179). Through the public name a locked phone asks twice in a row (unlock, then sign): without
// this the page showed nothing before either prompt, and a cancel only a small status text.
import { useEffect, useState } from 'react';
import { setPasskeyPrompter, type PasskeyStep } from '../api.ts';
import { passkeyWords } from '../passkeyWords.ts';

type Open = { step: PasskeyStep; answer: (goOn: boolean) => void };

export function PasskeyDialog() {
  // In turn: two changes sent at once each get their own step, and none is left waiting unanswered.
  const [queue, setQueue] = useState<Open[]>([]);
  useEffect(() => {
    setPasskeyPrompter((step) => new Promise<boolean>((resolve) => setQueue((q) => [...q, { step, answer: resolve }])));
    return () => setPasskeyPrompter(null);
  }, []);
  const open = queue[0];
  if (!open) return null;
  const words = passkeyWords(open.step);
  const answer = (goOn: boolean) => {
    setQueue((q) => q.slice(1));
    open.answer(goOn);
  };
  return (
    <div className="passkey-backdrop">
      <div className="passkey-dialog" role="alertdialog" aria-modal="true" aria-labelledby="passkey-title">
        <h3 id="passkey-title">{words.title}</h3>
        {words.body.map((line) => <p key={line}>{line}</p>)}
        <div className="passkey-actions">
          <button onClick={() => answer(false)}>Cancel</button>
          <button className="primary" autoFocus onClick={() => answer(true)}>{words.go}</button>
        </div>
      </div>
    </div>
  );
}
