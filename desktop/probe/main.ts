// The desktop app's loopback check (issue #358): loads the real ../main.ts in Electron, against a throwaway Ledung
// named by LEDUNG_CONFIG and LEDUNG_DATA_DIR, checks the window from inside and quits. Prints `PROBE {json}` lines.
// Never point it at a real Ledung: the "notrunning" and "stopped" phases start and stop the Ledung of that config.
// Opening the default browser is intercepted and recorded, so nothing opens on the screen.
//
//   PROBE_PHASE=attach      a Ledung runs: signed in, address, settings, refused navigation and windows, links
//   PROBE_PHASE=again       a second start: still signed in, with the device the first start made
//   PROBE_PHASE=notrunning  none runs: the "not running" page; the probe starts one, presses Retry, page loads
//   PROBE_PHASE=stopped     the probe starts one, the app attaches, the probe stops it and reloads: the "not
//                           running" page again; it starts it again, presses Retry, page loads
//
// Run from desktop/: `LEDUNG_CONFIG=… LEDUNG_DATA_DIR=… PROBE_PHASE=attach npx electron probe`
import { app, BrowserWindow, shell } from 'electron';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidatePorts, configFiles, dataDir, DEFAULT_PORT } from '../attach.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const clone = path.resolve(here, '..', '..');
const phase = process.env.PROBE_PHASE ?? 'attach';
const port = candidatePorts(configFiles())[0];
// Only a throwaway Ledung: without both settings the app would find the real one (self-check round 2, finding 1).
// Checked before the app is loaded, since it attaches as soon as Electron is ready.
const refused = !process.env.LEDUNG_CONFIG || !process.env.LEDUNG_DATA_DIR
  ? 'LEDUNG_CONFIG and LEDUNG_DATA_DIR must both name a throwaway Ledung'
  : port === undefined || port === DEFAULT_PORT ? `the config's port is ${port ?? 'unreadable'}; use a test port, never the real Ledung's` : null;
