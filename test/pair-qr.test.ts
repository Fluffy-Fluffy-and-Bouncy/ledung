// The pairing QR code (issue #194): Ledung's icon in its middle, and fewer, larger modules than the old one.
// Each code is drawn to pixels as the page draws it, with whatever might be on the icon's square in the
// middle, and read back with a QR decoder (jsQR): it must still carry the pairing link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsqr from 'jsqr';
import qrcode from 'qrcode-generator';
import { Devices } from '../src/server/devices.ts';
import { openDatabase } from '../src/store/database.ts';
import { pairQrText, qrModules, type QrModules } from '../web/src/components/qr.ts';

// jsqr is CommonJS with its function under default.
const jsQR = jsqr.default;

/** The code as pixels: `scale` pixels a module, the page's 4-module white margin, `middle` decides the icon's square. */
function draw({ n, dark, logo }: QrModules, middle: (r: number, c: number) => boolean, scale = 4) {
  const w = (n + 8) * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  const inLogo = (v: number) => v >= logo.from && v < logo.from + logo.size;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!(inLogo(r) && inLogo(c) ? middle(r, c) : dark(r, c))) continue;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const i = (((r + 4) * scale + y) * w + (c + 4) * scale + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }
  return jsQR(px, w, w)?.data ?? null;
}

// The icon is a dark square with light boats: read as modules it is anything. All light, all dark and noise.
const middles: Record<string, (r: number, c: number) => boolean> = {
  'left clear': () => false,
  'all dark': () => true,
  'noise': (r, c) => ((r * 7 + c * 13) % 5) < 2,
};

test('the pairing code reads back as the pairing link, whatever the icon in its middle looks like to a reader', () => {
  for (const host of ['pc.example.com', 'ledung.example.com', 'a-much-longer-relay-name.somewhere.example.net']) {
    for (let i = 0; i < 10; i++) {
      const { code } = new Devices(openDatabase(':memory:')).newPairCode();
      const url = `https://${host}/p/${code}`;
      const qr = qrModules(pairQrText(url));
      assert.ok(qr.logo.size >= 7, `the icon gets a square of its own (${qr.logo.size} modules of ${qr.n})`);
      for (const [name, middle] of Object.entries(middles)) {
        const read = draw(qr, middle);
        assert.equal(read, url.toUpperCase(), `${host}, middle ${name}`);
        // What the phone opens: the same host, the short path and the code (the server takes either case).
        const opened = new URL(read!);
        assert.equal(opened.host, host);
        assert.equal(opened.pathname.toLowerCase(), `/p/${code}`);
      }
    }
  }
});

test('the code has fewer modules than the old one for the same public name', () => {
  // The old link: /pair?code= and 32 base64url characters, in byte mode at level M.
  const host = 'ledung.example.com';
  const old = qrcode(0, 'M');
  old.addData(`https://${host}/pair?code=${'A'.repeat(32)}`);
  old.make();
  // 69 bytes: past version 4-M's 62, so version 5, 37 modules a side.
  assert.equal(old.getModuleCount(), 37);
  // The new link in capitals is 49 alphanumeric characters (8 + 18 + 3 + 20): version 4-H holds 50, so 33 a side.
  const { code } = new Devices(openDatabase(':memory:')).newPairCode();
  const text = pairQrText(`https://${host}/p/${code}`);
  assert.equal(text.length, 49);
  assert.equal(qrModules(text).n, 33);
});

test('a pairing code is 20 letters and digits, and matches in either case', () => {
  const devices = new Devices(openDatabase(':memory:'));
  let code = devices.newPairCode().code;
  while (!code.includes('k')) code = devices.newPairCode().code;
  assert.match(code, /^[0-9a-z]{20}$/);
  assert.ok(devices.codeValid(code.toUpperCase()));
  // A character outside ASCII that lower-cases into the alphabet is not the code (U+212A, the Kelvin sign, is "k").
  assert.equal('K'.toLowerCase(), 'k');
  assert.equal(devices.codeValid(code.replace('k', 'K')), false);
  assert.ok(devices.pair(code.toUpperCase(), 'Phone'));
});
