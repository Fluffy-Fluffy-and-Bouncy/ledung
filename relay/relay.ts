// The relay (issue #160, docs/steps/relay.md step 1): Ledungs dial out to it, and phones reach them
// through it. It runs on a server behind a reverse proxy that ends HTTPS and passes the Host on.
//
// - A Ledung (an "agent") opens a WebSocket to /agent with its name and secret. The config holds
//   only a SHA-256 hash of each secret, the public host the agent serves and who owns it; nothing
//   about any one user is built in (decision 7: several users later).
// - A connection whose Host is an agent's public host becomes a stream over that agent's socket,
//   and its bytes go through untouched, HTTP and WebSocket alike. The relay reads only the request
//   head, to find the Host; it adds "Connection: close" to a plain request so that each connection
//   carries one request and a proxy can't reuse it for another host.
// - No agent for that host, or no such host: a plain "This Ledung is offline" page, the same for
//   both, so names can't be probed.
// - It logs connects, disconnects and refusals, never what goes through.
// - End to end (#200, docs/steps/relay-e2e.md piece 2): an agent with "tls": "passthrough" is reached
//   on a second listener instead, which the server's proxy feeds raw TLS, routed by name and preceded
//   by a PROXY v2 header with the phone's address. The relay reads that header and the ClientHello's
//   name and passes every byte on unchanged; it holds no certificate and cannot end TLS for the name.
//   No name, an unknown one or an agent offline: the connection is closed, with no page (it has no
//   certificate to show one with).
// - Adding a computer (#236): `node relay.ts add`, `remove` and `list` talk to the running relay over a
//   local socket that only the relay's own machine or container reaches, never its public ports. They
//   change the agents in place, so connected Ledungs stay connected, and the relay keeps what was added
//   in a store file of its own beside the config, which stays read-only. Only a hash is ever given: the
//   new computer's Ledung makes its secret (`remote-secret`, src/remote/secret.ts). Every computer added
//   this way is passed through end to end (Martin, 2026-10-19, Ledung questions 396 and 398). The work is
//   in Relay.add, remove and list (adminRequest takes them as one request) and readStore / writeStore;
//   the commands only parse their arguments, send one request and print the answer.
//
// Not part of Ledung's release copy or npm package: it runs on its own, from its own container.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_CLIENT_HELLO, readClientHello } from '../src/remote/clienthello.ts';
import { decodeFrame, encodeFrame, FRAME, helloMessage, helloVersion, MAX_CHUNK, PROTOCOL_VERSION, Streams } from '../src/remote/mux.ts';
import { hashSecret } from '../src/remote/secret.ts';
import { isJoinToken, JOIN_TOKEN_BYTES, newJoinToken } from '../src/remote/join-token.ts';

export { hashSecret };

export interface AgentEntry {
  /** What the agent gives when it connects. */
  name: string;
  /** Who the agent belongs to; only logged for now (decision 7). */
  owner: string;
  /** The public host phones use for it, e.g. "pc.example.org". */
  host: string;
  /** SHA-256 of the agent's secret, as hex (`node relay.ts hash`). */
  secretSha256: string;
  /**
   * "proxy" (the default): the server's proxy ends TLS and phones come in on the HTTP listener.
   * "passthrough": phones come in on the passthrough listener, still encrypted, and the HTTP listener
   * refuses the name, so a proxy left ending TLS for it fails loudly (relay-e2e.md piece 2).
   */
  tls: 'proxy' | 'passthrough';
}

export interface RelayLimits {
  /** The largest message an agent may send. */
  maxFrameBytes: number;
  /** Phone connections open at once through one agent. */
  maxStreamsPerAgent: number;
  /** Refused agent sign-ins from one address before it is turned away for the window. */
  failedAttemptsPerAddress: number;
  attemptWindowSeconds: number;
  /** How long a connection may take to send its request head (or PROXY header and ClientHello) before it is dropped. */
  headTimeoutMs: number;
}

