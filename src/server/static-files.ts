// The page's own files (issue #229, audit O2): every open downloaded about 1 MB again, uncompressed and never cached.
// Vite names the files under assets/ by their content, so a name never comes back with other content: those are kept
// by the browser for good. Everything else (index.html, the service worker, the manifest) stays no-store, so a new
// release is picked up as before. Text files go compressed, each compressed once and kept while Ledung runs.
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

/** Cache-Control for a file under assets/: a hashed name, so it never changes. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Text that compresses well; pictures and fonts are compressed already and go as they are. */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest']);

export type Encoding = 'br' | 'gzip' | null;

/** Is the file one of Vite's hashed assets: directly under <root>/assets/. */
export function isHashedAsset(root: string, file: string): boolean {
  return path.dirname(file) === path.join(root, 'assets');
}

export function compressible(file: string): boolean {
  return COMPRESSIBLE.has(path.extname(file).toLowerCase());
}

/** The encoding to send for a request's Accept-Encoding: Brotli when it takes it, else gzip, else none. */
export function pickEncoding(acceptEncoding: string | string[] | undefined): Encoding {
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding ?? '';
  const accepted = new Set<string>();
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    // "br;q=0" refuses it (RFC 9110 12.5.3).
    if (name && !(q && Number(q.slice(2)) === 0)) accepted.add(name);
  }
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip')) return 'gzip';
  return null;
}

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** Compressed copies of the page's files, made on first ask and kept; a file changed on disk is compressed again. */
export class PackedFiles {
  private readonly packed = new Map<string, { stamp: string; bytes: Promise<Buffer> }>();

  get(file: string, encoding: Exclude<Encoding, null>): Promise<Buffer> {
    const stat = fs.statSync(file);
    const key = `${encoding}:${file}`;
    const stamp = `${stat.size}:${stat.mtimeMs}`;
    const kept = this.packed.get(key);
    if (kept?.stamp === stamp) return kept.bytes;
    const bytes = fs.promises.readFile(file).then((raw) => encoding === 'br'
      ? brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
      : gzip(raw, { level: 9 }));
    const entry = { stamp, bytes };
    // A failure is not kept: the next request tries again.
    bytes.catch(() => { if (this.packed.get(key) === entry) this.packed.delete(key); });
    this.packed.set(key, entry);
    return bytes;
  }
}

/**
 * API answers below this go as they are: compressing a few hundred bytes saves nothing a packet doesn't already
 * hold (issue #330).
 */
export const PACK_MIN_BYTES = 1024;

/**
 * An API answer, compressed for the request (issue #330): a long chat's page of messages is ~3 MB of JSON, ~1.7 s
 * on phone Wi-Fi at 30 Mbit/s. Made fresh each time, so quick settings: for 3 MB, Brotli 4 takes ~15-30 ms and gzip 4
 * ~35-40 ms (gzip 6: ~65-85 ms for a little less), off the main thread. gzip matters: a browser on the local network's
 * plain http:// address offers no Brotli.
 */
export function packAnswer(raw: Buffer, encoding: Exclude<Encoding, null>): Promise<Buffer> {
  return encoding === 'br'
    ? brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } })
    : gzip(raw, { level: 4 });
}
