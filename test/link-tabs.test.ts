// Computer tabs and frame permission from the hivemind link (issue #273, docs/steps/computer-tabs-link.md part 1):
// Martin's PC had no `computers` in its config, so it answered frame-ancestors 'none' and its tab on the Mac was white.
// A linked computer is now known as if the config listed it; the config wins; linking, unlinking and a hello take
// effect at once.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { knownComputers } from '../src/shared/computers.ts';
import { waitingCount } from '../src/shared/waiting.ts';
import { LINKS_FILE } from '../src/remote/linked.ts';
import { directive, keyFor, LinkedNodes, until } from './linked-nodes.ts';
import { FakePasskey } from './fake-passkey.ts';
import { frameAnswer, frameAsk, framePaired, pairsThroughLink, shownComputerOf } from '../web/src/computerFrame.ts';

const nodes = new LinkedNodes();
after(() => nodes.close());

const tabs = async (page: Awaited<ReturnType<LinkedNodes['page']>>) =>
  ((await page('GET', 'state')).json.computers as { id: string; name: string; colour: string; here: boolean }[]);

test('the known computers are the config\'s, then the linked ones it does not list; the config wins by public name', () => {
  const config = [{ name: 'Mac', publicName: 'mac.example.test' }, { name: 'Tubal Cain', colour: 'teal' as const, publicName: 'pc.example.test', port: 4399 }];
  const linked = [{ name: 'Gaming PC', publicName: 'PC.example.test', port: 4400 }, { name: 'NAS', publicName: 'nas.example.test', port: 4401 }, { name: 'Old', publicName: 'old.example.test' }];
  assert.deepEqual(knownComputers(config, linked), [
    ...config,
    { name: 'NAS', publicName: 'nas.example.test', port: 4401 },
    // A link that told no port: Ledung's default, as a config entry without one.
    { name: 'Old', publicName: 'old.example.test' },
  ]);
  assert.deepEqual(knownComputers([], []), []);
  // A link's name may be up to 40 characters; a tab's is at most 24.
  assert.equal(knownComputers([], [{ name: 'A'.repeat(40), publicName: 'long.example.test' }])[0]!.name, 'A'.repeat(24));
});

