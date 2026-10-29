// The Shared tab draws other people's files (issue #364), so a strange name in one of them must not break it for
// everyone: a limit kind, status, project or model of "__proto__" (review of PR #372, finding 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SharedUsageView } from '../src/shared/published-usage.ts';
import { bucket, day, generatedFleet } from './shared-usage-files.ts';
import { removeTemp } from './temp.ts';

const NOW = new Date(2026, 9, 28, 12, 0).getTime();

test('a file with "__proto__" as its limit kind, status, model and project still draws, with the other computers', async () => {
  const { build, stop } = await import('esbuild');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-shared-page-'));
  const { Window } = await import('happy-dom');
  const win = new Window({ url: 'http://127.0.0.1:4396/' });
  try {
    const out = path.join(dir, 'page.mjs');
    await build({
      stdin: {
        contents: "export { SharedView } from './web/src/usage/SharedView.tsx'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server.browser';",
        resolveDir: path.join(import.meta.dirname, '..'), loader: 'ts',
      },
      bundle: true, format: 'esm', platform: 'browser', outfile: out, logLevel: 'silent',
      loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
    });
    for (const key of ['window', 'document', 'localStorage', 'location', 'matchMedia', 'navigator']) {
      Object.defineProperty(globalThis, key, { value: (win as any)[key], configurable: true, writable: true });
    }
    (globalThis as any).MessageChannel = class {
      port1: { onmessage: ((e: unknown) => void) | null } = { onmessage: null };
      port2 = { postMessage: () => setImmediate(() => this.port1.onmessage?.({})) };
    };
    const page = await import(pathToFileURL(out).href);
    const odd = generatedFleet(NOW)[2]!;
    odd.accounts[0]!.limits = [{ kind: '__proto__', status: '__proto__', utilization: 0.5, resetsAt: NOW + 3_600_000, seenAt: NOW }];
    odd.accounts[0]!.daily.push({ ...bucket('__proto__', 5, 1, '__proto__'), t: day(NOW) });
    const files = [generatedFleet(NOW)[0]!, odd];
    const view: SharedUsageView = {
      repo: 'org/usage', canRemove: false, error: null, checkedAt: NOW,
      entries: files.map((f) => ({ id: f.computerId, own: false, state: 'ok', login: f.login, computer: f.computer, asOf: f.asOf, stale: false, file: f })),
    };
    const html: string = page.renderToStaticMarkup(page.createElement(page.SharedView, { view, now: NOW }));
    assert.match(html, /Alice Max/, 'the other computers still show');
    assert.match(html, /Bob Pro/);
    assert.match(html, /<span>__proto__<\/span>/, 'the odd limit is named by its kind');
    assert.match(html, /50%/);
  } finally {
    await win.happyDOM.close();
    await stop();
    removeTemp(dir);
  }
});
