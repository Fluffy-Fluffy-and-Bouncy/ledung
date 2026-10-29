// Who may use Ledung's page and API (issue #4).
//
// Ledung listens on 127.0.0.1 only, unless the config opens it to the local network ("lan"); then it
// also listens on, and answers to, this computer's network address(es). With "lanSignIn": false,
// requests through those addresses need no sign-in: the network itself is trusted. Every request must:
// - name Ledung itself in its Host header, which stops DNS rebinding;
// - carry the sign-in cookie, set by opening the one-time /login link Ledung prints and opens;
// - for anything that changes something, and for the live connection, come from Ledung's own page
//   (Origin header), which stops other websites from sending requests in the background.
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

  /**
   * `lanNames`: extra names Ledung answers to on the local network (empty when it isn't opened to it).
   * `lanOpen`: requests through those names need no sign-in.
   * `remote`: the public name and how a device cookie is checked; null: no public name.
   */
  constructor(token: string, port: number, lanNames: string[] = [], lanOpen = false, remote: PublicAccess<D> | null = null) {
    this.token = Buffer.from(token);
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

  /** The install's token cookie; never counts through the public name. */
  signedIn(req: IncomingMessage): boolean {
    return !this.isPublic(req) && this.tokenMatches(readCookie(req, COOKIE_NAME));
  }

  cookieHeader(): string {
    return `${COOKIE_NAME}=${this.token.toString()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
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
