// The phone's passkey (issue #160, docs/steps/relay.md step 5). Through the public name, Ledung asks for it
// before a signed action (a sensitive decision, or the unlock; words to a manager are covered by the unlock, #192): it issues a challenge for exactly the
// request about to be sent, the phone signs it after Face ID or a fingerprint, and the request goes again
// with that signature (web/src/api.ts). On this computer none of this runs. Browser-only: main.tsx hands
// these to the API module.
import { PASSKEY_CANCELLED, type PasskeyCalls } from './api.ts';
import { asCancelled } from './passkeyWords.ts';

export const toBase64url = (bytes: ArrayBuffer | Uint8Array): string => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const fromBase64url = (text: string): Uint8Array<ArrayBuffer> => {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

type CredentialOptions = { challenge: string; [k: string]: unknown };

/** Signs Ledung's challenge for one request; the header value the request then carries. */
export async function signRequest(options: CredentialOptions): Promise<string> {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: fromBase64url(options.challenge),
      rpId: options.rpId as string,
      timeout: options.timeout as number,
      userVerification: 'required',
      allowCredentials: ((options.allowCredentials as { id: string }[] | undefined) ?? []).map((c) => ({ type: 'public-key' as const, id: fromBase64url(c.id) })),
    },
  }).catch((e: unknown) => {
    throw asCancelled(e);
  }) as PublicKeyCredential | null;
  if (!cred) throw new Error(PASSKEY_CANCELLED);
  const r = cred.response as AuthenticatorAssertionResponse;
  const json = {
    id: cred.id, rawId: toBase64url(cred.rawId), type: cred.type, clientExtensionResults: {},
    response: {
      clientDataJSON: toBase64url(r.clientDataJSON), authenticatorData: toBase64url(r.authenticatorData), signature: toBase64url(r.signature),
      ...(r.userHandle ? { userHandle: toBase64url(r.userHandle) } : {}),
    },
  };
  return toBase64url(new TextEncoder().encode(JSON.stringify(json)));
}

/** Makes this device's passkey from Ledung's registration options; the answer to send back. */
export async function createPasskey(options: CredentialOptions): Promise<unknown> {
  const user = options.user as { id: string; name: string; displayName: string };
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: fromBase64url(options.challenge),
      rp: options.rp as PublicKeyCredentialRpEntity,
      user: { id: fromBase64url(user.id), name: user.name, displayName: user.displayName },
      pubKeyCredParams: options.pubKeyCredParams as PublicKeyCredentialParameters[],
      timeout: options.timeout as number,
      attestation: 'none',
      authenticatorSelection: { residentKey: 'discouraged', userVerification: 'required' },
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new Error('Setting up the passkey was cancelled.');
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id, rawId: toBase64url(cred.rawId), type: cred.type, clientExtensionResults: {},
    response: { clientDataJSON: toBase64url(r.clientDataJSON), attestationObject: toBase64url(r.attestationObject), transports: r.getTransports?.() ?? [] },
  };
}

/** What the API module calls for a passkey. */
export const browserPasskeys: PasskeyCalls = { sign: signRequest, create: createPasskey };
