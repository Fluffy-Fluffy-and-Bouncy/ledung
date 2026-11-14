// The page's half of a trusted computer (issue #313; Martin, 2026-11-13, question #890: "a — Design a, with a key on
// the tab"): the framing page vouches only for its own frame of a computer that trusts it, the frame takes only the
// framing page's answer, and that computer's tab shows a key.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { vouchAnswer, vouchAnswered, vouchAsk, vouchAsked } from '../web/src/vouch.ts';
import type { ComputerInfo } from '../src/shared/computers.ts';
import { removeTemp } from './temp.ts';

const PC = { url: 'https://pc.l.example.com/', trustsUs: true };
const ask = vouchAsk('abc123', 'A'.repeat(43));

test('the framing page vouches only for its own frame, at that computer\'s origin, of a computer that trusts it', () => {
  const from = { data: ask, origin: 'https://pc.l.example.com', fromFrame: true };
  // Premise: the right frame's ask is taken.
  assert.deepEqual(vouchAsked(from, PC), { id: 'abc123', challenge: 'A'.repeat(43) });
  assert.equal(vouchAsked({ ...from, fromFrame: false }, PC), null, 'another window');
  assert.equal(vouchAsked({ ...from, origin: 'https://evil.example.com' }, PC), null, 'another origin');
  assert.equal(vouchAsked({ ...from, origin: 'http://pc.l.example.com' }, PC), null, 'http, not https');
  assert.equal(vouchAsked(from, { ...PC, trustsUs: false }), null, 'a computer that doesn\'t trust this screen');
  assert.equal(vouchAsked(from, { url: PC.url }), null, 'trust not known');
  for (const data of [{ ...ask, challenge: 'a b' }, { ...ask, challenge: 'x'.repeat(101) }, { ...ask, id: 'ABC!' }, { type: 'ledung:vouch', id: 'abc123', error: null }, null, 'ledung:vouch?']) {
    assert.equal(vouchAsked({ ...from, data }, PC), null, JSON.stringify(data));
  }
});

test('the frame takes only the framing page\'s answer to its own ask', () => {
  // Premise: the answer from the parent to this ask counts, vouched or refused with a reason.
  assert.equal(vouchAnswered(vouchAnswer('abc123', null), true, 'abc123'), null);
  assert.equal(vouchAnswered(vouchAnswer('abc123', 'PC is offline'), true, 'abc123'), 'PC is offline');
  assert.equal(vouchAnswered(vouchAnswer('abc123', null), false, 'abc123'), undefined, 'not from the parent');
  assert.equal(vouchAnswered(vouchAnswer('other', null), true, 'abc123'), undefined, 'another ask');
  assert.equal(vouchAnswered(ask, true, 'abc123'), undefined, 'an ask is no answer');
});

test('a computer that trusts this screen shows a key on its tab; the others and this computer\'s own do not', async () => {
  const { build, stop } = await import('esbuild');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-trusted-tab-'));
  try {
    const out = path.join(dir, 'tabs.mjs');
    await build({
      stdin: {
        contents: "export { ComputerTabs } from './web/src/components/ComputerTabs.tsx'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server.browser';",
        resolveDir: path.join(import.meta.dirname, '..'), loader: 'ts',
      },
      bundle: true, format: 'esm', platform: 'browser', outfile: out, logLevel: 'silent',
      loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
    });
    // React's browser renderer schedules through a MessageChannel, whose open port would keep the test running (as
    // shared-usage-page.test.ts stubs it).
    const channel = (globalThis as any).MessageChannel;
    (globalThis as any).MessageChannel = class {
      port1: { onmessage: ((e: unknown) => void) | null } = { onmessage: null };
      port2 = { postMessage: () => setImmediate(() => this.port1.onmessage?.({})) };
    };
    after(() => {
      (globalThis as any).MessageChannel = channel;
    });
    const page = await import(pathToFileURL(out).href);
    const tab = (id: string, name: string, extra: Partial<ComputerInfo>): ComputerInfo => ({
      id, name, colour: 'blue', here: false, url: `https://${id}/`, config: { name, colour: 'blue' }, ...extra,
    } as ComputerInfo);
    const tabs = [
      tab('mac.l.example.com', 'Mac', { here: true, trustsUs: true }),
      tab('pc.l.example.com', 'PC', { linked: true, trustsUs: true }),
      tab('mini.l.example.com', 'Mini', { linked: true }),
    ];
    const html: string = page.renderToStaticMarkup(page.createElement(page.ComputerTabs, { frame: { tabs, remote: false, here: tabs[0] } }));
    const keys = html.match(/class="ctab-key"/g) ?? [];
    assert.equal(keys.length, 1, html);
    assert.match(html, /<span class="nm">PC<\/span><span class="ctab-key" title="Trusted — PC trusts this computer&#x27;s screen: changes from here need no passkey there"/);
    assert.doesNotMatch(html, /<span class="nm">Mini<\/span><span class="ctab-key"/);
  } finally {
    // esbuild's service would keep the test process alive.
    await stop();
    removeTemp(dir);
  }
});
