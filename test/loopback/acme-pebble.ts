// Loopback test for issue #202 (docs/steps/relay-e2e.md, build plan step 4): a real Ledung gets its certificate from a
// real Pebble by TLS-ALPN-01 through the real relay, with the wait for the CAA record. Not in CI (CI has no Pebble).
//
//   SPIKE_DIR=.test/spike bash docs/steps/relay-e2e-spike/fetch.sh     # once: Pebble and its mock DNS, checksummed
//   node test/loopback/acme-pebble.ts                                  # LEDUNG_PORT=4398 by default
//
// Parts, all on 127.0.0.1: pebble-challtestsrv (the mock DNS, whose /add-caa sets CAA records), Pebble (resolving
// through it; its tlsPort is the "443" below), a small PROXY v2 front standing in for caddy-l4 on the server, the
// relay from relay/relay.ts with a passthrough agent, and a throwaway Ledung started from src/main.ts with its own
// config and data in .test/acme-loopback. Pebble never checks CAA (spike #199), so what is tested is Ledung's own
// lookup and its wait. Everything started here is stopped here, by its own process handle; nothing else is touched.
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { hashSecret, parseRelayConfig, Relay } from '../../relay/relay.ts';
import type { CertificateStatus, RemoteStatus } from '../../src/shared/protocol.ts';
import { removeTemp } from '../temp.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const spike = path.resolve(process.env.SPIKE_DIR ?? path.join(repo, '.test', 'spike'));
const work = path.join(repo, '.test', 'acme-loopback');
const exe = process.platform === 'win32' ? '.exe' : '';
// Outside the ranges Windows reserves on the development PC (spike #199: netsh ... excludedportrange).
const P = { dns: 51653, dnsMgmt: 51655, acme: 51600, acmeMgmt: 51601, pebbleHttp: 51681, front: 51643, passthrough: 51644, relay: 51680 };
const LEDUNG_PORT = Number(process.env.LEDUNG_PORT ?? 4398);
const NAME = 'pc.l.test';
const SECRET = crypto.randomBytes(16).toString('hex');
const minica = path.join(spike, 'dl-pebble', 'pebble.minica.pem');

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
}

const children: ChildProcess[] = [];
function start(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess & { output: () => string } {
  const log = fs.createWriteStream(path.join(work, `${name}.log`), { flags: 'a' });
  const child = spawn(cmd, args, { cwd: work, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  for (const s of [child.stdout!, child.stderr!]) s.on('data', (d: Buffer) => { text += d.toString(); log.write(d); });
  children.push(child);
  return Object.assign(child, { output: () => text });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise((r) => child.once('exit', r));
  child.kill();
  await gone;
}

async function until<T>(get: () => T | Promise<T>, what: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const portOpen = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

async function setCaa(issue: string | null): Promise<void> {
  const body = issue ? { host: `${NAME}.`, policies: [{ tag: 'issue', value: issue }] } : { host: `${NAME}.` };
  const res = await fetch(`http://127.0.0.1:${P.dnsMgmt}/${issue ? 'add-caa' : 'clear-caa'}`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`challtestsrv: ${res.status} ${await res.text()}`);
}

/** Pebble's root, from its management API (its own certificate is signed by minica). */
function pebbleRoot(): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(`https://127.0.0.1:${P.acmeMgmt}/roots/0`, { ca: fs.readFileSync(minica), servername: 'localhost' }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

/** The PROXY v2 header caddy-l4 sends before the phone's bytes (TCP over IPv4). */
function proxyHeader(from: net.Socket): Buffer {
  const ip = (a: string) => Buffer.from((a.replace(/^::ffff:/, '') || '127.0.0.1').split('.').map(Number));
  const body = Buffer.alloc(12);
  ip(from.remoteAddress ?? '127.0.0.1').copy(body, 0);
  ip(from.localAddress ?? '127.0.0.1').copy(body, 4);
  body.writeUInt16BE(from.remotePort ?? 0, 8);
  body.writeUInt16BE(from.localPort ?? 0, 10);
  return Buffer.concat([Buffer.from('0d0a0d0a000d0a515549540a', 'hex'), Buffer.from([0x21, 0x11, 0, 12]), body]);
}

/** A phone: TLS to the "443" with the name, trusting only Pebble's root, one GET. */
function phone(root: string): Promise<{ authorized: boolean; issuer: string; status: string }> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port: P.front, servername: NAME, ca: root, ALPNProtocols: ['http/1.1'] }, () => {
      const cn = s.getPeerCertificate().issuer?.CN ?? '';
      const issuer = Array.isArray(cn) ? cn.join(', ') : cn;
      s.write(`GET / HTTP/1.1\r\nHost: ${NAME}\r\nConnection: close\r\n\r\n`);
      let text = '';
      s.on('data', (d) => (text += d));
      s.on('end', () => resolve({ authorized: s.authorized, issuer, status: text.split('\r\n')[0] ?? '' }));
    });
    s.on('error', reject);
  });
}

