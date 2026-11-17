// The desktop app's loopback check (issue #358): loads the real ../main.ts in Electron, against a throwaway Ledung
// named by LEDUNG_CONFIG and LEDUNG_DATA_DIR, checks the window from inside and quits. Prints `PROBE {json}` lines;
// every observation the PR relies on is checked here, and a check that fails prints `"event":"fail"` and makes the
// exit code 1 (test review of PR #366, finding 1). 0 means every check held; 2 means it refused to run.
// Never point it at a real Ledung: the "notrunning" and "stopped" phases start and stop the Ledung of that config.
// Opening the default browser is intercepted and recorded, so nothing opens on the screen.
//
//   PROBE_PHASE=attach      a Ledung runs: signed in, address, settings, permissions, refused navigation and
//                           windows, links; saves the device list for "again"
//   PROBE_PHASE=again       a second start: still signed in, the same devices as after "attach"
//   PROBE_PHASE=notrunning  none runs: the "not running" page; the probe starts one, presses Retry, page loads
//   PROBE_PHASE=stopped     the probe starts one, the app attaches, the probe stops it and reloads: the "not
//                           running" page again; it starts it again, presses Retry, page loads
//
// Run from desktop/: `LEDUNG_CONFIG=… LEDUNG_DATA_DIR=… PROBE_PHASE=attach npx electron probe`. macOS and Linux
// only for now: it reads command lines with `ps` (code review of PR #366, Minor 3).
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
const refused = process.platform === 'win32'
  ? 'Windows has no ps to read command lines with; run this on macOS or Linux'
  : !process.env.LEDUNG_CONFIG || !process.env.LEDUNG_DATA_DIR
    ? 'LEDUNG_CONFIG and LEDUNG_DATA_DIR must both name a throwaway Ledung'
    : port === undefined || port === DEFAULT_PORT ? `the config's port is ${port ?? 'unreadable'}; use a test port, never the real Ledung's` : null;
