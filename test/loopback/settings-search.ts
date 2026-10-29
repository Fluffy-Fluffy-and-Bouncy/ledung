// Loopback for issue #367 (searching Settings, mockup F): the search box in a real browser, on a throwaway Ledung on
// 4396 with two projects. Not in CI (it starts a Ledung and a browser). playwright-core is given from outside, as for
// settings-frame.ts.
//
//   PLAYWRIGHT=/path/to/playwright-core [CHROMIUM=/path/to/chrome] [SHOTS=<folder>] node test/loopback/settings-search.ts
//
// The box is above the side menu on the Ledung, Chats and each project tab; "/" focuses it; the issue's words list
// their settings with tab and group; choosing a project's hit opens that tab and group and highlights the setting;
// no match says so; Escape clears the search first and leaves Settings after; on a phone it sits above the list of
// groups; the × clears it on every tab and the phone (#383). SHOTS saves the dark screenshots for the PR. Exit code 1 on any FAIL.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { check, failed, Page, repo, until } from './linked-pair.ts';
import { removeTemp } from '../temp.ts';

const work = path.join(repo, '.test', 'settings-search-loopback');
const PORT = 4396;
type Tab = any;

async function browser() {
  if (!process.env.PLAYWRIGHT) throw new Error('Set PLAYWRIGHT to a playwright-core folder (and CHROMIUM to a browser, unless its own is installed).');
  const mod = await import(process.env.PLAYWRIGHT) as { chromium?: any; default?: { chromium: any } };
  const chromium = mod.chromium ?? mod.default!.chromium;
  return chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
}

async function openPage(b: any, page: Page, width = 1280, height = 900): Promise<Tab> {
  const ctx = await b.newContext({ viewport: { width, height }, colorScheme: 'dark' });
  const tab = await ctx.newPage();
  await tab.goto(`${page.origin}/login?token=${page.token}`);
  return tab;
}

const shots = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
async function shot(tab: Tab, name: string): Promise<void> {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await tab.waitForTimeout(300);
  await tab.screenshot({ path: path.join(shots, `${name}.png`) });
}

/** The hits on screen, as "<name> | <tab> › <group>". */
const hits = (tab: Tab): Promise<string[]> => tab.locator('.search-results button.search-hit').evaluateAll((els: HTMLElement[]) =>
  els.map((e) => `${e.querySelector('.search-hit-name')!.childNodes[0]!.textContent!.trim()} | ${e.querySelector('.search-hit-path')!.textContent!.trim()}`));

