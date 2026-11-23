// A small PNG reader for tests: 8-bit RGB or RGBA, non-interlaced, which is what web/public holds. Returns a pixel as
// [r, g, b, a] (a = 255 for RGB). Written here so a test needs no image library.
import zlib from 'node:zlib';

export interface Png {
  width: number;
  height: number;
  pixel(x: number, y: number): [number, number, number, number];
}

export function readPng(buf: Buffer): Png {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const type = buf[25];
  const interlace = buf[28];
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace !== 0) {
    throw new Error(`unsupported PNG: depth ${depth}, colour type ${type}, interlace ${interlace}`);
  }
  const bpp = type === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let o = 8; o < buf.length; ) {
    const n = buf.readUInt32BE(o);
    if (buf.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + n));
    o += 12 + n;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const a = x >= bpp ? out[i - bpp]! : 0;
      const b = y > 0 ? out[i - stride]! : 0;
      const c = x >= bpp && y > 0 ? out[i - stride - bpp]! : 0;
      let v = raw[y * (stride + 1) + 1 + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = v & 255;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const i = (y * width + x) * bpp;
      return [out[i]!, out[i + 1]!, out[i + 2]!, bpp === 4 ? out[i + 3]! : 255];
    },
  };
}
