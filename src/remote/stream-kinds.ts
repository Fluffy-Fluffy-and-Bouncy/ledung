// The kinds of file a manager streams to a manager on a linked computer (issue #159, option B of the research report):
// audio and zip (Martin, 2026-11-06 12:09, question #631: "a — Audio and zip", note "start with audio and zip"). Each
// is recognised by its first bytes and its extension, as an image is (bytesKind in board/attachments.ts). Audio has
// nothing readable inside to check, like an image's pixels; a zip is opened and checked entry by entry before it
// leaves (zipProblem). PNG, JPEG and text keep going as #158 sends them, pushed whole.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { bytesKind, kindLabel, readLinkOutgoing, safeName, type AttachmentKind, type OutgoingFile } from '../board/attachments.ts';
import { FileError, openProjectFile } from '../sessions/files.ts';

export type StreamKind = 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'zip';
/** Every kind a linked computer's file may be: #158's, pushed, and #159's, streamed. */
export type LinkedKind = AttachmentKind | StreamKind;

export const STREAM_KINDS: readonly StreamKind[] = ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'zip'];
/** How many first bytes streamKindOf needs at most (m4a's "ftyp" box sits at 4..8). */
export const KIND_HEAD_BYTES = 16;

/** The kinds that can go, as a refusal lists them (issue #159, first Done bullet). */
export const KINDS_THAT_CAN_GO = 'only PNG and JPEG images and .txt, .log or .md text files (up to 5 MB and 512 KB), and .wav, .mp3, .flac, .ogg or .m4a audio and .zip files (any size)';

const EXTENSION: Record<StreamKind, RegExp> = { wav: /\.wav$/i, mp3: /\.mp3$/i, flac: /\.flac$/i, ogg: /\.ogg$/i, m4a: /\.m4a$/i, zip: /\.zip$/i };
const LABEL: Record<StreamKind, string> = { wav: 'WAV audio', mp3: 'MP3 audio', flac: 'FLAC audio', ogg: 'Ogg audio', m4a: 'M4A audio', zip: 'zip' };

export function isStreamKind(kind: unknown): kind is StreamKind {
  return typeof kind === 'string' && (STREAM_KINDS as readonly string[]).includes(kind);
}

export function linkedKindLabel(kind: LinkedKind): string {
  return isStreamKind(kind) ? LABEL[kind] : kindLabel(kind);
}

/** Do the first bytes say `kind`? */
function looksLike(kind: StreamKind, head: Buffer): boolean {
  const at = (offset: number, ascii: string) => head.subarray(offset, offset + ascii.length).toString('latin1') === ascii;
  switch (kind) {
    case 'wav': return at(0, 'RIFF') && at(8, 'WAVE');
    // An ID3 tag, or straight to a frame: 11 bits of frame sync, then not the reserved MPEG version or layer.
    case 'mp3': return at(0, 'ID3') || (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0 && (head[1]! & 0x18) !== 0x08 && (head[1]! & 0x06) !== 0);
    case 'flac': return at(0, 'fLaC');
    case 'ogg': return at(0, 'OggS');
    case 'm4a': return at(4, 'ftyp');
    case 'zip': return head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  }
}

/** The streamed kind its name says, if its first bytes agree; null: not one of them (or not really one). */
export function streamKindOf(head: Buffer, name: string): StreamKind | null {
  const named = STREAM_KINDS.find((k) => EXTENSION[k].test(name));
  return named && looksLike(named, head) ? named : null;
}

/**
 * A file to stream to a linked computer: audio or a zip, found in the manager's folder with the file viewer's rules,
 * its snapshot made and checked (a zip entry by entry) when the message goes.
 */
export interface OutgoingStream { streamed: true; name: string; kind: StreamKind; inside: string; real: string; size: number }

/**
 * A file a manager sends to a manager on a linked computer (issues #158, #159), from `root` with the file viewer's
 * rules: PNG, JPEG or text as #158 reads them (whole, at most 5 MB and 512 KB), audio or a zip only found and sized,
 * to be streamed. Anything else is refused with the kinds that can go, before a byte of it is read past its start.
 */
