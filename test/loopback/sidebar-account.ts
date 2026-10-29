// Loopback for issue #394 (option B, Martin in Ledung question #388): the project's Claude account in small muted text
// over its name in the sidebar, in a real browser, on a throwaway Ledung on 4396. Not in CI (it starts a Ledung and a
// browser). playwright-core is given from outside, as for settings-frame.ts.
//
//   PLAYWRIGHT=/path/to/playwright-core [CHROMIUM=/path/to/chrome] [SHOTS=<folder>] node test/loopback/sidebar-account.ts
//
// The accounts are made up, with empty sign-in folders, and the sessions run a stand-in for Claude Code that only
// waits: nothing signs in or reaches Anthropic. A named account is shown over its project's name, also when it is the
// only one added; a project on this computer's own login shows none; a long name ends in "…" with the whole name on
// hover and leaves the row's buttons where they were; the manager's row names no account. Exit code 1 on any FAIL.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, failed, Page, repo, until } from './linked-pair.ts';
import { removeTemp } from '../temp.ts';

const work = path.join(repo, '.test', 'sidebar-account-loopback');
const PORT = 4396;
const LONG = 'northwind-enterprise-team-plan';
type Tab = any;

async function browser() {
  if (!process.env.PLAYWRIGHT) throw new Error('Set PLAYWRIGHT to a playwright-core folder (and CHROMIUM to a browser, unless its own is installed).');
  const mod = await import(process.env.PLAYWRIGHT) as { chromium?: any; default?: { chromium: any } };
  const chromium = mod.chromium ?? mod.default!.chromium;
  return chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
}

