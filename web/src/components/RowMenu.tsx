// The sidebar's right-click menu (Simon, 2026-11-06), drawn over the page at the point it was opened. A menu with
// menu roles: the arrow keys, Home and End move between items, Enter or Space picks one, Escape and Tab close it.
// What asks first (Stop and archive, Clear context) turns the menu into its question, with the yes and a Cancel.
// A choice of several (Model, Account) is one row with its current value that opens a submenu (Simon, 2026-11-08):
// beside the menu with a mouse, → opens it and ← closes it; on a touch or narrow screen it opens in place, below
// its row, so it never runs off a phone's screen.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { menuPlace, moveFocus, subMenuPlace } from '../sidebarMenu.ts';
import { COARSE_QUERY } from '../coarsePointer.ts';
import { NARROW_QUERY } from '../sidebarSize.ts';

type Radio = { kind: 'radio'; label: string; checked: boolean; onPick: () => void };
export type MenuEntry =
  | { kind: 'item'; label: string; hint?: string; onPick: () => void; ask?: { question: string; yes: string } }
  | Radio
  | { kind: 'group'; label: string; entries: MenuEntry[] }
  /** value: the current choice, shown in its row; note: what choosing affects, shown above the choices. */
  | { kind: 'submenu'; label: string; value: string; note?: string; entries: Radio[] }
  | { kind: 'separator' };

const ITEMS = '[role="menuitem"], [role="menuitemradio"]';

/** The items of one menu level: those whose nearest menu is it, not a submenu inside it. */
const itemsOf = (menu: Element): HTMLElement[] => [...menu.querySelectorAll<HTMLElement>(ITEMS)].filter((el) => el.closest('[role="menu"]') === menu);