/** What the Ledung page is told about the certificate, over its live connection, as Settings gets it. */
class PageView {
  certificate: CertificateStatus | undefined;
  private ws: WebSocket | null = null;
  async open(): Promise<void> {
    const token = fs.readFileSync(path.join(work, 'data', 'auth-token'), 'utf8').trim();
    const origin = `http://127.0.0.1:${LEDUNG_PORT}`;
    this.ws = new WebSocket(`ws://127.0.0.1:${LEDUNG_PORT}/ws`, { headers: { Cookie: `ledung_auth=${token}`, Origin: origin } });
    this.ws.on('message', (data) => {
      const event = JSON.parse(String(data)) as { type: string; remote?: RemoteStatus | null };
      if ((event.type === 'hello' || event.type === 'remote') && event.remote) this.certificate = event.remote.certificate;
    });
    await new Promise((resolve, reject) => { this.ws!.once('open', resolve); this.ws!.once('error', reject); });
  }
  close(): void {
    this.ws?.close();
  }
}

async function checkNow(): Promise<number> {
  const token = fs.readFileSync(path.join(work, 'data', 'auth-token'), 'utf8').trim();
  const origin = `http://127.0.0.1:${LEDUNG_PORT}`;
  const res = await fetch(`${origin}/api/certificate-check`, { method: 'POST', headers: { Cookie: `ledung_auth=${token}`, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  return res.status;
}

function startLedung() {
  return start('ledung', process.execPath, [path.join(repo, 'src', 'main.ts'), '--no-open'], {
    LEDUNG_CONFIG: path.join(work, 'config.json'), LEDUNG_DATA_DIR: path.join(work, 'data'),
    // Pebble's API certificate is signed by its own minica root (spike #199).
    NODE_EXTRA_CA_CERTS: minica,
  });
}

async function main(): Promise<void> {
  for (const f of [`dl-pebble/pebble${exe}`, `dl-challtestsrv/pebble-challtestsrv${exe}`]) {
    if (!fs.existsSync(path.join(spike, f))) throw new Error(`${path.join(spike, f)} is missing: run docs/steps/relay-e2e-spike/fetch.sh with SPIKE_DIR=${spike} first.`);
  }
  for (const port of [...Object.values(P), LEDUNG_PORT]) if (await portOpen(port)) throw new Error(`Port ${port} is in use; this test starts everything itself.`);
  removeTemp(work);
  fs.mkdirSync(path.join(work, 'data'), { recursive: true });

  // The mock DNS: every name is 127.0.0.1, and CAA records are what /add-caa sets.
  start('challtestsrv', path.join(spike, 'dl-challtestsrv', `pebble-challtestsrv${exe}`), ['-defaultIPv4', '127.0.0.1', '-defaultIPv6', '',
    '-dnsserver', `127.0.0.1:${P.dns}`, '-management', `127.0.0.1:${P.dnsMgmt}`, '-http01', '', '-https01', '', '-tlsalpn01', '', '-doh', '']);
  fs.writeFileSync(path.join(work, 'pebble.json'), JSON.stringify({ pebble: {
    listenAddress: `127.0.0.1:${P.acme}`, managementListenAddress: `127.0.0.1:${P.acmeMgmt}`,
    certificate: path.join(spike, 'dl-pebble', 'cert.pem'), privateKey: path.join(spike, 'dl-pebble', 'key.pem'),
    httpPort: P.pebbleHttp, tlsPort: P.front, ocspResponderURL: '', externalAccountBindingRequired: false,
  } }));
  start('pebble', path.join(spike, 'dl-pebble', `pebble${exe}`), ['-config', path.join(work, 'pebble.json'), '-dnsserver', `127.0.0.1:${P.dns}`],
    // AUTHZREUSE 100: an authorization still valid is always reused, as Let's Encrypt does for 30 days; Pebble's default
    // of 50 % made step 5 pass only every other run before the order handling was fixed for it.
    { PEBBLE_VA_NOSLEEP: '1', PEBBLE_WFE_NONCEREJECT: '0', PEBBLE_AUTHZREUSE: '100' });

  // The relay, with this Ledung as a passthrough agent, and the front that stands in for caddy-l4.
  const relay = new Relay(parseRelayConfig({
    port: P.relay, bind: '127.0.0.1', passthroughPort: P.passthrough, passthroughFrom: ['127.0.0.0/8'],
    agents: [{ name: 'pc', owner: 'test', host: NAME, secretSha256: hashSecret(SECRET), tls: 'passthrough' }],
  }));
  await relay.listen();
  let checkConnections = 0;
  const front = net.createServer((client) => {
    const upstream = net.connect(P.passthrough, '127.0.0.1', () => {
      upstream.write(proxyHeader(client));
      // Added with the pipe, not before: an earlier listener would read the ClientHello before the pipe is there.
      client.once('data', (d: Buffer) => { if (d.includes('acme-tls/1')) checkConnections++; });
      client.pipe(upstream).pipe(client);
    });
    for (const s of [client, upstream]) s.on('error', () => { client.destroy(); upstream.destroy(); });
  });
  await new Promise<void>((r) => front.listen(P.front, '127.0.0.1', r));

  fs.writeFileSync(path.join(work, 'config.json'), JSON.stringify({
    port: LEDUNG_PORT, projects: [],
    remote: { relay: `ws://127.0.0.1:${P.relay}`, name: 'pc', publicName: NAME, secret: SECRET, tls: 'required', acme: 'pebble',
      pebble: { directory: `https://127.0.0.1:${P.acme}/dir`, dns: `127.0.0.1:${P.dns}` } },
  }, null, 2));
  await until(() => portOpen(P.acme), 'Pebble');
  const root = await pebbleRoot();
  const remoteDir = path.join(work, 'data', 'remote');
  const page = new PageView();

  try {
    console.log('== 1. Start: account, then the wait for the CAA record ==');
    let ledung = startLedung();
    await until(() => ledung.output().includes('Ledung is running'), 'Ledung to listen');
    await page.open();
    const waiting = await until(() => (page.certificate?.state === 'waiting-caa' ? page.certificate : null), 'waiting-caa');
    const log = ledung.output();
    check(log.indexOf('Ledung is running') < log.indexOf('Certificate: ACME account'), 'Ledung listens before it goes to the ACME server');
    const saved = JSON.parse(fs.readFileSync(path.join(remoteDir, 'acme.json'), 'utf8'));
    check(!!waiting.accountUrl && saved.accounts[`https://127.0.0.1:${P.acme}/dir`] === waiting.accountUrl, 'the account URL Pebble gave is in acme.json and on the page', waiting.accountUrl ?? '');
    check(waiting.record === `${NAME}. CAA 0 issue "letsencrypt.org; accounturi=${waiting.accountUrl}; validationmethods=tls-alpn-01"`, 'the page shows the record to paste', waiting.record ?? '');
    check(fs.existsSync(path.join(remoteDir, 'acme-account.key')), 'the account key is in the remote folder');

    console.log('== 2. A record for another account changes nothing; the right one, with Check now, orders ==');
    await setCaa('letsencrypt.org; accounturi=https://127.0.0.1/my-account/someone-else; validationmethods=tls-alpn-01');
    check(await checkNow() === 200, 'Check now answers');
    await until(() => page.certificate?.error?.includes('someone-else'), 'the lookup to see the other record', 10_000);
    check(page.certificate?.state === 'waiting-caa' && !fs.existsSync(path.join(remoteDir, 'tls.crt')) && checkConnections === 0, 'still waiting, nothing ordered, no check reached the relay');
    await setCaa(`letsencrypt.org; accounturi=${waiting.accountUrl}; validationmethods=tls-alpn-01`);
    const started = Date.now();
    check(await checkNow() === 200, 'Check now answers');
    const valid = await until(() => (page.certificate?.state === 'valid' ? page.certificate : null), 'the certificate', 60_000);
    check(Date.now() - started < 60_000, 'ordered within the minute of Check now', `${Date.now() - started} ms`);
    check(checkConnections > 0, 'Pebble\'s TLS-ALPN-01 check came through the front, the relay and the tunnel', `${checkConnections} connection(s)`);
    const cert = new crypto.X509Certificate(fs.readFileSync(path.join(remoteDir, 'tls.crt')));
    check(cert.issuer.includes('Pebble') && cert.checkHost(NAME) === NAME, 'tls.crt is Pebble\'s certificate for the name', cert.issuer.replace(/\n/g, ', '));
    check(!!valid.validUntil && !!valid.renewAt && valid.renewAt < valid.validUntil, 'the page shows when it runs out and when it renews', new Date(valid.validUntil!).toISOString());

    console.log('== 3. A phone through the relay gets that certificate, without a restart ==');
    const seen = await phone(root);
    check(seen.authorized && seen.issuer.includes('Pebble'), 'the phone trusts it through Pebble\'s root', `issuer ${seen.issuer}, ${seen.status}`);
    check(/^HTTP\/1\.1 \d{3}/.test(seen.status), 'and gets an HTTP answer from Ledung', seen.status);

    console.log('== 4. A restart with a valid certificate orders nothing ==');
    page.close();
    const fingerprint = cert.fingerprint256;
    const checksBefore = checkConnections;
    await stop(ledung);
    ledung = startLedung();
    await until(() => ledung.output().includes('Remote: connected'), 'the tunnel again');
    await page.open();
    await until(() => page.certificate?.state === 'valid', 'valid after the restart');
    await new Promise((r) => setTimeout(r, 3000));
    check(!ledung.output().includes('Certificate: issued') && checkConnections === checksBefore, 'no order after the restart');
    check(new crypto.X509Certificate(fs.readFileSync(path.join(remoteDir, 'tls.crt'))).fingerprint256 === fingerprint, 'the same certificate in use');

    console.log('== 5. With no usable certificate, a start orders as soon as the tunnel connects (the record is in place) ==');
    page.close();
    await stop(ledung);
    // An expired one counts as none; Pebble's lifetime can't be set short here, so the files are removed instead.
    fs.rmSync(path.join(remoteDir, 'tls.crt'));
    fs.rmSync(path.join(remoteDir, 'tls.key'));
    ledung = startLedung();
    await until(() => ledung.output().includes('Remote: connected'), 'the tunnel again');
    const connectedAt = Date.now();
    await until(() => ledung.output().includes('Certificate: issued'), 'an order on connect', 60_000);
    check(Date.now() - connectedAt < 60_000, 'a new certificate within a minute of connecting', `${Date.now() - connectedAt} ms`);
    check(new crypto.X509Certificate(fs.readFileSync(path.join(remoteDir, 'tls.crt'))).fingerprint256 !== fingerprint, 'a new certificate');
    check((await phone(root)).authorized, 'the phone trusts the new one');
  } finally {
    page.close();
    for (const child of children.reverse()) await stop(child);
    front.close();
    // The relay's close waits for its connections to end; the process exit below ends them.
    void relay.close();
    for (const port of [P.dns, P.dnsMgmt, P.acme, P.acmeMgmt, LEDUNG_PORT]) if (await portOpen(port)) console.log(`WARN  port ${port} still open after the test`);
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`FAIL  ${(e as Error).message}`);
  for (const child of children) await stop(child);
  process.exit(1);
});
