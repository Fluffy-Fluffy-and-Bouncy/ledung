// Reads the name (SNI) and ALPN list from a TLS ClientHello, the first thing a phone sends on a
// passed-through connection (docs/steps/relay-e2e.md, piece 2). The relay routes by the name without
// ending TLS (#200); Ledung reads ALPN from the same bytes to pick the TLS-ALPN-01 context (#202).
//
// The bytes come from the internet, so every length is checked against what is there, and anything
// that is not one well-formed ClientHello is refused rather than guessed at. Like mux.ts this file
// imports nothing, so the relay's container can copy it on its own.

/** A TLS record carries at most 2^14 bytes (RFC 8446 5.1). */
export const MAX_RECORD = 16384;
const RECORD_HEADER = 5;
/** The most a caller needs to buffer before the answer is known. */
export const MAX_CLIENT_HELLO = RECORD_HEADER + MAX_RECORD;

export type ClientHelloResult =
  /** More bytes are needed. */
  | { state: 'more' }
  /** Not a ClientHello this code will route: close the connection. */
  | { state: 'bad'; reason: string }
  /** `sni` is lower case, or null when none was sent; `length` is the bytes of the record it came in. */
  | { state: 'hello'; sni: string | null; alpn: string[]; length: number };

class Truncated extends Error {}

/** A cursor over one handshake message: reading past its end throws instead of reading on. */
class Reader {
  private readonly buf: Buffer;
  at: number;
  readonly end: number;
  constructor(buf: Buffer, at: number, end: number) {
    this.buf = buf;
    this.at = at;
    this.end = end;
  }
  private need(n: number): void {
    if (this.at + n > this.end) throw new Truncated();
  }
  u8(): number {
    this.need(1);
    return this.buf[this.at++]!;
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.at);
    this.at += 2;
    return v;
  }
  bytes(n: number): Buffer {
    this.need(n);
    const v = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }
  /** A length-prefixed block as a reader of its own, bounded by its length. */
  block(lengthBytes: 1 | 2): Reader {
    const n = lengthBytes === 1 ? this.u8() : this.u16();
    this.need(n);
    const inner = new Reader(this.buf, this.at, this.at + n);
    this.at += n;
    return inner;
  }
  get left(): number {
    return this.end - this.at;
  }
}

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const EXT_SERVER_NAME = 0;
const EXT_ALPN = 16;

/** Reads `buf`, the first bytes of a connection, as a ClientHello. */
export function readClientHello(buf: Buffer): ClientHelloResult {
  const bad = (reason: string): ClientHelloResult => ({ state: 'bad', reason });
  // The record header, checked byte by byte as it arrives so garbage is refused at once.
  if (buf.length >= 1 && buf[0] !== 0x16) return bad('not a TLS handshake');
  if (buf.length >= 2 && buf[1] !== 0x03) return bad('not a TLS record');
  if (buf.length < RECORD_HEADER) return { state: 'more' };
  const recordLength = buf.readUInt16BE(3);
  if (recordLength > MAX_RECORD) return bad('record too large');
  if (recordLength < 4) return bad('record too small');
  // The handshake header is in the first four bytes of the record.
  if (buf.length >= RECORD_HEADER + 1 && buf[RECORD_HEADER] !== 0x01) return bad('not a ClientHello');
  if (buf.length >= RECORD_HEADER + 4) {
    const helloLength = buf.readUIntBE(RECORD_HEADER + 1, 3);
    // A ClientHello split over several records is legal but rare: refused, not reassembled (spike #199).
    if (4 + helloLength > recordLength) return bad('ClientHello split over several records');
  }
  if (buf.length < RECORD_HEADER + recordLength) return { state: 'more' };
  const helloLength = buf.readUIntBE(RECORD_HEADER + 1, 3);
  try {
    return { state: 'hello', ...parseBody(new Reader(buf, RECORD_HEADER + 4, RECORD_HEADER + 4 + helloLength)), length: RECORD_HEADER + recordLength };
  } catch (e) {
    if (e instanceof Truncated) return bad('lengths do not add up');
    if (e instanceof BadHello) return bad(e.message);
    throw e;
  }
}

class BadHello extends Error {}

function parseBody(r: Reader): { sni: string | null; alpn: string[] } {
  const version = r.u16();
  if (version >> 8 !== 0x03) throw new BadHello('not a TLS version');
  r.bytes(32); // random
  if (r.block(1).left > 32) throw new BadHello('session id too long');
  const suites = r.block(2);
  if (suites.left < 2 || suites.left % 2) throw new BadHello('bad cipher suites');
  if (r.block(1).left < 1) throw new BadHello('no compression methods');
  const result = { sni: null as string | null, alpn: [] as string[] };
  // Before TLS 1.2 the extensions may be missing altogether: then there is no name.
  if (r.left === 0) return result;
  const extensions = r.block(2);
  if (r.left !== 0) throw new BadHello('bytes after the extensions');
  const seen = new Set<number>();
  while (extensions.left > 0) {
    const type = extensions.u16();
    const body = extensions.block(2);
    // The same extension twice is forbidden (RFC 8446 4.2), and would let two readers disagree on the name.
    if (seen.has(type)) throw new BadHello('an extension twice');
    seen.add(type);
    if (type === EXT_SERVER_NAME) result.sni = serverName(body);
    else if (type === EXT_ALPN) result.alpn = protocols(body);
  }
  return result;
}

function serverName(body: Reader): string | null {
  // An empty server_name extension is what a server sends back; from a client it names nothing.
  if (body.left === 0) return null;
  const list = body.block(2);
  if (body.left !== 0) throw new BadHello('bytes after the server name list');
  let name: string | null = null;
  while (list.left > 0) {
    const type = list.u8();
    const value = list.block(2);
    if (type !== 0) continue; // only host_name is defined; others are skipped
    if (name !== null) throw new BadHello('two host names');
    const raw = value.bytes(value.left);
    // ASCII only (RFC 6066 3: an A-label, no trailing dot); anything else would be decoded differently by different readers.
    const text = raw.toString('latin1');
    if (!HOST_NAME.test(text.toLowerCase())) throw new BadHello('not a host name');
    name = text.toLowerCase();
  }
  return name;
}

function protocols(body: Reader): string[] {
  const list = body.block(2);
  if (body.left !== 0) throw new BadHello('bytes after the ALPN list');
  const out: string[] = [];
  while (list.left > 0) {
    const name = list.block(1);
    if (name.left === 0) throw new BadHello('an empty ALPN name');
    out.push(name.bytes(name.left).toString('latin1'));
  }
  if (!out.length) throw new BadHello('an empty ALPN list');
  return out;
}
