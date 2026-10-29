// The pairing QR code's modules (issue #194): a code with the Ledung logo in its middle, as few modules as the
// link allows. Kept apart from the component so a test can draw it, cover the logo and decode it.
import qrcode from 'qrcode-generator';

/** QR alphanumeric mode's characters: 5.5 bits each instead of a byte's 8, so the same link needs fewer modules. */
const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]*$/;

/**
 * Level H: up to 30 % of the code can be lost and it still reads, which the logo in the middle uses up part
 * of. Q (25 %) leaves too little room for a logo a phone still reads past (#194).
 */
export const QR_LEVEL = 'H';

/** Share of the code's width the logo's clear square takes (#194; the test checks it reads with it covered). */
export const LOGO_SHARE = 0.3;

/**
 * The text the pairing QR code carries: the link in capitals, so it fits the alphanumeric mode. Scheme and host
 * are case-blind, and the server takes the /p/ path and the code in either case (#194).
 */
export const pairQrText = (url: string) => url.toUpperCase();

export type QrModules = { n: number; dark: (r: number, c: number) => boolean; logo: { from: number; size: number } };

export function qrModules(text: string): QrModules {
  const qr = qrcode(0, QR_LEVEL);
  qr.addData(text, ALPHANUMERIC.test(text) ? 'Alphanumeric' : 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  // An odd size, so the square sits exactly in the middle of the (always odd) grid.
  let size = Math.floor(n * LOGO_SHARE);
  if (size % 2 === 0) size--;
  const from = (n - size) / 2;
  const inLogo = (r: number, c: number) => r >= from && r < from + size && c >= from && c < from + size;
  return { n, dark: (r, c) => !inLogo(r, c) && qr.isDark(r, c), logo: { from, size } };
}