export function linkOutgoing(root: string, link: string): OutgoingFile | OutgoingStream {
  const f = openProjectFile(root, link, Math.max(KIND_HEAD_BYTES, 8192));
  const streamed = streamKindOf(f.head, f.path);
  if (streamed) return { streamed: true, name: safeName(f.path), kind: streamed, inside: f.path, real: f.real, size: f.size };
  if (bytesKind(f.head, f.path)) return readLinkOutgoing(root, link);
  const named = /\.png$/i.test(f.path) ? 'a PNG image' : /\.jpe?g$/i.test(f.path) ? 'a JPEG image' : streamKindNamed(f.path) ? `${LABEL[streamKindNamed(f.path)!]}` : null;
  throw new FileError(named ? `${f.path} is not really ${named}.` : `${f.path} can't be sent: ${KINDS_THAT_CAN_GO}.`);
}

/** The streamed kind its name claims, whatever its bytes: for "x.wav is not really WAV audio". */
export function streamKindNamed(name: string): StreamKind | null {
  return STREAM_KINDS.find((k) => EXTENSION[k].test(name)) ?? null;
}

// --- Zip, entry by entry (issue #159, Done bullets 1 and 2) -------------------------------------------------------------

/** Names an entry may not have, whatever the project's patterns: .env, keys and token files (issue #159). */
const REFUSED_ENTRIES: [RegExp, string][] = [
  [/(^|\/)\.env(\.[^/]*)?$/i, 'a .env file'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/i, 'an SSH private key'],
  [/\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/i, 'a key file'],
  [/(^|\/)(\.npmrc|\.netrc|_netrc|\.pypirc|\.git-credentials|\.pgpass|\.htpasswd|credentials(\.json)?)$/i, 'a credentials file'],
  [/(^|\/)[^/]*(^|[._-])(tokens?|secrets?)([._-][^/]*)?$/i, 'a token or secrets file'],
  [/(^|\/)\.(ssh|aws|gnupg|kube|docker)\//i, 'in a folder of keys or sign-ins'],
];

/** Archives inside a zip are refused: what is in them can't be checked without opening them too. */
const ARCHIVE_MAGIC: [Buffer, number][] = [
  [Buffer.from([0x50, 0x4b, 0x03, 0x04]), 0], [Buffer.from([0x1f, 0x8b]), 0], [Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), 0],
  [Buffer.from('Rar!', 'latin1'), 0], [Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), 0], [Buffer.from('BZh', 'latin1'), 0], [Buffer.from('ustar', 'latin1'), 257],
];

/** At most this much of a zip's central directory is read; at most this much text in it is checked. */
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_TEXT_BYTES = 256 * 1024 * 1024;
/** Text is checked in windows this large, each overlapping the last by OVERLAP characters, so no match falls between. */
const WINDOW_CHARS = 1024 * 1024;
const OVERLAP_CHARS = 4096;
const SNIFF_BYTES = 8192;

export interface ZipChecks {
  /** Why this entry's name can't go (the project's sensitive path patterns), or null. */
  name(entry: string): string | null;
  /** Why this text (part of an entry) can't go (patterns, locked secrets, tokens), or null. */
  text(entry: string, text: string): string | null;
}

interface Entry { name: string; flags: number; method: number; compressed: number; uncompressed: number; local: number; comment: string }

/** The central directory's entries, where the directory starts, and the zip's comment. */
interface Directory { list: Entry[]; at: number; comment: string }

class ZipRefusal extends Error {}

const refuse = (why: string): never => {
  throw new ZipRefusal(why);
};

async function readAt(fd: fs.promises.FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buf, 0, length, offset);
  return buf.subarray(0, bytesRead);
}

/** Bytes no entry, directory or end record accounts for (review finding 1 on PR #175): a streaming unzip reads them. */
const unplaced = (at: number): never => refuse(`it has bytes Ledung can't place (at byte ${at}): they are not in any entry its directory lists, and an unzip tool may still read them`);

/**
 * The central directory's entries, from the end record (zip64 too); throws a ZipRefusal for anything else. The
 * directory must run right up to the zip64 records or the end record, and the end record and its comment must end
 * the file: nothing sits between them for a streaming unzip to find.
 */
