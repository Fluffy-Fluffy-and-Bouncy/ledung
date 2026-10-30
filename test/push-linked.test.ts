// One push switch for several linked computers (issue #451, Martin's pick on question #496: "a — One switch, through
// the first computer"): a new item on a linked computer reaches the phones subscribed on this one, titled with that
// computer's name and opening its tab; each item goes one hop, never back. Settings in another computer's tab says
// where pushes come from instead of a switch the browser can't let work there.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { keyFor, LinkedNodes, until, type Node } from './linked-nodes.ts';
import { phone } from './push-phone.ts';
import { computerFromHash } from '../web/src/computerFrame.ts';
import { framedPushNote } from '../web/src/push.ts';
import { removeTemp } from './temp.ts';

const nodes = new LinkedNodes();
const dirs: string[] = [];
after(async () => {
  await nodes.close();
  for (const d of dirs) removeTemp(d);
});

/** A linked Ledung with push, whose "push service" keeps what it was sent. */
async function withPush(name: string, settings?: Parameters<LinkedNodes['ledung']>[1]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-push-linked-'));
  dirs.push(dir);
  const sent: { url: string; body: Buffer }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: Buffer.from(init!.body as Uint8Array) });
    return new Response(null, { status: 201 });
  }) as typeof globalThis.fetch;
  const node = await nodes.ledung(name, settings, undefined, { keyFile: path.join(dir, 'push-vapid.json'), fetch, log: () => {} });
  node.store.createSession({ id: 's1', project: 'p', runner: 'local', title: 'a session', parentId: null, permissionMode: 'default', role: 'session' });
  return { node, sent };
}

/** A phone paired with `node`, push switched on there. */
function subscribedPhone(node: Node) {
  const { code } = node.server.devices.newPairCode('phone');
  const { device } = node.server.devices.pair(code, 'Phone')!;
  const ph = phone();
  node.server.push!.subscribe(device.id, ph.subscription);
  return ph;
}

function newQuestion(node: Node) {
  const q = node.store.createQuestion({ sessionId: 's1', question: 'Ship it?', options: null, addressedTo: 'user' });
  node.server.broadcast({ type: 'question', question: q });
  return q;
}

test('a new item on a linked computer buzzes the phone subscribed on this one, with that computer\'s name, opening its tab', { timeout: 20_000 }, async () => {
  const A = 'mac.pushlink.test', B = 'pc.pushlink.test';
  // A's tabs name B "Studio PC" (its config), the name the phone should see.
  const a = await withPush(A, [{ name: 'Desk Mac', publicName: A }, { name: 'Studio PC', publicName: B }]);
  const b = await withPush(B, [{ name: 'Studio PC', publicName: B }]);
  await nodes.link(a.node, b.node, 'Desk Mac');
  const onA = subscribedPhone(a.node);
  const onB = subscribedPhone(b.node);

  const q = newQuestion(b.node);
  await until(() => a.sent.length === 1, 'A to push B\'s item');
  await b.node.server.push!.settled();
  const got = onA.read(a.sent[0]!.body);
  assert.equal(a.sent[0]!.url, onA.subscription.endpoint);
  assert.deepEqual(got, { computer: 'Studio PC', kind: 'question', item: `${B}:q${q.id}`, open: `/#/c/${B}` });
  // B's own phone gets B's own push, as before.
  assert.equal(b.sent.length, 1);
  assert.deepEqual(onB.read(b.sent[0]!.body), { computer: 'Studio PC', kind: 'question', item: `q${q.id}`, open: `/#/waiting/q/${q.id}` });

  // Tapped on the phone, A's page opens B's tab.
  assert.equal(computerFromHash(new URL(got.open, `https://${A}`).hash), B);

  // The other way too, and one hop only: A's item goes to B's phone once, and nothing comes back to A's.
  a.sent.length = 0;
  b.sent.length = 0;
  const qa = newQuestion(a.node);
  await until(() => b.sent.length === 1, 'B to push A\'s item');
  await new Promise((r) => setTimeout(r, 300));
  await a.node.server.push!.settled();
  await b.node.server.push!.settled();
  assert.equal(a.sent.length, 1, 'A\'s own push only');
  assert.equal(b.sent.length, 1, 'B pushed it once and sent nothing back');
  assert.deepEqual(onB.read(b.sent[0]!.body), { computer: 'Desk Mac', kind: 'question', item: `${A}:q${qa.id}`, open: `/#/c/${A}` });
});

