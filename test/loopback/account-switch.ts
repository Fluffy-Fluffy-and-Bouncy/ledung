// Loopback for issue #395: changing a project's or chats' account switches its running sessions, in a real Ledung and
// browser, on a throwaway Ledung on 4397. Not in CI (it starts a Ledung, session hosts and a browser). playwright-core
// is given from outside, as for sidebar-account.ts.
//
//   PLAYWRIGHT=/path/to/playwright-core [CHROMIUM=/path/to/chrome] [SHOTS=<folder>] node test/loopback/account-switch.ts
//
// The accounts are made up, with empty sign-in folders, and the sessions run a stand-in for Claude Code: it says the
// sign-in folder it was given ("signed-out" reads as signed out), answers each message with the account it runs on,
// and holds a turn open for "SLOW:<seconds>". Nothing signs in or reaches Anthropic. Exit code 1 on any FAIL.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, failed, Page, repo, until } from './linked-pair.ts';
import { removeTemp } from '../temp.ts';

const work = path.join(repo, '.test', 'account-switch-loopback');
const PORT = 4397;
type Tab = any;

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
  await tab.waitForTimeout(400);
  await tab.screenshot({ path: path.join(shots, `${name}.png`) });
}

/** The stand-in for Claude Code (see the top). */
function standIn(version: string): string {
  return `
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
const argv = process.argv.slice(2);
const a = argv.join(' ');
const dir = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? '';
const account = dir ? path.basename(dir) : 'default';
if (a.includes('--version')) { console.log('${version} (Claude Code)'); process.exit(0); }
if (a.includes('auth status')) { console.log(JSON.stringify({ loggedIn: account !== 'signed-out', authMethod: 'claude.ai' })); process.exit(0); }
// The conversation it resumes keeps its id, as Claude Code's does.
const sid = argv.find((x) => x.startsWith('--resume='))?.slice(9) ?? crypto.randomUUID();
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const textOf = (m) => typeof m.message?.content === 'string' ? m.message.content : (m.message?.content ?? []).map((c) => c.text ?? '').join('\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_request' && m.request?.subtype === 'initialize') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [], models: [], account: {}, output_style: 'default', available_output_styles: [] } } });
    send({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-4-5', cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'default', apiKeySource: 'none', claude_code_version: '${version}' });
    return;
  }
  if (m.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
    return;
  }
  if (m.type !== 'user') return;
  const text = textOf(m);
  const slow = Number(/SLOW:(\\d+)/.exec(text)?.[1] ?? 0);
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const reply = 'Running on the account "' + account + '".';
  send({ type: 'assistant', parent_tool_use_id: null, session_id: sid, message: { id: 'msg_' + process.pid + '_' + Date.now(), model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'text', text: slow ? 'Working on it (' + slow + ' s)…' : reply }], usage } });
  setTimeout(() => {
    if (slow) send({ type: 'assistant', parent_tool_use_id: null, session_id: sid, message: { id: 'msg_' + process.pid + '_' + Date.now(), model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'text', text: 'Done. ' + reply }], usage } });
    send({ type: 'result', subtype: 'success', num_turns: 1, is_error: false, result: reply, session_id: sid, modelUsage: { 'claude-haiku-4-5': { contextWindow: 200000 } } });
  }, slow * 1000);
});
`;
}

