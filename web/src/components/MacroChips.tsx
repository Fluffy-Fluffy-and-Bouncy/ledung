// A session's macros in its info bar, right-aligned (issue #410, placement B, Martin 2026-10-29 in Ledung question
// #425). The chips that fit are shown; the rest, and the keybind-only macros, are in the menu behind the last chip:
// always "＋". The ＋ shows with no macros too, as the way to make the first one (issue #126, Martin 2026-11-05).
// The composer's 🔑 and 📎 live at the top of the same menu, and the ＋ no longer reads "+N" (issue #186, Martin
// 2026-11-07 in Ledung question #671: "with a fixed + icon that always shows (not "+1"), and arrow-key navigation").
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { keyLabel, type Macro } from '../../../src/shared/macros.ts';
import { menuStep } from '../menuNav.ts';

/** An entry above the macros in the ＋ menu: the composer's own actions (issue #186). */
export type MenuAction = { id: string; label: string; title: string; disabled?: boolean; onPick: () => void };

export const onMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function macroTitle(m: Macro, mac: boolean): string {
  const what = m.send ? 'Sends' : 'Puts in the message box';
  const key = m.key ? ` · ${keyLabel(m.key, mac)}` : '';
  return `${what}: ${m.text}${key}\nShift+click: ${m.send ? 'put it in the message box' : 'send it'}`;
}

export function MacroChips(props: { macros: Macro[]; onUse: (m: Macro, other: boolean) => void; onEdit: () => void; actions?: MenuAction[] }) {
  const chips = props.macros.filter((m) => m.chip);
  const keyOnly = props.macros.filter((m) => !m.chip);
  const row = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  // How many chips fit on the one row; the rest wrap out of sight and are counted into the menu.
  const [fit, setFit] = useState(chips.length);
  const [open, setOpen] = useState(false);
  const plus = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Which item gets the focus when the menu opens: the first, or the last when opened with Up.
  const openAt = useRef<'ArrowDown' | 'ArrowUp'>('ArrowDown');
  const mac = onMac();
  const actions = props.actions ?? [];

  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => {
      const kids = [...el.children] as HTMLElement[];
      const top = kids[0]?.offsetTop ?? 0;
      setFit(kids.filter((k) => k.offsetTop === top).length);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [chips.map((m) => m.id + m.name).join('|')]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) {
        // Escape hands the focus back to the ＋, so the keyboard carries on from where the menu was opened.
        if (e.key === 'Escape') { setOpen(false); plus.current?.focus(); }
      } else if (!bar.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  // Opened, the focus goes into the menu so the arrow keys work at once.
  useEffect(() => {
    if (!open) return;
    const items = menuItems();
    const to = menuStep(items.map((b) => !b.disabled), -1, openAt.current);
    if (to !== null) items[to]!.focus();
    openAt.current = 'ArrowDown';
  }, [open]);

  const menuItems = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  const onMenuKey = (e: ReactKeyboardEvent) => {
    const items = menuItems();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Enter' && at >= 0) {
      // Picked as a click would be, Shift included (a macro's other way, as with Shift+click).
      e.preventDefault();
      items[at]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: e.shiftKey }));
      return;
    }
    if (e.key === 'Tab') return setOpen(false);
    const to = menuStep(items.map((b) => !b.disabled), at, e.key);
    if (to === null) return;
    e.preventDefault();
    items[to]!.focus();
  };

  const rest = [...chips.slice(fit), ...keyOnly];
  const use = (m: Macro, other: boolean) => {
    setOpen(false);
    props.onUse(m, other);
  };
  const more = rest.length ? `${rest.length} more macro${rest.length === 1 ? '' : 's'}` : 'edit macros';
  const plusTitle = actions.length ? `${actions.map((a) => a.label.replace(/^\P{L}+/u, '')).join(', ')}, ${more}` : more[0]!.toUpperCase() + more.slice(1);
  return (
    <span className="macro-bar" ref={bar}>
      <span className="macro-chips" ref={row}>
        {chips.map((m, i) => (
          <button key={m.id} className="board-chip macro-chip" title={macroTitle(m, mac)} tabIndex={i < fit ? 0 : -1} aria-hidden={i < fit ? undefined : true}
            onClick={(e) => use(m, e.shiftKey)}>
            {m.name}{m.send && <span className="macro-send" aria-label="sends"> ↵</span>}
          </button>
        ))}
      </span>
      <button ref={plus} className={`board-chip macro-chip macro-more${open ? ' on' : ''}`} aria-expanded={open} aria-haspopup="menu"
        aria-label="Actions and macros" title={plusTitle} onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
          e.preventDefault();
          openAt.current = e.key;
          setOpen(true);
        }}>
        ＋
      </button>
      {open && (
        <div className="macro-menu" role="menu" ref={menu} onKeyDown={onMenuKey}>
          {actions.map((a) => (
            <button key={a.id} role="menuitem" title={a.title} disabled={a.disabled} onClick={() => { setOpen(false); a.onPick(); }}>
              <span>{a.label}</span><span />
            </button>
          ))}
          {actions.length > 0 && <hr />}
          {rest.map((m) => (
            <button key={m.id} role="menuitem" title={macroTitle(m, mac)} onClick={(e) => use(m, e.shiftKey)}>
              <span>{m.name}{m.send && <span className="macro-send"> ↵</span>}</span>{m.key ? <kbd>{keyLabel(m.key, mac)}</kbd> : <span />}
            </button>
          ))}
          {rest.length > 0 && <hr />}
          <button role="menuitem" className="muted" onClick={() => { setOpen(false); props.onEdit(); }}>Edit macros…</button>
        </div>
      )}
    </span>
  );
}
