// The certificate Ledung ends TLS with for streams through the relay (issue #201, docs/steps/relay-e2e.md 3a).
// tls.key and tls.crt (the full chain) in remoteDir(); step 4's ACME client writes them, and tests do by hand.
// Read again whenever they change, so a renewed certificate is used without a restart; connections already
// open keep the one they started with.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

export const TLS_KEY = 'tls.key';
export const TLS_CERT = 'tls.crt';

export interface TlsFiles {
  key: Buffer;
  cert: Buffer;
}

export type CertificateCheck =
  | { state: 'unchanged' }
  | { state: 'missing'; problem: string }
  | { state: 'invalid'; problem: string }
  | { state: 'loaded'; files: TlsFiles };

/** Watches tls.key and tls.crt by size and time, cheaply enough to ask on every stream. */
export class CertificateFiles {
  private readonly dir: string;
  private readonly publicName: string;
  private seen: string | null = null;

  constructor(dir: string, publicName: string) {
    this.dir = dir;
    this.publicName = publicName;
  }

  /** What changed since the last call: nothing, gone, unusable, or a new key and certificate to use. */
  check(): CertificateCheck {
    const keyFile = path.join(this.dir, TLS_KEY);
    const certFile = path.join(this.dir, TLS_CERT);
    let stamp: string;
    try {
      stamp = [fs.statSync(keyFile), fs.statSync(certFile)].map((s) => `${s.size}:${s.mtimeMs}`).join('|');
    } catch {
      this.seen = null;
      return { state: 'missing', problem: `No certificate: ${TLS_KEY} and ${TLS_CERT} are not both in ${this.dir}, so encrypted connections through the relay are closed.` };
    }
    if (stamp === this.seen) return { state: 'unchanged' };
    this.seen = stamp;
    try {
      const files = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
      const problem = certificateProblem(files, this.publicName);
      return problem ? { state: 'invalid', problem } : { state: 'loaded', files };
    } catch (e) {
      return { state: 'invalid', problem: `The certificate in ${this.dir} could not be read: ${(e as Error).message}` };
    }
  }
}

/** Why this key and certificate can't serve the public name; null: they can. */
export function certificateProblem(files: TlsFiles, publicName: string): string | null {
  let cert: crypto.X509Certificate;
  let key: crypto.KeyObject;
  try {
    cert = new crypto.X509Certificate(files.cert);
    key = crypto.createPrivateKey(files.key);
  } catch (e) {
    return `${TLS_KEY} or ${TLS_CERT} is not a PEM key and certificate: ${(e as Error).message}`;
  }
  if (!cert.checkPrivateKey(key)) return `${TLS_KEY} is not the key of ${TLS_CERT}.`;
  // A certificate for another name would only ever show the phone an error.
  if (!cert.checkHost(publicName)) return `${TLS_CERT} is not for ${publicName}.`;
  // What TLS itself refuses (an RSA key under 2048 bits, for one) would otherwise throw where it is used, at the
  // start or on a phone's connection, and stop Ledung (review 201, finding 2).
  try {
    tls.createSecureContext({ key: files.key, cert: files.cert });
  } catch (e) {
    return `${TLS_KEY} and ${TLS_CERT} can't be used for TLS: ${(e as Error).message}`;
  }
  return null;
}
