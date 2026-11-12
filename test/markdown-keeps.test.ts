// Issue #200: a long command in Waiting for you jumped back to the left while scrolled sideways. Markdown made its
// code block anew on every render, so each live update threw the <pre> away for a new one. These tests draw the real
// page in a small browser stand-in (happy-dom), redraw it as a live update does, and check the elements are kept.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';
import { Window } from 'happy-dom';

const root = path.join(import.meta.dirname, '..');
const LONG = `node build.js ${Array.from({ length: 30 }, (_, i) => `--option-${i}=value-${i}`).join(' ')}`;

let page: any;
let dir: string;
let win: Window;

before(async () => {
  win = new Window({ url: 'http://127.0.0.1:4394/' });
  for (const key of ['window', 'document', 'localStorage', 'location', 'history', 'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent']) {
    Object.defineProperty(globalThis, key, { value: (win as any)[key], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // As in typing-renders.test.ts: a MessageChannel that lets Node exit.
  (globalThis as any).MessageChannel = class {
    port1: { onmessage: ((e: unknown) => void) | null } = { onmessage: null };
    port2 = { postMessage: () => setImmediate(() => this.port1.onmessage?.({})) };
  };
  dir = mkdtempSync(path.join(tmpdir(), 'ledung-markdown-'));
  const out = path.join(dir, 'page.mjs');
  await build({
    stdin: {
      contents: [
        "export { WaitingView } from './web/src/components/WaitingView.tsx';",
        "export { Markdown } from './web/src/components/Markdown.tsx';",
        "export { createElement, act } from 'react';",
        "export { createRoot } from 'react-dom/client';",
      ].join('\n'),
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: out,
    loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'silent',
  });
  page = await import(pathToFileURL(out).href);
});

after(async () => {
  await stop();
  await win.happyDOM.close();
  rmSync(dir, { recursive: true, force: true });
});

const session = (title: string) => ({ id: 's1', project: 'demo', role: 'session', title, status: 'idle' });
const question = {
  id: 7, sessionId: 's1', askedAt: Date.now(), question: 'Long command', options: ['Allow once', 'Deny'], addressedTo: 'user',
  status: 'open', answer: null, answeredAt: null, answeredBy: null, aboutQuestion: null, forwardedFrom: null, aboutRequest: null,
  shots: null, deliveredAt: null, withdrawnReason: null,
  details: { title: 'Auto mode refused a call', issue: `A long command waits.\n\n\`\`\`bash\n${LONG}\n\`\`\`\n\n| a | b |\n|---|---|\n| 1 | 2 |`, tier: 'Housekeeping' },
};

function render(container: Element, element: unknown) {
  const reactRoot = page.createRoot(container);
  page.act(() => reactRoot.render(element));
  return reactRoot;
}

test('a live update keeps the code block and table of an open question, and where they are scrolled', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const props = (sessions: unknown[]) => ({
    questions: [question], permissions: [], sessions, projects: [{ name: 'demo', questionTiers: ['Housekeeping'] }], chats: null,
    userName: 'Simon', questionId: 7, onOpenQuestion: () => {}, onOpenSession: () => {}, onGoToConversation: () => {},
    onClose: () => {}, onLeaveShots: () => {}, sidebarHidden: false, onToggleSidebar: () => {}, newComputers: [], linkPairings: [],
    orders: [], run: async () => {},
  });
  const reactRoot = render(container, page.createElement(page.WaitingView, props([session('Worker')])));
  try {
    const pre = container.querySelector('.issue .code-block pre')!;
    const table = container.querySelector('.issue .table-scroll')!;
    assert.ok(pre && table, 'the question shows its command as a code block, and its table');
    assert.match(pre.textContent!, /--option-29=value-29/);
    pre.scrollLeft = 400;
    table.scrollLeft = 50;

    // A live update: the session list arrives anew (another status, another title), so the whole page is drawn again.
    page.act(() => reactRoot.render(page.createElement(page.WaitingView, props([{ ...session('Worker, renamed'), status: 'working' }]))));
    page.act(() => reactRoot.render(page.createElement(page.WaitingView, props([session('Worker, renamed')]))));
    // assert.ok, not equal: printing two happy-dom elements in a failure's diff takes minutes.
    assert.ok(container.querySelector('.issue .code-block pre') === pre, 'the same <pre>, not a new one');
    assert.ok(container.querySelector('.issue .table-scroll') === table, 'the same table box');
    assert.equal(pre.scrollLeft, 400, 'still scrolled where it was');
    assert.equal(table.scrollLeft, 50);
  } finally {
    page.act(() => reactRoot.unmount());
    container.remove();
  }
});

test('Markdown keeps its elements when the caller passes a new closure, and links call the newest one', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const opened: string[] = [];
  const md = (tag: string) => page.createElement(page.Markdown, {
    text: `See [the notes](docs/notes.md).\n\n\`\`\`\n${LONG}\n\`\`\``, baseDir: 'web', onOpenFile: (p: string) => opened.push(`${tag}:${p}`),
  });
  const reactRoot = render(container, md('first'));
  try {
    const pre = container.querySelector('pre')!;
    const link = container.querySelector('a.file-link')!;
    page.act(() => reactRoot.render(md('second')));
    assert.ok(container.querySelector('pre') === pre, 'the same <pre>');
    assert.ok(container.querySelector('a.file-link') === link, 'the same link');
    page.act(() => link.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as Event));
    assert.deepEqual(opened, ['second:web/docs/notes.md'], 'the click goes to the handler given last, resolved against baseDir');
  } finally {
    page.act(() => reactRoot.unmount());
    container.remove();
  }
});
