// Screenshots kept for questions are stored as WebP (issue #306; Martin, 2026-11-12, Ledung question #2145: "a — Ledung
// keeps a copy of every shot, as WebP"). The codecs are jSquash's (Squoosh's libwebp, image-png and mozjpeg compiled to
// WebAssembly): no native build at install and the same bytes on Windows and macOS. Each codec's .wasm is read from
// node_modules and handed in, as Node has no fetch for file URLs. A PNG becomes lossless WebP: the pixels stay exact for
// judging how something looks, and on Ledung's own dark screenshots it was 33-46 % of the PNG (lossy q80 was larger
// than the PNG on most of them). A JPEG, lossy already, becomes lossy WebP at quality 90.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Past this many pixels an image is kept as it came: decoding it would take over 200 MB (4 bytes a pixel). */
export const WEBP_MAX_PIXELS = 50_000_000;
const JPEG_QUALITY = 90;

type Pixels = { data: Uint8ClampedArray; width: number; height: number };
interface Codecs {
  png(bytes: ArrayBuffer): Promise<Pixels>;
  jpeg(bytes: ArrayBuffer): Promise<Pixels>;
  webp(pixels: Pixels, options: { lossless?: number; quality?: number }): Promise<ArrayBuffer>;
}

let loading: Promise<Codecs> | null = null;

const wasm = (spec: string) => WebAssembly.compile(fs.readFileSync(fileURLToPath(import.meta.resolve(spec))));

/** The codecs, loaded once, on the first copy; a failed load is tried again next time. */
function codecs(): Promise<Codecs> {
  loading ??= (async () => {
    const [png, jpeg, webp] = await Promise.all([
      import('@jsquash/png/decode.js'), import('@jsquash/jpeg/decode.js'), import('@jsquash/webp/encode.js'),
    ]);
    // Node 24 has WebAssembly SIMD, which webp's init picks; its module must be the SIMD build. jpeg's init takes a
    // module too, though its typings name only the options.
    await Promise.all([
      png.init(await wasm('@jsquash/png/codec/pkg/squoosh_png_bg.wasm')),
      webp.init(await wasm('@jsquash/webp/codec/enc/webp_enc_simd.wasm')),
      (jpeg.init as unknown as (m: WebAssembly.Module) => Promise<void>)(await wasm('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm')),
    ]);
    return {
      png: (b) => png.decode(b) as Promise<Pixels>,
      jpeg: (b) => jpeg.default(b) as Promise<Pixels>,
      webp: (p, o) => webp.default(p as never, o),
    };
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/** RIFF....WEBP: a WebP file by its first bytes. */
export function isWebp(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP';
}

/** Width times height from a PNG's IHDR or a JPEG's first frame header, without decoding; null when not found. */
export function pixelCount(bytes: Buffer, kind: 'png' | 'jpeg'): number | null {
  if (kind === 'png') return bytes.length >= 24 ? bytes.readUInt32BE(16) * bytes.readUInt32BE(20) : null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    // SOF0-SOF15 but DHT (C4), JPG (C8) and DAC (CC): the frame header with the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return bytes.readUInt16BE(at + 5) * bytes.readUInt16BE(at + 7);
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

/**
 * A PNG or JPEG as WebP. Throws when it can't be converted (an image too large to decode, or one the codec refuses);
 * the caller keeps the image as it came then, so a question is never refused for the conversion.
 */
export async function toWebp(bytes: Buffer, kind: 'png' | 'jpeg'): Promise<Buffer> {
  const pixels = pixelCount(bytes, kind);
  if (pixels === null || pixels > WEBP_MAX_PIXELS) throw new Error(`the image is ${pixels === null ? 'of unknown size' : `${pixels} pixels`}; at most ${WEBP_MAX_PIXELS} are converted`);
  const c = await codecs();
  const own = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer;
  const decoded = kind === 'png' ? await c.png(own) : await c.jpeg(own);
  const out = Buffer.from(await c.webp(decoded, kind === 'png' ? { lossless: 1 } : { quality: JPEG_QUALITY }));
  if (!isWebp(out)) throw new Error('the encoder gave no WebP');
  return out;
}
