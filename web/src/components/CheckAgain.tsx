// Check again on the Claude Code and sign-in banners and in Settings (#455): it says it is checking while it
// looks, then what came of it, even when nothing changed; before, an unchanged answer left the page as it was.
import { useState } from 'react';
import { checkAgainNote } from '../claudeProgram.ts';

/** `check` looks again and answers whether the problem is still there. */
export function CheckAgain({ check, primary = true }: { check: () => Promise<boolean>; primary?: boolean }) {
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const press = async () => {
    setChecking(true);
    setNote(null);
    try {
      setNote(checkAgainNote(await check(), new Date()));
    } catch (e) {
      setNote(`Couldn't check: ${(e as Error).message}`);
    } finally {
      setChecking(false);
    }
  };
  return (
    <>
      <button className={primary ? 'small primary' : 'small'} disabled={checking} aria-busy={checking} onClick={() => void press()}>
        {checking ? 'Checking…' : 'Check again'}
      </button>
      {note && <span className="muted" role="status">{note}</span>}
    </>
  );
}
