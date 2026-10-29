// The join code of "Invite a computer" (issue #237): one string carrying the relay's address and a one-time token,
// so the person joining pastes only that (Martin, question #405, default 5). The relay keeps only the token's hash;
// the token is used once and runs out after 24 hours there.
//
// Short form "relay.example.org/K7QF-…" for a wss:// relay; a relay on this computer (tests, trials) is written in
// full, "ws://127.0.0.1:8080/K7QF-…", since plain ws:// is allowed only there (tunnel.ts, secureRelay).
import { isJoinToken } from './join-token.ts';
import { secureRelay } from './tunnel.ts';

export { isJoinToken, JOIN_TOKEN_BYTES, newJoinToken } from './join-token.ts';

/** The code the admin hands over: the relay as Ledung dials it (wss://host or ws://127.0.0.1:port) and the token. */
export function joinCode(relay: string, token: string): string {
  const url = new URL(relay);
  return url.protocol === 'wss:' ? `${url.host}/${token}` : `${url.protocol}//${url.host}/${token}`;
}

/** What a pasted code says: the relay to dial, where to enrol, and the token. Throws a readable error. */
export function parseJoinCode(code: string): { relay: string; enrol: string; token: string } {
  const text = code.trim();
  const full = /^wss?:\/\//i.test(text) ? text : `wss://${text}`;
  let url: URL;
  try {
    url = new URL(full);
  } catch {
    throw new Error('That is not a join code: it looks like "relay.example.org/ABCD-…".');
  }
  const token = url.pathname.replace(/^\//, '').toUpperCase();
  if (!isJoinToken(token) || url.search || url.hash || url.username || url.password) {
    throw new Error('That is not a join code: it looks like "relay.example.org/ABCD-…", 28 letters and digits after the slash.');
  }
  const relay = `${url.protocol}//${url.host}`;
  if (!secureRelay(relay)) throw new Error('A join code must name a relay reached over wss:// (plain ws:// only on this computer).');
  return { relay, enrol: `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}/enrol`, token };
}
