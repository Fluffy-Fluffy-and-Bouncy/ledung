// Ledung's own certificate by ACME TLS-ALPN-01, with the wait for the CAA record (issue #202, docs/steps/relay-e2e.md
// 3b and build plan step 4). acme-client is replaced by a fake ACME server here, as the issue asks; the challenge
// certificate, the CSR and the files are real, and the TLS-ALPN-01 checks go through a real LedungServer's tunnel
// streams. The run against a real Pebble through a local relay is test/loopback/acme-pebble.ts (not in CI).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { duplexPair } from 'node:stream';
import tls from 'node:tls';
import acme from 'acme-client';
import { parseConfig } from '../src/config.ts';
import { ACCOUNT_KEY, ACME_STATE, BACKOFF, CAA_EVERY, caaAllows, caaRecord, CertificateManager, CHECK_EVERY, type AcmeClient, type Timers } from '../src/server/acme.ts';
import { LedungServer } from '../src/server/server.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import type { CertificateStatus } from '../src/shared/protocol.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { certificateLine } from '../web/src/remoteStatus.ts';
import { selfSigned } from './self-signed.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';

const PUBLIC = 'pc.acme.test';
const DIRECTORY = 'https://acme.test/dir';
const DAY = 86_400_000;
const MINUTE = 60_000;
const T = { timeout: 30_000 };
const cleanup: (() => unknown)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

/** What the fake ACME server saw and how it behaves. */
interface Ca {
  clients: number;
  accounts: number;
  orders: number;
  /** TLS-ALPN-01 checks that found the right challenge certificate. */
  validated: number;
  caaLookups: number;
  /** The next orders fail validation. */
  fail: boolean;
  /** The certificates it issues: days of life, from when. */
  days: number;
  /** The account URLs it has made. */
  known: Set<string>;
  /** Accounts with a valid authorization for the name, which a CA reuses for the next order (RFC 8555 7.1.4). */
  authorized: Set<string>;
  /** The challenge certificate Ledung has open. */
  open: { key: Buffer; cert: Buffer } | null;
  /** The check itself: by default it looks at the challenge Ledung has open; the server test connects through the tunnel. */
  check: (keyAuthorization: string) => Promise<boolean>;
}

const fakeCa = (check?: Ca['check']): Ca => {
  const ca: Ca = {
    clients: 0, accounts: 0, orders: 0, validated: 0, caaLookups: 0, fail: false, days: 90, known: new Set(), authorized: new Set(), open: null,
    check: check ?? (async (keyAuthorization) => !!ca.open && acme.crypto.isAlpnCertificateAuthorizationValid(ca.open.cert, keyAuthorization)),
  };
  return ca;
};

/** The public key in a CSR (RFC 2986: the third field of its CertificationRequestInfo), as a CA reads it. */
function csrPublicKey(csr: Buffer): crypto.KeyObject {
  const text = csr.toString('latin1');
  const der = text.startsWith('-----') ? Buffer.from(text.replace(/-----[^-]+-----|\s/g, ''), 'base64') : csr;
  const read = (at: number) => {
    let length = der[at + 1]!;
    let header = 2;
    if (length & 0x80) {
      header += length & 0x7f;
      length = der.readUIntBE(at + 2, length & 0x7f);
    }
    return { start: at + header, end: at + header + length };
  };
  const info = read(read(0).start);
  const version = read(info.start);
  const subject = read(version.end);
  const spki = read(subject.end);
  return crypto.createPublicKey({ key: der.subarray(subject.end, spki.end), format: 'der', type: 'spki' });
}

