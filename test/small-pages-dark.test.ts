// Ledung's small pages are dark (issue #481): the passkey sign page, the passkey set-up page, the not-signed-in /
// not-paired page and the pairing page all load one dark stylesheet, whose colours are the dark half of the main
// page's, and say color-scheme dark so a browser in a light system theme draws them dark too.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { parseConfig } from '../src/config.ts';
import { LedungServer } from '../src/server/server.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';

const ROOT = path.join(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'web', 'public');
const TOKEN = 'e'.repeat(64);
const MAC = 'mac.example.test';
const LINK = '<link rel="stylesheet" href="/small-page.css">';
const SCHEME = '<meta name="color-scheme" content="dark">';

let port = 0;
let server: LedungServer;
let store: Store;
let manager: SessionManager;
let dir: string;

before(async () => {
  port = await freePort();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-small-pages-'));
  const webRoot = path.join(dir, 'web');
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
  // The built page carries web/public as it is. A missing stylesheet fails the tests below, each on its own assert.
  if (fs.existsSync(path.join(PUBLIC, 'small-page.css'))) fs.copyFileSync(path.join(PUBLIC, 'small-page.css'), path.join(webRoot, 'small-page.css'));
  store = new Store(openDatabase(path.join(dir, 'ledung.db')));
  manager = refuseRealSignInStores(new SessionManager(parseConfig({ port, projects: [] }), store, () => {}));
  server = new LedungServer({ port, token: TOKEN, store, manager, webRoot, publicName: MAC });
  await server.listen();
});
after(async () => {
  await server.close();
  manager.detachAll();
  store.database.close();
  removeTemp(dir);
});

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
function request(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}
const pub = (p: string) => request({ path: p, headers: { host: MAC } });

/** A pairing code, made on this computer's open page as Settings → Phones makes it. */
async function newCode(): Promise<string> {
  const local = `ledung_auth=${TOKEN}`;
  const origin = `http://127.0.0.1:${port}`;
  const page = await new Promise<{ key: string; close(): void }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: local, origin } });
    ws.once('message', (data) => resolve({ key: JSON.parse(String(data)).pageKey, close: () => ws.close() }));
    ws.on('error', reject);
  });
  const made = await request({ method: 'POST', path: '/api/devices-pair', body: JSON.stringify({ kind: 'phone' }), headers: { cookie: local, origin, 'content-type': 'application/json', 'x-ledung-page': page.key } });
  page.close();
  assert.equal(made.status, 200, made.body);
  return new URL(JSON.parse(made.body).url).pathname.slice(3);
}

/** A custom property's value in a stylesheet's text; for a light-dark() pair, its dark half. */
function colour(css: string, name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  assert.ok(m, `${name} is in the stylesheet`);
  const value = (m[1] ?? '').trim();
  const pair = /^light-dark\(\s*[^,]+,\s*([^)]+)\)$/.exec(value);
  return (pair?.[1] ?? value).trim().toLowerCase();
}

test('the small pages\' stylesheet is dark, in the main page\'s dark colours', () => {
  const small = fs.readFileSync(path.join(PUBLIC, 'small-page.css'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'web', 'src', 'styles.css'), 'utf8');
  assert.match(small, /:root\s*\{[^}]*color-scheme:\s*dark;/);
  for (const name of ['--bg', '--panel', '--panel-2', '--text', '--muted', '--border', '--accent']) {
    assert.equal(colour(small, name), colour(main, name), `${name} is the main page's dark value`);
  }
  // The page itself, its text, buttons and fields take those colours.
  assert.match(small, /body\s*\{[^}]*background:\s*var\(--bg\);[^}]*color:\s*var\(--text\);/);
  assert.match(small, /button\s*\{[^}]*background:\s*var\(--panel-2\);/);
  assert.match(small, /input\s*\{[^}]*background:\s*var\(--panel\);/);
});

for (const file of ['sign.html', 'enrol.html']) {
  test(`${file} loads the dark stylesheet and says it is dark`, () => {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    assert.ok(html.includes(LINK), `${file} links the stylesheet`);
    assert.ok(html.includes(SCHEME), `${file} says color-scheme dark`);
  });
}

test('the not-signed-in page on this computer loads the dark stylesheet', async () => {
  const res = await request({ path: '/' });
  assert.equal(res.status, 401);
  assert.match(res.body, /Not signed in/);
  assert.ok(res.body.includes(LINK) && res.body.includes(SCHEME), res.body);
});

test('the not-paired page through the public name, with its pair-code form, loads the dark stylesheet', async () => {
  const res = await pub('/');
  assert.equal(res.status, 401);
  assert.match(res.body, /not paired/);
  assert.match(res.body, /<form method="get" action="\/pair">/);
  assert.ok(res.body.includes(LINK) && res.body.includes(SCHEME), res.body);
});

test('the pairing page of a link loads the dark stylesheet, and the stylesheet is served to a browser not yet paired', async () => {
  const code = await newCode();
  const form = await pub(`/p/${code}`);
  assert.equal(form.status, 200);
  assert.match(form.body, /Pair this device with Ledung/);
  assert.ok(form.body.includes(LINK) && form.body.includes(SCHEME), form.body);
  // A link no longer valid is the same page.
  const invalid = await pub('/p/NOTACODE');
  assert.equal(invalid.status, 403);
  assert.ok(invalid.body.includes(LINK), invalid.body);
  const css = await pub('/small-page.css');
  assert.equal(css.status, 200);
  assert.match(String(css.headers['content-type']), /^text\/css/);
  assert.match(css.body, /color-scheme:\s*dark/);
});
