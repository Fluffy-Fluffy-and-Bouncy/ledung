// The sidebar's right-click menu (Simon, 2026-11-06), drawn over the page at the point it was opened. A menu with
// menu roles: the arrow keys, Home and End move between items, Enter or Space picks one, Escape and Tab close it.
// What asks first (Stop and archive, Clear context) turns the menu into its question, with the yes and a Cancel.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { menuPlace, moveFocus } from '../sidebarMenu.ts';

export type MenuEntry =
  | { kind: 'item'; label: string; hint?: string; onPick: () => void; ask?: { question: string; yes: string } }
  | { kind: 'radio'; label: string; checked: boolean; onPick: () => void }
  | { kind: 'group'; label: string; entries: MenuEntry[] }
  | { kind: 'separator' };

const ITEMS = '[role="menuitem"], [role="menuitemradio"]';

export function RowMenu({ label, x, y, entries, onClose }: {
  /** What the menu is for, read out by a screen reader. */
  label: string;
  x: number;
  y: number;
  entries: MenuEntry[];
  /** refocus: closed from the keyboard, so the focus goes back to the row. */
  onClose: (refocus: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [asking, setAsking] = useState<{ question: string; yes: string; onPick: () => void } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // The browser's own menu event that follows the menu key or Shift+F10 lands on the menu once it has the focus.
  const openedAt = useRef(Date.now());

  // Measured before it is shown, so it opens where it fits rather than jumping there.
  useLayoutEffect(() => {
    const r = box.current!.getBoundingClientRect();
    setPlace(menuPlace(x, y, r.width, r.height, window.innerWidth, window.innerHeight));
  }, [x, y, asking]);

  // Once placed: a hidden menu can't take the focus.
  const placed = place !== null;
  useEffect(() => {
    if (placed) box.current?.querySelector<HTMLElement>(ITEMS)?.focus();
  }, [placed, asking]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) closeRef.current(false); };
    // Capture, so Escape closes the menu before Settings or anything else hears it (issue #78).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Tab') return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current(true);
    };
    const onAway = () => closeRef.current(false);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onAway);
    window.addEventListener('blur', onAway);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onAway);
      window.removeEventListener('blur', onAway);
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const items = [...box.current!.querySelectorAll<HTMLElement>(ITEMS)];
    const next = moveFocus(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (next === null) return;
    e.preventDefault();
    items[next]!.focus();
  };

  const pick = (entry: Extract<MenuEntry, { kind: 'item' }>) => {
    if (entry.ask) return setAsking({ ...entry.ask, onPick: entry.onPick });
    closeRef.current(false);
    entry.onPick();
  };

  const draw = (list: MenuEntry[]): ReactNode => list.map((entry, i) => {
    if (entry.kind === 'separator') return <div key={i} role="separator" className="row-menu-separator" />;
    if (entry.kind === 'group') {
      return (
        <div key={i} role="group" aria-label={entry.label} className="row-menu-group">
          <div className="row-menu-heading" aria-hidden="true">{entry.label}</div>
          {draw(entry.entries)}
        </div>
      );
    }
    if (entry.kind === 'radio') {
      return (
        <button key={i} type="button" role="menuitemradio" aria-checked={entry.checked} tabIndex={-1} className="row-menu-item"
          onClick={() => { closeRef.current(false); if (!entry.checked) entry.onPick(); }}>
          <span className="row-menu-tick" aria-hidden="true">{entry.checked ? '✓' : ''}</span>{entry.label}
        </button>
      );
    }
    return (
      <button key={i} type="button" role="menuitem" tabIndex={-1} className="row-menu-item" title={entry.hint} onClick={() => pick(entry)}>
        <span className="row-menu-tick" aria-hidden="true" />{entry.label}{entry.ask ? '…' : ''}
      </button>
    );
  });

  return createPortal(
    <div
      ref={box}
      className="row-menu"
      role="menu"
      aria-label={asking ? asking.question : label}
      style={place ? { left: place.left, top: place.top } : { left: x, top: y, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      // Its own items never show the browser's menu, but Shift+right-click still does (not the Shift+F10 that opened it).
      onContextMenu={(e) => { if (!e.shiftKey || Date.now() - openedAt.current < 800) e.preventDefault(); }}
    >
      {asking ? (
        <>
          <div className="row-menu-question" aria-hidden="true">{asking.question}</div>
          <button type="button" role="menuitem" tabIndex={-1} className="row-menu-item danger" onClick={() => { closeRef.current(false); asking.onPick(); }}>
            <span className="row-menu-tick" aria-hidden="true" />{asking.yes}
          </button>
          <button type="button" role="menuitem" tabIndex={-1} className="row-menu-item" onClick={() => closeRef.current(true)}>
            <span className="row-menu-tick" aria-hidden="true" />Cancel
          </button>
        </>
      ) : draw(entries)}
    </div>,
    document.body,
  );
}