/** Stands in for acme-client's Client: one account per key, URL from the key, never the shape Ledung expects. */
class FakeAcme implements AcmeClient {
  private readonly ca: Ca;
  private readonly url: string;
  private csr: Buffer | null = null;
  private passed = false;
  constructor(ca: Ca, accountKey: Buffer) {
    this.ca = ca;
    this.url = `https://acme.test/my-account/${crypto.createHash('sha256').update(accountKey).digest('hex').slice(0, 12)}`;
  }
  /**
   * As acme-client does against Pebble: onlyReturnExisting finds an account or fails; the terms for a key that has
   * an account become an account update, which Pebble refuses (found in the loopback run, #202).
   */
  async createAccount(data: { termsOfServiceAgreed: true } | { onlyReturnExisting: true }) {
    const exists = this.ca.known.has(this.url);
    if ('onlyReturnExisting' in data) {
      if (!exists) throw new Error('urn:ietf:params:acme:error:accountDoesNotExist: unable to find existing account for only-return-existing request');
      return {};
    }
    if (exists) throw new Error('Use POST-as-GET to retrieve account data instead of doing an empty update');
    this.ca.known.add(this.url);
    this.ca.accounts++;
    return {};
  }
  getAccountUrl() {
    return this.url;
  }
  async createOrder(data: { identifiers: { type: string; value: string }[] }) {
    this.ca.orders++;
    assert.deepEqual(data.identifiers, [{ type: 'dns', value: PUBLIC }]);
    const status = this.ca.authorized.has(this.url) ? 'ready' : 'pending';
    return { url: 'https://acme.test/order/1', status, identifiers: data.identifiers, authorizations: [], finalize: 'https://acme.test/finalize/1' } as unknown as acme.Order;
  }
  async getAuthorizations() {
    const challenges = [{ type: 'http-01', url: 'https://acme.test/c/h', token: 'h', status: 'pending' }, { type: 'tls-alpn-01', url: 'https://acme.test/c/t', token: 'tok', status: 'pending' }];
    const status = this.ca.authorized.has(this.url) ? 'valid' : 'pending';
    return [{ url: 'https://acme.test/authz/1', identifier: { type: 'dns', value: PUBLIC }, status, challenges }] as unknown as acme.Authorization[];
  }
  async getChallengeKeyAuthorization(challenge: { token: string }) {
    return `${challenge.token}.thumbprint-of-${this.url}`;
  }
  async completeChallenge(challenge: { type: string; token: string }) {
    assert.equal(challenge.type, 'tls-alpn-01');
    this.passed = !this.ca.fail && await this.ca.check(await this.getChallengeKeyAuthorization(challenge));
    if (this.passed) {
      this.ca.validated++;
      this.ca.authorized.add(this.url);
    }
    return {};
  }
  async waitForValidStatus() {
    if (!this.passed) throw new Error('urn:ietf:params:acme:error:unauthorized: the challenge certificate was not found');
    return {};
  }
  /** As acme-client does: the finalized order carries the certificate's URL; the one it was given may not. */
  async finalizeOrder(order: acme.Order, csr: Buffer) {
    this.csr = csr;
    return { ...order, status: 'valid', certificate: 'https://acme.test/cert/1' } as acme.Order;
  }
  async getCertificate(order: acme.Order) {
    // acme-client waits only for an order that is not "ready" or "valid" yet; then it needs the URL.
    if (!order.certificate && (order.status === 'ready' || order.status === 'valid')) throw new Error('Unable to download certificate, URL not found');
    const issued = selfSigned(PUBLIC, { days: this.ca.days, publicKey: csrPublicKey(this.csr!) });
    return issued.cert;
  }
}

/** Timers the test fires by hand, with the delay each was set for. */
function handTimers(): Timers & { pending: { fn: () => void; ms: number }[]; fire(): void } {
  const pending: { fn: () => void; ms: number }[] = [];
  return {
    pending,
    set(fn, ms) {
      const t = { fn, ms };
      pending.push(t);
      return t;
    },
    clear(handle) {
      const at = pending.indexOf(handle as { fn: () => void; ms: number });
      if (at >= 0) pending.splice(at, 1);
    },
    fire() {
      const t = pending.shift();
      assert.ok(t, 'a timer is set');
      t.fn();
    },
  };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-acme-'));
  cleanup.push(() => removeTemp(dir));
  return dir;
};

function writeCert(dir: string, pair: { key: string; cert: string }): void {
  fs.writeFileSync(path.join(dir, 'tls.key'), pair.key);
  fs.writeFileSync(path.join(dir, 'tls.crt'), pair.cert);
}

/** A record naming `accountUrl` as the CAA lock wants it. */
const lockFor = (accountUrl: string): dns.CaaRecord => ({ critical: 0, issue: `letsencrypt.org; accounturi=${accountUrl}; validationmethods=tls-alpn-01` });

type Caa = 'none' | 'match' | dns.CaaRecord[] | Error;

/**
 * A CertificateManager over `dir` with the fake ACME server. `caa`: "none", "match" (a record naming whatever
 * account it has, as if pasted), the records to serve, or the error the lookup fails with.
 */
function manager(opts: { dir?: string; directoryUrl?: string; ca?: Ca; caa?: Caa; clock?: { now: number }; challenge?: (pair: { key: Buffer; cert: Buffer } | null) => void; issued?: () => void; onStatus?: (s: CertificateStatus) => void } = {}) {
  const dir = opts.dir ?? tempDir();
  const ca = opts.ca ?? fakeCa();
  const state = { caa: opts.caa ?? 'none' as Caa, issued: 0, challenges: [] as ({ key: Buffer; cert: Buffer } | null)[] };
  const timers = handTimers();
  const m: CertificateManager = new CertificateManager({
    dir, publicName: PUBLIC, acme: 'pebble', directoryUrl: opts.directoryUrl ?? DIRECTORY,
    resolveCaa: async () => {
      ca.caaLookups++;
      if (state.caa === 'none') return [];
      if (state.caa instanceof Error) throw state.caa;
      if (state.caa === 'match') return [lockFor(m.get().accountUrl!)];
      return state.caa;
    },
    client: (url, key) => {
      assert.equal(url, opts.directoryUrl ?? DIRECTORY);
      ca.clients++;
      return new FakeAcme(ca, key);
    },
    challenge: (pair) => {
      ca.open = pair;
      state.challenges.push(pair);
      opts.challenge?.(pair);
    },
    issued: () => {
      state.issued++;
      opts.issued?.();
    },
    onStatus: (s) => opts.onStatus?.(s),
    now: opts.clock ? () => opts.clock!.now : undefined,
    timers,
  });
  cleanup.push(() => m.stop());
  return { m, dir, ca, timers, state };
}