async function entries(fd: fs.promises.FileHandle, size: number): Promise<Directory> {
  const tailStart = Math.max(0, size - 22 - 65535);
  const tail = await readAt(fd, tailStart, size - tailStart);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) refuse('it is not a zip file Ledung can read (no central directory)');
  if (tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) refuse('it is a zip split over several files');
  const endAt = tailStart + end;
  const commentLen = tail.readUInt16LE(end + 20);
  if (endAt + 22 + commentLen !== size) unplaced(Math.min(endAt + 22 + commentLen, size));
  const comment = tail.subarray(end + 22, end + 22 + commentLen).toString('utf8');
  let count = tail.readUInt16LE(end + 10);
  let dirSize = tail.readUInt32LE(end + 12);
  let dirAt = tail.readUInt32LE(end + 16);
  // Where the directory must end: at the zip64 end record when there is one, else at the end record.
  let dirEnd = endAt;
  const locAt = endAt - 20;
  const loc = locAt >= 0 ? await readAt(fd, locAt, 20) : Buffer.alloc(0);
  const zip64 = loc.length === 20 && loc.readUInt32LE(0) === 0x07064b50;
  if (!zip64 && (count === 0xffff || dirSize === 0xffffffff || dirAt === 0xffffffff)) refuse('its zip64 end record is missing');
  if (zip64) {
    const recAt = Number(loc.readBigUInt64LE(8));
    const rec = await readAt(fd, recAt, 56);
    if (rec.length < 56 || rec.readUInt32LE(0) !== 0x06064b50) refuse('its zip64 end record is missing');
    // The record's size field counts what follows it (12 bytes of signature and size before); the locator comes next.
    if (recAt + 12 + Number(rec.readBigUInt64LE(4)) !== locAt) unplaced(recAt);
    count = Number(rec.readBigUInt64LE(32));
    dirSize = Number(rec.readBigUInt64LE(40));
    dirAt = Number(rec.readBigUInt64LE(48));
    dirEnd = recAt;
  }
  if (dirSize > MAX_DIRECTORY_BYTES) refuse('it has more entries than Ledung checks');
  if (dirAt + dirSize > size) refuse('its central directory is cut off');
  if (dirAt + dirSize !== dirEnd) unplaced(Math.min(dirAt + dirSize, dirEnd));
  const dir = await readAt(fd, dirAt, dirSize);
  const out: Entry[] = [];
  let p = 0;
  while (p + 46 <= dir.length && dir.readUInt32LE(p) === 0x02014b50) {
    const flags = dir.readUInt16LE(p + 8);
    const method = dir.readUInt16LE(p + 10);
    let compressed = dir.readUInt32LE(p + 20);
    let uncompressed = dir.readUInt32LE(p + 24);
    const nameLen = dir.readUInt16LE(p + 28);
    const extraLen = dir.readUInt16LE(p + 30);
    const commentLen = dir.readUInt16LE(p + 32);
    let local = dir.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen > dir.length) refuse('its central directory is cut off');
    // Bit 11: the name is UTF-8; otherwise code page 437, which agrees with Latin-1 on every ASCII name.
    const name = dir.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    // The zip64 extra field holds, in this order, the values the record left at 0xffffffff.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = dir.readUInt16LE(e);
      const len = dir.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        const next = () => {
          const v = q + 8 <= e + 4 + len ? Number(dir.readBigUInt64LE(q)) : refuse(`entry ${name}'s zip64 sizes are cut off`);
          q += 8;
          return v;
        };
        if (uncompressed === 0xffffffff) uncompressed = next();
        if (compressed === 0xffffffff) compressed = next();
        if (local === 0xffffffff) local = next();
      }
      e += 4 + len;
    }
    const comment = dir.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    out.push({ name, flags, method, compressed, uncompressed, local, comment });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (out.length !== count) refuse('its central directory does not list the entries it says');
  if (p !== dir.length) unplaced(dirAt + p);
  return { list: out, at: dirAt, comment };
}

/** An entry name that is empty, absolute (a slash or a drive first) or climbs out with "..", either slash. */
function leadsOut(entryName: string): boolean {
  const name = entryName.replace(/\\/g, '/');
  return !name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((p) => p === '..');
}

/** A zip that arrives from a linked computer holds at most this many entries, and this much unpacked (Project-Ledung#479). */
export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_ZIP_UNPACKED_BYTES = 16 * 1024 * 1024 * 1024;

/**
 * Why a zip that arrived from a linked computer can't be kept, or null (Project-Ledung#479): its central directory
 * must parse and run right to the end of the file with nothing after it (entries() above); it lists at most
 * MAX_ZIP_ENTRIES entries and MAX_ZIP_UNPACKED_BYTES unpacked, as their directory records say; and no entry name is
 * empty, absolute or climbs out with "..". It reads only the directory: unlike zipProblem it does not check that the
 * listed entries fill the file before the directory (ledung#244), nor any entry's content.
 */
