// Loopback check for issue #241 (not part of npm test): two throwaway Ledungs from this checkout, alpha on 4397 and
// beta on 4398, behind a stand-in for the relay (docs/steps/computer-tabs-in-page-spike/front.ts on the design branch,
// TLS on 4396 for *.l.spike.test), driven in real Chrome. Clicking beta's tab on alpha's local page shows beta's own
// page in a frame; pairing, passkey and unlock happen in the frame, through beta's own page; switching is instant.
// Then the same on a phone-sized page through alpha's public name. Screenshots and results go to <out>.
// Usage: PLAYWRIGHT_DIR=<node_modules with playwright> node docs/steps/computer-tabs-in-page-loopback/computer-frames.ts <front.ts> <out dir>
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const [frontScript, out] = process.argv.slice(2) as [string, string];
const REPO = path.resolve(import.meta.dirname, '../../..');
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR!, 'x.js'));
const { chromium, webkit } = require('playwright') as typeof import('playwright');
type Page = import('playwright').Page;
type Frame = import('playwright').Frame;

const T = path.join(os.tmpdir(), 'ledung-241-frames');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const results: string[] = [];
const check = (ok: boolean, what: string, detail: unknown = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${what}${detail === '' ? '' : ` — ${(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 200)}`}`;
  results.push(line);
  // A FAIL line fails the run: its exit code is what a report quotes, never a count from an old results.txt.
  if (!ok) process.exitCode = 1;
  console.log(line);
};

// Certificate for the stand-in relay, trusted by Chrome through its SPKI hash only.
fs.mkdirSync(T, { recursive: true });
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=l.spike.test',
  '-addext', 'subjectAltName=DNS:alpha.l.spike.test,DNS:beta.l.spike.test', '-keyout', path.join(T, 'key.pem'), '-out', path.join(T, 'cert.pem')], { stdio: 'ignore' });
const der = execFileSync('openssl', ['x509', '-in', path.join(T, 'cert.pem'), '-pubkey', '-noout']);
const spki = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: der }) }).toString('base64');

const computers = [
  { name: 'Alpha', colour: 'green', publicName: 'alpha.l.spike.test', port: 4397 },
  { name: 'Beta', colour: 'purple', publicName: 'beta.l.spike.test', port: 4398 },
];
const kids: ChildProcess[] = [];
async function ledung(name: 'alpha' | 'beta', port: number) {
  const dir = path.join(T, name);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    port, userName: 'loopback', remoteControl: false, projects: [], computers,
    remote: { relay: 'ws://127.0.0.1:9', name, publicName: `${name}.l.spike.test`, secret: 'loopback' },
  }));
  const log = fs.openSync(path.join(dir, 'ledung.log'), 'a');
  kids.push(spawn(process.execPath, [path.join(REPO, 'src/main.ts'), '--no-open'], {
    env: { ...process.env, LEDUNG_CONFIG: path.join(dir, 'config.json'), LEDUNG_DATA_DIR: path.join(dir, 'data') }, stdio: ['ignore', log, log],
  }));
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error(`${name} did not start`);
}
const token = (name: string) => fs.readFileSync(path.join(T, name, 'data', 'auth-token'), 'utf8').trim();

/** A pairing code from beta's (or alpha's) own computer, as its Settings → Devices makes one, for a phone or a computer. */
async function pairCode(page: Page, name: string, port: number, kind: 'phone' | 'computer' = 'phone'): Promise<string> {
  const p = await page.context().browser()!.newContext().then((c) => c.newPage());
  await p.goto(`http://127.0.0.1:${port}/login?token=${token(name)}`);
  const url = await p.evaluate(async ([port, kind]) => {
    const key = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.onmessage = (e) => resolve(JSON.parse(e.data).pageKey);
    });
    const res = await fetch('/api/devices-pair', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ledung-page': key }, body: JSON.stringify({ kind }) });
    return (await res.json()).url as string;
  }, [port, kind] as const);
  await p.context().close();
  return new URL(url).pathname.split('/').pop()!.toUpperCase();
}
const betaFrame = (page: Page): Frame | undefined => page.frames().find((f) => f.url().startsWith('https://beta.l.spike.test'));
/** In the frame: Continue on the passkey dialog, if it is there. */
/**
 * A button pressed through the page itself. After the passkey window has closed, Playwright's mouse clicks in Chrome no
 * longer reached the frame (seen 2026-10-20: no request at all, while the same click through the page went through);
 * a person's click is not affected, so from there the script presses buttons this way.
 */