/** Settled: a run ended with its next look-up or try scheduled, and nothing is in flight. */
const settled = (t: { m: CertificateManager; timers: { pending: unknown[] } }, state: CertificateStatus['state']) =>
  until(() => t.m.get().state === state && t.timers.pending.length === 1, `state ${state}`);

test('nothing goes to the ACME server or the DNS before the tunnel connects; then the account comes first', T, async () => {
  const t = manager();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.m.get().state, 'offline');
  assert.equal(t.ca.clients, 0, 'no ACME client before the tunnel connects');
  assert.equal(t.ca.caaLookups, 0, 'no CAA lookup before the tunnel connects');
  assert.equal(fs.existsSync(path.join(t.dir, ACCOUNT_KEY)), false);
  assert.equal(t.timers.pending.length, 0, 'nothing scheduled either');

  t.m.setConnected(true);
  await settled(t, 'waiting-caa');
  // The account key: ECDSA P-256, kept in the remote folder.
  const key = crypto.createPrivateKey(fs.readFileSync(path.join(t.dir, ACCOUNT_KEY)));
  assert.equal(key.asymmetricKeyType, 'ec');
  assert.equal(key.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  const accountUrl = t.m.get().accountUrl!;
  assert.match(accountUrl, /^https:\/\/acme\.test\/my-account\//, 'the URL the ACME server gave, as given');
  const saved = JSON.parse(fs.readFileSync(path.join(t.dir, ACME_STATE), 'utf8'));
  assert.equal(saved.accounts[DIRECTORY], accountUrl, 'acme.json keeps the account URL per directory');
  assert.equal(t.m.get().record, `${PUBLIC}. CAA 0 issue "letsencrypt.org; accounturi=${accountUrl}; validationmethods=tls-alpn-01"`);
  assert.equal(t.ca.orders, 0, 'no order before the CAA record names the account');
});

test('waiting for the CAA record: looked up every minute, ordered only once it names the account, Check now looks at once', T, async () => {
  const t = manager();
  t.m.setConnected(true);
  await settled(t, 'waiting-caa');
  assert.equal(t.timers.pending[0]!.ms, CAA_EVERY);
  assert.equal(CAA_EVERY, MINUTE);
  assert.match(t.m.get().error ?? '', /No CAA record/);

  // A record for another account (a server operator's) is not ours: still waiting, and it says what it found.
  t.state.caa = [lockFor('https://acme.test/my-account/someone-else')];
  const lookups = t.ca.caaLookups;
  t.timers.fire();
  await until(() => t.ca.caaLookups > lookups && t.timers.pending.length === 1, 'the next lookup');
  assert.equal(t.m.get().state, 'waiting-caa');
  assert.match(t.m.get().error ?? '', /does not name this account.*someone-else/);
  assert.equal(t.ca.orders, 0);

  // Pasted: Check now orders without waiting for the minute.
  t.state.caa = 'match';
  t.m.checkNow();
  await settled(t, 'valid');
  assert.equal(t.ca.orders, 1);
  assert.equal(t.ca.validated, 1, 'the challenge certificate was open when the CA checked');
  assert.equal(t.state.challenges.at(-1), null, 'and closed again after the order');
  assert.equal(t.state.issued, 1, 'the server was told to load the new certificate');
  const cert = new crypto.X509Certificate(fs.readFileSync(path.join(t.dir, 'tls.crt')));
  assert.ok(cert.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(path.join(t.dir, 'tls.key')))), 'tls.key is the key the CSR named');
  assert.ok(cert.checkHost(PUBLIC));
});

test('a CAA lookup that fails keeps waiting and says the lookup failed; no record at all says so', T, async () => {
  // As Node's resolver fails (queryCaa <code> <name>).
  const dnsError = (code: string) => Object.assign(new Error(`queryCaa ${code} ${PUBLIC}`), { code });
  const t = manager({ caa: dnsError('ESERVFAIL') });
  t.m.setConnected(true);
  await settled(t, 'waiting-caa');
  assert.equal(t.ca.orders, 0, 'fail closed: no order');
  assert.equal(t.timers.pending[0]!.ms, CAA_EVERY, 'looked up again in a minute');
  assert.equal(t.m.get().error, `The CAA lookup for ${PUBLIC} failed: queryCaa ESERVFAIL ${PUBLIC}`);
  assert.match(certificateLine(t.m.get(), Date.now()).detail ?? '', /CAA lookup .* failed: queryCaa ESERVFAIL/, 'Settings shows it');

  // No CAA data, or no such name: the DNS answered, there is just no record.
  for (const code of ['ENODATA', 'ENOTFOUND']) {
    t.state.caa = dnsError(code);
    t.m.checkNow();
    await until(() => /No CAA record/.test(t.m.get().error ?? '') && t.timers.pending.length === 1, code);
    assert.equal(t.m.get().error, `No CAA record for ${PUBLIC} yet.`);
    t.state.caa = dnsError('ESERVFAIL');
    t.m.checkNow();
    await until(() => /lookup/.test(t.m.get().error ?? '') && t.timers.pending.length === 1, 'the failure again');
  }

  t.state.caa = 'match';
  t.m.checkNow();
  await settled(t, 'valid');
  assert.equal(t.ca.orders, 1);
});

