// Spike for issue #199 (docs/steps/relay-e2e.md, build plan item 1). Not production code: it lives
// outside src/ on purpose and is run by run.sh, which starts Caddy, Pebble and Pebble's mock DNS first.
//
// One process plays three parts, each as close to the real one as a spike needs:
//   relay   the agents' WebSocket (127.0.0.1:51481) and a passthrough listener (127.0.0.1:51444) that
//           reads Caddy's PROXY v2 header and the ClientHello's SNI and puts the raw bytes on that
//           agent's stream, with Ledung's own mux (src/remote/mux.ts) unchanged.
//   Ledung  the tunnel client: each stream is a duplexPair end, as LedungServer.tunnelConnection()
//           makes today; it peeks at the ClientHello and hands the stream to an https server that never
//           listens (or to the TLS-ALPN-01 challenge context), with emit('connection').
//   phone   a TLS client to Caddy's "443" (127.0.0.1:51443) with an SNI of copper7meadow4.l.test.
// Every check prints PASS or FAIL; the process exits 1 on any FAIL.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { duplexPair, type Duplex } from 'node:stream';
import tls from 'node:tls';
import { WebSocket, WebSocketServer } from 'ws';
import { decodeFrame, encodeFrame, FRAME, Streams } from '../../../src/remote/mux.ts';

const SPIKE_DIR = process.env.SPIKE_DIR ?? path.resolve(import.meta.dirname, '../../../.test/spike');
const require = createRequire(path.join(SPIKE_DIR, 'node', 'package.json'));
const acme = require('acme-client');
const x509 = require('@peculiar/x509');
x509.cryptoProvider.set(crypto.webcrypto);

const NAME = 'copper7meadow4.l.test';
/** Names the CAA cases order; the same spike Ledung answers their challenges. */
const CAA_NAMES = ['sibling.l.test', 'mine.l.test', 'dnsonly.l.test', 'late.l.test'];
const CADDY = { host: '127.0.0.1', port: 51443 };
const RELAY_WS = 51481;
const RELAY_PASSTHROUGH = 51444;
const PEBBLE_DIR = 'https://127.0.0.1:51400/dir';
const PEBBLE_MGMT = 'https://127.0.0.1:51401';
const DNS_MGMT = 'http://127.0.0.1:51055';
/** What the page says; it must never show up in the bytes the relay carries. */
const SECRET = `SECRET-PAGE-BODY-${crypto.randomBytes(8).toString('hex')}`;

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
}
const log = (who: string, msg: string) => console.log(`      ${who}: ${msg}`);

// ---------------------------------------------------------------------------------------------
// The ClientHello: SNI and ALPN, as the relay and Ledung would both read it (the proposal's shared
// src/remote/clienthello.ts). Returns null while more bytes are needed, 'bad' when it isn't one.
interface Hello { sni: string | null; alpn: string[] }
function parseClientHello(buf: Buffer): Hello | null | 'bad' {
  if (buf.length < 5) return null;
  if (buf[0] !== 0x16) return 'bad';
  const recLen = buf.readUInt16BE(3);
  if (recLen > 16384) return 'bad';
  if (buf.length < 5 + recLen) return null;
  const b = buf.subarray(5, 5 + recLen);
  try {
    if (b[0] !== 0x01) return 'bad';
    let at = 4 + 2 + 32; // handshake header, client version, random
    at += 1 + b.readUInt8(at); // session id
    at += 2 + b.readUInt16BE(at); // cipher suites
    at += 1 + b.readUInt8(at); // compression methods
    const end = at + 2 + b.readUInt16BE(at);
    at += 2;
    const hello: Hello = { sni: null, alpn: [] };
    while (at + 4 <= end) {
      const type = b.readUInt16BE(at);
      const len = b.readUInt16BE(at + 2);
      const ext = b.subarray(at + 4, at + 4 + len);
      if (type === 0 && ext.length > 5 && ext[2] === 0) hello.sni = ext.subarray(5, 5 + ext.readUInt16BE(3)).toString('ascii');
      if (type === 16) for (let i = 2; i < ext.length; i += 1 + ext.readUInt8(i)) hello.alpn.push(ext.subarray(i + 1, i + 1 + ext.readUInt8(i)).toString('ascii'));
      at += 4 + len;
    }
    return hello;
  } catch {
    return 'bad';
  }
}

