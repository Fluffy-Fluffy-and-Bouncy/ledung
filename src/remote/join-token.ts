// The one-time token in a join code (issue #237). Shared by the relay, which hands it out and keeps only its
// SHA-256, and Ledung, which reads it from the code: no imports, so the relay's container copies just this file.

/** 140 random bits in Crockford-style base32 (no I, L, O, U), in groups of four: easy to read out and to retype. */
const TOKEN = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** The random bytes a token is made from: 18 bytes, of which 140 bits fill seven groups of four. */
export const JOIN_TOKEN_BYTES = 18;

/** A fresh token from JOIN_TOKEN_BYTES random bytes: what the relay hands out for an invite. */
export function newJoinToken(random: Buffer): string {
  if (random.length < JOIN_TOKEN_BYTES) throw new Error(`a join token needs ${JOIN_TOKEN_BYTES} random bytes`);
  let bits = 0n;
  for (const byte of random.subarray(0, JOIN_TOKEN_BYTES)) bits = (bits << 8n) | BigInt(byte);
  let text = '';
  for (let i = 0; i < 28; i++) text = ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)] + text;
  return text.match(/.{4}/g)!.join('-');
}

export function isJoinToken(token: string): boolean {
  return TOKEN.test(token);
}
