// Issue #323: typing in a long conversation lagged, because every key press redrew every message on screen. The
// message box now keeps its own text and the conversation is memoized; these tests run the real session view in a
// small browser stand-in (happy-dom) and count how often a message's Markdown is drawn.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';
import { Window } from 'happy-dom';

const root = path.join(import.meta.dirname, '..');
const MESSAGES = Number(process.env.TYPING_MESSAGES ?? 500);
const DRAFT_KEY = 'ledung.draft.s1';

/**
 * Markdown drawn, per message text. A light stand-in draws it (react-markdown is slow in happy-dom); set
 * TYPING_REAL_MARKDOWN=1 to draw the real one, e.g. to time typing.
 */
const drawn: string[] = [];
(globalThis as any).__markdownDrawn = drawn;

let page: any;
let dir: string;
let win: Window;

before(async () => {
  win = new Window({ url: 'http://127.0.0.1:4394/' });
  // What React and the page reach for as browser globals.
  for (const key of ['window', 'document', 'localStorage', 'location', 'history', 'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent']) {
    Object.defineProperty(globalThis, key, { value: (win as any)[key], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // Bundled, React's act() queues its work through a new MessageChannel each time, whose ports keep Node from
  // exiting; one that posts through setImmediate does the same and lets go.
  (globalThis as any).MessageChannel = class {
    port1: { onmessage: ((e: unknown) => void) | null } = { onmessage: null };
    port2 = { postMessage: () => setImmediate(() => this.port1.onmessage?.({})) };
  };
  dir = mkdtempSync(path.join(tmpdir(), 'ledung-typing-'));
  const out = path.join(dir, 'page.mjs');
  await build({
    stdin: {
      contents: [
        "export { SessionView } from './web/src/App.tsx';",
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
    plugins: [{
      name: 'counting-markdown',
      setup(b) {
        const real = path.join(root, 'web', 'src', 'components', 'Markdown.tsx').replace(/\\/g, '/');
        // The page's Markdown module with a counting Markdown; the stand-in's own import of it resolves as usual.
        b.onResolve({ filter: /\/Markdown\.tsx$/ }, (args) => (args.namespace === 'stub' ? undefined : { path: 'markdown', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: [
            "import { createElement } from 'react';",
            `import { Markdown as Real } from '${real}';`,
            `export * from '${real}';`,
            'export function Markdown(props) {',
            '  globalThis.__markdownDrawn.push(props.text);',
            `  return ${process.env.TYPING_REAL_MARKDOWN ? 'createElement(Real, props)' : "createElement('div', { className: 'markdown' }, props.text)"};`,
            '}',
          ].join('\n'),
          loader: 'js',
          resolveDir: root,
        }));
      },
    }],
  });
  page = await import(pathToFileURL(out).href);
});

after(async () => {
  await win?.happyDOM.close();
  await stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function session() {
  return {
    id: 's1', project: 'demo', runner: 'local', title: 'Long talk', role: 'manager', status: 'idle', permissionMode: 'default',
    claudeSessionId: 'c1', model: null, requestedModel: null, profile: null, clearDue: null, clearedAt: null, compacting: null,
    claudeVersion: null, cwd: null, workDir: null, createdAt: 1, endedAt: null, endReason: null, parentId: null, backgroundTasks: 0,
    branch: null, contextTokens: null, contextWindow: null, pr: null, tickets: [], priority: 'normal', priorityNote: null, paused: false,
    queuedAt: null, account: null, archivedAt: null, order: null, remoteControl: null,
  };
}

function assistant(id: number, text: string) {
  return { id, at: 1_700_000_000_000 + id * 1000, kind: 'sdk', data: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } } };
}

const long = (i: number) => `Message ${i}.\n\n${'A long paragraph with **bold**, `code` and a [link](https://example.com). '.repeat(20)}`;

function ledung(messages: unknown[]) {
  return {
    sessions: [session()], projects: [{ name: 'demo', colours: null }], chats: null, machine: null, overview: null, board: null, away: null,
    questions: {}, permissions: {}, messages, hasEarlier: false, loadEarlier: async () => {}, userName: 'Simon', bangShell: 'bash',
  };
}

function props(l: unknown) {
  // New closures each time, as App makes them on every render.
  return {
    session: (l as any).sessions[0], ledung: l, pendingCount: 0, run: async (a: () => Promise<unknown>) => { await a(); },
    focusQuestion: (l as any).focusQuestion ?? null, cameFrom: null, onOpenQuestion: () => {}, onOpenBoardThread: () => {}, onBack: () => {},
  };
}

async function mount(l: unknown) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const r = page.createRoot(host);
  await page.act(async () => r.render(page.createElement(page.SessionView, props(l))));
  return {
    rerender: (next: unknown) => page.act(async () => r.render(page.createElement(page.SessionView, props(next)))),
    unmount: () => page.act(async () => r.unmount()),
    box: () => host.querySelector('.composer textarea') as unknown as HTMLTextAreaElement,
    host,
  };
}

/** Types as a browser does: the box's value changes, then an input event. */
async function type(box: HTMLTextAreaElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor((win as any).HTMLTextAreaElement.prototype, 'value')!.set!;
  for (const ch of text) {
    await page.act(async () => {
      setValue.call(box, box.value + ch);
      box.dispatchEvent(new (win as any).Event('input', { bubbles: true }));
    });
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('typing in a conversation of 500 long messages draws no message again', async () => {
  localStorage.clear();
  const messages = Array.from({ length: MESSAGES }, (_, i) => assistant(i + 1, long(i + 1)));
  const view = await mount(ledung(messages));
  assert.equal(drawn.length, MESSAGES, 'each message drawn once on opening');
  drawn.length = 0;
  const typed = 'Hello there, how is it going?';
  const start = performance.now();
  await type(view.box(), typed);
  // With the real Markdown, the time per key press is the figure in PR #323's description.
  if (process.env.TYPING_REAL_MARKDOWN) console.log(`${MESSAGES} messages: ${((performance.now() - start) / typed.length).toFixed(1)} ms per key press`);
  assert.equal(view.box().value, typed);
  assert.equal(drawn.length, 0, `messages drawn again while typing: ${drawn.length}`);
  await view.unmount();
});

test('a live update redraws only what changed: the view drawn again with new handlers draws no message, a new message draws one', async () => {
  localStorage.clear();
  const messages = Array.from({ length: MESSAGES }, (_, i) => assistant(i + 1, long(i + 1)));
  const l = ledung(messages);
  const view = await mount(l);
  drawn.length = 0;
  // App draws the view again on every live event, with new closures and a new copy of its state.
  await view.rerender({ ...l, sessions: [{ ...session(), backgroundTasks: 1 }] });
  assert.equal(drawn.length, 0, 'a session change redrew the messages');
  await view.rerender({ ...l, messages: [...messages, assistant(MESSAGES + 1, 'The newest one')] });
  assert.deepEqual(drawn, ['The newest one']);
  await view.unmount();
});

test('Quote puts the message into the box as a quote, after what was typed', async () => {
  localStorage.clear();
  const view = await mount(ledung([assistant(1, 'First answer'), assistant(2, 'Second answer')]));
  const quotes = view.host.querySelectorAll('.quote-button');
  await page.act(async () => (quotes[0] as any).click());
  assert.match(view.box().value, /^> Claude, .+:\n> First answer\n\n$/);
  await type(view.box(), 'Agreed.');
  await page.act(async () => (quotes[1] as any).click());
  assert.match(view.box().value, /^> Claude, .+:\n> First answer\n\nAgreed\.\n\n> Claude, .+:\n> Second answer\n\n$/);
  assert.equal(document.activeElement, view.box(), 'the box has the focus after Quote');
  await view.unmount();
});

test('the draft is kept: written a moment after the last key, at once on leaving, and back on returning', async () => {
  localStorage.clear();
  const view = await mount(ledung([assistant(1, 'Hi')]));
  await type(view.box(), 'half a thought');
  assert.equal(localStorage.getItem(DRAFT_KEY), null, 'not written on every key');
  await wait(400);
  assert.equal(localStorage.getItem(DRAFT_KEY), 'half a thought');
  await type(view.box(), ' more');
  // Switching to another session unmounts the view before the delay is up.
  await view.unmount();
  assert.equal(localStorage.getItem(DRAFT_KEY), 'half a thought more');
  const back = await mount(ledung([assistant(1, 'Hi')]));
  assert.equal(back.box().value, 'half a thought more');
  await back.unmount();
});

test('the draft is written when the page is hidden or closed', async () => {
  localStorage.clear();
  const view = await mount(ledung([assistant(1, 'Hi')]));
  await type(view.box(), 'typed just before closing');
  window.dispatchEvent(new (win as any).Event('pagehide'));
  assert.equal(localStorage.getItem(DRAFT_KEY), 'typed just before closing');
  await view.unmount();
});

test('opened at a question not loaded yet, it loads earlier messages from the messages shown, not an older list', async () => {
  // Go to conversation on an old question (issue #61): useLedung's loadEarlier works from the messages it was made with.
  const seen: (number | null)[] = [];
  const at = (messages: { id: number }[], hasEarlier: boolean) => ({
    ...ledung(messages), hasEarlier, focusQuestion: 7, loadEarlier: async () => void seen.push(messages[0]?.id ?? null),
  });
  const view = await mount(at([], false));
  await view.rerender(at([assistant(50, 'Later'), assistant(51, 'Latest')], true));
  assert.deepEqual(seen, [50]);
  await view.unmount();
});