// PROXY protocol v2 (what caddy-l4's proxy handler sends first): the phone's address.
const PROXY_SIG = Buffer.from('0d0a0d0a000d0a515549540a', 'hex');
function parseProxyV2(buf: Buffer): { from: string; rest: Buffer } | null | 'bad' {
  if (buf.length < 16) return null;
  if (!buf.subarray(0, 12).equals(PROXY_SIG)) return 'bad';
  const len = buf.readUInt16BE(14);
  if (buf.length < 16 + len) return null;
  const fam = buf[13];
  let from = '?';
  if (fam === 0x11) from = `${[...buf.subarray(16, 20)].join('.')}:${buf.readUInt16BE(24)}`;
  else if (fam === 0x21) from = `[${buf.subarray(16, 32).toString('hex')}]:${buf.readUInt16BE(48)}`;
  return { from, rest: buf.subarray(16 + len) };
}

/** Walks a byte stream as TLS records: true when every byte is part of a well-formed record. */
function onlyTlsRecords(bytes: Buffer): { ok: boolean; records: number; types: Set<number> } {
  let at = 0;
  let records = 0;
  const types = new Set<number>();
  while (at + 5 <= bytes.length) {
    const type = bytes.readUInt8(at);
    const major = bytes.readUInt8(at + 1);
    const len = bytes.readUInt16BE(at + 3);
    if (![20, 21, 22, 23].includes(type) || major !== 3 || len > 16384 + 256) return { ok: false, records, types };
    types.add(type);
    at += 5 + len;
    records++;
  }
  return { ok: at === bytes.length, records, types };
}

// ---------------------------------------------------------------------------------------------
// relay
interface Capture { up: Buffer[]; down: Buffer[]; hello: Hello; from: string }
const captures: Capture[] = [];
const agents = new Map<string, { ws: WebSocket; streams: Streams; nextId: number }>();

const relayWss = new WebSocketServer({ host: '127.0.0.1', port: RELAY_WS, path: '/agent' });
relayWss.on('connection', (ws, req) => {
  // Spike only: one agent may answer for several names, so the CAA cases below need no second Ledung.
  const names = String(req.headers['x-ledung-agent']).split(',');
  const agent = { ws, streams: new Streams(ws as never), nextId: 1 };
  for (const name of names) agents.set(name, agent);
  ws.on('message', (data: Buffer) => {
    const f = decodeFrame(data);
    if (f) agent.streams.receive(f.kind, f.id, f.payload);
  });
  ws.on('close', () => names.forEach((n) => agents.delete(n)));
});

const passthrough = net.createServer({ allowHalfOpen: true }, (socket) => {
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => socket.destroy(), 10_000);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 16 * 1024 + 256) return socket.destroy();
    const proxy = parseProxyV2(buf);
    if (proxy === 'bad') return socket.destroy();
    if (!proxy) return;
    const hello = parseClientHello(proxy.rest);
    if (hello === 'bad') return socket.destroy();
    if (!hello) return;
    socket.off('data', onData);
    socket.pause();
    clearTimeout(timer);
    const agent = hello.sni ? agents.get(hello.sni) : undefined;
    log('relay', `from ${proxy.from} sni=${hello.sni} alpn=[${hello.alpn.join(',')}] -> ${agent ? 'agent' : 'closed (no such Ledung online)'}`);
    if (!agent) return socket.destroy();
    // Everything the relay carries for this stream, both ways, for the "only TLS records" check.
    const cap: Capture = { up: [proxy.rest], down: [], hello, from: proxy.from };
    captures.push(cap);
    socket.on('data', (c: Buffer) => cap.up.push(c));
    const write = socket.write.bind(socket);
    socket.write = ((c: Buffer, ...rest: never[]) => {
      cap.down.push(Buffer.from(c));
      return write(c, ...rest);
    }) as typeof socket.write;
    const id = agent.nextId++;
    agent.ws.send(encodeFrame(FRAME.open, id));
    agent.streams.attach(id, socket, proxy.rest);
    socket.resume();
  };
  socket.on('data', onData);
  socket.on('error', () => {});
});
passthrough.listen(RELAY_PASSTHROUGH, '127.0.0.1');

// ---------------------------------------------------------------------------------------------
// Ledung
/** Sockets that came through the tunnel, as Guard.markTunnel keeps them. */
const tunnelSockets = new WeakSet<object>();
const tunnelEnds = new WeakSet<object>();
let lastRequestSocketWasMarked: boolean | null = null;
let lastRequestSocketWasTheTunnelEnd: boolean | null = null;

