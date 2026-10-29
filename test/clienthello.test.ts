// The ClientHello reader the relay routes passed-through connections by (#200, relay-e2e.md piece 2).
// It reads bytes from the internet, so it is fed recorded browsers' ClientHellos, Node's own, hand-built
// ones that break one rule each, every truncation, and garbage; it must never throw and never guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { MAX_RECORD, readClientHello, type ClientHelloResult } from '../src/remote/clienthello.ts';

/**
 * Recorded 2026-10-18 on Windows from headless browsers opening https://pc.relay.test/ against a local
 * listener: Chrome 122 (565 bytes) and Edge 155, whose post-quantum key share makes it 1795 bytes.
 */
const recorded = (browser: string) => Buffer.from(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', `clienthello-${browser}.hex`), 'utf8').trim(), 'hex');
const BROWSERS = ['chrome', 'edge'];

const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const u24 = (n: number) => Buffer.from([n >> 16, (n >> 8) & 0xff, n & 0xff]);
const vec8 = (b: Buffer) => Buffer.concat([Buffer.from([b.length]), b]);
const vec16 = (b: Buffer) => Buffer.concat([u16(b.length), b]);
const ext = (type: number, body: Buffer) => Buffer.concat([u16(type), vec16(body)]);
const sniExt = (...names: Buffer[]) => ext(0, vec16(Buffer.concat(names.map((n) => Buffer.concat([Buffer.from([0]), vec16(n)])))));
const alpnExt = (...protocols: string[]) => ext(16, vec16(Buffer.concat(protocols.map((p) => vec8(Buffer.from(p, 'latin1'))))));

/** A ClientHello built by hand from RFC 8446 4.1.2, with `extensions` as given (null: none at all). */
function hello(extensions: Buffer[] | null, body: { sessionId?: Buffer; suites?: Buffer; compression?: Buffer } = {}): Buffer {
  const message = Buffer.concat([
    u16(0x0303),
    crypto.randomBytes(32),
    vec8(body.sessionId ?? crypto.randomBytes(32)),
    vec16(body.suites ?? Buffer.from([0x13, 0x01, 0x13, 0x02])),
    vec8(body.compression ?? Buffer.from([0])),
    extensions === null ? Buffer.alloc(0) : vec16(Buffer.concat(extensions)),
  ]);
  return record(Buffer.concat([Buffer.from([0x01]), u24(message.length), message]));
}
const record = (payload: Buffer) => Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(payload.length), payload]);

const isBad = (r: ClientHelloResult, reason?: RegExp) => {
  assert.equal(r.state, 'bad', JSON.stringify(r));
  if (reason) assert.match((r as { reason: string }).reason, reason);
};

/** The first record Node's own TLS client sends with these options. */
function nodeHello(options: tls.ConnectionOptions): Promise<Buffer> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let got = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        got = Buffer.concat([got, chunk]);
        if (got.length >= 5 && got.length >= 5 + got.readUInt16BE(3)) {
          socket.destroy();
          server.close();
          resolve(got.subarray(0, 5 + got.readUInt16BE(3)));
        }
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      const client = tls.connect({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, ...options });
      client.on('error', () => {});
    });
  });
}

test('recorded browser ClientHellos give their name and ALPN list', () => {
  for (const browser of BROWSERS) {
    const bytes = recorded(browser);
    assert.deepEqual(readClientHello(bytes), { state: 'hello', sni: 'pc.relay.test', alpn: ['h2', 'http/1.1'], length: bytes.length }, browser);
  }
  assert.ok(recorded('edge').length > 1500, 'the post-quantum one is the large case');
});

test("Node's own ClientHello gives its name and ALPN, and none without a name", async () => {
  const named = await nodeHello({ servername: 'Copper7Meadow4.example.org', ALPNProtocols: ['acme-tls/1', 'http/1.1'] });
  assert.deepEqual(readClientHello(named), { state: 'hello', sni: 'copper7meadow4.example.org', alpn: ['acme-tls/1', 'http/1.1'], length: named.length });
  // Node sends no server_name for an address (RFC 6066 3), and none was asked for here.
  const unnamed = await nodeHello({});
  const result = readClientHello(unnamed);
  assert.equal(result.state, 'hello');
  assert.equal((result as { sni: string | null }).sni, null);
});

test('every truncation of a ClientHello asks for more bytes, and never answers early', () => {
  for (const bytes of [...BROWSERS.map(recorded), hello([sniExt(Buffer.from('a.example')), alpnExt('http/1.1')])]) {
    for (let n = 0; n < bytes.length; n++) assert.deepEqual(readClientHello(bytes.subarray(0, n)), { state: 'more' }, `first ${n} of ${bytes.length} bytes`);
  }
});

test('bytes after the ClientHello (the rest of the handshake) do not change the answer', () => {
  const bytes = recorded('edge');
  const more = Buffer.concat([bytes, crypto.randomBytes(300)]);
  assert.deepEqual(readClientHello(more), readClientHello(bytes));
});

