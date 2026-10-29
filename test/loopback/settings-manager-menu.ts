// Loopback for issue #366: the name colour pickers moved from a manager's ⚙ menu to its project's tab (Martin,
// 2026-10-28, Ledung question #325). Starts one Haiku manager on a throwaway Ledung, so it needs Claude Code signed in
// on this computer; not in CI. playwright-core is given from outside, as for settings-frame.ts.
//
//   PLAYWRIGHT=/path/to/playwright-core/index.mjs node test/loopback/settings-manager-menu.ts   # port 4396
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { check, failed, Page, repo, until } from './linked-pair.ts';
import { removeTemp } from '../temp.ts';

const dir = path.join(repo, '.test', 'settings-manager-menu-loopback');
removeTemp(dir);
const data = path.join(dir, 'data');
const proj = path.join(dir, 'haiku-check');
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 4396, userName: 'Martin', remoteControl: false,
  projects: [{ name: 'Haiku check', runner: 'local', path: proj, model: 'haiku' }] }, null, 2));
const child = spawn(process.execPath, [path.join(repo, 'src/main.ts'), '--no-open'], {
  cwd: dir, env: { ...process.env, LEDUNG_CONFIG: path.join(dir, 'config.json'), LEDUNG_DATA_DIR: data }, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
for (const s of [child.stdout!, child.stderr!]) s.on('data', (d: Buffer) => { out += d.toString(); });
if (!process.env.PLAYWRIGHT) throw new Error('Set PLAYWRIGHT to playwright-core (its index.mjs).');
const mod = await import(process.env.PLAYWRIGHT) as any;
const b = await (mod.chromium ?? mod.default.chromium).launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
try {
  await until(() => out.includes('Ledung is running at'), 'Ledung on 4396');
  const page = new Page(4396, data);
  await page.open();
  const started = await page.api('POST', `projects/${encodeURIComponent('Haiku check')}/manager`, { text: 'Reply with the single word OK.' });
  const id = started.json?.id;
  check(!!id, 'a Haiku manager started', id ? '' : JSON.stringify(started));
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const tab = await ctx.newPage();
  await tab.goto(`${page.origin}/login?token=${page.token}`);
  // The same probe finds the pickers where they are now, so finding none in the menu means none (test review of PR #379).
  const pickers = (where: any) => where.locator('[aria-label="Manager name colour"], .name-colours');
  await tab.goto(`${page.origin}/#/ps/${encodeURIComponent('Haiku check')}/look`);
  await tab.waitForTimeout(1200);
  check(await pickers(tab.locator('.settings-content')).count() > 0, "the probe finds the pickers in the project tab's Look");
  await tab.goto(`${page.origin}/#/s/${id}`);
  await tab.waitForTimeout(4000);
  await tab.getByRole('button', { name: 'Session settings' }).click();
  await tab.waitForTimeout(500);
  const menu = tab.locator('#session-menu');
  check(await menu.count() === 1, "the manager's ⚙ menu opens");
  check(await pickers(menu).count() === 0, "the manager's ⚙ menu has no name colour pickers");
  await page.api('POST', `sessions/${id}/stop`, {});
  await tab.waitForTimeout(1500);
} finally {
  await b.close();
  child.kill();
}
console.log(failed() ? `${failed()} FAILED` : 'all passed');
process.exitCode = failed() ? 1 : 0;