test('Check now does nothing outside the CAA wait', T, async () => {
  const t = manager({ caa: 'match' });
  t.m.checkNow();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.ca.clients, 0, 'not connected: Check now does not start anything');

  // Connected, valid and failed: no new run (no status sent), and the next look or try stays as it was.
  const quiet = async (u: ReturnType<typeof manager>, statuses: () => number) => {
    const timer = u.timers.pending[0];
    const sent = statuses();
    u.m.checkNow();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(statuses(), sent, `${u.m.get().state}: no new run`);
    assert.deepEqual(u.timers.pending, [timer], `${u.m.get().state}: the pending timer is unchanged`);
  };
  const dir = tempDir();
  writeCert(dir, selfSigned(PUBLIC, { validFrom: Date.now() - DAY, days: 90 }));
  let validStatuses = 0;
  const valid = manager({ dir, caa: 'match', onStatus: () => validStatuses++ });
  valid.m.setConnected(true);
  await settled(valid, 'valid');
  await quiet(valid, () => validStatuses);

  let failedStatuses = 0;
  const failed = manager({ caa: 'match', onStatus: () => failedStatuses++ });
  failed.ca.fail = true;
  failed.m.setConnected(true);
  await settled(failed, 'failed');
  await quiet(failed, () => failedStatuses);
  assert.equal(failed.ca.orders, 1, 'the back-off is not skipped');
});

test('the tunnel goes down while waiting for the CAA record: the next minute orders nothing, the reconnect does', T, async () => {
  const t = manager();
  t.m.setConnected(true);
  await settled(t, 'waiting-caa');
  t.m.setConnected(false);
  // Pasted while the tunnel is down: an order now could not be validated, and would count as a failure at the CA.
  t.state.caa = 'match';
  t.timers.fire();
  await until(() => t.m.get().state === 'offline', 'the run after the minute');
  assert.equal(t.ca.orders, 0, 'no order without the tunnel');
  assert.equal(t.timers.pending.length, 0, 'and nothing scheduled: the reconnect starts it');

  t.m.setConnected(true);
  await settled(t, 'valid');
  assert.equal(t.ca.orders, 1);
});

test('the tunnel goes down during a back-off: the retry orders nothing, the reconnect does', T, async () => {
  const clock = { now: Date.now() };
  const t = manager({ caa: 'match', clock });
  t.ca.fail = true;
  t.m.setConnected(true);
  await settled(t, 'failed');
  assert.equal(t.ca.orders, 1);
  t.m.setConnected(false);
  t.ca.fail = false;
  clock.now += t.timers.pending[0]!.ms;
  t.timers.fire();
  await until(() => t.m.get().state === 'offline', 'the run after the back-off');
  assert.equal(t.ca.orders, 1, 'no retry without the tunnel');

  t.m.setConnected(true);
  await settled(t, 'valid');
  assert.equal(t.ca.orders, 2);
});

test('the account key is kept: after a restart the same account is found, and an order follows a record already in place', T, async () => {
  const first = manager();
  first.m.setConnected(true);
  await settled(first, 'waiting-caa');
  const accountUrl = first.m.get().accountUrl;
  const key = fs.readFileSync(path.join(first.dir, ACCOUNT_KEY));
  first.m.stop();

  const again = manager({ dir: first.dir, ca: first.ca, caa: 'match' });
  assert.equal(again.m.get().accountUrl, accountUrl, 'shown from acme.json before connecting');
  again.m.setConnected(true);
  await settled(again, 'valid');
  assert.ok(fs.readFileSync(path.join(first.dir, ACCOUNT_KEY)).equals(key), 'the same account key');
  assert.equal(again.m.get().accountUrl, accountUrl);
  assert.equal(first.ca.accounts, 1, 'found, not made again');
  assert.equal(again.ca.orders, 1);
});

test('a start with a valid certificate orders nothing, and looks again in 12 hours', T, async () => {
  const dir = tempDir();
  writeCert(dir, selfSigned(PUBLIC, { validFrom: Date.now() - DAY, days: 90 }));
  const t = manager({ dir, caa: 'match' });
  assert.equal(t.m.get().state, 'valid', 'from the files alone');
  t.m.setConnected(true);
  await settled(t, 'valid');
  assert.equal(t.ca.clients, 0, 'not even the account is asked for');
  assert.equal(t.ca.orders, 0);
  assert.equal(t.timers.pending[0]!.ms, CHECK_EVERY);
  assert.equal(CHECK_EVERY, 12 * 60 * MINUTE);
});

