// Paired devices (issue #160, docs/steps/relay.md step 4): through the public name, a device cookie is
// the only way in. The install's token never counts there, so a leaked token or a leaked sign-in link
// cannot be used from the internet, and each phone can be locked out on its own.
//
// A device is paired with a one-time code that Settings shows on this computer (a link and a QR code):
// 10 minutes, used once, one at a time. Codes live in memory only, so a restart ends any that are open.
//
// A browser on this computer or the local network is a device too (Project-Ledung#482, step 1 of #477): its
// ledung_auth cookie is a row of kind 'browser', kept as a hash, renewed daily, listed and removed in Settings like a
// phone. Browser rows count only locally and phone and computer rows only through the public name (byCookie's `where`).
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** The device cookie. `__Host-` makes the browser keep it only for this exact name, over HTTPS, at Path=/. */
export const DEVICE_COOKIE = '__Host-ledung_device';
export const PAIR_CODE_MS = 10 * 60 * 1000;
const PAIR_CODE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PAIR_CODE_LENGTH = 20;
/** How long after pairing the device may register its passkey (step 5): a copied cookie later can't add its own. */
export const PASSKEY_WINDOW_MS = 10 * 60 * 1000;
/** last_used_at is written at most this often per device, not on every request. */
const TOUCH_MS = 60 * 1000;

/**
 * A device is a phone or a computer (issue #241; Martin's decision 6 on #245, "On the computer, I want the signoff
 * to last untill I have to log on again ... phone should work as it does now"). Chosen on this computer when the
 * pairing code is made, kept in the device's row, never in its cookie, and never changed: to change it, pair again.
 */
export type DeviceKind = 'phone' | 'computer' | 'browser';
export const DEVICE_KINDS: DeviceKind[] = ['phone', 'computer', 'browser'];
/** A computer device unused this long must log on again (question 5 on #245). */
export const COMPUTER_IDLE_MS = 14 * 24 * 60 * 60 * 1000;
/** A computer device's cookie is renewed once this old, so a copy of it stops working within a day (question 5). */
export const COOKIE_RENEW_MS = 24 * 60 * 60 * 1000;
/** The renewed cookie's old value still works this long, for requests the browser sent before it got the new one. */
export const OLD_COOKIE_GRACE_MS = 60 * 1000;
/** A browser unused this long is removed, as its cookie (Max-Age a year) is gone from it by then (as #476's sign-ins). */
export const BROWSER_UNUSED_MS = 365 * 24 * 60 * 60 * 1000;
/** At most this many live browsers; past it the one used longest ago is removed (as #476's MAX_SIGN_INS). */
export const MAX_BROWSERS = 200;
/**
 * The name of a browser signed in before browsers became devices (the migration in database.ts); the first time it is
 * used it is named from its User-Agent instead (design #477 section 3).
 */
export const LEGACY_BROWSER_NAME = 'Browser signed in before the update';

export interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** The passkey's credential id (base64url), or null before one is registered. */
  credentialId: string | null;
  publicKey: Uint8Array<ArrayBuffer> | null;
  counter: number;
  /** When the passkey was set up: shown in Settings, so a passkey added by someone else in the window after pairing shows (code review Minor 2). */
  passkeyAt: number | null;
  kind: DeviceKind;
  /** Paired inside a frame on another computer's page: its cookie is Partitioned (issue #241). */
  partitioned: boolean;
  /** A computer: when its passkey check logged it on; null while logged off. Phones: always null. */
  loggedOnAt: number | null;
  /** When its current cookie was set. */
  cookieAt: number | null;
  /** The linked computer whose page asked for its pairing code (issue #273); null: paired from this computer. */
  pairedVia: string | null;
}

export interface DeviceView {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  passkey: boolean;
  passkeyAt: number | null;
  kind: DeviceKind;
  /** Paired through the link from this linked computer (issue #273); null: from this computer. */
  pairedVia: string | null;
}

type Row = Record<string, any>;

const hash = (secret: string) => crypto.createHash('sha256').update(secret).digest('hex');

