// Ledung's own certificate for its public name, by ACME TLS-ALPN-01 through the relay (issue #202,
// docs/steps/relay-e2e.md 3b and build plan step 4). Let's Encrypt connects to the name with ALPN acme-tls/1; the
// relay passes that through the tunnel and Ledung answers with the one-off challenge certificate (server.ts).
//
// The lock is a CAA record naming this Ledung's ACME account (decision C1, Martin 2026-10-18 12:43). The account
// URL exists only once the account does, so Ledung makes the account, then waits in "waiting-caa", looking the
// record up itself every minute (and on Check now), and orders only once it names the account: under the lock an
// earlier order would only fail and count against Let's Encrypt's limit of failed validations.
//
// Nothing here runs before the tunnel connects: every order is validated through it, and a relay that is down
// never holds up the start. The files live in remoteDir(): acme-account.key, acme.json, and tls.key and tls.crt,
// which server.ts reads.
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import acme from 'acme-client';
import type { CertificateStatus } from '../shared/protocol.ts';
import { certificateProblem, TLS_CERT, TLS_KEY } from './tunnel-tls.ts';

export const ACCOUNT_KEY = 'acme-account.key';
export const ACME_STATE = 'acme.json';

export type AcmeMode = CertificateStatus['acme'];

export const DIRECTORIES: Record<Exclude<AcmeMode, 'pebble'>, string> = {
  staging: acme.directory.letsencrypt.staging,
  production: acme.directory.letsencrypt.production,
};

/** The CA's name in the CAA record. Pebble never checks CAA (spike #199), so the record shown is Let's Encrypt's. */
const CAA_ISSUER = 'letsencrypt.org';
const TLS_ALPN = 'tls-alpn-01';
const MINUTE = 60_000;
/** How often the CAA record is looked up while waiting for it (relay-e2e.md 3b). */
export const CAA_EVERY = MINUTE;
/** How often a valid certificate is looked at (relay-e2e.md 3b: at start and every 12 hours). */
export const CHECK_EVERY = 12 * 60 * MINUTE;
/** The waits after the first, second, third and every later failed order (relay-e2e.md 3b, rate limits). */
export const BACKOFF = [MINUTE, 5 * MINUTE, 30 * MINUTE, 60 * MINUTE];

/** The part of acme-client's Client used here, so tests can stand in for the ACME server. */
export interface AcmeClient {
  createAccount(data: { termsOfServiceAgreed: true } | { onlyReturnExisting: true }): Promise<unknown>;
  getAccountUrl(): string;
  createOrder(data: { identifiers: { type: string; value: string }[] }): Promise<acme.Order>;
  getAuthorizations(order: acme.Order): Promise<acme.Authorization[]>;
  getChallengeKeyAuthorization(challenge: AcmeChallenge): Promise<string>;
  completeChallenge(challenge: AcmeChallenge): Promise<unknown>;
  waitForValidStatus(item: AcmeChallenge | acme.Order): Promise<unknown>;
  finalizeOrder(order: acme.Order, csr: Buffer): Promise<acme.Order>;
  getCertificate(order: acme.Order): Promise<string>;
}
type AcmeChallenge = acme.Authorization['challenges'][number];

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface CertificateOptions {
  /** remoteDir(). */
  dir: string;
  publicName: string;
  acme: AcmeMode;
  /** The directory URL; for staging and production, Let's Encrypt's. */
  directoryUrl: string;
  /** Looks up the public name's CAA records; default the system's resolver (Pebble: the mock DNS). */
  resolveCaa?: (name: string) => Promise<dns.CaaRecord[]>;
  /** Default acme-client's own; tests give a fake. */
  client?: (directoryUrl: string, accountKey: Buffer) => AcmeClient;
  /** The challenge certificate to answer acme-tls/1 with while an order is open; null: none open. */
  challenge: (pair: { key: Buffer; cert: Buffer } | null) => void;
  /** tls.key and tls.crt were replaced: load them. */
  issued: () => void;
  onStatus: (status: CertificateStatus) => void;
  now?: () => number;
  timers?: Timers;
}

