// Loopback for issue #286: a framed computer device keeps its pairing through a cookie renewal and a restart of both
// Ledungs and of the browser, and the Pair through the link offer shows only while the frame is not paired.
// Not in CI (it starts two Ledungs and WebKit).
//
//   PLAYWRIGHT_DIR=<node_modules holding playwright> node test/loopback/frame-renewal.ts
//
// The Mac's local page (4397) shows the PC's page (4398, through its public name pc.l.test) in a frame, as on
// Martin's Mac. WebKit runs with a profile on disk, so closing and opening it again is a browser quit and relaunch;
// it is Playwright's WebKit, Safari's engine, not Safari, and a Dock web app is not reproduced. The browser reaches
// pc.l.test through a CONNECT proxy here that hands *.l.test:443 to the relay's front (linked-pair.ts).
// WebKit has no passkeys here, so logging on is written into the PC's database, as the passkey check would.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { check, failed, link, repo, startPair, until } from './linked-pair.ts';

// playwright is not a dependency of Ledung: it is given from outside, untyped here (as link-pair.ts).
type Frame = any;
type Page = any;
type Context = any;

const work = path.join(repo, '.test', 'frame-renewal');
const PROXY = 51890;
const DAY = 24 * 60 * 60 * 1000;

/** Hands CONNECT *.l.test:443 to the relay's front; anything else is refused. */
function connectProxy(front: number): net.Server {
  return net.createServer((client) => {
    client.once('data', (head: Buffer) => {
      const m = /^CONNECT ([a-z0-9.-]+\.l\.test):443 /i.exec(head.toString('latin1'));
      if (!m) return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      const up = net.connect(front, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        client.pipe(up).pipe(client);
      });
      for (const s of [client, up]) s.on('error', () => { client.destroy(); up.destroy(); });
    });
  });
}

