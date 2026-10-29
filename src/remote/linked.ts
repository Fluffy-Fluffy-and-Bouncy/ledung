// Linked computers, the hivemind's first step (issue #245, docs/steps/manager-link.md step 1): two of a person's
// Ledungs link once, each with a key for calling the other, and reach each other over each other's public name,
// end to end, exactly as a phone does (decision 7.1 there: no relay change).
//
// Linking (manager-link.md, "Linking two computers"):
// 1. Computer 1 makes a link code in Settings: its public name and a one-time secret, 10 minutes, used once.
// 2. Computer 2, given the code, makes the key K21 that computer 1 will call it with, and sends code, its own public
//    name and K21 to computer 1's /link/pair.
// 3. Computer 1 calls back computer 2's public name, /link/confirm, with K21: only the Ledung that really holds that
//    name knows K21, so a code holder can't link computer 1 to a name that isn't theirs. Then it answers step 2 with
//    K12, the key computer 2 will call it with.
// 4. Each keeps the key it sends and the SHA-256 of the key it accepts in links.json in remoteDir(), private to this
//    user like the keys next to it; never in the config, the repository or a release.
//
// Only HTTPS to the other's public name, its certificate checked as for any site; the server only lets /link/* in
// through the tunnel over TLS (server.ts), never locally.
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { PUBLIC_NAME } from '../config.ts';

export const LINKS_FILE = 'links.json';
export const LINK_CODE_MS = 10 * 60 * 1000;
/** How long computer 2 waits for computer 1's callback after sending the code. */
export const CONFIRM_MS = 60 * 1000;
const REQUEST_MS = 15_000;
const MAX_ANSWER = 16 * 1024;
const TOUCH_MS = 60 * 1000;
const SECRET_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SECRET_LENGTH = 24;
const SECRET = new RegExp(`^[${SECRET_CHARS}]{${SECRET_LENGTH}}$`);
/**
 * How long computer 1 waits for computer 2's callback: well inside computer 2's own wait for the whole pairing, so
 * computer 1 never saves a link computer 2 has already given up on (review 250, Minor 3).
 */
const CONFIRM_CALL_MS = 8_000;
const KEY = /^[A-Za-z0-9_-]{43}$/;

/** A linked computer as the page sees it: never its keys. */
export interface LinkedComputer {
  id: string;
  name: string;
  publicName: string;
  linkedAt: number;
  lastUsedAt: number | null;
  /** The port its Ledung listens on there, as it told this one (issue #273); left out: not told, 4317. */
  port?: number;
}

interface Saved extends LinkedComputer {
  /** The key this Ledung sends to it. */
  sendKey: string;
  /** SHA-256 (hex) of the key it sends to this Ledung. */
  acceptSha256: string;
}

/** A refusal with the HTTP status the link route answers with. */
export class LinkError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface LinkedOptions {
  /** remoteDir(). */
  dir: string;
  /** This Ledung's public name. */
  publicName: string;
  /** Opens TLS to another Ledung's public name; default: port 443 of that name, its certificate checked as usual. */
  connect?: (publicName: string) => tls.TLSSocket;
  /** The name a computer linked from elsewhere is shown with at first (the computer tabs' name for it, #232). */
  nameFor?: (publicName: string) => string | null;
  /** This Ledung's own port, told to linked computers so their pages may frame this one's local page (issue #273). */
  port?: number;
  /** A link was made or dropped, or a linked computer's port changed: the computer tabs and frames follow (#273). */
  onChange?: () => void;
  now?: () => number;
}

const portOf = (raw: unknown): { port?: number } => {
  const port = linkPort(raw);
  return port ? { port } : {};
};
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const newKey = () => crypto.randomBytes(32).toString('base64url');
const sameHash = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

/** A computer's name as the person typed it: trimmed, one line, short. */
export function computerName(raw: unknown, fallback: string): string {
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40) : '';
  return name || fallback;
}

/** A port another Ledung told, or undefined when it told none or nothing usable. */
export function linkPort(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : undefined;
}

