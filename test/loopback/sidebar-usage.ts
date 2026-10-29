// Loopback for issue #400 (Martin in Ledung question #393, "b — Footer chip"): no Overview and no Board button at the
// sidebar's top, a Usage chip in the footer, and the Overview's list as Usage → Sessions, in a real browser, on a
// throwaway Ledung on 4396. Not in CI (it starts a Ledung and a browser). playwright-core is given from outside, as
// for settings-frame.ts.
//
//   PLAYWRIGHT=/path/to/playwright-core [CHROMIUM=/path/to/chrome] [SHOTS=<folder>] node test/loopback/sidebar-usage.ts
//
// The sessions run a stand-in for Claude Code that reports one model call (fixed figures, below) and then waits: nothing
// signs in or reaches Anthropic. A board is set up but off (repo example/board), so the board chip shows without GitHub
// being asked (the test review of PR #401 found the call). Exit code 1 on any FAIL.
//
// Issue #403: a board problem is amber text under the connection's border. A real problem needs a board service that
// fails, so one tab rewrites the board part of what Ledung sends it (BOARD_PROBLEM, below); the chip itself is real.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, failed, Page, repo, until } from './linked-pair.ts';
import { removeTemp } from '../temp.ts';

const work = path.join(repo, '.test', 'sidebar-usage-loopback');
const PORT = 4396;
// The one model call each stand-in session reports: 1k input, 1k output, 38k cache read, 1k cache write, in a 200k
// window. So each session used 41k today (41k = 41000 tokens), the three together 123k, and the context is
// (1k + 38k + 1k) / 200k = 20 % full.
const CALL = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 38000, cache_creation_input_tokens: 1000 };
const MODEL = 'claude-haiku-4-5';
type Tab = any;
// The board as one failing repo with posts waiting (issue #403): 3 unread, 2 ignored, 1 thread paused, so the chip reads
// "Board: problem · 3 unread · 2 ignored · 1 paused", longer than the footer has room for at either width.
const LONG_BOARD = 'Board: problem · 3 unread · 2 ignored · 1 paused';
const BOARD_PROBLEM = {
  configured: true, identity: null, unread: { Orchard: 3 },
  projects: { Orchard: { enabled: true, repo: 'example/board', allow: [], channels: [], ignored: [{ login: 'someone', count: 2, lastAt: 0 }] } },
  boards: [{ repo: 'example/board', backend: 'github', state: 'error', identity: null, error: 'the board service did not answer.', lastPollAt: null, nextPollAt: null, projects: ['Orchard'], frontDesk: null, ignored: [], quiet: 0, paused: [{ project: 'Orchard', threadId: '7', until: 0 }] }],
};

/** A tab whose live connection carries BOARD_PROBLEM in place of the real board; everything else passes through. */
async function openProblemPage(b: any, page: Page, width: number, height: number): Promise<Tab> {
  const ctx = await b.newContext({ viewport: { width, height }, colorScheme: 'dark' });
  await ctx.routeWebSocket(/./, (ws: any) => {
    const server = ws.connectToServer();
    server.onMessage((m: string | Buffer) => {
      if (typeof m !== 'string') return ws.send(m);
      const e = JSON.parse(m) as { type: string; board?: unknown };
      if (e.type === 'hello' || e.type === 'board') e.board = BOARD_PROBLEM;
      ws.send(JSON.stringify(e));
    });
  });
  const tab = await ctx.newPage();
  await tab.goto(`${page.origin}/login?token=${page.token}`);
  return tab;
}

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