export interface RelayConfig {
  port: number;
  /** The address to listen on; in a container, all of them. */
  bind: string;
  /** The passthrough listener's port (8443 in the plan), or null for none. Never published: only the proxy reaches it. */
  passthroughPort: number | null;
  /**
   * Who may connect to the passthrough listener and so speak for a phone in a PROXY header: addresses
   * or ranges ("10.0.0.0/8"). Anyone else is closed before a byte is read (Martin, 2026-10-18, #283).
   */
  passthroughFrom: string[];
  /** Behind a reverse proxy: take the caller's address from the last X-Forwarded-For entry. */
  trustProxy: boolean;
  /** The domain added computers are named under by default, as `<name>.l.<domain>`; null: `add` needs --host. */
  domain: string | null;
  /** The address Ledungs dial, as it goes in their remote block ("wss://relay.example.org"); null: a placeholder. */
  relayUrl: string | null;
  /**
   * SHA-256 of the admin key the admin's Ledung made (Settings → Relay, #237): it opens the admin API for invites
   * (README, Invite a computer). Null: no admin API, and /enrol takes no codes.
   */
  adminKeySha256: string | null;
  agents: AgentEntry[];
  limits: RelayLimits;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const DEFAULT_LIMITS: RelayLimits = { maxFrameBytes: 1024 * 1024, maxStreamsPerAgent: 64, failedAttemptsPerAddress: 10, attemptWindowSeconds: 600, headTimeoutMs: 10_000 };
/** A request head larger than this is refused. */
const MAX_HEAD = 16 * 1024;
const PING_MS = 30_000;
/** An agent that signed in must send its hello within this long. */
const HELLO_MS = 10_000;
/** The headers an agent signs in with. */
export const AGENT_NAME_HEADER = 'x-ledung-agent';
/** Loopback and the private ranges: Caddy on the same machine or on Docker's own network. */
export const DEFAULT_PASSTHROUGH_FROM = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1/128', 'fc00::/7'];

/** An address with an optional prefix ("10.0.0.0/8", "::1"), or null when it isn't one. */
function parseRange(range: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [address = '', prefixText, extra] = range.split('/');
  const version = net.isIP(address);
  if (!version || extra !== undefined) return null;
  const max = version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : NaN;
  if (!(prefix >= 0 && prefix <= max)) return null;
  return { address, prefix, family: version === 4 ? 'ipv4' : 'ipv6' };
}

/**
 * A test for the senders `ranges` allow. IPv4-mapped IPv6 ("::ffff:10.0.0.2", a dual-stack socket's form)
 * counts as its IPv4 address: BlockList matches it against the IPv4 ranges itself.
 */
export function senderCheck(ranges: string[]): (address: string | undefined) => boolean {
  const list = new net.BlockList();
  for (const range of ranges) {
    const r = parseRange(range);
    if (!r) throw new Error(`not an address or range: ${range}`);
    list.addSubnet(r.address, r.prefix, r.family);
  }
  return (address) => {
    const version = address ? net.isIP(address) : 0;
    return version !== 0 && list.check(address!, version === 4 ? 'ipv4' : 'ipv6');
  };
}

/** Checks the relay's config file; throws a readable error. */
export function parseRelayConfig(raw: unknown): RelayConfig {
  const problems: string[] = [];
  const c = (raw ?? {}) as Record<string, unknown>;
  const port = c.port ?? 8080;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) problems.push('port: a whole number from 0 to 65535');
  const bind = c.bind ?? '0.0.0.0';
  if (typeof bind !== 'string') problems.push('bind: an address');
  const passthroughPort = c.passthroughPort ?? null;
  if (passthroughPort !== null && (typeof passthroughPort !== 'number' || !Number.isInteger(passthroughPort) || passthroughPort < 0 || passthroughPort > 65535)) {
    problems.push('passthroughPort: a whole number from 0 to 65535, or left out');
  }
  const passthroughFrom = c.passthroughFrom ?? DEFAULT_PASSTHROUGH_FROM;
  if (!Array.isArray(passthroughFrom) || passthroughFrom.some((r) => typeof r !== 'string' || !parseRange(r))) {
    problems.push('passthroughFrom: a list of addresses or ranges, e.g. ["10.0.0.0/8", "::1"]');
  }
  const trustProxy = c.trustProxy ?? false;
  if (typeof trustProxy !== 'boolean') problems.push('trustProxy: true or false');
  const domain = c.domain ?? null;
  if (domain !== null && (typeof domain !== 'string' || !HOST.test(domain))) problems.push('domain: a domain in lower case, e.g. example.org, or left out');
  const relayUrl = c.relayUrl ?? null;
  if (relayUrl !== null && (typeof relayUrl !== 'string' || !/^wss?:\/\/[^\s/]+\/?$/.test(relayUrl))) problems.push('relayUrl: what Ledungs dial, e.g. wss://relay.example.org, or left out');
  const adminKeySha256 = c.adminKeySha256 ?? null;
  if (adminKeySha256 !== null && (typeof adminKeySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(adminKeySha256))) problems.push('adminKeySha256: the 64 hex digits Settings → Relay shows, or left out');
  const limits = { ...DEFAULT_LIMITS, ...((c.limits ?? {}) as Partial<RelayLimits>) };
  for (const [key, value] of Object.entries(limits)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) problems.push(`limits.${key}: a whole number above 0`);
  }
  // A frame carries up to MAX_CHUNK bytes of a stream plus its header.
  if (limits.maxFrameBytes < MAX_CHUNK + 16) problems.push(`limits.maxFrameBytes: at least ${MAX_CHUNK + 16}`);
  const agents: AgentEntry[] = [];
  if (!Array.isArray(c.agents)) problems.push('agents: a list');
  else {
    c.agents.forEach((a: unknown, i) => {
      const { entry, problems: wrong } = parseAgent(a, `agents[${i}]`);
      problems.push(...wrong);
      agents.push(entry);
    });
    const passed = agents.find((a) => a.tls === 'passthrough');
    if (passed && passthroughPort === null) problems.push(`agents: "${passed.name}" is "tls": "passthrough", so passthroughPort must be set`);
    const twice = (key: 'name' | 'host') => agents.map((a) => a[key]).find((v, i, all) => all.indexOf(v) !== i);
    if (twice('name')) problems.push(`agents: two are named "${twice('name')}"`);
    if (twice('host')) problems.push(`agents: two use the host "${twice('host')}"`);
  }
  if (problems.length) throw new Error(`The relay config has problems:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return {
    port: port as number, bind: bind as string, passthroughPort: passthroughPort as number | null, passthroughFrom: passthroughFrom as string[],
    trustProxy: trustProxy as boolean, domain: domain as string | null, relayUrl: relayUrl === null ? null : (relayUrl as string).replace(/\/$/, ''),
    adminKeySha256: adminKeySha256 as string | null, agents, limits,
  };
}

/** One agent entry, from the config or the store; `at` names it in the problems. */
function parseAgent(raw: unknown, at: string): { entry: AgentEntry; problems: string[] } {
  const a = (raw ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof a.name !== 'string' || !NAME.test(a.name)) problems.push(`${at}.name: letters, digits, "_" or "-"`);
  if (typeof a.owner !== 'string' || !a.owner.trim()) problems.push(`${at}.owner: who it belongs to`);
  if (typeof a.host !== 'string' || !HOST.test(a.host)) problems.push(`${at}.host: a host name in lower case, e.g. pc.example.org`);
  if (typeof a.secretSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.secretSha256)) problems.push(`${at}.secretSha256: 64 hex digits (node relay.ts hash)`);
  const tls = a.tls ?? 'proxy';
  if (tls !== 'proxy' && tls !== 'passthrough') problems.push(`${at}.tls: "proxy" or "passthrough"`);
  return { entry: { name: String(a.name), owner: String(a.owner), host: String(a.host), secretSha256: String(a.secretSha256), tls: tls as AgentEntry['tls'] }, problems };
}

function secretMatches(given: string, entry: AgentEntry): boolean {
  return crypto.timingSafeEqual(Buffer.from(hashSecret(given), 'hex'), Buffer.from(entry.secretSha256, 'hex'));
}

/**
 * Words for the names the relay picks (docs/steps/relay-home.md decision 2): 6 to 10 lower-case letters,
 * plain things and places, none offensive, none a person's name, and none that reads like another when
 * spoken or typed. Changing the list changes only names picked from then on.
 */
export const NAME_WORDS = [
  'almond', 'anchor', 'apricot', 'autumn', 'badger', 'bamboo', 'banner', 'barley', 'basket', 'beacon', 'blossom',
  'bramble', 'breeze', 'bridge', 'bronze', 'button', 'cactus', 'candle', 'canopy', 'canyon', 'carbon', 'castle',
  'cellar', 'cherry', 'chestnut', 'cinder', 'circle', 'citrus', 'clover', 'cobalt', 'compass', 'copper', 'cotton',
  'cradle', 'crystal', 'cypress', 'dahlia', 'dolphin', 'dragonfly', 'falcon', 'feather', 'fennel', 'forest', 'fossil',
  'garden', 'garnet', 'ginger', 'glacier', 'granite', 'gravel', 'harbor', 'harvest', 'heather', 'hedgehog', 'hollow',
  'horizon', 'iceberg', 'island', 'jasmine', 'juniper', 'kettle', 'lagoon', 'lantern', 'lavender', 'lichen', 'locket',
  'magnet', 'marble', 'marigold', 'meadow', 'meteor', 'mirror', 'mistral', 'monsoon', 'mosaic', 'nectar', 'nutmeg',
  'orchard', 'orchid', 'paddle', 'pebble', 'pepper', 'pigeon', 'pinecone', 'planet', 'pocket', 'pollen', 'prairie',
  'pumpkin', 'quartz', 'quiver', 'rabbit', 'ribbon', 'rocket', 'saffron', 'salmon', 'sapling', 'sequoia', 'shadow',
  'silver', 'sparrow', 'spruce', 'squirrel', 'summit', 'sunrise', 'teapot', 'thicket', 'thistle', 'thunder', 'timber',
  'tundra', 'turtle', 'valley', 'velvet', 'violet', 'walnut', 'whisker', 'willow', 'window', 'winter', 'yarrow',
  'zephyr',
];

/**
 * A name in the style of relay-home decision 2: two words, and two digits from 2 to 9 (no 0 or 1, which read
 * as o and l) in two different gaps of the three around them, as in "copper7meadow4" or "4lantern9harbor".
 * It is a DNS label as it is: lower-case letters and digits, at most 22 characters.
 */
export function wordName(random: (max: number) => number = crypto.randomInt): string {
  const first = NAME_WORDS[random(NAME_WORDS.length)]!;
  let second = NAME_WORDS[random(NAME_WORDS.length)]!;
  while (second === first) second = NAME_WORDS[random(NAME_WORDS.length)]!;
  const gaps = ['', '', ''];
  const skipped = random(3);
  for (let i = 0; i < 3; i++) if (i !== skipped) gaps[i] = String(2 + random(8));
  return `${gaps[0]}${first}${gaps[1]}${second}${gaps[2]}`;
}

/** An added computer's name: one DNS label, so it can be the first part of its host. */
const ADDED_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** What `node relay.ts add` asks the running relay for. */
export interface AddRequest {
  /** SHA-256 of the computer's secret, which its own Ledung made (`remote-secret`). */
  hash: string;
  owner: string;
  /** Left out: a word name. */
  name?: string;
  /** Left out: `<name>.l.<domain>`. */
  host?: string;
  /** Only "passthrough" is accepted: computers added this way are always end to end (Martin, question 396). */
  tls?: string;
}

export interface ListedAgent {
  name: string;
  owner: string;
  host: string;
  tls: AgentEntry['tls'];
  /** "config" for the hand-written entries, "added" for those `add` made. */
  from: 'config' | 'added';
  connected: boolean;
}

export type AdminRequest = { op: 'add' } & AddRequest | { op: 'remove'; name: string } | { op: 'list' };
export type AdminReply =
  | { ok: false; error: string }
  | { ok: true; op: 'add'; agent: AgentEntry; relayUrl: string | null }
  | { ok: true; op: 'remove'; agent: AgentEntry; wasConnected: boolean }
  | { ok: true; op: 'list'; agents: ListedAgent[] };

/** Where the admin socket is: RELAY_ADMIN_SOCKET, or a fixed place both the relay and the commands find. */
export function adminSocketPath(): string {
  return process.env.RELAY_ADMIN_SOCKET || (process.platform === 'win32' ? '\\\\.\\pipe\\ledung-relay-admin' : path.join(os.tmpdir(), 'ledung-relay-admin.sock'));
}

/**
 * The store of added computers, as written: every entry checked, but not yet against the config (Relay does
 * that when it starts). No file yet: none added. A file that isn't a store throws, with the reason.
 */
export function readStore(file: string): AgentEntry[] {
  if (!fs.existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`The relay's store of added computers (${file}) can't be read: ${(e as Error).message}`);
  }
  const list = (raw as { agents?: unknown })?.agents;
  if (!Array.isArray(list)) throw new Error(`The relay's store of added computers (${file}) has no "agents" list.`);
  return list.map((a, i) => {
    const { entry, problems } = parseAgent(a, `agents[${i}]`);
    if (problems.length) throw new Error(`The relay's store of added computers (${file}) has problems:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    return entry;
  });
}

/** Written whole to a file beside it, then renamed over it: a crash leaves the old store or the new one, never half of one. */
export function writeStore(file: string, agents: AgentEntry[]): void {
  const temp = `${file}.${process.pid}.tmp`;
  const body = { $comment: 'Computers added with node relay.ts add (README, Adding a computer). Change them with add and remove, not by hand.', agents };
  try {
    fs.writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw new Error(`Could not write the relay's store of added computers (${file}): ${(e as Error).message}`);
  }
}

/** An invite (#237): a name reserved for someone's computer, until its one-time code is used or runs out. */
export interface Invite {
  id: string;
  /** SHA-256 of the token in the join code; the token itself is shown once, to the admin's Ledung, and not kept. */
  tokenSha256: string;
  owner: string;
  name: string;
  host: string;
  expiresAt: number;
}

/** A computer that joined with an invite, waiting for its CAA record until the admin's Ledung says it was written. */
export interface Joined {
  name: string;
  accountUrl: string;
  enrolledAt: number;
  approved: boolean;
}

/** A join code works for this long (#237: valid 24 h, single use). */
export const INVITE_MS = 24 * 60 * 60 * 1000;
/** Open invites at once: a stolen admin key can't fill the store. */
const MAX_INVITES = 100;
/** The body of an admin or enrolment request. */
const MAX_API_BODY = 4096;
/** An ACME account URL as a CA gives it: https, nothing that could break out of a CAA record. */
const ACCOUNT_URL = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,=%-]{1,500}$/;

/** The invites file: open invites and joined computers. No file yet: none. A file that isn't one throws, with the reason. */
export function readInvites(file: string): { invites: Invite[]; joined: Joined[] } {
  if (!fs.existsSync(file)) return { invites: [], joined: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { invites?: unknown; joined?: unknown };
    if (!Array.isArray(raw.invites) || !Array.isArray(raw.joined)) throw new Error('no "invites" and "joined" lists');
    return { invites: raw.invites as Invite[], joined: raw.joined as Joined[] };
  } catch (e) {
    throw new Error(`The relay's invites (${file}) can't be read: ${(e as Error).message}`);
  }
}

/** Written whole beside it, then renamed over it, as the store is. */
export function writeInvites(file: string, data: { invites: Invite[]; joined: Joined[] }): void {
  const temp = `${file}.${process.pid}.tmp`;
  const body = { $comment: 'Invites from the admin\'s Ledung and the computers that joined with them (README, Invite a computer). Not by hand.', ...data };
  try {
    fs.writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw new Error(`Could not write the relay's invites (${file}): ${(e as Error).message}`);
  }
}

class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** An admin request is one short JSON line. */
const MAX_ADMIN_REQUEST = 4096;

const OFFLINE_PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Offline</title></head>'
  + '<body style="font-family:system-ui,sans-serif;margin:3em auto;max-width:30em;padding:0 1em"><h1>This Ledung is offline</h1>'
  + '<p>The computer it runs on is not connected right now. Try again when it is on.</p></body></html>';

function plainResponse(status: number, reason: string, body: string, type = 'text/html; charset=utf-8'): string {
  return `HTTP/1.1 ${status} ${reason}\r\nContent-Type: ${type}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${body}`;
}

/** The head as it goes to the agent: unchanged for an upgrade, one request per connection otherwise. */
export function forwardHead(head: string): string {
  const lines = head.split('\r\n');
  // An upgrade by Node's own rule: an Upgrade header and "upgrade" among the Connection tokens. A lone
  // Upgrade header is an ordinary request to Node, kept alive unless told otherwise, and a second request
  // on the same connection could then name this computer instead of the public host (review 165 finding 1).
  const connection = lines.filter((l) => /^connection\s*:/i.test(l)).flatMap((l) => l.slice(l.indexOf(':') + 1).split(',')).map((t) => t.trim().toLowerCase());
  const upgrade = lines.some((l) => /^upgrade\s*:/i.test(l)) && connection.includes('upgrade');
  if (upgrade) return head;
  const kept = lines.filter((l, i) => i === 0 || !/^(connection|keep-alive)\s*:/i.test(l));
  // The head ends with an empty line; "Connection: close" goes in before it.
  kept.splice(kept.length - 2, 0, 'Connection: close');
  return kept.join('\r\n');
}

const PROXY_SIGNATURE = Buffer.from('0d0a0d0a000d0a515549540a', 'hex');
const PROXY_HEADER = 16;
/** Addresses and a few TLVs; caddy-l4 sends none. More than this is not a proxy we know. */
const MAX_PROXY_BODY = 1024;
/** What the passthrough listener buffers at most before it knows where a connection goes. */
const MAX_PASSTHROUGH_HEAD = PROXY_HEADER + MAX_PROXY_BODY + MAX_CLIENT_HELLO;

export type ProxyHeaderResult =
  | { state: 'more' }
  | { state: 'bad'; reason: string }
  /** `address` is the phone's, or null for a LOCAL header (the proxy's own check) or an unspecified family. */
  | { state: 'header'; address: string | null; length: number };

/**
 * Reads a PROXY protocol v2 header (proxy-protocol.txt section 2.2, haproxy.org), which caddy-l4's
 * proxy sends before the phone's first byte (spike #199 finding 2). Only TCP over IPv4 or IPv6 carries
 * an address; the TLVs after it are skipped.
 */
export function readProxyHeader(buf: Buffer): ProxyHeaderResult {
  const bad = (reason: string): ProxyHeaderResult => ({ state: 'bad', reason });
  const sig = Math.min(buf.length, PROXY_SIGNATURE.length);
  if (!buf.subarray(0, sig).equals(PROXY_SIGNATURE.subarray(0, sig))) return bad('no PROXY v2 header');
  if (buf.length < PROXY_HEADER) return { state: 'more' };
  const version = buf[12]! >> 4;
  const command = buf[12]! & 0x0f;
  const family = buf[13]!;
  const length = buf.readUInt16BE(14);
  if (version !== 2) return bad('not PROXY version 2');
  if (command > 1) return bad('unknown PROXY command');
  if (length > MAX_PROXY_BODY) return bad('PROXY header too large');
  if (buf.length < PROXY_HEADER + length) return { state: 'more' };
  const body = buf.subarray(PROXY_HEADER, PROXY_HEADER + length);
  const done = (address: string | null): ProxyHeaderResult => ({ state: 'header', address, length: PROXY_HEADER + length });
  // LOCAL: the proxy speaking for itself, and the family is to be ignored; UNSPEC: no address given.
  if (command === 0 || family === 0x00) return done(null);
  if (family === 0x11) {
    if (body.length < 12) return bad('PROXY address too short');
    return done([...body.subarray(0, 4)].join('.'));
  }
  if (family === 0x21) {
    if (body.length < 36) return bad('PROXY address too short');
    const groups = Array.from({ length: 8 }, (_, i) => body.readUInt16BE(i * 2).toString(16)).join(':');
    // The usual short form ("2001:db8::1"), so one address is always written, and counted, the same way.
    return done(new URL(`http://[${groups}]/`).hostname.slice(1, -1));
  }
  // UDP, Unix sockets: not what a phone's TLS connection comes over.
  return bad('PROXY family not TCP');
}

interface Agent {
  entry: AgentEntry;
  ws: WebSocket;
  streams: Streams;
  nextId: number;
  alive: boolean;
}

export class Relay {
  private readonly config: RelayConfig;
  private readonly log: (line: string) => void;
  private readonly byHost = new Map<string, AgentEntry>();
  private readonly byName = new Map<string, AgentEntry>();
  private readonly online = new Map<string, Agent>();
  private readonly failures = new Map<string, { count: number; since: number }>();
  private readonly server: net.Server;
  /** Raw TLS from the server's proxy, for "tls": "passthrough" agents; null when not configured. */
  private readonly passthrough: net.Server | null;
  private readonly trustedSender: (address: string | undefined) => boolean;
  /** The relay's own requests (health, the agents' sign-in, the offline page) go through this. */
  private readonly own: http.Server;
  private readonly wss: WebSocketServer;
  private readonly pinger: NodeJS.Timeout;
  private readonly sockets = new Set<net.Socket>();
  /** Where added computers are kept, or null to keep them only while the relay runs (tests). */
  private readonly store: string | null;
  /** Picks a name for an add without --name; replaced only by tests, to make names collide. */
  private readonly pickName: () => string;
  /** The names `add` made, in the order added; the rest come from the config. */
  private readonly added: string[] = [];
  private admin: net.Server | null = null;
  /** Where invites and joined computers are kept (#237), or null to keep them only while the relay runs (tests). */
  private readonly invitesFile: string | null;
  private invites: Invite[] = [];
  private joined: Joined[] = [];
  private readonly now: () => number;

  /**
   * `store`: the file added computers are kept in (README, Adding a computer). `invites`: the file invites and joined
   * computers are kept in (README, Invite a computer). `now`: the clock invites run out by; tests move it.
   */
  constructor(config: RelayConfig, log: (line: string) => void = (line) => console.log(line), options: { store?: string | null; pickName?: () => string; invites?: string | null; now?: () => number } = {}) {
    this.config = config;
    this.log = log;
    this.store = options.store ?? null;
    this.pickName = options.pickName ?? (() => wordName());
    this.invitesFile = options.invites ?? null;
    this.now = options.now ?? Date.now;
    if (this.invitesFile) ({ invites: this.invites, joined: this.joined } = readInvites(this.invitesFile));
    for (const a of config.agents) {
      this.byHost.set(a.host, a);
      this.byName.set(a.name, a);
    }
    for (const a of this.loadStore()) {
      this.byHost.set(a.host, a);
      this.byName.set(a.name, a);
      this.added.push(a.name);
    }
    this.wss = new WebSocketServer({ noServer: true, maxPayload: config.limits.maxFrameBytes });
    this.own = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://relay').pathname;
      // Invite a computer (#237): the admin API with the admin key, and the one-time enrolment with a join code.
      if (pathname === '/enrol' || pathname === '/admin' || pathname.startsWith('/admin/')) {
        void this.onApi(req, res, pathname);
        return;
      }
      // Written whole and the connection closed: the same bytes as the offline page sent for a known host.
      const health = req.method === 'GET' && req.url === '/health';
      res.socket?.end(health ? plainResponse(200, 'OK', 'ok', 'text/plain') : plainResponse(503, 'Service Unavailable', OFFLINE_PAGE));
    });
    this.own.on('upgrade', (req, socket, head) => this.onAgent(req, socket as net.Socket, head));
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => this.onConnection(socket));
    this.trustedSender = senderCheck(config.passthroughFrom);
    this.passthrough = config.passthroughPort === null ? null : net.createServer({ allowHalfOpen: true }, (socket) => this.onPassthrough(socket));
    this.pinger = setInterval(() => this.ping(), PING_MS);
    this.pinger.unref();
  }

  /** Listens on both ports; resolves with the HTTP one (useful with port 0 in tests; see passthroughPort()). */
  async listen(): Promise<number> {
    const listen = (server: net.Server, port: number) => new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.config.bind, () => {
        server.off('error', reject);
        resolve((server.address() as net.AddressInfo).port);
      });
    });
    const port = await listen(this.server, this.config.port);
    if (this.passthrough) await listen(this.passthrough, this.config.passthroughPort!);
    return port;
  }

  /** The passthrough listener's port once listening, or null when there is none. */
  passthroughPort(): number | null {
    const address = this.passthrough?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  async close(): Promise<void> {
    clearInterval(this.pinger);
    for (const agent of this.online.values()) agent.ws.terminate();
    for (const socket of this.sockets) socket.destroy();
    const close = (server: net.Server | null) => new Promise<void>((resolve) => (server?.listening ? server.close(() => resolve()) : resolve()));
    await Promise.all([close(this.server), close(this.passthrough), close(this.admin)]);
  }

  /**
   * The admin socket `add`, `remove` and `list` reach the running relay through: a Unix socket (a named pipe
   * on Windows), so only someone on the relay's own machine or in its container can use it, never anyone
   * through its ports (#236). On Unix only the relay's own user may connect.
   */
  async listenAdmin(socketPath = adminSocketPath()): Promise<void> {
    const server = net.createServer((socket) => this.onAdmin(socket));
    // A socket file left by a relay that didn't stop cleanly would make listen fail.
    if (process.platform !== 'win32') fs.rmSync(socketPath, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
    this.admin = server;
  }

  private onAdmin(socket: net.Socket): void {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    const timer = setTimeout(() => socket.destroy(), 10_000);
    const onData = (chunk: string) => {
      buffered += chunk;
      const end = buffered.indexOf('\n');
      if (end === -1 && buffered.length <= MAX_ADMIN_REQUEST) return;
      clearTimeout(timer);
      socket.off('data', onData);
      let reply: AdminReply;
      try {
        if (end === -1) throw new Error('The request is too long.');
        reply = this.adminRequest(JSON.parse(buffered.slice(0, end)) as AdminRequest);
      } catch (e) {
        reply = { ok: false, error: (e as Error).message };
      }
      socket.end(`${JSON.stringify(reply)}\n`);
    };
    socket.on('data', onData);
  }

  /** One admin request; a refusal is a reply with the reason, never a change. */
  adminRequest(request: AdminRequest): AdminReply {
    try {
      if (request?.op === 'add') return { ok: true, op: 'add', agent: this.add(request), relayUrl: this.config.relayUrl };
      if (request?.op === 'remove') return { ok: true, op: 'remove', ...this.remove(request.name) };
      if (request?.op === 'list') return { ok: true, op: 'list', agents: this.list() };
      throw new Error('Unknown request: add, remove or list.');
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Adds a computer to the running relay; it can connect at once, and nothing else is touched. */
  add(request: AddRequest): AgentEntry {
    if (request.tls !== undefined && request.tls !== 'passthrough') {
      throw new Error('Computers added this way are always "tls": "passthrough" (end to end); "proxy" is only for hand-written config entries.');
    }
    if (this.config.passthroughPort === null) throw new Error('The relay has no passthroughPort, and added computers are passed through end to end: set passthroughPort first.');
    const hash = String(request.hash ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('--hash: the 64 hex digits the computer\'s Ledung showed (remote-secret).');
    const owner = String(request.owner ?? '').trim();
    if (!owner) throw new Error('--owner: who the computer belongs to.');
    const { name, host } = this.chooseName(request);
    const entry: AgentEntry = { name, owner, host, secretSha256: hash, tls: 'passthrough' };
    // Kept first: an add that can't be kept is no add.
    this.saveStore([...this.addedEntries(), entry]);
    this.byName.set(name, entry);
    this.byHost.set(host, entry);
    this.added.push(name);
    this.event('agent added', { name, owner, host, tls: entry.tls });
    return entry;
  }

  /**
   * The name and host for a new computer: the ones asked for if free and valid, else a free word name under the
   * relay's domain. A name or host an open invite holds is taken too (#237).
   */
  private chooseName(request: { name?: string; host?: string }): { name: string; host: string } {
    this.dropExpired();
    const taken = (name: string) => [...this.byName.keys(), ...this.invites.map((i) => i.name)].some((n) => n.toLowerCase() === name);
    let name: string;
    if (request.name !== undefined) {
      name = String(request.name).trim().toLowerCase();
      if (!ADDED_NAME.test(name)) throw new Error('--name: lower-case letters, digits and "-", at most 63, as one part of a host name.');
      if (taken(name)) throw new Error(`The name "${name}" is taken.`);
    } else {
      let tries = 0;
      do {
        // About 2.8 million names (relay-home decision 2): this many collisions in a row means something is wrong.
        if (++tries > 100) throw new Error('Could not find a free name; give one with --name.');
        name = this.pickName();
      } while (taken(name));
    }
    let host: string;
    if (request.host !== undefined) {
      host = String(request.host).trim().toLowerCase();
      if (!HOST.test(host) || !host.includes('.')) throw new Error('--host: one host name in lower case, e.g. pc.example.org.');
    } else {
      if (!this.config.domain) throw new Error('The relay\'s config has no "domain", so give the host with --host.');
      host = `${name}.l.${this.config.domain}`;
    }
    if (this.byHost.has(host) || this.invites.some((i) => i.host === host)) throw new Error(`The host "${host}" is taken.`);
    if (this.config.relayUrl && host === new URL(this.config.relayUrl).hostname) throw new Error(`"${host}" is the relay's own name.`);
    return { name, host };
  }

  /** Removes a computer `add` made, and disconnects it if it is connected. */
  remove(name: string): { agent: AgentEntry; wasConnected: boolean } {
    const entry = this.byName.get(String(name ?? ''));
    if (!entry) throw new Error(`No computer is named "${name}".`);
    if (!this.added.includes(entry.name)) throw new Error(`"${entry.name}" is written in the relay's config; remove it there and restart the relay.`);
    this.saveStore(this.addedEntries().filter((a) => a !== entry));
    this.byName.delete(entry.name);
    this.byHost.delete(entry.host);
    this.added.splice(this.added.indexOf(entry.name), 1);
    // A computer that joined with an invite stops waiting for its CAA record too.
    if (this.joined.some((j) => j.name === entry.name)) {
      this.joined = this.joined.filter((j) => j.name !== entry.name);
      this.saveInvites();
    }
    const agent = this.online.get(entry.name);
    if (agent) {
      this.online.delete(entry.name);
      agent.streams.closeAll();
      agent.ws.close(4003, 'Removed from the relay.');
    }
    this.event('agent removed', { name: entry.name, owner: entry.owner, host: entry.host, connected: agent ? 'yes' : 'no' });
    return { agent: entry, wasConnected: !!agent };
  }

  /** Every computer the relay knows, the config's first. */
  list(): ListedAgent[] {
    return [...this.byName.values()].map((a) => ({
      name: a.name, owner: a.owner, host: a.host, tls: a.tls, from: this.added.includes(a.name) ? 'added' : 'config', connected: this.online.has(a.name),
    }));
  }

  /**
   * Invite a computer (#237): reserves a name (a word name, or the one asked for) and gives a one-time token for
   * it, valid 24 hours. Only the token's hash is kept; the token goes back once, to the admin's Ledung.
   */
  invite(request: { owner?: unknown; name?: unknown; host?: unknown }): Omit<Invite, 'tokenSha256'> & { token: string } {
    if (this.config.passthroughPort === null) throw new ApiError(400, 'The relay has no passthroughPort, and invited computers are passed through end to end: set passthroughPort first.');
    const owner = typeof request.owner === 'string' ? request.owner.trim() : '';
    if (!owner || owner.length > 100) throw new ApiError(400, 'Say whose computer it is ("owner").');
    if ((request.name !== undefined && typeof request.name !== 'string') || (request.host !== undefined && typeof request.host !== 'string')) {
      throw new ApiError(400, '"name" and "host" are text.');
    }
    this.dropExpired();
    if (this.invites.length >= MAX_INVITES) throw new ApiError(429, `${MAX_INVITES} invites are open already; revoke some first.`);
    let chosen: { name: string; host: string };
    try {
      chosen = this.chooseName({ name: (request.name as string | undefined) || undefined, host: (request.host as string | undefined) || undefined });
    } catch (e) {
      throw new ApiError(400, (e as Error).message.replace(/^--(name|host): /, '"$1": '));
    }
    const token = newJoinToken(crypto.randomBytes(JOIN_TOKEN_BYTES));
    const invite: Invite = { id: crypto.randomBytes(8).toString('hex'), tokenSha256: hashSecret(token), owner, ...chosen, expiresAt: this.now() + INVITE_MS };
    this.invites.push(invite);
    this.saveInvites();
    this.event('invite made', { name: invite.name, owner, host: invite.host });
    const { tokenSha256: _, ...shown } = invite;
    return { ...shown, token };
  }

  /** The invites not used yet, without their token hashes. */
  openInvites(): Omit<Invite, 'tokenSha256'>[] {
    this.dropExpired();
    return this.invites.map(({ tokenSha256: _, ...shown }) => shown);
  }

  revokeInvite(id: string): void {
    const invite = this.invites.find((i) => i.id === id);
    if (!invite) throw new ApiError(404, 'No such invite.');
    this.invites = this.invites.filter((i) => i !== invite);
    this.saveInvites();
    this.event('invite revoked', { name: invite.name, owner: invite.owner });
  }

  /**
   * Enrolment (#237): a join code's token, the joining Ledung's secret hash and its ACME account URL. The code is
   * used up whatever happens next; the computer is added to the running relay end to end, under the invite's name.
   */
  enrol(request: { code?: unknown; secretSha256?: unknown; accountUrl?: unknown }): { name: string; host: string } {
    const token = typeof request.code === 'string' ? request.code.trim().toUpperCase() : '';
    const hash = typeof request.secretSha256 === 'string' ? request.secretSha256 : '';
    const accountUrl = typeof request.accountUrl === 'string' ? request.accountUrl : '';
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new ApiError(400, '"secretSha256": 64 hex digits.');
    if (!ACCOUNT_URL.test(accountUrl)) throw new ApiError(400, '"accountUrl": the ACME account URL, https://….');
    this.dropExpired();
    const tokenSha256 = isJoinToken(token) ? hashSecret(token) : null;
    const invite = tokenSha256 ? this.invites.find((i) => crypto.timingSafeEqual(Buffer.from(i.tokenSha256, 'hex'), Buffer.from(tokenSha256, 'hex'))) : undefined;
    // Used, run out, revoked or never made: one answer for all, so codes can't be probed.
    if (!invite) throw new ApiError(401, 'This code is not valid: it may have been used, revoked or run out. Ask for a new one.');
    this.invites = this.invites.filter((i) => i !== invite);
    let entry: AgentEntry;
    try {
      entry = this.add({ hash, owner: invite.owner, name: invite.name, host: invite.host, tls: 'passthrough' });
    } catch (e) {
      this.saveInvites();
      throw new ApiError(409, `The computer could not be added: ${(e as Error).message}`);
    }
    this.joined.push({ name: entry.name, accountUrl, enrolledAt: this.now(), approved: false });
    this.saveInvites();
    this.event('computer joined', { name: entry.name, owner: entry.owner, host: entry.host });
    return { name: entry.name, host: entry.host };
  }

  /** The computers that joined with an invite and are still on the relay, for the admin's Approve cards. */
  joinedComputers(): { name: string; owner: string; host: string; accountUrl: string; enrolledAt: number; approved: boolean }[] {
    return this.joined.flatMap((j) => {
      const entry = this.byName.get(j.name);
      return entry ? [{ name: j.name, owner: entry.owner, host: entry.host, accountUrl: j.accountUrl, enrolledAt: j.enrolledAt, approved: j.approved }] : [];
    });
  }

  /** The admin's Ledung wrote the computer's CAA record (Approve), or the admin did by hand. */
  approved(name: string): void {
    const joined = this.joined.find((j) => j.name === name);
    if (!joined) throw new ApiError(404, 'No computer by that name joined with an invite.');
    joined.approved = true;
    this.saveInvites();
    this.event('computer approved', { name });
  }

  private dropExpired(): void {
    const now = this.now();
    const left = this.invites.filter((i) => i.expiresAt > now);
    if (left.length === this.invites.length) return;
    this.invites = left;
    this.saveInvites();
  }

  private saveInvites(): void {
    if (this.invitesFile) writeInvites(this.invitesFile, { invites: this.invites, joined: this.joined });
  }

  /**
   * The admin API and enrolment, on the relay's own HTTP port (#237; Martin, question #405, default 2: the admin's
   * Ledung is not on the server). The admin API needs the admin key (its hash in the config); none set: it is off.
   * A wrong key or a bad code counts as a failed attempt from that address, as a wrong agent secret does, so
   * guessing is turned away for the window. Answers are JSON, and every connection carries one request.
   */
  private async onApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    const forwarded = req.headers['x-forwarded-for'];
    const from = this.addressOf(req.socket, Array.isArray(forwarded) ? forwarded.join(',') : forwarded);
    const answer = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.socket?.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${text}`);
    };
    try {
      if (!this.config.adminKeySha256) throw new ApiError(404, 'Inviting computers is not set up on this relay.');
      if (this.blocked(from)) throw new ApiError(429, 'Too many failed attempts; try again later.');
      const route = `${req.method} ${pathname.replace(/^\/admin\/(invites|computers)\/[^/]+/, '/admin/$1/:id')}`;
      if (route === 'POST /enrol') {
        try {
          return answer(200, this.enrol(await readApiBody(req)));
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) {
            this.failed(from);
            this.event('enrol refused', { reason: 'bad code', from });
          }
          throw e;
        }
      }
      const key = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
      if (!key || !crypto.timingSafeEqual(Buffer.from(hashSecret(key), 'hex'), Buffer.from(this.config.adminKeySha256, 'hex'))) {
        this.failed(from);
        this.event('admin refused', { reason: 'wrong key', from });
        throw new ApiError(401, 'The admin key is not accepted.');
      }
      // Decoded only after the key check: a bad escape from anyone else would be a 500 and an "api error" line
      // per request, uncounted (PR #239 review, Minor 1).
      let id: string;
      try {
        id = decodeURIComponent(pathname.split('/')[3] ?? '');
      } catch {
        throw new ApiError(400, 'The name in the address is not valid.');
      }
      switch (route) {
        case 'POST /admin/invites': return answer(200, this.invite(await readApiBody(req)));
        case 'GET /admin/invites': return answer(200, { invites: this.openInvites() });
        case 'DELETE /admin/invites/:id': this.revokeInvite(id); return answer(200, { ok: true });
        case 'GET /admin/computers': return answer(200, { computers: this.joinedComputers() });
        case 'POST /admin/computers/:id/approved':
          this.approved(id);
          return answer(200, { ok: true });
      }
      throw new ApiError(404, 'Not found.');
    } catch (e) {
      if (e instanceof ApiError) return answer(e.status, { error: e.message });
      this.event('api error', { error: (e as Error).message });
      return answer(500, { error: 'The relay could not do that.' });
    }
  }

  private addedEntries(): AgentEntry[] {
    return this.added.map((name) => this.byName.get(name)!);
  }

  /**
   * The added computers from the store. One that clashes with the config (a name or host since written there
   * by hand), is not "tls": "passthrough" (a hand edit of the store) or needs a passthroughPort the config no
   * longer has is left out and logged, rather than keeping every other Ledung offline with a relay that won't start.
   */
  private loadStore(): AgentEntry[] {
    if (!this.store) return [];
    const kept: AgentEntry[] = [];
    readStore(this.store).forEach((entry) => {
      const clash = this.byName.has(entry.name) || this.byHost.has(entry.host) || kept.some((k) => k.name === entry.name || k.host === entry.host);
      // Added computers are always end to end (Martin, question 396), also after a hand edit of the store (PR #238 review, Minor 1).
      const reason = clash ? 'name or host already in use'
        : entry.tls !== 'passthrough' ? 'not end to end'
        : this.config.passthroughPort === null ? 'no passthroughPort' : null;
      if (reason) this.event('added agent skipped', { name: entry.name, host: entry.host, reason });
      else kept.push(entry);
    });
    return kept;
  }

  private saveStore(agents: AgentEntry[]): void {
    if (this.store) writeStore(this.store, agents);
  }

  /** The names of the agents connected now. */
  connected(): string[] {
    return [...this.online.keys()];
  }

  private event(what: string, fields: Record<string, string | number | undefined>): void {
    const parts = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`);
    this.log(`${new Date().toISOString()} ${what}${parts.length ? ` ${parts.join(' ')}` : ''}`);
  }

  /** Reads the request head, then hands the connection to an agent or to the relay's own server. */
  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), this.config.limits.headTimeoutMs);
    socket.on('error', () => {});
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffered.length > MAX_HEAD) {
          clearTimeout(timer);
          socket.off('data', onData);
          socket.end(plainResponse(431, 'Request Header Fields Too Large', 'Too large.', 'text/plain'));
        }
        return;
      }
      clearTimeout(timer);
      socket.pause();
      socket.off('data', onData);
      const head = buffered.subarray(0, end + 4).toString('latin1');
      this.route(socket, head, buffered.subarray(end + 4));
    };
    socket.on('data', onData);
  }

  private route(socket: net.Socket, head: string, rest: Buffer): void {
    const host = headerOf(head, 'host')?.replace(/:\d+$/, '').toLowerCase() ?? '';
    const entry = this.byHost.get(host);
    if (!entry) {
      // Not a public host: the relay's own (health, /agent), or a name it doesn't know (the offline page).
      socket.unshift(Buffer.concat([Buffer.from(head, 'latin1'), rest]));
      this.own.emit('connection', socket);
      socket.resume();
      return;
    }
    if (entry.tls === 'passthrough') {
      // The proxy ended TLS for a name that must reach its Ledung still encrypted: a half-done proxy
      // config. Refused out loud rather than carried, or the proxy would read it all (relay-e2e.md piece 2).
      this.event('stream refused', { agent: entry.name, reason: 'passthrough name on the HTTP listener', from: this.addressOf(socket, headerOf(head, 'x-forwarded-for')) });
      socket.end(plainResponse(421, 'Misdirected Request', 'This name is passed through to its Ledung encrypted; the proxy in front of the relay must not end TLS for it.', 'text/plain'));
      return;
    }
    const agent = this.online.get(entry.name);
    if (!agent) {
      socket.end(plainResponse(503, 'Service Unavailable', OFFLINE_PAGE));
      return;
    }
    if (agent.streams.size >= this.config.limits.maxStreamsPerAgent) {
      this.event('stream refused', { agent: entry.name, reason: 'too many streams', from: this.addressOf(socket, headerOf(head, 'x-forwarded-for')) });
      socket.end(plainResponse(503, 'Service Unavailable', 'Too many connections to this Ledung at once; try again.', 'text/plain'));
      return;
    }
    this.openStream(agent, socket, Buffer.concat([Buffer.from(forwardHead(head), 'latin1'), rest]));
  }

  private openStream(agent: Agent, socket: net.Socket, first: Buffer): void {
    const id = agent.nextId;
    agent.nextId = agent.nextId >= 0xffffffff ? 1 : agent.nextId + 1;
    agent.ws.send(encodeFrame(FRAME.open, id));
    agent.streams.attach(id, socket, first);
    socket.resume();
  }

  /**
   * A connection on the passthrough listener: the PROXY v2 header, then the ClientHello, read only far
   * enough to find the name. Everything after the PROXY header goes to the agent unchanged, the
   * ClientHello included; the relay never answers it, so TLS can only end at the Ledung.
   */
  private onPassthrough(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    // Only the proxy may speak for a phone: anyone else could write any address into the PROXY header
    // (review 205, Martin 2026-10-18 #283 "Check the sender"). Closed before a byte is read.
    if (!this.trustedSender(socket.remoteAddress)) {
      this.event('passthrough closed', { reason: 'sender not trusted', from: socket.remoteAddress ?? 'unknown' });
      socket.destroy();
      return;
    }
    let buffered = Buffer.alloc(0);
    let from = socket.remoteAddress ?? 'unknown';
    let afterProxy = -1;
    const timer = setTimeout(() => socket.destroy(), this.config.limits.headTimeoutMs);
    const stop = () => {
      clearTimeout(timer);
      socket.off('data', onData);
    };
    // No page and no TLS alert: the relay has no certificate to speak TLS with (spike #199, finding 1).
    const close = (reason: string, sni?: string) => {
      stop();
      this.event('passthrough closed', { reason, sni, from });
      socket.destroy();
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (afterProxy < 0) {
        const proxy = readProxyHeader(buffered);
        if (proxy.state === 'bad') return close(proxy.reason);
        if (proxy.state === 'more') return;
        // The phone's address, from the proxy: what the logs and a per-address cap (#167) go by.
        if (proxy.address) from = proxy.address;
        afterProxy = proxy.length;
      }
      const tlsBytes = buffered.subarray(afterProxy);
      const hello = readClientHello(tlsBytes);
      if (hello.state === 'bad') return close(hello.reason);
      // Each reader refuses what is too long for it; this is the backstop.
      if (hello.state === 'more') return void (buffered.length > MAX_PASSTHROUGH_HEAD && close('too large'));
      if (!hello.sni) return close('no name');
      const entry = this.byHost.get(hello.sni);
      // A name the relay knows but doesn't pass through closes the same way as one it doesn't know.
      if (!entry || entry.tls !== 'passthrough') return close('unknown name', hello.sni);
      const agent = this.online.get(entry.name);
      if (!agent) return close('offline', hello.sni);
      stop();
      if (agent.streams.size >= this.config.limits.maxStreamsPerAgent) {
        this.event('stream refused', { agent: entry.name, reason: 'too many streams', from });
        socket.destroy();
        return;
      }
      socket.pause();
      this.openStream(agent, socket, tlsBytes);
    };
    socket.on('data', onData);
  }

  private addressOf(socket: net.Socket, forwarded: string | undefined): string {
    if (this.config.trustProxy) {
      const last = forwarded?.split(',').pop()?.trim();
      if (last) return last;
    }
    return socket.remoteAddress ?? 'unknown';
  }

  private blocked(address: string): boolean {
    const f = this.failures.get(address);
    if (!f) return false;
    if (Date.now() - f.since > this.config.limits.attemptWindowSeconds * 1000) {
      this.failures.delete(address);
      return false;
    }
    return f.count >= this.config.limits.failedAttemptsPerAddress;
  }

  private failed(address: string): void {
    const now = Date.now();
    const f = this.failures.get(address);
    if (!f || now - f.since > this.config.limits.attemptWindowSeconds * 1000) this.failures.set(address, { count: 1, since: now });
    else f.count++;
    // Bounded: a flood of addresses can't grow it without end.
    if (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value!);
  }

  private onAgent(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const forwarded = req.headers['x-forwarded-for'];
    const from = this.addressOf(socket, Array.isArray(forwarded) ? forwarded.join(',') : forwarded);
    const refuse = (status: number, reason: string, name?: string) => {
      this.event('agent refused', { name, reason, from });
      socket.end(plainResponse(status, status === 429 ? 'Too Many Requests' : status === 404 ? 'Not Found' : 'Unauthorized', '', 'text/plain'));
    };
    const url = new URL(req.url ?? '/', 'http://relay');
    if (url.pathname !== '/agent') return refuse(404, 'not /agent');
    if (this.blocked(from)) return refuse(429, 'too many failed attempts');
    const name = String(req.headers[AGENT_NAME_HEADER] ?? '');
    const secret = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
    const entry = this.byName.get(name);
    if (!entry || !secret || !secretMatches(secret, entry)) {
      this.failed(from);
      return refuse(401, entry ? 'wrong secret' : 'unknown name', name.slice(0, 64) || undefined);
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.awaitHello(entry, ws, from));
  }

  /** The agent's first message must be a hello in a version this relay speaks; only then do phones reach it. */
  private awaitHello(entry: AgentEntry, ws: WebSocket, from: string): void {
    const refuse = (code: number, reason: string) => {
      this.event('agent refused', { name: entry.name, reason, from });
      ws.close(code, reason);
    };
    const timer = setTimeout(() => refuse(1002, 'No hello.'), HELLO_MS);
    ws.on('error', () => {});
    ws.once('close', () => clearTimeout(timer));
    ws.once('message', (data: Buffer, isBinary: boolean) => {
      clearTimeout(timer);
      const version = isBinary ? null : helloVersion(data.toString('utf8'));
      if (version === null) return refuse(1002, 'No hello.');
      if (version !== PROTOCOL_VERSION) return refuse(4001, `Protocol version ${version} is not supported; this relay speaks ${PROTOCOL_VERSION}.`);
      // Removed (or removed and added again with a new secret) while it signed in: the secret it signed in
      // with is no longer the relay's, so it must not become the tunnel (PR #238 review finding 1).
      if (this.byName.get(entry.name) !== entry) return refuse(4003, 'Removed from the relay.');
      ws.send(helloMessage());
      this.register(entry, ws, from);
    });
  }

  private register(entry: AgentEntry, ws: WebSocket, from: string): void {
    const previous = this.online.get(entry.name);
    if (previous) {
      // The same Ledung back after a dropped connection, or a second copy: the newest wins.
      this.event('agent replaced', { name: entry.name, owner: entry.owner });
      this.online.delete(entry.name);
      previous.streams.closeAll();
      previous.ws.close(4000, 'Replaced by a newer connection.');
    }
    const agent: Agent = { entry, ws, streams: new Streams(ws), nextId: 1, alive: true };
    this.online.set(entry.name, agent);
    this.event('agent connected', { name: entry.name, owner: entry.owner, host: entry.host, tls: entry.tls, from });
    ws.on('pong', () => {
      agent.alive = true;
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      // Text after the hello is for later messages (status); none are defined yet.
      if (!isBinary) return;
      const frame = decodeFrame(data);
      // Only the relay opens streams; anything else from the agent ends its connection.
      if (!frame || frame.kind === FRAME.open || !agent.streams.receive(frame.kind, frame.id, frame.payload)) {
        ws.close(1002, 'Bad frame.');
      }
    });
    ws.on('close', (code) => {
      agent.streams.closeAll();
      if (this.online.get(entry.name) !== agent) return;
      this.online.delete(entry.name);
      this.event('agent disconnected', { name: entry.name, owner: entry.owner, code });
    });
  }

  private ping(): void {
    for (const agent of this.online.values()) {
      if (!agent.alive) {
        agent.ws.terminate();
        continue;
      }
      agent.alive = false;
      agent.ws.ping();
    }
  }
}

