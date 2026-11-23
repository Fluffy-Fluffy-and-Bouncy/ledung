// The desktop app's right-click menu (#447). Electron shows none unless the app builds one, so right-clicking did
// nothing in the app, where a browser shows its own (Martin, 2026-11-19 22:53: "I want to be able to right click on
// screenshots and copy the picture"). No Electron in it, so the root tests decide which items a click gets
// (test/desktop.test.ts); main.ts builds Electron's menu from them and does what they say.

/** What was right-clicked: the fields of Electron's `context-menu` params that the menu reads. */
export interface ContextTarget {
  /** "image" on a picture; also "none", "video", "audio", "canvas", "plugin", "file". */
  mediaType: string;
  /** The picture's address, for Save Image As…. */
  srcURL: string;
  /** False when the image has not loaded (a broken one): there is nothing to copy. */
  hasImageContents?: boolean;
  /** The link's address, "" off a link. */
  linkURL: string;
  /** The selected text, "" for none. */
  selectionText: string;
  /** A text box, the composer or the find bar's. */
  isEditable: boolean;
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

export type ContextItem = 'copyImage' | 'saveImage' | 'copyLink' | 'cut' | 'copy' | 'paste' | 'selectAll';
export type ContextEntry = ContextItem | 'separator';

/** The labels, in the Title Case Electron gives its own Edit items (Cut, Copy, Paste, Select All). */
export const CONTEXT_LABELS: Record<ContextItem, string> = {
  copyImage: 'Copy Image',
  saveImage: 'Save Image As…',
  copyLink: 'Copy Link Address',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select All',
};

/** An address worth copying from a link: a web address, never a `javascript:` one. */
function copyableLink(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** A picture address a download can fetch: Ledung's own (http), or one the page made (data:, blob:). */
function saveableImage(url: string): boolean {
  try {
    return ['http:', 'https:', 'data:', 'blob:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * The right-click menu's items for what was clicked, as a browser gives them: a link's, then a picture's, then the
 * text's, each group apart. In a text box Cut, Copy and Paste as its edit flags allow, then Select All; on selected text
 * elsewhere, Copy. An item that would do nothing is left out rather than greyed (#447: "No menu items that do
 * nothing"), and an empty list means no menu at all ("no menu where none applies").
 */
export function contextItems(target: ContextTarget): ContextEntry[] {
  const groups: ContextItem[][] = [];
  if (target.linkURL !== '' && copyableLink(target.linkURL)) groups.push(['copyLink']);
  if (target.mediaType === 'image' && target.hasImageContents !== false) {
    groups.push(saveableImage(target.srcURL) ? ['copyImage', 'saveImage'] : ['copyImage']);
  }
  const flags = target.editFlags;
  if (target.isEditable) {
    const edit: ContextItem[] = [];
    if (flags.canCut) edit.push('cut');
    if (flags.canCopy) edit.push('copy');
    if (flags.canPaste) edit.push('paste');
    if (edit.length > 0) groups.push(edit);
    if (flags.canSelectAll) groups.push(['selectAll']);
  } else if (target.selectionText.trim() !== '' && flags.canCopy) {
    groups.push(['copy']);
  }
  const entries: ContextEntry[] = [];
  for (const group of groups) {
    if (entries.length > 0) entries.push('separator');
    entries.push(...group);
  }
  return entries;
}
