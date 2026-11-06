// A capped owner's sends to the admin's own computers (issue #176), end to end as shipped: a real relay, the admin's
// real Ledung on it through RemoteLink and its Tunnel (main.ts's wiring, nothing overridden), and the capped owner's
// Ledung calling it through the relay's passthrough listener, TLS ending in the admin's Ledung. The relay is told who
// the stream comes from by that Ledung, and the Ledung hears which senders are capped and refuses the file (test
// review of PR #179, finding 1: no other test ran the seam from Tunnel through RemoteLink to the server). Its own file:
// the EXERCISED line is logged once per run of the relay module.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { hashSecret, parseRelayConfig, Relay, writeUsage } from '../relay/relay.ts';
import { parseConfig } from '../src/config.ts';
import { RemoteLink } from '../src/remote/link.ts';
import { relayCapSenderSentence } from '../src/remote/tunnel.ts';
import { keyFor, LinkedNodes, until } from './linked-nodes.ts';
import { freePort } from './free-port.ts';
import { removeTemp } from './temp.ts';
import { HANG_MS } from './limits.ts';

const nodes = new LinkedNodes();
const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
  await nodes.close();
});

const MINE = 'secret of the admin\'s own computer 0123456789';
const PROXY_SIGNATURE = Buffer.from('\r\n\r\n\0\r\nQUIT\n', 'latin1');
/** A PROXY v2 header for TCP over IPv4 from 203.0.113.7, as the proxy in front of the relay sends it. */
const PROXY = Buffer.concat([PROXY_SIGNATURE, Buffer.from([0x21, 0x11, 0, 12, 203, 0, 113, 7, 10, 0, 0, 2, 0xc8, 0x22, 0x20, 0xfb])]);

test('ledung#176: through RemoteLink and its tunnel, the admin\'s Ledung tells the relay who a linked call comes from, and refuses a capped sender\'s file', { timeout: HANG_MS }, async () => {
  const bob = await nodes.ledung('bob-e2e.files.test');
  const mine = await nodes.ledung('mine-e2e.files.test');
  await nodes.link(bob, mine, 'Bob');

  // Bob is past his cap from the start, and Martin is the admin's own owner, as the relay's byte counts keep them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-capsend-e2e-'));
  cleanup.push(() => removeTemp(dir));
  const usage = path.join(dir, 'relay.usage.json');
  const today = new Date().toISOString().slice(0, 10);
  writeUsage(usage, { owners: [{ owner: 'Bob', cap: 10, days: { [today]: 1000 } }], admin: 'Martin', logged: today });
  const lines: string[] = [];
  const config = parseRelayConfig({
    port: await freePort(), passthroughPort: await freePort(), bind: '127.0.0.1',
    agents: [
      { name: 'mine', owner: 'Martin', host: mine.name, secretSha256: hashSecret(MINE), tls: 'passthrough' },
      { name: 'bobpc', owner: 'Bob', host: bob.name, secretSha256: hashSecret('secret of bob\'s computer 0123456789'), tls: 'passthrough' },
    ],
  });
  const relay = new Relay(config, (line) => lines.push(line), { usage });
  const port = await relay.listen();
  cleanup.push(() => relay.close());

  // The admin's Ledung on the relay as main.ts puts it there: RemoteLink with the config's "remote".
  const remote = parseConfig({ remote: { relay: `ws://127.0.0.1:${port}`, name: 'mine', publicName: mine.name, secret: MINE, tls: 'required' } }).remote;
  const link = new RemoteLink({ server: mine.server, dir: mine.dir, configured: remote, log: () => {} });
  cleanup.push(() => link.stop());
  link.start();
  await until(() => relay.connected().includes('mine'), 'the admin\'s Ledung to connect');

  // Bob's Ledung posts a file to the admin's through the relay: TLS to the admin's Ledung, with Bob's link key.
  const post = () => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = https.request({
      method: 'POST', path: '/link/file?kind=png', host: mine.name,
      createConnection: () => {
        const raw = net.connect(config.passthroughPort!, '127.0.0.1');
        raw.write(PROXY);
        return tls.connect({ socket: raw, servername: mine.name, ca: mine.cert, ALPNProtocols: ['http/1.1'] });
      },
      headers: { Host: mine.name, 'Content-Type': 'application/octet-stream', 'Content-Length': 100, Authorization: `Bearer ${keyFor(bob, mine)}` },
    }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end(Buffer.alloc(100));
  });
  await until(async () => (await post()).status === 429, 'the admin\'s Ledung to hear Bob\'s computer is capped and refuse');
  const refused = await post();
  assert.deepEqual([refused.status, JSON.parse(refused.body).error], [429, relayCapSenderSentence(capResets())], 'refused with the sender sentence');
  // The relay was told by the admin's Ledung, through its tunnel, that the stream came from Bob's computer.
  await until(() => lines.some((l) => /EXERCISED #176 relay throttled a capped owner's stream to the admin's own computer$/.test(l)), `the relay to mark the stream (${lines.join(' | ')})`);
});

/** The first of next month, UTC: when the relay says the cap resets. */
function capResets(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}