async function main(): Promise<void> {
  removeTemp(work);
  // The browser first: a browser that can't start must not leave the Ledung running.
  const b = await browser();
  const dir = work;
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  const projects = ['Demo project', 'Website'].map((name) => ({ name, runner: 'local', path: path.join(dir, name.replace(' ', '-')) }));
  for (const p of projects) fs.mkdirSync(p.path, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: PORT, userName: 'Martin', remoteControl: false, projects }, null, 2));
  const log = fs.createWriteStream(path.join(dir, 'ledung.log'));
  const child: ChildProcess = spawn(process.execPath, [path.join(repo, 'src', 'main.ts'), '--no-open'], {
    cwd: dir, env: { ...process.env, LEDUNG_CONFIG: path.join(dir, 'config.json'), LEDUNG_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  for (const s of [child.stdout!, child.stderr!]) s.on('data', (d: Buffer) => { out += d.toString(); log.write(d); });
  try {
    await until(() => out.includes('Ledung is running at'), `the Ledung on ${PORT}`);
    const page = new Page(PORT, data);
    const tab = await openPage(b, page);
    const hash = () => tab.evaluate(() => location.hash);
    const settle = (ms = 900) => tab.waitForTimeout(ms);
    const box = tab.getByRole('searchbox', { name: 'Search settings' });

    // On every tab, above the side menu.
    for (const [address, name] of [['settings', 'Ledung'], ['chats', 'Chats'], ['ps/Demo%20project', 'Demo project'], ['ps/Website', 'Website']]) {
      await tab.goto(`${page.origin}/#/overview`);
      await tab.goto(`${page.origin}/#/${address}`);
      await settle();
      const above = await tab.evaluate(() => {
        const s = document.querySelector('.settings-side .settings-search');
        const m = document.querySelector('.settings-side .settings-menu');
        return !!s && !!m && s.getBoundingClientRect().bottom <= m.getBoundingClientRect().top + 1;
      });
      check(await box.count() === 1 && above, `${name} tab: the search box is above the side menu`);
    }

    // "/" focuses it.
    await tab.goto(`${page.origin}/#/settings/update`);
    await settle();
    await tab.locator('body').click({ position: { x: 900, y: 600 } });
    await tab.keyboard.press('/');
    check(await box.evaluate((e: Element) => e === document.activeElement), '"/" focuses the search box');
    check(await box.inputValue() === '', 'and types nothing into it');

    // The issue's words, each listing its settings with tab and group.
    const want: [string, string[]][] = [
      ['restart', ['Restart Ledung | Ledung › Update & restart']],
      ['phone', ['Phones | Ledung › Remote & devices', 'Remote access | Ledung › Remote & devices']],
      ['theme', ['Appearance | Ledung › Look & feel']],
      ['skills', ['Skills | Ledung › Sessions', 'Skills | Demo project › Skills & profiles', 'Skills | Website › Skills & profiles']],
      ['usage', ['Usage stops | Ledung › Claude & usage', 'Publish usage | Ledung › Claude & usage', 'Publish its usage under its name | Demo project › General']],
      ['always goes to you', ['What always goes to you | Chats › What always goes to you', 'What always goes to you | Demo project › What always goes to you']],
    ];
    for (const [q, expect] of want) {
      await box.fill(q);
      await settle(200);
      const seen = await hits(tab);
      for (const e of expect) check(seen.includes(e), `"${q}" lists ${e}`, JSON.stringify(seen.slice(0, 8)));
      if (q === 'phone') await shot(tab, '367-search-phone-ledung-1280-dark');
    }

    // No match says so, and lists nothing.
    await box.fill('xylophone');
    await settle(200);
    check(await tab.locator('.search-results').innerText() === 'No setting matches "xylophone".' && (await hits(tab)).length === 0, 'no match says so, and suggests nothing');
    await shot(tab, '367-search-no-match-1280-dark');

    // Escape clears the search first, then leaves Settings.
    await tab.goto(`${page.origin}/#/overview`);
    await settle();
    await tab.goto(`${page.origin}/#/settings/update`);
    await settle();
    await box.fill('phone');
    await tab.keyboard.press('Escape');
    await settle(200);
    check(await box.inputValue() === '' && await hash() === '#/settings/update', 'Escape clears the search and stays in Settings');
    check(await tab.locator('.settings-content').isVisible(), 'the group is back');
    await tab.keyboard.press('Escape');
    await settle();
    // Opened by its address here, so leaving goes to the start page (#78), not back to Overview.
    check(!(await hash()).startsWith('#/settings') && await tab.locator('.settings-frame').count() === 0, 'a second Escape leaves Settings', await hash() || '(start page)');

    // From the Chats tab, choosing a project's hit opens that tab and group and highlights the setting.
    await tab.goto(`${page.origin}/#/chats`);
    await settle();
    await box.fill('ticket link');
    await settle(200);
    await shot(tab, '367-search-ticket-chats-1280-dark');
    await tab.locator('.search-results button.search-hit', { hasText: 'Website' }).first().click();
    await settle(400);
    check(await hash() === '#/ps/Website/tickets', "choosing Website's Ticket link opens its tab and group", await hash());
    check(await box.inputValue() === '', 'the search is cleared');
    const lit = tab.locator('.settings-content .search-found');
    check(await lit.count() === 1 && (await lit.innerText()).includes('Ticket link'), 'Ticket link is highlighted');
    await shot(tab, '367-search-chosen-highlight-1280-dark');
    await tab.waitForTimeout(2800);
    check(await lit.count() === 0, 'the highlight fades');

    // Enter opens the first hit; on the Ledung tab a hit from the Ledung tab.
    await box.fill('appearance');
    await tab.keyboard.press('Enter');
    await settle(400);
    check(await hash() === '#/settings/look', 'Enter opens the first hit', await hash());
    check(await tab.locator('.settings-content .search-found').count() === 1, 'and highlights it');

    // Relay while it is off is drawn as the one line "Run a relay": choosing it still outlines that line.
    await box.fill('relay');
    await settle(200);
    await tab.locator('.search-results button.search-hit', { hasText: /^Relay/ }).first().click();
    await settle(600);
    const relay = tab.locator('.settings-content .search-found');
    check(await hash() === '#/settings/remote' && await relay.count() === 1 && (await relay.innerText()).includes('Run a relay'), 'choosing Relay outlines its "Run a relay" line', await hash());

    // A search kept while the tab changes, and what is typed in a group kept while searching.
    await tab.goto(`${page.origin}/#/ps/Demo%20project/general`);
    await settle();
    const model = tab.locator('.field', { has: tab.locator('.field-name', { hasText: /^Model$/ }) }).locator('input').first();
    await model.fill('sonnet');
    await box.fill('lockdown');
    await settle(200);
    check((await hits(tab))[0] === 'Lockdown | Demo project › Manager\'s powers', "the open project's hit comes first", JSON.stringify(await hits(tab)));
    await box.fill('');
    await settle(200);
    check(await model.inputValue() === 'sonnet', 'what was typed in the group is still there after a search');

    // The × (#383): shown only while there is text; it empties the box, closes the results and keeps the focus; Tab
    // reaches it. On every tab.
    const clear = tab.getByRole('button', { name: 'Clear search' });
    for (const [address, name] of [['settings/update', 'Ledung'], ['chats', 'Chats'], ['ps/Demo%20project/general', 'Demo project']]) {
      await tab.goto(`${page.origin}/#/${address}`);
      await settle();
      check(await clear.count() === 0, `${name} tab: no × while the box is empty`);
      await box.fill('skills');
      await settle(200);
      check(await clear.isVisible() && (await hits(tab)).length > 0, `${name} tab: an × while it has text`);
      if (name === 'Ledung') await shot(tab, '383-search-clear-ledung-1280-dark');
      await clear.click();
      await settle(200);
      check(await box.inputValue() === '' && await tab.locator('.search-results').count() === 0 && await tab.locator('.settings-content').isVisible(), `${name} tab: the × empties the box and closes the results`);
      check(await box.evaluate((e: Element) => e === document.activeElement) && await clear.count() === 0, `${name} tab: the focus stays in the box, and the × is gone`);
    }
    await box.fill('skills');
    await box.focus();
    await tab.keyboard.press('Tab');
    check(await clear.evaluate((e: Element) => e === document.activeElement), 'Tab from the box reaches the ×');
    await tab.keyboard.press('Enter');
    await settle(200);
    check(await box.inputValue() === '' && await box.evaluate((e: Element) => e === document.activeElement), 'Enter on the × clears it too, back in the box');

    // The phone: above the list of groups, the hits in its place.
    const phone = await openPage(b, page, 390, 844);
    await phone.goto(`${page.origin}/#/settings`);
    await phone.waitForTimeout(1000);
    const pbox = phone.getByRole('searchbox', { name: 'Search settings' });
    const phoneAbove = await phone.evaluate(() => {
      const s = document.querySelector('.settings-side .settings-search');
      const m = document.querySelector('.settings-side .settings-menu');
      return !!s && !!m && m.querySelectorAll('.settings-menu-item').length > 0 && s.getBoundingClientRect().bottom <= m.getBoundingClientRect().top + 1;
    });
    check(await pbox.count() === 1 && phoneAbove, 'phone: the box is above the list of groups');
    await pbox.fill('phone');
    await phone.waitForTimeout(300);
    check(await phone.locator('.settings-menu').count() === 0 && (await hits(phone)).includes('Phones | Ledung › Remote & devices'), 'phone: the hits replace the list');
    await shot(phone, '367-search-phone-390-dark');
    const pclear = phone.getByRole('button', { name: 'Clear search' });
    check(await pclear.isVisible(), 'phone: an × while it has text');
    await shot(phone, '383-search-clear-phone-390-dark');
    await pclear.click();
    await phone.waitForTimeout(300);
    check(await pbox.inputValue() === '' && await phone.locator('.settings-menu-item').count() > 0 && await phone.locator('.search-results').count() === 0
      && await pbox.evaluate((e: Element) => e === document.activeElement), 'phone: the × empties the box, the list of groups is back, the focus stays');
    await pbox.fill('phone');
    await phone.waitForTimeout(300);
    await phone.locator('.search-results button.search-hit').first().click();
    await phone.waitForTimeout(600);
    check(await phone.evaluate(() => location.hash) === '#/settings/remote' && await phone.locator('.settings-content .search-found').count() === 1, 'phone: a hit opens its group, highlighted');
  } finally {
    await b.close();
    if (child.exitCode === null) {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill();
      await gone;
    }
  }
  console.log(failed() ? `${failed()} FAILED` : 'all passed');
  process.exitCode = failed() ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
