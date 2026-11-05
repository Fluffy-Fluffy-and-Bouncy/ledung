// Issue #126: the ＋ in a session's info bar is the way to Settings → Macros, so it shows with no macros too
// (Martin, 2026-11-05 15:49: "The plus for macros only appear when you have one macro, I want it to always be there.").
// The bar is drawn in a small browser stand-in (happy-dom), as typing-renders.test.ts does, and the ＋ clicked.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';
import { Window } from 'happy-dom';
import type { Macro } from '../src/shared/macros.ts';
import { removeTemp } from './temp.ts';

const root = path.join(import.meta.dirname, '..');
let page: any;
let dir: string;
let win: Window;

before(async () => {
  win = new Window({ url: 'http://127.0.0.1:4396/' });
  for (const key of ['window', 'document', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent']) {
    Object.defineProperty(globalThis, key, { value: (win as any)[key], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // Bundled, act() queues through a new MessageChannel each time, whose ports keep Node from exiting.
  (globalThis as any).MessageChannel = class {
    port1: { onmessage: ((e: unknown) => void) | null } = { onmessage: null };
    port2 = { postMessage: () => setImmediate(() => this.port1.onmessage?.({})) };
  };
  dir = mkdtempSync(path.join(tmpdir(), 'ledung-macro-plus-'));
  const out = path.join(dir, 'page.mjs');
  await build({
    stdin: {
      contents: [
        "export { MacroChips } from './web/src/components/MacroChips.tsx';",
        "export { createElement, act } from 'react';",
        "export { createRoot } from 'react-dom/client';",
      ].join('\n'),
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true, format: 'esm', platform: 'browser', outfile: out, logLevel: 'silent',
    loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
  });
  page = await import(pathToFileURL(out).href);
});

after(async () => {
  await win.happyDOM.close();
  await stop();
  removeTemp(dir);
});

async function draw(macros: Macro[]) {
  const edits: number[] = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const r = page.createRoot(host);
  await page.act(async () => r.render(page.createElement(page.MacroChips, { macros, onUse: () => {}, onEdit: () => edits.push(1) })));
  return {
    host, edits,
    done: async () => { await page.act(async () => r.unmount()); host.remove(); },
  };
}

const more = (host: HTMLElement) => host.querySelector('button.macro-more') as HTMLButtonElement | null;
const items = (host: HTMLElement) => [...host.querySelectorAll('.macro-menu [role="menuitem"]')].map((b) => b.textContent);

test('with no macros the ＋ shows, and its menu holds only "Edit macros…", which goes to the editor', async () => {
  const bar = await draw([]);
  try {
    const plus = more(bar.host);
    assert.ok(plus, 'the ＋ is drawn with no macros');
    assert.equal(plus.textContent, '＋');
    assert.equal(bar.host.querySelectorAll('button.macro-chip:not(.macro-more)').length, 0, 'no chips');
    await page.act(async () => plus.click());
    assert.deepEqual(items(bar.host), ['Edit macros…']);
    await page.act(async () => (bar.host.querySelector('.macro-menu [role="menuitem"]') as HTMLButtonElement).click());
    assert.equal(bar.edits.length, 1, '"Edit macros…" calls the editor');
  } finally {
    await bar.done();
  }
});

test('with macros the bar is as before: the chip, then the button whose menu ends in "Edit macros…"', async () => {
  const macros: Macro[] = [
    { id: 'a', name: 'Go on', text: 'go on', send: true, chip: true, key: null, project: null },
    { id: 'b', name: 'Keyed', text: 'keyed', send: false, chip: false, key: 'Alt+K', project: null },
  ];
  const bar = await draw(macros);
  try {
    assert.ok(bar.host.querySelector('button.macro-chip:not(.macro-more)')?.textContent?.startsWith('Go on'), 'the chip shows');
    const button = more(bar.host);
    assert.ok(button, 'the button after the chips shows');
    await page.act(async () => button.click());
    const menu = items(bar.host);
    assert.ok(menu.some((t) => t?.startsWith('Keyed')), 'the keybind-only macro is in the menu');
    assert.equal(menu.at(-1), 'Edit macros…');
  } finally {
    await bar.done();
  }
});