test('a certificate from another directory (staging, then "acme": "production") is replaced, through the new account\'s CAA record', T, async () => {
  const staging = manager({ caa: 'match' });
  staging.m.setConnected(true);
  await settled(staging, 'valid');
  const stagingCert = fs.readFileSync(path.join(staging.dir, 'tls.crt'));
  staging.m.stop();

  // The same folder, now pointed at another directory: its certificate is still valid, but not that CA's (#214).
  const PRODUCTION = 'https://acme.test/production/dir';
  const production = manager({ dir: staging.dir, directoryUrl: PRODUCTION, ca: fakeCa(), caa: 'none' });
  assert.notEqual(production.m.get().state, 'valid', 'not shown as the certificate this directory gave');
  production.m.setConnected(true);
  await settled(production, 'waiting-caa');
  assert.equal(production.ca.accounts, 1, 'an account at the new directory');
  assert.equal(production.m.get().record, caaRecord(PUBLIC, production.m.get().accountUrl!), 'its record to paste');
  assert.equal(production.ca.orders, 0, 'nothing ordered before the record names it');
  assert.ok(fs.readFileSync(path.join(staging.dir, 'tls.crt')).equals(stagingCert), 'the old certificate stays in use meanwhile');

  production.state.caa = 'match';
  production.m.checkNow();
  await settled(production, 'valid');
  assert.equal(production.ca.orders, 1);
  assert.ok(!fs.readFileSync(path.join(staging.dir, 'tls.crt')).equals(stagingCert), 'replaced by the new directory\'s certificate');

  // Restarted on the new directory with its certificate: nothing more to order.
  production.m.stop();
  const again = manager({ dir: staging.dir, directoryUrl: PRODUCTION, ca: production.ca, caa: 'match' });
  assert.equal(again.m.get().state, 'valid');
  again.m.setConnected(true);
  await settled(again, 'valid');
  assert.equal(production.ca.orders, 1, 'no second order');
});

test('a certificate at two-thirds of its life renews; one short of it waits for exactly that moment', T, async () => {
  // 90 days from 61 days ago: two-thirds was at day 60.
  const dir = tempDir();
  writeCert(dir, selfSigned(PUBLIC, { validFrom: Date.now() - 61 * DAY, days: 90 }));
  const t = manager({ dir, caa: 'match' });
  t.m.setConnected(true);
  await settled(t, 'valid');
  assert.equal(t.ca.orders, 1, 'renewed');
  const renewed = new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'tls.crt')));
  assert.ok(Date.now() - Date.parse(renewed.validFrom) < DAY, 'the new certificate is in place');

  // 90 days from 59 days and 23 hours ago: two-thirds comes in an hour, sooner than the 12-hour look.
  const soon = tempDir();
  const from = Date.now() - 60 * DAY + 60 * MINUTE;
  writeCert(soon, selfSigned(PUBLIC, { validFrom: from, days: 90 }));
  const w = manager({ dir: soon, caa: 'match' });
  w.m.setConnected(true);
  await settled(w, 'valid');
  assert.equal(w.ca.orders, 0);
  const renewAt = Math.floor(from / 1000) * 1000 + 60 * DAY; // certificate times are whole seconds
  assert.ok(Math.abs(w.timers.pending[0]!.ms - (renewAt - Date.now())) < 5_000, `next look at two-thirds, not in 12 h (${w.timers.pending[0]!.ms} ms)`);
});

test('a renewal while the authorization is still valid needs no new check, and gets its certificate', T, async () => {
  const t = manager({ caa: 'match' });
  t.m.setConnected(true);
  await settled(t, 'valid');
  assert.equal(t.ca.validated, 1);
  // Two-thirds reached: an older certificate in place, and the 12-hour look comes.
  writeCert(t.dir, selfSigned(PUBLIC, { validFrom: Date.now() - 61 * DAY, days: 90 }));
  t.timers.fire();
  await until(() => t.ca.orders === 2 && t.timers.pending.length === 1 && t.m.get().state !== 'ordering', 'the renewal');
  assert.equal(t.m.get().state, 'valid', t.m.get().error ?? '');
  assert.equal(t.ca.validated, 1, 'the CA reused the authorization: no second check');
  assert.ok(Date.now() - Date.parse(new crypto.X509Certificate(fs.readFileSync(path.join(t.dir, 'tls.crt'))).validFrom) < DAY, 'the new certificate is in place');
});

test('an expired certificate renews as soon as the tunnel connects', T, async () => {
  const dir = tempDir();
  writeCert(dir, selfSigned(PUBLIC, { validFrom: Date.now() - 100 * DAY, days: 90 }));
  const t = manager({ dir, caa: 'match' });
  assert.equal(t.m.get().state, 'offline', 'an expired certificate is no certificate');
  assert.equal(t.m.get().validUntil, null);
  t.m.setConnected(true);
  await settled(t, 'valid');
  assert.equal(t.ca.orders, 1);
  assert.ok(t.m.get().validUntil! > Date.now() + 80 * DAY);
});

