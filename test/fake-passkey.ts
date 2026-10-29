// A software passkey for tests (issue #160, step 5): a real ES256 key made here, and the bytes a phone's
// authenticator would send, built from the WebAuthn spec (authenticator data, client data, a "none"
// attestation). Not a mock of Ledung's check: the check under test is @simplewebauthn/server's, over these bytes.
import crypto from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');

export interface FakePasskeyOptions {
  /** Sign as this origin (default https://<rpID>). */
  origin?: string;
  /** Leave the user-verified flag out (a phone that skipped Face ID / the fingerprint). */
  noUserVerification?: boolean;
  /** Signed inside a frame (issue #241): the client data says crossOrigin, and topOrigin unless it is null (Safari leaves it out). */
  framedIn?: string | null;
  /** A topOrigin with crossOrigin false: what no browser sends (the spec's violation case), to check it is refused. */
  topOriginOnly?: string;
}

export class FakePasskey {
  readonly id = crypto.randomBytes(16);
  private readonly keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  counter = 0;
  private readonly rpID: string;

  constructor(rpID: string) {
    this.rpID = rpID;
  }

  get credentialId(): string {
    return b64url(this.id);
  }

  private authData(flags: number, attested?: Buffer): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const rpIdHash = crypto.createHash('sha256').update(this.rpID).digest();
    return Buffer.concat([rpIdHash, Buffer.from([flags]), counter, ...(attested ? [attested] : [])]);
  }

  private clientData(type: string, challenge: string, opts: FakePasskeyOptions): Buffer {
    const frame = opts.topOriginOnly !== undefined ? { crossOrigin: false, topOrigin: opts.topOriginOnly }
      : opts.framedIn === undefined ? { crossOrigin: false } : { crossOrigin: true, ...(opts.framedIn === null ? {} : { topOrigin: opts.framedIn }) };
    return Buffer.from(JSON.stringify({ type, challenge, origin: opts.origin ?? `https://${this.rpID}`, ...frame }));
  }

  /** What navigator.credentials.create() returns, as JSON, for registration options. */
  register(options: { challenge: string }, opts: FakePasskeyOptions = {}) {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')],
    ]));
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.id.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.id, Buffer.from(cose)]);
    // Flags: user present (0x01), user verified (0x04), attested credential data (0x40).
    const authData = this.authData(0x41 | (opts.noUserVerification ? 0 : 0x04), attested);
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]) as never);
    return {
      id: this.credentialId, rawId: this.credentialId, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge, opts)), attestationObject: b64url(attestationObject), transports: ['internal'] },
    };
  }

  /** What navigator.credentials.get() returns, as JSON, for a challenge. */
  assert(options: { challenge: string }, opts: FakePasskeyOptions = {}) {
    this.counter++;
    const authData = this.authData(0x01 | (opts.noUserVerification ? 0 : 0x04));
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, opts);
    const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]), this.keys.privateKey);
    return {
      id: this.credentialId, rawId: this.credentialId, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientDataJSON), authenticatorData: b64url(authData), signature: b64url(signature) },
    };
  }

  /** The header a request carries the assertion in. */
  header(options: { challenge: string }, opts: FakePasskeyOptions = {}): string {
    return Buffer.from(JSON.stringify(this.assert(options, opts))).toString('base64url');
  }
}
