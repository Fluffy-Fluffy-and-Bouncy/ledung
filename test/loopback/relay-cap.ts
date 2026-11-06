// Loopback for issue #161: the byte cap per owner on a real relay. The Mac is Martin's and the relay's admin; the PC
// is Bob's. Managers (Haiku) on the two linked throwaway Ledungs send files through the relay, end to end. Settings →
// Relay → Owners on the Mac shows both owners' bytes; with no cap Bob's files go; a cap Bob has reached throttles his
// computer's streams (a page asset crawls but arrives) and makes his Ledung refuse file transfers both ways with the
// sentence, while messages still go; Martin's own can't be capped; a relay restart keeps the counts; removing the cap
// lets files through again at once. Not in CI (two Ledungs, a few Haiku turns).
//
//   npm run build && node test/loopback/relay-cap.ts      # ports 4396 and 4397
//   PLAYWRIGHT=/path/to/playwright-core CHROMIUM=/path/to/chrome node test/loopback/relay-cap.ts   # with a shot (dark)
//
// The two Ledungs, the relay and the front: linked-pair.ts. Shots and logs land in .test/relay-cap.
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { hashSecret } from '../../relay/relay.ts';
import { relayCapSentence } from '../../src/remote/tunnel.ts';
import { check, failed, link, type Page, repo, startPair, until } from './linked-pair.ts';

const work = path.join(repo, '.test', 'relay-cap');
const TURN_MS = 240_000;
const ADMIN_KEY = 'the loopback admin key of the Mac';
/** 128 KiB/s past the cap here, so the crawl is seconds, not the minutes 64 KiB/s would take. */
const RATE = 128 * 1024;

