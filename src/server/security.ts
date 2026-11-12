// Who may use Ledung's page and API (issue #4).
//
// Ledung listens on 127.0.0.1 only, unless the config opens it to the local network ("lan"); then it
// also listens on, and answers to, this computer's network address(es). With "lanSignIn": false,
// requests through those addresses need no sign-in: the network itself is trusted. Every request must:
// - name Ledung itself in its Host header, which stops DNS rebinding;
// - carry the sign-in cookie, set by opening the one-time /login link Ledung prints and opens. The cookie is a
//   sign-in of its own, random, kept here only as a hash and revocable, never the install token
//   (Project-Ledung#476). A browser still holding the older cookie that was the token is let in, and its next
//   page load swaps that cookie for a sign-in (oldTokenCookie), so nobody is signed out by the change;
// - for anything that changes something, for the live connection, and for API reads that do work, come from
//   Ledung's own page (Origin header, and Sec-Fetch-Site where the browser sends it), which stops other pages
//   from sending requests in the background.
//
// The public name (issue #160, docs/steps/relay.md step 3): nothing here trusts the address a request came
// from. A request is the public name's when its Host is that name, or when it came through the relay tunnel
// whatever Host it claims: the tunnel hands its connections to the server in this process, marked
// (markTunnel, read by isPublic; Martin, 2026-10-17, question #219). Through the public name:
// the Host is exactly that name, the Origin exactly https://<name>, and only a live paired device's cookie
// signs in. The install token and "lanSignIn": false never do there.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { userDataDir } from '../platform/paths.ts';
import { runningProof } from '../platform/running.ts';
import { DEVICE_COOKIE } from './devices.ts';

export const COOKIE_NAME = 'ledung_auth';

/** Where sign-ins are kept between restarts: one JSON text (the store's meta table, in the server). */
export interface SignInStore {
  get(): string | null;
  set(value: string): void;
}

/** How many sign-ins are kept; past it the one used longest ago goes (each sign-in link opened adds one). */
export const MAX_SIGN_INS = 200;
/** A sign-in's last use is written down at most this often, so a busy page doesn't write on every request. */
const USE_NOTED_MS = 86_400_000;
/** A sign-in unused this long ends, as its cookie does (Max-Age a year). */
const SIGN_IN_UNUSED_MS = 365 * 86_400_000;

const hashOf = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