/** An admin or enrolment request's JSON body: a small object, or a 400. */
function readApiBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Answered at once, and the connection closed with the answer; the rest is not kept.
      if (size > MAX_API_BODY) return void reject(new ApiError(413, 'Too large.'));
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body as Record<string, unknown>);
      } catch {
        reject(new ApiError(400, 'Send a JSON object.'));
      }
    });
  });
}

function headerOf(head: string, name: string): string | undefined {
  const match = new RegExp(`\\r\\n${name}[ \\t]*:[ \\t]*([^\\r\\n]*)`, 'i').exec(head);
  return match?.[1]?.trim();
}

const ADMIN_USAGE = [
  'node relay.ts add --hash <64 hex digits> --owner <who> [--name <name>] [--host <host>]',
  'node relay.ts remove <name>',
  'node relay.ts list',
].join('\n');

/** `add`, `remove` or `list` and their options, as an admin request; throws the usage on anything else. */
export function parseAdminArgs(args: string[]): AdminRequest {
  const [op, ...rest] = args;
  const usage = (problem: string) => new Error(`${problem}\n\n${ADMIN_USAGE}`);
  if (op === 'list') {
    if (rest.length) throw usage('list takes nothing more.');
    return { op: 'list' };
  }
  if (op === 'remove') {
    if (rest.length !== 1 || rest[0]!.startsWith('--')) throw usage('remove takes the name only.');
    return { op: 'remove', name: rest[0]! };
  }
  if (op !== 'add') throw usage(`Unknown command: ${op ?? '(none)'}.`);
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!;
    const value = rest[i + 1];
    if (!['--hash', '--owner', '--name', '--host', '--tls'].includes(key)) throw usage(`Unknown option: ${key}.`);
    if (value === undefined || value.startsWith('--')) throw usage(`${key} needs a value.`);
    options[key.slice(2)] = value;
  }
  if (!options.hash || !options.owner) throw usage('add needs --hash and --owner.');
  return { op: 'add', hash: options.hash, owner: options.owner, name: options.name, host: options.host, tls: options.tls };
}

