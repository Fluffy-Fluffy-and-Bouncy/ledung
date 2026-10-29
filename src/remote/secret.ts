// The secret a Ledung signs in to the relay with (issue #236). The relay keeps only its SHA-256, so a new
// computer's Ledung makes its own secret and its owner sends the relay's admin only the hash: the secret
// never travels (Martin, 2026-10-19, Ledung question 398). The relay imports hashSecret from here, so both
// sides hash the same way.
//
//   node src/main.ts remote-secret     (ledung remote-secret with the npm package)
import crypto from 'node:crypto';

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 32 random bytes, URL-safe: nothing to escape in JSON or a shell. */
export function makeSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** What `remote-secret` prints: the secret for this computer's config, and the hash to send. */
export function remoteSecretText(secret = makeSecret()): string {
  return [
    'A new secret for this computer\'s relay connection.',
    '',
    'Keep this one to yourself. It goes in your config, as "secret" in the "remote" block:',
    `  ${secret}`,
    '',
    'Send only this to whoever runs the relay (it is the SHA-256 of the secret and cannot be turned back into it):',
    `  ${hashSecret(secret)}`,
    '',
    'They add your computer with it and send you the rest of the "remote" block.',
  ].join('\n');
}
