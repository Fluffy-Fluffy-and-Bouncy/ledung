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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { bytesKind, contentProblem, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, safeName, type AttachmentKind } from '../board/attachments.ts';
import { FileError } from '../sessions/files.ts';

export const LINKED_FILE_PREFIX = 'linked:';
/** A file no message claimed within this long is dropped: its message never came (the sender failed on the way). */
export const PENDING_MS = 60 * 60 * 1000;
const HANDLE = /^linked:([0-9a-f]{16})\/(.+)$/;
const FILE_ID = /^[0-9a-f]{16}$/;
const LINK_ID = /^[A-Za-z0-9-]{1,64}$/;
const EXT: Record<AttachmentKind, string> = { png: 'png', jpeg: 'jpg', text: 'txt' };
const DAY_MS = 24 * 60 * 60 * 1000;

/** What /link/file says about the bytes it carries; all of it is checked against them. */
export interface LinkedFileMeta { to: string; name: string; kind: AttachmentKind; size: number; sha: string }

/** A file a message claimed, as the receiving manager is told of it. */
export interface ReceivedFile { id: string; handle: string; name: string; kind: AttachmentKind; size: number; text: string | null }

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
  private prunedAt = 0;

  /**
   * `dir`: where the copies are kept, in the data folder; asked each time, so tests can move it. `keepDays`: how many
   * days a copy is kept, the board's evidenceDays, read at each prune so a config change applies.
   */
  constructor(db: DatabaseSync, dir: () => string, keepDays: () => number, now: () => number = Date.now) {
    this.db = db;
    this.dir = dir;
    this.keepDays = keepDays;
    this.now = now;
  }

  /** The copy's file: <dir>/<link id>/<file id>.<ext>, names Ledung made only. */
  private fileOf(linkId: string, id: string, kind: AttachmentKind): string {
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
      const kind = r!.kind as AttachmentKind;
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
    if (!r || r.to_session !== sessionId || r.state !== 'delivered') throw new FileError(`Ledung has no file ${m[2]} from a linked computer for this session.`);
    if (r.pruned_at !== null) throw new FileError(`${r.name} was pruned: copies from linked computers are kept for a limited number of days.`);
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
      fs.rmSync(this.fileOf(r.link_id, r.id, r.kind as AttachmentKind), { force: true });
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