function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)))]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const messages = async (page: Page, id: string) => JSON.stringify((await page.api('GET', `sessions/${id}/messages?limit=500`)).json).replace(/\\+"/g, '"').replace(/\\+n/g, '\n');
const state = async (page: Page) => (await page.api('GET', 'state')).json as { sessions: { id: string; status: string }[]; remote: { relayCap?: { resetsOn: string } } | null };
const idle = (page: Page, id: string, what: string) => until(async () => (await state(page)).sessions.find((s) => s.id === id)?.status === 'idle', what, TURN_MS);
type Owner = { owner: string; computers: number; today: number; month: number; cap: number | null; capped: boolean; you: boolean };
const owners = async (page: Page) => (await page.api('GET', 'relay-owners')).json as { owners: Owner[]; resetsOn: string };
const ownerOf = async (page: Page, name: string) => (await owners(page)).owners.find((o) => o.owner === name)!;

/**
 * Tells a manager to make one tool call and gives its history from then on, once that call's result is in and the
 * manager is idle. It waits for any turn already running first: a message from the other computer starts one.
 */
async function turn(page: Page, id: string, text: string, what: string): Promise<string> {
  await idle(page, id, `${what}: the manager free`);
  const before = (await messages(page, id)).length;
  await page.api('POST', `sessions/${id}/messages`, { text });
  await until(async () => (await messages(page, id)).slice(before).includes('"tool_result"'), `${what}: the tool's answer`, TURN_MS);
  await idle(page, id, what);
  return (await messages(page, id)).slice(before);
}

/** One GET through the relay's front to a public name, over TLS ending in that Ledung, as a phone's browser would. */
function viaRelay(front: number, name: string, route: string, ca: string): Promise<{ status: number; bytes: number; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = https.request({ method: 'GET', path: route, headers: { host: name }, createConnection: () => tls.connect({ host: '127.0.0.1', port: front, servername: name, ca, ALPNProtocols: ['http/1.1'] }) }, (res) => {
      let bytes = 0;
      res.on('data', (d: Buffer) => (bytes += d.length));
      res.on('end', () => resolve({ status: res.statusCode!, bytes, ms: Date.now() - t0 }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function shot(page: Page, file: string): Promise<boolean> {
  if (!process.env.PLAYWRIGHT || !process.env.CHROMIUM) return false;
  const mod = await import(process.env.PLAYWRIGHT) as { chromium?: any; default?: { chromium: any } };
  const chromium = mod.chromium ?? mod.default!.chromium;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 1000 }, colorScheme: 'dark' });
    const tab = await ctx.newPage();
    await tab.goto(`${page.origin}/login?token=${page.token}`);
    await tab.goto(`${page.origin}/#/settings/remote`);
    const owners = tab.locator('.relay-owners');
    await owners.waitFor({ timeout: 20_000 });
    await tab.locator('.relay-owners li').first().waitFor({ timeout: 20_000 });
    await owners.scrollIntoViewIfNeeded();
    await tab.waitForTimeout(300);
    await owners.screenshot({ path: path.join(work, 'shots', file) });
    return true;
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const project = (name: string) => ({ name, runner: 'local', path: path.join(work, `project-${name}`), model: 'haiku', managerModel: 'haiku', permissionMode: 'default' });
  const pair = await startPair(work, { mac: [project('Alpha')], pc: [project('Beta')] }, {
    ports: { mac: 4396, pc: 4397 },
    relay: { owners: { mac: 'Martin', pc: 'Bob' }, adminKeySha256: hashSecret(ADMIN_KEY), usage: path.join(work, 'relay.usage.json'), limits: { capThrottleBytesPerSecond: RATE } },
  });
  const { mac, pc } = pair.pages;
  const ca = fs.readFileSync(path.join(work, 'trust.pem'), 'utf8');
  fs.writeFileSync(path.join(work, 'project-Alpha', 'shot.png'), png(320, 180, [40, 140, 220]));
  fs.writeFileSync(path.join(work, 'project-Beta', 'pc.png'), png(240, 160, [220, 120, 40]));
  // Settings → Relay on the Mac: the relay's address and the admin key, as Make admin key would leave them.
  fs.writeFileSync(path.join(mac.data, 'relay-admin.json'), JSON.stringify({ relay: `ws://127.0.0.1:${pair.relayPort}`, adminKey: ADMIN_KEY }), { mode: 0o600 });
  const asset = `/assets/${fs.readdirSync(path.join(repo, 'web', 'dist', 'assets')).filter((f) => f.endsWith('.js')).sort((a, b) => fs.statSync(path.join(repo, 'web', 'dist', 'assets', b)).size - fs.statSync(path.join(repo, 'web', 'dist', 'assets', a)).size)[0]}`;
  const assetBytes = fs.statSync(path.join(repo, 'web', 'dist', asset)).size;
  try {
    console.log('== 1. Link; Settings → Relay lists both owners, Martin as "you", nobody capped ==');
    await link(pair.pages);
    const first = await owners(mac);
    const martin0 = first.owners.find((o) => o.owner === 'Martin');
    const bob0 = first.owners.find((o) => o.owner === 'Bob');
    check(first.owners[0]?.owner === 'Martin' && !!martin0?.you && martin0.cap === null, 'Martin first, marked you, no cap', JSON.stringify(first.owners));
    check(!!bob0 && !bob0.you && bob0.cap === null && !bob0.capped && bob0.month > 0, 'Bob uncapped, his bytes counted from the start (the link\'s own calls)', JSON.stringify(bob0));
    const refused = await mac.api('POST', 'relay-owners/Martin/cap', { cap: 1 });
    check(refused.status === 400 && /never capped/.test(JSON.stringify(refused.json)), 'a cap for Martin\'s own is refused', JSON.stringify(refused.json));

    const beta = (await pc.api('POST', 'projects/Beta/manager', { text: 'Test manager in a Ledung loopback. Reply with the single word "ready" and stop. Later messages tell you exactly which tool to call; do only that, quote the tool\'s answer exactly, and stop.' })).json;
    const alpha = (await mac.api('POST', 'projects/Alpha/manager', { text: 'Test manager in a Ledung loopback. Reply with the single word "ready" and stop. Later messages tell you exactly which tool to call; do only that, quote the tool\'s answer exactly, and stop.' })).json;
    await idle(pc, beta.id, 'Beta to be ready');
    await idle(mac, alpha.id, 'Alpha to be ready');
    const send = (to: string, computer: string, text: string, files?: string[]) => `Call message_manager once: id "${to}", computer "${computer}", text "${text}"${files ? `, attachments ${JSON.stringify(files)}` : ''}. Quote the tool's answer exactly and stop.`;

    console.log('== 2. Under the cap (none set): a file goes, at full speed ==');
    const fastAsset = await viaRelay(pair.front, 'pc.l.test', asset, ca);
    check(fastAsset.status === 200 && fastAsset.bytes === assetBytes, 'Bob\'s page asset through the relay', `${fastAsset.bytes} bytes in ${fastAsset.ms} ms`);
    const sent1 = await turn(mac, alpha.id, send(beta.id, 'PC', 'one', ['shot.png']), 'Alpha sends a file');
    check(/With 1 file\(s\): shot\.png/.test(sent1), 'Alpha\'s file to Bob\'s PC went');

    console.log('== 3. Bob at his cap: throttled, told, files refused both ways, messages still go ==');
    const bobNow = await ownerOf(mac, 'Bob');
    const capSet = await mac.api('POST', 'relay-owners/Bob/cap', { cap: bobNow.month });
    check(capSet.status === 200, 'cap set to what Bob has moved so far', `${bobNow.month} bytes`);
    const capped = await until(async () => (await state(pc)).remote?.relayCap ?? null, 'the PC to hear it is capped');
    check(capped.resetsOn === first.resetsOn && !(await state(mac)).remote?.relayCap, 'the PC is told until when; the Mac is told nothing', JSON.stringify(capped));
    check((await ownerOf(mac, 'Bob')).capped, 'Settings shows Bob as past his cap');
    const toBob = await turn(mac, alpha.id, send(beta.id, 'PC', 'two', ['shot.png']), 'Alpha tries a file to the capped PC');
    check(toBob.includes(relayCapSentence(capped.resetsOn, false)), 'the PC refused it with the sentence', relayCapSentence(capped.resetsOn, false));
    const textToBob = await turn(mac, alpha.id, send(beta.id, 'PC', 'just text'), 'Alpha sends text to the capped PC');
    check(/Sent to manager "Manager: Beta"/.test(textToBob), 'a message without files still reaches Bob\'s PC');
    const fromBob = await turn(pc, beta.id, send(alpha.id, 'Mac', 'from bob', ['pc.png']), 'Beta tries a file from the capped PC');
    check(fromBob.includes(relayCapSentence(capped.resetsOn, true)), 'the PC refused to send it, with the sentence', relayCapSentence(capped.resetsOn, true));
    const textFromBob = await turn(pc, beta.id, send(alpha.id, 'Mac', 'text from bob'), 'Beta sends text from the capped PC');
    check(/Sent to manager "Manager: Alpha"/.test(textFromBob), 'a message without files still goes from Bob\'s PC');
    const slowAsset = await viaRelay(pair.front, 'pc.l.test', asset, ca);
    // The fewest milliseconds the throttle allows: the bytes at the rate, less what it lets ahead (1 s of slack, one
    // 64 KiB chunk, and the half second its release comes early).
    const least = (assetBytes / RATE) * 1000 - (1000 + (64 * 1024 / RATE) * 1000 + 500);
    check(slowAsset.status === 200 && slowAsset.bytes === assetBytes && slowAsset.ms >= least, 'the same asset still arrives whole, but crawls at the throttle', `${slowAsset.ms} ms against ${fastAsset.ms} ms; at least ${Math.round(least)} ms at ${RATE / 1024} KiB/s`);
    const macAsset = await viaRelay(pair.front, 'mac.l.test', asset, ca);
    check(macAsset.status === 200 && macAsset.ms < least / 2, 'Martin\'s own computer at full speed meanwhile', `${macAsset.ms} ms`);
    if (await shot(mac, 'mac-settings-relay-owners.png')) check(true, 'shot: Settings → Relay → Owners with Bob capped (dark)', 'shots/mac-settings-relay-owners.png');

    console.log('== 4. A relay restart keeps the counts and the cap ==');
    const before = await owners(mac);
    await pair.restartRelay();
    const after = await owners(mac);
    const pick = (v: typeof before) => v.owners.map((o) => [o.owner, o.today, o.month, o.cap, o.capped, o.you]);
    check(JSON.stringify(pick(after)) === JSON.stringify(pick(before)), 'Settings → Relay shows the same bytes, cap and state after the restart', JSON.stringify(pick(after)));
    await until(async () => (await state(pc)).remote?.relayCap ?? null, 'the PC back and told again after the hello', 60_000);
    check(true, 'the PC reconnected and was told it is still capped');

    console.log('== 5. Removing the cap lets files through at once ==');
    const removed = await mac.api('POST', 'relay-owners/Bob/cap', { cap: null });
    check(removed.status === 200, 'cap removed');
    await until(async () => !(await state(pc)).remote?.relayCap, 'the PC to hear the cap is gone');
    const sent2 = await turn(mac, alpha.id, send(beta.id, 'PC', 'three', ['shot.png']), 'Alpha sends a file again');
    check(/With 1 file\(s\): shot\.png/.test(sent2), 'Alpha\'s file to Bob\'s PC goes again');

    console.log('== 6. The relay\'s log ==');
    const log = fs.readFileSync(path.join(work, 'relay.log'), 'utf8');
    check(/ owner capped owner="Bob"/.test(log) && / owner cap lifted owner="Bob"/.test(log), 'the cap and its lifting are logged');
    check(/EXERCISED #161 relay throttled an owner past their monthly cap/.test(log), 'EXERCISED #161 in the relay\'s log');
    check(!/\/link\/|IHDR|from bob|just text/.test(log), 'nothing that went through is in the log');
    check(!pair.seen.clear, 'the server\'s side carried only TLS');
  } finally {
    await pair.close();
  }
  console.log(failed() ? `${failed()} FAILED` : 'ALL PASSED');
  process.exitCode = failed() ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
