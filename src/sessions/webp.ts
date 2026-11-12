// Screenshots kept for questions are stored as WebP (issue #306; Martin, 2026-11-12, Ledung question #2145: "a — Ledung
// keeps a copy of every shot, as WebP"). The codecs are jSquash's (Squoosh's libwebp, image-png and mozjpeg compiled to
// WebAssembly): no native build at install and the same bytes on Windows and macOS. Each codec's .wasm is read from
// node_modules and handed in, as Node has no fetch for file URLs. A PNG becomes lossless WebP: the pixels stay exact for
// judging how something looks, and on Ledung's own dark screenshots it was 33-46 % of the PNG (lossy q80 was larger
// than the PNG on most of them). A JPEG, lossy already, becomes lossy WebP at quality 90.
//
// Each conversion runs in a worker thread of its own, which ends with it (code review of PR #307): a lossless encode
// took 0.5 s for a 4K screenshot and 2 s for an 8K one, which on Ledung's own thread would hold every page and session
// that long, and WebAssembly memory never shrinks (+480 MB for the 8K one). The worker's code goes in as a data: module,
// since the package bundles Ledung into a few fixed files and a worker file of its own would not be among them.
import { Worker } from 'node:worker_threads';

/** Past this many pixels an image is kept as it came (5K is 14.7 million, a 1280 × 16,000 full page 20.5 million). */
export const WEBP_MAX_PIXELS = 25_000_000;
/** A conversion that takes longer is stopped, and the image kept as it came. */
const WEBP_TIMEOUT_MS = 60_000;
const JPEG_QUALITY = 90;

/** The worker: decodes the PNG or JPEG and encodes it as WebP, with the codecs at the file URLs it is given. */
const WORKER = `
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
const { bytes, kind, at, quality } = workerData;
const wasm = (url) => WebAssembly.compile(fs.readFileSync(new URL(url)));
const own = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
let pixels;
if (kind === 'png') {
  const png = await import(at.png);
  await png.init(await wasm(at.pngWasm));
  pixels = await png.decode(own);
} else {
  const jpeg = await import(at.jpeg);
  await jpeg.init(await wasm(at.jpegWasm));
  pixels = await jpeg.default(own);
}
// Node 24 has WebAssembly SIMD, which webp's init picks; its module must be the SIMD build.
const webp = await import(at.webp);
await webp.init(await wasm(at.webpWasm));
const out = await webp.default(pixels, kind === 'png' ? { lossless: 1 } : { quality });
parentPort.postMessage(out, [out]);
`;

/** Where the codecs are: resolved here, so the package's own node_modules are used wherever Ledung runs from. */
function codecs(): Record<string, string> {
  const at = (spec: string) => import.meta.resolve(spec);
  return {
    png: at('@jsquash/png/decode.js'), pngWasm: at('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'),
    jpeg: at('@jsquash/jpeg/decode.js'), jpegWasm: at('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'),
    webp: at('@jsquash/webp/encode.js'), webpWasm: at('@jsquash/webp/codec/enc/webp_enc_simd.wasm'),
  };
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
 * A PNG or JPEG as WebP. Throws when it can't be converted (an image too large, one the codec refuses, or one that took
 * too long); the caller keeps the image as it came then, so a question is never refused for the conversion.
 */
export async function toWebp(bytes: Buffer, kind: 'png' | 'jpeg'): Promise<Buffer> {
  const pixels = pixelCount(bytes, kind);
  if (pixels === null || pixels > WEBP_MAX_PIXELS) throw new Error(`the image is ${pixels === null ? 'of unknown size' : `${pixels} pixels`}; at most ${WEBP_MAX_PIXELS} are converted`);
  const out = await new Promise<Buffer>((resolve, reject) => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER)}`), {
      workerData: { bytes: new Uint8Array(bytes), kind, at: codecs(), quality: JPEG_QUALITY },
      // A worker's own LEDUNG_* or anything else is not needed; it reads only the codec files it is given.
      env: {},
      stdout: true,
      stderr: true,
    });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error(`the conversion took over ${WEBP_TIMEOUT_MS / 1000} s`)); }, WEBP_TIMEOUT_MS);
    worker.once('message', (m: ArrayBuffer) => { clearTimeout(timer); resolve(Buffer.from(m)); void worker.terminate(); });
    worker.once('error', (e) => { clearTimeout(timer); reject(e); });
    worker.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the converter stopped (${code})`)); });
  });
  if (!isWebp(out)) throw new Error('the encoder gave no WebP');
  return out;
}
