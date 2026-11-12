// Files between managers on linked computers (issue #158, the first step: option A of the research report): a manager
// sends PNG, JPEG or text files with message_manager to a manager on another of the person's computers. Each file comes
// on its own /link/file call before the message that names it; this Ledung checks it again (kind by its first bytes,
// size, SHA-256), keeps a copy in its own data folder, mode 0600, and records it here as pending. The message then
// claims its files for the manager it is to, and from then on only that manager can name them, as "linked:<id>/<name>"
// in ask_user's screenshots and a review's evidence, and the page shows them through that manager's questions.
// Copies are pruned after evidenceDays, as board attachments are; files no message claimed, after an hour.
//
// The bytes of files sent and received are counted per link and day, and shown in Settings → Linked computers; nothing
// is ever held back or slowed on the count (Martin, 2026-11-06, question #609: "Track only").
//
// Audio and zip files (issue #159) are not pushed: the message names them with the sender's snapshot id, size and
// SHA-256 (linked-outbox.ts), and this Ledung records each as remote, tells the manager its handle at once, and pulls
// the bytes (fetch): streamed to <file>.part, hashed as they come, resumed from where a cut-off fetch stopped, and
// renamed into place only when size, SHA-256 and kind agree. A fetch that can't finish leaves no part behind; its row
// says why. Such a copy is never shown in a question or a review: save_linked_file puts it in a worktree (#160).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DatabaseSync } from 'node:sqlite';
import { bytesKind, contentProblem, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, safeName, sizeLabel, type AttachmentKind } from '../board/attachments.ts';
import { FileError } from '../sessions/files.ts';
import { isStreamKind, KIND_HEAD_BYTES, linkedKindLabel, streamKindOf, zipArrivalProblem, type LinkedKind, type StreamKind } from './stream-kinds.ts';

export const LINKED_FILE_PREFIX = 'linked:';
/** A file no message claimed within this long is dropped: its message never came (the sender failed on the way). */
export const PENDING_MS = 60 * 60 * 1000;
const HANDLE = /^linked:([0-9a-f]{16})\/(.+)$/;
const FILE_ID = /^[0-9a-f]{16}$/;
const LINK_ID = /^[A-Za-z0-9-]{1,64}$/;
const EXT: Record<LinkedKind, string> = { png: 'png', jpeg: 'jpg', text: 'txt', wav: 'wav', mp3: 'mp3', flac: 'flac', ogg: 'ogg', m4a: 'm4a', zip: 'zip' };
const DAY_MS = 24 * 60 * 60 * 1000;
/** A fetch that gets no byte for this long is cut off (issue #159: an idle limit, not one for the whole transfer). */
export const FETCH_IDLE_MS = 60_000;
/** A cut-off fetch is tried this many times in all, each from where the last stopped, waiting longer each time. */
export const FETCH_TRIES = 6;
export const FETCH_BACKOFF_MS = 2000;

/** What /link/file says about the bytes it carries; all of it is checked against them. */
export interface LinkedFileMeta { to: string; name: string; kind: AttachmentKind; size: number; sha: string }

/** A file a message claimed, as the receiving manager is told of it. */
export interface ReceivedFile { id: string; handle: string; name: string; kind: LinkedKind; size: number; text: string | null }

/** A fetch's answer from the sender: the bytes from `start` on (0: the whole file, whatever was asked). */
export type FetchFrom = (from: number) => Promise<{ body: Readable; start: number }>;

/** How a fetch ended. */
export type FetchResult = { ok: true; file: ReceivedFile } | { ok: false; file: ReceivedFile; problem: string };

/** A fetch refused for good (403, 404, more bytes than said): trying again would not help. */
export class FetchRefused extends Error {}

/** The most a linked computer may stream here (Project-Ledung#479): per file, and for all of one message's files. */
export interface StreamLimits { maxFileBytes: number; maxMessageBytes: number }
/** The config's defaults, linkedFiles.maxFileMB and maxMessageMB. */
export const DEFAULT_STREAM_LIMITS: StreamLimits = { maxFileBytes: 2048 * 1024 * 1024, maxMessageBytes: 4096 * 1024 * 1024 };

/** One line in Ledung's log for each streamed file refused, so the reason can be found later (Project-Ledung#479). */
function logRefused(linkId: string, name: string, why: string): void {
  console.log(`Linked computers: linked file refused from ${linkId}: ${name}: ${why}`);
}