async function selfSigned(name: string): Promise<{ key: string; cert: string }> {
  const keys = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: `CN=${name}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    keys,
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: name }])],
  });
  const pkcs8 = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  return { cert: cert.toString('pem'), key: `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n` };
}

const firstCert = await selfSigned(NAME);
const handler: http.RequestListener = (req, res) => {
  lastRequestSocketWasMarked = tunnelSockets.has(req.socket);
  lastRequestSocketWasTheTunnelEnd = tunnelEnds.has(req.socket);
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`${SECRET} host=${req.headers.host}\n`);
};
// Never listens: every connection it gets is a tunnel stream, handed over with emit('connection').
const ledungHttps = https.createServer({ ...firstCert, ALPNProtocols: ['http/1.1'] }, handler);
// Review finding 4a: req.socket here is the TLSSocket, not the duplexPair end. Mark the TLSSocket.
ledungHttps.on('secureConnection', (s) => tunnelSockets.add(s));
const ledungWss = new WebSocketServer({ noServer: true });
ledungHttps.on('upgrade', (req, socket, head) => ledungWss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send(`echo ${m} marked=${tunnelSockets.has(req.socket)}`))));
// Today's plain mode, for a relay that still sends HTTP.
const ledungHttp = http.createServer(handler);

// TLS-ALPN-01: the one-off challenge certificate, only while an order is open, chosen by the ALPN
// in the ClientHello Ledung peeked at.
const challenges = new Map<string, tls.SecureContext>();
const acmeTls = tls.createServer({ ALPNProtocols: ['acme-tls/1'], SNICallback: (sni, cb) => cb(null, challenges.get(sni)) });
acmeTls.on('secureConnection', (s) => {
  log('ledung', `answered a TLS-ALPN-01 check for ${s.servername} (alpn ${s.alpnProtocol})`);
  s.end();
});
acmeTls.on('tlsClientError', (e) => log('ledung', `challenge TLS error: ${e.message}`));
ledungHttps.on('tlsClientError', (e) => log('ledung', `TLS error: ${e.message}`));

/** One tunnel stream: what tunnelConnection() does, with the first-byte peek (review finding 4b). */
function tunnelConnection(): Duplex {
  const [ours, theirs] = duplexPair();
  Object.assign(ours, { setTimeout: () => ours, setNoDelay: () => ours, setKeepAlive: () => ours });
  ours.on('error', () => {});
  ours.once('close', () => theirs.destroy());
  theirs.once('close', () => ours.destroy());
  tunnelEnds.add(ours);
  let buf = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const hello = parseClientHello(buf);
    if (hello === null) return;
    ours.off('data', onData);
    ours.pause();
    ours.unshift(buf);
    // The handover happens after the first bytes, not when the stream opens.
    if (hello === 'bad') return void ledungHttp.emit('connection', ours);
    const target = hello.alpn.includes('acme-tls/1') && hello.sni && challenges.has(hello.sni) ? acmeTls : ledungHttps;
    target.emit('connection', ours);
  };
  ours.on('data', onData);
  return theirs;
}

const agentWs = new WebSocket(`ws://127.0.0.1:${RELAY_WS}/agent`, { headers: { 'x-ledung-agent': [NAME, ...CAA_NAMES].join(',') } });
const agentStreams = new Streams(agentWs as never);
agentWs.on('message', (data: Buffer) => {
  const f = decodeFrame(data);
  if (!f) return;
  if (f.kind === FRAME.open) agentStreams.attach(f.id, tunnelConnection());
  else agentStreams.receive(f.kind, f.id, f.payload);
});
await new Promise((r) => agentWs.once('open', r));
await new Promise((r) => setTimeout(r, 100));

// ---------------------------------------------------------------------------------------------
// phone
function phoneGet(servername: string, ca: string | string[]): Promise<{ status: number; body: string; cert: tls.PeerCertificate }> {
  return new Promise((resolve, reject) => {
    const req = https.get({ ...CADDY, servername, headers: { host: servername }, ca, agent: false, path: '/' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, body, cert: (res.socket as tls.TLSSocket).getPeerCertificate() }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

console.log('\n== 1. Caddy (caddy-l4) routes *.l.test by SNI, other sites keep working ==');
const caddyRoot = fs.readFileSync(path.join(SPIKE_DIR, 'caddy-data/pki/authorities/local/root.crt'), 'utf8');
try {
  const site = await phoneGet('site.test', caddyRoot);
  check(site.status === 200 && site.body.includes('ordinary site'), 'an ordinary HTTPS site on the same port is served by Caddy', `issuer ${site.cert.issuer?.CN}`);
} catch (e) {
  check(false, 'an ordinary HTTPS site on the same port is served by Caddy', String(e));
}
const before = captures.length;
try {
  await phoneGet('nobody.l.test', firstCert.cert);
  check(false, 'an unknown *.l.test name is closed, not served by Caddy');
} catch (e) {
  const msg = String((e as Error).message);
  // Reached Caddy (not ECONNREFUSED), went to the relay, which closed it without a stream.
  check(captures.length === before && !msg.includes('ECONNREFUSED'), 'an unknown *.l.test name is closed, not served by Caddy', msg);
}

console.log('\n== 2. TLS over the tunnel, self-signed: the relay sees only TLS records ==');
try {
  const r = await phoneGet(NAME, firstCert.cert);
  check(r.status === 200 && r.body.includes(SECRET), 'the phone completes TLS end to end with the Ledung', `subject ${r.cert.subject?.CN}, body "${r.body.trim().slice(0, 40)}..."`);
  const cap = captures.at(-1)!;
  check(/^127\.0\.0\.1:\d+$/.test(cap.from), 'the relay gets the phone address from PROXY v2', cap.from);
  const up = Buffer.concat(cap.up);
  const down = Buffer.concat(cap.down);
  const u = onlyTlsRecords(up);
  const d = onlyTlsRecords(down);
  check(u.ok && d.ok, 'every byte the relay carried is a TLS record', `phone->Ledung ${up.length} B in ${u.records} records, Ledung->phone ${down.length} B in ${d.records} records, types ${[...new Set([...u.types, ...d.types])].join(',')}`);
  check(!up.includes(SECRET) && !down.includes(SECRET) && !down.includes('host='), 'the page text is not in what the relay carried');
  check(lastRequestSocketWasMarked === true, 'the request socket is the marked TLSSocket (mark on secureConnection)');
  check(lastRequestSocketWasTheTunnelEnd === false, 'review finding 4a holds: req.socket is not the duplexPair end, so today\'s mark alone would miss it');
} catch (e) {
  check(false, 'the phone completes TLS end to end with the Ledung', String(e));
}
try {
  const echoed = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`wss://${NAME}:${CADDY.port}/ws`, {
      ca: firstCert.cert,
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4))) as never,
    });
    ws.on('open', () => ws.send('hi'));
    ws.on('message', (m) => (resolve(String(m)), ws.close()));
    ws.on('error', reject);
  });
  check(echoed === 'echo hi marked=true', 'a WebSocket works over TLS through the tunnel, and is marked', echoed);
} catch (e) {
  check(false, 'a WebSocket works over TLS through the tunnel', String(e));
}

