// A session's macros in its info bar, right-aligned (issue #410, placement B, Martin 2026-10-29 in Ledung question
// #425). The chips that fit are shown; the rest, and the keybind-only macros, are in the menu behind the last chip:
// "+N", or "＋" with only "Edit macros…" in it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { keyLabel, type Macro } from '../../../src/shared/macros.ts';

export const onMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function macroTitle(m: Macro, mac: boolean): string {
  const what = m.send ? 'Sends' : 'Puts in the message box';
  const key = m.key ? ` · ${keyLabel(m.key, mac)}` : '';
  return `${what}: ${m.text}${key}\nShift+click: ${m.send ? 'put it in the message box' : 'send it'}`;
}

export function MacroChips(props: { macros: Macro[]; onUse: (m: Macro, other: boolean) => void; onEdit: () => void }) {
  const chips = props.macros.filter((m) => m.chip);
  const keyOnly = props.macros.filter((m) => !m.chip);
  const row = useRef<HTMLSpanElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  // How many chips fit on the one row; the rest wrap out of sight and are counted into the menu.
  const [fit, setFit] = useState(chips.length);
  const [open, setOpen] = useState(false);
  const mac = onMac();

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
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !bar.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (!props.macros.length) return null;
  const rest = [...chips.slice(fit), ...keyOnly];
  const use = (m: Macro, other: boolean) => {
    setOpen(false);
    props.onUse(m, other);
  };
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
      <button className={`board-chip macro-chip macro-more${open ? ' on' : ''}`} aria-expanded={open} aria-haspopup="menu"
        title={rest.length ? `${rest.length} more macro${rest.length === 1 ? '' : 's'}` : 'Edit macros'} onClick={() => setOpen((v) => !v)}>
        {rest.length ? `+${rest.length}` : '＋'}
      </button>
      {open && (
        <div className="macro-menu" role="menu">
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