async function domClick(f: Frame, name: string) {
  await f.waitForFunction((n) => [...document.querySelectorAll('button')].some((b) => b.textContent === n), name, { timeout: 8000 }).catch(() => {});
  await f.evaluate((n) => ([...document.querySelectorAll('button')].find((b) => b.textContent === n) as HTMLButtonElement | undefined)?.click(), name);
}
async function continueDialog(f: Frame) {
  const button = f.getByRole('button', { name: 'Continue' });
  if (await button.isVisible({ timeout: 2000 }).catch(() => false)) await button.click();
}

async function main() {
  const front = spawn(process.execPath, [frontScript, T], { stdio: 'ignore' });
  await ledung('alpha', 4397);
  await ledung('beta', 4398);
  const browser = await chromium.launch({ channel: 'chrome', args: ['--host-resolver-rules=MAP *.l.spike.test:443 127.0.0.1:4396', `--ignore-certificate-errors-spki-list=${spki}`] });
  try {
    // ---- The computer's own screen: alpha's local page ----
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const authenticator = { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } as const;
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: authenticator });
    await page.goto(`http://127.0.0.1:4397/login?token=${token('alpha')}`);
    await page.getByRole('navigation', { name: 'Computers' }).waitFor();
    await page.screenshot({ path: path.join(out, '241c-local-1280-alpha.png') });
    await page.getByRole('link', { name: 'Beta' }).click();
    await page.locator('iframe.cframe').waitFor();
    check(page.url().startsWith('http://127.0.0.1:4397'), 'clicking Beta keeps alpha\'s page (no navigation)', page.url());
    await page.waitForTimeout(1500);
    let f = betaFrame(page);
    check(!!f && (await f.getByText('not paired').isVisible().catch(() => false)), 'the frame shows beta\'s own not-paired page');
    await page.screenshot({ path: path.join(out, '241c-local-1280-beta-not-paired.png') });

    // On beta's own screen: Settings → Devices → Pair a computer, and its code (issue #241, decision 6 on #245).
    const betaHere = await browser.newContext({ viewport: { width: 1280, height: 800 } }).then((c) => c.newPage());
    await betaHere.goto(`http://127.0.0.1:4398/login?token=${token('beta')}`);
    await betaHere.goto('http://127.0.0.1:4398/#/settings');
    await betaHere.getByRole('button', { name: 'Pair a computer' }).click();
    const typedCode = (await betaHere.locator('.pair-code b').innerText()).trim();
    check(/^[0-9A-Z]{20}$/.test(typedCode), 'beta\'s Settings shows a computer pairing code to type in', typedCode);
    await betaHere.locator('.pair-code').scrollIntoViewIfNeeded();
    await betaHere.screenshot({ path: path.join(out, '241c-beta-settings-pair-a-computer-1280.png') });
    await betaHere.context().close();
    await f!.getByLabel('Pairing code or link').fill(typedCode);
    await f!.getByRole('button', { name: 'Next' }).click();
    await f!.getByLabel('Name of this device').fill('Mac Chrome');
    await f!.getByRole('button', { name: 'Pair' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('iframe')].length === 1);
    await page.waitForTimeout(2500);
    f = betaFrame(page)!;
    check(f.url().includes('#/settings'), 'paired in the frame: beta\'s own page, Settings', f.url());
    check(!(await f.locator('nav.ctabs').count()), 'beta in the frame draws no tabs (alpha draws them)');
    check(!(await f.locator('.page.remote').count()), 'beta in the frame draws no remote frame');
    // The passkey is made in a window of its own, on beta's own page at the top level (Safari can't make one in a frame
    // on another site). Chrome gives each window its own virtual authenticator; the system keychain is one, so the
    // passkey made in that window is copied to the main window's authenticator, as the keychain would have it.
    await f.getByRole('button', { name: 'Set up passkey' }).click();
    const [enrolWindow] = await Promise.all([ctx.waitForEvent('page'), f.getByRole('link', { name: 'Open the passkey window' }).click()]);
    await enrolWindow.waitForLoadState();
    check(enrolWindow.url() === 'https://beta.l.spike.test/enrol.html', 'the passkey window is beta\'s own enrol page at the top level, the code gone from the address', enrolWindow.url());
    const ecdp = await ctx.newCDPSession(enrolWindow);
    await ecdp.send('WebAuthn.enable');
    const { authenticatorId: enrolAuth } = await ecdp.send('WebAuthn.addVirtualAuthenticator', { options: authenticator });
    await enrolWindow.getByRole('button', { name: 'Set up passkey' }).click();
    await enrolWindow.locator('#done').waitFor({ state: 'visible' });
    await enrolWindow.screenshot({ path: path.join(out, '241c-enrol-window-1280.png') });
    for (const credential of (await ecdp.send('WebAuthn.getCredentials', { authenticatorId: enrolAuth })).credentials) {
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
    }
    await enrolWindow.close();
    // Back in Ledung's window, as a person clicking back into it: Chrome refuses a passkey check from a window without focus.
    await page.bringToFront();
    await f.getByRole('button', { name: 'Log on' }).waitFor({ timeout: 8000 });
    const device1 = await f.evaluate(async () => (await fetch('/api/device')).json());
    check(device1.device?.passkey === true, 'beta\'s passkey set up in its own window; the frame saw it by itself', device1.device);
    const logOn = async () => {
      await domClick(f!, 'Log on');
      // The dialog that explains the unlock comes up after a moment.
      await page.waitForTimeout(800);
      await domClick(f!, 'Continue');
      await page.waitForTimeout(2000);
      return f!.evaluate(async () => (await fetch('/api/device')).json());
    };
    const device2 = await logOn();
    check(device2.device?.kind === 'computer' && device2.unlockedUntil > Date.now() + 13 * 24 * 3600_000,
      'paired as a computer, logged on in the frame with its passkey: until 14 days unused, not 30 minutes', { kind: device2.device?.kind, until: new Date(device2.unlockedUntil).toISOString() });
    await page.screenshot({ path: path.join(out, '241c-local-1280-beta-logged-on.png') });
    await domClick(f, 'Log out');
    await page.waitForTimeout(1000);
    const loggedOut = await f.evaluate(async () => (await fetch('/api/device')).json());
    check(loggedOut.unlockedUntil === null && await f.getByRole('button', { name: 'Log on' }).isVisible(), 'Log out logs it off at once', loggedOut.unlockedUntil);
    await page.screenshot({ path: path.join(out, '241c-local-1280-beta-logged-out.png') });
    check(typeof (await logOn()).unlockedUntil === 'number', 'and Log on logs it on again with the passkey');
    const chat = await f.evaluate(async () => {
      const res = await fetch('/api/chats-new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'haiku' }) });
      return { status: res.status, id: (await res.json()).id };
    });
    const renamed = await f.evaluate(async (id) => (await fetch(`/api/sessions/${id}/rename`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Started from the Mac' }) })).status, chat.id);
    check(chat.status === 200 && renamed === 200, 'an ordinary change on beta from the frame goes through', { chat: chat.status, renamed });
    await f.goto('https://beta.l.spike.test/');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(out, '241c-local-1280-beta.png') });

    // Switching is instant: the frame stays loaded, its live connection with it.
    await f.evaluate(() => { (window as unknown as { kept: number }).kept = 41; });
    await page.getByRole('button', { name: 'Alpha' }).click();
    check(await page.locator('.page > .app').isVisible() && !(await page.locator('iframe.cframe').isVisible()), 'clicking Alpha shows alpha\'s own page again');
    await page.screenshot({ path: path.join(out, '241c-local-1280-back-to-alpha.png') });
    await page.getByRole('link', { name: 'Beta' }).click();
    const kept = await betaFrame(page)!.evaluate(() => (window as unknown as { kept?: number }).kept);
    check(kept === 41, 'clicking Beta again shows the same frame, not reloaded', kept);
    // Alpha's own script still gets nothing from beta: no CORS for it.
    const direct = await page.evaluate(async () => {
      try { return (await fetch('https://beta.l.spike.test/api/state', { credentials: 'include' })).status; } catch (e) { return String(e); }
    });
    check(direct !== 200, 'alpha\'s page itself cannot read beta\'s API', direct);
    await ctx.close();

    // ---- A phone through alpha's public name ----
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const pp = await phone.newPage();
    await pp.goto(`https://alpha.l.spike.test/p/${await pairCode(pp, 'alpha', 4397)}`);
    await pp.getByRole('button', { name: 'Pair' }).click();
    await pp.waitForURL(/#\/settings/);
    await pp.goto('https://alpha.l.spike.test/');
    await pp.getByRole('navigation', { name: 'Computers' }).waitFor();
    await pp.getByRole('link', { name: 'Beta' }).click();
    await pp.locator('iframe.cframe').waitFor();
    await pp.waitForTimeout(1500);
    const pf = betaFrame(pp)!;
    await pf.getByLabel('Pairing code or link').fill(await pairCode(pp, 'beta', 4398));
    await pf.getByRole('button', { name: 'Next' }).click();
    await pf.getByRole('button', { name: 'Pair' }).click();
    await pp.waitForTimeout(2500);
    await betaFrame(pp)!.goto('https://beta.l.spike.test/');
    await pp.waitForTimeout(2000);
    const phoneState = await betaFrame(pp)!.evaluate(async () => (await fetch('/api/state')).status);
    check(phoneState === 200, 'on the phone through alpha\'s public name, beta pairs and works in the frame', phoneState);
    await pp.screenshot({ path: path.join(out, '241c-phone-390-beta.png') });
    await pp.getByRole('button', { name: 'Alpha' }).click();
    await pp.screenshot({ path: path.join(out, '241c-phone-390-alpha.png') });
    await phone.close();
    await browser.close();

    // ---- WebKit (Playwright's build, the engine of Safari; not Safari itself, and with no passkeys) ----
    const wk = await webkit.launch({ proxy: { server: 'http://127.0.0.1:4399', bypass: '127.0.0.1' } });
    try {
      const wctx = await wk.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
      const wp = await wctx.newPage();
      await wp.goto(`http://127.0.0.1:4397/login?token=${token('alpha')}`);
      await wp.getByRole('navigation', { name: 'Computers' }).waitFor();
      await wp.getByRole('link', { name: 'Beta' }).click();
      await wp.locator('iframe.cframe').waitFor();
      await wp.waitForTimeout(1500);
      let wf = betaFrame(wp)!;
      await wf.getByLabel('Pairing code or link').fill(await pairCode(wp, 'beta', 4398, 'computer'));
      await wf.getByRole('button', { name: 'Next' }).click();
      await wf.getByRole('button', { name: 'Pair' }).click();
      await wp.waitForTimeout(2500);
      wf = betaFrame(wp)!;
      const wdev = await wf.evaluate(async () => (await fetch('/api/device')).json());
      check(wdev.remote === true && wdev.device?.kind === 'computer', 'WebKit: paired as a computer inside the frame on alpha\'s local page; the Partitioned cookie is kept and sent', wdev.device);
      await wf.getByRole('button', { name: 'Set up passkey' }).click();
      const [wEnrol] = await Promise.all([wctx.waitForEvent('page'), wf.getByRole('link', { name: 'Open the passkey window' }).click()]);
      await wEnrol.waitForLoadState();
      check(await wEnrol.getByRole('button', { name: 'Set up passkey' }).isVisible(), 'WebKit: the passkey window opens on beta\'s own enrol page, ready for Touch ID', wEnrol.url());
      await wEnrol.screenshot({ path: path.join(out, '241c-webkit-enrol-window-1280.png') });
      await wEnrol.close();
      await wp.screenshot({ path: path.join(out, '241c-webkit-local-1280-beta-passkey-link.png') });
    } finally {
      await wk.close();
    }
  } finally {
    await browser.close().catch(() => {});
    for (const k of kids) k.kill('SIGTERM');
    front.kill();
    await new Promise((r) => setTimeout(r, 2000));
    fs.writeFileSync(path.join(out, 'results.txt'), results.join('\n') + '\n');
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });

