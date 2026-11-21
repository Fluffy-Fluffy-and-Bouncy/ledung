// Passkeys for page-key actions through the public name (issue #160, docs/steps/relay.md step 5; Martin's
// decisions 3 and 4 of 2026-10-17: a passkey, checked with @simplewebauthn/server).
//
// A copied device cookie must not be enough to allow a sensitive call or to put words in a manager's mouth
// (brief section 5): those need the phone's passkey, which needs Face ID or a fingerprint (user verification)
// and never leaves the phone. Each check signs a challenge Ledung issued for exactly one request (its method,
// path and the hash of its exact body), for one device, used once, within two minutes. A signature over
// "allow permission A" therefore cannot allow permission B, deny instead of allow, or be replayed.
//
// Everything fails closed: an unknown, expired, used or mismatched challenge, a missing user-verification
// flag, another device's credential or a counter going backwards refuses the request before it does anything.
import crypto from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { COMPUTER_IDLE_MS, type Device, type Devices } from './devices.ts';

export const CHALLENGE_MS = 2 * 60 * 1000;
/** How long an enrol code works (issue #241): long enough to open the window and use Touch ID, short for a copy. */
export const ENROL_MS = 5 * 60 * 1000;
/**
 * How long one passkey check unlocks a device for ordinary changes through the public name (Martin,
 * 2026-10-17 12:54, review finding 1 of PR #164: "C but unlocks 30min"). Locked, a device cookie is read-only.
 */
export const UNLOCK_MS = 30 * 60 * 1000;
/** The refusals the page acts on (web/src/api.ts): ask for the passkey for this request, or unlock first. */
export const PASSKEY_NEEDED = 'This needs your passkey.';
export const DEVICE_LOCKED = 'This device is locked: unlock it with its passkey to make changes from here.';
/** The header a request through the public name carries its passkey assertion in (base64url of its JSON). */
export const PASSKEY_HEADER = 'x-ledung-passkey';
/**
 * The header a trusted computer's frame carries a vouched challenge in instead (issue #313,
 * docs/steps/trusted-computer.md choice 3a): the challenge itself, which that computer's own screen vouched for.
 */
export const VOUCH_HEADER = 'x-ledung-vouch';
/** The refusal of a vouch for what still takes a passkey (choice 2a): the page then asks for the passkey itself. */
export const PASSKEY_ONLY = 'This needs a passkey, or this computer\'s own screen: a trusted computer can\'t do it.';
/** What a sign link (#463) for logging the device on says it signs; the sign page words a log-on by it (#481). */
export const SIGN_LOG_ON = 'Log this device on';
/**
 * What the sign page (#481) tells the person before they sign: whether it logs the device on, and for how long that
 * lasts for its kind, from the rules themselves (a computer: until it logs out or goes unused; a phone: unlocked a while).
 */
export type SignTerms = { logOn: boolean; kind: Device['kind']; idleDays: number; unlockMinutes: number; linkMinutes: number };
/** A sign link (#463) that is unknown, used or past its two minutes: what the browser and the app are told. */
export const SIGN_LINK_GONE = 'This sign link is not valid any more: it was used, or its two minutes ran out. Make the change again in the app.';
/** A sign link picked up by a device other than the one it was made for (#463). */
export const SIGN_LINK_FOREIGN = 'This sign link is for another device.';
/** ES256 and RS256: what phones and computers make; nothing weaker. */
const ALGORITHMS = [-7, -257];
/** Open challenges per device; more is a page (or someone) asking without answering. */
const MAX_OPEN = 20;

export class PasskeyError extends Error {}

/** What a challenge is for: the exact request, so the signature covers it. */
export function actionOf(method: string, pathname: string, body: Buffer | string): string {
  return `${method.toUpperCase()} ${pathname}\n${crypto.createHash('sha256').update(body).digest('hex')}`;
}

interface Open {
  deviceId: string;
  purpose: 'register' | 'assert' | 'vouch';
  /** For an assertion or a vouch: the request it allows. */
  action: string;
  expiresAt: number;
  /** A vouch's challenge: true once the trusted computer's own screen vouched for it over the link (issue #313). */
  vouched?: boolean;
}

