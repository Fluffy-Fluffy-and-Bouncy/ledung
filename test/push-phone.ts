// The phone's side of a push (issue #246), for the push tests: a browser's subscription and reading what arrives,
// written from the RFCs apart from Ledung's code.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const hmac = (key: Buffer, data: Buffer) => crypto.createHmac('sha256', key).update(data).digest();

/** The phone's side, written from RFC 8291 section 3 and RFC 8188 with plain HMAC, apart from Ledung's code. */
export function decrypt(message: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
  const ua = crypto.createECDH('prime256v1');
  ua.setPrivateKey(uaPrivate);
  const salt = message.subarray(0, 16);
  const idlen = message[20]!;
  const asPublic = message.subarray(21, 21 + idlen);
  const sealed = message.subarray(21 + idlen);
  const prkKey = hmac(auth, ua.computeSecret(asPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  // The last record ends with 0x02, then any zero padding.
  let end = padded.length - 1;
  while (padded[end] === 0) end--;
  assert.equal(padded[end], 2, 'last-record delimiter');
  return padded.subarray(0, end);
}

/** A browser's subscription: real P-256 keys, and the phone's private key to read what arrives. */
export function phone(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    read: (body: Buffer) => JSON.parse(decrypt(body, ecdh.getPrivateKey(), auth).toString()),
  };
}

