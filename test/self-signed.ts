// A self-signed certificate for tests (issues #200 and #201): an ECDSA P-256 key (or RSA, to test a key TLS
// refuses) and an X.509 v3 certificate for one DNS name, written out in DER by hand (RFC 5280) and signed with
// Node's own crypto, so no package is needed. Nothing here checks anything.
import crypto from 'node:crypto';

function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  const n = body.length;
  const length = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

const seq = (...c: Buffer[]) => der(0x30, ...c);
const oid = (dotted: string) => {
  const [a, b, ...rest] = dotted.split('.').map(Number) as [number, number, ...number[]];
  const bytes = [a * 40 + b];
  for (const n of rest) {
    const groups = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) groups.unshift((v & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
};
const time = (d: Date) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const name = (cn: string) => seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn)))));

/**
 * PEM key and certificate for `dnsName`, valid from a minute ago (or `validFrom`, ms) for `days`; an RSA key of
 * `rsaBits` instead of P-256. With `publicKey` the certificate is for that key (as a CA issues for a CSR's key, #202)
 * and signed by the returned key.
 */
export function selfSigned(dnsName: string, opts: { days?: number; rsaBits?: number; validFrom?: number; publicKey?: crypto.KeyObject } = {}): { key: string; cert: string } {
  const days = opts.days ?? 30;
  const pair = opts.rsaBits
    ? crypto.generateKeyPairSync('rsa', { modulusLength: opts.rsaBits })
    : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateKey = pair.privateKey;
  const publicKey = opts.publicKey ?? pair.publicKey;
  // ecdsa-with-SHA256, or sha256WithRSAEncryption with its NULL parameters.
  const signatureAlgorithm = opts.rsaBits ? seq(oid('1.2.840.113549.1.1.11'), der(0x05)) : seq(oid('1.2.840.10045.4.3.2'));
  const from = opts.validFrom ?? Date.now() - 60_000;
  const serial = crypto.randomBytes(8);
  // Positive, with no leading zero byte (DER forbids one; 0x00 there made about one certificate in 128 unreadable).
  serial[0] = (serial[0]! & 0x7f) | 0x40;
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    signatureAlgorithm,
    name(dnsName),
    seq(time(new Date(from)), time(new Date(from + days * 86_400_000))),
    name(dnsName),
    publicKey.export({ type: 'spki', format: 'der' }),
    // subjectAltName: the one DNS name; browsers and Node check this, not the common name.
    der(0xa3, seq(seq(oid('2.5.29.17'), der(0x04, seq(der(0x82, Buffer.from(dnsName))))))),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const cert = seq(tbs, signatureAlgorithm, der(0x03, Buffer.from([0]), signature));
  const pem = (label: string, b: Buffer) => `-----BEGIN ${label}-----\n${b.toString('base64').replace(/.{64}/g, '$&\n').replace(/\n?$/, '\n')}-----END ${label}-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert: pem('CERTIFICATE', cert) };
}