/** Sends one request to the running relay on its admin socket. */
export function sendAdmin(request: AdminRequest, socketPath = adminSocketPath()): Promise<AdminReply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let answer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      answer += chunk;
    });
    socket.on('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
        ? new Error(`No relay is running here (no admin socket at ${socketPath}). Run this where the relay runs, e.g. docker exec ledung-relay node relay.ts list.`)
        : e);
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(answer) as AdminReply);
      } catch {
        reject(new Error('The relay gave no readable answer.'));
      }
    });
  });
}

/** What the admin sees for a reply; for an add, the block the computer's owner pastes. */
export function adminText(reply: AdminReply): string {
  if (!reply.ok) return reply.error;
  if (reply.op === 'list') {
    if (!reply.agents.length) return 'No computers.';
    const rows = [['NAME', 'OWNER', 'HOST', 'TLS', 'FROM', 'CONNECTED'], ...reply.agents.map((a) => [a.name, a.owner, a.host, a.tls, a.from, a.connected ? 'yes' : 'no'])];
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
    return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
  }
  if (reply.op === 'remove') return `Removed "${reply.agent.name}" (${reply.agent.host})${reply.wasConnected ? ' and disconnected it' : ''}.`;
  const a = reply.agent;
  // The owner's Ledung ends TLS itself and gets its certificate by ACME through the relay (relay-e2e.md 3a, 3b).
  const block = {
    remote: { relay: reply.relayUrl ?? 'wss://<the relay\'s name>', name: a.name, publicName: a.host, secret: '<the secret remote-secret printed for you>', tls: 'required', acme: 'production' },
  };
  return [
    `Added "${a.name}" for ${a.owner}, at ${a.host}, end to end ("tls": "passthrough"). It can connect now.`,
    '',
    `Send this to ${a.owner}, for the config of the Ledung on that computer (ledung.config.local.json). The secret stays theirs:`,
    '',
    JSON.stringify(block, null, 2).split('\n').slice(1, -1).join('\n'),
    '',
    `Then: once their Ledung has restarted, Settings shows a CAA line for ${a.host}; add that CAA record in the DNS, or it can't get its certificate.`,
  ].join('\n');
}