/** The per-install secret, created on first run and kept in the user data folder. */
export function loadOrCreateToken(file = path.join(userDataDir(), 'auth-token')): string {
  if (fs.existsSync(file)) {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(token)) return token;
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/** Through the public name: the name, and the live device a cookie belongs to (src/server/devices.ts). */
export interface PublicAccess<D> {
  publicName: string;
  device(cookie: string | null): D | null;
}

export class Guard<D = unknown> {
  private readonly token: Buffer;
  private readonly port: number;
  private readonly lanNames: string[];
  private hosts = new Set<string>();
  private origins = new Set<string>();
  private lanHosts = new Set<string>();
  private readonly lanOpen: boolean;
  private remote: PublicAccess<D> | null = null;
  /** Sockets that came through the relay tunnel; see isPublic. */
  private readonly tunnel = new WeakSet<object>();
  /** Live sign-ins: the hash of each cookie value and when it was last used (ms); never the values themselves. */
  private signIns = new Map<string, number>();
  private signInStore: SignInStore | null = null;
  private readonly now: () => number;

  /**
   * `lanNames`: extra names Ledung answers to on the local network (empty when it isn't opened to it).
   * `lanOpen`: requests through those names need no sign-in.
   * `remote`: the public name and how a device cookie is checked; null: no public name.
   */
  constructor(token: string, port: number, lanNames: string[] = [], lanOpen = false, remote: PublicAccess<D> | null = null, now: () => number = Date.now) {
    this.token = Buffer.from(token);
    this.now = now;
    this.port = port;
    this.lanNames = lanNames.map((n) => n.toLowerCase());
    this.lanOpen = lanOpen;
    this.setRemote(remote);
  }

  /** The public name changed: joining or leaving a relay from Settings (issue #237), with no restart. */
  setRemote(remote: PublicAccess<D> | null): void {
    this.remote = remote;
    // The public name is never a local-network name, whatever the network reports, so lanOpen can't open it.
    const lan = this.lanNames.filter((n) => n !== remote?.publicName);
    const names = ['127.0.0.1', 'localhost', ...lan];
    this.hosts = new Set(names.map((n) => `${n}:${this.port}`));
    this.origins = new Set(names.map((n) => `http://${n}:${this.port}`));
    this.lanHosts = new Set(lan.map((n) => `${n}:${this.port}`));
  }

  /**
   * The request came in through the public name: exactly the name, as browsers send it for HTTPS on 443.
   * No port and no other spelling, so a lookalike or "<name>:4317" is an unknown host.
   */
  isPublic(req: IncomingMessage): boolean {
    // Anything that came through the relay is a phone, whatever Host it claims (Martin, #160, 13:31, question
    // #219: "a — Mark tunnel traffic as public in Ledung"; review 165 finding 2).
    if (this.tunnelled(req)) return true;
    return !!this.remote && (req.headers.host ?? '').toLowerCase() === this.remote.publicName;
  }

  /** A connection the relay tunnel handed to the server (LedungServer.tunnelConnection), never a local one. */
  markTunnel(socket: object): void {
    this.tunnel.add(socket);
  }

  private tunnelled(req: IncomingMessage): boolean {
    return this.tunnel.has(req.socket);
  }

  /** The live device signed in through the public name, or null (always null for local requests). */
  deviceOf(req: IncomingMessage): D | null {
    if (!this.remote || !this.isPublic(req)) return null;
    for (const cookie of readCookies(req, DEVICE_COOKIE)) {
      const device = this.remote.device(cookie);
      if (device) return device;
    }
    return null;
  }

  /** Signed in, or come in through a trusted network address; through the public name, a live paired device only. */
  mayUse(req: IncomingMessage): boolean {
    if (this.isPublic(req)) return this.deviceOf(req) !== null;
    return this.signedIn(req) || (this.lanOpen && this.lanHosts.has((req.headers.host ?? '').toLowerCase()));
  }

  hostAllowed(req: IncomingMessage): boolean {
    // Through the tunnel with no public name configured: nothing it could be allowed as.
    if (this.isPublic(req)) return !!this.remote;
    return this.hosts.has((req.headers.host ?? '').toLowerCase());
  }

  /**
   * True only when the request says it comes from Ledung's own page, on the kind of name it was sent to:
   * through the public name only https://<name>; locally never that one.
   */
  originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (typeof origin !== 'string') return false;
    if (this.isPublic(req)) return !!this.remote && origin.toLowerCase() === `https://${this.remote.publicName}`;
    return this.origins.has(origin.toLowerCase());
  }

  tokenMatches(candidate: string | undefined | null): boolean {
    if (!candidate) return false;
    const given = Buffer.from(candidate);
    return given.length === this.token.length && crypto.timingSafeEqual(given, this.token);
  }

  /** The launchers' proof that this Ledung holds the token, for their nonce (src/platform/running.ts). */
  runningProof(nonce: string): string {
    return runningProof(this.token.toString(), nonce);
  }

  /**
   * A live sign-in's cookie, or the older cookie that was the install token (oldTokenCookie); never through the
   * public name. A browser can send two values under the name (two paths or spellings), so each is tried.
   */
  signedIn(req: IncomingMessage): boolean {
    if (this.isPublic(req)) return false;
    return readCookies(req, COOKIE_NAME).some((value) => this.tokenMatches(value) || this.useSignIn(value));
  }

  /**
   * The request carries the cookie set before Project-Ledung#476, whose value was the install token. It still signs
   * in, so the change signs nobody out; the server answers a page load that carries it with a sign-in cookie, which
   * replaces it in that browser (same name, host and path).
   */
  oldTokenCookie(req: IncomingMessage): boolean {
    return !this.isPublic(req) && readCookies(req, COOKIE_NAME).some((value) => this.tokenMatches(value));
  }

  /** Where sign-ins are kept between restarts; loads the ones it holds. Without one they last until Ledung stops. */
  useSignInStore(store: SignInStore): void {
    this.signInStore = store;
    const loaded = new Map<string, number>();
    try {
      const saved = JSON.parse(store.get() ?? '{}') as Record<string, unknown>;
      for (const [hash, used] of Object.entries(saved)) if (/^[0-9a-f]{64}$/.test(hash) && typeof used === 'number') loaded.set(hash, used);
    } catch {
      // Unreadable: no sign-in cookie counts; the sign-in link still works.
    }
    this.signIns = loaded;
    if (this.prune()) this.save();
  }

  /** A new sign-in, as the Set-Cookie header that gives it to the browser. */
  signInCookie(): string {
    const value = crypto.randomBytes(32).toString('hex');
    this.signIns.set(hashOf(value), this.now());
    this.prune();
    this.save();
    return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
  }

  /** Ends one sign-in (by its cookie's value), or with none given every one; returns how many ended. */
  revokeSignIns(value?: string): number {
    const before = this.signIns.size;
    if (value === undefined) this.signIns.clear();
    else this.signIns.delete(hashOf(value));
    const ended = before - this.signIns.size;
    if (ended) this.save();
    return ended;
  }

  signInCount(): number {
    return this.signIns.size;
  }

  /** Whether a cookie value is a live sign-in; notes its use at most once a day. Looked up by hash, so no timing tells. */
  private useSignIn(value: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(value)) return false;
    const hash = hashOf(value);
    const used = this.signIns.get(hash);
    if (used === undefined) return false;
    const now = this.now();
    if (now - used > SIGN_IN_UNUSED_MS) {
      this.signIns.delete(hash);
      this.save();
      return false;
    }
    if (now - used > USE_NOTED_MS) {
      this.signIns.set(hash, now);
      this.save();
    }
    return true;
  }

  /** Drops sign-ins unused for a year, then the least recently used past MAX_SIGN_INS; true when any went. */
  private prune(): boolean {
    const before = this.signIns.size;
    const now = this.now();
    for (const [hash, used] of this.signIns) if (now - used > SIGN_IN_UNUSED_MS) this.signIns.delete(hash);
    if (this.signIns.size > MAX_SIGN_INS) {
      const oldest = [...this.signIns].sort((a, b) => a[1] - b[1]).slice(0, this.signIns.size - MAX_SIGN_INS);
      for (const [hash] of oldest) this.signIns.delete(hash);
    }
    return this.signIns.size !== before;
  }

  private save(): void {
    this.signInStore?.set(JSON.stringify(Object.fromEntries(this.signIns)));
  }

  /**
   * As far as the browser tells, the request comes from Ledung's own page or the person's own address bar: an Origin,
   * when sent, is Ledung's (originAllowed), and Sec-Fetch-Site, when sent, is "same-origin" or "none" (a typed address
   * or a bookmark). Asked of API reads that do work (Project-Ledung#476). A client that sends neither header is taken
   * as no browser page; it still needs the cookie. `siteOnly`: ask only Sec-Fetch-Site (server.ts SITE_ONLY_READS).
   */
  fromOwnPage(req: IncomingMessage, siteOnly = false): boolean {
    if (!siteOnly && req.headers.origin !== undefined && !this.originAllowed(req)) return false;
    const site = req.headers['sec-fetch-site'];
    return site === undefined || site === 'same-origin' || site === 'none';
  }
}

