// Board attachments: evidence files (screenshots, logs) a manager posts with a board post. The sender's
// Ledung uploads them into the board repo as evidence/<thread>/<post key>/<n>.<ext>, on a branch of their
// own that each change replaces with one new commit without parents, so no branch's history keeps them
// (the backend does that); the receiver's Ledung downloads them into its own board cache in the data
// folder, never into a project folder, so a manager and the page can show them. Images are PNG or JPEG
// only, checked by their first bytes like the file viewer's (decision 2026-10-14); text is plain text.
// Everything is checked again on arrival: a header is written by another Ledung and only says where to
// look and what to expect (size, SHA-256).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readProjectBytes, readProjectImage, FileError } from '../sessions/files.ts';

export type AttachmentKind = 'png' | 'jpeg' | 'text';

/** An attachment as Ledung's header carries it: where it is in the board repo, and what it must be. */
export interface AttachmentRef {
  /** In the board repo, e.g. "evidence/12/0123456789ab/1.png". */
  path: string;
  /** The file's name as shown, e.g. "cart.png": a label only, never used for a path. */
  name: string;
  kind: AttachmentKind;
  size: number;
  /** SHA-256 of the content: the receiver checks the download against it. */
  sha: string;
}

/** At most this many files per post, each at most this large. */
export const MAX_ATTACHMENTS = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_BYTES = 512 * 1024;
/** A text attachment is shown to the receiving manager inline, up to this many characters. */
export const TEXT_INLINE_CHARS = 4000;
/**
 * A text attachment this Ledung sends is at most this long, so the user's question shows it whole and the
 * receiving manager gets it whole (review B2). The receiver still takes up to MAX_TEXT_BYTES from others.
 */
export const MAX_TEXT_CHARS = TEXT_INLINE_CHARS;
/** What may be attached: by extension, then checked by content. Nothing else (no .env, keys, tokens, binaries). */
const TEXT_FILE = /\.(txt|log|md)$/i;

const EXT: Record<AttachmentKind, string> = { png: 'png', jpeg: 'jpg', text: 'txt' };
const REPO_PATH = /^evidence\/(new|[A-Za-z0-9_-]{1,40})\/[0-9a-f]{12}\/([1-5])\.(png|jpg|txt)$/;
const THREAD_ID = /^[A-Za-z0-9_-]{1,40}$/;

export function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** A post's key in the board repo: the service's post id is not known before the post exists, after its files. */
export function newPostKey(): string {
  return crypto.randomBytes(6).toString('hex');
}

/** A name safe to show: letters, digits, ".", "_" and "-", at most 80. */
export function safeName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return (base || 'file').slice(-80);
}

/**
 * Where an attachment goes in the board repo: evidence/<thread>/<post key>/<n>.<ext> (a new thread has no
 * number yet, so "new"). Only Ledung's own names: the file's name is never part of a path.
 */
export function evidencePath(threadId: string | null, postKey: string, n: number, kind: AttachmentKind): string {
  if (threadId !== null && !THREAD_ID.test(threadId)) throw new Error(`"${threadId}" is not a thread id.`);
  if (!/^[0-9a-f]{12}$/.test(postKey) || !Number.isInteger(n) || n < 1 || n > MAX_ATTACHMENTS) throw new Error('Not an attachment key.');
  return `evidence/${threadId ?? 'new'}/${postKey}/${n}.${EXT[kind]}`;
}

/** An attachment of a header, if it is one Ledung would have written; anything else is dropped. */
export function validRef(raw: unknown): AttachmentRef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const m = typeof r.path === 'string' ? REPO_PATH.exec(r.path) : null;
  if (!m || typeof r.sha !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha)) return null;
  if ((r.kind !== 'png' && r.kind !== 'jpeg' && r.kind !== 'text') || EXT[r.kind] !== m[3]) return null;
  const max = r.kind === 'text' ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES;
  if (typeof r.size !== 'number' || !Number.isInteger(r.size) || r.size < 0 || r.size > max) return null;
  const name = typeof r.name === 'string' ? safeName(r.name) : `${m[2]}.${m[3]}`;
  return { path: r.path as string, name, kind: r.kind, size: r.size, sha: r.sha };
}

/** A file the posting manager names, read from its folder (the file viewer's rules), with its kind. */
export interface OutgoingFile { name: string; kind: AttachmentKind; bytes: Buffer; sha: string; text: string | null; inside: string }

/**
 * The kind comes from the file the link resolves to, by its first bytes (review M3), so a link named x.png
 * that leads to notes.md is text, and the held post, the question and the upload agree on it. Text is
 * attached only up to what the user's question shows whole (review B2): the user sees every byte that leaves.
 */