function startLedung(dir: string, data: string): ChildProcess & { output: () => string } {
  const log = fs.createWriteStream(path.join(dir, 'ledung.log'), { flags: 'a' });
  const child = spawn(process.execPath, [path.join(repo, 'src', 'main.ts'), '--no-open'], {
    cwd: dir, env: { ...process.env, LEDUNG_CONFIG: path.join(dir, 'config.json'), LEDUNG_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcess & { output: () => string };
  let out = '';
  for (const s of [child.stdout!, child.stderr!]) s.on('data', (d: Buffer) => { out += d.toString(); log.write(d); });
  child.output = () => out;
  return child;
}

async function stopLedung(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const gone = new Promise((r) => child.once('exit', r));
  child.kill();
  await gone;
}

async function main(): Promise<void> {
  removeTemp(work);
  const b = await browser();
  const data = path.join(work, 'data');
  fs.mkdirSync(data, { recursive: true });
  const sdk = JSON.parse(fs.readFileSync(path.join(repo, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')) as { claudeCodeVersion: string };
  fs.writeFileSync(path.join(work, 'fake-claude.mjs'), standIn(sdk.claudeCodeVersion));
  // On Windows Ledung takes a .exe or an npm shim to a script for Claude Code, so the stand-in gets a shim there.
  const program = process.platform === 'win32' ? path.join(work, 'claude.cmd') : path.join(work, 'fake-claude.mjs');
  if (process.platform === 'win32') fs.writeFileSync(program, '@ECHO off\r\nnode "%~dp0\\fake-claude.mjs" %*\r\n');
  else fs.chmodSync(program, 0o755);
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-account-switch-')));
  const orchard = path.join(real, 'projects', 'Orchard');
  fs.mkdirSync(orchard, { recursive: true });
  fs.writeFileSync(path.join(work, 'config.json'), JSON.stringify({ port: PORT, userName: 'Simon', remoteControl: false, claudeExecutable: program, browseRoots: [real], chats: { folder: real }, projects: [] }, null, 2));
  let child = startLedung(work, data);
  const page = new Page(PORT, data);
  const started: string[] = [];
  try {
    await until(() => child.output().includes('Ledung is running at'), `the Ledung on ${PORT}`);
    await page.open();
    const ok = async (what: string, call: Promise<{ status: number; json: any }>) => {
      const r = await call;
      if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)}`);
      return r.json;
    };
    // Past the first start's Welcome screen, as "Set up by hand instead" does.
    await ok('set up by hand', page.api('POST', 'setup', { action: 'leave' }));
    const addAccount = (name: string) => ok(`add account ${name}`, page.api('POST', 'accounts', { name, configDir: path.join(real, 'logins', name) }));
    for (const name of ['work', 'personal']) await addAccount(name);
    const orchardSettings = (account: string) => ({ name: 'Orchard', runner: 'local', path: orchard, account });
    await ok('add Orchard', page.api('POST', 'projects', orchardSettings('work')));
    const setAccount = (account: string) => ok(`Orchard on ${account}`, page.api('POST', 'projects/Orchard', orchardSettings(account)));
    const session = async (id: string) => (await ok('sessions', page.api('GET', 'state'))).sessions.find((s: any) => s.id === id);
    const events = async (id: string) => {
      const r = await ok('messages', page.api('GET', `sessions/${id}/messages?limit=500`));
      return ((Array.isArray(r) ? r : r.messages) as any[]).filter((m) => m.kind === 'event').map((m) => m.data.text as string);
    };
    const status = async (id: string) => (await session(id))?.status;
    /**
     * On this account, quiet, and done switching: the account is written before Claude Code is up again. A resumed
     * session not spoken to since is "starting" (shown as Ready), as quiet as an idle one.
     */
    const on = async (id: string, account: string) => {
      const s = await session(id);
      return s?.account === account && !s.accountSwitch && ['idle', 'starting'].includes(s.status) && (await events(id)).at(-1) === `Now on the account "${account}".` || null;
    };

    // The manager, done with its turn; a worker in a long one.
    await ok('start the manager', page.api('POST', 'projects/Orchard/manager', { text: 'Where do things stand?' }));
    const mgr = (await ok('projects', page.api('GET', 'projects'))).find((p: any) => p.name === 'Orchard').managerId as string;
    started.push(mgr);
    await until(async () => (await status(mgr)) === 'idle' || null, 'the manager idle');
    const worker = (await ok('start a worker', page.api('POST', 'sessions', { project: 'Orchard', text: 'SLOW:600 Build the cart page.' }))).id as string;
    started.push(worker);
    await ok('rename', page.api('POST', `sessions/${worker}/rename`, { title: 'Build the cart page' }));
    await until(async () => (await status(worker)) === 'running' || null, 'the worker running');
    check((await session(mgr)).account === 'work' && (await session(worker)).account === 'work', 'both start on "work"');

    // The account changes: the quiet manager switches at once, the busy worker waits.
    await setAccount('personal');
    await until(async () => on(mgr, 'personal'), 'the manager on "personal"');
    check((await events(mgr)).includes('Now on the account "personal".'), 'the manager\'s chat says "Now on the account "personal"."', JSON.stringify(await events(mgr)));
    let w = await session(worker);
    check(w.account === 'work' && w.status === 'running' && w.accountSwitch?.to === 'personal' && !w.accountSwitch.failed, 'the worker, mid-turn, keeps "work" and waits to switch', JSON.stringify(w));
    await new Promise((r) => setTimeout(r, 3000));
    check((await status(worker)) === 'running', 'its turn is not interrupted');

    const open = async (width: number, height: number, id: string): Promise<Tab> => {
      const ctx = await b.newContext({ viewport: { width, height }, colorScheme: 'dark' });
      const tab = await ctx.newPage();
      await tab.goto(`${page.origin}/login?token=${page.token}`);
      await tab.goto(`${page.origin}/#/s/${id}`);
      await tab.waitForTimeout(1500);
      // The first start's two offers (desktop icon, counting users), answered once, so the shots show the session.
      for (const name of ['No', 'OK']) {
        const button = tab.getByRole('button', { name, exact: true });
        if (await button.count()) await button.first().click();
      }
      await tab.waitForTimeout(300);
      return tab;
    };
    const desk = await open(1280, 800, worker);
    const phone = await open(390, 844, worker);
    for (const tab of [desk, phone]) {
      const notice = await tab.locator('.account-switch').first().textContent();
      check(/Switches to personal when this turn ends/.test(notice ?? ''), `${tab === desk ? 'desk' : 'phone'}: the header says "Switches to personal when this turn ends"`, notice ?? '');
    }
    const tooltip = await desk.locator('.session-item', { hasText: 'Build the cart page' }).first().getAttribute('title');
    check((tooltip ?? '').startsWith('Switches to personal when this turn ends'), 'the sidebar row\'s tooltip says so first', tooltip ?? '');
    await shot(desk, '395-pending-1280-dark');
    await shot(phone, '395-pending-390-dark');

    // Switch now: asks first.
    for (const tab of [desk, phone]) await tab.locator('.account-switch button', { hasText: 'Switch now' }).click();
    const asked = await desk.locator('.account-switch').first().textContent();
    check(/This stops what it's doing now and resumes it on personal/.test(asked ?? ''), 'Switch now asks first', asked ?? '');
    await shot(desk, '395-switch-now-confirm-1280-dark');
    await shot(phone, '395-switch-now-confirm-390-dark');
    check((await status(worker)) === 'running', 'nothing stopped while it asks');
    await desk.locator('.account-switch button.primary', { hasText: 'Switch now' }).click();
    await until(async () => on(worker, 'personal'), 'the worker on "personal"');
    w = await session(worker);
    check(!w.accountSwitch, 'the switch is done', JSON.stringify(w));
    const we = await events(worker);
    check(we.some((t: string) => t.startsWith('Stopped by Simon to switch to the account "personal" now')) && we.includes('Now on the account "personal".'), 'its chat says it was stopped to switch, then "Now on …"', JSON.stringify(we));
    await ok('message the worker', page.api('POST', `sessions/${worker}/messages`, { text: 'Which account are you on?' }));
    await until(async () => (await status(worker)) === 'idle' || null, 'the worker answered');
    await desk.waitForTimeout(1500);
    const said = await desk.locator('.messages').last().textContent().catch(() => '');
    check((said ?? '').includes('Running on the account "personal".'), 'the same conversation goes on, now on "personal"', (said ?? '').slice(-300));
    await phone.waitForTimeout(500);
    await shot(desk, '395-now-on-1280-dark');
    await shot(phone, '395-now-on-390-dark');

    // A switch that fails: the manager stays on "personal", once. The account is added only now, so the sign-in
    // banner it brings is in the failed switch's screenshots alone.
    await addAccount('signed-out');
    await setAccount('signed-out');
    await until(async () => (await session(mgr))?.accountSwitch?.failed || null, 'the failed switch', 60000);
    const m = await session(mgr);
    check(m.account === 'personal' && ['idle', 'starting'].includes(m.status), 'the manager stays on "personal", running', JSON.stringify(m));
    const me = await events(mgr);
    check(me.some((t: string) => t.startsWith('Couldn\'t switch to the account "signed-out", so it stays on the account "personal"')), 'its chat says it couldn\'t switch', JSON.stringify(me.slice(-4)));
    const mdesk = await open(1280, 800, mgr);
    const mphone = await open(390, 844, mgr);
    const failedNotice = await mdesk.locator('.account-switch.failed').first().textContent();
    check(/Couldn't switch to signed-out; still on personal\./.test(failedNotice ?? ''), 'the header says it couldn\'t switch, with Try again', failedNotice ?? '');
    await shot(mdesk, '395-failed-1280-dark');
    await shot(mphone, '395-failed-390-dark');
    const tries = (await events(mgr)).filter((t: string) => t === 'Session resumed.').length;
    // The minute check runs in the meantime: no second try.
    await new Promise((r) => setTimeout(r, 65000));
    check((await events(mgr)).filter((t: string) => t === 'Session resumed.').length === tries, 'no second try on its own in a minute');

    // Chats: those on the chats' account switch with it.
    await ok('chats on work', page.api('POST', 'account-choices', { chats: 'work' }));
    const chat = (await ok('a chat', page.api('POST', 'chats-new', { text: 'Hello' }))).id as string;
    started.push(chat);
    await until(async () => (await status(chat)) === 'idle' || null, 'the chat idle');
    check((await session(chat)).account === 'work', 'the chat starts on "work"');
    await ok('chats on personal', page.api('POST', 'account-choices', { chats: 'personal' }));
    await until(async () => on(chat, 'personal'), 'the chat on "personal"');
    check((await events(chat)).includes('Now on the account "personal".'), 'the chat says "Now on …"');

    // Restart Ledung with a switch waiting: it happens afterwards.
    await setAccount('work');
    await until(async () => on(mgr, 'work'), 'the manager back on "work"');
    await ok('a long turn', page.api('POST', `sessions/${mgr}/messages`, { text: 'SLOW:25 Check the board.' }));
    // Under way in Claude Code (its first words are in), not only sent.
    await until(async () => JSON.stringify(await ok('messages', page.api('GET', `sessions/${mgr}/messages?limit=20`))).includes('Working on it (25 s)') || null, 'the manager busy');
    await setAccount('personal');
    check((await session(mgr)).accountSwitch?.to === 'personal', 'waits to switch before the restart');
    page.ws?.close();
    await stopLedung(child);
    child = startLedung(work, data);
    await until(() => child.output().includes('Ledung is running at'), `the Ledung on ${PORT} again`);
    await page.open();
    check((await session(mgr)).accountSwitch?.to === 'personal' && (await session(mgr)).account === 'work', 'after the restart it still waits', JSON.stringify(await session(mgr)));
    await until(async () => on(mgr, 'personal'), 'the manager on "personal" after its turn', 90000);
    check(!(await session(mgr)).accountSwitch, 'and switched once its turn ended');
  } finally {
    await b.close();
    // The hosts outlive Ledung by design: stop the sessions first, so nothing is left running.
    for (const id of started) await page.api('POST', `sessions/${id}/stop`).catch(() => null);
    page.ws?.close();
    await stopLedung(child);
    removeTemp(real);
  }
  console.log(failed() ? `${failed()} FAILED` : 'all passed');
  process.exitCode = failed() ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
