// The sign page (#463, sign.html): signs one waiting request for the device that made this one-time link, here in the
// default browser, because Ledung's desktop app on a Mac can't show Touch ID (#427). The passkey is the one that device
// set up in this browser (the enrol link, #241). No cookie is needed: the code in the fragment is the proof, works once
// and for two minutes, and only for that device's one request. What the page says is #481's (signWords). Plain script
// module, no build.
import { signError, signWords } from '/enrol-messages.js';

const code = location.hash.slice(1);
history.replaceState(null, '', location.pathname); // the code leaves the address bar
const title = document.getElementById('title');
const what = document.getElementById('what');
const request = document.getElementById('request');
const facts = document.getElementById('facts');
const go = document.getElementById('go');
const fine = document.getElementById('fine');
const done = document.getElementById('done');

/** Text parts into an element, as text only: a device's name is typed by whoever paired it. */
const fill = (el, parts) => {
  el.replaceChildren(...parts.map((p) => {
    if (!p.bold) return document.createTextNode(p.text);
    const b = document.createElement('b');
    b.textContent = p.text;
    return b;
  }));
};

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const post = async (path, body) => {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Ledung answered ${res.status}.`);
  return json;
};

if (!code) {
  what.textContent = 'This link has no code. Make the change again in the app.';
} else if (!window.PublicKeyCredential) {
  what.textContent = 'This browser has no passkeys. Open the link in Safari or a current Chrome.';
} else {
  // What is signed, before any prompt: the device and the request, as Ledung has them for this code.
  post('/sign/options', { code }).then((o) => {
    const words = signWords(o.name, o.what, o.terms);
    title.textContent = words.title;
    document.title = `Ledung · ${words.title}`;
    fill(what, words.lead);
    if (words.request) {
      request.textContent = words.request;
      request.hidden = false;
    }
    facts.querySelector('h3').textContent = words.factsTitle;
    facts.querySelector('ul').replaceChildren(...words.rules.map((parts) => {
      const li = document.createElement('li');
      fill(li, parts);
      return li;
    }));
    facts.hidden = false;
    go.textContent = words.button;
    go.hidden = false;
    fine.textContent = words.fine;
    fine.hidden = false;
    // The browser asks for the passkey only after a press here (Safari wants a user gesture for it).
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const cred = await navigator.credentials.get({
          publicKey: {
            challenge: fromB64(o.options.challenge), rpId: o.options.rpId, timeout: o.options.timeout, userVerification: 'required',
            allowCredentials: (o.options.allowCredentials || []).map((c) => ({ type: 'public-key', id: fromB64(c.id) })),
          },
        });
        if (!cred) throw new Error('The passkey check was cancelled.');
        const r = cred.response;
        const response = {
          id: cred.id, rawId: toB64(cred.rawId), type: cred.type, clientExtensionResults: {},
          response: {
            clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.authenticatorData), signature: toB64(r.signature),
            ...(r.userHandle ? { userHandle: toB64(r.userHandle) } : {}),
          },
        };
        await post('/sign/finish', { code, response });
        const tick = document.createElement('span');
        tick.className = 'ok';
        tick.textContent = '✓ ';
        title.replaceChildren(tick, document.createTextNode(words.doneTitle));
        fill(what, words.doneLead);
        for (const el of [request, facts, go, fine]) el.hidden = true;
        done.hidden = false;
      } catch (e) {
        what.textContent = signError(e);
        go.disabled = false;
      }
    });
  }, (e) => {
    what.textContent = e.message;
  });
}
