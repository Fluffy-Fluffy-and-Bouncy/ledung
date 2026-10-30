// Push notifications to paired phones (issue #246, docs/steps/push.md): Web Push with VAPID, sent by Ledung itself.
// Two standards, both with node:crypto, rather than the web-push package and its five dependencies: the VAPID
// token (RFC 8292, a JWT signed ES256) and the payload's encryption (RFC 8291, aes128gcm).
//
// A notification says which computer and what kind of item, never its text: the page fetches that when opened,
// after its usual sign-in, so the push service (Apple's, Google's) never sees a question.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { PermissionInfo, QuestionInfo, ServerEvent } from '../shared/protocol.ts';
import { permissionWaits, questionWaits } from '../shared/waiting.ts';
import { exercisedLine } from '../platform/exercised.ts';

/** The browser's subscription as PushSubscription.toJSON() gives it. */
export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** What a notification carries, all of it. */
export interface PushPayload {
  computer: string;
  kind: 'question' | 'permission';
  /** The notification's tag: the page's own notifications use the same (web/src/notify.ts), so they replace each other. */
  item: string;
  /** Where tapping it goes, in the page. */
  open: string;
}

export class PushError extends Error {}

/** What a computer tells its linked computers of a new item (issue #451): its kind and its tag, nothing else. */
export type LinkedPushItem = Pick<PushPayload, 'kind' | 'item'>;

/** A linked computer's item as it came over the link, checked: only the kinds and tags payloadFor makes; null: not one. */
export function linkedPushItem(raw: Record<string, unknown>): LinkedPushItem | null {
  const { kind, item } = raw;
  if (typeof item !== 'string') return null;
  if (kind === 'question' && /^q\d{1,12}$/.test(item)) return { kind, item };
  if (kind === 'permission' && /^p[A-Za-z0-9-]{1,80}$/.test(item)) return { kind, item };
  return null;
}

/**
 * The payload for a linked computer's item, on this computer's phones (issue #451): titled with that computer's name
 * as its tab here shows it, and its tag kept apart from this computer's own item of the same number. Tapping opens
 * that computer's tab (`#/c/<public name>`, App), not the item in it: nothing of this page goes into a computer's
 * frame (issue #241), so its page opens where it was.
 */
export function linkedPayload(item: LinkedPushItem, computer: { id: string; name: string }): PushPayload {
  return { computer: computer.name, kind: item.kind, item: `${computer.id}:${item.item}`, open: `/#/c/${encodeURIComponent(computer.id)}` };
}

/**
 * The push services' hosts: a subscription's endpoint must be one, so a paired device can't make Ledung post to any
 * address (Google; Apple; Mozilla; Microsoft for Edge). A dot at the start: that name's subdomains.
 */
export const PUSH_HOSTS = ['fcm.googleapis.com', '.push.apple.com', '.push.services.mozilla.com', '.notify.windows.com'];

/** How long a push service keeps a message for a phone that is off: a day, then it no longer matters. */
const TTL_SECONDS = 24 * 60 * 60;
/** The VAPID token's life; RFC 8292 allows at most 24 hours. */
const TOKEN_SECONDS = 12 * 60 * 60;
const RECORD_SIZE = 4096;

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

/**
 * RFC 8291: the message encrypted for one subscription. The key pair and salt are new for every message; tests give
 * the RFC's own (Appendix A).
 */
export function encrypt(plaintext: Buffer, uaPublic: Buffer, authSecret: Buffer, fixed?: { asPrivate: Buffer; salt: Buffer }): Buffer {
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixed?.salt ?? crypto.randomBytes(16);
  const secret = ecdh.computeSecret(uaPublic);
  const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Buffer, length: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
  const ikm = hkdf(secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // One record, so the last-record delimiter 0x02 and no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([header, asPublic, body]);
}

/** The VAPID key pair, made on first use and kept in `file`: it never leaves this computer. */
export function loadOrCreateVapid(file: string): { publicKey: string; privateKey: crypto.KeyObject } {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.publicKey === 'string' && typeof saved.privateKey === 'string') {
      return { publicKey: saved.publicKey, privateKey: crypto.createPrivateKey(saved.privateKey) };
    }
  } catch { /* none yet, or unreadable: a new pair */ }
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const publicKey = b64(Buffer.concat([Buffer.from([4]), unb64(jwk.x!), unb64(jwk.y!)]));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ publicKey, privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) }), { mode: 0o600 });
  return { publicKey, privateKey };
}