/** "<public name>/<secret>"; null: not a link code. */
export function parseLinkCode(raw: unknown): { publicName: string; secret: string } | null {
  if (typeof raw !== 'string') return null;
  const m = /^([^/\s]+)\/([a-z0-9]+)$/.exec(raw.trim().replace(/^https:\/\//, ''));
  if (!m || !PUBLIC_NAME.test(m[1]!.toLowerCase()) || m[2]!.length !== SECRET_LENGTH) return null;
  return { publicName: m[1]!.toLowerCase(), secret: m[2]! };
}

/**
 * TLS to a linked computer's public name through "host:port" instead of the name's own address: for a loopback with
 * a local relay, where the name is not in DNS. The certificate is still checked for the name.
 */
export function connectVia(hostPort: string): (publicName: string) => tls.TLSSocket {
  const at = hostPort.lastIndexOf(':');
  const host = hostPort.slice(0, at);
  const port = Number(hostPort.slice(at + 1));
  return (publicName) => tls.connect({ host, port, servername: publicName, ALPNProtocols: ['http/1.1'] });
}

/** The key in an "Authorization: Bearer" header, or null. */
function bearer(header: string | undefined): string | null {
  const m = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? '');
  return m && KEY.test(m[1]!) ? m[1]! : null;
}

export class LinkedComputers {
  private readonly opts: LinkedOptions;
  private readonly file: string;
  private readonly now: () => number;
  private code: { secret: string; expiresAt: number } | null = null;
  /** Computer 2's side while computer 1 calls back: the SHA-256 of K21 → the name it was sent to, until when. */
  private readonly pending = new Map<string, { publicName: string; until: number }>();

  constructor(opts: LinkedOptions) {
    this.opts = opts;
    this.file = path.join(opts.dir, LINKS_FILE);
    this.now = opts.now ?? Date.now;
  }

  list(): LinkedComputer[] {
    return this.read().map(({ sendKey: _s, acceptSha256: _a, ...view }) => view);
  }

  /** A new link code, replacing an open one. */
  newCode(): { code: string; expiresAt: number } {
    const secret = Array.from(crypto.randomBytes(SECRET_LENGTH), (b) => SECRET_CHARS[b % SECRET_CHARS.length]).join('');
    const expiresAt = this.now() + LINK_CODE_MS;
    this.code = { secret, expiresAt };
    return { code: `${this.opts.publicName}/${secret}`, expiresAt };
  }

  /** Computer 2: link with the computer whose code this is, named `name` here. */
  async join(rawCode: unknown, rawName: unknown): Promise<LinkedComputer> {
    const code = parseLinkCode(rawCode);
    if (!code) throw new LinkError(400, 'That is not a link code. It looks like name.example.com/abc…, from Settings → Linked computers on the other computer.');
    if (code.publicName === this.opts.publicName) throw new LinkError(400, 'That code is this computer\'s own.');
    if (this.read().some((l) => l.publicName === code.publicName)) throw new LinkError(400, `This computer is already linked with ${code.publicName}. Unlink it first.`);
    const k21 = newKey();
    this.pending.set(sha256(k21), { publicName: code.publicName, until: this.now() + CONFIRM_MS });
    try {
      const answer = await this.call(code.publicName, '/link/pair', { code: code.secret, publicName: this.opts.publicName, key: k21, ...this.ownPort() });
      const k12 = typeof answer.key === 'string' && KEY.test(answer.key) ? answer.key : null;
      if (!k12) throw new LinkError(502, `${code.publicName} gave no usable key.`);
      return this.save({ name: computerName(rawName, this.defaultName(code.publicName)), publicName: code.publicName, sendKey: k12, acceptSha256: sha256(k21), ...portOf(answer.port) });
    } finally {
      this.pending.delete(sha256(k21));
    }
  }

  /** Computer 1's /link/pair: the code, then the callback to the name given, then the key back. */
  async pair(body: Record<string, unknown>): Promise<{ key: string; port?: number }> {
    const open = this.code;
    if (!open || this.now() >= open.expiresAt) {
      this.code = null;
      throw new LinkError(403, 'No link code is open on this computer.');
    }
    const given = typeof body.code === 'string' ? body.code : '';
    // Only the code's own alphabet is compared: anything else is a wrong guess, never an error (review 250, Minor 1).
    // Wrong guesses don't close the code: its 124 bits need no limit, and every guess comes through the relay alike, so
    // a limit could not tell a stranger from the other computer and would let anyone who sees the public name close
    // it (review 250, Minor 2).
    if (!SECRET.test(given) || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(open.secret))) {
      throw new LinkError(403, 'That link code is not valid here.');
    }
    // Used once, also when what follows fails: a new code is one click.
    this.code = null;
    const peer = typeof body.publicName === 'string' ? body.publicName.toLowerCase() : '';
    const k21 = typeof body.key === 'string' && KEY.test(body.key) ? body.key : null;
    if (!PUBLIC_NAME.test(peer) || peer === this.opts.publicName || !k21) throw new LinkError(400, 'Send the code, your public name and your key.');
    if (this.read().some((l) => l.publicName === peer)) throw new LinkError(409, `${this.opts.publicName} is already linked with ${peer}.`);
    const nonce = crypto.randomBytes(16).toString('hex');
    const back = await this.call(peer, '/link/confirm', { nonce }, k21, CONFIRM_CALL_MS).catch((e: Error) => {
      throw new LinkError(502, `${this.opts.publicName} could not confirm ${peer}: ${e.message}`);
    });
    if (back.nonce !== nonce) throw new LinkError(502, `${peer} did not confirm the link.`);
    const k12 = newKey();
    this.save({ name: this.defaultName(peer), publicName: peer, sendKey: k21, acceptSha256: sha256(k12), ...portOf(body.port) });
    return { key: k12, ...this.ownPort() };
  }

  /** Computer 2's /link/confirm: only while its own join waits, only with the key it just sent. */
  confirm(authorization: string | undefined, body: Record<string, unknown>): { nonce: string } {
    const key = bearer(authorization);
    const hit = key ? this.pending.get(sha256(key)) : undefined;
    if (!hit || this.now() >= hit.until) throw new LinkError(401, 'Not a link this computer is making.');
    if (typeof body.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(body.nonce)) throw new LinkError(400, 'Send the nonce.');
    return { nonce: body.nonce };
  }

  /** The linked computer whose key this is (constant-time on the hash), its last use noted; null: none. */
  byKey(authorization: string | undefined): LinkedComputer | null {
    const key = bearer(authorization);
    if (!key) return null;
    const hash = sha256(key);
    const links = this.read();
    const hit = links.find((l) => sameHash(l.acceptSha256, hash));
    if (!hit) return null;
    const at = this.now();
    if (hit.lastUsedAt === null || at - hit.lastUsedAt >= TOUCH_MS) {
      hit.lastUsedAt = at;
      this.write(links);
    }
    return this.list().find((l) => l.id === hit.id)!;
  }

  /** Unlinks here at once, then tells the other computer, which drops its side too; a failure there is only logged. */
  remove(id: string): LinkedComputer | null {
    const links = this.read();
    const gone = links.find((l) => l.id === id);
    if (!gone) return null;
    this.write(links.filter((l) => l.id !== id));
    this.opts.onChange?.();
    this.call(gone.publicName, '/link/unlink', {}, gone.sendKey).catch((e: Error) => {
      console.log(`Linked computers: unlinked ${gone.publicName} here; telling it failed (${e.message}). Its key no longer works here.`);
    });
    const { sendKey: _s, acceptSha256: _a, ...view } = gone;
    return view;
  }

  /** The other computer unlinked: its side goes here too. */
  dropped(id: string): void {
    const links = this.read();
    if (!links.some((l) => l.id === id)) return;
    this.write(links.filter((l) => l.id !== id));
    this.opts.onChange?.();
  }

  /** /link/hello from a linked computer: the port it told, kept when it changed; this one's own port back. */
  hello(id: string, body: Record<string, unknown>): { port?: number } {
    this.notePort(id, linkPort(body.port));
    return this.ownPort();
  }

  /**
   * Tells every linked computer this Ledung's port, and keeps the port each answers with (issue #273): at start, so a
   * port changed since linking reaches the other side. A computer that is offline then tells its own at its start.
   */
  helloAll(): void {
    for (const link of this.read()) {
      this.call(link.publicName, '/link/hello', this.ownPort(), link.sendKey)
        .then((answer) => this.notePort(link.id, linkPort(answer.port)))
        .catch((e: Error) => console.log(`Linked computers: no hello from ${link.publicName} (${e.message}).`));
    }
  }

  private notePort(id: string, port: number | undefined): void {
    if (port === undefined) return;
    const links = this.read();
    const link = links.find((l) => l.id === id);
    if (!link || link.port === port) return;
    link.port = port;
    this.write(links);
    this.opts.onChange?.();
  }

  private ownPort(): { port?: number } {
    return this.opts.port ? { port: this.opts.port } : {};
  }

  /** Calls another linked computer by its id, with this computer's key for it: the managers' calls (#245). */
  async callLinked(id: string, route: string, body: Record<string, unknown>, timeoutMs = REQUEST_MS): Promise<Record<string, unknown>> {
    const link = this.read().find((l) => l.id === id);
    if (!link) throw new LinkError(404, 'No such linked computer.');
    return this.call(link.publicName, route, body, link.sendKey, timeoutMs);
  }

  private defaultName(publicName: string): string {
    return computerName(this.opts.nameFor?.(publicName), publicName.split('.')[0]!);
  }

  private save(entry: Omit<Saved, 'id' | 'linkedAt' | 'lastUsedAt'>): LinkedComputer {
    const saved: Saved = { id: crypto.randomUUID(), linkedAt: this.now(), lastUsedAt: null, ...entry };
    this.write([...this.read(), saved]);
    this.opts.onChange?.();
    const { sendKey: _s, acceptSha256: _a, ...view } = saved;
    return view;
  }

  private read(): Saved[] {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { links?: Saved[] };
      return Array.isArray(data.links) ? data.links.filter((l) => l && typeof l.sendKey === 'string' && typeof l.acceptSha256 === 'string') : [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.log(`Linked computers: ${this.file} can't be read: ${(e as Error).message}`);
      return [];
    }
  }

  private write(links: Saved[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.new`;
    fs.writeFileSync(temp, JSON.stringify({ links }, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  /** One POST to another Ledung's public name over TLS; the JSON answer, or an error with the reason. */
  private call(publicName: string, route: string, body: Record<string, unknown>, key?: string, timeoutMs = REQUEST_MS): Promise<Record<string, unknown>> {
    const data = JSON.stringify(body);
    const connect = this.opts.connect ?? ((name: string) => tls.connect({ host: name, port: 443, servername: name, ALPNProtocols: ['http/1.1'] }));
    return new Promise((resolve, reject) => {
      const req = https.request({
        method: 'POST', path: route, createConnection: () => connect(publicName),
        headers: { Host: publicName, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => {
          text += d;
          if (text.length > MAX_ANSWER) req.destroy(new Error('the answer is too long'));
        });
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch { /* an error page: the status says enough */ }
          if (res.statusCode === 200) resolve(json);
          else reject(new LinkError(502, `${publicName} answered ${res.statusCode}${typeof json.error === 'string' ? `: ${json.error}` : ''}`));
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs / 1000} s`)));
      // The relay closes a stream for a Ledung that isn't connected before any TLS (spike #245, finding 6).
      req.on('error', (e) => reject(e instanceof LinkError ? e : new LinkError(502, /before secure TLS|ECONNRESET|socket hang up/.test(e.message)
        ? `${publicName} is offline (its Ledung is not connected to the relay).`
        : `${publicName} could not be reached: ${e.message}`)));
      req.end(data);
    });
  }
}
