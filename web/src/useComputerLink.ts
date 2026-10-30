// A tapped push for a linked computer's item (issue #451) opens this page at `#/c/<public name>`: that computer's tab
// shows. The address is put back to this computer's start, so a reload or this computer's own tab doesn't land on that
// computer again. Called before the page's own address handling, so that sees the start, not `#/c/…`.
import { useEffect } from 'react';
import { computerFromHash } from './computerFrame.ts';

/** `show`: shows that computer's tab (App's showComputer); `framed`: this page is in a frame, which shows no tabs. */
export function useComputerLink(show: (id: string) => void, framed: boolean): void {
  useEffect(() => {
    if (framed) return;
    const take = () => {
      const id = computerFromHash(location.hash);
      if (!id) return;
      history.replaceState(history.state, '', location.pathname + location.search);
      show(id);
    };
    take();
    window.addEventListener('hashchange', take);
    return () => window.removeEventListener('hashchange', take);
    // The page's state setters only, which never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