export async function zipArrivalProblem(file: string): Promise<string | null> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(file, 'r');
    const dir = await entries(fd, (await fd.stat()).size);
    if (dir.list.length > MAX_ZIP_ENTRIES) refuse(`it has ${dir.list.length} entries; this computer takes at most ${MAX_ZIP_ENTRIES}`);
    let unpacked = 0;
    for (const entry of dir.list) {
      if (leadsOut(entry.name)) refuse(`entry ${entry.name} has a path that leads out of the zip`);
      unpacked += entry.uncompressed;
    }
    if (unpacked > MAX_ZIP_UNPACKED_BYTES) refuse(`it unpacks to more than ${MAX_ZIP_UNPACKED_BYTES / 1024 ** 3} GB`);
    return null;
  } catch (e) {
    if (e instanceof ZipRefusal) return e.message;
    return `it can't be read as a zip: ${(e as Error).message}`;
  } finally {
    await fd?.close();
  }
}

/**
 * How many bytes follow an entry's data as its data descriptor (flag bit 3), from the bytes after the data and where
 * the next part must start: 12 or 20 (32- or 64-bit sizes), 16 or 24 with the optional signature. A local header
 * takes 30 bytes at least, so no hidden entry fits in one.
 */
function descriptorLength(after: Buffer, room: number): number | null {
  const signed = after.length >= 4 && after.readUInt32LE(0) === 0x08074b50;
  const fits = signed ? [16, 24] : [12, 20];
  return fits.includes(room) ? room : null;
}

/** An entry's bytes as stored (compressed or not), streamed from the file. */
function rawStream(file: string, start: number, length: number): fs.ReadStream | null {
  return length === 0 ? null : fs.createReadStream(file, { start, end: start + length - 1, highWaterMark: 64 * 1024 });
}

/** The entry's content checks: text through `checks.text` in overlapping windows; archives and unknown methods refused. */
async function checkContent(file: string, entry: Entry, dataAt: number, checks: ZipChecks, budget: { text: number }): Promise<void> {
  if (entry.method !== 0 && entry.method !== 8) refuse(`entry ${entry.name} is compressed in a way Ledung can't open to check (method ${entry.method})`);
  const raw = rawStream(file, dataAt, entry.compressed);
  if (!raw) return;
  const source = entry.method === 8 ? raw.pipe(zlib.createInflateRaw()) : raw;
  if (source !== raw) raw.on('error', (e) => source.destroy(e));
  const decoder = new TextDecoder('utf-8');
  let head: Buffer | null = Buffer.alloc(0);
  let text = '';
  const scan = (final: boolean) => {
    const problem = checks.text(entry.name, text);
    if (problem) refuse(`entry ${entry.name}: ${problem}`);
    if (!final) text = text.slice(-OVERLAP_CHARS);
  };
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      if (head !== null) {
        head = Buffer.concat([head, chunk]);
        if (head.length < SNIFF_BYTES) continue;
        const kindAt = head;
        head = null;
        if (ARCHIVE_MAGIC.some(([m, at]) => kindAt.subarray(at, at + m.length).equals(m))) refuse(`entry ${entry.name} is an archive inside the zip; Ledung can't check what is in it`);
        // Not text (a NUL in its first 8 KiB, as bytesKind decides): its name was checked, its bytes can't be.
        if (kindAt.subarray(0, SNIFF_BYTES).includes(0)) return;
        budget.text -= kindAt.length;
        text += decoder.decode(kindAt, { stream: true });
      } else {
        budget.text -= chunk.length;
        text += decoder.decode(chunk, { stream: true });
      }
      if (budget.text < 0) refuse(`entry ${entry.name}: the zip holds more text than Ledung checks (${MAX_ZIP_TEXT_BYTES / 1048576} MB)`);
      if (text.length >= WINDOW_CHARS) scan(false);
    }
  } catch (e) {
    if (e instanceof ZipRefusal) throw e;
    refuse(`entry ${entry.name} can't be read: ${(e as Error).message}`);
  } finally {
    raw.destroy();
    source.destroy();
  }
  if (head !== null) {
    // The whole entry is shorter than the sniff.
    if (ARCHIVE_MAGIC.some(([m, at]) => head!.subarray(at, at + m.length).equals(m))) refuse(`entry ${entry.name} is an archive inside the zip; Ledung can't check what is in it`);
    if (head.includes(0)) return;
    budget.text -= head.length;
    text += decoder.decode(head, { stream: true });
  }
  text += decoder.decode();
  scan(true);
}