async function main(): Promise<void> {
  const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR!, 'x.js'));
  const { webkit } = require('playwright') as { webkit: any };
  const pair = await startPair(work);
  const { mac, pc } = pair.pages;
  const proxy = connectProxy(pair.front);
  await new Promise<void>((r) => proxy.listen(PROXY, '127.0.0.1', r));
  const profile = path.join(work, 'webkit-profile');
  let ctx: Context | null = null;
  const db = () => new DatabaseSync(path.join(pc.data, 'ledung.db'));
  const row = () => {
    const d = db();
    try { return d.prepare("SELECT * FROM devices WHERE kind = 'computer'").all() as Record<string, any>[]; } finally { d.close(); }
  };
  const write = (sql: string, ...args: (number | string)[]) => {
    const d = db();
    try { d.prepare(sql).run(...args); } finally { d.close(); }
  };
  const open = async (): Promise<{ page: Page; frame: () => Frame | undefined }> => {
    ctx = await webkit.launchPersistentContext(profile, { viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, proxy: { server: `http://127.0.0.1:${PROXY}`, bypass: '127.0.0.1' } });
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto(`${mac.origin}/login?token=${mac.token}`);
    await page.getByRole('navigation', { name: 'Computers' }).waitFor();
    await page.locator('nav.ctabs a.ctab').first().click();
    await page.locator('iframe.cframe').first().waitFor();
    const frame = () => page.frames().find((f: Frame) => f.url().startsWith('https://pc.l.test'));
    await until(() => frame(), 'the PC\'s frame', 15_000);
    return { page, frame };
  };
  const device = async (f: Frame) => f.evaluate(async () => (await fetch('/api/device')).json()).catch((e: unknown) => ({ error: String(e) }));
  try {
    await link(pair.pages);

    console.log('== 1. Pair the frame through the link, in WebKit ==');
    let { page, frame } = await open();
    await until(async () => (await page.getByRole('button', { name: 'Pair through the link' }).isVisible().catch(() => false)) || null, 'the offer over the not-paired frame', 15_000);
    check(true, 'the "Not paired" offer shows over the frame before pairing');
    await page.getByRole('button', { name: 'Pair through the link' }).click();
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await until(() => frame()?.url().includes('/p/'), 'the frame on the pairing form', 15_000);
    await until(async () => (await frame()!.getByRole('button', { name: 'Pair' }).isVisible().catch(() => false)) || null, 'the form', 15_000);
    await frame()!.getByRole('button', { name: 'Pair' }).click();
    await until(() => frame()?.url().includes('#/settings'), 'the frame on Settings', 15_000);
    let d = await device(frame()!);
    check(d.remote === true && d.device?.kind === 'computer', 'paired as a computer in the frame; WebKit keeps and sends the Partitioned cookie', JSON.stringify(d.device ?? d));
    const [paired] = row();
    check(!!paired && paired.partitioned === 1, 'the PC keeps it as a framed (partitioned) device');
    write('UPDATE devices SET logged_on_at = ?, credential_id = ? WHERE id = ?', Date.now(), 'loopback', paired!.id);
    d = await device(frame()!);
    check(typeof d.unlockedUntil === 'number', 'logged on (written as the passkey check would)', String(d.unlockedUntil));

    console.log('== 2. A day later: the cookie is renewed on the frame\'s page load ==');
    write('UPDATE devices SET cookie_at = ? WHERE id = ?', Date.now() - DAY - 60_000, paired!.id);
    const before = row()[0]!.cookie_hash;
    await frame()!.goto('https://pc.l.test/');
    await page.waitForTimeout(1500);
    const renewed = row()[0]!;
    check(renewed.cookie_hash !== before && renewed.old_cookie_hash === before, 'the PC renewed the cookie on that load');
    // The old value now revokes at once, so any later use of it shows as a revoke rather than a quiet grace minute.
    write('UPDATE devices SET old_cookie_until = ? WHERE id = ?', Date.now() - 1, paired!.id);
    d = await device(frame()!);
    check(d.remote === true && !!d.device && typeof d.unlockedUntil === 'number', 'the frame sends the renewed cookie: still paired and logged on', JSON.stringify(d.device ?? d));

    console.log('== 3. A second renewal, on a call from the frame\'s script ==');
    write('UPDATE devices SET cookie_at = ? WHERE id = ?', Date.now() - DAY - 60_000, paired!.id);
    const before2 = row()[0]!.cookie_hash;
    await device(frame()!);
    check(row()[0]!.cookie_hash !== before2, 'renewed on a fetch');
    write('UPDATE devices SET old_cookie_until = ? WHERE id = ?', Date.now() - 1, paired!.id);
    d = await device(frame()!);
    check(!!d.device && typeof d.unlockedUntil === 'number', 'the next call sends the cookie from that fetch\'s answer', JSON.stringify(d.device ?? d));

    console.log('== 4. Restart both Ledungs and quit and relaunch the browser ==');
    await ctx!.close();
    ctx = null;
    await pair.off('pc');
    await pair.off('mac');
    await pair.on('pc');
    await pair.on('mac');
    ({ page, frame } = await open());
    await page.waitForTimeout(1500);
    d = await device(frame()!);
    check(d.remote === true && !!d.device && typeof d.unlockedUntil === 'number', 'after both restarts and a browser relaunch the frame is still paired and logged on', JSON.stringify(d.device ?? d));
    check(row()[0]!.revoked_at === null, 'the device was never revoked');
    // Both runs of the PC write to the same file. The frame's load before pairing showed as not paired, and that line
    // holds its kind back for 10 minutes, so the absence is judged on the PC's run after the restart, which starts with
    // no line held (test review 288, finding 1).
    const pcLog = fs.readFileSync(path.join(work, 'ledung-pc.log'), 'utf8');
    const renewals = pcLog.split('Devices: renewed the cookie of "Browser on Mac" (paired in a frame).').length - 1;
    check(renewals === 2, 'the PC\'s log names both renewals', String(renewals));
    check(pcLog.includes('Devices: a frame on another computer\'s page opened this page with no device cookie, so it shows as not paired.'), 'the line is written: the frame\'s load before pairing showed as not paired');
    check(!/a frame on another computer's page opened this page with/.test(pair.ledungs.pc.output()), 'after the restarts, no frame load showed as not paired');
    // Issue #286's recurrence: the offer showed over a paired frame, and "Not paired with … in this tab?" read as a loss.
    await page.waitForTimeout(4000);
    check(!(await page.getByText(/Not paired with .* in this tab/).isVisible().catch(() => true)), 'no "Not paired" offer over the paired, logged-on frame');
    await page.screenshot({ path: path.join(work, 'shots', 'after-restart.png') });
  } finally {
    await (ctx as Context | null)?.close().catch(() => {});
    proxy.close();
    await pair.close();
  }
  console.log(failed() ? `${failed()} FAILED` : 'all passed');
  process.exitCode = failed() ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
