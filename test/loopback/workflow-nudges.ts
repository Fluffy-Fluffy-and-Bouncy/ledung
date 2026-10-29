// Loopback for issue #405 (Martin, Ledung question #915: "a — File as written and start a worker"): a workflow's nudges
// file, on a throwaway Ledung on 4396. Not in CI (it starts a Ledung and a browser). playwright-core is given from
// outside, as for sidebar-usage.ts.
//
//   PLAYWRIGHT=/path/to/playwright-core [CHROMIUM=/path/to/chrome] [SHOTS=<folder>] node test/loopback/workflow-nudges.ts
//
// The sessions run a stand-in for Claude Code: nothing signs in or reaches Anthropic, and a context of 250k costs
// nothing. For each message it gets it reports one model call whose context is the message's "CTX:<tokens>" (in a 1000k
// window), and for a message with "PROBE" it then calls Ledung's own prompt hook, as Claude Code does before every turn,
// and writes down what the hook adds to the prompt. So the checks read the real hook's real answer for a context size
// the test chooses. Exit code 1 on any FAIL.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, failed, Page, repo, until } from './linked-pair.ts';
import { removeTemp } from '../temp.ts';

const work = path.join(repo, '.test', 'workflow-nudges-loopback');
const PORT = 4396;
const MODEL = 'claude-haiku-4-5';
// The issue's own example for the manager, and a runner-only one by title prefix.
const MANAGER_TEXT = 'Over 200k: bring your notes up to date and clear yourself.';
const RUNNER_TEXT = 'Runner over 300k: write your handoff and clear yourself.';
const NUDGES = { version: 1, nudges: [
  { role: 'manager', contextAtLeast: 200000, text: MANAGER_TEXT },
  { role: 'session', titlePrefix: 'win-run-', contextAtLeast: 300000, text: RUNNER_TEXT },
] };
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
  await tab.waitForTimeout(300);
  await tab.screenshot({ path: path.join(shots, `${name}.png`) });
}

/** The stand-in: answers the version and sign-in checks; per message a model call of CTX tokens, and on PROBE the prompt hook. */
function standIn(out: string, version: string): string {
  return `
import fs from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';
const a = process.argv.slice(2).join(' ');
if (a.includes('--version')) { console.log('${version} (Claude Code)'); process.exit(0); }
if (a.includes('auth status')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
const OUT = ${JSON.stringify(out)};
let hook = null, label = 'unlabelled', probes = 0;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const textOf = (m) => typeof m.message?.content === 'string' ? m.message.content : (m.message?.content ?? []).map((c) => c.text ?? '').join('\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_request' && m.request?.subtype === 'initialize') {
    // Answered as Claude Code does, and an init with a session id, so the session stays live between messages.
    hook = m.request.hooks?.UserPromptSubmit?.[0]?.hookCallbackIds?.[0] ?? null;
    send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { commands: [], models: [], account: {}, output_style: 'default', available_output_styles: [] } } });
    send({ type: 'system', subtype: 'init', session_id: crypto.randomUUID(), model: '${MODEL}', cwd: process.cwd(), tools: [], mcp_servers: [], permissionMode: 'default', apiKeySource: 'none', claude_code_version: '${version}' });
  }
  if (m.type === 'control_response' && String(m.response?.request_id).startsWith('probe-')) {
    fs.writeFileSync(OUT + '/' + label + '-' + m.response.request_id.slice(6) + '.json', JSON.stringify(m.response));
  }
  if (m.type !== 'user') return;
  const text = textOf(m);
  label = /LABEL:([\\w-]+)/.exec(text)?.[1] ?? label;
  const ctx = Number(/CTX:(\\d+)/.exec(text)?.[1] ?? 40000);
  const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: ctx - 2000, cache_creation_input_tokens: 1000 };
  send({ type: 'assistant', parent_tool_use_id: null, session_id: 'fake', message: { id: 'msg_fake_' + process.pid + '_' + Date.now(), model: '${MODEL}', role: 'assistant', content: [{ type: 'text', text: 'Standing by.' }], usage } });
  send({ type: 'result', subtype: 'success', num_turns: 1, is_error: false, result: 'Standing by.', session_id: 'fake', modelUsage: { '${MODEL}': { contextWindow: 1000000 } } });
  if (!text.includes('PROBE')) return;
  const n = ++probes;
  // After Ledung has recorded the call, as Claude Code calls the hook before the next turn.
  setTimeout(() => send({ type: 'control_request', request_id: 'probe-' + n, request: { subtype: 'hook_callback', callback_id: hook,
    input: { hook_event_name: 'UserPromptSubmit', prompt: 'probe ' + n, session_id: 'fake', transcript_path: '', cwd: process.cwd() } } }), 1500);
});
setInterval(() => {}, 1 << 30);
`;
}