test('failed orders back off 1, 5, 30 minutes, then hourly, and a restart keeps the wait', T, async () => {
  const clock = { now: Date.now() };
  const t = manager({ caa: 'match', clock });
  t.ca.fail = true;
  t.m.setConnected(true);
  const waits: number[] = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    await until(() => t.ca.orders === attempt && t.m.get().state === 'failed' && t.timers.pending.length === 1, `failure ${attempt}`);
    waits.push(t.timers.pending[0]!.ms);
    assert.equal(t.m.get().nextTry, clock.now + waits.at(-1)!);
    assert.match(t.m.get().error ?? '', /order failed.*unauthorized/);
    clock.now += waits.at(-1)!;
    if (attempt < 5) t.timers.fire();
  }
  assert.deepEqual(waits, [MINUTE, 5 * MINUTE, 30 * MINUTE, 60 * MINUTE, 60 * MINUTE]);
  assert.deepEqual(BACKOFF, [MINUTE, 5 * MINUTE, 30 * MINUTE, 60 * MINUTE]);
  t.m.stop();

  // A restart 10 minutes into the hour's wait: no order, the rest of the wait kept (acme.json).
  clock.now -= 50 * MINUTE;
  const again = manager({ dir: t.dir, ca: t.ca, caa: 'match', clock });
  again.m.setConnected(true);
  await settled(again, 'failed');
  assert.equal(t.ca.orders, 5, 'nothing ordered during the back-off');
  assert.equal(again.timers.pending[0]!.ms, 50 * MINUTE);

  // When it is up, it orders again, and a success clears the count.
  t.ca.fail = false;
  clock.now += 50 * MINUTE;
  again.timers.fire();
  await settled(again, 'valid');
  assert.equal(t.ca.orders, 6);
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, ACME_STATE), 'utf8')).failures, 0);
});