export function RowMenu({ label, x, y, entries, onClose }: {
  /** What the menu is for, read out by a screen reader. */
  label: string;
  x: number;
  y: number;
  entries: MenuEntry[];
  /** refocus: closed from the keyboard, so the focus goes back to the row. */
  onClose: (refocus: boolean) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const ids = useId();
  const fly = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  // In place on a touch or narrow screen, beside the menu otherwise; fixed for the menu's life.
  const [inline] = useState(() => typeof matchMedia === 'function' && matchMedia(`${COARSE_QUERY}, ${NARROW_QUERY}`).matches);
  /** The open submenu, by its entry's index; focus: its first item takes the focus (keys, a click), not a hover. */
  const [sub, setSub] = useState<{ at: number; focus: boolean } | null>(null);
  const subRef = useRef(sub);
  subRef.current = sub;
  const [flyPlace, setFlyPlace] = useState<{ left: number; top: number } | null>(null);
  // The question being asked, by its words; its yes is the entry's as it is now, and when the entry is gone (the
  // session ended meanwhile, so Stop and archive became Archive) the menu closes instead of acting on what was.
  const [askingFor, setAskingFor] = useState<string | null>(null);
  const asking = askingFor === null ? null : entries.find((e): e is Extract<MenuEntry, { kind: 'item' }> => e.kind === 'item' && e.ask?.question === askingFor) ?? null;
  const gone = askingFor !== null && !asking;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // The browser's own menu event that follows the menu key or Shift+F10 lands on the menu once it has the focus.
  const openedAt = useRef(Date.now());
  const opened = sub ? entries[sub.at] : undefined;
  const subEntries = opened?.kind === 'submenu' ? opened : null;

  // Measured before it is shown, so it opens where it fits rather than jumping there. In place, a submenu makes the
  // menu taller, so it is placed again.
  useLayoutEffect(() => {
    const r = box.current!.getBoundingClientRect();
    setPlace(menuPlace(x, y, r.width, r.height, window.innerWidth, window.innerHeight));
  }, [x, y, askingFor, inline ? sub?.at : null]);
  useLayoutEffect(() => {
    if (inline || !sub || !fly.current) return setFlyPlace(null);
    const item = box.current?.querySelector(`[data-sub="${sub.at}"]`)?.getBoundingClientRect();
    if (!item) return;
    const r = fly.current.getBoundingClientRect();
    setFlyPlace(subMenuPlace(item, r.width, r.height, window.innerWidth, window.innerHeight));
  }, [inline, sub?.at, place]);

  // Once placed: a hidden menu can't take the focus.
  const placed = place !== null;
  useEffect(() => {
    if (placed) box.current?.querySelector<HTMLElement>(ITEMS)?.focus();
  }, [placed, askingFor]);
  useEffect(() => {
    if (!sub?.focus) return;
    const level = inline ? box.current?.querySelector('[data-submenu]') : flyPlace && fly.current;
    if (!level) return;
    const items = itemsOf(level);
    (items.find((el) => el.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
  }, [sub, flyPlace]);
  useEffect(() => { if (gone) closeRef.current(false); }, [gone]);

  const closeSub = () => {
    const at = subRef.current?.at;
    setSub(null);
    if (at !== undefined) box.current?.querySelector<HTMLElement>(`[data-sub="${at}"]`)?.focus();
  };

  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) closeRef.current(false); };
    // Capture, so Escape closes the menu before Settings or anything else hears it (issue #78). In a submenu,
    // Escape closes only that.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Tab') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && subRef.current && (document.activeElement as HTMLElement | null)?.closest('[data-submenu]')) return closeSub();
      closeRef.current(true);
    };
    const onAway = () => closeRef.current(false);
    // A phone's address bar showing or hiding changes only the height; that keeps the menu.
    const width = window.innerWidth;
    const onResize = () => { if (window.innerWidth !== width) onAway(); };
    // The list scrolling away under it, not the menu's own scrolling.
    const onScroll = (e: Event) => { if (!root.current?.contains(e.target as Node)) onAway(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onAway);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onAway);
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const at = document.activeElement as HTMLElement | null;
    const level = at?.closest('[role="menu"]') ?? box.current!;
    const inSub = !!at?.closest('[data-submenu]');
    if (e.key === 'ArrowRight' && at?.dataset.sub !== undefined) {
      e.preventDefault();
      return setSub({ at: Number(at.dataset.sub), focus: true });
    }
    if (e.key === 'ArrowLeft' && inSub) {
      e.preventDefault();
      return closeSub();
    }
    const items = itemsOf(level);
    const next = moveFocus(e.key, items.indexOf(at as HTMLElement), items.length);
    if (next === null) return;
    e.preventDefault();
    // Moving on in the menu itself closes a submenu beside it.
    if (!inSub && !inline) setSub(null);
    items[next]!.focus();
  };

  // Picked from the keyboard (a click with no pointer behind it), the focus goes back to the row before the action,
  // so one that moves it on (Rename's name box, a page it opens) still can.
  const fromKeys = (e: { detail: number }) => e.detail === 0;
  const pick = (entry: Extract<MenuEntry, { kind: 'item' }>, keys: boolean) => {
    if (entry.ask) {
      setSub(null);
      return setAskingFor(entry.ask.question);
    }
    closeRef.current(keys);
    entry.onPick();
  };

  const radio = (entry: Radio, i: number, top = false) => (
    <button key={i} type="button" role="menuitemradio" aria-checked={entry.checked} tabIndex={-1} className="row-menu-item"
      onMouseEnter={top && !inline ? () => { if (subRef.current) setSub(null); } : undefined}
      onClick={(e) => { closeRef.current(fromKeys(e)); if (!entry.checked) entry.onPick(); }}>
      <span className="row-menu-tick" aria-hidden="true">{entry.checked ? '✓' : ''}</span>{entry.label}
    </button>
  );
  const subLevel = (entry: Extract<MenuEntry, { kind: 'submenu' }>, at: number) => (
    <div role="menu" id={`${ids}-sub-${at}`} aria-label={entry.note ? `${entry.label}: ${entry.note}` : entry.label} data-submenu={at}
      className={inline ? 'row-menu-inline' : 'row-menu row-menu-fly'}
      ref={inline ? undefined : fly}
      style={inline ? undefined : flyPlace ? { left: flyPlace.left, top: flyPlace.top } : { left: 0, top: 0, visibility: 'hidden' }}>
      {entry.note && <div className="row-menu-heading row-menu-note" aria-hidden="true">{entry.note}</div>}
      {entry.entries.map((r, j) => radio(r, j))}
    </div>
  );

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
    if (entry.kind === 'radio') return radio(entry, i, true);
    if (entry.kind === 'submenu') {
      const open = sub?.at === i;
      return (
        <div key={i} role="none">
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${ids}-sub-${i}` : undefined} tabIndex={-1} data-sub={i}
            className={`row-menu-item row-menu-parent${open ? ' open' : ''}`} title={entry.note}
            onClick={(e) => setSub(open && (inline || fromKeys(e)) ? null : { at: i, focus: fromKeys(e) || inline })}
            // Beside the menu a pointer resting on it opens it, as menus do.
            onMouseEnter={inline ? undefined : () => { if (subRef.current?.at !== i) setSub({ at: i, focus: false }); }}>
            <span className="row-menu-tick" aria-hidden="true" />
            <span className="row-menu-label">{entry.label}</span>
            <span className="row-menu-value">{entry.value}</span>
            <span className="row-menu-arrow" aria-hidden="true">{inline ? (open ? '▾' : '▸') : '▸'}</span>
          </button>
          {open && inline && subLevel(entry, i)}
        </div>
      );
    }
    return (
      <button key={i} type="button" role="menuitem" tabIndex={-1} className="row-menu-item" title={entry.hint} onClick={(e) => pick(entry, fromKeys(e))}
        onMouseEnter={inline ? undefined : () => { if (subRef.current) setSub(null); }}>
        <span className="row-menu-tick" aria-hidden="true" />{entry.label}{entry.ask ? '…' : ''}
      </button>
    );
  });

  // Its own items never show the browser's menu, but Shift+right-click still does (not the Shift+F10 that opened it).
  const onContextMenu = (e: ReactMouseEvent) => { if (!e.shiftKey || Date.now() - openedAt.current < 800) e.preventDefault(); };
  return createPortal(
    <div ref={root} className="row-menu-root" onKeyDown={onKeyDown} onContextMenu={onContextMenu}>
      <div
        ref={box}
        onScroll={inline ? undefined : () => { if (subRef.current) setSub(null); }}
        className="row-menu"
        role="menu"
        aria-label={asking ? asking.ask!.question : label}
        style={place ? { left: place.left, top: place.top } : { left: x, top: y, visibility: 'hidden' }}
      >
        {asking ? (
          <>
            <div className="row-menu-question" aria-hidden="true">{asking.ask!.question}</div>
            <button type="button" role="menuitem" tabIndex={-1} className="row-menu-item danger" onClick={(e) => { closeRef.current(fromKeys(e)); asking.onPick(); }}>
              <span className="row-menu-tick" aria-hidden="true" />{asking.ask!.yes}
            </button>
            <button type="button" role="menuitem" tabIndex={-1} className="row-menu-item" onClick={() => closeRef.current(true)}>
              <span className="row-menu-tick" aria-hidden="true" />Cancel
            </button>
          </>
        ) : draw(entries)}
      </div>
      {!inline && !asking && subEntries && sub && subLevel(subEntries, sub.at)}
    </div>,
    document.body,
  );
}