console.log('\n== 3. ACME TLS-ALPN-01 against Pebble, answered by Ledung through Caddy, relay and tunnel ==');
const dnsResolver = new dns.promises.Resolver();
dnsResolver.setServers(['127.0.0.1:51053']);
async function setCaa(host: string, policies: { tag: string; value: string }[] | null): Promise<void> {
  const url = `${DNS_MGMT}/${policies ? 'add-caa' : 'clear-caa'}`;
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(policies ? { host: `${host}.`, policies } : { host: `${host}.` }) });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
}

const accountKey = await acme.crypto.createPrivateEcdsaKey();
const client = new acme.Client({ directoryUrl: PEBBLE_DIR, accountKey, backoffAttempts: 5 });
await client.createAccount({ termsOfServiceAgreed: true });
const accountUrl: string = client.getAccountUrl();
log('ledung', `ACME account ${accountUrl} (exists before any CAA record or order)`);

/** One order for `name`, the challenge answered through the tunnel. Returns the PEM chain and key, or the error. */
async function order(name: string, c = client): Promise<{ key: string; cert: string } | Error> {
  try {
    const o = await c.createOrder({ identifiers: [{ type: 'dns', value: name }] });
    const [authz] = await c.getAuthorizations(o);
    const chall = authz.challenges.find((x: { type: string }) => x.type === 'tls-alpn-01');
    if (!chall) return new Error(`no tls-alpn-01 challenge offered: ${authz.challenges.map((x: { type: string }) => x.type)}`);
    const keyAuth = await c.getChallengeKeyAuthorization(chall);
    const [alpnKey, alpnCert] = await acme.crypto.createAlpnCertificate(authz, keyAuth);
    challenges.set(name, tls.createSecureContext({ key: alpnKey, cert: alpnCert }));
    try {
      await c.completeChallenge(chall);
      await c.waitForValidStatus(chall);
    } finally {
      challenges.delete(name);
    }
    const [key, csr] = await acme.crypto.createCsr({ altNames: [name] }, await acme.crypto.createPrivateEcdsaKey());
    await c.finalizeOrder(o, csr);
    return { key: String(key), cert: await c.getCertificate(o) };
  } catch (e) {
    return e as Error;
  }
}