test('what is not a TLS handshake is refused from its first byte', () => {
  isBad(readClientHello(Buffer.from('G')), /not a TLS handshake/);
  isBad(readClientHello(Buffer.from('GET / HTTP/1.1\r\nHost: pc.relay.test\r\n\r\n')), /not a TLS handshake/);
  isBad(readClientHello(Buffer.from([0x16, 0x02])), /not a TLS record/);
  // An SSL 2 style hello.
  isBad(readClientHello(Buffer.from([0x80, 0x2e, 0x01, 0x03, 0x01])));
  // A handshake record that is not a ClientHello (a ServerHello).
  isBad(readClientHello(Buffer.from([0x16, 0x03, 0x03, 0x00, 0x30, 0x02])), /not a ClientHello/);
});

test('an oversized record, and a ClientHello split over several records, are refused before they arrive', () => {
  isBad(readClientHello(Buffer.from([0x16, 0x03, 0x01, ...u16(MAX_RECORD + 1)])), /too large/);
  isBad(readClientHello(Buffer.from([0x16, 0x03, 0x01, 0xff, 0xff])), /too large/);
  // The handshake says it is longer than the record holding it: the rest would come in a second record.
  const whole = recorded('edge');
  const message = whole.subarray(5);
  const split = Buffer.concat([record(message.subarray(0, 1000)), record(message.subarray(1000))]);
  isBad(readClientHello(split.subarray(0, 9)), /split over several records/);
  isBad(readClientHello(split), /split over several records/);
});

test('hand-built ClientHellos: names are lower case, extensions and lists must add up', () => {
  const ok = (r: ClientHelloResult) => assert.equal(r.state, 'hello', JSON.stringify(r));
  ok(readClientHello(hello([sniExt(Buffer.from('a.example'))])));
  assert.equal((readClientHello(hello([sniExt(Buffer.from('PC.Relay.Test'))])) as { sni: string }).sni, 'pc.relay.test');
  // No extensions at all (allowed before TLS 1.2), or no server_name: no name.
  assert.deepEqual({ ...readClientHello(hello(null)), length: 0 }, { state: 'hello', sni: null, alpn: [], length: 0 });
  assert.equal((readClientHello(hello([alpnExt('h2')])) as { sni: string | null }).sni, null);
  // An unknown name type is skipped; its host_name still counts.
  const otherType = ext(0, vec16(Buffer.concat([Buffer.from([7]), vec16(Buffer.from('x')), Buffer.from([0]), vec16(Buffer.from('b.example'))])));
  assert.equal((readClientHello(hello([otherType])) as { sni: string }).sni, 'b.example');

  isBad(readClientHello(hello([sniExt(Buffer.from('a.example')), sniExt(Buffer.from('b.example'))])), /extension twice/);
  isBad(readClientHello(hello([sniExt(Buffer.from('a.example'), Buffer.from('b.example'))])), /two host names/);
  for (const name of ['', 'a..example', 'a.example.', '-a.example', 'a_b.example', 'a.example\0.evil', 'ex ample', 'a'.repeat(64) + '.example']) {
    isBad(readClientHello(hello([sniExt(Buffer.from(name, 'latin1'))])), /not a host name/);
  }
  isBad(readClientHello(hello([sniExt(Buffer.from('bücher.example', 'utf8'))])), /not a host name/);
  isBad(readClientHello(hello([alpnExt('')])), /empty ALPN name/);
  isBad(readClientHello(hello([ext(16, vec16(Buffer.alloc(0)))])), /empty ALPN list/);
  isBad(readClientHello(hello([], { sessionId: Buffer.alloc(33) })), /session id/);
  isBad(readClientHello(hello([], { suites: Buffer.from([0x13]) })), /cipher suites/);
  isBad(readClientHello(hello([], { compression: Buffer.alloc(0) })), /compression/);
  // An extension whose length runs past the extensions block.
  const runOver = Buffer.concat([u16(0), u16(500), Buffer.alloc(4)]);
  isBad(readClientHello(hello([runOver])), /do not add up/);
  // A server name list with a byte left over after it.
  isBad(readClientHello(hello([ext(0, Buffer.concat([vec16(Buffer.concat([Buffer.from([0]), vec16(Buffer.from('a.example'))])), Buffer.from([0])]))])), /after the server name/);
});

test('garbage and corrupted ClientHellos never throw, and a name read from them is always a host name', () => {
  const HOST = /^[a-z0-9.-]{1,253}$/;
  const check = (bytes: Buffer) => {
    const r = readClientHello(bytes);
    assert.ok(['more', 'bad', 'hello'].includes(r.state));
    if (r.state === 'hello') {
      if (r.sni !== null) assert.match(r.sni, HOST);
      assert.ok(r.length <= bytes.length);
    }
  };
  for (let i = 0; i < 3000; i++) check(crypto.randomBytes(crypto.randomInt(0, 2000)));
  // Random bytes behind a plausible header, so the parser gets past the first checks.
  for (let i = 0; i < 3000; i++) {
    const body = crypto.randomBytes(crypto.randomInt(4, 600));
    body[0] = 0x01;
    check(Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(body.length), body]));
  }
  // Each recorded hello with one byte changed, at every position.
  for (const browser of BROWSERS) {
    const bytes = recorded(browser);
    for (let at = 0; at < bytes.length; at++) {
      const copy = Buffer.from(bytes);
      copy[at] = copy[at]! ^ (1 + crypto.randomInt(255));
      check(copy);
    }
  }
});
