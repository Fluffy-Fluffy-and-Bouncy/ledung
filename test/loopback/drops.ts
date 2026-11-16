// Loopback for issue #339 (Martin, 2026-11-16 14:44, question #912: "a — Copy it in and link the copy"): a file
// dropped or picked in a running session's message box that isn't an image Ledung sends is saved in the project under
// .ledung/drops and its path goes into the box; an image still goes in as an image; over 50 MB is refused and nothing
// is written; git sees nothing new. In a real browser on a throwaway Ledung on 4396. Not in CI (it starts a Ledung and
// a browser). playwright-core is given from outside, as for macros.ts.
//
//   PLAYWRIGHT=/path/to/playwright-core [CHROMIUM=/path/to/chrome] [SHOTS=<folder>] [LEDUNG_TEST_PORT=4396] node test/loopback/drops.ts
//
// The session runs a stand-in for Claude Code that answers once and then waits: nothing signs in or reaches
// Anthropic. Exit code 1 on any FAIL.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, failed, Page, repo, until } from './linked-pair.ts';
import { removeTemp } from '../temp.ts';

const work = path.join(repo, '.test', 'drops-loopback');
const PORT = Number(process.env.LEDUNG_TEST_PORT ?? 4396);
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

/** Drops files made in the page on the message box, as a drag from the desktop does: a dragover, then the drop. */
const drop = (tab: Tab, files: { name: string; type: string; text?: string; size?: number }[]) => tab.evaluate((list: typeof files) => {
  const dt = new DataTransfer();
  for (const f of list) dt.items.add(new File([f.size !== undefined ? new Uint8Array(f.size) : f.text ?? ''], f.name, { type: f.type }));
  const box = document.querySelector('.composer')!;
  box.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  box.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
}, files);
const boxText = (tab: Tab) => tab.evaluate(() => (document.querySelector('.composer textarea') as HTMLTextAreaElement).value) as Promise<string>;

