// This Ledung's place on a relay (issues #160, #202, #237): the tunnel and the ACME certificate for one public name,
// started from the config's "remote" block, or from the settings Join with a code saved in the data folder, and
// stopped by Leave this relay, all without a restart.
//
// The config's block wins: while it is there Join and Leave are refused, so the page can never change what the
// config file says (Martin, question #405, default 5). Saved settings live in remoteDir()/remote.json, private to
// this user like the keys next to them, never in the config file or the repository.
//
// Joining makes everything that is this computer's own here, before anything is sent: a fresh tunnel secret, of
// which only the SHA-256 goes to the relay (decision Q398), and the ACME account, whose URL goes along so the CAA
// record can be written at once. The relay answers with the name it gave; the computer is always passthrough
// there, and the saved settings always say "tls": "required" (decision Q396).
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { parseRemote, type LedungConfig, type RemoteConfig } from '../config.ts';
import { acmeAccount, caaResolver, CertificateManager, DIRECTORIES, type CertificateOptions } from '../server/acme.ts';
import type { CertificateStatus, RemoteStatus } from '../shared/protocol.ts';
import { parseJoinCode } from './join-code.ts';
import { hashSecret, makeSecret } from './secret.ts';
import { Tunnel } from './tunnel.ts';

export const SAVED_REMOTE = 'remote.json';
/** The longest the relay's answer to an enrolment may take. */
const ENROL_TIMEOUT_MS = 30_000;
/** The longest making or finding the ACME account may take when joining. */
const ACME_TIMEOUT_MS = 45_000;

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** What the link needs of the server (LedungServer). */
export interface RemoteServer {
  setPublicName(name: string | null, tunnelTls: { dir: string; required: boolean } | null): void;
  tunnelConnection(): Duplex;
  setChallenge(pair: { key: Buffer; cert: Buffer } | null): void;
  loadCertificate(): void;
  setCertificate(status: CertificateStatus): void;
  setRemote(status: RemoteStatus): void;
}

export interface RemoteLinkOptions {
  server: RemoteServer;
  /** remoteDir(). */
  dir: string;
  /** The config's "remote" block; none: only saved settings, if any. */
  configured?: RemoteConfig;
  /** The ACME server Join uses (config "relayJoin"); default Let's Encrypt production. */
  joinAcme?: LedungConfig['relayJoin'];
  /** Tests: a stand-in ACME server and fetch. */
  acmeClient?: CertificateOptions['client'];
  resolveCaa?: (name: string) => Promise<dns.CaaRecord[]>;
  fetch?: typeof fetch;
  /** How long Join waits for the ACME account; default 45 s. */
  acmeTimeoutMs?: number;
  log?: (line: string) => void;
}

/** What Settings shows about where the remote settings come from: the config file, a join, or nothing. */
export type RemoteSource = 'config' | 'joined' | null;

export class RemoteLink {
  private readonly opts: RemoteLinkOptions;
  private readonly log: (line: string) => void;
  private tunnel: Tunnel | null = null;
  private certificates: CertificateManager | null = null;
  private current: RemoteConfig | null = null;
  private joining = false;

