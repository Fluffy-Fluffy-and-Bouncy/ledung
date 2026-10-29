// Loopback for issue #410 (macros, placement B, Martin 2026-10-29 in Ledung question #425): chips right-aligned in a
// session's info bar, the rest and the keybind-only ones in the last chip's menu, a click and a keybind that send or
// insert, and Settings → Macros (list, edit form, keybind clash), in a real browser on a throwaway Ledung on 4397. Not
// in CI (it starts a Ledung and a browser). playwright-core is given from outside, as for settings-frame.ts.
//
//   PLAYWRIGHT=/path/to/playwright-core [CHROMIUM=/path/to/chrome] [SHOTS=<folder>] node test/loopback/macros.ts
//
// The sessions run a stand-in for Claude Code that answers once and then waits: nothing signs in or reaches
// Anthropic. Exit code 1 on any FAIL.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, failed, Page, repo, until } from './linked-pair.ts';
import { removeTemp } from '../temp.ts';
import type { Macro } from '../../src/shared/macros.ts';

const work = path.join(repo, '.test', 'macros-loopback');
const PORT = 4397;
type Tab = any;

const m = (id: string, name: string, text: string, send: boolean, key: string | null, over: Partial<Macro> = {}): Macro =>
  ({ id, name, text, send, key, chip: true, project: null, ...over });
/** Eight chips (one only in Lantern, so not in an Orchard session), one keybind only. */
const MANY: Macro[] = [
  m('continue', 'Continue', 'Continue.', true, 'Ctrl+Shift+1'),
  m('checks', 'Run checks', 'Run the checks and tell me what fails.', true, 'Ctrl+Shift+2'),
  m('status', 'Status?', 'Where do things stand on {issue}?', true, null),
  m('summarize', 'Summarize', 'Summarize what you did in five lines.', false, 'Ctrl+Shift+4'),
  m('compact', '/compact', '/compact', true, null),
  m('review', 'Review', 'Review your diff on {branch} before you push.', false, null),
  m('open-pr', 'Open PR', 'Open a draft PR for {issue}.', false, null, { project: 'Orchard' }),
  m('lantern', 'Lantern only', 'Not in Orchard.', false, null, { project: 'Lantern' }),
  m('wrap', 'Wrap up', 'Wrap up: commit, push and report.', false, 'Ctrl+Shift+8'),
  m('go-on', 'Go on', 'Go on.', true, 'Ctrl+Shift+9', { chip: false }),
  // Kept for a project Ledung no longer has (code review of #416, Minor 2): no chip anywhere, marked in Settings.
  m('gone', 'Old one', 'From a removed project.', false, null, { project: 'Gone' }),
];
const FEW = MANY.slice(0, 3);

async function browser() {
  if (!process.env.PLAYWRIGHT) throw new Error('Set PLAYWRIGHT to a playwright-core folder (and CHROMIUM to a browser, unless its own is installed).');
  const mod = await import(process.env.PLAYWRIGHT) as { chromium?: any; default?: { chromium: any } };
  const chromium = mod.chromium ?? mod.default!.chromium;
  return chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
}

const shots = process.env.SHOTS ? path.resolve(process.env.SHOTS) : null;
async function shot(tab: Tab, name: string): Promise<void> {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await tab.waitForTimeout(300);
  await tab.screenshot({ path: path.join(shots, `${name}.png`) });
}

/** The info bar's macros: the chips in sight, the last chip's label, and whether the bar is on one line. */
const bar = (tab: Tab) => tab.evaluate(() => {
  const line = document.querySelector('.status-line');
  const chips = [...document.querySelectorAll('.status-line .macro-chips .macro-chip')] as HTMLElement[];
  const more = document.querySelector('.status-line .macro-more') as HTMLElement | null;
  const lineBox = line?.getBoundingClientRect();
  const label = document.querySelector('.status-line .working-label') as HTMLElement | null;
  return {
    all: chips.map((c) => c.textContent),
    shown: chips.filter((c) => !c.hasAttribute('aria-hidden')).map((c) => c.textContent),
    more: more?.textContent ?? null,
    // Right-aligned: the last chip ends at the line's right padding.
    rightGap: more && lineBox ? Math.round(lineBox.right - more.getBoundingClientRect().right) : null,
    oneLine: !!lineBox && lineBox.height < 40,
    labelWidth: label?.getBoundingClientRect().width ?? 0,
    menu: [...document.querySelectorAll('.macro-menu [role=menuitem]')].map((e) => e.textContent),
  };
});