function toDevice(r: Row): Device {
  return {
    id: r.id, name: r.name, createdAt: Number(r.created_at), lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at),
    credentialId: r.credential_id ?? null, publicKey: r.public_key ? new Uint8Array(r.public_key) : null, counter: Number(r.counter ?? 0),
    passkeyAt: r.passkey_at == null ? null : Number(r.passkey_at),
    kind: r.kind === 'computer' || r.kind === 'browser' ? r.kind : 'phone', partitioned: !!r.partitioned,
    loggedOnAt: r.logged_on_at == null ? null : Number(r.logged_on_at), cookieAt: r.cookie_at == null ? null : Number(r.cookie_at),
    pairedVia: r.paired_via ?? null,
  };
}

export const deviceView = (d: Device): DeviceView => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt, passkey: !!d.credentialId, passkeyAt: d.passkeyAt, kind: d.kind, pairedVia: d.pairedVia });

/** A device's name as the person typed it: trimmed, one line, short. */
export function deviceName(raw: unknown, fallback = 'Phone'): string {
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60) : '';
  return name || fallback;
}

/** A browser's name from its User-Agent, such as "Firefox on macOS": what Settings lists it as until it is renamed. */
export function browserName(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  // Order matters: Edge and Opera also say Chrome, Chrome also says Safari.
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux|X11/.test(ua) ? 'Linux' : null;
  return os ? `${browser} on ${os}` : browser;
}

export class Devices {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private code: { value: Buffer; expiresAt: number; kind: DeviceKind; via: string | null; viaLink: string | null } | null = null;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /**
   * A new pairing code; any earlier one stops working. Letters and digits only, 20 of them (103 bits, plenty for
   * one code that lives 10 minutes): the QR code carries the link in capitals, in its denser alphanumeric mode,
   * so the code is matched in either case (#194).
   */
  newPairCode(kind: DeviceKind = 'phone', via: { link: string; name: string } | null = null): { code: string; expiresAt: number; kind: DeviceKind } {
    const code = Array.from({ length: PAIR_CODE_LENGTH }, () => PAIR_CODE_CHARS[crypto.randomInt(PAIR_CODE_CHARS.length)]).join('');
    const expiresAt = this.now() + PAIR_CODE_MS;
    this.code = { value: Buffer.from(code), expiresAt, kind, via: via?.name ?? null, viaLink: via?.link ?? null };
    return { code, expiresAt, kind };
  }

  /**
   * Unlinking stops what the link gave (review 275, Important 1): an open code a linked computer asked for, and that
   * computer is no longer linked, is closed.
   */
  closeCodeUnlessLinked(links: ReadonlySet<string>): void {
    if (this.code?.viaLink && !links.has(this.code.viaLink)) this.code = null;
  }

  /** The linked computer the open code was made for (issue #273), while `code` is that code; null otherwise. */
  codeVia(code: unknown): string | null {
    return this.codeValid(code) ? this.code!.via : null;
  }

  /** True while `code` is the open, unexpired code; uses nothing up. */
  codeValid(code: unknown): boolean {
    // ASCII letters and digits only: a character such as the Kelvin sign would lower-case into the alphabet.
    if (typeof code !== 'string' || !/^[0-9a-z]+$/i.test(code) || !this.code) return false;
    if (this.now() >= this.code.expiresAt) {
      this.code = null;
      return false;
    }
    const given = Buffer.from(code.toLowerCase());
    return given.length === this.code.value.length && crypto.timingSafeEqual(given, this.code.value);
  }

  /**
   * Pairs a device with the open code, which is then used up, as the kind the code was made for. `partitioned`: paired
   * inside a frame (issue #241). Returns the device's cookie value, or null.
   */
  pair(code: unknown, name: unknown, partitioned = false): { device: Device; cookie: string } | null {
    if (!this.codeValid(code)) return null;
    const { kind, via } = this.code!;
    this.code = null;
    return this.add(kind, deviceName(name, kind === 'browser' ? 'Browser' : 'Phone'), partitioned, via);
  }

