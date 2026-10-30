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

// The page's parts, built once and run in a small browser stand-in (happy-dom), as typing-renders.test.ts does.
const A_ID = 'mac.example.test', B_ID = 'pc.example.test';
const tabsOf = () => [
  { id: A_ID, name: 'Desk Mac', colour: 'green', url: `https://${A_ID}/`, here: true, config: { name: 'Desk Mac', colour: 'green' } },
  { id: B_ID, name: 'Studio PC', colour: 'teal', url: `https://${B_ID}/`, here: false, linked: true, config: { name: 'Studio PC', colour: 'teal' } },
];

async function pageParts(url: string) {
  const { build, stop } = await import('esbuild');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-framed-push-'));
  const { Window } = await import('happy-dom');
  // The frames are never loaded: only which one shows is looked at.
  const win = new Window({ url, settings: { disableIframePageLoading: true, disableJavaScriptFileLoading: true } });
  const g = globalThis as any;
  const kept = { self: g.self, top: g.top };
  const out = path.join(dir, 'page.mjs');
  await build({
    stdin: {
      contents: [
        "export { NotifySwitch } from './web/src/components/SettingsView.tsx';",
        "export { ThisDevice } from './web/src/components/DevicesSettings.tsx';",
        "export { ComputerFrames, ComputerTabs } from './web/src/components/ComputerTabs.tsx';",
        "export { useComputerLink } from './web/src/useComputerLink.ts';",
        "export { computerFrame, shownComputerOf } from './web/src/computerFrame.ts';",
        "export { createElement, useState, act } from 'react';",
        "export { createRoot } from 'react-dom/client';",
        "export { renderToStaticMarkup } from 'react-dom/server.browser';",
      ].join('\n'),
      resolveDir: path.join(import.meta.dirname, '..'), loader: 'ts',
    },
    bundle: true, format: 'esm', platform: 'browser', outfile: out, logLevel: 'silent',
    loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
  });
  for (const key of ['window', 'document', 'localStorage', 'location', 'history', 'matchMedia', 'navigator', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'Event']) {
    Object.defineProperty(globalThis, key, { value: (win as any)[key], configurable: true, writable: true });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.MessageChannel = class {
    port1: { onmessage: ((e: unknown) => void) | null } = { onmessage: null };
    port2 = { postMessage: () => setImmediate(() => this.port1.onmessage?.({})) };
  };
  const page = await import(`${pathToFileURL(out).href}?${Date.now()}`);
  return {
    page, win,
    async close() {
      g.self = kept.self;
      g.top = kept.top;
      await win.happyDOM.close();
      await stop();
      removeTemp(dir);
    },
  };
}

/**
 * The computer tabs and frames wired to the link as App wires them (issue #451): App's showComputer, the same
 * components, and useComputerLink called before anything else reads the address.
 */
async function mountTabs(page: any) {
  const computers = tabsOf();
  function Tabs() {
    const [shown, setShown] = page.useState(null);
    const [opened, setOpened] = page.useState([]);
    page.useComputerLink((id: string) => {
      setShown(id);
      setOpened((list: string[]) => (list.includes(id) ? list : [...list, id]));
    }, false);
    const s = page.shownComputerOf(computers, shown);
    return page.createElement('div', null,
      page.createElement(page.ComputerTabs, { frame: page.computerFrame(computers, false, false), shown: s, onShow: setShown }),
      page.createElement(page.ComputerFrames, { computers, opened, shown: s }));
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = page.createRoot(host);
  await page.act(async () => root.render(page.createElement(Tabs)));
  return {
    shownTab: () => host.querySelector('.ctab.on .nm')?.textContent,
    /** The frames that show, by their computer's name. */
    shownFrames: () => [...host.querySelectorAll('.cframe-box')].filter((b: any) => !b.hidden).map((b: any) => b.querySelector('iframe')?.getAttribute('title')),
    frames: () => host.querySelectorAll('iframe').length,
    unmount: () => page.act(async () => root.unmount()),
  };
}

test('a tapped push for a linked computer opens the page with that computer\'s tab showing, and the address back at the start', { timeout: 30_000 }, async () => {
  const opened = await pageParts(`https://${A_ID}/#/c/${B_ID}`);
  try {
    const { page } = opened;
    // Opened at the link (the service worker's openWindow: no page was open).
    const view = await mountTabs(page);
    assert.equal(view.shownTab(), 'Studio PC');
    assert.deepEqual(view.shownFrames(), ['Studio PC\'s Ledung']);
    assert.equal(location.hash, '', 'a reload lands on this computer');
    // Back on this computer's tab, then a second tap reaches the open page as a hash change (the worker's navigate).
    await page.act(async () => (document.querySelector('button.ctab') as any).click());
    assert.equal(view.shownTab(), 'Desk Mac');
    await page.act(async () => {
      history.replaceState(null, '', `/#/c/${B_ID}`);
      window.dispatchEvent(new (opened.win as any).HashChangeEvent('hashchange'));
    });
    assert.equal(view.shownTab(), 'Studio PC');
    assert.equal(location.hash, '');
    // A computer this page has no tab for shows no frame: this computer's page stays.
    await page.act(async () => (document.querySelector('button.ctab') as any).click());
    await page.act(async () => {
      history.replaceState(null, '', '/#/c/nas.example.test');
      window.dispatchEvent(new (opened.win as any).HashChangeEvent('hashchange'));
    });
    assert.equal(view.shownTab(), 'Desk Mac');
    assert.deepEqual(view.shownFrames(), []);
    await view.unmount();
    const fresh = await mountTabs(page);
    assert.equal(fresh.frames(), 0, 'opened at no link, no frame is made');
    await fresh.unmount();
  } finally {
    await opened.close();
  }
  // App calls it before its own address handling, so that never sees `#/c/…`.
  const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'src', 'App.tsx'), 'utf8');
  const link = app.indexOf('useComputerLink((id)'), own = app.indexOf("window.addEventListener('hashchange', onHash)");
  assert.ok(link > 0 && link < own, 'App takes the link first');
  assert.match(app.slice(link, own), /setShownComputer\(id\);\s+setOpenedComputers\(/);
});

test('Settings in another computer\'s tab says pushes come through the first tab, with no switch that can\'t work there', { timeout: 30_000 }, async () => {
  const opened = await pageParts(`https://${B_ID}/`);
  try {
    const { page } = opened;
    const g = globalThis as any;
    // What the browser in a frame on the phone reports: notifications possible, and blocked (the issue's evidence).
    const notify = { possible: true, on: false, denied: true, set: async () => {} };
    const notifications = (linked: boolean) => page.renderToStaticMarkup(page.createElement(page.NotifySwitch, { notify, linked })) as string;
    // A paired phone with its passkey, unlocked: the case that offers the push switch on its own page.
    const phoneDevice = { id: 'd1', name: 'Phone', createdAt: 1, lastUsedAt: 1, passkey: true, passkeyAt: 1, kind: 'phone', pairedVia: null };
    const phones = (linked: boolean) => page.renderToStaticMarkup(page.createElement(page.ThisDevice, {
      device: phoneDevice, mayAddPasskey: false, unlockedUntil: Date.now() + 600_000, linked, run: async () => {}, onChange: () => {},
    })) as string;
    g.self = {};
    g.top = {};
    for (const html of [notifications(true), phones(true)]) {
      assert.match(html, /Pushes for this computer come through the first tab/);
      assert.doesNotMatch(html, /type="checkbox"|browser blocks notifications|Push notifications to this phone|can.t get push notifications|Home Screen/);
    }
    assert.match(notifications(false), /once the two computers are linked/);
    assert.match(phones(false), /once the two computers are linked/);
    // On its own page both are as before: the switch, or what the browser lacks for push.
    g.top = g.self;
    assert.match(notifications(true), /type="checkbox"/);
    assert.doesNotMatch(phones(true), /come through the first tab/);
    assert.match(phones(true), /push-switch/);
    assert.equal(framedPushNote(true).startsWith('Pushes for this computer come through the first tab'), true);
  } finally {
    await opened.close();
  }
});
