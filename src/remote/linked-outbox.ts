// The sender's side of files streamed to a manager on a linked computer (issue #159, the refine notes on it, point 1):
// a snapshot of the file in this Ledung's own outbox, in the data folder, mode 0600, made and hashed when the message
// is sent, so what the other computer fetches is the bytes that were checked, whatever happens to the file in the
// project folder since (as the board's outbox ties a held post to the bytes shown, PR #131). The message carries only
// a handle with the size and SHA-256; the other computer pulls the bytes with /link/file-get, with that link's key and
// for the manager the message named only, from the first byte or from where a cut-off fetch stopped.
//
// A snapshot is held until its message arrived, then offered. It goes an hour after it was first read to its end (the
// other computer then has its copy, checked), after evidenceDays at the latest, and at once when its message was
// refused; one whose message never went, after an hour.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { FileError } from '../sessions/files.ts';
import { LinkedFileError } from './linked-files.ts';
import { KIND_HEAD_BYTES, streamKindOf, type StreamKind } from './stream-kinds.ts';

const ID = /^[0-9a-f]{16}$/;
const LINK_ID = /^[A-Za-z0-9-]{1,64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A snapshot whose message never went (the send failed on the way) goes after this long. */
const HELD_MS = 60 * 60 * 1000;
/** A snapshot read to its end goes after this long: time for a resume or a second try, no more. */
export const FETCHED_KEEP_MS = 60 * 60 * 1000;
/** A snapshot is copied this much at a time. */
const COPY_CHUNK = 1024 * 1024;

/** What a message carries of a streamed file: the handle's id on the sender, and what the bytes must be. */
export interface StreamOffer { id: string; name: string; kind: StreamKind; size: number; sha: string }

/** One snapshot: whose, for whom, what. */
interface Row { id: string; link_id: string; from_session: string; to_session: string; name: string; kind: StreamKind; size: number; sha: string; state: string; created_at: number; fetched_at: number | null; pruned_at: number | null }

export class LinkedOutbox {
  private readonly db: DatabaseSync;
  private readonly dir: () => string;
  private readonly keepDays: () => number;
  private readonly now: () => number;
  private prunedAt = 0;

  constructor(db: DatabaseSync, dir: () => string, keepDays: () => number, now: () => number = Date.now) {
    this.db = db;
    this.dir = dir;
    this.keepDays = keepDays;
    this.now = now;
  }

  /** The snapshot's file: <dir>/<link id>/<id>.<kind>, names Ledung made only. */
  fileOf(linkId: string, id: string, kind: StreamKind): string {
    if (!LINK_ID.test(linkId) || !ID.test(id)) throw new FileError('Not a snapshot.');
    return path.join(this.dir(), linkId, `${id}.${kind}`);
  }

  /**
   * Copies `real` into the outbox, streamed, hashing as it goes; held until its message arrives. Its kind is checked
   * again on the copy, so a file swapped while it was read is refused. Throws a FileError with the reason.
   */
  async snapshot(real: string, meta: { linkId: string; from: string; to: string; name: string; inside: string; kind: StreamKind }): Promise<StreamOffer> {
    this.prune();
    const id = crypto.randomBytes(8).toString('hex');
    const file = this.fileOf(meta.linkId, id, meta.kind);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    const hash = crypto.createHash('sha256');
    let size = 0;
    const head = Buffer.alloc(KIND_HEAD_BYTES);
    // One buffer, read into and written from in turn: no garbage per chunk, so a large file never shows in memory as
    // buffers waiting to be collected (the loopback of #159 measures it), and the event loop is free between chunks.
    const buf = Buffer.alloc(COPY_CHUNK);
    let src: fs.promises.FileHandle | null = null;
    let dst: fs.promises.FileHandle | null = null;
    try {
      src = await fs.promises.open(real, 'r');
      dst = await fs.promises.open(temp, 'wx', 0o600);
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, buf.length, null);
        if (bytesRead === 0) break;
        const chunk = buf.subarray(0, bytesRead);
        if (size < KIND_HEAD_BYTES) chunk.copy(head, size, 0, Math.min(bytesRead, KIND_HEAD_BYTES - size));
        hash.update(chunk);
        await dst.write(chunk, 0, bytesRead, null);
        size += bytesRead;
      }
    } catch (e) {
      await dst?.close().catch(() => {});
      fs.rmSync(temp, { force: true });
      throw new FileError(`${meta.inside} could not be read: ${(e as Error).message}`);
    } finally {
      await src?.close().catch(() => {});
    }
    await dst.close();
    if (streamKindOf(head.subarray(0, Math.min(size, KIND_HEAD_BYTES)), meta.name) !== meta.kind) {
      fs.rmSync(temp, { force: true });
      throw new FileError(`${meta.inside} changed while it was read; send it again.`);
    }
    fs.renameSync(temp, file);
    const sha = hash.digest('hex');
    this.db.prepare(`INSERT INTO linked_outbox (id, link_id, from_session, to_session, name, kind, size, sha, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)`)
      .run(id, meta.linkId, meta.from, meta.to, meta.name, meta.kind, size, sha, this.now());
    return { id, name: meta.name, kind: meta.kind, size, sha };
  }

  /** The message naming them arrived: the other computer may fetch them now. */
  offer(ids: readonly string[]): void {
    for (const id of ids) this.db.prepare(`UPDATE linked_outbox SET state = 'offered' WHERE id = ? AND state = 'held'`).run(id);
  }

  /** The message was refused or never went: nothing of it is kept. */
  drop(ids: readonly string[]): void {
    for (const id of ids) {
      const r = this.db.prepare('SELECT * FROM linked_outbox WHERE id = ?').get(id) as Row | undefined;
      if (r) this.remove(r);
    }
  }

  /**
   * /link/file-get: the snapshot `id` for the linked computer `linkId`, for the manager `to` there, or the refusal
   * with its status: only the link and the manager the message went to (403), only once its message arrived and while
   * it is kept (404). `locked`: whether the sending manager's project is locked now, so a project locked after the
   * send sends nothing more.
   */
  serve(linkId: string, q: URLSearchParams, locked: (session: string) => boolean): { file: string; size: number; name: string; id: string } {
    const id = q.get('id') ?? '';
    const to = q.get('to') ?? '';
    if (!ID.test(id)) throw new LinkedFileError(400, 'Name the file by the id its message gave.');
    this.prune();
    const r = this.db.prepare('SELECT * FROM linked_outbox WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new LinkedFileError(404, 'This computer has no such file.');
    if (r.link_id !== linkId || r.to_session !== to) throw new LinkedFileError(403, 'That file was not sent to you, or not for that manager.');
    if (r.state !== 'offered') throw new LinkedFileError(404, 'This computer has no such file.');
    if (r.pruned_at !== null) throw new LinkedFileError(404, `${r.name} is no longer kept here; ask for it to be sent again.`);
    if (locked(r.from_session)) throw new LinkedFileError(403, 'No files go to or from a locked project.');
    const file = this.fileOf(r.link_id, r.id, r.kind);
    if (!fs.existsSync(file)) throw new LinkedFileError(404, `${r.name} is no longer kept here; ask for it to be sent again.`);
    return { file, size: Number(r.size), name: r.name, id: r.id };
  }

  /** A fetch read the snapshot to its end: it goes FETCHED_KEEP_MS from the first time. */
  fetched(id: string): void {
    this.db.prepare('UPDATE linked_outbox SET fetched_at = ? WHERE id = ? AND fetched_at IS NULL').run(this.now(), id);
  }

  /** Snapshots whose time is up go, their rows saying so; held ones whose message never went go with their row. */
  prune(force = false): void {
    const now = this.now();
    if (!force && now - this.prunedAt < 60_000) return;
    this.prunedAt = now;
    const old = this.db.prepare(`SELECT * FROM linked_outbox WHERE state = 'offered' AND pruned_at IS NULL AND (created_at < ? OR fetched_at < ?)`)
      .all(now - this.keepDays() * DAY_MS, now - FETCHED_KEEP_MS) as unknown as Row[];
    for (const r of old) {
      this.removeFile(r);
      this.db.prepare('UPDATE linked_outbox SET pruned_at = ? WHERE id = ?').run(now, r.id);
    }
    const held = this.db.prepare(`SELECT * FROM linked_outbox WHERE state = 'held' AND created_at < ?`).all(now - HELD_MS) as unknown as Row[];
    for (const r of held) this.remove(r);
  }

  private remove(r: Row): void {
    this.removeFile(r);
    this.db.prepare('DELETE FROM linked_outbox WHERE id = ?').run(r.id);
  }

  private removeFile(r: Row): void {
    try {
      fs.rmSync(this.fileOf(r.link_id, r.id, r.kind), { force: true });
    } catch (e) {
      console.error(`Linked outbox: could not remove ${r.id}: ${(e as Error).message}`);
    }
  }
}