  /**
   * A browser signed in on this computer or the local network (Project-Ledung#482): today through the sign-in link or
   * the swap of an old token cookie, which need no pairing code (the one-tap approval that will make one is step 2 of
   * #477). Past MAX_BROWSERS live browsers, the one used longest ago is removed: `removed` names them, so the server
   * closes their pages as Remove does (self-check of #482, finding 3b).
   */
  addBrowser(name: string): { device: Device; cookie: string; removed: string[] } {
    this.pruneBrowsers();
    const added = this.add('browser', deviceName(name, 'Browser'), false, null);
    const removed = (this.db.prepare("SELECT id FROM devices WHERE kind = 'browser' AND revoked_at IS NULL ORDER BY last_used_at DESC, created_at DESC LIMIT -1 OFFSET ?")
      .all(MAX_BROWSERS) as Row[]).map((r) => String(r.id));
    for (const id of removed) this.revoke(id);
    return { ...added, removed };
  }

  /**
   * Removes browsers unused for BROWSER_UNUSED_MS, whose cookie has expired, so one never used again leaves the list too
   * and not only one whose cookie comes back (as #476's sign-ins went when loaded; self-check of #482, finding 2).
   */
  private pruneBrowsers(): void {
    this.db.prepare("UPDATE devices SET revoked_at = ? WHERE kind = 'browser' AND revoked_at IS NULL AND COALESCE(last_used_at, created_at) < ?")
      .run(this.now(), this.now() - BROWSER_UNUSED_MS);
  }

