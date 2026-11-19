// The desktop app's menu (#359, #389, #414). No Electron in it, so the root tests check its items and keys per system
// (test/desktop.test.ts); main.ts builds Electron's menu from it. The types are a small part of Electron's own, so the
// template is one Electron accepts as it is (desktop's `npm run typecheck` checks that).

/** The standard items the menu uses, by their Electron role. */
type MenuRole = 'about' | 'services' | 'hide' | 'hideOthers' | 'unhide' | 'editMenu' | 'viewMenu' | 'minimize' | 'zoom' | 'front';

export interface MenuEntry<Win> {
  id?: string;
  label?: string;
  role?: MenuRole;
  accelerator?: string;
  type?: 'separator';
  submenu?: MenuEntry<Win>[];
  /** Electron passes the item and the focused window, if any. */
  click?: (item: unknown, window: Win | undefined) => void;
}

/** What the app's own items do; `window` is the focused one, if any. */
export interface MenuActions<Win> {
  newWindow: () => void;
  closeWindow: (window: Win | undefined) => void;
  toolCalls: (window: Win | undefined) => void;
  quit: () => void;
}

/** The New Window item's key (#414): ⌘N on the Mac, Ctrl+N on Windows and Linux, as Electron writes both. */
export const NEW_WINDOW_ACCELERATOR = 'CmdOrCtrl+N';

/**
 * The app's menu owns the keys a browser keeps (#359): ⌘N/Ctrl+N opens another window (#414), ⌘W/Ctrl+W hides the
 * last window instead of closing it, ⌘O on the Mac is the page's Ctrl+O, ⌘Q (Mac) and Alt+F4 (Windows) end the app.
 * Edit, View and Window keep their standard items, so copy and paste, reload and zoom work as in the default menu. The
 * ids let the probe press items. On Windows and Linux the menu is never shown (#389); it stays only for these keys.
 */
export function menuTemplate<Win>(platform: NodeJS.Platform, actions: MenuActions<Win>): MenuEntry<Win>[] {
  const mac = platform === 'darwin';
  const newWindow: MenuEntry<Win> = { id: 'new-window', label: 'New Window', accelerator: NEW_WINDOW_ACCELERATOR, click: () => actions.newWindow() };
  const closeWindow: MenuEntry<Win> = { id: 'close-window', label: 'Close Window', accelerator: 'CmdOrCtrl+W', click: (_item, w) => actions.closeWindow(w) };
  const quitItem: MenuEntry<Win> = { id: 'quit', label: mac ? 'Quit Ledung' : 'Quit', accelerator: mac ? 'Cmd+Q' : 'Alt+F4', click: () => actions.quit() };
  const toolCalls: MenuEntry<Win> = { id: 'tool-calls', label: 'Show Tool Calls', accelerator: 'Cmd+O', click: (_item, w) => actions.toolCalls(w) };
  const separator: MenuEntry<Win> = { type: 'separator' };
  return [
    ...(mac
      ? [{
          label: 'Ledung',
          submenu: [
            { role: 'about' }, separator, { role: 'services' }, separator,
            { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, separator, quitItem,
          ],
        } satisfies MenuEntry<Win>]
      : []),
    { label: 'File', submenu: mac ? [newWindow, separator, toolCalls, closeWindow] : [newWindow, closeWindow, separator, quitItem] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    // Spelled out: the standard Window menu on Windows has a Close of its own on Ctrl+W.
    { label: 'Window', submenu: mac ? [{ role: 'minimize' }, { role: 'zoom' }, separator, { role: 'front' }] : [{ role: 'minimize' }] },
  ];
}
