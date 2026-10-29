// Loopback for issue #365 (Settings in one place, mockup F): the page as drawn, in a real browser, on throwaway
// Ledungs. Not in CI (it starts Ledungs and a browser). playwright-core is not a dependency of Ledung: it is given
// from outside, as for link-pair.ts.
//
//   PLAYWRIGHT=/path/to/playwright-core [CHROMIUM=/path/to/chrome] node test/loopback/settings-frame.ts   # ports 4397, 4398
//
// Part 1, one Ledung on 4398 with two projects and remote off: every setting the side menu lists for search (#367) is
// drawn in its group, and every section drawn holds one of them (review of PR #371: the list must not drift from the
// page); "this browser" and "config" tags sit exactly on the settings the list says are kept there; the five features
// that are off are one line each, Phones and Linked computers greyed; Set up on Remote access opens the join form in
// place; Relay is one line until set up and in full after; Publish usage (#363) is one line whose Set up opens it in
// place; addresses, Back, Escape and the ⚙ (#78).
// Part 2, two linked Ledungs behind a real local relay (linked-pair.ts): with remote connected, Remote access, Phones
// and Linked computers are full sections and no longer lines, through the same probes that found them as lines in
// part 1.
// Part 3 (issue #366), on part 1's Ledung: a project's ⚙ opens its tab and the chats' ⚙ the Chats tab; every field
// the side menus list is drawn in its group and nothing is tagged; the Ledung defaults and an override with Reset; one
// Save for the whole tab, the Message board included, kept while moving between groups; Discard; "What always goes to
// you" open in its own group; the name colours in Look, saved at once and seen in another browser; the old addresses;
// the phone. SHOTS=<folder> also saves the dark screenshots for the PR. PART=1 runs parts 1 and 3 only.
// Exit code 1 on any FAIL.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { check, failed, link, Page, repo, startPair, until } from './linked-pair.ts';
import { removeTemp } from '../temp.ts';
import { CHATS_GROUPS, LEDUNG_GROUPS, PROJECT_GROUPS, type SettingsGroup } from '../../web/src/settingsGroups.ts';

const work = path.join(repo, '.test', 'settings-frame-loopback');

type Tab = any;

/** What a probe sees in the open group: section headings, one-line features, and the settings' own labels. */
async function drawn(tab: Tab): Promise<{ headings: string[]; lines: { name: string; why: string; needs: boolean; buttons: string[] }[]; labels: string[] }> {
  return tab.evaluate(() => {
    const content = document.querySelector('.settings-content')!;
    const text = (e: Element) => (e.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      headings: [...content.querySelectorAll('section h3')].map(text),
      lines: [...content.querySelectorAll('.offline')].map((l) => ({
        name: text(l.querySelector('.offline-name')!), why: text(l.querySelector('.offline-why')!), needs: l.classList.contains('needs'),
        buttons: [...l.querySelectorAll('button')].map(text),
      })),
      // A form field's own name (".field-name", the project and Chats tabs, #366) counts as its label too.
      labels: [...content.querySelectorAll('label.toggle, .compact-slider > span, .field-name')].map(text),
    };
  });
}

/** The tag in the section that holds a setting: "browser", "config", or "" for none. */
async function tagOf(tab: Tab, label: string): Promise<string> {
  return tab.evaluate((label: string) => {
    const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const content = document.querySelector('.settings-content')!;
    const el = [...content.querySelectorAll('section h3, label.toggle, .compact-slider > span, .offline-name, .field-name')].find((e) => norm(e.textContent) === norm(label));
    const where = el?.closest('section')?.querySelector('.where');
    return where ? (where.classList.contains('browser') ? 'browser' : where.classList.contains('config') ? 'config' : '?') : '';
  }, label);
}

/** A listed setting is drawn: a section heading, a switch or slider, or a one-line feature ("Run a relay" for Relay). */
function found(seen: Awaited<ReturnType<typeof drawn>>, label: string): boolean {
  const l = label.toLowerCase();
  return seen.headings.some((h) => h.toLowerCase() === l) || seen.labels.some((t) => t.toLowerCase() === l)
    || seen.lines.some((x) => x.name.toLowerCase() === l || x.name.toLowerCase() === `run a ${l}`);
}

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

async function group(tab: Tab, origin: string, id: string): Promise<void> {
  await tab.goto(`${origin}/#/settings/${id}`);
  await tab.locator('.settings-content').waitFor();
  // The groups read some of their state from the server after they open.
  await tab.waitForTimeout(1200);
}