const issued = await order(NAME);
if (issued instanceof Error) {
  check(false, 'Pebble issues a certificate for the name, validated through Caddy, relay and tunnel', issued.message);
} else {
  const sawCheck = captures.some((c) => c.hello.sni === NAME && c.hello.alpn.includes('acme-tls/1'));
  check(sawCheck, 'Pebble issues a certificate for the name, validated through Caddy, relay and tunnel', 'the relay saw ALPN acme-tls/1 for the name');
  // Renewal without a restart: swap the context in place.
  ledungHttps.setSecureContext(issued);
  const roots = await (await fetch(`${PEBBLE_MGMT}/roots/0`)).text();
  try {
    const r = await phoneGet(NAME, roots);
    check(r.status === 200 && r.body.includes(SECRET), 'after setSecureContext the phone sees the Pebble certificate, no restart', `issuer ${r.cert.issuer?.CN}`);
  } catch (e) {
    check(false, 'after setSecureContext the phone sees the Pebble certificate, no restart', String(e));
  }
}

console.log('\n== 3b. What Pebble does with CAA (informational: Pebble never checks CAA) ==');
// Pebble v2.10.1's caaIdentities only goes into the directory's meta and the DNS-PERSIST-01 challenge
// (wfe.go); its VA does no CAA lookup. So each order below is issued whatever the record says, and the
// CAA lock can only be proven against Let's Encrypt staging. Printed as INFO; it never fails the run.
const other = new acme.Client({ directoryUrl: PEBBLE_DIR, accountKey: await acme.crypto.createPrivateEcdsaKey(), backoffAttempts: 5 });
await other.createAccount({ termsOfServiceAgreed: true });
await setCaa('l.test', [{ tag: 'issue', value: ';' }]);
await setCaa('mine.l.test', [{ tag: 'issue', value: `pebble.letsencrypt.org; accounturi=${accountUrl}; validationmethods=tls-alpn-01` }]);
await setCaa('dnsonly.l.test', [{ tag: 'issue', value: `pebble.letsencrypt.org; accounturi=${accountUrl}; validationmethods=dns-01` }]);
await setCaa('late.l.test', [{ tag: 'issue', value: 'otherca.example' }]);
const caaCases: { name: string; c: typeof client; who: string; letsEncrypt: string }[] = [
  { name: 'sibling.l.test', c: client, who: 'our account', letsEncrypt: 'refuses: parent l.test says issue ";"' },
  { name: 'mine.l.test', c: client, who: 'our account', letsEncrypt: 'issues: own record names our account and tls-alpn-01' },
  { name: 'mine.l.test', c: other, who: 'another account (a server operator)', letsEncrypt: 'refuses: accounturi names a different account' },
  { name: 'dnsonly.l.test', c: client, who: 'our account', letsEncrypt: 'refuses: validationmethods allows only dns-01' },
  { name: 'late.l.test', c: client, who: 'our account', letsEncrypt: 'refuses: the record names another CA' },
];
for (const t of caaCases) {
  const own = await dnsResolver.resolveCaa(t.name).catch(() => []);
  const caa = own.length ? own : await dnsResolver.resolveCaa(t.name.split('.').slice(1).join('.')).catch(() => []);
  const r = await order(t.name, t.c);
  console.log(`INFO  ${t.name} by ${t.who}: Pebble ${r instanceof Error ? `refused (${r.message.slice(0, 120)})` : 'ISSUED'}; Let's Encrypt ${t.letsEncrypt}; CAA served: ${JSON.stringify(caa.map((x) => x.issue))}`);
}


console.log(`\n${failures ? `${failures} FAILED` : 'all checks passed'}`);
agentWs.close();
relayWss.close();
passthrough.close();
process.exit(failures ? 1 : 0);