export function readOutgoing(root: string, link: string): OutgoingFile {
  const f = readProjectBytes(root, link, MAX_IMAGE_BYTES);
  const kind = kindOrThrow(f.bytes, f.path);
  if (kind !== 'text') return { name: safeName(f.path), kind, bytes: f.bytes, sha: sha256(f.bytes), text: null, inside: f.path };
  const text = f.bytes.toString('utf8');
  if (text.length > MAX_TEXT_CHARS) {
    throw new FileError(`${f.path} is ${text.length} characters; a text attachment is at most ${MAX_TEXT_CHARS}, all of which the user sees before it leaves. Attach the part that matters.`);
  }
  // What leaves is the text as shown (invalid UTF-8 shown as replacement characters is sent so too).
  const bytes = Buffer.from(text, 'utf8');
  return { name: safeName(f.path), kind, bytes, sha: sha256(bytes), text, inside: f.path };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * A file's kind by its first bytes: PNG or JPEG (and named as one), or text without NUL named .txt, .log or
 * .md (so no .env, keys or token files); null: none of these.
 */
export function bytesKind(bytes: Buffer, name: string): AttachmentKind | null {
  if (bytes.subarray(0, 8).equals(PNG)) return /\.png$/i.test(name) ? 'png' : null;
  if (bytes.subarray(0, 3).equals(JPEG)) return /\.jpe?g$/i.test(name) ? 'jpeg' : null;
  return TEXT_FILE.test(name) && !bytes.subarray(0, 8192).includes(0) ? 'text' : null;
}

/** bytesKind, or the reason a file is none of the kinds. */
function kindOrThrow(bytes: Buffer, name: string): AttachmentKind {
  const kind = bytesKind(bytes, name);
  if (kind) return kind;
  const named = /\.png$/i.test(name) ? 'PNG' : /\.jpe?g$/i.test(name) ? 'JPEG' : null;
  throw new FileError(named ? `${name} is not really a ${named} image.` : `${name} can't be attached: only PNG and JPEG images and .txt, .log or .md text files.`);
}

/**
 * A review's evidence file (docs/steps/pr-review.md): the kinds and limits of an attachment, by its first
 * bytes, read with the file viewer's rules from `root` (a project folder, or a repo's board cache folder).
 * Checked when asked and again whenever the page shows it, so a file changed since is never shown as
 * another kind.
 */
export function readEvidence(root: string, link: string): { path: string; kind: AttachmentKind; bytes: Buffer } {
  const f = readProjectBytes(root, link, MAX_IMAGE_BYTES);
  const kind = kindOrThrow(f.bytes, f.path);
  if (kind === 'text' && f.bytes.length > MAX_TEXT_BYTES) throw new FileError(`${f.path} is too large (${Math.round(f.bytes.length / 1024)} KB; a text file is at most 512 KB).`);
  return { path: f.path, kind, bytes: f.bytes };
}

/**
 * Where a held post's files wait in the repo's cache folder: outbox/<key>-<n>.<ext>. The user is shown
 * these copies, and they are what is sent, so the file changing in the project folder meanwhile changes
 * nothing (PR #131 review: the approval bound to the bytes shown).
 */
export function outboxFile(cacheDir: string, repo: string, key: string, n: number, kind: AttachmentKind): { file: string; rel: string } {
  if (!/^[0-9a-f]{12}$/.test(key) || !Number.isInteger(n) || n < 1 || n > MAX_ATTACHMENTS) throw new FileError('Not a held attachment.');
  const rel = `outbox/${key}-${n}.${EXT[kind]}`;
  return { file: path.join(repoCacheDir(cacheDir, repo), ...rel.split('/')), rel };
}

/** Why downloaded bytes are not the attachment the header promised, or null. Images by their first bytes. */
export function contentProblem(ref: AttachmentRef, bytes: Buffer): string | null {
  if (bytes.length !== ref.size) return `its size is ${bytes.length} bytes, not the ${ref.size} the post says`;
  if (sha256(bytes) !== ref.sha) return 'its content is not what the post says';
  if (ref.kind === 'png' && !bytes.subarray(0, 8).equals(PNG)) return 'it is not really a PNG image';
  if (ref.kind === 'jpeg' && !bytes.subarray(0, 3).equals(JPEG)) return 'it is not really a JPEG image';
  if (ref.kind === 'text' && bytes.subarray(0, 8192).includes(0)) return 'it is not a text file';
  return null;
}

/** The board cache's folder for a repo: <cache>/<owner>/<name>; a repo name that could leave it is refused. */
export function repoCacheDir(cacheDir: string, repo: string): string {
  const parts = repo.split('/');
  if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p) || /^\.+$/.test(p))) throw new FileError(`"${repo}" is not a board repo.`);
  return path.join(cacheDir, parts[0]!, parts[1]!);
}

/**
 * The cached file of a post's n-th attachment: <cache>/<owner>/<name>/<thread>/<post id>-<n>.<ext>. Named
 * by Ledung from the service's ids, never from the sender's file name or path.
 */
export function cacheFile(cacheDir: string, repo: string, threadId: string, postId: string, n: number, kind: AttachmentKind): { file: string; rel: string } {
  if (!THREAD_ID.test(threadId)) throw new FileError(`"${threadId}" is not a thread id.`);
  const post = postId.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60);
  if (!post || !Number.isInteger(n) || n < 1 || n > MAX_ATTACHMENTS) throw new FileError('Not an attachment of a post.');
  const rel = `${threadId}/${post}-${n}.${EXT[kind]}`;
  return { file: path.join(repoCacheDir(cacheDir, repo), ...rel.split('/')), rel };
}

/** Writes a cached attachment, whole or not at all. */
export function writeCache(file: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
}

/** A file the page and ask_user name as "board:<owner>/<name>/<thread>/<file>". */
export const BOARD_FILE_PREFIX = 'board:';

/** "board:owner/name/12/issue-12-1.png" → the repo and the path inside its cache folder; null: not a board file. */
export function parseBoardFile(link: string): { repo: string; rel: string } | null {
  if (!link.startsWith(BOARD_FILE_PREFIX)) return null;
  const parts = link.slice(BOARD_FILE_PREFIX.length).split('/');
  if (parts.length < 3) return null;
  return { repo: `${parts[0]}/${parts[1]}`, rel: parts.slice(2).join('/') };
}

/** Reads a cached board image with the file viewer's rules (inside the folder, PNG or JPEG by its bytes, size). */
export function readCachedImage(cacheDir: string, repo: string, rel: string) {
  return readProjectImage(repoCacheDir(cacheDir, repo), rel);
}

export function kindLabel(kind: AttachmentKind): string {
  return kind === 'png' ? 'PNG' : kind === 'jpeg' ? 'JPEG' : 'text';
}

export function sizeLabel(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