export class Passkeys {
  private readonly devices: Devices;
  private readonly rpID: string;
  private readonly origin: string;
  private readonly now: () => number;
  private readonly open = new Map<string, Open>();
  /**
   * Enrol codes (issue #241): a one-time code that lets this Ledung's own page, opened at the top level in a window of
   * its own, set up the passkey of the device that asked for it. Safari can't create a passkey inside a frame on
   * another site (it can use one there), so a device paired in a frame sets its passkey up this way. In memory only.
   */
  private readonly enrolCodes = new Map<string, { deviceId: string; expiresAt: number }>();
  /**
   * Sign codes (#463): a one-time code that lets the default browser sign one waiting request for the device that asked
   * for it, which can't show a passkey prompt itself (the desktop app on a Mac, #427). Bound to that device and that
   * request's challenge, and gone with it after two minutes. The browser's answer waits here until the device picks it
   * up and sends its request with it, where the passkey check runs in full (verify). In memory only.
   */
  private readonly signCodes = new Map<string, { deviceId: string; challenge: string; what: string; expiresAt: number; answer?: string; failed?: string }>();
  /** Each device's unlock, until when. In memory only: a restart locks every device again (fails closed). */
  private readonly unlocked = new Map<string, number>();

  /** The pages that may frame this Ledung (issue #241, framingPages): a check signed in such a frame names one of them. */
  private framers: string[];

  /** The pages that may frame this Ledung now: a link made or dropped changes them at once (issue #273). */
  setFramers(framers: string[]): void {
    this.framers = framers;
  }

  constructor(devices: Devices, publicName: string, now: () => number = Date.now, framers: string[] = []) {
    this.devices = devices;
    this.framers = framers;
    this.rpID = publicName;
    // Only the HTTPS page on the public name: never http, never another name.
    this.origin = `https://${publicName}`;
    this.now = now;
  }

  /** A new enrol code for this device, while it may still set up its passkey; any earlier one of it stops working. */
  enrolCode(device: Device): { code: string; expiresAt: number } {
    if (!this.devices.mayRegisterPasskey(device)) {
      throw new PasskeyError(device.credentialId ? 'This device already has its passkey.' : 'A passkey can only be set up in the 10 minutes after pairing. Pair this device again from Settings on the computer.');
    }
    const at = this.now();
    for (const [c, e] of this.enrolCodes) if (e.deviceId === device.id || e.expiresAt <= at) this.enrolCodes.delete(c);
    const code = crypto.randomBytes(24).toString('base64url');
    const expiresAt = at + ENROL_MS;
    this.enrolCodes.set(code, { deviceId: device.id, expiresAt });
    return { code, expiresAt };
  }

  /** The device an enrol code is for, while it is open; null otherwise. `use`: the code is used up. */
  enrolDevice(code: unknown, use = false): Device | null {
    if (typeof code !== 'string' || !code) return null;
    const e = this.enrolCodes.get(code);
    if (!e || e.expiresAt <= this.now()) {
      this.enrolCodes.delete(code as string);
      return null;
    }
    if (use) this.enrolCodes.delete(code);
    return this.devices.get(e.deviceId);
  }

  async registrationOptions(device: Device): Promise<PublicKeyCredentialCreationOptionsJSON> {
    if (!this.devices.mayRegisterPasskey(device)) {
      throw new PasskeyError(device.credentialId ? 'This device already has its passkey.' : 'A passkey can only be set up in the 10 minutes after pairing. Pair this device again from Settings on the computer.');
    }
    const challenge = this.issue(device.id, 'register', '');
    return generateRegistrationOptions({
      rpName: 'Ledung', rpID: this.rpID, userName: device.name, userID: new TextEncoder().encode(device.id), challenge,
      timeout: CHALLENGE_MS, attestationType: 'none', supportedAlgorithmIDs: ALGORITHMS,
      authenticatorSelection: { residentKey: 'discouraged', userVerification: 'required' },
    });
  }

  async register(device: Device, response: unknown): Promise<void> {
    const res = response as RegistrationResponseJSON;
    const challenge = challengeIn(res);
    this.take(challenge, device.id, 'register', '');
    this.checkFrame(res);
    if (!this.devices.mayRegisterPasskey(device)) throw new PasskeyError('This device can no longer set up a passkey.');
    const verified = await verifyRegistrationResponse({
      response: res, expectedChallenge: challenge, expectedOrigin: this.origin, expectedRPID: this.rpID,
      requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: ALGORITHMS,
    }).catch((e: Error) => { throw new PasskeyError(`The passkey was not accepted: ${e.message}`); });
    if (!verified.verified) throw new PasskeyError('The passkey was not accepted.');
    const { credential } = verified.registrationInfo;
    if (!this.devices.setPasskey(device.id, credential.id, credential.publicKey, credential.counter)) throw new PasskeyError('This device already has its passkey.');
  }