async function partOne(): Promise<void> {
  const dir = path.join(work, 'one');
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  const projects = ['Demo project', 'Website'].map((name) => ({ name, runner: 'local', path: path.join(dir, name.replace(' ', '-')) }));
  for (const p of projects) fs.mkdirSync(p.path, { recursive: true });
  // A workflow, so a project tab's Workflow group has its fields (#366).
  const workflow = { folder: path.join(dir, 'process'), managerFile: 'lead.md', sessionFile: 'worker.md', projectConfig: 'docs/LEAD.md' };
  fs.mkdirSync(workflow.folder, { recursive: true });
  for (const f of ['lead.md', 'worker.md']) fs.writeFileSync(path.join(workflow.folder, f), '# process\n');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 4398, userName: 'Martin', remoteControl: false, workflow, projects,
    // A second profile, so a project tab's two profile fields can be set off their default (#366).
    profiles: { lean: { about: 'Only Ledung\'s tools.', mcpServers: 'none' } } }, null, 2));
  const log = fs.createWriteStream(path.join(dir, 'ledung.log'));
  const child: ChildProcess = spawn(process.execPath, [path.join(repo, 'src', 'main.ts'), '--no-open'], {
    cwd: dir, env: { ...process.env, LEDUNG_CONFIG: path.join(dir, 'config.json'), LEDUNG_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  for (const s of [child.stdout!, child.stderr!]) s.on('data', (d: Buffer) => { out += d.toString(); log.write(d); });
  const b = await browser();
  try {
    await until(() => out.includes('Ledung is running at'), 'the Ledung on 4398');
    const page = new Page(4398, data);
    const tab = await openPage(b, page);

    for (const g of LEDUNG_GROUPS) {
      await group(tab, page.origin, g.id);
      const seen = await drawn(tab);
      for (const s of g.settings) {
        check(found(seen, s.label), `${g.label}: "${s.label}" is drawn`, found(seen, s.label) ? '' : `headings ${JSON.stringify(seen.headings)}`);
        const tag = await tagOf(tab, s.label);
        check(tag === (s.storedIn ?? ''), `${g.label}: "${s.label}" is tagged ${s.storedIn ? `"${s.storedIn}"` : 'nothing'}`, `found "${tag}"`);
      }
      // The other way: a section drawn that no listed setting stands for would be missed by search.
      for (const h of seen.headings) {
        if (h === 'Not set up') continue;
        const covered = g.settings.some((s) => s.label.toLowerCase() === h.toLowerCase())
          || await tab.evaluate(([h, labels]: [string, string[]]) => {
            const sec = [...document.querySelectorAll('.settings-content section')].find((s) => (s.querySelector('h3')?.textContent ?? '').trim() === h);
            const inside = [...(sec?.querySelectorAll('label.toggle, .compact-slider > span, .field-name') ?? [])].map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase());
            return labels.some((l) => inside.includes(l.toLowerCase()));
          }, [h, g.settings.map((s) => s.label)]);
        check(covered, `${g.label}: section "${h}" holds a listed setting`);
      }
    }

    // Publish usage (#363), off by default: one line in Claude & usage; Set up opens its form in place, nothing sent yet.
    await group(tab, page.origin, 'claude');
    const usage = (await drawn(tab)).lines.find((l) => l.name === 'Publish usage');
    check(!!usage, 'claude: Publish usage is one line while off');
    check(usage?.buttons.includes('Set up ›') === true, 'claude: Publish usage has Set up ›');
    await tab.locator('.offline', { has: tab.locator('.offline-name', { hasText: /^Publish usage$/ }) }).getByRole('button', { name: 'Set up ›' }).click();
    const usageForm = tab.locator('.offline-open', { hasText: 'Publish usage' });
    check(await usageForm.count() === 1, 'Set up on Publish usage opens in place');
    check(await usageForm.getByRole('checkbox', { name: 'Publish usage' }).isChecked() === false, 'Publish usage opens unticked');

    // Remote & devices with remote off (f-mix.png): Computers in full, the other five as one line each.
    await group(tab, page.origin, 'remote');
    let seen = await drawn(tab);
    check(seen.headings.includes('Computers'), 'remote off: Computers is a full section');
    const line = (name: string) => seen.lines.find((l) => l.name === name);
    for (const name of ['Remote access', 'Phones', 'Linked computers', 'Run a relay', 'Message board']) check(!!line(name), `remote off: ${name} is one line`);
    for (const name of ['Remote access', 'Phones', 'Linked computers', 'Relay']) check(!seen.headings.includes(name), `remote off: ${name} is not a full section`);
    for (const name of ['Phones', 'Linked computers']) {
      check(!!line(name)?.needs && line(name)?.why === 'Needs remote access first.', `remote off: ${name} is greyed, "Needs remote access first."`, JSON.stringify(line(name)));
      check(line(name)?.buttons.length === 0, `remote off: ${name} has no button`);
    }
    check(line('Remote access')?.buttons.includes('Set up ›') === true, 'remote off: Remote access has Set up ›');
    check(line('Message board')?.buttons.includes('Projects ›') === true, 'Message board has Projects ›');
    // By the line's own name: "Needs remote access first." on Phones and Linked computers matches a plain text search too.
    const lineOf = (name: string) => tab.locator('.offline', { has: tab.locator('.offline-name', { hasText: new RegExp(`^${name}$`) }) });
    await lineOf('Remote access').getByRole('button', { name: 'Set up ›' }).click();
    const open = tab.locator('.offline-open', { hasText: 'Remote access' });
    check(await open.count() === 1, 'Set up on Remote access opens in place');
    // The form asks the server for the relay link first, and draws nothing until it answers.
    await open.getByRole('textbox', { name: 'Join code' }).waitFor({ timeout: 5000 }).catch(() => {});
    check(await open.getByRole('textbox', { name: 'Join code' }).count() === 1 && await open.getByRole('button', { name: 'Join with a code' }).count() === 1, "it is today's join-with-a-code form");
    await open.getByRole('button', { name: 'Close Remote access' }).click();
    check(await lineOf('Remote access').count() === 1 && await open.count() === 0, '✕ makes it one line again');

    // Relay: one line until set up; Set up opens its form; once a relay address is saved it is in full, also after a reload.
    await lineOf('Run a relay').getByRole('button', { name: 'Set up ›' }).click();
    const relay = tab.locator('.offline-open', { hasText: 'Run a relay' });
    check(await relay.count() === 1, 'Set up on Run a relay opens its form in place');
    await relay.locator('input').first().fill('wss://relay.example.org');
    await relay.getByRole('button', { name: 'Save' }).first().click();
    await tab.waitForTimeout(1200);
    seen = await drawn(tab);
    check(seen.headings.includes('Relay') && !line('Run a relay'), 'once set up, Relay is a full section and no longer a line');
    await tab.reload();
    await tab.waitForTimeout(1500);
    seen = await drawn(tab);
    check(seen.headings.includes('Relay'), 'a relay admin who has set up sees Relay in full after a reload');

    // Addresses, Back, Escape and the ⚙ (#78).
    const hash = () => tab.evaluate(() => location.hash);
    await tab.goto(`${page.origin}/#/overview`);
    await tab.waitForTimeout(800);
    await tab.getByRole('button', { name: 'Settings', exact: true }).click();
    check(await hash() === '#/settings', 'the ⚙ opens Settings');
    check(await tab.getByRole('tab', { name: 'Ledung' }).getAttribute('aria-selected') === 'true', 'on the Ledung tab');
    check((await tab.locator('.settings-menu-item.on').innerText()).startsWith('Update & restart'), 'on Update & restart');
    await tab.getByRole('button', { name: /^Remote & devices/ }).click();
    check(await hash() === '#/settings/remote', 'a group has its own address');
    await tab.getByRole('button', { name: /^Look & feel/ }).click();
    await tab.goBack();
    check(await hash() === '#/settings/remote', 'Back goes to the group before');
    await tab.goForward();
    await tab.keyboard.press('Escape');
    await tab.waitForTimeout(400);
    check(await hash() === '#/overview', 'Escape goes back past every group to where Settings was opened');
    await tab.getByRole('button', { name: 'Settings', exact: true }).click();
    await tab.getByRole('button', { name: /^About/ }).click();
    await tab.getByRole('button', { name: 'Close settings' }).click();
    await tab.waitForTimeout(400);
    check(await hash() === '#/overview', 'a second ⚙ press goes back to where Settings was opened');
    await tab.goto(`${page.origin}/#/accounts`);
    await tab.waitForTimeout(1000);
    check((await tab.locator('.settings-menu-item.on').innerText()).startsWith('Claude & usage'), 'the old Accounts address opens Claude & usage');
    for (const [name, want] of [['Chats', '#/chats'], ['Website', '#/ps/Website'], ['+ Add project', '#/add']]) {
      await tab.getByRole('tab', { name }).click();
      check(await hash() === want && await tab.locator('.settings-state').count() === 1, `the ${name} tab, with the header`);
    }

    // The phone: plain Settings is the list of groups; a group opens on its own.
    const phone = await openPage(b, page, 390, 844);
    await phone.goto(`${page.origin}/#/settings`);
    await phone.waitForTimeout(1000);
    check(await phone.locator('.settings-menu-item').count() === LEDUNG_GROUPS.length && await phone.locator('.settings-content').count() === 0, 'phone: Settings is the list of groups');
    await phone.getByRole('button', { name: /^Remote & devices/ }).click();
    await phone.waitForTimeout(800);
    check(await phone.locator('.settings-menu').count() === 0 && await phone.getByRole('button', { name: '← All settings' }).count() === 1, 'phone: a group opens on its own');

    await partThree(b, page);
  } finally {
    await b.close();
    if (child.exitCode === null) {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill();
      await gone;
    }
  }
}

const shots = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
async function shot(tab: Tab, name: string): Promise<void> {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await tab.waitForTimeout(300);
  await tab.screenshot({ path: path.join(shots, `${name}.png`) });
}

/** Every setting a tab's group lists is drawn in it, untagged unless the list says so, and every section drawn holds one. */
async function groupDrawn(tab: Tab, tabName: string, g: SettingsGroup): Promise<void> {
  const seen = await drawn(tab);
  for (const s of g.settings) {
    check(found(seen, s.label), `${tabName} › ${g.label}: "${s.label}" is drawn`, found(seen, s.label) ? '' : `labels ${JSON.stringify(seen.labels)} headings ${JSON.stringify(seen.headings)}`);
    const tag = await tagOf(tab, s.label);
    check(tag === (s.storedIn ?? ''), `${tabName} › ${g.label}: "${s.label}" is tagged ${s.storedIn ? `"${s.storedIn}"` : 'nothing'}`, `found "${tag}"`);
  }
  for (const h of seen.headings) {
    const covered = g.settings.some((s) => s.label.toLowerCase() === h.toLowerCase())
      || await tab.evaluate(([h, labels]: [string, string[]]) => {
        const sec = [...document.querySelectorAll('.settings-content section')].find((s) => (s.querySelector('h3')?.textContent ?? '').trim() === h);
        const inside = [...(sec?.querySelectorAll('label.toggle, .field-name') ?? [])].map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase());
        return labels.some((l) => inside.includes(l.toLowerCase()));
      }, [h, g.settings.map((s) => s.label)]);
    check(covered, `${tabName} › ${g.label}: section "${h}" holds a listed setting`);
  }
}