  constructor(opts: RemoteLinkOptions) {
    this.opts = opts;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  /** The remote settings in use: the config's, else the saved ones; null: none. A saved file that doesn't parse is reported and ignored. */
  settings(): RemoteConfig | null {
    return this.opts.configured ?? savedRemote(this.opts.dir, this.log);
  }

  source(): RemoteSource {
    if (this.opts.configured) return 'config';
    return this.current ? 'joined' : null;
  }

  /** At start, once Ledung listens: in the background, so a relay that is down never holds it up (#160). */
  start(): void {
    const remote = this.settings();
    if (remote) this.begin(remote);
  }

  /** Settings' Check now while waiting for the CAA record (#202). False: no ACME certificate here. */
  checkNow(): boolean {
    if (!this.certificates) return false;
    this.certificates.checkNow();
    return true;
  }

  /** Ledung is stopping: the tunnel and the certificate's timers go, the saved settings stay. */
  stop(): void {
    this.tunnel?.stop();
    this.certificates?.stop();
    this.tunnel = null;
    this.certificates = null;
  }

  /**
   * Join with a code: a fresh secret and the ACME account here, then the relay enrols this computer with the
   * secret's hash and the account URL, and answers with its name. Saved, then started: no restart.
   */
  async join(code: string): Promise<{ publicName: string; record: string | null }> {
    if (this.opts.configured) throw new Error('This Ledung\'s relay is set in the config file ("remote"); change it there.');
    if (this.current) throw new Error(`This Ledung is already on a relay as ${this.current.publicName}. Leave it first.`);
    if (this.joining) throw new Error('A join is already under way.');
    const { relay, enrol, token } = parseJoinCode(code);
    this.joining = true;
    try {
      const join = this.opts.joinAcme ?? { acme: 'production' as const };
      const directoryUrl = this.directoryOf(join);
      // The same secret and hash as remote-secret (#236): the relay checks it with the same hashSecret.
      const secret = makeSecret();
      const secretSha256 = hashSecret(secret);
      let accountUrl: string;
      try {
        // A time limit: acme-client retries an ACME server it can't reach for minutes, and the page waits on this
        // (loopback, #237).
        accountUrl = (await withTimeout(acmeAccount({ dir: this.opts.dir, directoryUrl, client: this.opts.acmeClient }), this.opts.acmeTimeoutMs ?? ACME_TIMEOUT_MS, 'no answer from the ACME server')).url;
      } catch (e) {
        throw new Error(`The ACME account could not be made, so nothing was sent to the relay: ${(e as Error).message}`);
      }
      const answer = await this.enrol(enrol, { code: token, secretSha256, accountUrl });
      const remote = parseRemote({
        relay, name: answer.name, publicName: answer.host, secret, tls: 'required', acme: join.acme,
        ...(join.acme === 'pebble' ? { pebble: join.pebble ?? {} } : {}),
      });
      writePrivate(this.savedFile(), `${JSON.stringify(remote, null, 2)}\n`);
      this.log(`Remote: joined the relay at ${new URL(relay).host} as ${remote.publicName}.`);
      this.begin(remote);
      return { publicName: remote.publicName, record: this.certificates?.get().record ?? null };
    } finally {
      this.joining = false;
    }
  }

  /**
   * Leave this relay: the tunnel stops, the saved settings are removed and the public name is gone, at once. The
   * ACME account key stays (it is this computer's, and a later join reuses it). Removing the name from the relay is
   * the relay admin's (question #405, default 5).
   */
  leave(): void {
    if (this.opts.configured) throw new Error('This Ledung\'s relay is set in the config file ("remote"); remove it there.');
    if (!this.current) throw new Error('This Ledung is not on a relay.');
    const name = this.current.publicName;
    this.stop();
    this.current = null;
    fs.rmSync(this.savedFile(), { force: true });
    this.opts.server.setPublicName(null, null);
    this.log(`Remote: left the relay; ${name} no longer reaches this Ledung.`);
  }

  private begin(remote: RemoteConfig): void {
    const { server, dir } = this.opts;
    this.current = remote;
    server.setPublicName(remote.publicName, { dir, required: remote.tls === 'required' });
    // Its own certificate by ACME (issue #202): it only reads its files here, and goes to the ACME server once the
    // tunnel connects, since every check comes through it.
    let certificates: CertificateManager | null = null;
    if (remote.acme) {
      certificates = new CertificateManager({
        dir, publicName: remote.publicName, acme: remote.acme,
        directoryUrl: this.directoryOf(remote),
        resolveCaa: this.opts.resolveCaa ?? caaResolver(remote.acme === 'pebble' ? remote.pebble?.dns : undefined),
        client: this.opts.acmeClient,
        challenge: (pair) => server.setChallenge(pair),
        issued: () => server.loadCertificate(),
        // A certificate manager or tunnel left behind by Leave says nothing more.
        onStatus: (status) => this.certificates === certificates && server.setCertificate(status),
      });
      server.setCertificate(certificates.get());
    }
    this.certificates = certificates;
    const tunnel: Tunnel = new Tunnel({ ...remote, connect: () => server.tunnelConnection(), onStatus: (status) => {
      if (this.tunnel !== tunnel) return;
      server.setRemote(status);
      certificates?.setConnected(status.state === 'connected');
      this.log(`Remote: ${status.state}${status.error ? `. ${status.error}` : ''}`);
    } });
    this.tunnel = tunnel;
    server.setRemote(tunnel.status());
    tunnel.start();
  }

  private directoryOf(remote: { acme?: 'pebble' | 'staging' | 'production'; pebble?: { directory?: string } }): string {
    const acme = remote.acme ?? 'production';
    return acme === 'pebble' ? remote.pebble?.directory ?? 'https://localhost:14000/dir' : DIRECTORIES[acme];
  }

  /** POST /enrol on the relay; its answer's name and host, or its refusal in words. */
  private async enrol(url: string, body: { code: string; secretSha256: string; accountUrl: string }): Promise<{ name: string; host: string }> {
    const doFetch = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(ENROL_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`The relay at ${new URL(url).host} could not be reached: ${(e as Error).message}`);
    }
    const answer = await res.json().catch(() => ({})) as { name?: unknown; host?: unknown; error?: unknown };
    if (!res.ok) {
      throw new Error(typeof answer.error === 'string' ? `The relay refused the code: ${answer.error}` : `The relay refused the code (${res.status}).`);
    }
    if (typeof answer.name !== 'string' || typeof answer.host !== 'string') throw new Error('The relay\'s answer has no name.');
    return { name: answer.name, host: answer.host };
  }

  private savedFile(): string {
    return path.join(this.opts.dir, SAVED_REMOTE);
  }
}

/** The settings Join with a code saved in `dir` (remoteDir()); null: none, or a file that can't be used (said in the log). */
export function savedRemote(dir: string, log: (line: string) => void = (line) => console.log(line)): RemoteConfig | null {
  const file = path.join(dir, SAVED_REMOTE);
  try {
    return parseRemote(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log(`Remote: the saved settings in ${file} can't be used: ${(e as Error).message}`);
    return null;
  }
}

/** Written whole and then renamed into place, private to this user (as remoteDir() is). */
function writePrivate(file: string, data: string): void {
  const temp = `${file}.${process.pid}.new`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, file);
}