/**
 * The device cookie, set only through the public name, so always Secure (HTTPS at the relay). `framed`: paired inside
 * a frame on another computer's page (issue #241). A Strict cookie is never sent into a frame on another site (that
 * computer's local page, http://127.0.0.1), and a plain third-party one is blocked, so that device's cookie is
 * Partitioned: the browser keeps it only for this name as framed by pages of that one site, and sends it nowhere
 * else (spike, docs/steps/computer-tabs-in-page-spike).
 */
export function deviceCookieHeader(value: string, framed = false): string {
  return `${DEVICE_COOKIE}=${value}; Secure; HttpOnly; ${framed ? 'SameSite=None; Partitioned' : 'SameSite=Strict'}; Path=/; Max-Age=31536000`;
}

export function readCookie(req: IncomingMessage, name: string): string | null {
  return readCookies(req, name)[0] ?? null;
}

/** Every value a cookie name has: a browser can hold a device's Strict cookie and a framed one's Partitioned one (#241). */
export function readCookies(req: IncomingMessage, name: string): string[] {
  const found: string[] = [];
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) found.push(v.join('='));
  }
  return found;
}

/**
 * Headers for every response: no embedding in other pages (no clickjacking of Allow), strict sources.
 * imageHosts: hosts pictures may load from. publicName: its page's live connection is wss on that name.
 * frames (issue #241): `sources`, the other computers' pages this page may show in a frame (https://<their name>);
 * `ancestors`, the pages that may show this one in a frame, given only for responses through the public name.
 * Exact origins from the config's computers; with none, nobody may frame it, as before.
 */
export function securityHeaders(port: number, lanNames: string[] = [], imageHosts: string[] = [], publicName?: string, frames: { sources?: string[]; ancestors?: string[] } = {}): Record<string, string> {
  const ancestors = frames.ancestors ?? [];
  const sources = frames.sources ?? [];
  const live = [...['127.0.0.1', 'localhost', ...lanNames].map((n) => `ws://${n}:${port}`), ...(publicName ? [`wss://${publicName}`] : [])];
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      `connect-src 'self' ${live.join(' ')}`,
      // Extra hosts only for the board's people list (their pictures, decision 5 of the message board).
      `img-src ${["'self'", 'data:', ...imageHosts].join(' ')}`,
      "style-src 'self' 'unsafe-inline'",
      `frame-ancestors ${ancestors.length ? ancestors.join(' ') : "'none'"}`,
      ...(sources.length ? [`frame-src 'self' ${sources.join(' ')}`] : []),
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    // Older browsers know only this header; it can't list pages, so it goes only when some may frame this one.
    ...(ancestors.length ? {} : { 'X-Frame-Options': 'DENY' }),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}