async function openPage(b: any, page: Page, width: number, height: number): Promise<Tab> {
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

/** What the sidebar shows of a project's row: its account line, where it sits against the name, and its buttons. */
const row = (tab: Tab, project: string) => tab.evaluate((name: string) => {
  const rows = [...document.querySelectorAll('.project-row')];
  const r = rows.find((e) => e.querySelector('.project-name')?.textContent?.includes(name));
  if (!r) return null;
  const account = r.querySelector('.project-account') as HTMLElement | null;
  const title = r.querySelector('.project-name-text') as HTMLElement | null;
  const actions = r.querySelector('.project-actions') as HTMLElement | null;
  const box = (e: Element | null) => (e ? e.getBoundingClientRect() : null);
  return {
    account: account?.textContent ?? null,
    accountTitle: account?.title ?? null,
    cut: account ? account.scrollWidth > account.clientWidth : false,
    over: !!account && !!title && box(account)!.bottom <= box(title)!.top + 1,
    actionsRight: box(actions)?.right ?? null,
    actionsWidth: box(actions)?.width ?? null,
    rowRight: box(r)!.right,
  };
}, project);

async function main(): Promise<void> {
  removeTemp(work);
  // The browser first: a browser that can't start must not leave the Ledung running.
  const b = await browser();
  const dir = work;
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  const sdk = JSON.parse(fs.readFileSync(path.join(repo, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')) as { claudeCodeVersion: string };
  // The stand-in for Claude Code: answers the version and sign-in checks, and otherwise waits until it is stopped.
  const fake = path.join(dir, 'fake-claude.mjs');
  fs.writeFileSync(fake, [
    "const a = process.argv.slice(2).join(' ');",
    `if (a.includes('--version')) { console.log('${sdk.claudeCodeVersion} (Claude Code)'); process.exit(0); }`,
    "if (a.includes('auth status')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }",
    'setInterval(() => {}, 1 << 30);',
    '',
  ].join('\n'));
  // The projects outside this repository: inside it, their managers would show this branch and its pull request.
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-sidebar-account-')));
  for (const p of ['Orchard', 'Harbor', 'Lantern', 'Meadow']) fs.mkdirSync(path.join(real, 'projects', p), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: PORT, userName: 'Martin', remoteControl: false, claudeExecutable: fake, browseRoots: [real], projects: [] }, null, 2));
  const log = fs.createWriteStream(path.join(dir, 'ledung.log'));
  const child: ChildProcess = spawn(process.execPath, [path.join(repo, 'src', 'main.ts'), '--no-open'], {
    cwd: dir, env: { ...process.env, LEDUNG_CONFIG: path.join(dir, 'config.json'), LEDUNG_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  for (const s of [child.stdout!, child.stderr!]) s.on('data', (d: Buffer) => { out += d.toString(); log.write(d); });
  const page = new Page(PORT, data);
  const managers: string[] = [];
  try {
    await until(() => out.includes('Ledung is running at'), `the Ledung on ${PORT}`);
    await page.open();
    const ok = async (what: string, call: Promise<{ status: number; json: any }>) => {
      const r = await call;
      if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)}`);
      return r.json;
    };
    const account = (name: string) => ok(`add account ${name}`, page.api('POST', 'accounts', { name, configDir: path.join(real, 'logins', name) }));
    const project = (name: string, acc?: string) => ok(`add project ${name}`, page.api('POST', 'projects', { name, runner: 'local', path: path.join(real, 'projects', name), ...(acc ? { account: acc } : {}) }));

    // One named account only: it is named all the same (before #394 it was hidden then).
    await account('work');
    await project('Orchard', 'work');
    await project('Lantern');
    const tab = await openPage(b, page, 1280, 800);
    await tab.goto(`${page.origin}/#/overview`);
    await tab.waitForTimeout(1200);
    let orchard = await row(tab, 'Orchard');
    check(orchard?.account === 'work' && orchard.over, 'with one account added, Orchard names "work" over its name', JSON.stringify(orchard));
    let lantern = await row(tab, 'Lantern');
    check(lantern !== null && lantern.account === null, "Lantern, on this computer's own login, names no account", JSON.stringify(lantern));

    // More accounts, a long name, and managers running.
    await account('side-project');
    await account(LONG);
    await project('Harbor', 'side-project');
    await project('Meadow', LONG);
    for (const p of ['Orchard', 'Lantern', 'Meadow']) {
      await ok(`start the manager of ${p}`, page.api('POST', `projects/${p}/manager`, { text: 'Where do things stand?' }));
    }
    const now = await ok('projects', page.api('GET', 'projects')) as { name: string; managerId: string | null }[];
    managers.push(...now.map((p) => p.managerId).filter((id): id is string => !!id));
    check(managers.length === 3, 'three managers started', JSON.stringify(now.map((p) => [p.name, !!p.managerId])));
    await tab.goto(`${page.origin}/#/p/Harbor`);
    await tab.waitForTimeout(1500);

    orchard = await row(tab, 'Orchard');
    const harbor = await row(tab, 'Harbor');
    const meadow = await row(tab, 'Meadow');
    lantern = await row(tab, 'Lantern');
    check(orchard?.account === 'work' && orchard.over, 'Orchard names "work" over its name', JSON.stringify(orchard));
    check(harbor?.account === 'side-project' && harbor.over, 'Harbor, open, names "side-project" over its name', JSON.stringify(harbor));
    check(lantern?.account === null, 'Lantern still names no account', JSON.stringify(lantern));
    check(meadow?.account === LONG && meadow.over && meadow.cut, `Meadow's long account is cut at the sidebar's width`, JSON.stringify(meadow));
    check(meadow?.accountTitle?.includes(LONG) ?? false, 'and its whole name is in the tooltip', meadow?.accountTitle ?? '');
    check(!!meadow && !!lantern && meadow.actionsRight === lantern.actionsRight && meadow.actionsWidth === lantern.actionsWidth && meadow.actionsRight! <= meadow.rowRight,
      "the long name leaves the row's buttons where a row without an account has them", JSON.stringify({ meadow, lantern }));
    const managerRows = await tab.locator('.session-item').count();
    const managerAccounts = await tab.locator('.session-item .project-account').count();
    const named = await tab.locator('.session-item', { hasText: /work|side-project|northwind/ }).count();
    check(managerRows >= 3 && managerAccounts === 0 && named === 0, 'the manager rows name no account', `${managerRows} rows, ${managerAccounts + named} with an account`);
    await shot(tab, '394-sidebar-account-1280-dark');

    // The phone: the list is the whole screen; the account still over the name.
    const phone = await openPage(b, page, 390, 844);
    await phone.goto(`${page.origin}/`);
    await phone.waitForTimeout(1500);
    const pm = await row(phone, 'Meadow');
    check(pm?.account === LONG && pm.over && pm.actionsRight! <= pm.rowRight, 'phone: Meadow names its account over its name, the buttons in the row', JSON.stringify(pm));
    check((await row(phone, 'Lantern'))?.account === null, 'phone: Lantern names none');
    await shot(phone, '394-sidebar-account-390-dark');
  } finally {
    await b.close();
    // The managers' hosts outlive Ledung by design: stop the sessions first, so nothing is left running.
    for (const id of managers) await page.api('POST', `sessions/${id}/stop`).catch(() => null);
    page.ws?.close();
    if (child.exitCode === null) {
      const gone = new Promise((r) => child.once('exit', r));
      child.kill();
      await gone;
    }
    removeTemp(real);
  }
  console.log(failed() ? `${failed()} FAILED` : 'all passed');
  process.exitCode = failed() ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