/** What acme.json keeps: the account per directory, and the failures so a restart doesn't skip the back-off. */
interface Saved {
  accounts: Record<string, string>;
  /**
   * The directory tls.crt came from. A certificate from another one (staging, then "acme": "production") is
   * replaced like a missing one, or a switch keeps the untrusted staging certificate for months (#214). None: put
   * there by hand, or before this was kept; used as it is.
   */
  issuedBy: string | null;
  failures: number;
  nextTry: number | null;
  error: string | null;
}

/** A resolver that asks `server` ("host:port") instead of the system's. */
export function caaResolver(server?: string): (name: string) => Promise<dns.CaaRecord[]> {
  if (!server) return (name) => dns.promises.resolveCaa(name);
  const resolver = new dns.promises.Resolver();
  resolver.setServers([server]);
  return (name) => resolver.resolveCaa(name);
}

/** The line to add to the DNS zone: only this account may get a certificate for the name, and only by TLS-ALPN-01. */
export function caaRecord(publicName: string, accountUrl: string): string {
  return `${publicName}. CAA 0 issue "${caaValue(accountUrl)}"`;
}

/** The issue record's value alone, as Cloudflare's API takes it (issue #237, Approve). */
export function caaValue(accountUrl: string): string {
  return `${CAA_ISSUER}; accounturi=${accountUrl}; validationmethods=${TLS_ALPN}`;
}

/**
 * Whether the name's CAA records let this account order by TLS-ALPN-01 (RFC 8659, RFC 8657): an issue record for
 * Let's Encrypt whose accounturi is exactly the URL the ACME server gave (never built or pattern-matched: Pebble's
 * look different, spike #199), and whose validationmethods, if any, include tls-alpn-01.
 */
export function caaAllows(records: dns.CaaRecord[], accountUrl: string): boolean {
  return records.some((r) => {
    if (typeof r.issue !== 'string') return false;
    const [issuer = '', ...params] = r.issue.split(';').map((p) => p.trim());
    if (issuer.toLowerCase() !== CAA_ISSUER) return false;
    const values = new Map(params.filter(Boolean).map((p) => {
      const at = p.indexOf('=');
      return at < 0 ? [p.toLowerCase(), ''] : [p.slice(0, at).trim().toLowerCase(), p.slice(at + 1).trim()];
    }));
    if (values.get('accounturi') !== accountUrl) return false;
    const methods = values.get('validationmethods');
    return methods === undefined || methods.split(',').map((m) => m.trim()).includes(TLS_ALPN);
  });
}

/** Where a certificate's life is at: valid until notAfter, renewed at two-thirds of it (relay-e2e.md 3b). */
export function lifetime(cert: Buffer | string): { validFrom: number; validUntil: number; renewAt: number } {
  const x = new crypto.X509Certificate(cert);
  const validFrom = Date.parse(x.validFrom);
  const validUntil = Date.parse(x.validTo);
  return { validFrom, validUntil, renewAt: validFrom + Math.round((validUntil - validFrom) * 2 / 3) };
}

export class CertificateManager {
  private readonly opts: CertificateOptions;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly resolveCaa: (name: string) => Promise<dns.CaaRecord[]>;
  private status: CertificateStatus;
  private connected = false;
  private running = false;
  /** Asked again while a run was going: one more run when it ends. */
  private again = false;
  private timer: unknown = null;
  private stopped = false;
  /** Made once per start, on the first connect: createAccount also confirms the account still exists. */
  private client: AcmeClient | null = null;