async function main(): Promise<void> {
  removeTemp(work);
  const b = await browser();
  const data = path.join(work, 'data');
  const out = path.join(work, 'probes');
  const process_ = path.join(work, 'process');
  for (const d of [data, out, process_]) fs.mkdirSync(d, { recursive: true });
  for (const f of ['lead.md', 'worker.md']) fs.writeFileSync(path.join(process_, f), '# A throwaway process\n');
  const nudgesFile = path.join(process_, 'nudges.json');
  fs.writeFileSync(nudgesFile, JSON.stringify(NUDGES, null, 2));
  const sdk = JSON.parse(fs.readFileSync(path.join(repo, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')) as { claudeCodeVersion: string };
  const fake = path.join(work, 'fake-claude.mjs');
  fs.writeFileSync(fake, standIn(out, sdk.claudeCodeVersion));
  // On Windows Ledung takes a .exe or an npm shim to a script for Claude Code, so the stand-in gets a shim there.
  const program = process.platform === 'win32' ? path.join(work, 'claude.cmd') : fake;
  if (process.platform === 'win32') fs.writeFileSync(program, '@ECHO off\r\nnode "%~dp0\\fake-claude.mjs" %*\r\n');
  // Outside this repository, so the sessions show no branch of it.
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-nudges-')));
  for (const p of ['Orchard', 'Lantern']) fs.mkdirSync(path.join(real, 'projects', p), { recursive: true });
  // Orchard follows the workflow with the nudges file; Lantern one without it (the key left out).
  const wf = { folder: process_, managerFile: 'lead.md', sessionFile: 'worker.md', projectConfig: 'CFG.md' };
  fs.writeFileSync(path.join(work, 'config.json'), JSON.stringify({
    port: PORT, userName: 'Martin', remoteControl: false, claudeExecutable: program, browseRoots: [real],
    workflows: [{ name: 'nudged', ...wf, nudgesFile: 'nudges.json' }, { name: 'plain', ...wf }],
    projects: [
      { name: 'Orchard', runner: 'local', path: path.join(real, 'projects', 'Orchard'), workflow: { name: 'nudged' } },
      { name: 'Lantern', runner: 'local', path: path.join(real, 'projects', 'Lantern'), workflow: { name: 'plain' } },
    ],
  }, null, 2));
  const log = fs.createWriteStream(path.join(work, 'ledung.log'));
  const child: ChildProcess = spawn(process.execPath, [path.join(repo, 'src', 'main.ts'), '--no-open'], {
    cwd: work, env: { ...process.env, LEDUNG_CONFIG: path.join(work, 'config.json'), LEDUNG_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const s of [child.stdout!, child.stderr!]) s.on('data', (d: Buffer) => { output += d.toString(); log.write(d); });
  const page = new Page(PORT, data);
  const started: string[] = [];
  try {
    await until(() => output.includes('Ledung is running at'), `the Ledung on ${PORT}`);
    await page.open();
    const ok = async (what: string, call: Promise<{ status: number; json: any }>) => {
      const r = await call;
      if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)}`);
      return r.json;
    };
    for (const p of ['Orchard', 'Lantern']) await ok(`start the manager of ${p}`, page.api('POST', `projects/${p}/manager`, { text: `LABEL:${p.toLowerCase()}-manager` }));
    const projects = await ok('projects', page.api('GET', 'projects')) as { name: string; managerId: string | null }[];
    const manager = projects.find((p) => p.name === 'Orchard')!.managerId!;
    const plainManager = projects.find((p) => p.name === 'Lantern')!.managerId!;
    started.push(manager, plainManager);
    const session = async (label: string, title: string) => {
      const s = await ok(`start ${title}`, page.api('POST', 'sessions', { project: 'Orchard', text: `LABEL:${label}` })) as { id: string };
      started.push(s.id);
      await ok(`rename ${title}`, page.api('POST', `sessions/${s.id}/rename`, { title }));
      return s.id;
    };
    const runner = await session('runner', 'win-run-20261029-day');
    const other = await session('other', 'fix-1941');

    /** Sends a message with a context size and a probe, and returns what the hook added to that prompt. */
    const n: Record<string, number> = {};
    const probe = async (id: string, label: string, ctx: number): Promise<string> => {
      // The stand-in ends each turn at once; a message to a busy session would wait for it anyway.
      await new Promise((r) => setTimeout(r, 1000));
      n[label] = (n[label] ?? 0) + 1;
      await ok(`message ${label}`, page.api('POST', `sessions/${id}/messages`, { text: `PROBE CTX:${ctx}` }));
      const file = path.join(out, `${label}-${n[label]}.json`);
      await until(() => fs.existsSync(file), `${label}'s probe ${n[label]}`, 20000);
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      return String(r.response?.hookSpecificOutput?.additionalContext ?? `(no context: ${JSON.stringify(r)})`);
    };
    const lineAfter = (text: string, line: string) => text.split('\n')[text.split('\n').indexOf(line) + 1] ?? null;

    let t = await probe(manager, 'orchard-manager', 250_000);
    check(lineAfter(t, 'Your context: 250k of 1000k tokens.') === MANAGER_TEXT, 'manager at 250k: the nudge is the line right under "Your context"', JSON.stringify(t));
    check(!t.includes(RUNNER_TEXT), "manager at 250k: not the runners' nudge", JSON.stringify(t));
    t = await probe(manager, 'orchard-manager', 200_000);
    check(lineAfter(t, 'Your context: 200k of 1000k tokens.') === MANAGER_TEXT, 'manager at exactly 200k: the nudge', JSON.stringify(t));
    t = await probe(manager, 'orchard-manager', 150_000);
    check(t.includes('Your context: 150k of 1000k tokens.') && !t.includes(MANAGER_TEXT), 'manager under 200k again (as after a clear): the line is gone', JSON.stringify(t));

    t = await probe(runner, 'runner', 350_000);
    check(lineAfter(t, 'Your context: 350k of 1000k tokens.') === RUNNER_TEXT && !t.includes(MANAGER_TEXT), 'win-run- session at 350k: only its nudge', JSON.stringify(t));
    t = await probe(runner, 'runner', 250_000);
    check(!t.includes(RUNNER_TEXT), 'win-run- session at 250k: under its threshold, none', JSON.stringify(t));
    t = await probe(other, 'other', 350_000);
    check(t.includes('Your context: 350k of 1000k tokens.') && !t.includes(RUNNER_TEXT) && !t.includes(MANAGER_TEXT), 'another session at 350k: no nudge', JSON.stringify(t));

    t = await probe(plainManager, 'lantern-manager', 250_000);
    check(t.includes('Your context: 250k of 1000k tokens.') && !t.includes(MANAGER_TEXT) && !/nudge/i.test(t), 'a workflow without the key: the prompt has no nudge and no warning', JSON.stringify(t));

    // The page: Usage → Sessions with each session's context in the prompt line's form.
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    const tab = await ctx.newPage();
    await tab.goto(`${page.origin}/login?token=${page.token}`);
    await tab.goto(`${page.origin}/#/overview`);
    await tab.waitForTimeout(1500);
    const cards = await tab.evaluate(() => [...document.querySelectorAll('.usage .overview-card')].map((c) => ({
      title: c.querySelector('.overview-title')?.textContent?.trim() ?? '', facts: c.querySelector('.overview-facts')?.textContent ?? '',
    }))) as { title: string; facts: string }[];
    const card = (title: string) => cards.find((c) => c.title.endsWith(title))?.facts ?? '';
    check(card('win-run-20261029-day').includes('context 25% · 250k of 1000k'), 'Usage → Sessions: the runner at 250k shows "250k of 1000k"', JSON.stringify(cards));
    check(card('fix-1941').includes('context 35% · 350k of 1000k'), 'Usage → Sessions: another session at 350k shows "350k of 1000k"', JSON.stringify(cards));
    check(cards.filter((c) => /context \d+% · \d+k of 1000k/.test(c.facts)).length === 4, 'Usage → Sessions: all four sessions show their size', JSON.stringify(cards));
    await shot(tab, '405-usage-sessions-1280-dark');
    const phone = await (await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' })).newPage();
    await phone.goto(`${page.origin}/login?token=${page.token}`);
    await phone.goto(`${page.origin}/#/overview`);
    await phone.waitForTimeout(1500);
    await shot(phone, '405-usage-sessions-390-dark');

    // A bad file: told on the next prompt, once, with no nudges; told again when the problem changes; fine once fixed.
    fs.writeFileSync(nudgesFile, '{ "version": 1, "nudges": [ ');
    t = await probe(manager, 'orchard-manager', 250_000);
    check(t.includes(`The workflow's nudges file ${nudgesFile} is not valid JSON`) && t.includes('No nudges are shown until it is fixed. Tell whoever you ask (ask_user) once.') && !t.includes(MANAGER_TEXT),
      'invalid file: the manager is told, asked to report it, and gets no nudge', JSON.stringify(t));
    t = await probe(manager, 'orchard-manager', 250_000);
    check(!t.includes('nudges file') && !t.includes(MANAGER_TEXT), 'invalid file: not told again on the next prompt', JSON.stringify(t));
    t = await probe(runner, 'runner', 350_000);
    check(t.includes('is not valid JSON') && t.includes('No nudges are shown until it is fixed.') && !t.includes('Tell whoever you ask'), 'invalid file: a session is told, but not asked to report it', JSON.stringify(t));
    fs.rmSync(nudgesFile);
    t = await probe(manager, 'orchard-manager', 250_000);
    check(t.includes(`The workflow's nudges file ${nudgesFile} was not found.`), 'missing file: a changed problem is told', JSON.stringify(t));
    fs.writeFileSync(nudgesFile, JSON.stringify(NUDGES));
    t = await probe(manager, 'orchard-manager', 250_000);
    check(lineAfter(t, 'Your context: 250k of 1000k tokens.') === MANAGER_TEXT && !t.includes('nudges file'), 'fixed file: the nudge is back, with no warning, without a restart', JSON.stringify(t));
  } finally {
    await b.close();
    // The hosts outlive Ledung by design: stop the sessions first, so nothing is left running.
    for (const id of started) await page.api('POST', `sessions/${id}/stop`).catch(() => null);
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
