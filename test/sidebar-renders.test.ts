// The sidebar is not drawn again by a live event that changes nothing in it (issue #233, Martin 08:36, Ledung question
// #2069 "b — A render-count test instead"): the whole page with 60 sessions, one message arriving in the open
// conversation, and a count of the sidebar's rows drawn. An inline prop or handler where the page draws the sidebar
// breaks its memo, and this test then counts every row again.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';
import { Window } from 'happy-dom';

const root = path.join(import.meta.dirname, '..');
const SESSIONS = 60;

/** Each name drawn through the page's name component, the sidebar rows' and the session header's. */
const named: string[] = [];
(globalThis as any).__namedDrawn = named;
/** The page's live connection, as the fake below makes it. */
let socket: { onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; close(): void } | null = null;

let page: any;
let dir: string;
let win: Window;

before(async () => {
  win = new Window({ url: 'http://127.0.0.1:4398/#/s/m' });
  for (const key of ['window', 'document', 'localStorage', 'location', 'history', 'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent']) {
    Object.defineProperty(globalThis, key, { value: (win as any)[key], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  // As in typing-renders.test.ts: act() through setImmediate, so Node can exit.
  (globalThis as any).MessageChannel = class {
    port1: { onmessage: ((e: unknown) => void) | null } = { onmessage: null };
    port2 = { postMessage: () => setImmediate(() => this.port1.onmessage?.({})) };
  };
  // The live connection is the test's: it opens when told and delivers what the test sends.
  (globalThis as any).WebSocket = class {
    onopen?: () => void;
    onmessage?: (e: { data: string }) => void;
    onclose?: () => void;
    constructor() {
      socket = this;
    }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  };
  // Ledung's answers: the open session has no history yet; anything else is refused, as a page with no server gets.
  (globalThis as any).fetch = async (url: string) =>
    String(url).includes('/messages')
      ? new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response('{"error":"not in this test"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  dir = mkdtempSync(path.join(tmpdir(), 'ledung-sidebar-'));
  const out = path.join(dir, 'page.mjs');
  await build({
    stdin: {
      contents: [
        "export { App } from './web/src/App.tsx';",
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
      name: 'counting-names',
      setup(b) {
        const real = path.join(root, 'web', 'src', 'components', 'ProjectName.tsx').replace(/\\/g, '/');
        // The page's name module with a counting Named; the stand-in's own import of it resolves as usual.
        b.onResolve({ filter: /\/ProjectName\.tsx$/ }, (args) => (args.namespace === 'stub' ? undefined : { path: 'names', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: [
            `import { Named as Real } from '${real}';`,
            `export * from '${real}';`,
            "import { createElement } from 'react';",
            'export function Named(props) {',
            '  globalThis.__namedDrawn.push(String(props.children));',
            '  return createElement(Real, props);',
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

function session(id: string, more: Record<string, unknown> = {}) {
  return {
    id, project: 'demo', runner: 'local', title: `Session ${id}`, role: 'worker', status: 'idle', permissionMode: 'default',
    claudeSessionId: `c-${id}`, model: null, requestedModel: null, profile: null, clearDue: null, clearedAt: null, compacting: null,
    claudeVersion: null, cwd: null, workDir: null, createdAt: 1, endedAt: null, endReason: null, parentId: 'm', backgroundTasks: 0,
    branch: null, contextTokens: null, contextWindow: null, pr: null, tickets: [], priority: 'normal', priorityNote: null, paused: false,
    queuedAt: null, account: null, archivedAt: null, order: null, position: null, remoteControl: null, ...more,
  };
}

/** A manager and the sessions it runs: 60 in all, every one idle so no ship ticks during the count. */
const sessions = [session('m', { role: 'manager', title: 'The manager', parentId: null }), ...Array.from({ length: SESSIONS - 1 }, (_, i) => session(`w${i + 1}`))];

function hello() {
  return {
    type: 'hello', build: 'test', canRestart: false, userName: 'Simon', sessions, permissions: [], questions: [],
    projects: [{ name: 'demo', managerId: 'm', where: 'This computer', account: null, colours: { manager: null, session: null }, profiles: {}, workflow: null }],
    limits: [], away: null, profiles: ['full'],
  };
}

const deliver = (event: unknown) => page.act(async () => socket!.onmessage!({ data: JSON.stringify(event) }));
/** The sidebar rows drawn: every name but the open manager's, which its own header draws too. */
const rowsDrawn = () => named.filter((n) => n !== 'The manager');

test('a message in the open conversation draws no sidebar row again; a change to a session draws them', async (t) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const r = page.createRoot(host);
  // Unmounted however the test ends: the page's shared clock would otherwise keep Node running after a failure.
  t.after(() => page.act(async () => r.unmount()));
  await page.act(async () => r.render(page.createElement(page.App)));
  await page.act(async () => socket!.onopen?.());
  await deliver(hello());
  // The probe sees the rows: each of the 59 sessions under the manager drawn on arriving.
  assert.ok(rowsDrawn().length >= SESSIONS - 1, `rows drawn on arriving: ${rowsDrawn().length}`);

  named.length = 0;
  const text = 'A message that arrives while the conversation is open.';
  await deliver({ type: 'message', message: { id: 1, sessionId: 'm', at: 1_700_000_000_000, kind: 'sdk', data: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } } } });
  // The message did arrive and was drawn: the page did redraw for it.
  assert.ok(host.textContent!.includes(text), 'the message is shown');
  assert.deepEqual(rowsDrawn(), [], `sidebar rows drawn again for a message: ${rowsDrawn().length}`);

  // A session that starts working: the sidebar shows that, so it is drawn again.
  named.length = 0;
  await deliver({ type: 'session', session: { ...sessions[5], status: 'waiting' } });
  assert.ok(rowsDrawn().length > 0, 'the sidebar redraws when a session changes');
});