  constructor(opts: CertificateOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? { set: (fn, ms) => setTimeout(fn, ms).unref(), clear: (h) => clearTimeout(h as NodeJS.Timeout) };
    this.resolveCaa = opts.resolveCaa ?? caaResolver();
    const saved = this.saved();
    const accountUrl = saved.accounts[opts.directoryUrl] ?? null;
    this.status = {
      state: 'offline', acme: opts.acme, accountUrl, record: accountUrl ? caaRecord(opts.publicName, accountUrl) : null,
      validUntil: null, renewAt: null, error: saved.error, nextTry: null,
    };
    // Only the files: what is in use now, for Settings. Nothing goes over the network before the tunnel connects.
    const current = this.current();
    if (current) this.status = { ...this.status, state: 'valid', validUntil: current.validUntil, renewAt: current.renewAt };
  }

  get(): CertificateStatus {
    return this.status;
  }

  /** The tunnel is up: look at the certificate now (an expired one renews within the minute, relay-e2e.md 3b). */
  setConnected(connected: boolean): void {
    this.connected = connected;
    if (connected) this.run();
  }

  /** Settings' Check now: look the CAA record up at once instead of at the next minute. */
  checkNow(): CertificateStatus {
    if (this.status.state === 'waiting-caa') this.run();
    return this.status;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private run(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.step().catch((e) => {
      // A bug, not an ACME failure (those are caught in order()): say it, and look again in a while.
      console.log(`Certificate: ${(e as Error).message}`);
      this.later(CHECK_EVERY);
    }).finally(() => {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.run();
      }
    });
  }

