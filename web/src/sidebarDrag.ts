// Dragging projects and sessions into another order in the sidebar (issue #88). Rows that can be dragged carry
// data-drag (their sibling group: "projects", "t:<project>" for a project's top-level sessions, "c:<id>" for
// the sessions under one session) and data-drag-id. Mouse: a drag starts once the pointer moves; touch: after
// a long press, so a tap still opens and a swipe still scrolls. A row with a menu (data-menu, the right-click menu of
// 2026-11-06) opens it on that long press instead, and a finger that then moves on drags the row as before, so the
// two never fight: hold for the menu, hold and move to reorder.
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { dropSlot, moved, staysPut } from './sidebarOrder.ts';

/** How far the mouse moves before a press becomes a drag. */
const MOVE_PX = 5;
/** How long a finger rests before a press becomes a drag, and how far it may wander meanwhile (more is a scroll). */
const HOLD_MS = 450;
const HOLD_SLOP_PX = 8;
/** Near the list's top or bottom edge a drag scrolls it. */
const EDGE_PX = 28;

export interface SidebarDrag {
  group: string;
  id: string;
  /** The slot it would land in among its siblings, before the sibling at that index; null: nowhere (drop cancels). */
  slot: number | null;
}

/** group and id null: a row with a menu that can't be dragged; held: its long press opened the menu. */
interface Press { pointerId: number; x: number; y: number; group: string | null; id: string | null; touch: boolean; timer: number | null; held: boolean }

/** The right-click menu's side: a long press on a row with data-menu, a right-click, and a drag that closes it. */
export interface RowMenuHooks {
  onHold: (row: HTMLElement, x: number, y: number) => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onDragStart: () => void;
}