  /** A challenge for one request by this device. */
  async challenge(device: Device, action: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    if (!device.credentialId) throw new PasskeyError('This device has no passkey; it can only do this on the computer.');
    const challenge = this.issue(device.id, 'assert', action);
    return generateAuthenticationOptions({
      rpID: this.rpID, challenge, timeout: CHALLENGE_MS, userVerification: 'required',
      allowCredentials: [{ id: device.credentialId }],
    });
  }

  /**
   * A challenge for one request by a trusted computer's frame (issue #313): its own screen vouches for it over the link
   * instead of a passkey signing it. Bound to the request and the device, used once, within two minutes, as a passkey's.
   * The caller checks the device is that frame; it needs no passkey of its own.
   */
  vouchChallenge(device: Device, action: string): string {
    return Buffer.from(this.issue(device.id, 'vouch', action)).toString('base64url');
  }

  /**
   * The trusted computer's own screen vouches for an open challenge (/link/vouch): `accepts` says whether the device it
   * was issued to is that computer's frame here. Throws when the challenge is unknown, used, expired or not a vouch's.
   */
  vouch(challenge: unknown, accepts: (device: Device) => boolean): void {
    const o = typeof challenge === 'string' ? this.open.get(challenge) : undefined;
    if (!o || o.purpose !== 'vouch' || o.vouched || o.expiresAt <= this.now()) throw new PasskeyError('That check expired or was already used; try again.');
    const device = this.devices.get(o.deviceId);
    if (!device || !accepts(device)) throw new PasskeyError('That check is not for a frame of this computer.');
    o.vouched = true;
  }

  /** Throws unless `header` is a challenge issued to this device for exactly `action` and vouched for; uses it up. */
  verifyVouch(device: Device, action: string, header: unknown): void {
    if (typeof header !== 'string' || !header || header.length > 100) throw new PasskeyError(PASSKEY_NEEDED);
    const vouched = this.open.get(header)?.vouched === true;
    this.take(header, device.id, 'vouch', action);
    if (!vouched) throw new PasskeyError('That check was not vouched for by the trusted computer.');
  }

  /** Throws unless `header` holds this device's passkey signing a challenge issued for exactly `action`. */
  async verify(device: Device, action: string, header: unknown): Promise<void> {
    if (!device.credentialId || !device.publicKey) throw new PasskeyError('This device has no passkey; it can only do this on the computer.');
    if (typeof header !== 'string' || !header || header.length > 16 * 1024) throw new PasskeyError(PASSKEY_NEEDED);
    let res: AuthenticationResponseJSON;
    try {
      res = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    } catch {
      throw new PasskeyError('The passkey answer could not be read.');
    }
    const challenge = challengeIn(res);
    // Used up here, before the signature is checked: a failed try can't be retried with the same challenge.
    this.take(challenge, device.id, 'assert', action);
    this.checkFrame(res);
    if (res.id !== device.credentialId || res.rawId !== device.credentialId) throw new PasskeyError("That is not this device's passkey.");
    const verified = await verifyAuthenticationResponse({
      response: res, expectedChallenge: challenge, expectedOrigin: this.origin, expectedRPID: this.rpID,
      // Signed in a frame (#241): the page around it, checked by checkFrame and again here.
      ...(this.framers.length ? { expectedTopOrigin: this.framers } : {}),
      credential: { id: device.credentialId, publicKey: device.publicKey, counter: device.counter },
      requireUserVerification: true,
    }).catch((e: Error) => { throw new PasskeyError(`The passkey was not accepted: ${e.message}`); });
    if (!verified.verified || !verified.authenticationInfo.userVerified) throw new PasskeyError('The passkey was not accepted.');
    this.devices.setCounter(device.id, verified.authenticationInfo.newCounter);
  }

