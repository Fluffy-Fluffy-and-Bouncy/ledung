// Two throwaway Ledungs, "mac" on 4397 and "pc" on 4398, behind a real relay, for the linked-computer loopbacks
// (issue #245): link-pair.ts (linking), link-managers.ts (managers across computers) and frame-renewal.ts (#286).
//
// All on 127.0.0.1: the relay from relay/relay.ts with both Ledungs as passthrough agents, a PROXY v2 front standing
// in for caddy-l4 (as acme-pebble.ts), and two Ledungs started from src/main.ts with their own config and data in
// `work`, each holding a self-signed certificate for its public name and trusting the other's through
// NODE_EXTRA_CA_CERTS; "linkVia" sends their link calls to the front. Everything started here is stopped by `close`,
// by its own process handle; nothing else is touched.
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { hashSecret, parseRelayConfig, Relay } from '../../relay/relay.ts';
import { selfSigned } from '../self-signed.ts';
import { removeTemp } from '../temp.ts';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const P = { relay: 51880, passthrough: 51844, front: 51843 };

let failures = 0;
export function check(ok: boolean, what: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
}
export const failed = () => failures;

export async function until<T>(get: () => T | Promise<T>, what: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const portOpen = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

function proxyHeader(from: net.Socket): Buffer {
  const ip = (a: string) => Buffer.from((a.replace(/^::ffff:/, '') || '127.0.0.1').split('.').map(Number));
  const body = Buffer.alloc(12);
  ip(from.remoteAddress ?? '127.0.0.1').copy(body, 0);
  ip(from.localAddress ?? '127.0.0.1').copy(body, 4);
  body.writeUInt16BE(from.remotePort ?? 0, 8);
  body.writeUInt16BE(from.localPort ?? 0, 10);
  return Buffer.concat([Buffer.from('0d0a0d0a000d0a515549540a', 'hex'), Buffer.from([0x21, 0x11, 0, 12]), body]);
}

/** One Ledung's local page: the page key from its live connection, then API calls as the page makes them. */
export class Page {
  readonly port: number;
  readonly data: string;
  pageKey = '';
  ws: WebSocket | null = null;
  constructor(port: number, data: string) {
    this.port = port;
    this.data = data;
  }
  get origin() { return `http://127.0.0.1:${this.port}`; }
  get token() { return fs.readFileSync(path.join(this.data, 'auth-token'), 'utf8').trim(); }
  async open(): Promise<void> {
    this.ws?.close();
    this.pageKey = '';
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`, { headers: { Cookie: `ledung_auth=${this.token}`, Origin: this.origin } });
    this.ws.on('message', (d) => { const e = JSON.parse(String(d)); if (e.pageKey) this.pageKey = e.pageKey; });
    await until(() => this.pageKey, 'the page key', 10_000);
  }
  async api(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${this.origin}/api/${route}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Cookie: `ledung_auth=${this.token}`, Origin: this.origin, 'Content-Type': 'application/json', 'X-Ledung-Page': this.pageKey },
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
}

export type Ledung = ChildProcess & { output: () => string };

/**
 * Starts the relay, the front and both Ledungs, and waits for both tunnels. `projects` gives each Ledung's config
 * projects (folders are made in `work`). `close` stops everything it started.
 */
export async function startPair(work: string, projects: { mac?: unknown[]; pc?: unknown[] } = {}) {
  for (const port of [...Object.values(P), 4397, 4398]) if (await portOpen(port)) throw new Error(`Port ${port} is in use; this loopback starts everything itself.`);
  removeTemp(work);
  fs.mkdirSync(path.join(work, 'shots'), { recursive: true });
  const children: ChildProcess[] = [];
  const side = (n: 'mac' | 'pc', port: number) => ({ n, port, data: path.join(work, `data-${n}`), name: `${n}.l.test`, secret: crypto.randomBytes(16).toString('hex'), pair: selfSigned(`${n}.l.test`) });
  const A = side('mac', 4397);
  const B = side('pc', 4398);
  for (const s of [A, B]) {
    fs.mkdirSync(path.join(s.data, 'remote'), { recursive: true });
    fs.writeFileSync(path.join(s.data, 'remote', 'tls.key'), s.pair.key, { mode: 0o600 });
    fs.writeFileSync(path.join(s.data, 'remote', 'tls.crt'), s.pair.cert, { mode: 0o600 });
  }
  // Both test certificates, trusted by both Ledungs as a public CA's would be.
  const trust = path.join(work, 'trust.pem');
  fs.writeFileSync(trust, A.pair.cert + B.pair.cert);

  const relay = new Relay(parseRelayConfig({
    port: P.relay, bind: '127.0.0.1', passthroughPort: P.passthrough, passthroughFrom: ['127.0.0.0/8'],
    agents: [A, B].map((s) => ({ name: s.n, owner: 'test', host: s.name, secretSha256: hashSecret(s.secret), tls: 'passthrough' })),
  }), (line) => fs.appendFileSync(path.join(work, 'relay.log'), `${line}\n`));
  await relay.listen();
  const seen = { clear: false, bytes: 0 };
  const front = net.createServer((client) => {
    const upstream = net.connect(P.passthrough, '127.0.0.1', () => {
      upstream.write(proxyHeader(client));
      // What the server sees must be TLS only: no route, no code, no key in clear.
      client.on('data', (d: Buffer) => {
        seen.bytes += d.length;
        if (d.includes('/link/') || d.includes('Bearer')) seen.clear = true;
      });
      client.pipe(upstream).pipe(client);
    });
    for (const s of [client, upstream]) s.on('error', () => { client.destroy(); upstream.destroy(); });
  });
  await new Promise<void>((r) => front.listen(P.front, '127.0.0.1', r));

  const run = (s: typeof A): Ledung => {
    const list = (projects[s.n] ?? []) as { path?: string; name: string }[];
    for (const p of list) if (p.path) fs.mkdirSync(p.path, { recursive: true });
    const config = {
      port: s.port, userName: 'Martin', projects: list,
      remote: { relay: `ws://127.0.0.1:${P.relay}`, name: s.n, publicName: s.name, secret: s.secret, tls: 'required', linkVia: `127.0.0.1:${P.front}` },
    };
    fs.writeFileSync(path.join(work, `config-${s.n}.json`), JSON.stringify(config, null, 2));
    const log = fs.createWriteStream(path.join(work, `ledung-${s.n}.log`), { flags: 'a' });
    const child = spawn(process.execPath, [path.join(repo, 'src', 'main.ts'), '--no-open'], {
      cwd: work, env: { ...process.env, LEDUNG_CONFIG: path.join(work, `config-${s.n}.json`), LEDUNG_DATA_DIR: s.data, NODE_EXTRA_CA_CERTS: trust }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    for (const st of [child.stdout!, child.stderr!]) st.on('data', (d: Buffer) => { text += d.toString(); log.write(d); });
    children.push(child);
    return Object.assign(child, { output: () => text });
  };
  const stop = async (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const gone = new Promise((r) => child.once('exit', r));
    child.kill();
    await gone;
  };
  const ledungs = { mac: run(A), pc: run(B) };
  const pages = { mac: new Page(4397, A.data), pc: new Page(4398, B.data) };
  const close = async () => {
    pages.mac.ws?.close();
    pages.pc.ws?.close();
    for (const c of [...children].reverse()) await stop(c);
    front.close();
    await relay.close();
  };
  try {
    await until(() => ledungs.mac.output().includes('Remote: connected') && ledungs.pc.output().includes('Remote: connected'), 'both tunnels');
    await pages.mac.open();
    await pages.pc.open();
  } catch (e) {
    await close();
    throw e;
  }
  /** Stops one Ledung, or starts it again with the same config and data. */
  const off = (n: 'mac' | 'pc') => stop(ledungs[n]);
  const on = async (n: 'mac' | 'pc') => {
    ledungs[n] = run(n === 'mac' ? A : B);
    await until(() => ledungs[n].output().includes('Remote: connected'), `the ${n} again`);
    await pages[n].open();
  };
  const pcOff = () => off('pc');
  const pcOn = () => on('pc');
  return { pages, ledungs, seen, close, pcOff, pcOn, off, on, work, front: P.front };
}

/** Links the PC to the Mac through the pages, as Settings does: a code on the Mac, pasted on the PC as "Mac". */
export async function link(pages: { mac: Page; pc: Page }): Promise<void> {
  const code = await pages.mac.api('POST', 'links-code', {});
  const joined = await pages.pc.api('POST', 'links-join', { code: code.json.code, name: 'Mac' });
  if (joined.status !== 200) throw new Error(`linking failed: ${JSON.stringify(joined.json)}`);
}