async function main(): Promise<void> {
  if (['add', 'remove', 'list'].includes(process.argv[2] ?? '')) {
    const reply = await sendAdmin(parseAdminArgs(process.argv.slice(2)));
    if (!reply.ok) throw new Error(reply.error);
    console.log(adminText(reply));
    return;
  }
  if (process.argv[2] === 'hash') {
    // The secret comes on standard input, so it isn't left in the shell's history.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const secret = Buffer.concat(chunks).toString('utf8').trim();
    if (!secret) throw new Error('Give the secret on standard input: echo <secret> | node relay.ts hash');
    console.log(hashSecret(secret));
    return;
  }
  const file = process.argv[2] ?? process.env.RELAY_CONFIG ?? 'relay.config.json';
  const config = parseRelayConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  // Beside the config by default; in the container RELAY_STORE puts it in a writable volume, since the config is mounted read-only.
  const store = process.env.RELAY_STORE || path.join(path.dirname(path.resolve(file)), 'relay.added.json');
  // Invites and joined computers (#237) next to the store, in the same writable place.
  const invites = process.env.RELAY_INVITES || path.join(path.dirname(path.resolve(store)), 'relay.invites.json');
  const relay = new Relay(config, undefined, { store, invites });
  const port = await relay.listen();
  await relay.listenAdmin();
  const passthrough = relay.passthroughPort();
  console.log(`${new Date().toISOString()} relay listening port=${port}${passthrough === null ? '' : ` passthroughPort=${passthrough}`} agents=${relay.list().length} store=${JSON.stringify(store)}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void relay.close().then(() => process.exit(0)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