test('a new certificate already due for renewal (the clock far ahead) backs off and says to check the clock', T, async () => {
  // 70 days ahead: a 90-day certificate issued now is past two-thirds (day 60) the moment it arrives.
  const clock = { now: Date.now() + 70 * DAY };
  const t = manager({ caa: 'match', clock });
  t.m.setConnected(true);
  await settled(t, 'failed');
  assert.equal(t.ca.orders, 1);
  assert.match(t.m.get().error ?? '', /already due for renewal.*check the computer's clock/);
  assert.equal(t.timers.pending[0]!.ms, MINUTE, 'not again at once: the back-off');
  assert.ok(t.m.get().validUntil! > clock.now, 'the new certificate is in use meanwhile');
  assert.equal(t.state.issued, 1);

  clock.now += MINUTE;
  t.timers.fire();
  await until(() => t.ca.orders === 2 && t.m.get().state === 'failed' && t.timers.pending.length === 1, 'the second try');
  assert.equal(t.timers.pending[0]!.ms, 5 * MINUTE, 'and the back-off grows');
});

test('a failed renewal keeps the certificate in use, and says so', T, async () => {
  const dir = tempDir();
  writeCert(dir, selfSigned(PUBLIC, { validFrom: Date.now() - 61 * DAY, days: 90 }));
  const before = fs.readFileSync(path.join(dir, 'tls.crt'));
  const t = manager({ dir, caa: 'match' });
  t.ca.fail = true;
  t.m.setConnected(true);
  await settled(t, 'failed');
  assert.ok(fs.readFileSync(path.join(dir, 'tls.crt')).equals(before));
  assert.ok(t.m.get().validUntil! > Date.now());
  const line = certificateLine(t.m.get(), Date.now());
  assert.equal(line.label, 'Renewal failed');
  assert.match(line.detail ?? '', /Trying again at .*valid until/);
});

test('the CAA lock: only an issue record for Let\'s Encrypt naming exactly this account, by TLS-ALPN-01', () => {
  const mine = 'https://acme-staging-v02.api.letsencrypt.org/acme/acct/123';
  const allows = (...issue: string[]) => caaAllows(issue.map((v) => ({ critical: 0, issue: v })), mine);
  assert.ok(allows(`letsencrypt.org; accounturi=${mine}; validationmethods=tls-alpn-01`));
  assert.ok(allows(`LetsEncrypt.org;accounturi=${mine}`), 'case of the CA name and spacing do not matter; no validationmethods allows all');
  assert.ok(allows(`letsencrypt.org; accounturi=${mine}; validationmethods=dns-01,tls-alpn-01`));
  assert.ok(allows('otherca.example', `letsencrypt.org; accounturi=${mine}`), 'one record of several is enough');
  assert.ok(!allows(`letsencrypt.org; accounturi=${mine}/`), 'the URL exactly, not a prefix');
  assert.ok(!allows('letsencrypt.org; accounturi=https://acme-staging-v02.api.letsencrypt.org/acme/acct/1234'));
  assert.ok(!allows('letsencrypt.org'), 'a record without the account lets anyone\'s account order');
  assert.ok(!allows(`letsencrypt.org; accounturi=${mine}; validationmethods=dns-01`));
  assert.ok(!allows(`otherca.example; accounturi=${mine}`));
  assert.ok(!allows(';'));
  assert.ok(!caaAllows([{ critical: 0, issuewild: `letsencrypt.org; accounturi=${mine}` }], mine), 'issuewild is not for this name');
  assert.ok(!caaAllows([], mine));
  assert.equal(caaRecord('pc.example.org', mine), `pc.example.org. CAA 0 issue "letsencrypt.org; accounturi=${mine}; validationmethods=tls-alpn-01"`);
});

test('config: "acme" is pebble, staging or production, with Pebble\'s directory and mock DNS', () => {
  const remote = { relay: 'wss://relay.example', name: 'pc', publicName: 'pc.example.org', secret: 's' };
  assert.equal(parseConfig({ remote }).remote?.acme, undefined, 'left out: no ACME');
  assert.equal(parseConfig({ remote: { ...remote, acme: 'staging' } }).remote?.acme, 'staging');
  const pebble = parseConfig({ remote: { ...remote, acme: 'pebble', pebble: { directory: 'https://127.0.0.1:51400/dir', dns: '127.0.0.1:51053' } } }).remote;
  assert.equal(pebble?.pebble?.directory, 'https://127.0.0.1:51400/dir');
  assert.equal(pebble?.pebble?.dns, '127.0.0.1:51053');
  assert.throws(() => parseConfig({ remote: { ...remote, acme: 'letsencrypt' } }));
});

test('Settings: the CAA wait shows the account and the record to copy; fewer than 7 days left warns', () => {
  const base: CertificateStatus = { state: 'waiting-caa', acme: 'staging', accountUrl: 'https://x/acct/1', record: 'pc.example.org. CAA 0 issue "…"', validUntil: null, renewAt: null, error: 'No CAA record for pc.example.org yet.', nextTry: null };
  const waiting = certificateLine(base, Date.now());
  assert.equal(waiting.label, 'Waiting for the CAA record');
  assert.ok(waiting.copy);
  assert.match(waiting.detail ?? '', /every minute.*No CAA record/);
  const now = Date.now();
  assert.ok(certificateLine({ ...base, state: 'valid', validUntil: now + 6 * DAY, error: null }, now).warn);
  assert.ok(!certificateLine({ ...base, state: 'valid', validUntil: now + 8 * DAY, error: null }, now).warn);
  assert.ok(!certificateLine({ ...base, state: 'valid', validUntil: now + 8 * DAY, error: null }, now).copy);
});

// ---- Through a real LedungServer: the acme-tls/1 route on tunnel streams and the swap without a restart.


async function ledung(dir: string, onCertificateCheck?: () => void) {
  const port = await freePort();
  const webRoot = tempDir();
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
  const store = new Store(openDatabase(':memory:'));
  const sessions = refuseRealSignInStores(new SessionManager(parseConfig({ port }), store, () => {}));
  const server = new LedungServer({ port, token: 'd'.repeat(64), store, manager: sessions, webRoot, publicName: PUBLIC, tunnelTls: { dir, required: true }, onCertificateCheck });
  cleanup.push(() => server.close());
  await server.listen();
  return { server, port };
}

/** A TLS handshake over a new tunnel stream; resolves with what the server presented, or null if it closed. */
function handshake(server: LedungServer, alpn: string[], servername = PUBLIC): Promise<{ cert: string; alpn: string | false | null } | null> {
  return new Promise((resolve) => {
    const socket = tls.connect({ socket: server.tunnelConnection(), servername, ALPNProtocols: alpn, rejectUnauthorized: false });
    socket.once('secureConnect', () => {
      resolve({ cert: socket.getPeerX509Certificate()!.toString(), alpn: socket.alpnProtocol });
      socket.destroy();
    });
    socket.once('error', () => resolve(null));
    socket.once('close', () => resolve(null));
  });
}

test('through the tunnel: acme-tls/1 gets the challenge certificate only while the order is open, three checks at once; the new certificate is used without a restart', T, async () => {
  const dir = tempDir();
  const { server } = await ledung(dir);
  let checksWhileOpen: ({ cert: string; alpn: string | false | null } | null)[] = [];
  let phoneWhileOpen: { cert: string; alpn: string | false | null } | null | undefined;
  // The CA's check, as Pebble makes it: three connections at once, SNI the name, ALPN acme-tls/1 only (spike #199, 6).
  const ca = fakeCa(async (keyAuthorization) => {
    checksWhileOpen = await Promise.all([1, 2, 3].map(() => handshake(server, ['acme-tls/1'])));
    phoneWhileOpen = await handshake(server, ['http/1.1']);
    return checksWhileOpen.every((c) => c?.alpn === 'acme-tls/1' && acme.crypto.isAlpnCertificateAuthorizationValid(c.cert, keyAuthorization));
  });
  const t = manager({ dir, ca, caa: 'match', challenge: (pair) => server.setChallenge(pair), issued: () => server.loadCertificate(), onStatus: (s) => server.setCertificate(s) });

  assert.equal(await handshake(server, ['acme-tls/1']), null, 'no order open: a check is closed');
  assert.equal(await handshake(server, ['http/1.1']), null, 'no certificate yet: a phone is closed');

  t.m.setConnected(true);
  await settled(t, 'valid');
  assert.equal(ca.validated, 1);
  assert.equal(checksWhileOpen.length, 3);
  assert.ok(checksWhileOpen.every((c) => c?.alpn === 'acme-tls/1'), 'every check connection was answered with the challenge');
  assert.equal(phoneWhileOpen, null, 'a phone never gets the challenge certificate');

  // After the order: the check is closed again, and a phone gets the issued certificate, no restart.
  assert.equal(await handshake(server, ['acme-tls/1']), null);
  assert.equal(await handshake(server, ['acme-tls/1'], 'other.acme.test'), null);
  const phone = await handshake(server, ['http/1.1']);
  assert.ok(phone, 'the phone completes TLS');
  assert.equal(new crypto.X509Certificate(phone.cert).fingerprint256, new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'tls.crt'))).fingerprint256);
});