/** RFC 8292: the Authorization header for one push service, `aud` its origin. */
export function vapidHeader(endpoint: string, keys: { publicKey: string; privateKey: crypto.KeyObject }, subject: string, now: number): string {
  const part = (v: unknown) => b64(Buffer.from(JSON.stringify(v)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + TOKEN_SECONDS, sub: subject })}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64(signature)}, k=${keys.publicKey}`;
}

/** A subscription as given by the page, checked: an endpoint of a known push service, and keys that work. */
export function checkSubscription(raw: unknown, hosts: readonly string[] = PUSH_HOSTS): SubscriptionInput {
  const s = raw as Partial<SubscriptionInput> | null;
  if (!s || typeof s.endpoint !== 'string' || typeof s.keys?.p256dh !== 'string' || typeof s.keys.auth !== 'string') {
    throw new PushError('Send the browser\'s push subscription: endpoint and keys.');
  }
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    throw new PushError('The push endpoint is not an address.');
  }
  const host = url.hostname.toLowerCase();
  const known = hosts.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h));
  if (url.protocol !== 'https:' || url.username || url.password || !known || s.endpoint.length > 1000) {
    throw new PushError('The push endpoint is not one of the push services Ledung sends to.');
  }
  const p256dh = unb64(s.keys.p256dh);
  const auth = unb64(s.keys.auth);
  // computeSecret refuses a point that isn't on the curve (RFC 8291 section 7 asks for that check).
  try {
    if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw new Error();
    const probe = crypto.createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(p256dh);
  } catch {
    throw new PushError('The push subscription\'s keys are not valid.');
  }
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

/** The payload for a new item: the computer and the kind, never the item's text. */
export function payloadFor(event: ServerEvent, computer: string): PushPayload | null {
  if (event.type === 'question') {
    const q: QuestionInfo = event.question;
    return { computer, kind: 'question', item: `q${q.id}`, open: `/#/waiting/q/${q.id}` };
  }
  if (event.type === 'permission') {
    const p: PermissionInfo = event.permission;
    return { computer, kind: 'permission', item: `p${p.id}`, open: `/#/s/${encodeURIComponent(p.sessionId)}` };
  }
  return null;
}

/** The EXERCISED line once per run (worker.md, "EXERCISED line"). */
let exercised451 = false;

type Row = { device_id: string; endpoint: string; p256dh: string; auth: string };

export interface PushOptions {
  db: DatabaseSync;
  /** The VAPID key pair's file (in remoteDir(), next to the relay's keys). */
  keyFile: string;
  /** This computer's name as the page's computer tabs show it. */
  computer: () => string;
  /** The public name, for the token's contact; null: no relay, so nothing is sent. */
  publicName: () => string | null;
  /**
   * A new item here, for the linked computers (issue #451, Martin's pick on question #496: one switch, through the
   * first computer): each pushes it to the phones subscribed there, so a phone needs push on one computer only.
   */
  forward?: (item: LinkedPushItem) => void;
  fetch?: typeof fetch;
  hosts?: readonly string[];
  now?: () => number;
  log?: (line: string) => void;
}

export class Push {
  private readonly opts: PushOptions;
  private keys: ReturnType<typeof loadOrCreateVapid> | null = null;
  /** Items already told about, or already waiting when Ledung started: each notifies once. */
  private readonly seen = new Set<string>();
  /** Sends still on their way; tests wait for them. */
  private readonly sending = new Set<Promise<void>>();

  constructor(opts: PushOptions) {
    this.opts = opts;
  }

