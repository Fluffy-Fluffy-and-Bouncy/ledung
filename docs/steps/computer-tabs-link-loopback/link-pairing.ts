// Loopback check for issue #273 (not part of npm test): two throwaway Ledungs from this checkout, "mac" on 4397 and
// "pc" on 4398, behind a real local relay (test/loopback/linked-pair.ts), neither with "computers" in its config, as
// on Martin's PC on 2026-10-20. Linked once, the Mac's own page shows the PC's tab and the PC's page in its frame (no
// longer white), and pairs that frame through the link: confirm on the Mac's page, the PC's pairing form in the frame,
// read-only until the passkey window and Log on. The PC shows the pairing. Driven in real Chrome; shots and results.txt
// go to <out>.
// Usage: PLAYWRIGHT_DIR=<node_modules with playwright> node docs/steps/computer-tabs-link-loopback/link-pairing.ts <out dir>
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createRequire } from 'node:module';
import { link, startPair } from '../../../test/loopback/linked-pair.ts';

const [out] = process.argv.slice(2) as [string];
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR!, 'x.js'));
const { chromium } = require('playwright') as typeof import('playwright');
type Page = import('playwright').Page;
type Frame = import('playwright').Frame;

const FRONT = 51843;
fs.mkdirSync(out, { recursive: true });
const results: string[] = [];
const check = (ok: boolean, what: string, detail: unknown = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${what}${detail === '' ? '' : ` — ${(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 220)}`}`;
  results.push(line);
  if (!ok) process.exitCode = 1;
  console.log(line);
};
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(out, name) });

/** One HTTPS request to a public name through the front, as a browser or another computer would send it. */
function viaFront(work: string, name: string, route: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const req = https.request({
      method: opts.method ?? 'GET', path: route, headers: { host: name, ...opts.headers },
      createConnection: () => tls.connect({ host: '127.0.0.1', port: FRONT, servername: name, ca: fs.readFileSync(path.join(work, 'trust.pem')), ALPNProtocols: ['http/1.1'] }),
    }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}
const ancestors = (res: { headers: Record<string, unknown> }) => String(res.headers['content-security-policy']).split('; ').find((d) => d.startsWith('frame-ancestors ')) ?? '';

const pcFrame = (page: Page): Frame | undefined => page.frames().find((f) => f.url().startsWith('https://pc.l.test'));
async function domClick(f: Frame, name: string) {
  await f.waitForFunction((n) => [...document.querySelectorAll('button')].some((b) => b.textContent === n), name, { timeout: 8000 }).catch(() => {});
  await f.evaluate((n) => ([...document.querySelectorAll('button')].find((b) => b.textContent === n) as HTMLButtonElement | undefined)?.click(), name);
}

async function main() {
  const work = path.join(os.tmpdir(), 'ledung-273-link');
  const pair = await startPair(work);
  const { pages } = pair;
  // Chrome trusts the two test certificates by their keys only, and reaches the public names through the front.
  const spki = ['mac', 'pc'].map((n) => crypto.createHash('sha256')
    .update(crypto.createPublicKey(fs.readFileSync(path.join(work, `data-${n}`, 'remote', 'tls.crt'))).export({ type: 'spki', format: 'der' })).digest('base64'));
  const browser = await chromium.launch({ channel: 'chrome', args: [`--host-resolver-rules=MAP *.l.test:443 127.0.0.1:${FRONT}`, `--ignore-certificate-errors-spki-list=${spki.join(',')}`] });
  try {
    // ---- Part 1: tabs and frame permission from the link ----
    check(ancestors(await viaFront(work, 'pc.l.test', '/')) === "frame-ancestors 'none'", 'before linking, nobody may frame the PC (the white tab)', ancestors(await viaFront(work, 'pc.l.test', '/')));
    await link(pages);
    const pcAncestors = ancestors(await viaFront(work, 'pc.l.test', '/'));
    check(pcAncestors === 'frame-ancestors https://mac.l.test http://127.0.0.1:4397 http://localhost:4397', 'linked: the Mac\'s pages may frame the PC, on the port the Mac told', pcAncestors);
    const tabs = (await pages.mac.api('GET', 'state')).json.computers as { id: string; name: string; linked?: boolean }[];
    check(tabs.map((t) => t.id).join() === 'mac.l.test,pc.l.test' && tabs[1]!.linked === true, 'the Mac has the PC\'s tab, marked linked, with no "computers" in its config', tabs);
    await pages.mac.api('POST', 'computers', { id: 'pc.l.test', name: 'Tubal Cain' });

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const authenticator = { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } as const;
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: authenticator });
    await page.goto(`http://127.0.0.1:4397/login?token=${pages.mac.token}`);
    await page.getByRole('navigation', { name: 'Computers' }).waitFor();
    await page.getByRole('link', { name: 'Tubal Cain' }).click();
    await page.locator('iframe.cframe').waitFor();
    await page.waitForTimeout(1500);
    let f = pcFrame(page);
    check(!!f && (await f.getByText('not paired').isVisible().catch(() => false)), 'the PC\'s tab shows the PC\'s own not-paired page, not white');
    const bar = page.locator('.cframe-bar');
    check(await bar.getByRole('button', { name: 'Pair through the link' }).isVisible(), 'the Mac\'s page offers Pair through the link above the frame');
    await shot(page, '273-mac-1280-pc-tab-not-paired.png');

    // ---- Part 2: pair through the link ----
    await bar.getByRole('button', { name: 'Pair through the link' }).click();
    check(await bar.getByRole('button', { name: 'Pair', exact: true }).isVisible(), 'a confirm on the Mac\'s own page before anything is asked of the PC');
    check((await pages.pc.api('GET', 'state')).json.linkPairings.length === 0, 'nothing reached the PC before the confirm');
    await shot(page, '273-mac-1280-confirm.png');
    await bar.getByRole('button', { name: 'Pair', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some((i) => i.src.includes('/p/')), undefined, { timeout: 10_000 });
    await page.waitForTimeout(1500);
    f = pcFrame(page)!;
    const nameField = f.getByLabel('Name of this device');
    check(await nameField.inputValue() === 'Browser on Mac', 'the frame shows the PC\'s pairing form, named for a browser on the Mac', await nameField.inputValue());
    check(!(await page.locator('.cframe-bar').count()), 'the bar is gone once the frame has its code');
    await shot(page, '273-mac-1280-pc-pairing-form.png');
    await f.getByRole('button', { name: 'Pair' }).click();
    await page.waitForTimeout(2500);
    f = pcFrame(page)!;
    check(f.url().includes('#/settings'), 'paired in the frame: the PC\'s own page, Settings', f.url());
    const device = await f.evaluate(async () => (await fetch('/api/device')).json());
    check(device.device?.kind === 'computer' && device.device?.pairedVia === 'Mac' && device.device?.passkey === false, 'a computer device, paired through the link from Mac, no passkey yet', device.device);
    const change = () => f!.evaluate(async () => (await fetch('/api/computers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'pc.l.test', name: 'PC' }) })).status);
    check(await change() === 403, 'read-only: a change from the frame is refused before the passkey');
    await shot(page, '273-mac-1280-pc-paired-read-only.png');

    // The PC's Waiting for you now has the pairing: the Mac's tab for it says so, told over the link.
    const tabBadge = page.getByRole('link', { name: /Tubal Cain/ }).locator('.badge');
    await tabBadge.waitFor({ timeout: 8000 }).catch(() => {});
    check(await tabBadge.innerText().catch(() => '') === '1', 'the PC\'s tab on the Mac shows its Waiting-for-you count, 1', await tabBadge.innerText().catch(() => 'none'));
    check(!(await page.locator('nav.ctabs > .ctab:first-child .badge').count()), 'this computer\'s own tab has no badge');
    await page.getByRole('navigation', { name: 'Computers' }).screenshot({ path: path.join(out, '273-mac-tabs-badge.png') });

    // The passkey window's messages (Martin on Windows with no Windows Hello saw only "error"): the PC's own enrol page,
    // as a Windows browser with no platform authenticator, then a try the browser refuses.
    // The frame's own Set up passkey gives the window's link; the code is used up only when a passkey is made.
    await f.getByRole('button', { name: 'Set up passkey' }).click();
    const enrolLink = (await f.getByRole('link', { name: 'Open the passkey window' }).getAttribute('href'))!;
    const winCtx = await browser.newContext({ viewport: { width: 800, height: 420 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' });
    // Stands in for a Windows computer without Windows Hello, and for the refusal Chrome gives there.
    await winCtx.addInitScript(() => {
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => false;
      navigator.credentials.create = async () => { throw new DOMException('The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.', 'NotAllowedError'); };
    });
    const win = await winCtx.newPage();
    await win.goto(enrolLink);
    await win.waitForFunction(() => document.getElementById('what')!.textContent!.startsWith('No passkey'), undefined, { timeout: 8000 }).catch(() => {});
    const before = await win.locator('#what').innerText();
    check(before.startsWith('No passkey on this computer: set up Windows Hello (a PIN is enough)') && await win.getByRole('button', { name: 'Set up passkey' }).isVisible(),
      'the passkey window says before trying that this computer has no passkey, what to set up, and still offers the button', before);
    await win.screenshot({ path: path.join(out, '273-enrol-windows-no-hello.png') });
    await win.getByRole('button', { name: 'Set up passkey' }).click();
    await win.waitForFunction(() => document.getElementById('what')!.textContent!.includes('NotAllowedError'), undefined, { timeout: 8000 }).catch(() => {});
    const afterTry = await win.locator('#what').innerText();
    check(afterTry.startsWith('The passkey was not made') && afterTry.includes('(NotAllowedError: The operation either timed out'), 'a refused try shows the reason and the browser\'s error, not "error"', afterTry);
    await win.screenshot({ path: path.join(out, '273-enrol-error-not-allowed.png') });
    await winCtx.close();

    // The PC shows it on its own screen.
    const pcCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pcPage = await pcCtx.newPage();
    await pcPage.goto(`http://127.0.0.1:4398/login?token=${pages.pc.token}`);
    await pcPage.goto('http://127.0.0.1:4398/#/waiting');
    const card = pcPage.locator('.new-computer', { hasText: 'through the link' });
    await card.waitFor({ timeout: 8000 });
    check((await card.innerText()).includes('Mac paired') && (await card.innerText()).includes('Browser on Mac'), 'the PC\'s Waiting for you shows "Mac paired Browser on Mac through the link"', await card.innerText());
    await shot(pcPage, '273-pc-1280-waiting-paired-through-link.png');
    await pcPage.goto('http://127.0.0.1:4398/#/settings');
    const row = pcPage.getByText('paired through the link from Mac');
    await row.waitFor({ timeout: 8000 });
    await row.scrollIntoViewIfNeeded();
    check(await row.isVisible(), 'the PC\'s Settings → Devices row says "paired through the link from Mac"');
    await shot(pcPage, '273-pc-1280-devices-row.png');
    // OK on the PC's card: nothing waits there any more, and the Mac's tab loses its badge.
    await pcPage.goto('http://127.0.0.1:4398/#/waiting');
    await pcPage.locator('.new-computer', { hasText: 'through the link' }).getByRole('button', { name: 'OK' }).click();
    await page.getByRole('link', { name: /Tubal Cain/ }).locator('.badge').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {});
    check(!(await page.getByRole('link', { name: /Tubal Cain/ }).locator('.badge').count()), 'OK on the PC: the Mac\'s tab for it shows no badge (0 is hidden)');

    // The passkey in its own window and Log on in the frame, as #244 (here: Chrome's virtual authenticator).
    await page.bringToFront();
    const [enrolWindow] = await Promise.all([ctx.waitForEvent('page'), f.getByRole('link', { name: 'Open the passkey window' }).click()]);
    await enrolWindow.waitForLoadState();
    const ecdp = await ctx.newCDPSession(enrolWindow);
    await ecdp.send('WebAuthn.enable');
    const { authenticatorId: enrolAuth } = await ecdp.send('WebAuthn.addVirtualAuthenticator', { options: authenticator });
    await enrolWindow.getByRole('button', { name: 'Set up passkey' }).click();
    await enrolWindow.locator('#done').waitFor({ state: 'visible' });
    for (const credential of (await ecdp.send('WebAuthn.getCredentials', { authenticatorId: enrolAuth })).credentials) {
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
    }
    await enrolWindow.close();
    await page.bringToFront();
    await f.getByRole('button', { name: 'Log on' }).waitFor({ timeout: 8000 });
    check(await change() === 403, 'passkey set up but not logged on: still read-only');
    await domClick(f, 'Log on');
    await page.waitForTimeout(800);
    await domClick(f, 'Continue');
    await page.waitForTimeout(2000);
    const logged = await f.evaluate(async () => (await fetch('/api/device')).json());
    check(typeof logged.unlockedUntil === 'number', 'logged on in the frame with the passkey', logged.unlockedUntil);
    check(await change() === 200, 'logged on: a change from the frame works');

    // ---- The locks, over the real relay ----
    const again = await pages.mac.api('POST', 'link-device-pair', { id: 'pc.l.test' });
    check(again.status === 502 && /429.*less than 10 minutes/.test(again.json.error), 'a second pairing within 10 minutes is refused by the PC', again.json);
    const viaPublic = await viaFront(work, 'mac.l.test', '/api/link-device-pair', { method: 'POST', body: JSON.stringify({ id: 'pc.l.test' }), headers: { origin: 'https://mac.l.test', 'content-type': 'application/json' } });
    check(viaPublic.status === 401, 'through the Mac\'s public name, with no device: refused', viaPublic.status);
    const noKey = await viaFront(work, 'pc.l.test', '/link/device-pair', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    check(noKey.status === 401, 'the PC\'s /link/device-pair without a link key: refused', noKey.status);
    check(!pair.seen.clear && pair.seen.bytes > 0, 'nothing of /link/ or a key crossed the front in clear', pair.seen);

    // ---- Unlinking takes the tab and the permission away at once ----
    const linkId = (await pages.mac.api('GET', 'links')).json.links[0].id;
    await pages.mac.api('POST', `links/${linkId}/remove`, {});
    await page.waitForTimeout(1500);
    check(!(await page.getByRole('link', { name: /Tubal Cain/ }).count()), 'unlinked: the Mac\'s page has no PC tab any more');
    check(await page.locator('.page > .app').isVisible() && !(await page.locator('iframe.cframe').isVisible().catch(() => false)), 'unlinked while the PC\'s tab showed: the Mac\'s own page is back, not blank');
    let after = '';
    for (let i = 0; i < 20 && after !== "frame-ancestors 'none'"; i++) {
      after = ancestors(await viaFront(work, 'pc.l.test', '/'));
      await new Promise((r) => setTimeout(r, 250));
    }
    check(after === "frame-ancestors 'none'", 'unlinked: nobody may frame the PC again', after);
    await shot(page, '273-mac-1280-unlinked.png');
  } finally {
    await browser.close();
    await pair.close();
    fs.writeFileSync(path.join(out, 'results.txt'), `${results.join('\n')}\n`);
    fs.rmSync(work, { recursive: true, force: true });
  }
}

await main();