test('linking two Ledungs with no computers in their config gives each the other\'s tab and lets its pages frame this one, at once', { timeout: 20_000 }, async () => {
  const mac = await nodes.ledung('mac.tabs.test');
  const pc = await nodes.ledung('pc.tabs.test');
  const macPage = await nodes.page(mac);
  const pcPage = await nodes.page(pc);
  // Before the link: the PC is framed by nobody, as on Martin's PC on 2026-10-20 ("the screen turns white").
  assert.equal(directive(await nodes.viaTunnel(pc.name, '/', { method: 'GET' }), 'frame-ancestors'), "frame-ancestors 'none'");
  assert.deepEqual((await tabs(pcPage)).map((c) => c.here), [true]);

  await nodes.link(pc, mac, 'Tubal Cain');

  // The PC's public page may now be framed by the Mac's pages: through its public name and its local page, on the
  // port the Mac told when they linked.
  const macPages = [`https://${mac.name}`, `http://127.0.0.1:${mac.port}`, `http://localhost:${mac.port}`];
  for (const p of ['/', '/api/state', '/p/nope']) {
    assert.equal(directive(await nodes.viaTunnel(pc.name, p, { method: 'GET' }), 'frame-ancestors'), `frame-ancestors ${macPages.join(' ')}`, p);
  }
  // The PC's own screen is still never framed.
  assert.equal(directive(await nodes.local(pc, { path: '/' }), 'frame-ancestors'), "frame-ancestors 'none'");
  // And the Mac's pages may show the PC's.
  assert.equal(directive(await nodes.local(mac, { path: '/' }), 'frame-src'), `frame-src 'self' https://${pc.name}`);

  // Tabs on both, this computer first, the other named as it was linked; the open pages got them without a reload.
  assert.deepEqual((await tabs(macPage)).map((c) => [c.id, c.name, c.here]), [['mac.tabs.test', 'host', true], ['pc.tabs.test', 'Tubal Cain', false]]);
  assert.deepEqual((await tabs(pcPage)).map((c) => [c.id, c.here]), [['pc.tabs.test', true], ['mac.tabs.test', false]]);
  await until(() => macPage.events.some((e) => e.type === 'computers' && e.computers.length === 2), 'the Mac page to get the tabs');
  await until(() => pcPage.events.some((e) => e.type === 'computers' && e.computers.length === 2), 'the PC page to get the tabs');

  // A linked computer's tab can be renamed and coloured like a config one (#240).
  const renamed = await macPage('POST', 'computers', { id: 'pc.tabs.test', name: 'PC', colour: 'amber' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.deepEqual((await tabs(macPage)).find((c) => c.id === 'pc.tabs.test'), { ...(await tabs(macPage)).find((c) => c.id === 'pc.tabs.test'), name: 'PC', colour: 'amber' });

  // Unlinking on the Mac removes the tab and the permission on both, at once.
  const link = (await macPage('GET', 'links')).json.links[0];
  assert.equal((await macPage('POST', `links/${link.id}/remove`, {})).status, 200);
  assert.equal(directive(await nodes.local(mac, { path: '/' }), 'frame-src'), null);
  assert.deepEqual((await tabs(macPage)).map((c) => c.id), ['mac.tabs.test']);
  await until(async () => directive(await nodes.viaTunnel(pc.name, '/', { method: 'GET' }), 'frame-ancestors') === "frame-ancestors 'none'", 'the PC to drop the Mac\'s pages');
  assert.deepEqual((await tabs(pcPage)).map((c) => c.id), ['pc.tabs.test']);
});

test('the config wins over a link for name, colour and port', { timeout: 20_000 }, async () => {
  const config = [{ name: 'Mac', publicName: 'mac2.tabs.test', colour: 'pink' as const, port: 4399 }];
  const pc = await nodes.ledung('pc2.tabs.test', config);
  const mac = await nodes.ledung('mac2.tabs.test');
  await nodes.link(mac, pc);
  const pcPage = await nodes.page(pc);
  assert.deepEqual((await tabs(pcPage)).map((c) => [c.id, c.name, c.colour]), [['pc2.tabs.test', 'host', 'green'], ['mac2.tabs.test', 'Mac', 'pink']]);
  // The port the config gives, not the one the Mac told.
  assert.equal(directive(await nodes.viaTunnel(pc.name, '/', { method: 'GET' }), 'frame-ancestors'),
    `frame-ancestors https://${mac.name} http://127.0.0.1:4399 http://localhost:4399`);
});

test('a hello tells the port: kept in links.json, and the framers follow it at once', { timeout: 20_000 }, async () => {
  const mac = await nodes.ledung('mac3.tabs.test');
  const pc = await nodes.ledung('pc3.tabs.test');
  await nodes.link(mac, pc);
  // Each side kept the port the other told when they linked; neither ever sees a key in the page.
  const saved = (node: typeof mac) => JSON.parse(fs.readFileSync(path.join(node.dir, LINKS_FILE), 'utf8')).links[0];
  assert.equal(saved(pc).port, mac.port);
  assert.equal(saved(mac).port, pc.port);

  // The Mac's Ledung now runs on another port and says so; the PC answers with its own.
  const hello = await nodes.viaTunnel(pc.name, '/link/hello', { headers: { authorization: `Bearer ${keyFor(mac, pc)}` }, body: JSON.stringify({ port: 4398 }) });
  assert.equal(hello.status, 200, hello.body);
  assert.deepEqual(JSON.parse(hello.body), { publicName: pc.name, port: pc.port });
  assert.equal(saved(pc).port, 4398);
  assert.equal(directive(await nodes.viaTunnel(pc.name, '/', { method: 'GET' }), 'frame-ancestors'),
    `frame-ancestors https://${mac.name} http://127.0.0.1:4398 http://localhost:4398`);
  // A port that isn't one changes nothing.
  for (const port of [0, 70000, '4397', 4397.5]) {
    await nodes.viaTunnel(pc.name, '/link/hello', { headers: { authorization: `Bearer ${keyFor(mac, pc)}` }, body: JSON.stringify({ port }) });
    assert.equal(saved(pc).port, 4398, String(port));
  }
});

test('a passkey check in a frame on a linked computer\'s page counts from the moment of linking, and stops at unlinking', { timeout: 20_000 }, async () => {
  const pc = await nodes.ledung('pc4.tabs.test');
  const mac = await nodes.ledung('mac4.tabs.test');
  const pcPage = await nodes.page(pc);
  // A device of the PC, paired and with its passkey set up at the top level (the passkey window, #244).
  const made = await pcPage('POST', 'devices-pair', { kind: 'computer' });
  const code = new URL(made.json.url).pathname.slice('/p/'.length);
  const paired = await nodes.viaTunnel(pc.name, '/pair', { body: new URLSearchParams({ code, name: 'Mac browser' }).toString(), headers: { origin: `https://${pc.name}`, 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(paired.status, 303, paired.body);
  const cookie = /^(__Host-ledung_device=[0-9a-f]{64})/.exec(String(paired.headers['set-cookie']))![1]!;
  const pageKey = await nodes.publicPage(pc, cookie);
  const pub = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    nodes.viaTunnel(pc.name, `/api/${route}`, { body: JSON.stringify(body), headers: { cookie, origin: `https://${pc.name}`, 'x-ledung-page': pageKey, ...headers } });
  const key = new FakePasskey(pc.name);
  const options = JSON.parse((await pub('passkey-options', {})).body);
  const registered = await pub('passkey', { response: key.register(options) });
  assert.equal(registered.status, 200, registered.body);
  const unlockIn = async (framedIn: string) => {
    const challenge = JSON.parse((await pub('passkey-challenge', { method: 'POST', path: '/api/device-unlock', body: '{}' })).body);
    return pub('device-unlock', {}, { 'x-ledung-passkey': key.header(challenge, { framedIn }) });
  };
  const macLocal = `http://127.0.0.1:${mac.port}`;
  assert.equal((await unlockIn(macLocal)).status, 403, 'not linked yet: no page may frame the PC');

  await nodes.link(mac, pc);
  assert.equal((await unlockIn(macLocal)).status, 200, 'linked: the Mac\'s local page');
  assert.equal((await unlockIn(`https://${mac.name}`)).status, 200, 'linked: the Mac\'s public page');

  const link = (await pcPage('GET', 'links')).json.links[0];
  assert.equal((await pcPage('POST', `links/${link.id}/remove`, {})).status, 200);
  assert.equal((await unlockIn(macLocal)).status, 403, 'unlinked');
});

test('the page offers Pair through the link only for a linked computer, on this computer\'s own page', () => {
  const pc = { id: 'pc.example.test', name: 'PC', colour: 'green' as const, url: 'https://pc.example.test/', here: false, config: { name: 'PC', colour: 'green' as const } };
  assert.equal(pairsThroughLink({ ...pc, linked: true }, false, false), true);
  assert.equal(pairsThroughLink(pc, false, false), false, 'only in the config, not linked');
  assert.equal(pairsThroughLink({ ...pc, linked: true }, true, false), false, 'through the public name: a phone');
  assert.equal(pairsThroughLink({ ...pc, linked: true }, false, true), false, 'this page in a frame');
  assert.equal(pairsThroughLink({ ...pc, linked: true, here: true }, false, false), false, 'this computer');
});

test('Pair through the link is not offered over a frame that is paired, nor before its page answered (#286)', () => {
  const pc = { id: 'pc.example.test', name: 'PC', colour: 'green' as const, url: 'https://pc.example.test/', here: false, linked: true, config: { name: 'PC', colour: 'green' as const } };
  // Martin, 2026-10-21 10:31: "I lost the tubal cain pairing again on my mac", reading the offer over a paired frame.
  assert.equal(pairsThroughLink(pc, false, false, 'paired'), false, 'the frame is paired');
  assert.equal(pairsThroughLink(pc, false, false, 'unknown'), false, 'its page has not answered yet');
  assert.equal(pairsThroughLink(pc, false, false, 'not-paired'), true, 'no answer in time: the not-paired page');
});

test('a framed page says it is paired only to the page framing it, and that page believes only that frame at its origin (#286)', () => {
  assert.ok(frameAnswer(frameAsk(), true), 'asked by the page that frames it');
  assert.equal(frameAnswer(frameAsk(), false), null, 'asked by any other window');
  assert.equal(frameAnswer('something else', true), null);
  const answer = frameAnswer(frameAsk(), true)!;
  const url = 'https://pc.example.test/';
  assert.equal(framePaired({ data: answer, origin: 'https://pc.example.test', fromFrame: true }, url), true);
  assert.equal(framePaired({ data: answer, origin: 'https://evil.example.test', fromFrame: true }, url), false, 'another origin');
  assert.equal(framePaired({ data: answer, origin: 'https://pc.example.test', fromFrame: false }, url), false, 'not that frame\'s window');
  assert.equal(framePaired({ data: frameAsk(), origin: 'https://pc.example.test', fromFrame: true }, url), false, 'not the answer');
});

test('a shown computer whose tab is gone (unlinked) gives this computer\'s page back, not a blank one', () => {
  const here = { id: 'mac.example.test', name: 'Mac', colour: 'green' as const, url: 'https://mac.example.test/', here: true, config: { name: 'Mac', colour: 'green' as const } };
  const pc = { ...here, id: 'pc.example.test', name: 'PC', url: 'https://pc.example.test/', here: false };
  assert.equal(shownComputerOf([here, pc], 'pc.example.test'), 'pc.example.test');
  assert.equal(shownComputerOf([here], 'pc.example.test'), null, 'the loopback\'s blank page after Unlink');
  assert.equal(shownComputerOf([here, pc], null), null);
});

test('the count a tab shows is what waits for the user there: open questions and pending prompts addressed to the user', () => {
  const q = (status: string, addressedTo: string) => ({ status, addressedTo }) as never;
  assert.equal(waitingCount([q('open', 'user'), q('open', 'manager'), q('answered', 'user')], [q('pending', 'user'), q('pending', 'manager'), q('allowed', 'user')]), 2);
});

test('each linked computer\'s tab shows its Waiting-for-you count, live over the link', { timeout: 20_000 }, async () => {
  // The poll every 30 s, as in use: within this test a count only arrives when the link is made, or pushed on a change.
  const mac = await nodes.ledung('mac5.tabs.test');
  const pc = await nodes.ledung('pc5.tabs.test');
  await nodes.link(mac, pc);
  const macPage = await nodes.page(mac);
  const pcPage = await nodes.page(pc);
  const badge = async (page: typeof macPage, id: string) => ((await page('GET', 'state')).json.computers as { id: string; waiting?: number }[]).find((c) => c.id === id)?.waiting;
  await until(async () => (await badge(macPage, pc.name)) === 0, 'the PC\'s count on the Mac');
  await until(async () => (await badge(pcPage, mac.name)) === 0, 'the Mac\'s count on the PC');
  // This computer's own tab never has one.
  assert.equal(((await macPage('GET', 'state')).json.computers as { here: boolean; waiting?: number }[]).find((c) => c.here)!.waiting, undefined);

  // Something now waits on the PC (a pairing through the link): the Mac's tab for it says 1, and its open page got it.
  assert.equal((await macPage('POST', 'link-device-pair', { id: pc.name })).status, 200);
  await until(() => macPage.events.some((e) => e.type === 'computers' && e.computers.some((c) => c.id === pc.name && c.waiting === 1)), 'the Mac page to get 1');
  const [notice] = (await pcPage('GET', 'state')).json.linkPairings;
  assert.equal((await pcPage('POST', `link-pairings/${notice.id}/dismiss`, {})).status, 200);
  await until(async () => (await badge(macPage, pc.name)) === 0, 'back to 0');

});

test('a linked computer that goes offline loses its badge at the next exchange, rather than showing an old number', { timeout: 20_000 }, async () => {
  const mac = await nodes.ledung('mac6.tabs.test', undefined, 200);
  const pc = await nodes.ledung('pc6.tabs.test');
  await nodes.link(mac, pc);
  const macPage = await nodes.page(mac);
  const badge = async () => ((await macPage('GET', 'state')).json.computers as { id: string; waiting?: number }[]).find((c) => c.id === pc.name)?.waiting;
  await until(async () => (await badge()) === 0, 'the PC\'s count');
  nodes.offline(pc.name);
  await until(async () => (await badge()) === undefined, 'the badge to go while the PC is offline');
});