/** The text under a field's name: its Ledung default or its override (#366). */
const lineOf = (tab: Tab, field: string) => tab.locator('.field', { has: tab.locator('.field-name', { hasText: new RegExp(`^${field}$`) }) }).locator('.inherit');
const saveBar = (tab: Tab) => tab.locator('.save-bar');
/** A field's control, found by the field's name. */
const control = (tab: Tab, field: string) => tab.locator('.field', { has: tab.locator('.field-name', { hasText: new RegExp(`^${field}$`) }) }).locator('input, select, textarea').first();

/** Part 3 (issue #366): the project and Chats tabs, on part 1's Ledung with remote off. */
async function partThree(b: any, page: Page): Promise<void> {
  const tab = await openPage(b, page);
  const hash = () => tab.evaluate(() => location.hash);
  const settle = (ms = 900) => tab.waitForTimeout(ms);
  const project = async () => (await page.api('GET', 'projects')).json.find((p: { name: string }) => p.name === 'Demo project');
  await tab.goto(`${page.origin}/#/overview`);
  await settle();

  // A project's ⚙ opens its tab; the chats' ⚙ the Chats tab.
  await tab.getByRole('button', { name: 'Settings of Demo project' }).click();
  await settle();
  check(await hash() === '#/ps/Demo%20project', "a project's ⚙ opens its tab", await hash());
  check(await tab.getByRole('tab', { name: 'Demo project' }).getAttribute('aria-selected') === 'true', 'on the Demo project tab');
  check((await tab.locator('.settings-menu-item.on').innerText()).startsWith('General'), 'on General');
  check(await tab.getByRole('button', { name: 'Settings of Demo project' }).evaluate((e: Element) => e.classList.contains('on')), "the project's ⚙ shows as on");
  await tab.getByRole('button', { name: 'Settings of chats' }).click();
  await settle();
  check(await hash() === '#/chats' && await tab.getByRole('tab', { name: 'Chats' }).getAttribute('aria-selected') === 'true', "the chats' ⚙ opens the Chats tab");

  // Every listed field is drawn in its group (search, #367, reads the same list).
  for (const g of PROJECT_GROUPS) {
    await tab.goto(`${page.origin}/#/ps/Demo%20project/${g.id}`);
    await settle(1300);
    check((await tab.locator('.settings-menu-item.on').innerText()).startsWith(g.label), `#/ps/Demo%20project/${g.id} opens ${g.label}`);
    await groupDrawn(tab, 'Demo project', g);
    await shot(tab, `366-p${PROJECT_GROUPS.indexOf(g) + 1}-${g.id}-1280-dark`);
  }
  for (const g of CHATS_GROUPS) {
    await tab.goto(`${page.origin}/#/chats/${g.id}`);
    await settle(1100);
    await groupDrawn(tab, 'Chats', g);
    await shot(tab, `366-c${CHATS_GROUPS.indexOf(g) + 1}-${g.id}-1280-dark`);
  }

  // What always goes to you: its own group, highlighted, nothing to unfold.
  await tab.goto(`${page.origin}/#/ps/Demo%20project/safety`);
  await settle();
  const safety = tab.locator('.settings-content .safety');
  check(await safety.count() === 1 && await safety.isVisible(), 'What always goes to you is open and highlighted');
  check(await tab.locator('.settings-content details .sensitive-list').count() === 0, 'nothing to unfold');
  const entries = await safety.locator('.sensitive-list li').count();
  check(entries > 0 && entries === (await project()).sensitive.commandPatterns.length + (await project()).sensitive.pathPatterns.length, 'it lists exactly what is enforced', `${entries} drawn`);
  check((await tab.locator('.settings-menu-item', { hasText: 'What always goes to you' }).innerText()).includes(String(entries)), 'the side menu counts its entries');

  // Ledung defaults, an override with Reset.
  await tab.goto(`${page.origin}/#/ps/Demo%20project/general`);
  await settle();
  for (const [field, text] of ([['Claude account', "Ledung default: this computer's own login"], ['Model', "Ledung default: the project's Claude settings, else Claude Code's"],
    ['Model for its manager', 'Ledung default: the same as its sessions'], ['Permissions for new sessions', 'Ledung default: Ask']] as [string, string][])) {
    check(await lineOf(tab, field).innerText() === text, `${field}: "${text}"`, await lineOf(tab, field).innerText());
  }
  check(await saveBar(tab).count() === 0, 'no Save bar while nothing is changed');
  await control(tab, 'Model').fill('sonnet');
  check((await lineOf(tab, 'Model').innerText()).startsWith('Overrides Ledung') && await lineOf(tab, 'Model').getByRole('button', { name: 'Reset' }).count() === 1, 'a value of its own: "Overrides Ledung · Reset"');
  check((await saveBar(tab).innerText()).includes('1 unsaved change'), 'the Save bar counts 1');
  await lineOf(tab, 'Model').getByRole('button', { name: 'Reset' }).click();
  check(await control(tab, 'Model').inputValue() === '' && (await lineOf(tab, 'Model').innerText()).startsWith('Ledung default'), 'Reset brings the default back');
  check(await saveBar(tab).count() === 0, 'and nothing is left to save');
  // An override saved, shown after a reload, then Reset and saved again.
  await control(tab, 'Permissions for new sessions').selectOption('plan');
  await control(tab, 'Model').fill('haiku');
  check((await saveBar(tab).innerText()).includes('2 unsaved changes'), 'two changes, counted');
  await shot(tab, '366-p1b-general-override-1280-dark');
  await saveBar(tab).getByRole('button', { name: 'Save' }).click();
  await settle();
  check((await project()).model === 'haiku' && (await project()).permissionMode === 'plan', 'Save saved both', JSON.stringify({ model: (await project()).model, mode: (await project()).permissionMode }));
  await tab.reload();
  await settle(1200);
  check((await lineOf(tab, 'Permissions for new sessions').innerText()).startsWith('Overrides Ledung (Ask)'), 'after a reload: Overrides Ledung (Ask)');
  await lineOf(tab, 'Permissions for new sessions').getByRole('button', { name: 'Reset' }).click();
  await lineOf(tab, 'Model').getByRole('button', { name: 'Reset' }).click();
  await saveBar(tab).getByRole('button', { name: 'Save' }).click();
  await settle();
  check((await project()).model === null && (await project()).permissionMode === null, 'Reset and Save: the project follows Ledung again');

  // One Save for the whole tab: a change in General and one on the Message board, kept while moving between groups.
  await control(tab, 'Model for its manager').fill('opus');
  await tab.locator('.settings-menu-item', { hasText: 'Message board' }).click();
  await settle();
  check(await hash() === '#/ps/Demo%20project/board', 'a group of a project tab has its own address');
  await tab.locator('.board-repo input, input[placeholder*="owner/"]').first().fill('example/board');
  await settle(300);
  check((await saveBar(tab).innerText()).includes('2 unsaved changes'), 'a board change and a General change: one bar, 2 changes', await saveBar(tab).innerText());
  // The same probe finds the tab's own Save, so finding none on the board means there is none (test review of PR #379).
  const saves = (where: any) => where.getByRole('button', { name: /^Save/ });
  check(await saves(saveBar(tab)).count() === 1, 'the probe for a Save button finds the tab\'s own Save');
  check(await saves(tab.locator('.settings-content')).count() === 0, 'the board has no Save of its own');
  check((await tab.locator('.settings-menu-item', { hasText: 'General' }).innerText()).includes('•') && (await tab.locator('.settings-menu-item', { hasText: 'Message board' }).innerText()).includes('•'), 'the side menu marks both groups');
  await shot(tab, '366-p8b-board-unsaved-1280-dark');
  await saveBar(tab).getByRole('button', { name: 'Save' }).click();
  await settle(1500);
  const board = (await page.api('GET', 'board')).json;
  check((await project()).managerModel === 'opus' && board?.projects?.['Demo project']?.repo === 'example/board', 'one Save saved the project and its board', JSON.stringify({ manager: (await project()).managerModel, board: board?.projects?.['Demo project'] }));

  // Every field the tab owns, changed through its own control in its group, saved with one Save and read back from
  // the server; then put back the same way (test review of PR #379, finding 1).
  await page.open();
  await page.api('POST', 'accounts', { name: 'Work' });
  await tab.reload();
  await settle(1200);
  const before = await project();
  const extra = path.join(path.dirname(page.data), 'worktrees');
  const go = async (g: string) => { await tab.locator('.settings-menu-item', { hasText: new RegExp(`^${g}`) }).click(); await settle(500); };
  const toggle = (name: string) => tab.locator('label.toggle', { has: tab.locator('.field-name', { hasText: new RegExp(`^${name}`) }) }).locator('input');
  await go('General');
  await control(tab, 'Claude account').selectOption('Work');
  await control(tab, 'Extra folders').fill(extra);
  await toggle('Publish its usage under its name').check();
  await go('What always goes to you');
  const removed = (await tab.locator('.sensitive-list li code').first().innerText()).trim();
  await tab.locator('.sensitive-list li').first().getByRole('button').click();
  await tab.locator('.sensitive-add input').fill('\\bdeploy-prod\\b');
  await tab.locator('.sensitive-add').getByRole('button', { name: 'Add' }).click();
  await go("Manager's powers");
  await control(tab, 'What the manager may decide for you').fill('Naming and test structure.');
  await toggle('Its manager adds projects').check();
  await toggle('Its manager reads and changes workflow settings').check();
  await control(tab, 'Dev ship command').fill('npm run ship:dev');
  await tab.locator('label', { has: tab.locator('.field-name', { hasText: /^Lockdown$/ }) }).locator('select').selectOption('A');
  await tab.getByLabel('Keep the message board on for it').check();
  await tab.getByLabel('Keep Remote Control for its manager').check();
  await go('Skills & profiles');
  await tab.locator('.skills-choice summary').click();
  const skill = tab.locator('.skills-choice input[type=checkbox]').first();
  await skill.click();
  await control(tab, 'Profile for its manager').selectOption('lean');
  await control(tab, 'Profile for its sessions').selectOption('lean');
  await go('Workflow');
  await control(tab, 'Project config for the workflow').fill('docs/OTHER.md');
  await go('Tickets & questions');
  await control(tab, 'Ticket pattern').fill('T-\\d+');
  await control(tab, 'Ticket link').fill('https://tracker.example/{id}');
  await control(tab, 'Question tiers').fill('Now\nLater');
  check(await saveBar(tab).isVisible(), 'every field changed: one Save bar', await saveBar(tab).innerText());
  await saveBar(tab).getByRole('button', { name: 'Save' }).click();
  await settle(1500);
  const after = await project();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const [what, got, want] of [
    ['Claude account', after.account, 'Work'],
    ['Extra folders', after.extraFolders, [extra]],
    ['Publish its usage under its name', after.publishUsageName, true],
    ['a pattern taken out', after.sensitive.commandPatterns.includes(removed) || after.sensitive.pathPatterns.includes(removed), false],
    ['a pattern added', after.sensitive.commandPatterns.includes('\\bdeploy-prod\\b'), true],
    ['the config-only MCP tools kept', after.sensitive.mcpTools, before.sensitive.mcpTools],
    ['What the manager may decide for you', after.managerGrant, 'Naming and test structure.'],
    ['Its manager adds projects…', after.projectToolsUnasked, true],
    ['Its manager reads and changes workflow settings…', after.projectSettingsTools, true],
    ['Dev ship command', after.devShipCommand, 'npm run ship:dev'],
    ['Lockdown', [after.lockdown.level, after.lockdown.board, after.lockdown.remoteControl], ['A', true, true]],
    ['Skills', Object.keys(after.skills).length > 0, true],
    ['Profile for its manager', after.profiles.manager, 'lean'],
    ['Profile for its sessions', after.profiles.session, 'lean'],
    ['Project config for the workflow', after.workflow?.projectConfig, 'docs/OTHER.md'],
    ['Ticket pattern and link', after.tickets, { pattern: 'T-\\d+', url: 'https://tracker.example/{id}' }],
    ['Question tiers', after.questionTiers, ['Now', 'Later']],
  ] as [string, unknown, unknown][]) check(same(got, want), `one Save saved "${what}"`, `got ${JSON.stringify(got)}`);

  // Put back, through the same controls, and check the server has what it had.
  await go('General');
  await lineOf(tab, 'Claude account').getByRole('button', { name: 'Reset' }).click();
  await control(tab, 'Extra folders').fill('');
  await toggle('Publish its usage under its name').uncheck();
  await go('What always goes to you');
  await tab.locator('.sensitive-list li', { hasText: 'deploy-prod' }).getByRole('button').click();
  await tab.locator('.sensitive-add input').fill(removed);
  await tab.locator('.sensitive-add').getByRole('button', { name: 'Add' }).click();
  await go("Manager's powers");
  await control(tab, 'What the manager may decide for you').fill('');
  await toggle('Its manager adds projects').uncheck();
  await toggle('Its manager reads and changes workflow settings').uncheck();
  await control(tab, 'Dev ship command').fill('');
  await tab.locator('label', { has: tab.locator('.field-name', { hasText: /^Lockdown$/ }) }).locator('select').selectOption('off');
  await go('Skills & profiles');
  await tab.locator('.field', { has: tab.locator('.skills-choice') }).locator('.inherit').getByRole('button', { name: 'Reset' }).click();
  await lineOf(tab, 'Profile for its manager').getByRole('button', { name: 'Reset' }).click();
  await lineOf(tab, 'Profile for its sessions').getByRole('button', { name: 'Reset' }).click();
  await go('Workflow');
  await control(tab, 'Project config for the workflow').fill('');
  await go('Tickets & questions');
  await control(tab, 'Ticket pattern').fill('');
  await control(tab, 'Ticket link').fill('');
  await control(tab, 'Question tiers').fill(before.questionTiers.join('\n'));
  await saveBar(tab).getByRole('button', { name: 'Save' }).click();
  await settle(1500);
  const back = await project();
  const sorted = (p: any) => ({ ...p, sensitive: { ...p.sensitive, commandPatterns: [...p.sensitive.commandPatterns].sort() } });
  for (const k of ['account', 'extraFolders', 'publishUsageName', 'sensitive', 'managerGrant', 'projectToolsUnasked', 'projectSettingsTools', 'devShipCommand', 'lockdown', 'skills', 'profiles', 'workflow', 'tickets', 'questionTiers']) {
    check(same(sorted(back)[k] ?? null, sorted(before)[k] ?? null), `put back: "${k}" is as before`, `${JSON.stringify(sorted(back)[k])} vs ${JSON.stringify(sorted(before)[k])}`);
  }

  // A new name goes with Save, and the tab moves to it, on the same group (issue #116).
  await go('General');
  await control(tab, 'Name').fill('Demo renamed');
  await saveBar(tab).getByRole('button', { name: 'Save' }).click();
  await settle(1500);
  check(await hash() === '#/ps/Demo%20renamed/general' && (await page.api('GET', 'projects')).json.some((p: { name: string }) => p.name === 'Demo renamed'), 'Save renames, and the tab moves to the new name', await hash());
  await control(tab, 'Name').fill('Demo project');
  await saveBar(tab).getByRole('button', { name: 'Save' }).click();
  await settle(1500);
  check(await hash() === '#/ps/Demo%20project/general' && !!(await project()), 'and back');

  // Discard throws the unsaved changes away.
  await tab.goto(`${page.origin}/#/ps/Demo%20project/tickets`);
  await settle();
  await control(tab, 'Ticket pattern').fill('[A-Z]+-\\d+');
  await tab.goto(`${page.origin}/#/ps/Demo%20project/safety`);
  await settle();
  await tab.locator('.sensitive-list li').first().getByRole('button').click();
  check((await saveBar(tab).innerText()).includes('2 unsaved changes'), 'a ticket pattern and a pattern taken out: 2 changes');
  await saveBar(tab).getByRole('button', { name: 'Discard' }).click();
  check(await tab.locator('.sensitive-list li').count() === entries && await saveBar(tab).count() === 0, 'Discard puts the list back and leaves nothing to save');
  await tab.goto(`${page.origin}/#/ps/Demo%20project/tickets`);
  await settle();
  check(await control(tab, 'Ticket pattern').inputValue() === '', 'and the ticket pattern too');

  // Look: the name colours, saved at once, seen in another browser; not in the manager's ⚙ menu any more (no session here to open one).
  await tab.goto(`${page.origin}/#/ps/Demo%20project/look`);
  await settle();
  await tab.getByRole('button', { name: 'Manager name: Teal' }).click();
  await settle();
  check((await project()).colours.manager === 'teal' && await saveBar(tab).count() === 0, 'a colour saves at once, with no Save', JSON.stringify((await project()).colours));
  await shot(tab, '366-p5b-look-teal-1280-dark');
  const other = await openPage(b, page);
  await other.goto(`${page.origin}/#/ps/Demo%20project/look`);
  await other.waitForTimeout(1200);
  check(await other.getByRole('button', { name: 'Manager name: Teal' }).getAttribute('aria-pressed') === 'true', 'another browser shows it');
  check(await other.locator('.sidebar .named', { hasText: 'Demo project' }).count() > 0, "and the project's name in its sidebar has the colour");
  await other.context().close();
  await tab.goto(`${page.origin}/#/chats/look`);
  await settle();
  await tab.getByRole('button', { name: "Chats' names: Pink" }).click();
  await settle();
  check((await page.api('GET', 'chats')).json?.colour === 'pink', "the chats' colour saves at once too");

  // The Chats tab: the list saves with its Save bar.
  await tab.goto(`${page.origin}/#/chats/safety`);
  await settle();
  const chatEntries = await tab.locator('.sensitive-list li').count();
  await tab.locator('.sensitive-add input').fill('\\bterraform apply\\b');
  await tab.locator('.sensitive-add').getByRole('button', { name: 'Add' }).click();
  check((await saveBar(tab).innerText()).includes('1 unsaved change'), 'Chats: adding a pattern is 1 unsaved change');
  await shot(tab, '366-c2b-safety-unsaved-1280-dark');
  await saveBar(tab).getByRole('button', { name: 'Save' }).click();
  await settle();
  check((await page.api('GET', 'chats')).json?.sensitive.commandPatterns.includes('\\bterraform apply\\b') && await tab.locator('.sensitive-list li').count() === chatEntries + 1, 'Chats: Save saved it');

  // The old addresses lead to the new tabs.
  await tab.goto(`${page.origin}/#/ps/Website`);
  await settle();
  check(await tab.getByRole('tab', { name: 'Website' }).getAttribute('aria-selected') === 'true' && (await tab.locator('.settings-menu-item.on').innerText()).startsWith('General'), 'the old #/ps/<name> opens the tab on General');
  await tab.goto(`${page.origin}/#/chats`);
  await settle();
  check((await tab.locator('.settings-menu-item.on').innerText()).startsWith('General') && await tab.locator('.field-name', { hasText: 'Folder' }).count() === 1, 'the old #/chats opens the Chats tab on General');
  // Back steps through a project tab's groups.
  await tab.goto(`${page.origin}/#/ps/Website/general`);
  await settle(600);
  await tab.locator('.settings-menu-item', { hasText: 'Workflow' }).click();
  await tab.locator('.settings-menu-item', { hasText: 'Look' }).click();
  await tab.goBack();
  await settle(500);
  check(await hash() === '#/ps/Website/workflow', 'Back goes to the group before');

  // The phone: the tab is its list of groups; a group opens on its own with the Save bar under it.
  const phone = await openPage(b, page, 390, 844);
  await phone.goto(`${page.origin}/#/ps/Demo%20project`);
  await phone.waitForTimeout(1200);
  check(await phone.locator('.settings-menu-item').count() === PROJECT_GROUPS.length && await phone.locator('.settings-content').count() === 0, 'phone: a project tab is its list of groups');
  await shot(phone, '366-phone-1-project-list-390-dark');
  await phone.getByRole('button', { name: /^What always goes to you/ }).click();
  await phone.waitForTimeout(800);
  check(await phone.locator('.settings-menu').count() === 0 && await phone.locator('.safety').isVisible(), 'phone: What always goes to you opens on its own');
  await shot(phone, '366-phone-2-safety-390-dark');
  await phone.getByRole('button', { name: '← All settings' }).click();
  await phone.getByRole('button', { name: /^General/ }).click();
  await phone.waitForTimeout(800);
  await control(phone, 'Model').fill('sonnet');
  check(await saveBar(phone).isVisible() && (await saveBar(phone).boundingBox()).y + (await saveBar(phone).boundingBox()).height <= 844 + 1, 'phone: the Save bar is on screen');
  await shot(phone, '366-phone-3-general-override-390-dark');
  await phone.goto(`${page.origin}/#/chats/safety`);
  await phone.waitForTimeout(1000);
  await shot(phone, '366-phone-4-chats-safety-390-dark');
  await phone.context().close();
  await tab.context().close();
}

async function partTwo(): Promise<void> {
  const pair = await startPair(path.join(work, 'pair'));
  const b = await browser();
  try {
    await link(pair.pages);
    for (const [w, h] of [[1280, 900], [390, 844]]) {
      const tab = await openPage(b, pair.pages.mac, w, h);
      await group(tab, pair.pages.mac.origin, 'remote');
      await tab.waitForTimeout(1300);
      const seen = await drawn(tab);
      for (const name of ['Remote access', 'Phones', 'Linked computers']) {
        check(seen.headings.includes(name), `${w}px, remote connected: ${name} is a full section`);
        check(!seen.lines.some((l) => l.name === name), `${w}px, remote connected: ${name} is not a line`);
      }
    }
  } finally {
    await b.close();
    await pair.close();
  }
}

async function main(): Promise<void> {
  removeTemp(work);
  await partOne();
  if (process.env.PART !== '1') await partTwo();
  console.log(failed() ? `${failed()} FAILED` : 'all passed');
  process.exitCode = failed() ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
