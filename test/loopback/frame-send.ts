// Loopback for issue #303: a framed computer page whose live connection died at the far end, while the browser never
// heard it close (the Mac slept), still sends a message to a manager. Not in CI (it starts two Ledungs, WebKit and one
// Haiku turn).
//
//   PLAYWRIGHT_DIR=<node_modules holding playwright> node test/loopback/frame-send.ts
//
// The Mac's local page (4397) shows the PC's page (4398, through its public name pc.l.test) in a frame, paired through
// the link, as frame-renewal.ts does. The browser reaches pc.l.test through a CONNECT proxy here, which can put the
// Mac to sleep: every connection is cut at the far end, and the browser's side stays open in silence until it writes,
// which is then reset, as a TCP connection does after a sleep. WebKit has no passkeys here, so logging on is written
// into the PC's database, as the passkey check would.
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { check, failed, link, repo, startPair, until } from './linked-pair.ts';

// playwright is not a dependency of Ledung: it is given from outside, untyped here (as link-pair.ts).
type Frame = any;
type Context = any;

const work = path.join(repo, '.test', 'frame-send');
const PROXY = 51891;
const REFUSED = "Only Ledung's open page can do this";

const pipes: { client: net.Socket; up: net.Socket }[] = [];

/** Hands CONNECT *.l.test:443 to the relay's front; anything else is refused. */
function connectProxy(front: number): net.Server {
  return net.createServer((client) => {
    client.once('data', (head: Buffer) => {
      const m = /^CONNECT ([a-z0-9.-]+\.l\.test):443 /i.exec(head.toString('latin1'));
      if (!m) return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      const up = net.connect(front, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        pipes.push({ client, up });
        client.pipe(up).pipe(client);
      });
      for (const s of [client, up]) s.on('error', () => { client.destroy(); up.destroy(); });
    });
  });
}

/** The Mac sleeps: each connection ends at the far end; the browser hears nothing until it writes, then a reset. */
function sleep(): number {
  const open = pipes.splice(0).filter(({ client, up }) => !client.destroyed && !up.destroyed);
  for (const { client, up } of open) {
    client.unpipe(up);
    up.unpipe(client);
    up.destroy();
    client.removeAllListeners('data');
    client.on('data', () => client.resetAndDestroy());
    client.resume();
  }
  return open.length;
}