async function main(): Promise<void> {
  removeTemp(work);
  const b = await browser();
  const data = path.join(work, 'data');
  fs.mkdirSync(data, { recursive: true });
  const sdk = JSON.parse(fs.readFileSync(path.join(repo, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')) as { claudeCodeVersion: string };
  const fake = path.join(work, 'fake-claude.mjs');
  const reply = 'Checks ran: 412 passed, 0 failed. The branch is pushed and the draft PR is open; nothing is waiting on you.';
  fs.writeFileSync(fake, [
    "const a = process.argv.slice(2).join(' ');",
    `if (a.includes('--version')) { console.log('${sdk.claudeCodeVersion} (Claude Code)'); process.exit(0); }`,
    "if (a.includes('auth status')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }",
    "const id = 'msg_fake_' + process.pid + '_' + Date.now();",
    `console.log(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, session_id: 'fake', message: { id, model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(reply)} }], usage: { input_tokens: 10, output_tokens: 10 } } }));`,
    `console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, is_error: false, result: 'ok', session_id: 'fake', modelUsage: { 'claude-haiku-4-5': { contextWindow: 200000 } } }));`,
    'setInterval(() => {}, 1 << 30);',
    '',
  ].join('\n'));
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-macros-')));
  for (const p of ['Orchard', 'Lantern']) fs.mkdirSync(path.join(real, 'projects', p), { recursive: true });
  fs.writeFileSync(path.join(work, 'config.json'), JSON.stringify({ port: PORT, userName: 'Martin', remoteControl: false, claudeExecutable: fake, browseRoots: [real], projects: [] }, null, 2));
  const log = fs.createWriteStream(path.join(work, 'ledung.log'));
  const child: ChildProcess = spawn(process.execPath, [path.join(repo, 'src', 'main.ts'), '--no-open'], {
    cwd: work, env: { ...process.env, LEDUNG_CONFIG: path.join(work, 'config.json'), LEDUNG_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  for (const s of [child.stdout!, child.stderr!]) s.on('data', (d: Buffer) => { out += d.toString(); log.write(d); });
  const page = new Page(PORT, data);
  const ok = async (what: string, call: Promise<{ status: number; json: any }>) => {
    const r = await call;
    if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  try {
    await until(() => out.includes('Ledung is running at'), `the Ledung on ${PORT}`);
    await page.open();
    for (const p of ['Orchard', 'Lantern']) await ok(`add ${p}`, page.api('POST', 'projects', { name: p, runner: 'local', path: path.join(real, 'projects', p) }));
    await ok('manager', page.api('POST', 'projects/Orchard/manager', { text: 'Where do things stand?' }));
    const w = await ok('session', page.api('POST', 'sessions', { project: 'Orchard', text: 'Run the checks and tell me what fails.' })) as { id: string };
    await ok('session', page.api('POST', 'sessions', { project: 'Lantern', text: 'Go.' }));
    // The stand-in answers at once; give the three sessions a moment to start and answer.
    await new Promise((r) => setTimeout(r, 4000));
    const session = `#/s/${w.id}`;
    const open = async (width: number, height: number, hash: string): Promise<Tab> => {
      const ctx = await b.newContext({ viewport: { width, height }, colorScheme: 'dark', deviceScaleFactor: width < 500 ? 2 : 1 });
      const tab = await ctx.newPage();
      await tab.goto(`${page.origin}/login?token=${page.token}`);
      await tab.goto(`${page.origin}/${hash}`);
      await tab.waitForTimeout(1500);
      return tab;
    };

    // --- Three chips -------------------------------------------------------------------------------------------
    await ok('three macros', page.api('POST', 'macros', { macros: FEW }));
    for (const [width, height] of [[1280, 800], [390, 844]] as const) {
      const tab = await open(width, height, session);
      const s = await bar(tab);
      check(s.all.length === 3, `${width}: three chips in the info bar`, JSON.stringify(s));
      check(s.oneLine && s.rightGap !== null && s.rightGap <= 20, `${width}: on the bar's one line, right-aligned`, JSON.stringify(s));
      if (width === 1280) check(s.shown.length === 3 && s.more === '＋', '1280: all three in sight, and ＋ for Edit macros', JSON.stringify(s));
      else check(s.shown.length >= 1 && s.shown.length < 3 && s.more === `+${3 - s.shown.length}`, '390: what does not fit is counted on the last chip', JSON.stringify(s));
      check(s.labelWidth > 40, `${width}: the status keeps room`, String(s.labelWidth));
      await shot(tab, `410-b-3chips-${width}-dark`);
      await tab.context().close();
    }

    // --- Many: the Lantern one is not here, the keybind-only one is only in the menu ------------------------------
    await ok('many macros', page.api('POST', 'macros', { macros: MANY }));
    for (const [width, height] of [[1280, 800], [390, 844]] as const) {
      const tab = await open(width, height, session);
      let s = await bar(tab);
      check(s.all.length === 8 && !s.all.includes('Lantern only') && !s.all.some((t: string) => t.startsWith('Go on')), `${width}: eight chips: the global ones and Orchard's, no keybind-only one`, JSON.stringify(s.all));
      check(s.more === `+${8 - s.shown.length + 1}`, `${width}: the last chip counts the hidden chips and the keybind-only one`, JSON.stringify(s));
      await shot(tab, `410-b-8chips-${width}-dark`);
      await tab.click('.status-line .macro-more');
      s = await bar(tab);
      check(s.menu.some((t: string) => t.startsWith('Go on')) && s.menu.at(-1) === 'Edit macros…', `${width}: the menu has the rest, the keybind-only one, and Edit macros…`, JSON.stringify(s.menu));
      await shot(tab, `410-b-8chips-menu-${width}-dark`);
      await tab.context().close();
    }

    // --- Using them ----------------------------------------------------------------------------------------------
    const tab = await open(1280, 800, session);
    const box = () => tab.$eval('.composer textarea', (e: HTMLTextAreaElement) => e.value);
    const said = () => tab.$$eval('.msg', (els: Element[]) => els.map((e) => e.textContent ?? ''));
    await tab.click('.status-line .macro-chip:has-text("Summarize")');
    check((await box()) === 'Summarize what you did in five lines.', 'an insert chip puts its text in the message box', await box());
    await tab.fill('.composer textarea', '');
    await tab.click('.status-line .macro-chip:has-text("Continue")');
    await until(async () => (await said()).some((t: string) => t.includes('Continue.')), 'the sent macro', 10_000).catch(() => null);
    check((await said()).some((t: string) => t.includes('Continue.')), 'a send chip sends its text at once');
    await tab.click('.status-line .macro-chip:has-text("Run checks")', { modifiers: ['Shift'] });
    check((await box()) === 'Run the checks and tell me what fails.', 'Shift+click on a send chip puts it in the box instead', await box());
    await tab.fill('.composer textarea', '');
    await tab.focus('.composer textarea');
    await tab.keyboard.press('Control+Shift+Digit4');
    check((await box()) === 'Summarize what you did in five lines.', 'its keybind works from inside the message box', await box());
    await tab.fill('.composer textarea', '');
    await tab.keyboard.press('Control+Shift+Digit9');
    await until(async () => (await said()).some((t: string) => t.includes('Go on.')), 'the keybind-only macro', 10_000).catch(() => null);
    check((await said()).some((t: string) => t.includes('Go on.')), 'a keybind-only macro sends by its key');
    await tab.click('.status-line .macro-chip:has-text("Status?")');
    check((await box()) === 'Where do things stand on {issue}?', 'a placeholder the session has no value for goes into the box, not out', await box());
    // A save reaches a page that is already open (the "macros" event), with no reload: test review of #416, finding 1.
    await ok('without Status?', page.api('POST', 'macros', { macros: MANY.filter((x) => x.id !== 'status') }));
    await until(async () => (await bar(tab)).all.length === 7, 'the open tab hearing the save', 5000).catch(() => null);
    const live = await bar(tab);
    check(live.all.length === 7 && !live.all.some((t: string) => t.startsWith('Status?')), 'an open session tab drops a removed chip without a reload', JSON.stringify(live.all));
    await tab.context().close();

    // --- Settings ------------------------------------------------------------------------------------------------
    for (const [width, height] of [[1280, 800], [390, 844]] as const) {
      const st = await open(width, height, '#/settings/macros');
      const rows = await st.$$eval('.macro-list li', (els: Element[]) => els.map((e) => e.textContent ?? ''));
      check(rows.length === ((await page.api('GET', 'state')).json?.macros ?? []).length && rows.some((r: string) => r.includes('keybind only')), `${width}: Settings lists every macro and marks the keybind-only one`, JSON.stringify(rows.length));
      await shot(st, `410-settings-list-${width}-dark`);
      await st.click('.macro-list li:nth-child(2) button:has-text("Edit")');
      await st.evaluate(() => document.querySelector('.macro-form')?.scrollIntoView({ block: 'start' }));
      check(await st.isVisible('.macro-form label:has-text("Show as a chip") input:checked') && await st.isVisible('.macro-form label:has-text("Keybind") input:checked'), `${width}: the form has the chip and the keybind on switches of their own`);
      await shot(st, `410-settings-edit-${width}-dark`);
      await st.click('.macro-keyin');
      await st.keyboard.press('Control+KeyO');
      const clash = await st.textContent('.macro-conflict').catch(() => '');
      check(/tool calls/.test(clash ?? '') && await st.isDisabled('.macro-form button:has-text("Save")'), `${width}: Ctrl+O is refused with what uses it, and Save waits`, clash ?? '');
      await st.evaluate(() => document.querySelector('.macro-keyin')?.scrollIntoView({ block: 'center' }));
      await shot(st, `410-settings-clash-${width}-dark`);
      if (width === 1280) {
        await st.click('.macro-keyin');
        await st.keyboard.press('Control+Shift+Digit1');
        const taken = await st.textContent('.macro-conflict').catch(() => '');
        check(/“Continue” has this keybind/.test(taken ?? ''), 'another macro\'s keybind is named', taken ?? '');
        // Its own Ctrl+Shift+2 is free for it; Continue's Ctrl+Shift+1 is not.
        const offered = await st.$$eval('.macro-free', (els: Element[]) => els.map((e) => e.textContent));
        check(offered[0] === '⌃⇧2' && !offered.includes('⌃⇧1'), 'the free keybinds offered skip the taken ones', JSON.stringify(offered));
        await st.click('.macro-keyin');
        await st.keyboard.press('Control+Shift+Digit7');
        await st.click('.macro-form button:has-text("Save")');
        await st.waitForTimeout(800);
        const kept = (await page.api('GET', 'state')).json?.macros as Macro[] | undefined;
        const checks = kept?.find((x) => x.id === 'checks');
        const goneRow = await st.textContent('.macro-list li:has-text("Old one")').catch(() => '');
        check(/Gone \(removed\)/.test(goneRow ?? ''), 'a macro of a removed project is marked so in the list', goneRow ?? '');
        // The column can cut the label ("Gone (remo…" at 1280), so every scope chip has it whole on hover.
        const goneTitle = await st.getAttribute('.macro-list li:has-text("Old one") .macro-scope', 'title').catch(() => null);
        check(goneTitle === 'Gone (removed)', 'its scope chip has the whole label on hover', String(goneTitle));
        await st.click('.macro-list li:has-text("Old one") button:has-text("Edit")');
        const where = await st.$eval('.macro-form select', (e: HTMLSelectElement) => e.selectedOptions[0]?.textContent ?? '');
        check(where === 'Gone (removed)', 'its form shows the removed project as chosen, not a blank', where);
        await st.click('.macro-form button:has-text("Cancel")');
        check(checks?.key === 'Ctrl+Shift+7', 'a new keybind recorded and saved', JSON.stringify(checks));
        // The list on the page is the one Ledung sent back, so the row shows the new key without a reload.
        const row = await st.textContent('.macro-list li:nth-child(2)').catch(() => '');
        check(/⌃⇧7|Ctrl\+Shift\+7/.test(row ?? ''), 'the Settings row shows the saved keybind at once', row ?? '');
        await st.click('button:has-text("Add macro")');
        await st.fill('.macro-form input:not(.macro-keyin)', 'Thanks');
        await st.fill('.macro-form textarea', 'Thanks, that is all.');
        await st.click('.macro-form button:has-text("Save")');
        await st.waitForTimeout(800);
        const after = (await page.api('GET', 'state')).json?.macros as Macro[] | undefined;
        check(after?.at(-1)?.name === 'Thanks' && after.at(-1)!.chip && after.at(-1)!.key === null, 'a new macro is added at the end, a chip with no keybind', JSON.stringify(after?.at(-1)));
        // The Add saved the whole list from the page: had the page kept the old one, the edit above would be gone.
        check(after?.find((x) => x.id === 'checks')?.key === 'Ctrl+Shift+7', 'a second save from the same page keeps the first edit', JSON.stringify(after?.find((x) => x.id === 'checks')));
      }
      await st.context().close();
    }
    for (const [width, height] of [[1280, 800], [390, 844]] as const) {
      const st = await open(width, height, '#/settings');
      // Only the results region, not main: at 1280 the side menu in main always says "Macros" (test review of #416,
      // finding 2). A word that matches nothing shows the probe tells the two apart.
      const results = async (q: string) => {
        await st.fill('input[type=search]', q);
        await st.waitForTimeout(500);
        return await st.textContent('.search-results').catch(() => null);
      };
      const none = await results('zzz');
      check(none !== null && !/Macros/.test(none), `${width}: Settings search for "zzz" has no Macros hit`, String(none));
      const hit = await results('keybind');
      check(/Macros/.test(hit ?? ''), `${width}: Settings search finds Macros by "keybind"`, String(hit));
      await shot(st, `410-settings-search-${width}-dark`);
      await st.context().close();
    }
  } finally {
    await b.close();
    child.kill();
    // The session hosts carry the data folder on their command line.
    spawn('pkill', ['-f', data]);
  }
  console.log(failed() ? `${failed()} FAIL` : 'all PASS');
  process.exit(failed() ? 1 : 0);
}
await main();
