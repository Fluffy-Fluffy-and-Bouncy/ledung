// Linked test Ledungs (issue #273), as in linked.test.ts: each with a public name and a test certificate, reaching
// the others the way the relay would hand it a stream, over their tunnel connection with TLS ending in that Ledung.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import WebSocket from 'ws';
import { parseConfig } from '../src/config.ts';
import { LedungServer } from '../src/server/server.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { computerList, type ComputerSetting } from '../src/shared/computers.ts';
import type { ServerEvent } from '../src/shared/protocol.ts';
import { selfSigned } from './self-signed.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';

export const TOKEN = 'f'.repeat(64);
export const COOKIE = `ledung_auth=${TOKEN}`;


export interface Node { name: string; server: LedungServer; port: number; dir: string; cert: string; store: Store }

export class LinkedNodes {
  private readonly nodes = new Map<string, Node>();
  private readonly cleanup: (() => unknown)[] = [];
  clock = Date.now();
  readonly now = () => this.clock;

  async close(): Promise<void> {
    for (const fn of this.cleanup.reverse()) await fn();
  }

  /** TLS to a Ledung's public name over its tunnel; a name nobody holds: closed at once. */
  connect = (name: string): tls.TLSSocket => {
    const node = this.nodes.get(name);
    if (!node) {
      const dead = new Duplex({ read() {}, write: (_chunk, _enc, done) => done() });
      setImmediate(() => dead.destroy());
      return tls.connect({ socket: dead, servername: name });
    }
    return tls.connect({ socket: node.server.tunnelConnection(), servername: name, ca: node.cert, ALPNProtocols: ['http/1.1'] });
  };

  private readonly restarts = new Map<string, () => Promise<void>>();

  /** Restarts a Ledung as Restart Ledung would: a new server on the same database and data folder, memory gone. */
  restart(node: Node): Promise<void> {
    return this.restarts.get(node.name)!();
  }

  /** Takes a Ledung off the relay: calls to its public name fail as for a computer that is off. */
  offline(name: string): void {
    this.nodes.delete(name);
  }

  async ledung(name: string, computerSettings?: ComputerSetting[], waitingPollMs?: number): Promise<Node> {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-linked-'));
    const pair = selfSigned(name);
    fs.writeFileSync(path.join(dir, 'tls.key'), pair.key);
    fs.writeFileSync(path.join(dir, 'tls.crt'), pair.cert);
    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-web-'));
    fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
    const db = openDatabase(':memory:');
    const store = new Store(db);
    const start = async () => {
      const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port }), store, () => {}));
      const server = new LedungServer({
        port, token: TOKEN, store, manager, webRoot, publicName: name, tunnelTls: { dir, required: true }, now: this.now, linkConnect: this.connect,
        // As main.ts gives them: the config's tabs, and its list for the frames.
        computers: computerList(computerSettings ?? [], name, 'host'), ...(computerSettings ? { computerSettings } : {}),
        ...(waitingPollMs ? { waitingPollMs } : {}),
      });
      await server.listen();
      return server;
    };
    const node: Node = { name, server: await start(), port, dir, cert: pair.cert, store };
    this.restarts.set(name, async () => {
      await node.server.close();
      node.server = await start();
    });
    this.cleanup.push(() => node.server.close(), () => db.close(), () => removeTemp(dir), () => removeTemp(webRoot));
    this.nodes.set(name, node);
    return node;
  }

  /** The local page: its key from the live connection, its events as they come, and API calls with cookie and Origin. */
  async page(node: Node) {
    const origin = `http://127.0.0.1:${node.port}`;
    const ws = new WebSocket(`ws://127.0.0.1:${node.port}/ws`, { headers: { cookie: COOKIE, origin } });
    this.cleanup.push(() => ws.terminate());
    const events: ServerEvent[] = [];
    const key = await new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)).pageKey));
      ws.once('error', reject);
    });
    ws.on('message', (data) => events.push(JSON.parse(String(data)) as ServerEvent));
    const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> => {
      const res = await fetch(`${origin}/api/${route}`, {
        method, headers: { cookie: COOKIE, origin, 'content-type': 'application/json', 'x-ledung-page': key, ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    };
    return Object.assign(call, { key, events });
  }

  /** A paired device's open page through the public name: its page key. */
  async publicPage(node: Node, cookie: string): Promise<string> {
    const ws = new WebSocket(`wss://${node.name}/ws`, { createConnection: (() => this.connect(node.name)) as never, headers: { cookie, origin: `https://${node.name}` } });
    this.cleanup.push(() => ws.terminate());
    return new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)).pageKey));
      ws.once('error', reject);
    });
  }

  /** Links `a` and `b`: a link code made on `a`'s page, used on `b`'s, as Settings → Linked computers does. */
  async link(a: Node, b: Node, name?: string): Promise<void> {
    const code = (await (await this.page(a))('POST', 'links-code', {})).json.code;
    const joined = await (await this.page(b))('POST', 'links-join', { code, ...(name ? { name } : {}) });
    if (joined.status !== 200) throw new Error(`link failed: ${JSON.stringify(joined.json)}`);
  }

  /** One HTTPS request to a Ledung through its tunnel, as another computer, a phone or a stranger would send it. */
  viaTunnel(name: string, route: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const body = opts.body ?? '{}';
      const req = https.request({
        method: opts.method ?? 'POST', path: route, createConnection: () => this.connect(name),
        headers: { host: name, 'content-type': 'application/json', ...(opts.method === 'GET' ? {} : { 'content-length': Buffer.byteLength(body) }), ...opts.headers },
      }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
      });
      req.on('error', reject);
      if (opts.method === 'GET') req.end();
      else req.end(body);
    });
  }

  /** A plain request on a Ledung's local port (http.request: fetch drops a Host header it is given). */
  local(node: Node, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: node.port, method: opts.method ?? 'GET', path: opts.path, headers: { host: `127.0.0.1:${node.port}`, ...opts.headers } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end(opts.body);
    });
  }
}

/** The key `from` sends to `to`, from its links.json. */
export function keyFor(from: Node, to: Node): string {
  const saved = JSON.parse(fs.readFileSync(path.join(from.dir, 'links.json'), 'utf8')) as { links: { publicName: string; sendKey: string }[] };
  return saved.links.find((l) => l.publicName === to.name)!.sendKey;
}

export const directive = (res: { headers: http.IncomingHttpHeaders }, name: string): string | null =>
  String(res.headers['content-security-policy']).split('; ').find((d) => d.startsWith(`${name} `)) ?? null;

export async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
