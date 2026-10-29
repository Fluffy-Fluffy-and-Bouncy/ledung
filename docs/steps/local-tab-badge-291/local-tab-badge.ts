// Loopback check for issue #291 (not part of npm test): two throwaway Ledungs linked through a real local relay
// (test/loopback/linked-pair.ts), "mac" on 4397 and "pc" on 4398. On the Mac's page the PC's tab shows the PC's page
// in its frame; a Haiku manager on the Mac then asks a question, and the Mac's own tab gets the count without a
// switch, and loses it when the question is answered. Driven in real Chrome, dark mode; shots and results.txt go to
// <out>.
// Usage: PLAYWRIGHT_DIR=<node_modules with playwright> node docs/steps/local-tab-badge-291/local-tab-badge.ts <out dir>
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { link, startPair, until } from '../../../test/loopback/linked-pair.ts';

const [out] = process.argv.slice(2) as [string];
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR!, 'x.js'));
const { chromium } = require('playwright') as typeof import('playwright');
type Page = import('playwright').Page;

fs.mkdirSync(out, { recursive: true });
const results: string[] = [];
const check = (ok: boolean, what: string, detail: unknown = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${what}${detail === '' ? '' : ` — ${(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 220)}`}`;
  results.push(line);
  if (!ok) process.exitCode = 1;
  console.log(line);
};
const badgeOf = async (page: Page, sel: string) => {
  const b = page.locator(`${sel} .badge`);
  return (await b.count()) ? await b.innerText() : '';
};
const HERE = 'nav.ctabs > .ctab:first-child';

async function main() {
  const work = path.join(os.tmpdir(), 'ledung-291-badge');
  const project = { name: 'Alpha', runner: 'local', path: path.join(work, 'project-Alpha'), model: 'haiku', managerModel: 'haiku', permissionMode: 'default' };
  const pair = await startPair(work, { mac: [project] });
  const { pages } = pair;
  // Chrome trusts the two test certificates by their keys only, and reaches the public names through the front.
  const spki = ['mac', 'pc'].map((n) => crypto.createHash('sha256')
    .update(crypto.createPublicKey(fs.readFileSync(path.join(work, `data-${n}`, 'remote', 'tls.crt'))).export({ type: 'spki', format: 'der' })).digest('base64'));
  const browser = await chromium.launch({ channel: 'chrome', args: [`--host-resolver-rules=MAP *.l.test:443 127.0.0.1:${pair.front}`, `--ignore-certificate-errors-spki-list=${spki.join(',')}`] });
  try {
    await link(pages);
    await pages.mac.api('POST', 'computers', { id: 'mac.l.test', name: 'MacBenack' });
    await pages.mac.api('POST', 'computers', { id: 'pc.l.test', name: 'Tubal Cain' });

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:4397/login?token=${pages.mac.token}`);
    await page.getByRole('navigation', { name: 'Computers' }).waitFor();
    await page.getByRole('link', { name: /Tubal Cain/ }).click();
    await page.locator('iframe.cframe').waitFor();
    await page.waitForTimeout(1500);
    const pcFrame = page.frames().find((f) => f.url().startsWith('https://pc.l.test'));
    check(!!pcFrame && (await pcFrame.getByText('not paired').isVisible().catch(() => false)), 'the PC\'s tab shows the PC\'s own page in the frame');
    // Paired through the link (#273), so the frame shows the PC's whole page, read-only.
    const bar = page.locator('.cframe-bar');
    await bar.getByRole('button', { name: 'Pair through the link' }).click();
    await bar.getByRole('button', { name: 'Pair', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some((i) => i.src.includes('/p/')), undefined, { timeout: 10_000 });
    await page.waitForTimeout(1500);
    await page.frames().find((f) => f.url().startsWith('https://pc.l.test'))!.getByRole('button', { name: 'Pair' }).click();
    await page.waitForTimeout(2500);
    const paired = page.frames().find((f) => f.url().startsWith('https://pc.l.test'));
    check(!!paired && await paired.locator('.waiting-entry').isVisible().catch(() => false), 'the frame shows the PC\'s own Ledung page, paired through the link');
    check(await badgeOf(page, HERE) === '', 'the PC\'s page shows, nothing waits on the Mac: the Mac\'s tab has no badge');

    // A real question on the Mac: its Haiku manager asks Martin.
    const alpha = (await pages.mac.api('POST', 'projects/Alpha/manager', {
      text: 'Test manager in a Ledung loopback. Call ask_user exactly once with question "Loopback #291: is the badge on the Mac tab?", tier "Record only", and options ["yes","no"]. Then stop. Use no other tools.',
    })).json;
    const qid = await until(async () => {
      const qs = (await pages.mac.api('GET', 'state')).json.questions as Record<string, { id: number; sessionId: string; answer?: string | null }> | { id: number; sessionId: string }[];
      const list = Array.isArray(qs) ? qs : Object.values(qs);
      return list.find((q) => q.sessionId === alpha.id)?.id;
    }, 'the manager\'s question', 180_000);
    check(true, 'the Mac\'s manager asked a question', qid);
    await page.locator(`${HERE} .badge`).waitFor({ timeout: 10_000 }).catch(() => {});
    check(await badgeOf(page, HERE) === '1', 'without switching tabs, the Mac\'s own tab shows 1 waiting for you', await badgeOf(page, HERE));
    check(await page.locator('iframe.cframe').isVisible(), 'the PC\'s page still shows in the frame');
    const title = await page.locator(`${HERE} .badge`).getAttribute('title');
    check(title === '1 waiting for you on MacBenack' || /^1 waiting for you on /.test(title ?? ''), 'the badge says where it waits', title);
    await page.screenshot({ path: path.join(out, '291-mac-1280-pc-shown-local-badge.png') });
    await page.getByRole('navigation', { name: 'Computers' }).screenshot({ path: path.join(out, '291-mac-tabs-local-badge.png') });

    // Back on the Mac's own page: the sidebar counts it, the tab does not.
    await page.locator(HERE).click();
    await page.waitForTimeout(500);
    check(await badgeOf(page, HERE) === '', 'on the Mac\'s own page its tab shows no count; the sidebar\'s Waiting for you does', await page.locator('.waiting-entry').innerText());
    await page.screenshot({ path: path.join(out, '291-mac-1280-own-page.png') });

    // Answered while the PC's page shows: the count goes, live.
    await page.getByRole('link', { name: /Tubal Cain/ }).click();
    await page.waitForTimeout(500);
    check(await badgeOf(page, HERE) === '1', 'the PC\'s page again: the count is back on the Mac\'s tab');
    await pages.mac.api('POST', `questions/${qid}/answer`, { answer: 'yes' });
    await page.locator(`${HERE} .badge`).waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
    check(await badgeOf(page, HERE) === '', 'answered: the Mac\'s tab loses its badge without a switch');
    await page.getByRole('navigation', { name: 'Computers' }).screenshot({ path: path.join(out, '291-mac-tabs-answered.png') });
  } finally {
    await browser.close();
    await pair.close();
    fs.writeFileSync(path.join(out, 'results.txt'), `${results.join('\n')}\n`);
  }
}

await main();