const origin = `http://127.0.0.1:${port}`;
/** The device list "attach" saved, for "again" to compare with: in the throwaway's data folder. */
const devicesFile = path.join(dataDir(), 'desktop-probe-devices.json');
let failed = false;
const external: string[] = [];
(shell as { openExternal: (url: string) => Promise<void> }).openExternal = async (url: string) => {
  external.push(url);
};
const out = (event: string, data: unknown = {}) => console.log('PROBE ' + JSON.stringify({ phase, event, data }));
/** A check the PR relies on: a failing one is printed and makes the run exit 1. */
function expect(holds: boolean, what: string, seen?: unknown): void {
  if (holds) return;
  failed = true;
  out('fail', { what, seen });
}
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
async function waitForCore(): Promise<void> {
  for (let i = 0; i < 60 && token() === null; i++) await sleep(500);
  await sleep(3000);
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

/** Signed in at Ledung's own address, locked down, no token anywhere; returns the device ids. */
async function signedIn(w: BrowserWindow): Promise<string[]> {
  await sleep(2500);
  const wc = w.webContents;
  // Not in Electron's types, but on every WebContents: the preferences the page really runs with.
  const prefs = (wc as unknown as { getLastWebPreferences(): Record<string, unknown> }).getLastWebPreferences();
  const state = await api(w, 'state');
  const devices = await api(w, 'devices');
  const ids = ((devices.body?.devices ?? []) as { id: string }[]).map((d) => d.id).sort();
  const cookies = await wc.session.cookies.get({ url: origin, name: 'ledung_auth' });
  const t = token();
  const commandLines = execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const history = wc.navigationHistory.getAllEntries().map((e) => e.url);
  const sidebar = await page(w, `!!document.querySelector('nav, aside, .sidebar')`);
  const report = {
    url: wc.getURL(), history: history.map((u) => u.replace(/\?.*/, '?…')), title: wc.getTitle(), windows: BrowserWindow.getAllWindows().length,
    apiState: state.status, devicesState: devices.status, sidebar, devices: ids.map((id) => id.slice(0, 8)),
    cookie: cookies.map((c) => ({ httpOnly: c.httpOnly, sameSite: c.sameSite, isToken: c.value === t })),
    prefs: { contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration },
    browserOpened: [...external],
  };
  out('signed-in', report);
  expect(wc.getURL() === `${origin}/`, 'the address is Ledung\'s own', wc.getURL());
  expect(report.windows === 1, 'one window', report.windows);
  expect(state.status === 200 && devices.status === 200, 'the page is signed in (its data requests answered)', [state.status, devices.status]);
  expect(sidebar === true, 'the sidebar shows');
  expect(ids.length > 0, 'Ledung lists the app as a device');
  expect(prefs.contextIsolation === true && prefs.sandbox === true && prefs.nodeIntegration === false, 'the page is sandboxed and isolated', report.prefs);
  expect(cookies.length === 1 && cookies[0]!.httpOnly === true && cookies[0]!.sameSite === 'strict', 'one httpOnly, SameSite strict sign-in cookie', report.cookie);
  // No token anywhere, and the probes could see one (test review of PR #366, finding 2): the token was read, and the
  // same command-line scan finds this app's own binary.
  expect(t !== null, 'the throwaway Ledung\'s token was read');
  expect(commandLines.includes(process.execPath), 'the command-line scan sees this app', process.execPath);
  expect(t !== null && history.length > 0 && !history.some((u) => u.includes(t)), 'no address the window visited holds the token');
  expect(t !== null && !commandLines.includes(t), 'no command line holds the token');
  return ids;
}

/** Notifications and clipboard writes allowed for Ledung's page, anything else refused (code review, Minor 2). */
async function permissions(w: BrowserWindow): Promise<void> {
  const seen = await page(w, `(async () => ({
    notification: await Notification.requestPermission(),
    clipboard: (await navigator.permissions.query({ name: 'clipboard-write' })).state,
    location: (await navigator.permissions.query({ name: 'geolocation' })).state,
    camera: (await navigator.permissions.query({ name: 'camera' })).state,
  }))()`);
  out('permissions', seen);
  expect(seen.notification === 'granted', 'notifications are allowed', seen.notification);
  expect(seen.clipboard === 'granted', 'clipboard writes are allowed', seen.clipboard);
  expect(seen.location === 'denied' && seen.camera === 'denied', 'location and camera are refused', [seen.location, seen.camera]);
}

async function notRunningPage(): Promise<BrowserWindow> {
  const w = await showing('file:');
  const text = (await page(w, `document.body.innerText`)).replace(/\s+/g, ' ');
  const retryLink = await page(w, `document.querySelector('a.button')?.getAttribute('href') ?? null`);
  out('not-running', { text, retryLink });
  expect(text.includes('Ledung is not running'), 'the page says "Ledung is not running"', text);
  expect(retryLink === '#retry' && text.includes('Retry'), 'the page has its Retry button', retryLink);
  return w;
}
async function retry(w: BrowserWindow): Promise<string[]> {
  await page(w, `document.querySelector('a.button').click(); 1`);
  out('retry-pressed');
  return signedIn(await showing(`${origin}/`));
}

async function run(): Promise<void> {
  let core: ChildProcess | null = null;
  try {
    out('ready', { electron: process.versions.electron, node: process.versions.node, port });
    if (phase === 'attach' || phase === 'again') {
      const w = await showing(`${origin}/`);
      const ids = await signedIn(w);
      expect(external.length === 0, 'nothing opened in the browser at start', [...external]);
      if (phase === 'attach') {
        fs.writeFileSync(devicesFile, JSON.stringify(ids));
        await permissions(w);
        const opened = await page(w, `[window.open('https://github.com/example/pr/1') === null, window.open('/api/state') === null]`);
        await sleep(500);
        await page(w, `location.href = 'https://example.com/away'; 1`);
        await sleep(1500);
        const navigation = { openGaveNothing: opened, urlAfter: w.webContents.getURL(), browserOpened: [...external], windows: BrowserWindow.getAllWindows().length };
        out('navigation', navigation);
        expect(opened[0] === true && opened[1] === true, 'no new window, for an outside or an own address', opened);
        expect(navigation.urlAfter === `${origin}/` && navigation.windows === 1, 'the window stayed on Ledung', navigation.urlAfter);
        expect(JSON.stringify(navigation.browserOpened) === JSON.stringify(['https://github.com/example/pr/1', 'https://example.com/away']),
          'both outside addresses went to the browser, the own one did not', navigation.browserOpened);
        external.length = 0;
        // A new-tab link, clicked as a person would, as the page's links to pull requests are.
        const link = 'https://github.com/Fluffy-Fluffy-and-Bouncy/ledung/pull/1';
        await page(w, `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(link)}; a.target = '_blank'; a.rel = 'noreferrer noopener'; document.body.append(a); a.click(); a.remove(); return 1; })()`);
        await sleep(1000);
        const blank = { browserOpened: [...external], urlAfter: w.webContents.getURL(), windows: BrowserWindow.getAllWindows().length };
        out('blank-link', blank);
        expect(blank.browserOpened.length === 1 && blank.browserOpened[0] === link && blank.urlAfter === `${origin}/` && blank.windows === 1,
          'the clicked link went to the browser and the window stayed', blank);
      } else {
        let before: string[] | null = null;
        try {
          before = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
        } catch {
          // No "attach" run first.
        }
        out('devices', { afterAttach: before?.map((id) => id.slice(0, 8)) ?? null, now: ids.map((id) => id.slice(0, 8)) });
        expect(before !== null, 'an "attach" run saved its device list first');
        expect(JSON.stringify(before) === JSON.stringify(ids), 'a second start added no device', { before, now: ids });
      }
    } else if (phase === 'notrunning') {
      const w = await notRunningPage();
      expect((await page(w, `document.body.innerText`)).includes(`port ${port}`), 'the reason names the port tried');
      core = startCore();
      await waitForCore();
      await retry(w);
    } else if (phase === 'stopped') {
      core = startCore();
      await waitForCore();
      // The app looked before the Ledung was up: Retry from the "not running" page, or it found it already.
      const first = await showing('');
      if (first.webContents.getURL().startsWith('file:')) await retry(first);
      else await signedIn(first);
      await stopCore(core);
      core = null;
      win()!.webContents.reload();
      const w = await notRunningPage();
      expect((await page(w, `document.body.innerText`)).includes('did not load'), 'the reason says the page did not load');
      core = startCore();
      await sleep(4000);
      await retry(w);
    } else {
      expect(false, `no phase named ${phase}`);
    }
  } catch (e) {
    out('error', { message: (e as Error).message });
    failed = true;
  }
  if (core) await stopCore(core);
  await win()?.webContents.session.cookies.flushStore();
  out('done', { passed: !failed });
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