  private later(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.run();
    }, Math.max(0, ms));
  }

  private async step(): Promise<void> {
    const now = this.now();
    const current = this.current();
    // A usable certificate not yet at two-thirds: nothing to order (a start with one orders nothing).
    if (current && now < current.renewAt) {
      this.set({ state: 'valid', validUntil: current.validUntil, renewAt: current.renewAt, nextTry: null });
      this.later(Math.min(current.renewAt - now, CHECK_EVERY));
      return;
    }
    const lifeNow = { validUntil: current?.validUntil ?? null, renewAt: current?.renewAt ?? null };
    // Every order is validated through the tunnel; the next connect starts it.
    if (!this.connected) {
      this.set({ ...lifeNow, state: current ? 'valid' : 'offline', nextTry: null });
      return;
    }
    const saved = this.saved();
    if (saved.nextTry !== null && now < saved.nextTry) {
      this.set({ ...lifeNow, state: 'failed', error: saved.error, nextTry: saved.nextTry });
      this.later(saved.nextTry - now);
      return;
    }
    let accountUrl: string;
    try {
      accountUrl = await this.account();
    } catch (e) {
      this.failed(`The ACME account could not be made: ${(e as Error).message}`, lifeNow);
      return;
    }
    // A lookup that fails waits like a missing record (fail closed), but says so: otherwise someone re-pastes a record
    // that is there (code review of PR #209, minor 2). No data and no such name are answers: no record.
    let lookupError: string | null = null;
    const records = await this.resolveCaa(this.opts.publicName).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== dns.NODATA && e.code !== dns.NOTFOUND) lookupError = e.message;
      return [] as dns.CaaRecord[];
    });
    if (!caaAllows(records, accountUrl)) {
      const found = records.map((r) => r.issue).filter((v): v is string => typeof v === 'string');
      const error = lookupError
        ? `The CAA lookup for ${this.opts.publicName} failed: ${lookupError}`
        : found.length
          ? `The CAA record for ${this.opts.publicName} does not name this account: ${found.map((v) => `"${v}"`).join(', ')}.`
          : `No CAA record for ${this.opts.publicName} yet.`;
      this.set({ ...lifeNow, state: 'waiting-caa', error, nextTry: this.now() + CAA_EVERY });
      this.later(CAA_EVERY);
      return;
    }
    this.set({ ...lifeNow, state: 'ordering', error: null, nextTry: null });
    try {
      await this.order();
    } catch (e) {
      this.failed(`The order failed: ${(e as Error).message}`, lifeNow);
      return;
    }
    this.opts.issued();
    const issued = this.current();
    if (!issued) {
      this.failed('The new certificate could not be read back.', lifeNow);
      return;
    }
    // Due the moment it arrives (a clock far ahead, or a very short certificate): in use, but ordering again at once
    // would repeat without end, so it backs off like any failure (code review of PR #209, minor 1).
    if (this.now() >= issued.renewAt) {
      this.failed(`The new certificate (valid from ${new Date(issued.validFrom).toISOString()} until ${new Date(issued.validUntil).toISOString()}) is already due for renewal: check the computer's clock.`, { validUntil: issued.validUntil, renewAt: issued.renewAt });
      return;
    }
    this.save({ failures: 0, nextTry: null, error: null });
    console.log(`Certificate: issued for ${this.opts.publicName}, valid until ${new Date(issued.validUntil).toISOString()}`);
    this.set({ state: 'valid', validUntil: issued.validUntil, renewAt: issued.renewAt, error: null, nextTry: null });
    this.later(Math.min(issued.renewAt - this.now(), CHECK_EVERY));
  }

  private failed(error: string, life: { validUntil: number | null; renewAt: number | null }): void {
    const failures = this.saved().failures + 1;
    const wait = BACKOFF[Math.min(failures, BACKOFF.length) - 1]!;
    const nextTry = this.now() + wait;
    this.save({ failures, nextTry, error });
    console.log(`Certificate: ${error} Trying again in ${Math.round(wait / MINUTE)} min.`);
    this.set({ ...life, state: 'failed', error, nextTry });
    this.later(wait);
  }

  /** The account key (made once, kept), and its account at this directory, made or found with it. */
  private async account(): Promise<string> {
    const before = readSaved(this.opts.dir).accounts[this.opts.directoryUrl];
    if (!this.client) this.client = (await acmeAccount(this.opts)).client;
    const accountUrl = this.client.getAccountUrl();
    if (before !== accountUrl) {
      saveAccount(this.opts.dir, this.opts.directoryUrl, accountUrl);
      console.log(`Certificate: ACME account ${accountUrl}. Add this CAA record: ${caaRecord(this.opts.publicName, accountUrl)}`);
    }
    this.set({ accountUrl, record: caaRecord(this.opts.publicName, accountUrl) });
    return accountUrl;
  }

  /** One order for the public name, its challenge answered through the tunnel (as spike #199 ran it). */
  private async order(): Promise<void> {
    const client = this.client!;
    const name = this.opts.publicName;
    const order = await client.createOrder({ identifiers: [{ type: 'dns', value: name }] });
    for (const authz of await client.getAuthorizations(order)) {
      if (authz.status === 'valid') continue;
      const challenge = authz.challenges.find((c) => (c.type as string) === TLS_ALPN);
      if (!challenge) throw new Error(`the ACME server offers no ${TLS_ALPN} challenge`);
      const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
      const [key, cert] = await acme.crypto.createAlpnCertificate(authz, keyAuthorization);
      // Open for the whole check: the CA connects several times, from several places (spike #199, 6).
      this.opts.challenge({ key, cert });
      try {
        await client.completeChallenge(challenge);
        await client.waitForValidStatus(challenge);
      } finally {
        this.opts.challenge(null);
      }
    }
    const [key, csr] = await acme.crypto.createCsr({ altNames: [name] }, await acme.crypto.createPrivateEcdsaKey('P-256'));
    // The finalized order, not the first one: that carries the certificate's URL. When the CA reused an authorization
    // still valid from the last order, the first one came back "ready", and acme-client would not wait for it
    // (loopback, #202: every second order failed with "URL not found").
    const finalized = await client.finalizeOrder(order, csr);
    const chain = Buffer.from(await client.getCertificate(finalized));
    const problem = certificateProblem({ key, cert: chain }, name);
    if (problem) throw new Error(problem);
    // Key first, then the chain: until both are in place the server keeps the last good pair (tunnel-tls.ts).
    writePrivate(path.join(this.opts.dir, TLS_KEY), key);
    writePrivate(path.join(this.opts.dir, TLS_CERT), chain);
    this.save({ issuedBy: this.opts.directoryUrl });
  }

  /** The certificate in remoteDir() if it can serve the name, has not run out and is this directory's; null otherwise. */
  private current(): { validFrom: number; validUntil: number; renewAt: number } | null {
    const issuedBy = this.saved().issuedBy;
    if (issuedBy !== null && issuedBy !== this.opts.directoryUrl) return null;
    try {
      const files = { key: fs.readFileSync(path.join(this.opts.dir, TLS_KEY)), cert: fs.readFileSync(path.join(this.opts.dir, TLS_CERT)) };
      if (certificateProblem(files, this.opts.publicName)) return null;
      const life = lifetime(files.cert);
      return this.now() < life.validUntil ? life : null;
    } catch {
      return null;
    }
  }

  private saved(): Saved {
    return readSaved(this.opts.dir);
  }

  private save(change: Partial<Saved>): void {
    writeSaved(this.opts.dir, change);
  }

  private set(change: Partial<CertificateStatus>): void {
    this.status = { ...this.status, ...change };
    this.opts.onStatus(this.status);
  }
}