export function useSidebarDrag(onDrop: (group: string, ids: string[]) => void, menu?: RowMenuHooks) {
  const nav = useRef<HTMLElement>(null);
  const [drag, setDrag] = useState<SidebarDrag | null>(null);
  const press = useRef<Press | null>(null);
  const active = useRef<SidebarDrag | null>(null);
  const suppressClick = useRef(false);
  /** When a long press that opened the menu ended: its touchend follows the pointerup. */
  const heldEndedAt = useRef(0);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const detach = useRef<(() => void) | null>(null);

  const siblings = (group: string) => [...(nav.current?.querySelectorAll<HTMLElement>('[data-drag]') ?? [])].filter((e) => e.dataset.drag === group);
  // A project moves as its whole group; a session as its own row.
  const box = (e: HTMLElement, group: string) => (group === 'projects' ? e.closest<HTMLElement>('.project-group') ?? e : e);

  const slotAt = (a: SidebarDrag, x: number, y: number): number | null => {
    const els = siblings(a.group);
    const self = els.find((e) => e.dataset.dragId === a.id);
    // Outside the list (projects) or outside its own project (sessions): no place, so a drop there cancels.
    const area = (a.group === 'projects' ? nav.current : self?.closest('.project-group'))?.getBoundingClientRect();
    if (!area || x < area.left || x > area.right || y < area.top || y > area.bottom) return null;
    const slot = dropSlot(els.map((e) => { const r = box(e, a.group).getBoundingClientRect(); return r.top + r.height / 2; }), y);
    return staysPut(els.map((e) => e.dataset.dragId!), a.id, slot) ? null : slot;
  };

  const finish = (drop: boolean) => {
    const a = active.current;
    const held = press.current?.held ?? false;
    const touch = press.current?.touch ?? false;
    if (held && touch) heldEndedAt.current = Date.now();
    if (press.current?.timer) clearTimeout(press.current.timer);
    press.current = null;
    active.current = null;
    detach.current?.();
    detach.current = null;
    document.body.classList.remove('sidebar-dragging');
    setDrag(null);
    if (!a && !held) return;
    // The click that ends a mouse drag (or a long press without moving, which opened the menu) must not open the row.
    // A finger's click comes in a task of its own after the touch ends, so it is waited for a little longer.
    suppressClick.current = true;
    setTimeout(() => { suppressClick.current = false; }, touch ? 400 : 0);
    if (a && drop && a.slot !== null) dropRef.current(a.group, moved(siblings(a.group).map((e) => e.dataset.dragId!), a.id, a.slot));
  };

  const begin = (p: Press & { group: string; id: string }) => {
    active.current = { group: p.group, id: p.id, slot: null };
    document.body.classList.add('sidebar-dragging');
    setDrag(active.current);
    if (p.touch && !p.held) navigator.vibrate?.(10);
  };
  const draggable = (p: Press): p is Press & { group: string; id: string } => p.group !== null && p.id !== null;

  const scrollNear = (y: number) => {
    const list = nav.current;
    if (!list) return;
    // The list scrolls by itself on a wide screen; on a phone the whole sidebar does.
    const scroller = list.scrollHeight > list.clientHeight ? list : list.closest<HTMLElement>('.sidebar');
    if (!scroller) return;
    const r = scroller.getBoundingClientRect();
    if (y < r.top + EDGE_PX) scroller.scrollBy(0, -10);
    else if (y > r.bottom - EDGE_PX) scroller.scrollBy(0, 10);
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || press.current) return;
    const target = e.target as HTMLElement;
    const touch = e.pointerType === 'touch';
    const el = target.closest<HTMLElement>('[data-drag]');
    // A finger on a row with a menu: its long press opens the menu, whether or not the row can be dragged.
    const row = touch && menuRef.current ? target.closest<HTMLElement>('[data-menu]') : null;
    if ((!el || !nav.current?.contains(el)) && !(row && nav.current?.contains(row))) return;
    const inList = el && nav.current?.contains(el) ? el : null;
    const p: Press = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, group: inList?.dataset.drag ?? null, id: inList?.dataset.dragId ?? null, touch, timer: null, held: false };
    press.current = p;
    if (touch) {
      p.timer = window.setTimeout(() => {
        p.timer = null;
        if (press.current !== p) return;
        if (row) {
          p.held = true;
          navigator.vibrate?.(10);
          menuRef.current?.onHold(row, p.x, p.y);
        } else if (draggable(p)) begin(p);
      }, HOLD_MS);
    } else if (inList) {
      try { inList.setPointerCapture(e.pointerId); } catch { /* the drag still works inside the window */ }
    }

    const onMove = (m: PointerEvent) => {
      if (m.pointerId !== p.pointerId) return;
      const far = Math.hypot(m.clientX - p.x, m.clientY - p.y);
      if (!active.current) {
        // A finger that moves before the long press is a scroll; a mouse that moves is a drag. After a long press
        // that opened the menu, moving on drags the row (closing the menu); a row that can't be dragged stays put.
        if (p.touch && !p.held) { if (far > HOLD_SLOP_PX) finish(false); return; }
        if (far < (p.touch ? HOLD_SLOP_PX : MOVE_PX) || !draggable(p)) return;
        if (p.held) menuRef.current?.onDragStart();
        begin(p);
      }
      const a = active.current!;
      const slot = slotAt(a, m.clientX, m.clientY);
      if (slot !== a.slot) { active.current = { ...a, slot }; setDrag(active.current); }
      scrollNear(m.clientY);
    };
    const onUp = (u: PointerEvent) => { if (u.pointerId === p.pointerId) finish(true); };
    const onCancel = (c: PointerEvent) => { if (c.pointerId === p.pointerId) finish(false); };
    const onKey = (k: KeyboardEvent) => {
      if (k.key !== 'Escape' || !active.current) return;
      k.preventDefault();
      k.stopPropagation();
      finish(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    // Capture, so Escape ends the drag before it closes Settings or anything else (issue #78).
    document.addEventListener('keydown', onKey, true);
    detach.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('keydown', onKey, true);
    };
  };

  useEffect(() => {
    const list = nav.current;
    if (!list) return;
    // Once a touch drag has started the finger must move the row, not scroll the page. React's touch
    // handlers are passive and can't stop that, so this one is added by hand.
    // After a long press that opened the menu too, so moving on drags the row instead of scrolling the list.
    const onTouchMove = (t: TouchEvent) => { if (active.current || press.current?.held) t.preventDefault(); };
    // The end of a long press that opened the menu makes no click: the menu is under the finger by then, and the
    // click would pick whichever item it landed on.
    const onTouchEnd = (t: TouchEvent) => { if (Date.now() - heldEndedAt.current < 200 && t.cancelable) t.preventDefault(); };
    list.addEventListener('touchmove', onTouchMove, { passive: false });
    list.addEventListener('touchend', onTouchEnd, { passive: false });
    return () => { list.removeEventListener('touchmove', onTouchMove); list.removeEventListener('touchend', onTouchEnd); detach.current?.(); };
  }, []);

  const onClickCapture = (e: ReactMouseEvent) => {
    if (!suppressClick.current) return;
    e.preventDefault();
    e.stopPropagation();
  };
  // A long press opens the browser's menu on a phone; while a press may become a drag (or opened ours) it doesn't.
  // Otherwise it is a right-click or the keyboard's menu key: the row's menu.
  const onContextMenu = (e: ReactMouseEvent) => {
    if (press.current?.touch || active.current) e.preventDefault();
    else menuRef.current?.onContextMenu(e);
  };

  return { nav, drag, handlers: { onPointerDown, onClickCapture, onContextMenu } };
}