async function main(): Promise<void> {
  removeTemp(work);
  const b = await browser();
  const data = path.join(work, 'data');
  fs.mkdirSync(data, { recursive: true });
  const sdk = JSON.parse(fs.readFileSync(path.join(repo, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')) as { claudeCodeVersion: string };
  const fake = path.join(work, 'fake-claude.mjs');
  fs.writeFileSync(fake, [
    "const a = process.argv.slice(2).join(' ');",
    `if (a.includes('--version')) { console.log('${sdk.claudeCodeVersion} (Claude Code)'); process.exit(0); }`,
    "if (a.includes('auth status')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }",
    "const id = 'msg_fake_' + process.pid + '_' + Date.now();",
    "console.log(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, session_id: 'fake', message: { id, model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'text', text: 'Ready.' }], usage: { input_tokens: 10, output_tokens: 10 } } }));",
    "console.log(JSON.stringify({ type: 'result', subtype: 'success', num_turns: 1, is_error: false, result: 'ok', session_id: 'fake', modelUsage: { 'claude-haiku-4-5': { contextWindow: 200000 } } }));",
    'setInterval(() => {}, 1 << 30);',
    '',
  ].join('\n'));
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-drops-')));
  const project = path.join(real, 'projects', 'Orchard');
  fs.mkdirSync(project, { recursive: true });
  const git = (...args: string[]) => spawnSync('git', args, { cwd: project, encoding: 'utf8' });
  git('init', '-q');
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
  const drops = path.join(project, '.ledung', 'drops');
  const kept = () => (fs.existsSync(drops) ? fs.readdirSync(drops).filter((f) => f !== '.gitignore').sort() : []);
  const two = (v: number) => String(v).padStart(2, '0');
  const now = new Date();
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  try {
    await until(() => out.includes('Ledung is running at'), `the Ledung on ${PORT}`);
    await page.open();
    // Past the first start's welcome: "Set up by hand instead".
    await ok('leave setup', page.api('POST', 'setup', { action: 'leave' }));
    await ok('add Orchard', page.api('POST', 'projects', { name: 'Orchard', runner: 'local', path: project }));
    const w = await ok('session', page.api('POST', 'sessions', { project: 'Orchard', text: 'Hello.' })) as { id: string };
    await new Promise((r) => setTimeout(r, 4000));
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    const tab = await ctx.newPage();
    await tab.goto(`${page.origin}/login?token=${page.token}`);
    await tab.goto(`${page.origin}/#/s/${w.id}`);
    await tab.waitForSelector('.composer textarea:not([disabled])');

    // --- A PDF dropped after some words: its path goes in at the caret, the file is in the project ---------------
    const pdf = '%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n';
    await tab.fill('.composer textarea', 'Please read');
    await drop(tab, [{ name: 'Spec sheet.pdf', type: 'application/pdf', text: pdf }]);
    const first = `.ledung/drops/${day}-Spec sheet.pdf`;
    await until(async () => (await boxText(tab)).includes('[file: '), 'the path in the box');
    check(await boxText(tab) === `Please read [file: ${first}]`, 'Done 1: the box says "Please read [file: .ledung/drops/<date>-Spec sheet.pdf]"', await boxText(tab));
    const saved = path.join(project, ...first.split('/'));
    check(fs.existsSync(saved) && fs.readFileSync(saved, 'latin1') === pdf, 'Done 1: the file is in the project folder with the same bytes', kept().join(', '));
    await shot(tab, '339-pdf-dropped-1280-dark');

    // --- The same again, and a file of no type: unique names, both in the box ---------------------------------
    await drop(tab, [{ name: 'Spec sheet.pdf', type: 'application/pdf', text: 'second' }, { name: 'notes', type: '', text: 'n' }]);
    await until(async () => (await boxText(tab)).includes(`${day}-notes]`), 'two more paths in the box');
    check(await boxText(tab) === `Please read [file: ${first}] [file: .ledung/drops/${day}-Spec sheet-2.pdf] [file: .ledung/drops/${day}-notes]`, 'Done 5: a name already taken gets a number', await boxText(tab));
    check(fs.readFileSync(saved, 'latin1') === pdf, 'Done 5: the first file is left as it was');

    // --- An image still goes in as an image --------------------------------------------------------------------
    const before = kept();
    const textBefore = await boxText(tab);
    const png = await tab.evaluate(() => new Promise<string>((resolve) => {
      const c = document.createElement('canvas');
      c.width = 4; c.height = 4;
      c.toBlob((blob) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsBinaryString(blob!); }, 'image/png');
    }));
    await tab.evaluate((bin: string) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(bin, (ch) => ch.charCodeAt(0))], 'shot.png', { type: 'image/png' }));
      const box = document.querySelector('.composer')!;
      box.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, png);
    await until(async () => (await tab.$$('.composer-images img')).length === 1, 'the image above the box');
    check(JSON.stringify(kept()) === JSON.stringify(before) && await boxText(tab) === textBefore, 'Done 2: an image goes in as an image, not saved and not linked', kept().join(', '));

    // --- Over 50 MB: refused, the limit named, nothing written --------------------------------------------------
    await drop(tab, [{ name: 'huge.mov', type: 'video/quicktime', size: 50 * 1024 * 1024 + 1 }]);
    await until(async () => (await tab.textContent('body'))?.includes('at most 50 MB'), 'the refusal');
    check(JSON.stringify(kept()) === JSON.stringify(before) && await boxText(tab) === textBefore, 'Done 3: nothing written, the box unchanged');
    await shot(tab, '339-too-large-1280-dark');

    // --- 📎 picks any file -------------------------------------------------------------------------------------
    const picked = path.join(work, 'picked.csv');
    fs.writeFileSync(picked, 'a,b\n1,2\n');
    await tab.setInputFiles('.composer input[type=file]', picked);
    await until(async () => (await boxText(tab)).includes(`${day}-picked.csv]`), 'the picked file in the box');
    check(fs.readFileSync(path.join(drops, `${day}-picked.csv`), 'utf8') === 'a,b\n1,2\n', '📎: a picked CSV is saved and linked as a drop is');

    // --- git sees nothing new; the EXERCISED line ran -----------------------------------------------------------
    const status = git('status', '--porcelain', '--untracked-files=all');
    check(status.status === 0 && status.stdout === '', 'Done 4: git status in the project shows nothing new', status.stdout + status.stderr);
    check(/EXERCISED #339 /.test(out), 'the EXERCISED #339 line is in Ledung\'s output');
    await ctx.close();
  } finally {
    await b.close();
    child.kill();
    // The session hosts carry the data folder on their command line.
    spawn('pkill', ['-f', data]);
    removeTemp(real);
  }
  console.log(failed() ? `${failed()} FAIL` : 'all PASS');
  process.exit(failed() ? 1 : 0);
}
await main();