test('/link/push takes only a linked computer\'s key, and only the kinds and tags a push carries', { timeout: 20_000 }, async () => {
  const A = 'mac2.pushlink.test', B = 'pc2.pushlink.test';
  const a = await withPush(A);
  const b = await withPush(B);
  await nodes.link(a.node, b.node);
  const phoneOnA = subscribedPhone(a.node);
  const send = (body: unknown, key: string | null = keyFor(b.node, a.node)) =>
    nodes.viaTunnel(A, '/link/push', { body: JSON.stringify(body), headers: key ? { authorization: `Bearer ${key}` } : {} });
  assert.equal((await send({ kind: 'question', item: 'q1' }, null)).status, 401, 'no key');
  for (const bad of [
    { kind: 'question', item: 'p1' },
    { kind: 'question', item: 'q1x' },
    { kind: 'permission', item: 'p../../x?' },
    { kind: 'board', item: 'q1' },
    { kind: 'question', item: '<b>' },
    { kind: 'question' },
  ]) {
    assert.equal((await send(bad)).status, 400, JSON.stringify(bad));
  }
  await a.node.server.push!.settled();
  assert.equal(a.sent.length, 0, 'nothing refused was pushed');
  // Whatever else comes with it is not used: the address the phone opens is made here.
  assert.equal((await send({ kind: 'permission', item: 'p0f1e2d3c-1', open: 'https://evil.test/' })).status, 200);
  await a.node.server.push!.settled();
  assert.equal(a.sent.length, 1);
  assert.equal(phoneOnA.read(a.sent[0]!.body).open, `/#/c/${B}`);
});

test('the push link names only a computer\'s tab', () => {
  assert.equal(computerFromHash('#/c/pc.example.test'), 'pc.example.test');
  assert.equal(computerFromHash('#/c/PC.Example.test'), 'pc.example.test');
  for (const hash of ['#/waiting/q/1', '#/c/', '#/c/pc.example.test/waiting', '#/c/%E0%A4%A']) assert.equal(computerFromHash(hash), null, hash);
});

test('Settings in another computer\'s tab says pushes come through the first tab, with no switch that can\'t work there', async () => {
  const { build, stop } = await import('esbuild');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-framed-push-'));
  const { Window } = await import('happy-dom');
  const win = new Window({ url: 'https://pc.example.test/' });
  const g = globalThis as any;
  const kept = { self: g.self, top: g.top };
  try {
    const out = path.join(dir, 'page.mjs');
    await build({
      stdin: {
        contents: "export { NotifySwitch } from './web/src/components/SettingsView.tsx'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server.browser';",
        resolveDir: path.join(import.meta.dirname, '..'), loader: 'ts',
      },
      bundle: true, format: 'esm', platform: 'browser', outfile: out, logLevel: 'silent',
      loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
    });
    for (const key of ['window', 'document', 'localStorage', 'location', 'matchMedia', 'navigator']) {
      Object.defineProperty(globalThis, key, { value: (win as any)[key], configurable: true, writable: true });
    }
    g.MessageChannel = class {
      port1: { onmessage: ((e: unknown) => void) | null } = { onmessage: null };
      port2 = { postMessage: () => setImmediate(() => this.port1.onmessage?.({})) };
    };
    const page = await import(pathToFileURL(out).href);
    // What the browser in a frame on the phone reports: notifications possible, and blocked (the issue's evidence).
    const notify = { possible: true, on: false, denied: true, set: async () => {} };
    const render = (linked: boolean) => page.renderToStaticMarkup(page.createElement(page.NotifySwitch, { notify, linked })) as string;
    g.self = {};
    g.top = {};
    const framed = render(true);
    assert.match(framed, /Pushes for this computer come through the first tab/);
    assert.doesNotMatch(framed, /type="checkbox"|browser blocks notifications/);
    assert.match(render(false), /once the two computers are linked/);
    // On its own page the switch is there, as before.
    g.top = g.self;
    assert.match(render(true), /type="checkbox"/);
    assert.equal(framedPushNote(true).startsWith('Pushes for this computer come through the first tab'), true);
  } finally {
    g.self = kept.self;
    g.top = kept.top;
    await win.happyDOM.close();
    await stop();
    removeTemp(dir);
  }
});