  /**
   * A sign code for one request by this device (#463): a fresh challenge for exactly `action`, which the default
   * browser signs on the sign page. `what` is the request in words, shown there. Lives as long as its challenge.
   */
  signLink(device: Device, action: string, what: string): { code: string; expiresAt: number } {
    if (!device.credentialId) throw new PasskeyError('This device has no passkey; it can only do this on the computer.');
    const challenge = Buffer.from(this.issue(device.id, 'assert', action)).toString('base64url');
    // A code whose challenge is gone (used, run out, or pushed out by MAX_OPEN) goes too: no more codes than challenges.
    for (const [c, s] of this.signCodes) if (!this.open.has(s.challenge)) this.signCodes.delete(c);
    const code = crypto.randomBytes(24).toString('base64url');
    const expiresAt = this.open.get(challenge)!.expiresAt;
    this.signCodes.set(code, { deviceId: device.id, challenge, what, expiresAt });
    return { code, expiresAt };
  }

  /** The sign page's options (#463): the passkey check for the code's challenge, the device's name and what it signs. */
  async signOptions(code: unknown): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; name: string; what: string; terms: SignTerms }> {
    const s = this.signEntry(code);
    const device = this.devices.get(s.deviceId);
    // Works once: after an answer, right or wrong, the link is done.
    if (s.answer !== undefined || s.failed !== undefined || !device?.credentialId) throw new PasskeyError(SIGN_LINK_GONE);
    const options = await generateAuthenticationOptions({
      rpID: this.rpID, challenge: new Uint8Array(Buffer.from(s.challenge, 'base64url')), timeout: Math.max(0, s.expiresAt - this.now()),
      userVerification: 'required', allowCredentials: [{ id: device.credentialId }],
    });
    const terms: SignTerms = {
      logOn: s.what === SIGN_LOG_ON, kind: device.kind, idleDays: Math.round(COMPUTER_IDLE_MS / 86_400_000),
      unlockMinutes: Math.round(UNLOCK_MS / 60_000), linkMinutes: Math.round(CHALLENGE_MS / 60_000),
    };
    return { options, name: device.name, what: s.what, terms };
  }

  /**
   * The browser's answer for a sign code (#463), kept for the device to pick up. Only its challenge and credential are
   * checked here; the signature, the origin and user verification are checked in full when the device sends its
   * request with it (verify), which also uses the challenge up. One answer per code: a wrong one ends the link too.
   */
  signFinish(code: unknown, response: unknown): { name: string } {
    const s = this.signEntry(code);
    if (s.answer !== undefined || s.failed !== undefined) throw new PasskeyError(SIGN_LINK_GONE);
    const device = this.devices.get(s.deviceId);
    try {
      const res = response as AuthenticationResponseJSON;
      if (challengeIn(res) !== s.challenge) throw new PasskeyError('The passkey answer was for another check.');
      if (!device?.credentialId || res.id !== device.credentialId) throw new PasskeyError("That is not this device's passkey.");
      const answer = Buffer.from(JSON.stringify(res)).toString('base64url');
      if (answer.length > 16 * 1024) throw new PasskeyError('The passkey answer could not be read.');
      s.answer = answer;
      return { name: device.name };
    } catch (e) {
      s.failed = e instanceof PasskeyError ? e.message : 'The passkey answer could not be read.';
      throw e instanceof PasskeyError ? e : new PasskeyError(s.failed);
    }
  }

  /**
   * The browser's answer for this device's sign code (#463), once: the header its request then carries; null while the
   * browser has not answered. Only the device the code was made for gets it.
   */
  signAnswer(device: Device, code: unknown): string | null {
    const s = this.signEntry(code);
    if (s.deviceId !== device.id) throw new PasskeyError(SIGN_LINK_FOREIGN);
    if (s.answer === undefined && s.failed === undefined) return null;
    this.signCodes.delete(code as string);
    if (s.failed !== undefined) throw new PasskeyError(s.failed);
    return s.answer!;
  }

  /** An open sign code: known, its challenge still open and fresh; otherwise it is dropped and SIGN_LINK_GONE thrown. */
  private signEntry(code: unknown) {
    const s = typeof code === 'string' ? this.signCodes.get(code) : undefined;
    if (!s || s.expiresAt <= this.now() || !this.open.has(s.challenge)) {
      if (typeof code === 'string') this.signCodes.delete(code);
      throw new PasskeyError(SIGN_LINK_GONE);
    }
    return s;
  }

  /**
   * Unlocks a device for ordinary changes; call only after a passkey check of this request. Returns until when. A phone:
   * 30 minutes, in memory. A computer logs on instead, kept in its row: unlocked until it logs off, is revoked or goes
   * 14 days unused (issue #241; Martin's decision 6 and question 5 on #245), through a restart too.
   */
  unlock(deviceId: string): number {
    if (this.devices.get(deviceId)?.kind === 'computer') {
      this.devices.logOn(deviceId);
      return this.devices.loggedOnUntil(deviceId) ?? this.now();
    }
    const until = this.now() + UNLOCK_MS;
    this.unlocked.set(deviceId, until);
    return until;
  }

  /** Until when the device is unlocked, or null when it is locked. A computer: until when it stays logged on unused. */
  unlockedUntil(deviceId: string): number | null {
    if (this.devices.get(deviceId)?.kind === 'computer') return this.devices.loggedOnUntil(deviceId);
    const until = this.unlocked.get(deviceId);
    if (until === undefined) return null;
    if (until <= this.now()) {
      this.unlocked.delete(deviceId);
      return null;
    }
    return until;
  }

  /** Locks a phone, logs a computer off. */
  lock(deviceId: string): void {
    this.unlocked.delete(deviceId);
    this.devices.logOff(deviceId);
  }

  /**
   * A passkey check made inside a frame (the client data says crossOrigin) counts only when other computers' pages may
   * frame this one, and only from one of them (issue #241). The page around the frame is its topOrigin; Safari leaves
   * that out (the @simplewebauthn source, May 2026), and then frame-ancestors is what limits who framed it
   * (docs/steps/computer-tabs-in-page.md, question 4). The library checks topOrigin only for an assertion, so this
   * covers the passkey's registration too.
   */
  private checkFrame(res: { response?: { clientDataJSON?: unknown } }): void {
    const data = clientData(res);
    if (data.crossOrigin !== true) {
      if (data.topOrigin !== undefined) throw new PasskeyError('The passkey answer could not be read.');
      return;
    }
    if (!this.framers.length) throw new PasskeyError('A passkey check inside another page is not accepted here.');
    if (data.topOrigin !== undefined && !this.framers.includes(String(data.topOrigin))) {
      throw new PasskeyError('A passkey check inside another page is accepted only from your other computers\' pages.');
    }
  }

  /** A new challenge's bytes (the library base64url-encodes them into the options; a string it would encode as text). */
  private issue(deviceId: string, purpose: Open['purpose'], action: string): Uint8Array<ArrayBuffer> {
    const at = this.now();
    for (const [c, o] of this.open) if (o.expiresAt <= at) this.open.delete(c);
    const mine = [...this.open].filter(([, o]) => o.deviceId === deviceId);
    if (mine.length >= MAX_OPEN) this.open.delete(mine[0]![0]);
    const bytes = new Uint8Array(crypto.randomBytes(32));
    this.open.set(Buffer.from(bytes).toString('base64url'), { deviceId, purpose, action, expiresAt: at + CHALLENGE_MS });
    return bytes;
  }

  /** Uses up an open challenge, and throws unless it was issued to this device, for this purpose and action, and is still fresh. */
  private take(challenge: string, deviceId: string, purpose: Open['purpose'], action: string): void {
    const o = this.open.get(challenge);
    this.open.delete(challenge);
    if (!o || o.expiresAt <= this.now()) throw new PasskeyError('The passkey check expired or was already used; try again.');
    if (o.deviceId !== deviceId || o.purpose !== purpose || o.action !== action) throw new PasskeyError('The passkey check was for something else.');
  }
}

/** A browser's client data, parsed. */
function clientData(res: { response?: { clientDataJSON?: unknown } } | null): Record<string, unknown> {
  const data = res?.response?.clientDataJSON;
  if (typeof data !== 'string') throw new PasskeyError('The passkey answer could not be read.');
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* below */ }
  throw new PasskeyError('The passkey answer could not be read.');
}

/** The challenge a browser's answer signed, from its client data. */
function challengeIn(res: { response?: { clientDataJSON?: unknown } } | null): string {
  const challenge = clientData(res).challenge;
  if (typeof challenge === 'string' && challenge) return challenge;
  throw new PasskeyError('The passkey answer could not be read.');
}