/**
 * Why the zip at `file` can't go, naming the entry, or null when every entry may (issue #159): no entry encrypted, none
 * leading out of the zip, none named as .env, a key or a token file, none matching the sensitive path patterns, no
 * archive inside it, and every text entry, folder entry's data, entry comment and the zip comment through the text
 * checks (the secret scan). Streamed from disk: an entry is never held whole. The local header of each entry must agree
 * with the central directory, and the entries, directory and end records must fill the file with no byte left over,
 * so what an unzip tool reads, from the directory or from the local headers in order, is what was checked.
 */
export async function zipProblem(file: string, checks: ZipChecks): Promise<string | null> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(file, 'r');
    const size = (await fd.stat()).size;
    const budget = { text: MAX_ZIP_TEXT_BYTES };
    const dir = await entries(fd, size);
    const content: [Entry, number][] = [];
    for (const entry of dir.list) {
      const name = entry.name.replace(/\\/g, '/');
      const shown = entry.name;
      if (leadsOut(entry.name)) refuse(`entry ${shown} has a path that leads out of the zip`);
      if (entry.flags & 0x1 || entry.flags & 0x40 || entry.method === 99) refuse(`entry ${shown} is encrypted; Ledung can't check it`);
      const refused = REFUSED_ENTRIES.find(([re]) => re.test(name));
      if (refused) refuse(`entry ${shown} is ${refused[1]}, which never leaves`);
      const named = checks.name(name);
      if (named) refuse(`entry ${shown}: ${named}`);
      const local = await readAt(fd, entry.local, 30);
      if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) refuse(`entry ${shown} is not where the zip's directory says`);
      const localName = await readAt(fd, entry.local + 30, local.readUInt16LE(26));
      if (localName.toString(local.readUInt16LE(6) & 0x800 ? 'utf8' : 'latin1') !== entry.name) refuse(`entry ${shown} has another name inside the zip than its directory gives`);
      if (local.readUInt16LE(6) & 0x1) refuse(`entry ${shown} is encrypted; Ledung can't check it`);
      const dataAt = entry.local + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (dataAt + entry.compressed > size) refuse(`entry ${shown} is cut off`);
      // A folder entry's data, if it has any, is checked as a file's is (review finding 2 on PR #175): it leaves too.
      content.push([entry, dataAt]);
      const said = entry.comment && checks.text(entry.name, entry.comment);
      if (said) refuse(`entry ${shown}'s comment: ${said}`);
    }
    const said = dir.comment && checks.text('the zip comment', dir.comment);
    if (said) refuse(`the zip's comment: ${said}`);
    // The entries must fill the file from its first byte to the directory, each local header, name, extra field, data
    // and data descriptor running straight into the next (review finding 1 on PR #175): a streaming unzip reads local
    // headers in order and extracts whatever it finds, so a byte the directory doesn't list would go unchecked.
    const byPlace = [...dir.list].sort((a, b) => a.local - b.local);
    let at = 0;
    for (const [n, entry] of byPlace.entries()) {
      if (entry.local !== at) unplaced(Math.min(at, entry.local));
      const local = await readAt(fd, entry.local, 30);
      at = entry.local + 30 + local.readUInt16LE(26) + local.readUInt16LE(28) + entry.compressed;
      if ((entry.flags | local.readUInt16LE(6)) & 0x8) {
        const next = byPlace[n + 1]?.local ?? dir.at;
        const extra = descriptorLength(await readAt(fd, at, 4), next - at);
        if (extra === null) unplaced(at);
        at += extra!;
      }
    }
    if (at !== dir.at) unplaced(Math.min(at, dir.at));
    for (const [entry, dataAt] of content) await checkContent(file, entry, dataAt, checks, budget);
    return null;
  } catch (e) {
    if (e instanceof ZipRefusal) return e.message;
    return `it can't be read as a zip: ${(e as Error).message}`;
  } finally {
    await fd?.close();
  }
}