async function main(): Promise<void> {
  const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR!, 'x.js'));
  const { webkit } = require('playwright') as { webkit: any };
  const beta = { name: 'Beta', runner: 'local', path: path.join(work, 'project-Beta'), model: 'haiku', managerModel: 'haiku', permissionMode: 'default' };
  const pair = await startPair(work, { pc: [beta] });
  const { mac, pc } = pair.pages;
  const proxy = connectProxy(pair.front);
  await new Promise<void>((r) => proxy.listen(PROXY, '127.0.0.1', r));
  let ctx: Context | null = null;
  try {
    await link(pair.pages);

    console.log('== 1. Pair the frame through the link, in WebKit, and log on ==');
    ctx = await webkit.launchPersistentContext(path.join(work, 'webkit-profile'), { viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, proxy: { server: `http://127.0.0.1:${PROXY}`, bypass: '127.0.0.1' } });
    const page = ctx.pages()[0] ?? await ctx.newPage();
    // The frame's live connections, and its sends to Beta's manager with their answers, in order.
    const sockets: { closed: boolean }[] = [];
    page.on('websocket', (ws: any) => {
      if (!ws.url().startsWith('wss://pc.l.test')) return;
      const s = { closed: false };
      sockets.push(s);
      ws.on('close', () => { s.closed = true; });
    });
    const sends: { status: number; error: string | undefined }[] = [];
    page.on('response', async (r: any) => {
      if (r.request().method() !== 'POST' || !r.url().startsWith('https://pc.l.test/api/projects/Beta/manager')) return;
      sends.push({ status: r.status(), error: (await r.json().catch(() => ({}))).error });
    });
    await page.goto(`${mac.origin}/login?token=${mac.token}`);
    await page.getByRole('navigation', { name: 'Computers' }).waitFor();
    await page.locator('nav.ctabs a.ctab').first().click();
    const frame = () => page.frames().find((f: Frame) => f.url().startsWith('https://pc.l.test'));
    await until(() => frame(), 'the PC\'s frame', 15_000);
    await until(async () => (await page.getByRole('button', { name: 'Pair through the link' }).isVisible().catch(() => false)) || null, 'the offer over the not-paired frame', 15_000);
    await page.getByRole('button', { name: 'Pair through the link' }).click();
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await until(() => frame()?.url().includes('/p/'), 'the frame on the pairing form', 15_000);
    await until(async () => (await frame()!.getByRole('button', { name: 'Pair' }).isVisible().catch(() => false)) || null, 'the form', 15_000);
    await frame()!.getByRole('button', { name: 'Pair' }).click();
    await until(() => frame()?.url().includes('#/settings'), 'the frame on Settings', 15_000);
    const db = new DatabaseSync(path.join(pc.data, 'ledung.db'));
    db.prepare("UPDATE devices SET logged_on_at = ?, credential_id = 'loopback' WHERE kind = 'computer'").run(Date.now());
    db.close();
    await until(() => sockets.at(-1)?.closed === false || null, 'the frame\'s live connection', 15_000);
    check(true, 'the framed page is paired, logged on and has its live connection');

    console.log('== 2. The Mac sleeps: the frame\'s connection dies at the PC, and the browser hears no close ==');
    // Idle page loads' connections are closed by the PC after a few seconds (its keep-alive), before a real sleep would
    // come: only the live connection is still open then.
    await page.waitForTimeout(8000);
    const before = sockets.length;
    console.log(`connections open at the sleep: ${sleep()}`);
    await page.waitForTimeout(3000);
    check(sockets.length === before && sockets.at(-1)?.closed === false, 'the browser still thinks the frame\'s connection open');

    console.log('== 3. Message the manager of Beta from the frame ==');
    await frame()!.getByText('Beta', { exact: true }).first().click();
    await frame()!.getByPlaceholder('Message the manager of Beta').fill('Test manager in a Ledung loopback. Reply with the single word "ready" and stop. Use no tools.');
    await frame()!.getByRole('button', { name: 'Start manager' }).click();
    await until(() => sends.length > 0 || null, 'the send\'s answer', 30_000);
    // Time for the one go again: the page waits up to 5 s for a new connection's key.
    await page.waitForTimeout(7000);
    console.log('sends:', JSON.stringify(sends));
    check(sends.at(-1)?.status === 200, 'the message reached the manager', JSON.stringify(sends));
    check(sends.length <= 2 && sends.slice(0, -1).every((s) => s.status === 403 && !!s.error?.startsWith(REFUSED)), 'at most one refusal first, for the dead key', JSON.stringify(sends));
    check(sockets.length === before + 1, 'one new live connection replaced the dead one', String(sockets.length - before));
    check(!(await frame()!.getByText(REFUSED).isVisible().catch(() => false)), 'the frame shows no refusal');
    await page.screenshot({ path: path.join(work, 'shots', 'after-send.png') });

    const sessions = (await pc.api('GET', 'state')).json.sessions as { id: string }[];
    for (const s of sessions) await pc.api('POST', `sessions/${s.id}/stop`, {});
  } finally {
    await (ctx as Context | null)?.close().catch(() => {});
    proxy.close();
    await pair.close();
    // A manager's session host outlives its Ledung: stopped by its command line, which holds this test's data folder.
    if (process.platform !== 'win32') try { execFileSync('pkill', ['-f', path.join(work, 'data-pc')]); } catch { /* none left */ }
  }
  console.log(failed() ? `${failed()} FAILED` : 'all passed');
  process.exitCode = failed() ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