/** What the sidebar's top and footer show, and which Usage tab is selected. */
const state = (tab: Tab) => tab.evaluate(() => {
  const side = document.querySelector('.sidebar');
  const chip = document.querySelector('.connection .usage-chip') as HTMLElement | null;
  const board = document.querySelector('.connection .board-chip:not(.usage-chip)') as HTMLElement | null;
  const look = (e: HTMLElement) => {
    const st = getComputedStyle(e);
    return { text: e.textContent, title: e.title, pressed: e.getAttribute('aria-pressed'), on: e.classList.contains('on'), font: st.fontSize, radius: st.borderRadius, border: st.borderStyle + ' ' + st.borderWidth, color: st.borderTopColor,
      ink: st.color, cut: e.scrollWidth > e.clientWidth && st.textOverflow === 'ellipsis' && st.overflow === 'hidden', right: e.getBoundingClientRect().right };
  };
  /** A colour of the page's own palette as the browser computes it, to compare a border with. */
  const paint = (v: string) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${v})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  };
  const centres = [...document.querySelectorAll('.connection button')].map((e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; });
  const tabs = [...document.querySelectorAll('.usage .pane-tabs [role=tab]')];
  return {
    hash: location.hash,
    navEntries: document.querySelectorAll('.sidebar .nav-row, .sidebar .nav-entry').length,
    topButtons: [...(side?.querySelectorAll(':scope > button, :scope > div:not(.connection) > button') ?? [])].map((e) => e.textContent?.trim() ?? '').filter((t) => /^(Overview|Usage|Board)\b/.test(t)),
    first: side?.firstElementChild?.className ?? null,
    chip: chip ? look(chip) : null,
    board: board ? look(board) : null,
    footer: [...document.querySelectorAll('.connection button')].map((e) => e.className),
    footerText: document.querySelector('.connection')?.textContent ?? '',
    oneRow: centres.length > 0 && Math.max(...centres) - Math.min(...centres) < 2,
    green: paint('--st-good'),
    red: paint('--st-critical'),
    amber: paint('--dot-waiting'),
    plainInk: paint('--text'),
    sidebarRight: side?.getBoundingClientRect().right ?? 0,
    tabs: tabs.map((t) => t.textContent),
    selected: tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.textContent ?? null,
    cards: [...document.querySelectorAll('.usage .overview-card')].map((c) => ({ title: c.querySelector('.overview-title')?.textContent?.trim() ?? '', facts: c.querySelector('.overview-facts')?.textContent ?? '' })),
    listHead: document.querySelector('.usage .overview-list > .muted')?.textContent?.trim() ?? null,
    heading: document.querySelector('.main h2')?.textContent ?? null,
  };
});

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
    `const usage = ${JSON.stringify(CALL)};`,
    "const id = 'msg_fake_' + process.pid + '_' + Date.now();",
    `console.log(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, session_id: 'fake', message: { id, model: '${MODEL}', role: 'assistant', content: [{ type: 'text', text: 'Standing by.' }], usage } }));`,
    `console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, is_error: false, result: 'Standing by.', session_id: 'fake', modelUsage: { '${MODEL}': { contextWindow: 200000 } } }));`,
    'setInterval(() => {}, 1 << 30);',
    '',
  ].join('\n'));
  // The projects outside this repository: inside it, their managers would show this branch and its pull request.
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-sidebar-usage-')));
  for (const p of ['Orchard', 'Lantern']) fs.mkdirSync(path.join(real, 'projects', p), { recursive: true });
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
    for (const p of ['Orchard', 'Lantern']) {
      await ok(`add project ${p}`, page.api('POST', 'projects', { name: p, runner: 'local', path: path.join(real, 'projects', p) }));
      await ok(`start the manager of ${p}`, page.api('POST', `projects/${p}/manager`, { text: 'Where do things stand?' }));
    }
    const now = await ok('projects', page.api('GET', 'projects')) as { name: string; managerId: string | null }[];
    managers.push(...now.map((p) => p.managerId).filter((id): id is string => !!id));
    // A plain session, started after the managers: the list still puts the managers first.
    const plain = await ok('start a session in Orchard', page.api('POST', 'sessions', { project: 'Orchard', text: 'Go.' })) as { id: string };
    managers.push(plain.id);
    // No board yet: the Usage chip carries the connection's border (Ledung question #397's point 4).
    const early = await openPage(b, page, 1280, 800);
    await early.goto(`${page.origin}/#/waiting`);
    await early.waitForTimeout(1500);
    let s = await state(early);
    check(!s.board && s.chip?.color === s.green && /^Connected/.test(s.chip.title), 'no board: the Usage chip has the green border, and "Connected" in its tooltip', JSON.stringify([s.chip, s.green]));
    check(s.oneRow && !/Connected/.test(s.footerText), 'no board: the footer is one row with no "Connected" word', JSON.stringify([s.footer, s.footerText]));
    await shot(early, '400-footer-noboard-1280-dark');
    await early.context().close();

    await ok('set up a board, off', page.api('POST', 'board-projects/Orchard', { enabled: false, repo: 'example/board', allow: [], channels: [], frontDesk: false }));
    // The page reloads the per-session figures every 20 s; wait until the three calls are counted.
    await until(async () => ((await page.api('GET', 'overview')).json?.todayTokens ?? 0) >= 123000, 'the three stand-in calls counted', 30000);

    const tab = await openPage(b, page, 1280, 800);
    await tab.goto(`${page.origin}/#/waiting`);
    await tab.waitForTimeout(1500);
    s = await state(tab);
    check(s.navEntries === 0 && s.topButtons.length === 0, 'no Overview, Usage or Board button at the top of the sidebar', JSON.stringify(s));
    // The positive branch of the line above: a board is set up (its chip shows), where main had a Board button at the top.
    check(s.board?.text === 'Board off', 'a board is set up, so its chip shows', JSON.stringify(s.board));
    check(s.first?.includes('limits') || s.first?.includes('machine') || s.first?.includes('waiting-entry') || false, 'the sidebar starts with the meters (or what follows them when there are none)', String(s.first));
    check(s.chip?.text === 'Usage · 123k today', "the footer has a Usage chip with today's tokens (3 × 41k)", JSON.stringify(s.chip));
    check(s.chip?.pressed === 'false' && !s.chip.on, 'it is not selected while Waiting for you is open', JSON.stringify(s.chip));
    const cog = s.footer.findIndex((c: string) => c.includes('settings-cog'));
    const chipAt = s.footer.findIndex((c: string) => c.includes('usage-chip'));
    check(cog >= 0 && chipAt > cog, 'it sits in the footer after the ⚙', JSON.stringify(s.footer));
    check(s.footer[chipAt + 1]?.includes('board-chip') && !s.footer[chipAt + 1]?.includes('usage-chip'), 'and directly before the board chip', JSON.stringify(s.footer));
    check(s.board?.font === s.chip?.font && s.board?.radius === s.chip?.radius && s.board?.border === s.chip?.border, 'in the board chip\'s style (size, shape, border)', JSON.stringify([s.chip, s.board]));
    const rows = await tab.evaluate(() => [...document.querySelectorAll('.connection .usage-chip, .connection .board-chip:not(.usage-chip)')].map((e) => Math.round(e.getBoundingClientRect().top)));
    check(rows.length === 2 && rows[0] === rows[1], 'the two chips sit side by side on one row', JSON.stringify(rows));
    check(!/Connected/.test(s.footerText) && s.oneRow, 'the footer is one row, ⚙ and the two chips, with no "Connected" word', JSON.stringify([s.footer, s.footerText]));
    check(s.board?.color === s.green && /^Connected/.test(s.board.title) && s.board.title.includes('board'), 'connected: the board chip has the green border, the state and the board\'s own line in its tooltip', JSON.stringify([s.board, s.green]));
    check(s.chip?.color !== s.green && s.chip?.color !== s.red, 'with a board, the Usage chip\'s border is the plain one', JSON.stringify(s.chip));
    check(!s.board?.on, 'the board chip is not selected while Waiting for you is open', JSON.stringify(s.board));

    await tab.click('.connection .usage-chip');
    await tab.waitForTimeout(800);
    s = await state(tab);
    check(s.hash === '#/usage' && s.heading === 'Usage', 'the chip opens Usage', JSON.stringify(s));
    check(s.chip?.pressed === 'true' && s.chip.on, 'and looks selected while Usage is open', JSON.stringify(s.chip));
    check(!s.board?.on && s.board?.pressed === 'false', 'the board chip is not selected on Usage', JSON.stringify(s.board));
    check(JSON.stringify(s.tabs) === JSON.stringify(['This computer', 'Shared', 'Sessions']) && s.selected === 'This computer', 'Usage has three tabs, This computer first', JSON.stringify(s.tabs));
    await shot(tab, '400-sidebar-1280-dark');

    await tab.click('.usage .pane-tabs [role=tab]:has-text("Sessions")');
    await tab.waitForTimeout(800);
    s = await state(tab);
    check(s.hash === '#/overview' && s.selected === 'Sessions', 'Sessions has the old Overview address', JSON.stringify(s));
    check(s.cards.length === 3 && s.cards[0]!.title.startsWith('Manager') && s.cards[1]!.title.startsWith('Manager') && !s.cards[2]!.title.startsWith('Manager'),
      'it lists the three live sessions, managers first', JSON.stringify(s.cards.map((c: { title: string }) => c.title)));
    check(s.cards.every((c: { facts: string }) => c.facts.includes('41k today') && c.facts.includes('context 20%')), "each card shows its tokens today (41k) and its context fill (20%)", JSON.stringify(s.cards));
    check(s.listHead === '123k tokens today', "the tab's first line has today's total", String(s.listHead));
    check(s.chip?.on ?? false, 'the chip stays selected on Sessions', JSON.stringify(s.chip));
    await shot(tab, '400-usage-sessions-1280-dark');

    await tab.click('.usage .overview-card >> nth=0');
    await tab.waitForTimeout(800);
    s = await state(tab);
    check(s.hash.startsWith('#/s/') && !s.chip?.on, 'a row opens its session', JSON.stringify(s));
    await tab.goBack();
    await tab.waitForTimeout(800);
    s = await state(tab);
    check(s.hash === '#/overview' && s.selected === 'Sessions' && s.cards.length >= 2, 'Back lands on Usage → Sessions', JSON.stringify(s));
    await tab.click('.usage .pane-tabs [role=tab]:has-text("Shared")');
    await tab.waitForTimeout(500);
    s = await state(tab);
    check(s.hash === '#/usage' && s.selected === 'Shared', 'another tab leaves the Sessions address', JSON.stringify(s));

    // The board chip opens the board and is the one selected there.
    await tab.click('.connection .board-chip:not(.usage-chip)');
    await tab.waitForTimeout(800);
    s = await state(tab);
    check(s.hash === '#/board' && (s.board?.on ?? false) && s.board?.pressed === 'true' && !s.chip?.on, 'the board chip opens the board and looks selected there; the Usage chip does not', JSON.stringify(s));
    await tab.goto(`${page.origin}/#/usage`);
    await tab.waitForTimeout(800);
    await shot(tab, '400-footer-chips-1280-dark');

    // An old bookmark, typed in a fresh tab.
    const fresh = await openPage(b, page, 1280, 800);
    await fresh.goto(`${page.origin}/#/overview`);
    await fresh.waitForTimeout(1500);
    s = await state(fresh);
    check(s.heading === 'Usage' && s.selected === 'Sessions' && s.cards.length >= 2 && (s.chip?.on ?? false), 'an old #/overview address opens Usage → Sessions', JSON.stringify(s));

    // The phone: the list is the whole screen, the chip in its footer.
    const phone = await openPage(b, page, 390, 844);
    await phone.goto(`${page.origin}/`);
    await phone.waitForTimeout(1500);
    s = await state(phone);
    check(s.navEntries === 0 && !!s.chip, 'phone: no top buttons, the Usage chip in the footer', JSON.stringify(s));
    const box = await phone.locator('.connection .usage-chip').boundingBox();
    const bbox = await phone.locator('.connection .board-chip:not(.usage-chip)').boundingBox();
    check(!!box && !!bbox && box.x >= 0 && bbox.x + bbox.width <= 390 && Math.round(box.y) === Math.round(bbox.y) && bbox.x > box.x,
      'phone: both chips fit the screen, side by side', JSON.stringify([box, bbox]));
    check(s.oneRow && s.board?.color === s.green, 'phone: the footer is one row, the board chip green', JSON.stringify([s.footer, s.board]));
    await shot(phone, '400-sidebar-390-dark');
    await phone.click('.connection .usage-chip');
    await phone.waitForTimeout(800);
    await phone.click('.usage .pane-tabs [role=tab]:has-text("Sessions")');
    await phone.waitForTimeout(800);
    s = await state(phone);
    check(s.hash === '#/overview' && s.cards.length >= 2, 'phone: Usage → Sessions lists the sessions', JSON.stringify(s));
    await shot(phone, '400-usage-sessions-390-dark');

    // A board problem (issue #403): amber text, the border still the connection's green, and a long text cut with "…".
    for (const [w, h] of [[1280, 800], [390, 844]] as const) {
      const t = await openProblemPage(b, page, w, h);
      await t.goto(`${page.origin}/${w === 1280 ? '#/waiting' : ''}`);
      await t.waitForTimeout(1500);
      s = await state(t);
      check(s.board?.text === LONG_BOARD, `problem at ${w} px: the chip carries the long board text`, JSON.stringify(s.board));
      check(s.board?.ink === s.amber && s.amber !== s.plainInk, `problem at ${w} px: the chip's text is amber`, JSON.stringify([s.board, s.amber]));
      check(s.board?.color === s.green, `problem at ${w} px: its border stays the connection's green`, JSON.stringify([s.board, s.green]));
      check(s.oneRow && (s.board?.right ?? Infinity) <= s.sidebarRight, `problem at ${w} px: the footer stays one row, inside the sidebar`, JSON.stringify([s.footer, s.board, s.sidebarRight]));
      check(s.board?.cut ?? false, `problem at ${w} px: the text ends in "…"`, JSON.stringify(s.board));
      check(s.board?.title.includes(LONG_BOARD) ?? false, `problem at ${w} px: the whole text is in the tooltip`, JSON.stringify(s.board));
      await shot(t, `403-board-problem-${w}-dark`);
      await t.click('.connection .board-chip:not(.usage-chip)');
      await t.waitForTimeout(800);
      s = await state(t);
      check((s.board?.on ?? false) && s.board?.ink === s.amber, `problem at ${w} px: still amber while the board is open`, JSON.stringify([s.board, s.amber]));
      await t.context().close();
    }

    // Disconnected: Ledung stops (the sessions first, so no host is left), and both pages' board chips turn red.
    await phone.goto(`${page.origin}/`);
    await tab.goto(`${page.origin}/#/usage`);
    await tab.waitForTimeout(1000);
    for (const id of managers.splice(0)) await page.api('POST', `sessions/${id}/stop`).catch(() => null);
    page.ws?.close();
    const gone = new Promise((r) => child.once('exit', r));
    child.kill();
    await gone;
    for (const [t, where] of [[tab, '1280 px'], [phone, '390 px']] as const) {
      await until(async () => (await state(t)).board?.title.startsWith('Disconnected') || (await state(t)).board?.title.startsWith('Connecting'), `the ${where} page noticing`, 20000).catch(() => null);
      s = await state(t);
      check(s.board?.color === s.red && /^(Disconnected|Connecting)/.test(s.board.title), `disconnected at ${where}: the board chip has the red border, the state in its tooltip`, JSON.stringify([s.board, s.red]));
      check(s.oneRow && !/Disconnected|Connecting/.test(s.footerText), `disconnected at ${where}: still one row, no words added`, JSON.stringify([s.footer, s.footerText]));
    }
    await shot(tab, '400-footer-disconnected-1280-dark');
    await shot(phone, '400-footer-disconnected-390-dark');
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