  private add(kind: DeviceKind, name: string, partitioned: boolean, via: string | null): { device: Device; cookie: string } {
    const cookie = crypto.randomBytes(32).toString('hex');
    const id = crypto.randomUUID();
    const at = this.now();
    this.db.prepare('INSERT INTO devices (id, name, cookie_hash, created_at, last_used_at, kind, partitioned, cookie_at, paired_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, hash(cookie), at, at, kind, partitioned ? 1 : 0, at, via);
    return { device: this.get(id)!, cookie };
  }

  /**
   * The live (not revoked) device a cookie belongs to. A computer's or browser's cookie that a renewal replaced still
   * counts for a minute; used after that, two browsers hold the device's cookie, so the device is revoked (question 5
   * on #245). `where`: 'public' finds phones and computers, the only devices through the public name; 'local' finds
   * browsers, which count only on this computer and the local network (Project-Ledung#482).
   */
  byCookie(cookie: string | null | undefined, where: 'public' | 'local' = 'public'): Device | null {
    if (!cookie || !/^[0-9a-f]{64}$/.test(cookie)) return null;
    const kinds = where === 'local' ? "kind = 'browser'" : "kind <> 'browser'";
    let r = this.db.prepare(`SELECT * FROM devices WHERE cookie_hash = ? AND revoked_at IS NULL AND ${kinds}`).get(hash(cookie)) as Row | undefined;
    const at = this.now();
    if (!r) {
      const old = this.db.prepare(`SELECT * FROM devices WHERE old_cookie_hash = ? AND revoked_at IS NULL AND ${kinds}`).get(hash(cookie)) as Row | undefined;
      if (!old) return null;
      if (at > Number(old.old_cookie_until)) {
        this.revoke(old.id);
        this.onReuse?.(toDevice(old));
        return null;
      }
      r = old;
    }
    const device = toDevice(r);
    // A browser unused a year has lost its cookie (Max-Age a year); a copy of it found later signs nothing in.
    if (device.kind === 'browser' && at - (device.lastUsedAt ?? device.createdAt) > BROWSER_UNUSED_MS) {
      this.revoke(device.id);
      return null;
    }
    // 14 days unused logs a computer off, judged before this use counts as one.
    if (device.loggedOnAt !== null && at - Math.max(device.lastUsedAt ?? 0, device.loggedOnAt) >= COMPUTER_IDLE_MS) {
      this.logOff(device.id);
      device.loggedOnAt = null;
    }
    if (device.lastUsedAt == null || at - device.lastUsedAt >= TOUCH_MS) {
      this.db.prepare('UPDATE devices SET last_used_at = ? WHERE id = ?').run(at, device.id);
      device.lastUsedAt = at;
    }
    return device;
  }

  /**
   * For the log only (issue #286): what a device cookie that let nothing in was. A removed device's (revoked, or an
   * old value of one used after its renewal), or one this Ledung never made or no longer knows.
   */
  cookieState(cookie: string): 'removed' | 'unknown' {
    if (!/^[0-9a-f]{64}$/.test(cookie)) return 'unknown';
    const h = hash(cookie);
    return this.db.prepare('SELECT 1 FROM devices WHERE cookie_hash = ? OR old_cookie_hash = ?').get(h, h) ? 'removed' : 'unknown';
  }

  /** A live device by id. */
  get(id: string): Device | null {
    const r = this.db.prepare('SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL').get(id) as Row | undefined;
    return r ? toDevice(r) : null;
  }

  list(): DeviceView[] {
    this.pruneBrowsers();
    return (this.db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at').all() as Row[]).map((r) => deviceView(toDevice(r)));
  }

  /** True if the device was live. */
  rename(id: string, name: string): boolean {
    const fallback = this.get(id)?.kind === 'browser' ? 'Browser' : 'Phone';
    return Number(this.db.prepare('UPDATE devices SET name = ? WHERE id = ? AND revoked_at IS NULL').run(deviceName(name, fallback), id).changes) > 0;
  }

  /** Locks a device out for good; true if it was live. */
  revoke(id: string): boolean {
    return Number(this.db.prepare('UPDATE devices SET revoked_at = ?, logged_on_at = NULL WHERE id = ? AND revoked_at IS NULL').run(this.now(), id).changes) > 0;
  }

  /** Told when an old, renewed cookie was used again and its device revoked for it (the server closes its pages). */
  onReuse: ((device: Device) => void) | null = null;

  /**
   * A computer's or browser's new cookie when its current one is a day old, or null when none is due (phones keep
   * theirs). The old value works a minute more (OLD_COOKIE_GRACE_MS), then only revokes the device.
   */
  renewCookie(device: Device): string | null {
    const at = this.now();
    if (device.kind === 'phone' || at - (device.cookieAt ?? device.createdAt) < COOKIE_RENEW_MS) return null;
    const cookie = crypto.randomBytes(32).toString('hex');
    const done = this.db.prepare('UPDATE devices SET old_cookie_hash = cookie_hash, old_cookie_until = ?, cookie_hash = ?, cookie_at = ? WHERE id = ? AND revoked_at IS NULL AND cookie_at IS ?')
      .run(at + OLD_COOKIE_GRACE_MS, hash(cookie), at, device.id, device.cookieAt);
    // Two requests at once: only the first renews; the other keeps the cookie it came with, valid for the grace minute.
    return Number(done.changes) > 0 ? cookie : null;
  }

  /** A computer logs on (after its passkey check): changes need no unlock until it logs off. */
  logOn(id: string): void {
    this.db.prepare("UPDATE devices SET logged_on_at = ? WHERE id = ? AND revoked_at IS NULL AND kind = 'computer'").run(this.now(), id);
  }

  logOff(id: string): void {
    this.db.prepare('UPDATE devices SET logged_on_at = NULL WHERE id = ?').run(id);
  }

  /**
   * A computer logged on: until when it stays logged on if unused (14 days after its last use); null when it must log
   * on. byCookie logs off one unused that long before its use counts.
   */
  loggedOnUntil(id: string): number | null {
    const d = this.get(id);
    if (!d || d.kind !== 'computer' || d.loggedOnAt === null) return null;
    const until = Math.max(d.lastUsedAt ?? 0, d.loggedOnAt) + COMPUTER_IDLE_MS;
    if (until <= this.now()) {
      this.logOff(id);
      return null;
    }
    return until;
  }

  /** May this device still register its passkey: none yet, and within the window after pairing. */
  mayRegisterPasskey(d: Device): boolean {
    return !d.credentialId && this.now() - d.createdAt < PASSKEY_WINDOW_MS;
  }

  /** Stores the device's passkey, only if it has none (the check and the write are one statement). */
  setPasskey(id: string, credentialId: string, publicKey: Uint8Array, counter: number): boolean {
    return Number(this.db.prepare('UPDATE devices SET credential_id = ?, public_key = ?, counter = ?, passkey_at = ? WHERE id = ? AND revoked_at IS NULL AND credential_id IS NULL')
      .run(credentialId, publicKey, counter, this.now(), id).changes) > 0;
  }

  setCounter(id: string, counter: number): void {
    this.db.prepare('UPDATE devices SET counter = ? WHERE id = ?').run(counter, id);
  }
}
