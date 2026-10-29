// Loopback for issue #245 step 1 (docs/steps/manager-link.md): two throwaway Ledungs link with a code through a real
// relay, end to end, and unlink. Not in CI (it starts two Ledungs and, for screenshots, a browser).
//
//   node test/loopback/link-pair.ts                    # ports 4397 and 4398
//   PLAYWRIGHT=/path/to/playwright-core CHROMIUM=/path/to/chrome node test/loopback/link-pair.ts   # with screenshots
//
// The two Ledungs, the relay and the front: linked-pair.ts.
import fs from 'node:fs';
import path from 'node:path';
import { check, failed, type Page, repo, startPair, until } from './linked-pair.ts';

const work = path.join(repo, '.test', 'link-loopback');

/** Settings → Linked computers as Martin sees it, if a browser was given. */
async function shot(page: Page, file: string, click?: string): Promise<void> {
  if (!process.env.PLAYWRIGHT || !process.env.CHROMIUM) return;
  // playwright-core is not a dependency of Ledung: it is given from outside, as a CommonJS module.
  const mod = await import(process.env.PLAYWRIGHT) as { chromium?: any; default?: { chromium: any } };
  const chromium = mod.chromium ?? mod.default!.chromium;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
  try {
    const tab = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await tab.goto(`${page.origin}/login?token=${page.token}`);
    await tab.goto(`${page.origin}/#/settings`);
    const section = tab.locator('section', { has: tab.locator('h3', { hasText: 'Linked computers' }) });
    await section.waitFor();
    if (click) {
      await section.getByRole('button', { name: click }).click();
      await section.locator('code').waitFor();
    }
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: path.join(work, 'shots', file) });
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const pair = await startPair(work);
  const { mac, pc } = pair.pages;
  try {
    console.log('== 1. Link: a code on the Mac, pasted on the PC ==');
    await shot(mac, '1-none.png');
    // The page's own button first; the code made after it replaces that one.
    await shot(mac, '2-code.png', 'Link a computer');
    const code = await mac.api('POST', 'links-code', {});
    check(code.status === 200 && /^mac\.l\.test\/[a-z0-9]{24}$/.test(code.json.code), 'the Mac makes a code', code.json.code);
    const joined = await pc.api('POST', 'links-join', { code: code.json.code, name: 'Mac' });
    check(joined.status === 200 && joined.json.publicName === 'mac.l.test', 'the PC links with it, through the relay', JSON.stringify(joined.json));
    const onMac = (await mac.api('GET', 'links')).json.links;
    const onPc = (await pc.api('GET', 'links')).json.links;
    check(onMac.length === 1 && onMac[0].publicName === 'pc.l.test', 'the Mac lists the PC', onMac.map((l: any) => l.name).join());
    check(onPc.length === 1 && onPc[0].name === 'Mac', 'the PC lists the Mac by the name given');
    await shot(mac, '3-linked-mac.png');
    await shot(pc, '4-linked-pc.png');
    // Each absence with its positive branch (test review 250, finding 3): the linking went through the front, and
    // the relay's log is the one being written.
    check(pair.seen.bytes > 0 && !pair.seen.clear, 'the server\'s side carried the linking, and saw no route, code or key in clear', `${pair.seen.bytes} bytes`);
    const log = fs.readFileSync(path.join(work, 'relay.log'), 'utf8');
    check(/agent connected name="mac"/.test(log) && !log.includes(code.json.code.split('/')[1]), 'the relay\'s log is written (both Ledungs connecting) and holds no code');

    console.log('== 2. Unlink on the PC with both up: the Mac drops it too; the first code stays used ==');
    const first = (await pc.api('GET', 'links')).json.links[0];
    check((await pc.api('POST', `links/${first.id}/remove`, {})).status === 200, 'unlinked on the PC');
    await until(async () => (await mac.api('GET', 'links')).json.links.length === 0, 'the Mac to drop it', 10_000);
    check(true, 'dropped on the Mac once told');
    const again = await pc.api('POST', 'links-join', { code: code.json.code, name: 'Mac' });
    check(again.status === 502 && /No link code is open/.test(again.json.error), 'the first code works only once', again.json?.error);

    console.log('== 3. Unlinking on the Mac while the PC is off ==');
    const code2 = await mac.api('POST', 'links-code', {});
    check((await pc.api('POST', 'links-join', { code: code2.json.code, name: 'Mac' })).status === 200, 'linked again');
    await pair.pcOff();
    const link = (await mac.api('GET', 'links')).json.links[0];
    check((await mac.api('POST', `links/${link.id}/remove`, {})).status === 200 && (await mac.api('GET', 'links')).json.links.length === 0, 'gone on the Mac at once');
    await pair.pcOn();
    const stillOnPc = (await pc.api('GET', 'links')).json.links.length;
    check(stillOnPc === 1, 'the PC, off when it happened, still lists the Mac (unlinking tells the other side once, best effort)');
    const link2 = (await pc.api('GET', 'links')).json.links[0];
    check((await pc.api('POST', `links/${link2.id}/remove`, {})).status === 200, 'unlinking it on the PC too works, the Mac\'s side already gone');

    console.log('== 4. Linking with a computer that is off says so ==');
    const code3 = await pc.api('POST', 'links-code', {});
    await pair.pcOff();
    const offline = await mac.api('POST', 'links-join', { code: code3.json.code, name: 'PC' });
    check(offline.status === 502 && /offline/.test(offline.json.error), 'a plain "offline" error', offline.json?.error);
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
