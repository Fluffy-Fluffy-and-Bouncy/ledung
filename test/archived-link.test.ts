import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ARCHIVED_LINK_KEY, readArchivedLink, saveArchivedLink, showsArchivedLink, type ArchivedLinkStore } from '../web/src/archivedLink.ts';

// Issue #157: the sidebar's "Archived (N)" entry can be switched off in Settings, per browser, shown
// by default. Switching it back on is the way back to the archived sessions (Martin, 2026-10-16 23:43).

function memoryStore(): ArchivedLinkStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

test('the entry is shown in a browser that never switched it off', () => {
  assert.equal(readArchivedLink(memoryStore()), true);
});

test('the switch is kept in this browser and back on removes the entry', () => {
  const store = memoryStore();
  saveArchivedLink(store, false);
  assert.equal(readArchivedLink(store), false);
  assert.equal(store.data.get(ARCHIVED_LINK_KEY), '0');
  saveArchivedLink(store, true);
  assert.equal(readArchivedLink(store), true);
  assert.equal(store.data.has(ARCHIVED_LINK_KEY), false);
});

test('only the stored "0" hides the entry; any other value shows it', () => {
  for (const other of ['1', 'x', '', 'false']) {
    const store = memoryStore();
    store.setItem(ARCHIVED_LINK_KEY, other);
    assert.equal(readArchivedLink(store), true, other);
  }
});

test('a browser whose storage refuses shows the entry and saving does not throw', () => {
  const broken: ArchivedLinkStore = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  assert.equal(readArchivedLink(broken), true);
  assert.doesNotThrow(() => saveArchivedLink(broken, false));
});

test('on: a group shows the entry as before, when it has archived sessions and is not folded', () => {
  assert.equal(showsArchivedLink(true, 3, false), true);
  assert.equal(showsArchivedLink(true, 0, false), false);
  assert.equal(showsArchivedLink(true, 3, true), false);
});

test('off: no group shows the entry', () => {
  assert.equal(showsArchivedLink(false, 3, false), false);
  assert.equal(showsArchivedLink(false, 0, false), false);
});

// The sidebar must follow the switch, and Settings must carry it.
test('the sidebar draws "Archived (N)" only through the switch, and Settings has the switch', () => {
  const app = readFileSync(path.join(import.meta.dirname, '..', 'web', 'src', 'App.tsx'), 'utf8');
  const sidebar = app.slice(app.indexOf('function Sidebar('));
  assert.match(sidebar, /const \[archivedShown\] = useArchivedLink\(\);/);
  assert.match(sidebar, /\{showsArchivedLink\(archivedShown, g\.archived, g\.isFolded\) && \(\s*<button className=\{`archived-link/);
  // No other archived entry in the sidebar that ignores the switch.
  assert.equal(sidebar.match(/className=\{`archived-link/g)?.length, 1);
  const settings = readFileSync(path.join(import.meta.dirname, '..', 'web', 'src', 'components', 'SettingsView.tsx'), 'utf8');
  const section = settings.slice(settings.indexOf('<h3>Sidebar</h3>'), settings.indexOf('</section>', settings.indexOf('<h3>Sidebar</h3>')));
  assert.match(section, /<ArchivedLinkSwitch \/>/);
  assert.match(settings, /const \[on, set\] = useArchivedLink\(\);[\s\S]*?checked=\{on\} onChange=\{\(e\) => set\(e\.target\.checked\)\} \/> Show "Archived" in the sidebar/);
});