  /** What waits already when Ledung starts: not new, so a restart doesn't notify again. */
  seed(questions: QuestionInfo[], permissions: PermissionInfo[]): void {
    for (const q of questions) if (questionWaits(q)) this.seen.add(`q${q.id}`);
    for (const p of permissions) if (permissionWaits(p)) this.seen.add(`p${p.id}`);
  }

  publicKey(): string {
    return this.vapid().publicKey;
  }

  private vapid() {
    return (this.keys ??= loadOrCreateVapid(this.opts.keyFile));
  }

  subscribe(deviceId: string, raw: unknown): void {
    const s = checkSubscription(raw, this.opts.hosts);
    this.opts.db.prepare('INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT (device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at')
      .run(deviceId, s.endpoint, s.keys.p256dh, s.keys.auth, this.now());
  }

  /** Switched off, or the device revoked: true if it had one. */
  unsubscribe(deviceId: string): boolean {
    return Number(this.opts.db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(deviceId).changes) > 0;
  }

  subscribed(deviceId: string): boolean {
    return !!this.opts.db.prepare('SELECT 1 FROM push_subscriptions WHERE device_id = ?').get(deviceId);
  }

  /** Every event the page gets passes here; a newly waiting question or permission prompt notifies every phone. */
  notice(event: ServerEvent): void {
    let key: string, waiting: boolean;
    if (event.type === 'question') [key, waiting] = [`q${event.question.id}`, questionWaits(event.question)];
    else if (event.type === 'permission') [key, waiting] = [`p${event.permission.id}`, permissionWaits(event.permission)];
    else return;
    if (!waiting) {
      this.seen.delete(key);
      return;
    }
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const payload = payloadFor(event, this.opts.computer());
    if (!payload || !this.opts.publicName()) return;
    this.opts.forward?.({ kind: payload.kind, item: payload.item });
    this.send(payload);
  }

  /**
   * A linked computer's new item (issue #451), to this computer's phones only: never forwarded again, so an item goes
   * one hop and two linked computers can't send it back and forth.
   */
  fromLinked(item: LinkedPushItem, computer: { id: string; name: string }): void {
    if (!this.opts.publicName()) return;
    if (!exercised451) {
      exercised451 = true;
      exercisedLine('EXERCISED #451 a linked computer\'s item pushed to this computer\'s phones');
    }
    this.send(linkedPayload(item, computer));
  }

  private send(payload: PushPayload): void {
    const sent = this.sendAll(payload).catch((e) => this.log(`Push: ${(e as Error).message}`)).finally(() => this.sending.delete(sent));
    this.sending.add(sent);
  }

  /** Waits for the sends under way (tests). */
  async settled(): Promise<void> {
    while (this.sending.size) await Promise.all([...this.sending]);
  }

  /** To every live device's subscription; one the push service no longer knows (404, 410) is dropped. */
  private async sendAll(payload: PushPayload): Promise<void> {
    const subject = `https://${this.opts.publicName()}`;
    const rows = this.opts.db.prepare('SELECT s.* FROM push_subscriptions s JOIN devices d ON d.id = s.device_id WHERE d.revoked_at IS NULL').all() as Row[];
    const body = Buffer.from(JSON.stringify(payload));
    await Promise.all(rows.map(async (r) => {
      try {
        const res = await (this.opts.fetch ?? fetch)(r.endpoint, {
          method: 'POST',
          headers: {
            TTL: String(TTL_SECONDS), Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
            Authorization: vapidHeader(r.endpoint, this.vapid(), subject, this.now()),
          },
          body: new Uint8Array(encrypt(body, unb64(r.p256dh), unb64(r.auth))),
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 404 || res.status === 410) {
          this.opts.db.prepare('DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint = ?').run(r.device_id, r.endpoint);
          this.log(`Push: the push service no longer knows a device's subscription (${res.status}); dropped it.`);
        } else if (!res.ok) this.log(`Push: the push service refused a notification (${res.status}).`);
      } catch (e) {
        this.log(`Push: could not reach the push service: ${(e as Error).message}`);
      }
    }));
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private log(line: string): void {
    (this.opts.log ?? console.log)(line);
  }
}
