// Ledung's icon for the shortcuts Settings makes (issue #415): a Windows .ico and a macOS .icns, each wrapping the
// page's own PNG icons as they are. Both formats take PNG data inside since Windows Vista and Mac OS X 10.5, so no
// image library and no Mac tool (iconutil) is needed, and the files come out the same on every computer.

/** The PNG file signature: what both formats expect at the start of each image. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG)) throw new Error('Not a PNG image.');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** A .ico of one PNG image, at most 256 pixels square (the format's limit; 256 is written as 0). */
export function icoFromPng(png: Buffer): Buffer {
  const { width, height } = pngSize(png);
  if (width > 256 || height > 256) throw new Error(`An .ico image is at most 256 pixels, not ${width}×${height}.`);
  const head = Buffer.alloc(6 + 16);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // 1: icon
  head.writeUInt16LE(1, 4); // one image
  head.writeUInt8(width % 256, 6);
  head.writeUInt8(height % 256, 7);
  head.writeUInt8(0, 8); // no palette
  head.writeUInt8(0, 9); // reserved
  head.writeUInt16LE(1, 10); // colour planes
  head.writeUInt16LE(32, 12); // bits per pixel
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(head.length, 18); // the image follows the directory
  return Buffer.concat([head, png]);
}

/** The .icns type of a PNG of this size: ic08 256 pixels, ic09 512, ic10 1024 (Retina 512). */
const ICNS_TYPES: Record<number, string> = { 256: 'ic08', 512: 'ic09', 1024: 'ic10' };

/** A .icns of square PNG images of 256, 512 or 1024 pixels. */
export function icnsFromPngs(pngs: Buffer[]): Buffer {
  const parts = pngs.map((png) => {
    const { width, height } = pngSize(png);
    const type = width === height ? ICNS_TYPES[width] : undefined;
    if (!type) throw new Error(`An .icns here takes square images of 256, 512 or 1024 pixels, not ${width}×${height}.`);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([head, png]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([head, ...parts]);
}