let failed = false;
const external: string[] = [];
(shell as { openExternal: (url: string) => Promise<void> }).openExternal = async (url: string) => {
  external.push(url);
};
const out = (event: string, data: unknown = {}) => console.log('PROBE ' + JSON.stringify({ phase, event, data }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const token = () => {
  try {
    return fs.readFileSync(path.join(dataDir(), 'auth-token'), 'utf8').trim();
  } catch {
    return null;
  }
};

/** The config's Ledung on plain Node from PATH, never Electron's binary and with no ELECTRON_* setting (#361). */
function startCore(): ChildProcess {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('ELECTRON_')) env[k] = v;
  const core = spawn('node', [path.join(clone, 'src', 'main.ts'), '--no-open'], { cwd: clone, env, stdio: 'ignore' });
  out('core-started', { pid: core.pid });
  return core;
}
async function stopCore(core: ChildProcess): Promise<void> {
  core.kill('SIGTERM');
  await new Promise((r) => (core.exitCode !== null ? r(null) : core.once('exit', r)));
  out('core-stopped', { pid: core.pid });
}

const win = () => BrowserWindow.getAllWindows()[0];
/** Waits for the window to show `prefix` and finish loading. */
async function showing(prefix: string): Promise<BrowserWindow> {
  for (let i = 0; i < 150; i++) {
    const w = win();
    const url = w?.webContents.getURL();
    if (w && url && !w.webContents.isLoading() && url.startsWith(prefix)) return w;
    await sleep(200);
  }
  throw new Error(`the window never showed ${prefix} (it shows ${win()?.webContents.getURL()})`);
}
const page = (w: BrowserWindow, js: string) => w.webContents.executeJavaScript(js);
const api = (w: BrowserWindow, route: string) =>
  page(w, `fetch('/api/${route}').then(async (r) => ({ status: r.status, body: r.status === 200 ? await r.json() : null }))`);

async function signedIn(w: BrowserWindow): Promise<void> {
  await sleep(2500);
  const wc = w.webContents;
  // Not in Electron's types, but on every WebContents: the preferences the page really runs with.
  const prefs = (wc as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences();
  const devices = await api(w, 'devices');
  const cookies = await wc.session.cookies.get({ url: `http://127.0.0.1:${port}`, name: 'ledung_auth' });
  const t = token();
  const commandLines = execFileSync('ps', process.platform === 'win32' ? [] : ['-axww', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const history = wc.navigationHistory.getAllEntries().map((e) => e.url);
  out('signed-in', {
    url: wc.getURL(), history: history.map((u) => u.replace(/\?.*/, '?…')), title: wc.getTitle(), windows: BrowserWindow.getAllWindows().length,
    apiState: (await api(w, 'state')).status, sidebar: await page(w, `!!document.querySelector('nav, aside, .sidebar')`),
    devices: devices.body?.devices?.map((d: { id: string; name: string }) => `${d.name} ${d.id.slice(0, 8)}`) ?? devices.status,
    cookie: cookies.map((c) => ({ httpOnly: c.httpOnly, sameSite: c.sameSite, isToken: c.value === t })),
    tokenInAnyUrl: t !== null && history.some((u) => u.includes(t)), tokenInAnyCommandLine: t !== null && commandLines.includes(t),
    prefs: { contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration },
    browserOpened: [...external],
  });
}

async function notRunningPage(): Promise<BrowserWindow> {
  const w = await showing('file:');
  out('not-running', { text: (await page(w, `document.body.innerText`)).replace(/\s+/g, ' ') });
  return w;
}
async function retry(w: BrowserWindow): Promise<void> {
  await page(w, `document.querySelector('a.button').click(); 1`);
  out('retry-pressed');
  await signedIn(await showing(`http://127.0.0.1:${port}/`));
}

async function run(): Promise<void> {
  let core: ChildProcess | null = null;
  try {
    out('ready', { electron: process.versions.electron, node: process.versions.node, port });
    if (phase === 'attach' || phase === 'again') {
      const w = await showing(`http://127.0.0.1:${port}/`);
      await signedIn(w);
      if (phase === 'attach') {
        const opened = await page(w, `[window.open('https://github.com/example/pr/1') === null, window.open('/api/state') === null]`);
        await sleep(500);
        await page(w, `location.href = 'https://example.com/away'; 1`);
        await sleep(1500);
        out('navigation', { openGaveNothing: opened, urlAfter: w.webContents.getURL(), browserOpened: [...external], windows: BrowserWindow.getAllWindows().length });
        external.length = 0;
        // A new-tab link, clicked as a person would, as the page's links to pull requests are.
        await page(w, `(() => { const a = document.createElement('a'); a.href = 'https://github.com/Fluffy-Fluffy-and-Bouncy/ledung/pull/1'; a.target = '_blank'; a.rel = 'noreferrer noopener'; document.body.append(a); a.click(); a.remove(); return 1; })()`);
        await sleep(1000);
        out('blank-link', { browserOpened: [...external], urlAfter: w.webContents.getURL(), windows: BrowserWindow.getAllWindows().length });
      }
    } else if (phase === 'notrunning') {
      const w = await notRunningPage();
      core = startCore();
      for (let i = 0; i < 60 && token() === null; i++) await sleep(500);
      await sleep(3000);
      await retry(w);
    } else if (phase === 'stopped') {
      core = startCore();
      for (let i = 0; i < 60 && token() === null; i++) await sleep(500);
      await sleep(3000);
      // The app looked before the Ledung was up: Retry from the "not running" page, or it found it already.
      const first = await showing('');
      if (first.webContents.getURL().startsWith('file:')) await retry(first);
      else await signedIn(first);
      await stopCore(core);
      core = null;
      win()!.webContents.reload();
      const w = await notRunningPage();
      core = startCore();
      await sleep(4000);
      await retry(w);
    }
  } catch (e) {
    out('error', { message: (e as Error).message });
    failed = true;
  }
  if (core) await stopCore(core);
  await win()?.webContents.session.cookies.flushStore();
  await sleep(500);
  app.exit(failed ? 1 : 0);
}

if (refused) {
  out('error', { message: `refused: ${refused}` });
  app.exit(2);
} else {
  // Not awaited: Electron holds its ready event until a top-level await in the entry module settles.
  void import('../main.ts').then(() => app.whenReady()).then(run);
}