function readSaved(dir: string): Saved {
  const empty: Saved = { accounts: {}, issuedBy: null, failures: 0, nextTry: null, error: null };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, ACME_STATE), 'utf8')) as Partial<Saved>;
    return { ...empty, ...raw, accounts: { ...raw.accounts } };
  } catch {
    return empty;
  }
}

function writeSaved(dir: string, change: Partial<Saved>): void {
  writePrivate(path.join(dir, ACME_STATE), Buffer.from(JSON.stringify({ ...readSaved(dir), ...change }, null, 2)));
}

function saveAccount(dir: string, directoryUrl: string, accountUrl: string): void {
  writeSaved(dir, { accounts: { ...readSaved(dir).accounts, [directoryUrl]: accountUrl } });
}

/**
 * This computer's ACME account at a directory: the account key in `dir` (made once, kept) and the account it has
 * there, made or found. Needs only the ACME server, not the tunnel, so Join with a code (issue #237) makes it before
 * enrolling and sends its URL along: the admin can write the CAA record at once, with no second round trip.
 */
export async function acmeAccount(opts: { dir: string; directoryUrl: string; client?: CertificateOptions['client'] }): Promise<{ url: string; client: AcmeClient }> {
  const keyFile = path.join(opts.dir, ACCOUNT_KEY);
  let key: Buffer;
  try {
    key = fs.readFileSync(keyFile);
  } catch {
    key = await acme.crypto.createPrivateEcdsaKey('P-256');
    writePrivate(keyFile, key);
  }
  const client = (opts.client ?? defaultClient)(opts.directoryUrl, key);
  // The account this key already has, if any (RFC 8555 7.3.1), else a new one. Not createAccount with the terms
  // straight away: for a key that has an account, acme-client then sends the terms as an account update, which
  // Pebble refuses ("Use POST-as-GET"), so a restart with no certificate could never order (loopback, #202).
  try {
    await client.createAccount({ onlyReturnExisting: true });
  } catch {
    await client.createAccount({ termsOfServiceAgreed: true });
  }
  const url = client.getAccountUrl();
  saveAccount(opts.dir, opts.directoryUrl, url);
  return { url, client };
}

function defaultClient(directoryUrl: string, accountKey: Buffer): AcmeClient {
  return new acme.Client({ directoryUrl, accountKey });
}

/** Written whole and then renamed into place, private to this user (as remoteDir() is). */
function writePrivate(file: string, data: Buffer): void {
  const temp = `${file}.${process.pid}.new`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, file);
}
