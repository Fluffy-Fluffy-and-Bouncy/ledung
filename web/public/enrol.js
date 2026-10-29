// The enrol page (issue #241, enrol.html): sets up the passkey of the device that made this one-time link, here at the
// top level of this Ledung's own page. Safari can't create a passkey inside a frame on another site; it can use one
// there, so the device's frame logs on with it afterwards. No cookie is needed: the code in the fragment is the proof,
// works once and for five minutes, and only for a device still in its 10 minutes after pairing. Plain script module,
// no build.
import { NO_WEBAUTHN, noPlatformPasskey, passkeyError } from '/enrol-messages.js';

const code = location.hash.slice(1);
history.replaceState(null, '', location.pathname); // the code leaves the address bar
const what = document.getElementById('what');
const go = document.getElementById('go');
const done = document.getElementById('done');

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const post = async (path, body) => {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Ledung answered ${res.status}.`);
  return json;
};

if (!code) {
  what.textContent = 'This link has no code. Make a new one from the device that asked for it.';
} else {
  what.textContent = 'Press the button, then use Touch ID, Face ID or Windows Hello. The passkey is for this Ledung, and for the device that sent you here.';
  go.hidden = false;
  // Said before trying (issue #273): no passkey can be made on this computer itself. The button stays, for a phone
  // (by its QR code) or a password manager's extension.
  if (!window.PublicKeyCredential) {
    what.textContent = NO_WEBAUTHN;
    go.hidden = true;
  } else if (PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then((available) => {
      if (!available) what.textContent = noPlatformPasskey(navigator.userAgent);
    }, () => {});
  }
  // The browser asks for the passkey only after a press here (Safari wants a user gesture for it).
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const o = await post('/enrol/options', { code });
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: fromB64(o.challenge), rp: o.rp, user: { id: fromB64(o.user.id), name: o.user.name, displayName: o.user.displayName },
          pubKeyCredParams: o.pubKeyCredParams, timeout: o.timeout, attestation: 'none',
          authenticatorSelection: { residentKey: 'discouraged', userVerification: 'required' },
        },
      });
      if (!cred) throw new Error('Setting up the passkey was cancelled.');
      const r = cred.response;
      const response = {
        id: cred.id, rawId: toB64(cred.rawId), type: cred.type, clientExtensionResults: {},
        response: { clientDataJSON: toB64(r.clientDataJSON), attestationObject: toB64(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] },
      };
      const { name } = await post('/enrol/finish', { code, response });
      what.textContent = `The passkey of "${name}" is set up.`;
      go.hidden = true;
      done.hidden = false;
    } catch (e) {
      what.textContent = passkeyError(e);
      go.disabled = false;
    }
  });
}