export interface ByteTotals { today: { sent: number; received: number }; month: { sent: number; received: number } }

/** A refusal with the HTTP status /link/file answers with. */
export class LinkedFileError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** /link/file's query, or the reason it is not one: to, name, kind, size and sha. */
export function parseFileMeta(q: URLSearchParams): LinkedFileMeta {
  const to = q.get('to') ?? '';
  const kind = q.get('kind');
  const size = Number(q.get('size'));
  const sha = q.get('sha') ?? '';
  if (!to || to.length > 100) throw new LinkedFileError(400, 'Name the manager the file is for.');
  if (kind !== 'png' && kind !== 'jpeg' && kind !== 'text') throw new LinkedFileError(400, 'A file is a PNG or JPEG image or text.');
  if (!Number.isInteger(size) || size < 0 || size > (kind === 'text' ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES)) {
    throw new LinkedFileError(413, kind === 'text' ? 'A text file is at most 512 KB.' : 'An image is at most 5 MB.');
  }
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new LinkedFileError(400, 'Send the file\'s SHA-256.');
  return { to, name: safeName(q.get('name') ?? ''), kind, size, sha };
}

/** The local day, "YYYY-MM-DD", that bytes are counted under. */
function dayOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class LinkedFiles {
  private readonly db: DatabaseSync;
  private readonly dir: () => string;
  private readonly now: () => number;
  private readonly keepDays: () => number;
  private readonly limits: () => StreamLimits;
  private prunedAt = 0;

  /**
   * `dir`: where the copies are kept, in the data folder; asked each time, so tests can move it. `keepDays`: how many
   * days a copy is kept, the board's evidenceDays, read at each prune so a config change applies. `limits`: how much
   * a linked computer may stream here, read for each message so a config change applies.
   */
  constructor(db: DatabaseSync, dir: () => string, keepDays: () => number, now: () => number = Date.now, limits: () => StreamLimits = () => DEFAULT_STREAM_LIMITS) {
    this.db = db;
    this.dir = dir;
    this.keepDays = keepDays;
    this.now = now;
    this.limits = limits;
  }

  /** The copy's file: <dir>/<link id>/<file id>.<ext>, names Ledung made only. */
  private fileOf(linkId: string, id: string, kind: LinkedKind): string {
    if (!LINK_ID.test(linkId) || !FILE_ID.test(id)) throw new FileError('Not a linked file.');
    return path.join(this.dir(), linkId, `${id}.${EXT[kind]}`);
  }

  /**
   * /link/file: the bytes against what the call says of them, then the copy, mode 0600, pending until its message
   * comes. Its id back, for the message to name. `to` must already be checked as a manager that may receive files.
   */
  receive(linkId: string, meta: LinkedFileMeta, bytes: Buffer): string {
    const problem = contentProblem({ path: '', name: meta.name, kind: meta.kind, size: meta.size, sha: meta.sha }, bytes)
      ?? (bytesKind(bytes, `x.${EXT[meta.kind]}`) === meta.kind ? null : 'it is not the kind it says');
    if (problem) throw new LinkedFileError(400, `Not kept: ${problem}.`);
    this.prune();
    const id = crypto.randomBytes(8).toString('hex');
    const file = this.fileOf(linkId, id, meta.kind);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.db.prepare(`INSERT INTO linked_files (id, link_id, to_session, name, kind, size, sha, state, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(id, linkId, meta.to, meta.name, meta.kind, bytes.length, meta.sha, this.now());
    this.count(linkId, 'received', bytes.length);
    return id;
  }

  /**
   * The files a message from `linkId` to `toSession` names: each must have come from that link, for that manager, and
   * not been claimed yet. All or none: on a refusal nothing is claimed. Text comes with its content.
   */
  claim(linkId: string, toSession: string, ids: unknown): ReceivedFile[] {
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || ids.some((id) => typeof id !== 'string' || !FILE_ID.test(id))) {
      throw new LinkedFileError(400, `A message names at most ${MAX_ATTACHMENTS} files, by the ids /link/file gave.`);
    }
    const rows = (ids as string[]).map((id) => this.db.prepare('SELECT * FROM linked_files WHERE id = ?').get(id) as Record<string, any> | undefined);
    if (rows.some((r) => !r || r.link_id !== linkId || r.to_session !== toSession || r.state !== 'pending')) {
      throw new LinkedFileError(400, 'The message names a file this computer did not get from you for that manager.');
    }
    const files = rows.map((r) => {
      const kind = r!.kind as LinkedKind;
      const text = kind === 'text' ? fs.readFileSync(this.fileOf(linkId, r!.id, kind)).toString('utf8') : null;
      return { id: r!.id as string, handle: `${LINKED_FILE_PREFIX}${r!.id}/${r!.name}`, name: r!.name as string, kind, size: Number(r!.size), text };
    });
    for (const f of files) this.db.prepare(`UPDATE linked_files SET state = 'delivered' WHERE id = ?`).run(f.id);
    return files;
  }

  /** Pending files a refused message named go at once: nothing is left of a message that did not arrive. */
  drop(linkId: string, ids: unknown): void {
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (typeof id !== 'string' || !FILE_ID.test(id)) continue;
      const r = this.db.prepare(`SELECT * FROM linked_files WHERE id = ? AND link_id = ? AND state = 'pending'`).get(id, linkId) as Record<string, any> | undefined;
      if (r) this.remove(r);
    }
  }

  /**
   * A copy by its handle, for the manager it was sent to only (its questions and reviews, and the page showing them),
   * and only while its bytes are still what came and of a kind in `kinds`.
   */
  read(sessionId: string, handle: string, kinds: readonly AttachmentKind[]): { path: string; kind: AttachmentKind; bytes: Buffer } {
    const m = HANDLE.exec(handle);
    if (!m) throw new FileError('That is not a file from a linked computer.');
    this.prune();
    const r = this.db.prepare('SELECT * FROM linked_files WHERE id = ?').get(m[1]!) as Record<string, any> | undefined;
    // The name too, so the name a question shows is the one the file came with (review of PR #162, Minor 1).
    if (!r || r.to_session !== sessionId || r.name !== m[2]) throw new FileError(`Ledung has no file ${m[2]} from a linked computer for this session.`);
    this.usable(r);
    // Audio and zip (issue #159) are never shown, and never read whole here: refused before a byte of them is read.
    if (isStreamKind(r.kind)) throw new FileError(`${r.name} is ${linkedKindLabel(r.kind)}; it can't be shown in a question or a review. Save it into a session's worktree with save_linked_file.`);
    const kind = r.kind as AttachmentKind;
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(this.fileOf(r.link_id, r.id, kind));
    } catch {
      throw new FileError(`Ledung's copy of ${r.name} is gone.`);
    }
    if (contentProblem({ path: '', name: r.name, kind, size: Number(r.size), sha: r.sha }, bytes)) throw new FileError(`Ledung's copy of ${r.name} has changed; it is not shown.`);
    if (!kinds.includes(kind)) throw new FileError(`${r.name} is not ${kinds.includes('text') ? 'a PNG or JPEG image or a text file' : 'a PNG or JPEG image'}.`);
    return { path: r.name, kind, bytes };
  }

  /** Why a row's copy can't be used (still coming, failed, pruned); throws with it. Only rows of the right manager. */
  private usable(r: Record<string, any>): void {
    if (r.state === 'remote') throw new FileError(`${r.name} is still being fetched from the linked computer; Ledung tells you when it is here.`);
    if (r.state === 'failed') throw new FileError(`${r.name} could not be fetched from the linked computer (${r.problem ?? 'no reason given'}); nothing of it is kept.`);
    if (r.state !== 'delivered') throw new FileError(`Ledung has no file ${r.name} from a linked computer for this session.`);
    if (r.pruned_at !== null) throw new FileError(`${r.name} was pruned: copies from linked computers are kept for a limited number of days.`);
  }

  /**
   * A copy by its handle for save_linked_file (issues #160, #159), for the manager it was sent to only: a small kind as
   * read() gives it, bytes checked; a streamed one by its file, never read whole, with the size and SHA-256 the writer
   * checks the copy it makes against.
   */
  source(sessionId: string, handle: string): { kind: LinkedKind; name: string } & ({ bytes: Buffer } | { file: string; size: number; sha: string }) {
    const m = HANDLE.exec(handle);
    if (!m) throw new FileError('That is not a file from a linked computer.');
    const r = this.db.prepare('SELECT * FROM linked_files WHERE id = ?').get(m[1]!) as Record<string, any> | undefined;
    if (!r || !isStreamKind(r.kind)) {
      const copy = this.read(sessionId, handle, ['png', 'jpeg', 'text']);
      return { kind: copy.kind, name: copy.path, bytes: copy.bytes };
    }
    this.prune();
    if (r.to_session !== sessionId || r.name !== m[2]) throw new FileError(`Ledung has no file ${m[2]} from a linked computer for this session.`);
    this.usable(r);
    const file = this.fileOf(r.link_id, r.id, r.kind);
    if (!fs.existsSync(file)) throw new FileError(`Ledung's copy of ${r.name} is gone.`);
    return { kind: r.kind as StreamKind, name: r.name, file, size: Number(r.size), sha: r.sha };
  }

  /**
   * The streamed files a message from `linkId` to `toSession` names (issue #159), with `pushed` files besides: each is
   * recorded as remote, to be fetched, with the handle the manager is told at once. All or none: anything that is not a
   * streamed file as the sender's outbox describes it refuses the message, and nothing is recorded.
   */
  expect(linkId: string, toSession: string, offers: unknown, pushed: number): ReceivedFile[] {
    const ok = (o: any) => !!o && typeof o === 'object' && typeof o.id === 'string' && FILE_ID.test(o.id) && isStreamKind(o.kind)
      && Number.isSafeInteger(o.size) && o.size >= 0 && typeof o.sha === 'string' && /^[0-9a-f]{64}$/.test(o.sha) && typeof o.name === 'string';
    if (!Array.isArray(offers) || offers.length + pushed > MAX_ATTACHMENTS || !offers.every(ok)) {
      throw new LinkedFileError(400, `A message names at most ${MAX_ATTACHMENTS} files; a streamed one by its id, name, kind, size and SHA-256.`);
    }
    // The caps before anything is recorded, so nothing of a refused message is fetched (Project-Ledung#479).
    const { maxFileBytes, maxMessageBytes } = this.limits();
    const big = (offers as { name: string; size: number }[]).find((o) => o.size > maxFileBytes);
    if (big) {
      const why = `it is ${sizeLabel(big.size)}; this computer takes streamed files up to ${sizeLabel(maxFileBytes)} each`;
      logRefused(linkId, safeName(big.name), why);
      throw new LinkedFileError(413, `${safeName(big.name)} is not taken: ${why}.`);
    }
    const total = (offers as { size: number }[]).reduce((sum, o) => sum + o.size, 0);
    if (total > maxMessageBytes) {
      const why = `the message's streamed files are ${sizeLabel(total)} in all; this computer takes up to ${sizeLabel(maxMessageBytes)} in one message`;
      logRefused(linkId, `${offers.length} files`, why);
      throw new LinkedFileError(413, `The files are not taken: ${why}.`);
    }
    return (offers as { id: string; name: string; kind: StreamKind; size: number; sha: string }[]).map((o) => {
      const id = crypto.randomBytes(8).toString('hex');
      const name = safeName(o.name);
      this.db.prepare(`INSERT INTO linked_files (id, link_id, to_session, name, kind, size, sha, state, received_at, remote_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'remote', ?, ?)`)
        .run(id, linkId, toSession, name, o.kind, o.size, o.sha, this.now(), o.id);
      return { id, handle: `${LINKED_FILE_PREFIX}${id}/${name}`, name, kind: o.kind, size: o.size, text: null };
    });
  }

  /** Remote files a refused message named: gone with their rows. */
  forget(ids: readonly string[]): void {
    for (const id of ids) {
      const r = this.db.prepare(`SELECT * FROM linked_files WHERE id = ? AND state = 'remote'`).get(id) as Record<string, any> | undefined;
      if (r) this.remove(r);
    }
  }

  /** The streamed files still to fetch (state remote): after a restart, fetched again from where they stopped. */
  remote(): { id: string; linkId: string; toSession: string; remoteId: string }[] {
    return (this.db.prepare(`SELECT id, link_id, to_session, remote_id FROM linked_files WHERE state = 'remote'`).all() as Record<string, any>[])
      .map((r) => ({ id: r.id, linkId: r.link_id, toSession: r.to_session, remoteId: r.remote_id }));
  }

  private readonly inFlight = new Set<string>();

  /**
   * Fetches the remote file `id` with `get`, streamed to <file>.part: what is already in the part (a fetch cut off
   * before a restart) is hashed again, streamed, and asked for from its end on. Up to `tries` calls, waiting `backoffMs`
   * doubled each time; a FetchRefused (403, 404, more bytes than said) or a reason from `stop` ends it at once. Done: size, SHA-256 and kind
   * agree, the part is renamed into place, the bytes counted as received. Failed: the part is gone, the row says why.
   */
  async fetch(id: string, get: FetchFrom, opts: { tries?: number; backoffMs?: number; stop?: () => string | null } = {}): Promise<FetchResult> {
    const r = this.db.prepare(`SELECT * FROM linked_files WHERE id = ?`).get(id) as Record<string, any> | undefined;
    if (!r) throw new FileError('No such file.');
    const file: ReceivedFile = { id: r.id, handle: `${LINKED_FILE_PREFIX}${r.id}/${r.name}`, name: r.name, kind: r.kind, size: Number(r.size), text: null };
    if (r.state !== 'remote' || this.inFlight.has(id)) return { ok: false, file, problem: 'it is not waiting to be fetched' };
    this.inFlight.add(id);
    const target = this.fileOf(r.link_id, r.id, r.kind);
    const part = `${target}.part`;
    const size = Number(r.size);
    const tries = opts.tries ?? FETCH_TRIES;
    let wait = opts.backoffMs ?? FETCH_BACKOFF_MS;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      let hash = crypto.createHash('sha256');
      let have = 0;
      const restart = () => {
        fs.rmSync(part, { force: true });
        hash = crypto.createHash('sha256');
        have = 0;
      };
      if (fs.existsSync(part)) {
        // One buffer for the whole part, so hashing it again leaves no garbage behind (see linked-outbox.ts).
        const buf = Buffer.alloc(1024 * 1024);
        const fd = await fs.promises.open(part, 'r');
        try {
          for (let n = (await fd.read(buf, 0, buf.length, null)).bytesRead; n > 0; n = (await fd.read(buf, 0, buf.length, null)).bytesRead) {
            hash.update(buf.subarray(0, n));
            have += n;
          }
        } finally {
          await fd.close();
        }
        if (have > size) restart();
      }
      // A row recorded before the cap (or under a larger one) is held to it too, before a byte is asked for.
      const maxFileBytes = this.limits().maxFileBytes;
      if (size > maxFileBytes) {
        const why = `it is ${sizeLabel(size)}; this computer takes streamed files up to ${sizeLabel(maxFileBytes)} each`;
        logRefused(r.link_id, r.name, why);
        throw new FetchRefused(why);
      }
      if (size === 0) fs.writeFileSync(part, Buffer.alloc(0), { mode: 0o600 });
      for (let attempt = 1; have < size; attempt++) {
        try {
          // `stop` (the relay's cap, issue #177) is asked before every call and every chunk: a reason ends it for good.
          const stopped = opts.stop?.();
          if (stopped) throw new FetchRefused(stopped);
          const { body, start } = await get(have);
          if (start === 0 && have > 0) {
            restart();
          } else if (start !== have) {
            body.destroy();
            throw new FetchRefused(`the other computer answered from byte ${start}, not ${have}`);
          }
          // Hashed and counted only once on disk, and closed before any next try: what `have` says is what the part
          // holds, so a resume asks from its real end and never two writers append to it at once.
          const fd = await fs.promises.open(part, 'a', 0o600);
          const sink = new Writable({
            highWaterMark: 1024 * 1024,
            write(chunk: Buffer, _enc, done) {
              if (have + chunk.length > size) return done(new FetchRefused(`it is larger than the ${size} bytes the message says`));
              const stopped = opts.stop?.();
              if (stopped) return done(new FetchRefused(stopped));
              fd.write(chunk).then(() => {
                hash.update(chunk);
                have += chunk.length;
                done();
              }, done);
            },
            destroy(err, done) {
              // FileHandle.close waits for a write still in flight.
              fd.close().then(() => done(err), () => done(err));
            },
          });
          const closed = new Promise((res) => sink.once('close', res));
          try {
            await pipeline(body, sink);
          } finally {
            sink.destroy();
            await closed;
          }
          if (have < size) throw new Error(`cut off after ${have} of ${size} bytes`);
        } catch (e) {
          if (e instanceof FetchRefused) throw e;
          if (attempt >= tries) throw new FetchRefused(`${(e as Error).message} (tried ${tries} times)`);
          await new Promise((done) => setTimeout(done, wait));
          wait *= 2;
        }
      }
      const running = hash.digest('hex');
      if (running !== r.sha) throw new FetchRefused('its content is not what the message says (SHA-256)');
      const head = Buffer.alloc(KIND_HEAD_BYTES);
      const fd = fs.openSync(part, 'r');
      const read = fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      if (streamKindOf(head.subarray(0, read), `x.${EXT[r.kind as LinkedKind]}`) !== r.kind) throw new FetchRefused(`it is not really ${linkedKindLabel(r.kind)}`);
      // A zip's own directory is checked before it counts as here (Project-Ledung#479); a failing one goes with its part.
      if (r.kind === 'zip') {
        const zip = await zipArrivalProblem(part);
        if (zip) {
          logRefused(r.link_id, r.name, zip);
          throw new FetchRefused(zip);
        }
      }
      fs.renameSync(part, target);
      this.db.prepare(`UPDATE linked_files SET state = 'delivered' WHERE id = ?`).run(id);
      this.count(r.link_id, 'received', size);
      return { ok: true, file };
    } catch (e) {
      fs.rmSync(part, { force: true });
      const problem = (e as Error).message;
      this.db.prepare(`UPDATE linked_files SET state = 'failed', problem = ? WHERE id = ?`).run(problem, id);
      return { ok: false, file, problem };
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * Copies older than keepDays go and their rows say so; files no message claimed within PENDING_MS go with their row.
   * At most once a minute unless `force`.
   */
  prune(force = false): void {
    const now = this.now();
    if (!force && now - this.prunedAt < 60_000) return;
    this.prunedAt = now;
    const old = this.db.prepare(`SELECT * FROM linked_files WHERE state = 'delivered' AND pruned_at IS NULL AND received_at < ?`).all(now - this.keepDays() * DAY_MS) as Record<string, any>[];
    for (const r of old) {
      this.removeFile(r);
      this.db.prepare('UPDATE linked_files SET pruned_at = ? WHERE id = ?').run(now, r.id);
    }
    const stale = this.db.prepare(`SELECT * FROM linked_files WHERE state = 'pending' AND received_at < ?`).all(now - PENDING_MS) as Record<string, any>[];
    for (const r of stale) this.remove(r);
  }

  private remove(r: Record<string, any>): void {
    this.removeFile(r);
    this.db.prepare('DELETE FROM linked_files WHERE id = ?').run(r.id);
  }

  private removeFile(r: Record<string, any>): void {
    try {
      fs.rmSync(this.fileOf(r.link_id, r.id, r.kind as LinkedKind), { force: true });
      // A fetch cut off by a prune or a refused message leaves no part either.
      fs.rmSync(`${this.fileOf(r.link_id, r.id, r.kind as LinkedKind)}.part`, { force: true });
    } catch (e) {
      console.error(`Linked files: could not remove ${r.id}: ${(e as Error).message}`);
    }
  }

  /** Counts file bytes sent to or received from a linked computer, under today. Never refuses anything. */
  count(linkId: string, way: 'sent' | 'received', bytes: number): void {
    const col = way === 'sent' ? 'sent' : 'received';
    this.db.prepare(`INSERT INTO link_bytes (link_id, day, ${col}) VALUES (?, ?, ?) ON CONFLICT (link_id, day) DO UPDATE SET ${col} = ${col} + excluded.${col}`)
      .run(linkId, dayOf(this.now()), bytes);
  }

  /** A link's file bytes today and this month (local time). */
  totals(linkId: string): ByteTotals {
    const today = dayOf(this.now());
    const sum = (where: string, arg: string) => {
      const r = this.db.prepare(`SELECT COALESCE(SUM(sent), 0) AS sent, COALESCE(SUM(received), 0) AS received FROM link_bytes WHERE link_id = ? AND ${where}`).get(linkId, arg) as { sent: number; received: number };
      return { sent: Number(r.sent), received: Number(r.received) };
    };
    return { today: sum('day = ?', today), month: sum('day LIKE ?', `${today.slice(0, 7)}-%`) };
  }
}
