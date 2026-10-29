/**
 * The message box with a phone's on-screen keyboard (issue #174; phone audit, findings 3 and 4).
 */

/** The keys of a keydown that decide what Enter does. */
export interface EnterKey {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

/**
 * Whether a key in the message box sends. With a mouse, Enter sends and Shift+Enter adds a line, as before. A touch
 * keyboard has no Shift+Enter, so there Enter adds a line and Send sends; Ctrl/⌘+Enter still sends from a tablet's
 * own keyboard. Never while an input method is composing a word.
 */
export function enterSends(e: EnterKey, touch: boolean): boolean {
  if (e.key !== 'Enter' || e.isComposing) return false;
  return touch ? e.ctrlKey || e.metaKey : !e.shiftKey;
}

/** Less than this is a toolbar showing or hiding, not a keyboard. */
const MIN_KEYBOARD = 80;

/**
 * How much of the page the on-screen keyboard covers, in px: the layout's height less what is visible. Android with
 * `interactive-widget=resizes-content` shrinks the layout itself, so this stays 0 there; iOS keeps the layout and only
 * the visible part shrinks. A pinch zoom also shrinks the visible part, and is not a keyboard.
 */
export function keyboardInset(layoutHeight: number, visibleHeight: number, scale: number): number {
  if (Math.abs(scale - 1) > 0.01) return 0;
  const covered = Math.round(layoutHeight - visibleHeight);
  return covered >= MIN_KEYBOARD ? covered : 0;
}

/** The element types an on-screen keyboard types into; a button, a checkbox or a link brings none up. */
const NO_KEYBOARD_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);

/** The parts of an element `editable` reads. */
export interface FocusedElement {
  tagName: string;
  isContentEditable?: boolean;
  type?: string;
  readOnly?: boolean;
  disabled?: boolean;
}

/**
 * Whether the focused element is one an on-screen keyboard types into. iOS shows its keyboard only for one, so with
 * none focused there is no keyboard, whatever the last measurement said (#262).
 */
export function editable(el: FocusedElement | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (el.readOnly || el.disabled) return false;
  if (tag === 'TEXTAREA') return true;
  return tag === 'INPUT' && !NO_KEYBOARD_INPUTS.has((el.type ?? 'text').toLowerCase());
}

/** After a focus or window change, measure again once iOS's keyboard animation has ended (about 250 ms). */
const SETTLE_MS = 400;

type Listen = { addEventListener(type: string, listener: () => void): void };

/** The parts of the window followKeyboard uses (the core's type check, which runs the tests, has no DOM types). */
export interface KeyboardWindow extends Listen {
  visualViewport: ({ height: number; scale: number; offsetTop: number } & Listen) | null;
  scrollY: number;
  scrollTo(x: number, y: number): void;
  setTimeout(f: () => void, ms: number): unknown;
  document: Listen & {
    activeElement: FocusedElement | null;
    documentElement: { clientHeight: number; style: { setProperty(name: string, value: string): void; removeProperty(name: string): unknown } };
  };
}

/**
 * Keeps `--kb` on the root element at the keyboard's height, so the page's shell ends above the keyboard and the
 * message box and the newest message stay in view (the iOS fallback; issue #174).
 *
 * The visible part's resize is not the only way the keyboard goes (#262): a sensitive Allow takes the page through
 * the passkey dialog, which takes the focus, and Face ID's system sheet, which the page sits behind; then the card
 * and its fields go. When iOS hides the keyboard without a resize the page reaches, `--kb` kept the old height and
 * the bottom of the screen stayed blank. So it also measures again on every focus change and when the window comes
 * back, and once more after the keyboard has settled, and with no field focused it counts no keyboard at all.
 */
export function followKeyboard(win: KeyboardWindow): void {
  const vv = win.visualViewport;
  if (!vv) return;
  const doc = win.document;
  const root = doc.documentElement;
  let last = 0;
  const update = () => {
    const inset = editable(doc.activeElement) ? keyboardInset(root.clientHeight, vv.height, vv.scale) : 0;
    if (inset !== last) {
      last = inset;
      if (inset) root.style.setProperty('--kb', `${inset}px`);
      else root.style.removeProperty('--kb');
    }
    // iOS scrolls the page to bring the focused box up; once the shell ends above the keyboard that only hides the top.
    if (inset && (win.scrollY > 0 || vv.offsetTop > 0)) win.scrollTo(0, 0);
  };
  // A focus change: at once (after the focus has moved on, so a field-to-field move is not read as none), and settled.
  const recheck = () => {
    win.setTimeout(update, 0);
    win.setTimeout(update, SETTLE_MS);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  doc.addEventListener('focusin', recheck);
  doc.addEventListener('focusout', recheck);
  doc.addEventListener('visibilitychange', recheck);
  for (const type of ['resize', 'orientationchange', 'focus', 'pageshow']) win.addEventListener(type, recheck);
  update();
}
