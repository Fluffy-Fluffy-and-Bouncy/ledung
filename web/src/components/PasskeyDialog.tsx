// Says what a passkey prompt is for before the phone shows it, and offers a retry when a check didn't go
// through (#179). Through the public name a locked phone asks twice in a row (unlock, then sign): without
// this the page showed nothing before either prompt, and a cancel only a small status text.
import { useCallback, useEffect, useRef, useState } from 'react';
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
  // A browser step's link is open (#463): the dialog waits for the browser's answer.
  const [opened, setOpened] = useState(false);
  const open = queue[0];
  // Each step answered once: by a button, or for a browser step by its answer arriving, whichever comes first.
  const answered = useRef(new WeakSet<Open>());
  const answer = useCallback((goOn: boolean) => {
    if (!open || answered.current.has(open)) return;
    answered.current.add(open);
    setOpened(false);
    setQueue((q) => q.filter((o) => o !== open));
    open.answer(goOn);
  }, [open]);
  // Signed in the browser (#463), or the link ran out: the step closes by itself, and the change goes on (or says why).
  const signed = open?.step.browser?.signed;
  useEffect(() => {
    if (!signed) return;
    const done = () => answer(true);
    signed.then(done, done);
  }, [signed, answer]);
  if (!open) return null;
  const words = passkeyWords(open.step, opened);
  const go = () => {
    // The Mac app (#427): the one-time link opens in the default browser (the app hands it there), where Touch ID works.
    if (open.step.browser) {
      window.open(open.step.browser.url, '_blank', 'noopener');
      setOpened(true);
      return;
    }
    answer(true);
  };
  return (
    <div className="passkey-backdrop">
      <div className="passkey-dialog" role="alertdialog" aria-modal="true" aria-labelledby="passkey-title">
        <h3 id="passkey-title">{words.title}</h3>
        {words.body.map((line) => <p key={line}>{line}</p>)}
        <div className="passkey-actions">
          <button onClick={() => answer(false)}>Cancel</button>
          {words.go && <button className="primary" autoFocus onClick={go}>{words.go}</button>}
        </div>
      </div>
    </div>
  );
}