/** As handshake(), but the ClientHello reaches the tunnel stream in two pieces with a pause, as over a real relay. */
function splitHandshake(server: LedungServer, alpn: string[]): Promise<{ cert: string; alpn: string | false | null } | null> {
  return new Promise((resolve) => {
    const [client, wire] = duplexPair();
    const tunnel = server.tunnelConnection();
    const socket = tls.connect({ socket: client, servername: PUBLIC, ALPNProtocols: alpn, rejectUnauthorized: false });
    // Closed by Ledung, perhaps before the pieces are joined up: so is the client.
    tunnel.on('error', () => {});
    tunnel.once('close', () => socket.destroy());
    wire.once('data', (hello: Buffer) => {
      wire.pause();
      const cut = Math.floor(hello.length / 2);
      tunnel.write(hello.subarray(0, cut));
      setTimeout(() => {
        tunnel.write(hello.subarray(cut));
        wire.pipe(tunnel);
        tunnel.pipe(wire);
      }, 100);
    });
    socket.once('secureConnect', () => {
      resolve({ cert: socket.getPeerX509Certificate()!.toString(), alpn: socket.alpnProtocol });
      socket.destroy();
    });
    socket.once('error', () => resolve(null));
    socket.once('close', () => resolve(null));
  });
}

test('a ClientHello in two pieces is waited for: acme-tls/1 gets the challenge, http/1.1 the real certificate', T, async () => {
  const dir = tempDir();
  writeCert(dir, selfSigned(PUBLIC));
  const { server } = await ledung(dir);
  const [key, cert] = await acme.crypto.createAlpnCertificate({ identifier: { type: 'dns', value: PUBLIC } } as acme.Authorization, 'tok.thumb');
  server.setChallenge({ key, cert });
  const fingerprint = (pem: Buffer | string) => new crypto.X509Certificate(pem).fingerprint256;

  const check = await splitHandshake(server, ['acme-tls/1']);
  assert.ok(check, 'the check completes TLS');
  assert.equal(check.alpn, 'acme-tls/1');
  assert.equal(fingerprint(check.cert), fingerprint(cert), 'with the challenge certificate');

  const phone = await splitHandshake(server, ['http/1.1']);
  assert.ok(phone, 'the phone completes TLS');
  assert.equal(phone.alpn, 'http/1.1');
  assert.equal(fingerprint(phone.cert), fingerprint(fs.readFileSync(path.join(dir, 'tls.crt'))), 'with tls.crt');
});

test('a check for another name is closed even while an order is open', T, async () => {
  const dir = tempDir();
  const { server } = await ledung(dir);
  const [key, cert] = await acme.crypto.createAlpnCertificate({ identifier: { type: 'dns', value: PUBLIC } } as acme.Authorization, 'tok.thumb');
  server.setChallenge({ key, cert });
  assert.ok(await handshake(server, ['acme-tls/1']), 'the name itself is answered');
  assert.equal(await handshake(server, ['acme-tls/1'], 'other.acme.test'), null);
  assert.equal(await handshake(server, ['acme-tls/1'], ''), null, 'and one without a name');
  server.setChallenge(null);
  assert.equal(await handshake(server, ['acme-tls/1']), null);
});

test('Check now in Settings reaches the certificate manager; without ACME the route is not there', T, async () => {
  let asked = 0;
  const { port } = await ledung(tempDir(), () => asked++);
  const post = (p: number) => fetch(`http://127.0.0.1:${p}/api/certificate-check`, { method: 'POST', headers: { Cookie: `ledung_auth=${'d'.repeat(64)}`, Origin: `http://127.0.0.1:${p}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await post(port)).status, 200);
  assert.equal(asked, 1);
  const without = await ledung(tempDir());
  assert.equal((await post(without.port)).status, 404);
});
