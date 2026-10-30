// Ledung's HTTP server: the page, the API, and the live connection that pushes updates to the page.
import type { PaneFolderKey } from '../shared/files-pane.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import tls from 'node:tls';
import path from 'node:path';
import { type Duplex, duplexPair } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { appDir, appVersion, PACKAGED } from '../platform/paths.ts';
import { readRepository, sourceOffer } from './source.ts';
import type { SessionManager } from '../sessions/manager.ts';
import { UserError } from '../sessions/manager.ts';
import type { Store } from '../store/store.ts';
import { AWAY_DEFAULT, AWAY_KINDS, type AwayKind, type PermissionDecision, type PermissionMode, type RemoteStatus, type ServerEvent } from '../shared/protocol.ts';
import { deviceCookieHeader, Guard, readCookies, securityHeaders } from './security.ts';
import { DEVICE_COOKIE, type Device, type DeviceKind, deviceName, Devices, deviceView } from './devices.ts';
import { actionOf, DEVICE_LOCKED, PASSKEY_HEADER, PasskeyError, Passkeys } from './passkeys.ts';
import { linkedPushItem, Push, PushError, type LinkedPushItem } from './push.ts';
import type { UsageQueries } from '../usage/queries.ts';
import { readRunningRelease, type Updater } from '../update/updater.ts';
import { typicalCosts } from '../resources/typical.ts';
import { BoardError } from '../board/types.ts';
import type { ProjectConfig } from '../config.ts';
import type { Overview, Priority, UsageFilter, UsagePeriod } from '../shared/protocol.ts';
import { levelProblem, NO_LOCKDOWN } from '../projects/lockdown.ts';
import { CertificateFiles } from './tunnel-tls.ts';
import { readClientHello } from '../remote/clienthello.ts';
import type { RemoteLink } from '../remote/link.ts';
import { openFolder } from '../platform/open-folder.ts';
import { NONCE } from '../platform/running.ts';
import type { RelayAdmin } from '../remote/admin.ts';
import type { UsagePublisher } from '../usage/publisher.ts';
import type { Shortcuts } from '../platform/shortcuts.ts';
import { LinkError, LinkedComputers } from '../remote/linked.ts';
import { ManagementError, type SettingsPort } from '../sessions/management.ts';
import { waitingCount } from '../shared/waiting.ts';

/** Calls a linked computer may make in a minute (#245). */
const LINK_PER_MINUTE = 60;
/** The largest request body on /link/ (#245): a message is at most a few thousand characters. */
const LINK_MAX_BODY = 16 * 1024;

/**
 * Pairing codes a linked computer may ask for (issue #273, Martin's manager's decision on question #222): one every
 * 10 minutes per computer, as long as a code lives, so a leaked link key can't keep codes coming unseen.
 */
const LINK_PAIR_EVERY_MS = 10 * 60 * 1000;
/** Where the pairings linked computers asked for are kept for Waiting for you (issue #273); the latest few. */
const LINK_PAIRINGS_KEY = 'link-pairings';
const LINK_PAIRINGS_KEPT = 20;
/** When each linked computer last asked for a pairing code, for the 10-minute limit. */
const LINK_PAIR_TIMES_KEY = 'link-pair-times';
/**
 * How often the Waiting-for-you counts are exchanged with each linked computer when nothing changed (issue #273): a
 * change is sent at once, so this only notices a computer that went offline, and catches up one that came back.
 */
const WAITING_POLL_MS = 30_000;
/** A change in this computer's count is sent after this, so a burst of questions is one call. */
const WAITING_PUSH_MS = 1000;

/** Why linking refuses through the public name (#245 step 1: on the computer itself only). */
const LINKED_HERE = 'Computers are linked and unlinked';
import type { CertificateStatus, LinkPairingInfo, NewComputerInfo, SourceOffer } from '../shared/protocol.ts';
import { computerFrames, computerList, editComputer, knownComputers, readComputerEdits, withEdits, type ComputerInfo, type ComputerSetting } from '../shared/computers.ts';

const MAX_BODY = 1024 * 1024;
const NOT_PAIRED = 'This device is not paired with Ledung. Pair it from Settings → Phones in Ledung on the computer.';
/**
 * On the not-paired page through the public name: the pairing code or link typed in. Inside a frame on another
 * computer's page (issue #241) there is no address bar to open the link in, and pairing there must happen in the frame.
 */
const PAIR_CODE_FORM = '<form method="get" action="/pair"><p><label>Pairing code or link<br>'
  + '<input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" style="font-size:1.1em;width:100%"></label></p>'
  + '<p><button style="font-size:1.1em">Next</button></p></form>';
const NO_PASSKEY_LOCKED = 'This device has no passkey, so it can only look from here; make changes on the computer.';
/** Through the public name, the only changes a locked device may send (requireUnlocked). */
const OPEN_WHILE_LOCKED = new Set(['/api/device-unlock', '/api/passkey-challenge', '/api/passkey-options', '/api/passkey', '/api/device-logout', '/api/passkey-enrol-link']);
/** The header the page sends its live connection's key in (#104). */
export const PAGE_KEY_HEADER = 'x-ledung-page';
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ServerOptions {
  port: number;
  token: string;
  store: Store;
  manager: SessionManager;
  /** Folder holding the built page. */
  webRoot?: string;
  /** Called when Simon asks Ledung to restart. */
  onRestart?: () => void;
  /** Open Ledung to the local network: the names it answers to there (this computer's name or addresses). */
  lanNames?: string[];
  /** Where to listen for the local network: one of this computer's addresses, or 0.0.0.0 for all. */
  lanBind?: string;
  /** Requests through the network names need no sign-in. */
  lanOpen?: boolean;
  /** Usage figures (step 5). */
  usage?: UsageQueries;
  /** Settings' Update Ledung (#100). */
  updater?: Updater;
  /** The first-run question and Settings → Shortcuts: a Ledung icon that starts Ledung (issue #415). */
  shortcuts?: Shortcuts;
  /** Settings → Relay: inviting computers to a relay this Ledung is admin of (issue #237). */
  relayAdmin?: RelayAdmin;
  /** Publishing usage to a shared repo, and reading every computer's file there (issue #363). */
  usagePublisher?: UsagePublisher;
  /** The name Ledung answers to through the relay (config remote.publicName, issue #160); none: not reachable from outside. */
  publicName?: string;
  /** The clock for pairing codes, passkey challenges and unlocks; tests move it. Default: Date.now. */
  now?: () => number;
  /**
   * TLS on streams through the relay (issue #201): the folder holding tls.key and tls.crt (remoteDir()), and
   * whether plain streams are closed. None: tunnel streams are plain HTTP only, as before.
   */
  tunnelTls?: { dir: string; required: boolean };
  /** Tests shorten the limits on a tunnel stream (see TUNNEL_LIMITS) and how often Node checks the request ones. */
  limits?: Partial<typeof TUNNEL_LIMITS> & { checkEveryMs?: number };
  /** Settings' Check now while waiting for the CAA record (issue #202); none: no ACME. */
  onCertificateCheck?: () => void;
  /**
   * The computers for the page's tabs, this one among them (config computers, issue #232); none: no tabs. Names and
   * colours changed in the page go over these (issue #240).
   */
  computers?: ComputerInfo[];
  /**
   * The config's computers as listed (issue #241): this Ledung's page may frame the others' pages, and their pages may
   * frame this one through its public name (computerFrames, by whatever public name it has then). None: no frames.
   */
  computerSettings?: ComputerSetting[];
  /** How to reach a linked computer's public name (#245); default: its port 443. Tests and the loopback give their own. */
  linkConnect?: (publicName: string) => tls.TLSSocket;
  /**
   * Push notifications to paired phones (issue #246): the VAPID key pair's file, and in tests the fetch, the push
   * services' hosts and the log. None: no push.
   */
  push?: { keyFile: string; fetch?: typeof fetch; hosts?: readonly string[]; log?: (line: string) => void };
  /** How often Waiting-for-you counts are exchanged with linked computers (issue #273); tests shorten it. */
  waitingPollMs?: number;
  /** Shows a folder in the file manager (Settings' Open folder, issue #414); tests replace it. */
  openFolder?: (folder: string) => void;
}

/** Where the computers' names and colours from the page are kept (issue #240), as the chats' settings are. */
const COMPUTER_EDITS_KEY = 'computer-edits';

/**
 * Every stage of a tunnel stream has a limit, so no stream an unauthenticated caller opens through the relay can hold
 * one of its streams for long (review 201, round 1 and 2). Before the first byte: the relay's own hello limit. The TLS
 * handshake: a phone needs one round trip, so the same. The request head: Node's headersTimeout, as on the plain
 * path. A whole request: Node's requestTimeout, 5 minutes. An idle connection between requests: Node's
 * keepAliveTimeout, kept on TLS connections (on the plain path's in-memory stream setTimeout is a stub, so it does
 * not act there; that predates #201). A live page's WebSocket is meant to stay open.
 */
const TUNNEL_LIMITS = { peekMs: 10_000, handshakeMs: 10_000, headersMs: 60_000, idleMs: 5_000 };
/** The first byte of a TLS handshake record: anything else through the tunnel is plain HTTP. */
const TLS_HANDSHAKE = 0x16;
/** The ALPN protocol of a TLS-ALPN-01 check (RFC 8737). */
const ACME_TLS = 'acme-tls/1';

export class LedungServer {
  private readonly servers: http.Server[] = [];
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Set<WebSocket>();
  /**
   * Each live connection's page key (#104): only Ledung's open page has one; see requirePage. With the
   * device it was opened by through the public name (null: locally), so a key only works where it was given.
   */
  private readonly pageKeys = new Map<WebSocket, { key: string; device: string | null }>();
  private readonly guard: Guard<Device>;
  /** Paired devices and their passkeys (docs/steps/relay.md steps 4 and 5); passkeys only with a public name. */
  readonly devices: Devices;
  /** These three follow the public name, which Join and Leave in Settings change without a restart (issue #237). */
  private passkeys: Passkeys | null = null;
  private publicName: string | null = null;
  private tunnelTls: { dir: string; required: boolean } | null = null;
  /** Requests through the public name whose passkey signature for themselves was checked (requireUnlocked). */
  private readonly signed = new WeakSet<IncomingMessage>();
  private headers: Record<string, string>;
  /** The same for responses through the public name, which the other computers' pages may frame (issue #241). */
  private publicHeaders: Record<string, string> = {};
  /** Who may frame this Ledung's public page and be named as a framed passkey check's page (issue #241). */
  private frames: { sources: string[]; ancestors: string[] } = { sources: [], ancestors: [] };
  /** Responses to requests through the public name: they get publicHeaders. */
  private readonly publicResponses = new WeakSet<ServerResponse>();
  private readonly webRoot: string;
  private readonly opts: ServerOptions;
  /** The tunnel to the relay (issue #160); null: none is configured. */
  private remote: RemoteStatus | null = null;
  /** The certificate for TLS through the tunnel (issue #201); null: no tunnelTls option. */
  private certificate: CertificateFiles | null = null;
  /**
   * Ends TLS on tunnel streams and hands each decrypted connection to the listening plain server; never listens
   * itself. Made with the first usable certificate.
   */
  private tlsServer: tls.Server | null = null;
  /** Whether tlsServer has a certificate now: false once tls.key or tls.crt is gone. */
  private tlsUsable = false;
  /** What is wrong with TLS through the tunnel, for Settings; null: nothing. */
  private tlsProblem: string | null = null;
  /** The ACME certificate's state for Settings (issue #202); null: no ACME. */
  private certificateStatus: CertificateStatus | null = null;
  /**
   * Answers the CA's TLS-ALPN-01 checks (issue #202) with the one-off challenge certificate, only while an order is
   * open; never listens itself. Made with the first challenge.
   */
  private challengeServer: tls.Server | null = null;
  private challengeOpen = false;
  /** Join and Leave in Settings (issue #237); null: not attached (tests that need no relay). */
  private remoteLink: RemoteLink | null = null;
  /** The person's other Ledungs this one is linked with (#245); null without a public name and "tls": "required". */
  private linked: LinkedComputers | null = null;
  /** Push notifications to paired phones (issue #246); null: not set up. */
  readonly push: Push | null;

  constructor(opts: ServerOptions) {
    this.opts = opts;
    this.devices = new Devices(opts.store.database, opts.now);
    // An old computer cookie used after its renewal: two browsers had it, so the device was revoked; its pages close.
    this.devices.onReuse = (device) => {
      console.log(`Device "${device.name}" was removed: a cookie it had replaced was used again, so a copy of it existed.`);
      this.revokeDevice(device.id);
    };
    this.push = opts.push ? new Push({
      db: opts.store.database, keyFile: opts.push.keyFile, fetch: opts.push.fetch, hosts: opts.push.hosts, log: opts.push.log, now: opts.now,
      computer: () => this.computers().find((c) => c.here)?.name ?? this.publicName?.split('.')[0] ?? 'Ledung',
      publicName: () => this.publicName,
      forward: (item) => this.forwardPush(item),
    }) : null;
    this.push?.seed(opts.manager.questions(), opts.store.pendingPermissions());
    this.guard = new Guard<Device>(opts.token, opts.port, opts.lanNames ?? [], opts.lanOpen ?? false);
    this.headers = {};
    this.webRoot = opts.webRoot ?? path.join(appDir(), 'web', 'dist');
    this.setPublicName(opts.publicName ?? null, opts.tunnelTls ?? null);
    opts.manager.setSettings(this.settingsPort());
  }

  /**
   * Settings' page-only actions for managers' tools (issue #263): the very calls the routes below make, without
   * the routes' requireLocal and requirePage. Instead each tool call is a sensitive call that the user allows in
   * Ledung, or that their own words on this computer name (Session.settingsOnWord; Martin's b on question #447).
   * No HTTP route is added or opened. The relay link (remote-join, remote-leave) is not among them.
   */
  private settingsPort(): SettingsPort {
    return {
      relay: () => this.relayAdmin().view(),
      setRelay: (relay) => this.relayAdmin().update({ relay }),
      makeAdminKey: () => this.relayAdmin().makeKey(),
      invite: (owner, name) => this.relayAdmin().invite(owner, name),
      linkCode: () => this.requireLinked().newCode(),
      link: (code, name) => this.requireLinked().join(code, name),
      links: () => ({ problem: this.linkProblem(), links: this.linked?.list() ?? [] }),
      computers: () => this.computers(),
      // Publishing usage (issue #376): the page's switch; usage_publish asks the user before switching on.
      usagePublish: () => this.opts.usagePublisher?.view() ?? null,
      configureUsagePublish: (next) => this.publisher().configure(next),
    };
  }

  /** This computer's display name: its computer tab's, else the first part of its public name. */
  computerName(): string {
    return this.computers().find((c) => c.here)?.name ?? this.publicName?.split('.')[0] ?? 'Ledung';
  }

  /** The usage key of the first linked computer that has one (issue #363); null: none has, or none answered. */
  async linkedUsageKey(): Promise<string | null> {
    for (const link of this.linked?.list() ?? []) {
      const answer = await this.linked!.callLinked(link.id, '/link/usage-key', {}).catch(() => null);
      if (typeof answer?.key === 'string') return answer.key;
    }
    return null;
  }

  private publisher(): UsagePublisher {
    if (!this.opts.usagePublisher) throw new HttpError(404, 'Publishing usage is not available.');
    return this.opts.usagePublisher;
  }

  /** The relay link Settings' Join and Leave go to (issue #237). */
  attachRemote(link: RemoteLink): void {
    this.remoteLink = link;
  }

  /**
   * The name Ledung answers to through the relay, and TLS on its tunnel streams; null: none. Set at start from the
   * config, and again when Settings joins or leaves a relay (issue #237), so the guard, the passkey origin, the CSP
   * and the certificate always name the same public name. Leaving closes the pages opened through the old name.
   */
  setPublicName(name: string | null, tunnelTls: { dir: string; required: boolean } | null): void {
    const publicName = name?.toLowerCase() || null;
    const changed = publicName !== this.publicName;
    this.publicName = publicName;
    this.tunnelTls = publicName ? tunnelTls : null;
    // Linking needs end to end, so a relay that ends TLS itself can never read what linked computers send (#245).
    if (changed || !!this.linked !== !!this.tunnelTls?.required) {
      this.linked = publicName && this.tunnelTls?.required ? new LinkedComputers({
        dir: this.tunnelTls.dir, publicName, connect: this.opts.linkConnect, now: this.opts.now, port: this.opts.port,
        nameFor: (name) => this.computers().find((c) => c.id === name)?.name ?? null,
        onChange: () => this.computersChanged(),
      }) : null;
      this.opts.manager.setLinked(this.linked);
      if (this.servers.length) this.linked?.helloAll();
    }
    this.frames = computerFrames(this.knownComputers(), publicName ?? undefined);
    if (changed) {
      this.passkeys = publicName ? new Passkeys(this.devices, publicName, this.opts.now, this.frames.ancestors) : null;
      this.guard.setRemote(publicName ? { publicName, device: (cookie) => this.devices.byCookie(cookie) } : null);
      // Another name's certificate is no use for this one; the next tunnel stream reads the files again.
      this.tlsServer = null;
      this.tlsUsable = false;
      this.tlsProblem = null;
      for (const [ws, { device }] of this.pageKeys) if (device !== null) ws.close(1008, 'This Ledung left the relay.');
    }
    this.setHeaders();
    this.certificate = this.tunnelTls && publicName ? new CertificateFiles(this.tunnelTls.dir, publicName) : null;
    if (!publicName) {
      this.remote = null;
      this.certificateStatus = null;
      this.challengeOpen = false;
      this.broadcast({ type: 'remote', remote: null });
    } else if (this.servers.length) this.loadCertificate();
  }

  /** The security headers for the page and the public name, with the frames as they are now. */
  private setHeaders(): void {
    const publicName = this.publicName ?? undefined;
    // Boards are chosen per project in the page, so GitHub's pictures are allowed whenever boards are attached.
    const images = this.opts.manager.boards ? ['https://avatars.githubusercontent.com'] : [];
    this.headers = securityHeaders(this.opts.port, this.opts.lanNames ?? [], images, publicName, { sources: this.frames.sources });
    // Only the page through the public name may be framed, and only by the other computers' pages: locally never.
    this.publicHeaders = publicName ? securityHeaders(this.opts.port, this.opts.lanNames ?? [], images, publicName, this.frames) : this.headers;
  }

  /**
   * The config's computers and the linked ones it doesn't list (issue #273): a linked computer gets a tab and may
   * frame this one, as if the config listed it. The config wins on a conflict.
   */
  private knownComputers(): ComputerSetting[] {
    return knownComputers(this.opts.computerSettings ?? [], this.linked?.list() ?? []);
  }

  /**
   * A link was made or dropped, or a linked computer's port changed (issue #273): the tabs, frame-ancestors,
   * frame-src and the passkeys' accepted top pages follow at once, and the open pages get the new tabs.
   */
  private computersChanged(): void {
    this.frames = computerFrames(this.knownComputers(), this.publicName ?? undefined);
    this.passkeys?.setFramers(this.frames.ancestors);
    this.devices.closeCodeUnlessLinked(new Set((this.linked?.list() ?? []).map((l) => l.id)));
    this.setHeaders();
    this.broadcast({ type: 'computers', computers: this.computers() });
    // A new link's count at once, rather than at the next poll.
    if (this.servers.length) this.exchangeWaiting();
  }

  private createServer(): http.Server {
    const checkEvery = this.opts.limits?.checkEveryMs;
    const server = http.createServer({ headersTimeout: this.limit('headersMs'), keepAliveTimeout: this.limit('idleMs'), ...(checkEvery ? { connectionsCheckingInterval: checkEvery } : {}) }, (req, res) => {
      this.handle(req, res).catch((e) => this.fail(res, e));
    });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/ws' || !this.guard.hostAllowed(req) || !this.guard.originAllowed(req) || !this.guard.mayUse(req)) {
        // Ended rather than destroyed, so the refusal gets out through TLS too (issue #201); cut off if it lingers.
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        setTimeout(() => socket.destroy(), 1000).unref();
        return;
      }
      const device = this.guard.deviceOf(req)?.id ?? null;
      const viaPublic = this.guard.isPublic(req);
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onClient(ws, device, viaPublic));
    });
    return server;
  }

  /** Listens on 127.0.0.1, and on the local network address if Ledung is opened to it. */
  async listen(): Promise<void> {
    const bind = this.opts.lanBind;
    // 0.0.0.0 already includes 127.0.0.1; a single network address needs a second listener.
    const addresses = bind === '0.0.0.0' ? ['0.0.0.0'] : bind ? ['127.0.0.1', bind] : ['127.0.0.1'];
    for (const address of addresses) {
      const server = this.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.opts.port, address, () => {
          server.off('error', reject);
          resolve();
        });
      });
      this.servers.push(server);
    }
    // So Settings can say at once that no certificate is there, before a phone tries.
    this.loadCertificate();
    // Tells the linked computers this one's port (issue #273), as it may have changed since they linked.
    this.linked?.helloAll();
    this.waitingPoll = setInterval(() => this.exchangeWaiting(), this.opts.waitingPollMs ?? WAITING_POLL_MS);
    this.waitingPoll.unref();
    this.exchangeWaiting();
  }

  /**
   * A connection for the relay tunnel (issue #160): one end goes to the server in this process, marked so the
   * guard treats it as coming through the public name whatever Host it claims (Martin, 13:31, question #219);
   * the tunnel carries the other end. Never a TCP connection to 127.0.0.1, which would look local.
   *
   * Its first byte says which server it goes to (issue #201, docs/steps/relay-e2e.md 3a): a TLS handshake to the
   * TLS server, which ends the encryption here with the certificate in remoteDir(); anything else to the plain one,
   * from a relay that still ends TLS itself, unless tunnelTls.required closes it.
   */
  tunnelConnection(): Duplex {
    const plain = this.servers[0];
    if (!plain) throw new Error('Ledung is not listening yet.');
    const [ours, theirs] = duplexPair();
    // What http and ws ask of a socket that a stream in memory doesn't have.
    Object.assign(ours, { setTimeout: () => ours, setNoDelay: () => ours, setKeepAlive: () => ours });
    ours.on('error', () => {});
    // One end gone, for whatever reason: so is the other.
    ours.once('close', () => theirs.destroy());
    theirs.once('close', () => ours.destroy());
    this.guard.markTunnel(ours);
    if (!this.certificate) {
      plain.emit('connection', ours);
      return theirs;
    }
    // The peek: the stream waits for its first chunk (for TLS, the whole ClientHello), puts it back, and only then
    // goes to a server (spike #199, 4).
    const silent = setTimeout(() => ours.destroy(), this.limit('peekMs'));
    ours.once('close', () => clearTimeout(silent));
    let head: Buffer | null = null;
    const onData = (chunk: Buffer) => {
      head = head ? Buffer.concat([head, chunk]) : chunk;
      // The CA's TLS-ALPN-01 check is told apart by the ALPN in its ClientHello (issue #202, relay-e2e.md 3a).
      const hello = head[0] === TLS_HANDSHAKE ? readClientHello(head) : null;
      if (hello?.state === 'more') return;
      ours.off('data', onData);
      clearTimeout(silent);
      ours.pause();
      ours.unshift(head);
      if (hello?.state === 'hello' && hello.alpn.includes(ACME_TLS)) this.toChallenge(ours, hello.sni);
      // One the parser refuses goes on as before, and Node's own TLS decides (issue #201).
      else if (hello) this.toTls(ours);
      else if (this.tunnelTls?.required) {
        this.setTlsProblem('A plain connection came through the relay and was closed: "tls" is "required", so the relay must pass encrypted connections through instead of ending TLS itself.');
        ours.destroy();
      } else plain.emit('connection', ours);
      // Paused for the handover: a listener added now doesn't start the flow again by itself.
      if (!ours.destroyed) ours.resume();
    };
    ours.on('data', onData);
    return theirs;
  }

  /**
   * A TLS-ALPN-01 check (RFC 8737): answered with the challenge certificate while an order for the public name is
   * open, closed otherwise; never the real certificate or the page. Every check connection gets it, for the whole
   * order: the CA checks from several at once (spike #199, 6).
   */
  private toChallenge(stream: Duplex, sni: string | null): void {
    if (!this.challengeServer || !this.challengeOpen || sni !== this.publicName) {
      stream.destroy();
      return;
    }
    this.challengeServer.emit('connection', stream);
  }

  /** The challenge certificate to answer acme-tls/1 with while an order is open (issue #202); null: none open. */
  setChallenge(pair: { key: Buffer; cert: Buffer } | null): void {
    this.challengeOpen = !!pair;
    if (!pair) return;
    if (this.challengeServer) {
      this.challengeServer.setSecureContext(pair);
      return;
    }
    const server = tls.createServer({ ...pair, ALPNProtocols: [ACME_TLS], handshakeTimeout: this.limit('handshakeMs') });
    // The handshake is the answer; nothing is read or sent after it.
    server.on('secureConnection', (socket) => socket.end());
    server.on('tlsClientError', (_e, socket) => socket.destroy());
    this.challengeServer = server;
  }

  /** The ACME certificate's state changed (issue #202): kept with the tunnel's and sent to open pages. */
  setCertificate(status: CertificateStatus): void {
    this.certificateStatus = status;
    if (this.remote) this.setRemote(this.remote);
  }

  /** A tunnel stream that starts a TLS handshake: to the TLS server, or closed while there is no certificate. */
  private toTls(stream: Duplex): void {
    this.loadCertificate();
    if (!this.tlsServer || !this.tlsUsable) {
      stream.destroy();
      return;
    }
    this.tlsServer.emit('connection', stream);
  }

  /** Reads tls.key and tls.crt again if they changed; a new certificate is used from the next connection on. */
  loadCertificate(): void {
    const found = this.certificate?.check();
    if (!found || found.state === 'unchanged') return;
    if (found.state === 'missing') {
      this.tlsUsable = false;
      this.setTlsProblem(found.problem);
      return;
    }
    // An unusable new pair (half written, or for another name) keeps the last good one in use.
    if (found.state === 'invalid') {
      this.setTlsProblem(found.problem);
      return;
    }
    const context = { key: found.files.key, cert: found.files.cert };
    if (this.tlsServer) {
      // Only key and certificate: ALPN stays as the server was made (spike #199, finding on setSecureContext).
      this.tlsServer.setSecureContext(context);
    } else {
      // HTTP/1.1 only over the tunnel, as before (relay-e2e.md 3a).
      const server = tls.createServer({ ...context, ALPNProtocols: ['http/1.1'], handshakeTimeout: this.limit('handshakeMs') });
      server.on('secureConnection', (socket) => {
        // Behind TLS, req.socket is the TLSSocket and not the marked stream under it: mark it too, before any
        // request on it is read (review finding 4a of PR #198, proven by spike #199).
        this.guard.markTunnel(socket);
        // To the listening plain server, whose request-head and request limits only a listening server keeps
        // (review 201, finding 1: a server that never listens let a dribbled head hold a stream forever).
        const plain = this.servers[0];
        if (plain) plain.emit('connection', socket);
        else socket.destroy();
      });
      // A failed or timed-out handshake: a tls.Server only reports it and leaves the stream open, unlike an
      // https.Server (review 201, round 2), so it is closed here.
      server.on('tlsClientError', (_e, socket) => socket.destroy());
      this.tlsServer = server;
    }
    this.tlsUsable = true;
    this.setTlsProblem(null);
  }

  private limit(name: keyof typeof TUNNEL_LIMITS): number {
    return this.opts.limits?.[name] ?? TUNNEL_LIMITS[name];
  }

  private setTlsProblem(problem: string | null): void {
    if (problem === this.tlsProblem) return;
    this.tlsProblem = problem;
    if (problem) console.log(`Remote: ${problem}`);
    if (this.remote) this.setRemote(this.remote);
  }

  close(): Promise<void> {
    if (this.waitingPoll) clearInterval(this.waitingPoll);
    if (this.waitingPush) clearTimeout(this.waitingPush);
    for (const ws of this.clients) ws.close(1001, 'Ledung is shutting down.');
    return Promise.all(this.servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))).then(() => {});
  }

  broadcast(event: ServerEvent): void {
    this.push?.notice(event);
    if (event.type === 'question' || event.type === 'permission') this.waitingChanged();
    const data = JSON.stringify(event);
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  /** The relay admin's Approve cards changed (issue #237): to the pages open on this computer only, as in hello. */
  sendNewComputers(computers: NewComputerInfo[]): void {
    this.waitingChanged();
    const data = JSON.stringify({ type: 'newComputers', computers } satisfies ServerEvent);
    for (const [ws, { device }] of this.pageKeys) if (device === null && ws.readyState === ws.OPEN) ws.send(data);
  }

  /** The tunnel's state changed: kept for the next hello and sent to open pages (issue #160). */
  setRemote(remote: RemoteStatus): void {
    const { tls: _, certificate: __, ...tunnel } = remote;
    this.remote = {
      ...tunnel,
      ...(this.tlsProblem ? { tls: this.tlsProblem } : {}),
      ...(this.certificateStatus ? { certificate: this.certificateStatus } : {}),
    };
    this.broadcast({ type: 'remote', remote: this.remote });
  }

  private onClient(ws: WebSocket, device: string | null, viaPublic: boolean): void {
    this.clients.add(ws);
    const key = crypto.randomBytes(32).toString('hex');
    this.pageKeys.set(ws, { key, device });
    const gone = () => {
      this.clients.delete(ws);
      this.pageKeys.delete(ws);
    };
    ws.on('close', gone);
    ws.on('error', gone);
    // The page sends nothing over this connection; everything it does goes through the API.
    ws.on('message', () => ws.close(1008, 'Use the API.'));
    // The key only ever goes out here, never in GET state.
    ws.send(JSON.stringify({ ...this.hello(viaPublic), pageKey: key }));
  }

  private sourceCache: SourceOffer | null = null;

  /** Read once: the release and its package.json don't change while Ledung runs. */
  private source(): SourceOffer {
    this.sourceCache ??= sourceOffer({
      repository: readRepository(appDir()),
      packaged: PACKAGED,
      version: appVersion(),
      release: PACKAGED ? null : readRunningRelease(appDir()),
      build: path.basename(appDir()),
    });
    return this.sourceCache;
  }

  /** viaPublic: the page came through the public name, so it draws the remote frame (issue #232). */
  private hello(viaPublic: boolean): ServerEvent {
    const { manager, store } = this.opts;
    return {
      type: 'hello',
      // A release is named by its folder; the npm package's folder never changes, so by its version (#105).
      build: PACKAGED ? `ledung@${appVersion()}` : path.basename(appDir()),
      canRestart: !!this.opts.onRestart,
      source: this.source(),
      userName: manager.userName,
      sessions: manager.sessions(),
      permissions: store.pendingPermissions(),
      questions: manager.questions(),
      projects: manager.projects(),
      limits: store.latestLimits(),
      usageStops: manager.usageStopStates(),
      macros: manager.macros(),
      away: manager.away.current(),
      profiles: manager.profileNames(),
      board: manager.boardStatus(),
      github: manager.githubBudget(),
      config: manager.configStatus(),
      lockdownB: levelProblem({ ...NO_LOCKDOWN, level: 'B' }),
      bangShell: manager.bangShellName(),
      remote: this.remote,
      chats: manager.chats(),
      computers: this.computers(),
      throughPublicName: viaPublic,
      // The Approve cards are this computer's to act on: not sent through the public name (issue #237).
      newComputers: viaPublic ? [] : this.opts.relayAdmin?.newComputers() ?? [],
      // Like the devices they name, managed on this computer only.
      linkPairings: viaPublic ? [] : this.linkPairings(),
    };
  }

  /** The config's computers with the names and colours changed in the page (issue #240). */
  private computers(): ComputerInfo[] {
    const linked = new Set((this.linked?.list() ?? []).map((l) => l.publicName));
    const ids = new Map((this.linked?.list() ?? []).map((l) => [l.publicName, l.id]));
    return withEdits(this.computerTabs(), readComputerEdits(this.opts.store.getMeta(COMPUTER_EDITS_KEY))).map((c) => {
      if (!linked.has(c.id)) return c;
      const waiting = this.waitingThere.get(ids.get(c.id)!);
      return { ...c, linked: true, ...(waiting !== undefined ? { waiting } : {}) };
    });
  }

  /** The tabs before the page's edits: the config's, and with links the linked computers after them (issue #273). */
  private computerTabs(): ComputerInfo[] {
    const known = this.knownComputers();
    if (known.length === (this.opts.computerSettings ?? []).length) return this.opts.computers ?? [];
    // This computer keeps the name its tab had without links.
    return computerList(known, this.publicName ?? undefined, this.opts.computers?.find((c) => c.here)?.name ?? os.hostname());
  }

  /** One computer's name or colour from Settings → Computers, kept across restarts and sent to every open page. */
  private editComputer(body: Record<string, unknown>): ComputerInfo[] {
    const { store } = this.opts;
    let edits;
    try {
      edits = editComputer(readComputerEdits(store.getMeta(COMPUTER_EDITS_KEY)), this.computerTabs(), body);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    store.setMeta(COMPUTER_EDITS_KEY, JSON.stringify(edits));
    const computers = this.computers();
    this.broadcast({ type: 'computers', computers });
    return computers;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.guard.hostAllowed(req)) throw new HttpError(403, 'Unknown host.');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    const remote = this.guard.isPublic(req);
    if (remote) {
      this.publicResponses.add(res);
      // A computer device's cookie is renewed daily, so a copy stops working within a day (question 5 on #245).
      const device = this.guard.deviceOf(req);
      const renewed = device ? this.devices.renewCookie(device) : null;
      if (device && renewed) {
        res.setHeader('Set-Cookie', deviceCookieHeader(renewed, device.partitioned));
        console.log(`Devices: renewed the cookie of "${device.name}"${device.partitioned ? ' (paired in a frame)' : ''}.`);
      } else if (!device && req.method === 'GET' && req.headers['sec-fetch-dest'] === 'iframe') this.noteFrameUnpaired(req);
    }

    // Pairing a device is the one way in through the public name (docs/steps/relay.md step 4).
    // /p/<code> is the short link the QR code carries, in capitals (#194); /pair?code= still shows the same form.
    const short = /^\/p\/([0-9a-z]+)$/i.exec(url.pathname);
    if (url.pathname === '/pair' || short) {
      if (!remote) throw new HttpError(404, 'Not found.');
      if (short && req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      // The code, or the whole link pasted into the not-paired page's field: its last part.
      const given = short ? short[1]! : url.searchParams.get('code')?.trim().split('/').pop() ?? null;
      await this.pair(req, given, res);
      return;
    }

    // The enrol page's calls (issue #241, POST passkey-enrol-link): no cookie, the one-time code is the proof. Only
    // through the public name, and only from its own page at the top level (the Origin check; a frame elsewhere sends
    // its own origin, which is refused).
    if (url.pathname === '/enrol/options' || url.pathname === '/enrol/finish') {
      if (!remote || !this.passkeys) throw new HttpError(404, 'Not found.');
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      if (!this.guard.originAllowed(req)) throw new HttpError(403, 'Requests must come from Ledung\'s own page.');
      const passkeys = this.passkeys;
      const body = await readJson(req);
      const finish = url.pathname === '/enrol/finish';
      const device = passkeys.enrolDevice(body.code, finish);
      if (!device) throw new HttpError(403, 'This passkey link is not valid any more. Make a new one from the device that asked for it.');
      const result = finish
        ? await passkeyCall(async () => {
          await passkeys.register(device, body.response);
          return { name: device.name };
        })
        : await passkeyCall(() => passkeys.registrationOptions(device));
      this.json(res, 200, result);
      return;
    }

    if (url.pathname === '/login') {
      // The install token never signs in through the public name: a leaked link stays useless from outside.
      if (remote) throw new HttpError(403, 'Sign-in links work only on the computer Ledung runs on. Pair this device from Settings there.');
      if (!this.guard.tokenMatches(url.searchParams.get('token'))) throw new HttpError(403, 'This sign-in link is not valid.');
      res.writeHead(302, { ...this.headersFor(res), 'Set-Cookie': this.guard.cookieHeader(), Location: '/' });
      res.end();
      return;
    }

    // The launchers' open-or-start check (issue #415): proof that this Ledung holds the data folder's token, so the
    // launcher sends the token only to it (src/platform/running.ts). No cookie; only from this computer, never
    // through the public name or the local network.
    if (url.pathname === '/running') {
      if (remote || !fromThisComputer(req)) throw new HttpError(404, 'Not found.');
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      const nonce = url.searchParams.get('nonce') ?? '';
      if (!NONCE.test(nonce)) throw new HttpError(400, 'A nonce of 32 hex characters is needed.');
      this.json(res, 200, { proof: this.guard.runningProof(nonce) });
      return;
    }

    if (url.pathname.startsWith('/link/')) {
      await this.linkRoute(req, res, url.pathname, remote);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (!this.guard.mayUse(req)) throw new HttpError(401, remote ? NOT_PAIRED : 'Not signed in. Open Ledung through the link it prints when it starts.');
      if (req.method !== 'GET' && !this.guard.originAllowed(req)) throw new HttpError(403, 'Requests must come from Ledung\'s own page.');
      if (remote && req.method !== 'GET') await this.requireUnlocked(req, url);
      // An image is the one API answer that isn't JSON; errors still are.
      const image = req.method === 'GET' ? /^\/api\/sessions\/([^/]+)\/image$/.exec(url.pathname) : null;
      // A board attachment's image (board attachments): from the board cache, never a project folder.
      const boardImage = req.method === 'GET' && url.pathname === '/api/board-attachment';
      if (image || boardImage) {
        const found = image
          ? this.opts.manager.readImage(decodeURIComponent(image[1]!), url.searchParams.get('path') ?? '', paneFolder(url))
          : this.opts.manager.readBoardImage(url.searchParams.get('file') ?? '');
        res.writeHead(200, { ...this.headersFor(res), 'Content-Type': found.type, 'Content-Length': found.bytes.length });
        res.end(found.bytes);
        return;
      }
      const result = await this.api(req.method ?? 'GET', url, req);
      this.json(res, 200, result ?? { ok: true });
      return;
    }

    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    this.serveStatic(url.pathname, res, this.guard.mayUse(req), remote);
  }

  /**
   * Another of the person's Ledungs (#245, docs/steps/manager-link.md). Only through the tunnel and over TLS that
   * ended here, so never locally and never from a relay that ends TLS itself; only POST with JSON. Linking checks its
   * one-time code; everything else needs a linked computer's key in Authorization, never a cookie, so a browser
   * can't send one by itself, and that key is good for nothing outside /link/.
   */
  private async linkRoute(req: IncomingMessage, res: ServerResponse, route: string, remote: boolean): Promise<void> {
    const linked = this.linked;
    if (!remote || !(req.socket as tls.TLSSocket).encrypted || !linked || req.method !== 'POST') throw new HttpError(404, 'Not found.');
    // The header when there is one; the bytes read when the body comes chunked (review 254, Important 1).
    if (Number(req.headers['content-length'] ?? 0) > LINK_MAX_BODY) throw new HttpError(413, 'Request too large.');
    const body = await readJson(req, LINK_MAX_BODY);
    const from = () => {
      const computer = linked.byKey(req.headers.authorization);
      if (!computer) throw new LinkError(401, 'Not a linked computer.');
      return computer;
    };
    let answer: unknown;
    try {
      switch (route) {
        case '/link/pair':
          answer = await linked.pair(body);
          break;
        case '/link/confirm':
          answer = linked.confirm(req.headers.authorization, body);
          break;
        case '/link/hello':
          answer = { publicName: this.publicName, ...linked.hello(from().id, body) };
          break;
        case '/link/unlink':
          linked.dropped(from().id);
          answer = { ok: true };
          break;
        // The Waiting-for-you counts (issue #273): the caller's for its tab here, this one's back. A number only.
        case '/link/waiting': {
          const computer = from();
          this.linkRate(computer.id);
          this.noteWaiting(computer.id, body.count);
          answer = { count: this.waitingNow() };
          break;
        }
        // A new item there, for the phones subscribed here (issue #451, question #496 a): its kind and tag, checked,
        // never its text. Pushed with that computer's name and a link to its tab; never sent on.
        case '/link/push': {
          const computer = from();
          this.linkRate(computer.id);
          const item = linkedPushItem(body);
          if (!item) throw new HttpError(400, 'Send the kind and the item.');
          this.push?.fromLinked(item, { id: computer.publicName, name: this.computers().find((c) => c.id === computer.publicName)?.name ?? computer.name });
          answer = { ok: true, push: !!this.push };
          break;
        }
        // Pair through the link (issue #273): a pairing code for a browser on the linked computer's own screen.
        case '/link/device-pair':
          answer = this.linkDevicePair(from());
          break;
        // A linked computer's managers (#245 step 2): trusted as this computer's own; the computer is the key's.
        case '/link/managers':
          this.linkRate(from().id);
          answer = { text: this.opts.manager.linkManagers() };
          break;
        // The person's usage key (issue #363), so linked computers label unnamed projects alike. Only to a linked computer.
        case '/link/usage-key':
          this.linkRate(from().id);
          answer = { key: this.opts.usagePublisher?.key() ?? null };
          break;
        case '/link/projects':
          this.linkRate(from().id);
          answer = { text: this.opts.manager.linkProjects() };
          break;
        case '/link/message': {
          const computer = from();
          this.linkRate(computer.id);
          const text = (key: string) => (typeof body[key] === 'string' ? body[key] as string : '');
          if (!text('fromId') || !text('toId') || !text('text')) throw new HttpError(400, 'Send fromId, toId and text.');
          answer = { text: this.opts.manager.linkMessage({ id: computer.id, name: computer.name }, {
            fromId: text('fromId'), fromTitle: text('fromTitle'), fromProject: text('fromProject'), fromLocked: body.fromLocked === true, toId: text('toId'), text: text('text'),
          }) };
          break;
        }
        default:
          throw new HttpError(404, 'Not found.');
      }
    } catch (e) {
      if (e instanceof LinkError) throw new HttpError(e.status, e.message);
      if (e instanceof ManagementError) throw new HttpError(400, e.message);
      throw e;
    }
    this.json(res, 200, answer);
  }

  /**
   * A frame on another computer's page opened this page and no device let it in (issue #286, a frame's pairing lost
   * overnight): whether the browser sent no device cookie or one that is no live device's tells a browser that
   * dropped it from one Ledung no longer knows. Each of the three at most once every 10 minutes, with a count of those
   * held back, so anyone filling one window can't hide the others or make the line go missing (review 288, Minor 1);
   * never the cookie itself.
   */
  private readonly frameUnpaired = new Map<string, { at: number; held: number }>();
  private noteFrameUnpaired(req: IncomingMessage): void {
    const now = this.opts.now?.() ?? Date.now();
    const cookies = readCookies(req, DEVICE_COOKIE);
    const what = !cookies.length ? 'no device cookie'
      : cookies.some((c) => this.devices.cookieState(c) === 'removed') ? 'the cookie of a removed device' : 'a device cookie this Ledung does not know';
    const last = this.frameUnpaired.get(what);
    if (last && now - last.at < 10 * 60_000) {
      last.held++;
      return;
    }
    this.frameUnpaired.set(what, { at: now, held: 0 });
    const more = last?.held ? ` (and ${last.held} more like it since the last such line)` : '';
    console.log(`Devices: a frame on another computer's page opened this page with ${what}, so it shows as not paired${more}.`);
  }

  /** Calls per linked computer in the last minute: past LINK_PER_MINUTE, 429 (manager-link.md, "Loops and floods"). */
  private readonly linkCalls = new Map<string, number[]>();
  private linkRate(id: string): void {
    const now = this.opts.now?.() ?? Date.now();
    const recent = (this.linkCalls.get(id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= LINK_PER_MINUTE) throw new HttpError(429, `More than ${LINK_PER_MINUTE} calls in a minute from that computer; wait a little.`);
    recent.push(now);
    this.linkCalls.set(id, recent);
  }

  /**
   * /link/device-pair (issue #273): a one-time pairing code for a computer, made for the linked computer that asks,
   * at most one per computer every 10 minutes. The device it pairs is read-only until its passkey and log on, which
   * take Touch ID or Windows Hello checked here (#244). Shown in Waiting for you here, and on the device's row.
   */
  private linkDevicePair(computer: { id: string; name: string }): { code: string; expiresAt: number } {
    const now = this.opts.now?.() ?? Date.now();
    // Kept in the database, so a restart of this Ledung doesn't start the count again (review 275, Minor 1).
    let times: Record<string, number> = {};
    try {
      times = JSON.parse(this.opts.store.getMeta(LINK_PAIR_TIMES_KEY) ?? '{}') as Record<string, number>;
    } catch { /* unreadable: as none */ }
    const last = Object.hasOwn(times, computer.id) && typeof times[computer.id] === 'number' ? times[computer.id]! : undefined;
    if (last !== undefined && now - last < LINK_PAIR_EVERY_MS) {
      throw new HttpError(429, `${computer.name} asked for a pairing code less than 10 minutes ago; try again at ${new Date(last + LINK_PAIR_EVERY_MS).toLocaleTimeString()}.`);
    }
    for (const [id, at] of Object.entries(times)) if (now - at >= LINK_PAIR_EVERY_MS) delete times[id];
    this.opts.store.setMeta(LINK_PAIR_TIMES_KEY, JSON.stringify({ ...times, [computer.id]: now }));
    const { code, expiresAt } = this.devices.newPairCode('computer', { link: computer.id, name: computer.name });
    console.log(`Linked computers: ${computer.name} asked for a pairing code for a browser through the link.`);
    this.setLinkPairings([{ id: crypto.randomUUID(), computer: computer.name, at: now, device: null }, ...this.linkPairings()].slice(0, LINK_PAIRINGS_KEPT));
    return { code, expiresAt };
  }

  /**
   * A new item here, to every linked computer for the phones subscribed there (issue #451): one call each, the same
   * keyed link the counts go over; one that is offline misses it, as its phones can't open this computer's tab then.
   */
  private forwardPush(item: LinkedPushItem): void {
    const linked = this.linked;
    if (!linked) return;
    for (const link of linked.list()) {
      linked.callLinked(link.id, '/link/push', { ...item }).catch((e: Error) => console.log(`Push: could not pass a new item to ${link.name} for its phones (${e.message}).`));
    }
  }

  /** The linked computers' Waiting-for-you counts, by link id (issue #273); none: not known yet, or offline. */
  private readonly waitingThere = new Map<string, number>();
  private waitingPoll: NodeJS.Timeout | null = null;
  private waitingPush: NodeJS.Timeout | null = null;
  /** The count last sent to the linked computers, so an unchanged one isn't sent again. */
  private waitingSent: number | null = null;

  /** What waits for the user here, as this computer's page counts it (App: questions, prompts, cards). */
  private waitingNow(): number {
    return waitingCount(this.opts.manager.questions(), this.opts.store.pendingPermissions())
      + (this.opts.relayAdmin?.newComputers().length ?? 0) + this.linkPairings().length;
  }

  /** Something that may change the count happened: sent to the linked computers shortly, if it did change. */
  private waitingChanged(): void {
    if (this.waitingPush || !this.linked || !this.servers.length) return;
    this.waitingPush = setTimeout(() => {
      this.waitingPush = null;
      if (this.waitingNow() !== this.waitingSent) this.exchangeWaiting();
    }, WAITING_PUSH_MS);
    this.waitingPush.unref();
  }

  /** Sends this computer's count to every linked one and keeps theirs; one that doesn't answer loses its badge. */
  private exchangeWaiting(): void {
    const linked = this.linked;
    if (!linked) return;
    const count = this.waitingNow();
    this.waitingSent = count;
    for (const link of linked.list()) {
      linked.callLinked(link.id, '/link/waiting', { count }).then((answer) => this.noteWaiting(link.id, answer.count), () => this.noteWaiting(link.id, undefined));
    }
  }

  /** A linked computer's count, or undefined when it is offline: the open pages get its tab's badge at once. */
  private noteWaiting(id: string, raw: unknown): void {
    const count = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < 1_000_000 ? raw : undefined;
    if (this.waitingThere.get(id) === count) return;
    if (count === undefined) this.waitingThere.delete(id);
    else this.waitingThere.set(id, count);
    this.broadcast({ type: 'computers', computers: this.computers() });
  }

  /** A device paired with a code a linked computer asked for: its pairing in Waiting for you names it. */
  private linkPairingUsed(device: Device): void {
    const pairings = this.linkPairings();
    const open = pairings.find((p) => p.device === null && p.computer === device.pairedVia);
    if (open) open.device = { id: device.id, name: device.name };
    else pairings.unshift({ id: crypto.randomUUID(), computer: device.pairedVia!, at: device.createdAt, device: { id: device.id, name: device.name } });
    this.setLinkPairings(pairings.slice(0, LINK_PAIRINGS_KEPT));
  }

  private linkPairings(): LinkPairingInfo[] {
    try {
      const parsed = JSON.parse(this.opts.store.getMeta(LINK_PAIRINGS_KEY) ?? '[]') as unknown;
      return Array.isArray(parsed) ? parsed as LinkPairingInfo[] : [];
    } catch {
      return [];
    }
  }

  /** Kept, and sent to the pages open on this computer only, as the devices they name are managed only here. */
  private setLinkPairings(pairings: LinkPairingInfo[]): void {
    this.opts.store.setMeta(LINK_PAIRINGS_KEY, JSON.stringify(pairings));
    this.waitingChanged();
    const data = JSON.stringify({ type: 'linkPairings', pairings } satisfies ServerEvent);
    for (const [ws, { device }] of this.pageKeys) if (device === null && ws.readyState === ws.OPEN) ws.send(data);
  }

  /** Why this Ledung can't link with others, or null when it can. */
  private linkProblem(): string | null {
    if (!this.publicName) return 'Linking needs this Ledung on a relay: join one in Settings → Relay, or set "remote" in the config.';
    if (!this.tunnelTls?.required) return 'Linking needs end-to-end encryption through the relay ("tls": "required"), so the relay can never read what linked computers send each other.';
    return null;
  }

  private requireLinked(): LinkedComputers {
    if (!this.linked) throw new HttpError(400, this.linkProblem() ?? 'Linking is not available.');
    return this.linked;
  }

  /**
   * /p/<code> (or /pair?code=): a small form, so a link preview that only fetches the link pairs nothing; its
   * POST to /pair uses the code up, sets the device cookie and goes to the page. The POST's Origin must be the
   * public page's.
   */
  private async pair(req: IncomingMessage, code: string | null, res: ServerResponse): Promise<void> {
    const page = (status: number, body: string) => {
      // same-origin, not the usual no-referrer: under no-referrer a browser sends "Origin: null" on the form's
      // POST (a navigation), which the Origin check rightly refuses, and pairing would never work. Found taking
      // the round-2 screenshots of PR #164 in Chrome.
      res.writeHead(status, { ...this.headersFor(res), 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'same-origin' });
      res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Ledung</title><div style="font-family:sans-serif;max-width:30em;margin:2em auto">${body}</div>`);
    };
    const invalid = '<p>This pairing link is not valid any more. Make a new one in Settings → Phones in Ledung on the computer.</p>';
    if (req.method === 'GET') {
      // codeValid matches the code Ledung made itself (letters and digits), so it is safe to put back in the form.
      if (!this.devices.codeValid(code)) return page(403, invalid);
      // A code a linked computer asked for (issue #273) pairs a browser on that computer: named after it at first.
      const via = this.devices.codeVia(code);
      const name = via ? `Browser on ${via}`.replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 60) : 'Phone';
      return page(200, '<h2>Pair this device with Ledung</h2><form method="post" action="/pair">'
        + `<input type="hidden" name="code" value="${code}">`
        + `<p><label>Name of this device<br><input name="name" value="${name}" maxlength="60" style="font-size:1.1em"></label></p>`
        + '<p><button style="font-size:1.1em">Pair</button></p></form>');
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    if (!this.guard.originAllowed(req)) throw new HttpError(403, 'Requests must come from Ledung\'s own page.');
    if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'Send the form.');
    const form = new URLSearchParams((await readBody(req)).toString('utf8'));
    // Paired inside a frame on another computer's page: a cookie the browser keeps for that frame (issue #241). Only
    // when some page may frame this one; the browser says where the form was posted from.
    const framed = req.headers['sec-fetch-dest'] === 'iframe' && this.frames.ancestors.length > 0;
    const paired = this.devices.pair(form.get('code'), form.get('name'), framed);
    if (!paired) return page(403, invalid);
    if (paired.device.pairedVia !== null) this.linkPairingUsed(paired.device);
    // Straight to Settings, where the passkey is set up in the minutes after pairing.
    res.writeHead(303, { ...this.headersFor(res), 'Set-Cookie': deviceCookieHeader(paired.cookie, framed), Location: '/#/settings' });
    res.end();
  }

  /**
   * Deciding something sensitive needs more than the cookie (#104): the key of a live connection, which
   * only the open page holds and which dies with it. A script that got hold of the sign-in token alone
   * can't allow a sensitive call as the user (brief section 5).
   */
  private async requirePage(req: IncomingMessage, url: URL): Promise<void> {
    const device = this.requireOpenPage(req);
    if (!device) return;
    // Through the public name the page key is not enough (docs/steps/relay.md, threat model): the device's
    // passkey must also sign a challenge issued for exactly this request, its method, path and body (step 5).
    // An unlocked device is not enough either: each of these requests is signed on its own.
    if (!this.signed.has(req)) await this.verifySigned(req, url, device);
  }

  /**
   * The page key alone (#104), with no signature per request: through the public name the device must still be
   * live, and requireUnlocked has already refused it unless unlocked (Martin, 2026-10-18 10:41, issue #192).
   * Returns the device through the public name, null locally.
   */
  private requireOpenPage(req: IncomingMessage): Device | null {
    const remote = this.guard.isPublic(req);
    const device = this.guard.deviceOf(req);
    // Fails closed: through the public name with no live device (revoked since the guard ran) nothing passes.
    if (remote && !device) throw new HttpError(401, NOT_PAIRED);
    if (!this.pageKeyMatches(req, device?.id ?? null)) throw new HttpError(403, 'Only Ledung\'s open page can do this: it can allow a sensitive call.');
    return remote ? device : null;
  }

  /**
   * Through the public name a device cookie alone is read-only: changes need the device unlocked by a passkey
   * check in the last 30 minutes (Martin, 2026-10-17 12:54, review finding 1 of PR #164), or the request
   * signed for itself. Only unlocking and setting up the passkey are open while locked. A signature that
   * comes along is checked here, whatever the route, so a made-up one can't slip past the lock.
   */
  private async requireUnlocked(req: IncomingMessage, url: URL): Promise<void> {
    if (OPEN_WHILE_LOCKED.has(url.pathname)) return;
    const device = this.guard.deviceOf(req);
    if (!device || !this.passkeys) throw new HttpError(401, NOT_PAIRED);
    if (req.headers[PASSKEY_HEADER] !== undefined) return this.verifySigned(req, url, device);
    if (this.passkeys.unlockedUntil(device.id) === null) throw new HttpError(403, device.credentialId ? DEVICE_LOCKED : NO_PASSKEY_LOCKED);
  }

  /** Checks the passkey signature this request carries for exactly itself, once; the request then counts as signed. */
  private async verifySigned(req: IncomingMessage, url: URL, device: Device): Promise<void> {
    if (!this.passkeys) throw new HttpError(403, 'Passkeys are not available.');
    const action = actionOf(req.method ?? '', url.pathname, await readBody(req));
    await passkeyCall(() => this.passkeys!.verify(device, action, req.headers[PASSKEY_HEADER]));
    this.signed.add(req);
  }

  /**
   * Words that reach a manager as the user's own (a typed message, a task, an answer to its question) can
   * allow its merge without a prompt (mergeOnAnswer, decided 2026-10-13), so they need the page too
   * (#104 review, finding F1). Through the public name the 30-minute unlock covers them, with no signature
   * per message (Martin, 2026-10-18 10:41, issue #192).
   */
  private requirePageForManager(req: IncomingMessage, sessionId: string | undefined): void {
    if (sessionId && this.opts.store.getSession(sessionId)?.role === 'manager') this.requireOpenPage(req);
  }

  /** Paired devices are managed only on this computer: a device can't pair others or list them. */
  private requireLocal(req: IncomingMessage, what = 'Devices are managed'): void {
    if (this.guard.isPublic(req)) throw new HttpError(403, `${what} in Settings on the computer Ledung runs on.`);
  }

  /** The device a request through the public name comes from; refused locally, where there is none. */
  private requireDevice(req: IncomingMessage): { device: Device; passkeys: Passkeys } {
    const device = this.guard.deviceOf(req);
    if (!device || !this.passkeys) throw new HttpError(404, 'Only a paired device has this.');
    return { device, passkeys: this.passkeys };
  }

  /**
   * The request carries the key of a live connection opened where it comes from: a local page's key does
   * nothing through the public name, and one device's key does nothing for another (`where`: device id, null locally).
   */
  private pageKeyMatches(req: IncomingMessage, where: string | null): boolean {
    const given = req.headers[PAGE_KEY_HEADER];
    return typeof given === 'string' && [...this.pageKeys.values()]
      .some(({ key, device }) => device === where && key.length === given.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(given)));
  }

  /** Locks a device out: its cookie stops working at once and its open pages are closed. */
  revokeDevice(id: string): boolean {
    const revoked = this.devices.revoke(id);
    this.passkeys?.lock(id);
    this.push?.unsubscribe(id);
    for (const [ws, { device }] of this.pageKeys) if (device === id) ws.close(1008, 'This device was removed from Ledung.');
    return revoked;
  }

  private async api(method: string, url: URL, req: IncomingMessage): Promise<unknown> {
    const { manager, store } = this.opts;
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
    const route = `${method} ${parts.map((p, i) => (i % 2 === 1 ? ':id' : p)).join('/')}`;
    const id = parts[1] ?? '';

    switch (route) {
      case 'GET state':
        return this.hello(this.guard.isPublic(req));
      // Paired devices (docs/steps/relay.md step 4): listed, paired and revoked on this computer only.
      case 'GET devices':
        this.requireLocal(req);
        return { publicName: this.publicName, devices: this.devices.list() };
      case 'POST devices-pair': {
        this.requireLocal(req);
        // A paired device with its passkey can allow sensitive calls, so making one needs the open page (#104):
        // the install token alone must not lead there.
        await this.requirePage(req, url);
        if (!this.publicName) throw new HttpError(400, 'Set "remote" with its "publicName" in the config first.');
        // A phone or a computer (issue #241, decision 6 on #245): chosen here, on this computer, and never through the public name.
        const kind: DeviceKind = (await readJson(req)).kind === 'computer' ? 'computer' : 'phone';
        const { code, expiresAt } = this.devices.newPairCode(kind);
        return { url: `https://${this.publicName}/p/${code}`, expiresAt, kind };
      }
      // Linked computers (#245, docs/steps/manager-link.md step 1): linked and unlinked on this computer only. A link
      // lets the other computer's managers reach this one's, so making and using a code needs the open page (#104).
      case 'GET links':
        this.requireLocal(req, LINKED_HERE);
        return { publicName: this.publicName, problem: this.linkProblem(), links: this.linked?.list() ?? [] };
      case 'POST links-code':
        this.requireLocal(req, LINKED_HERE);
        await this.requirePage(req, url);
        return this.requireLinked().newCode();
      case 'POST links-join': {
        this.requireLocal(req, LINKED_HERE);
        await this.requirePage(req, url);
        const linked = this.requireLinked();
        const body = await readJson(req);
        try {
          return await linked.join(body.code, body.name);
        } catch (e) {
          if (e instanceof LinkError) throw new HttpError(e.status === 502 ? 502 : 400, e.message);
          throw e;
        }
      }
      // Pair through the link (issue #273, Martin's manager's decision on question #222, a): this computer's own page
      // asks a linked computer for a pairing code for the frame it shows. Local and the open page only, so neither a
      // phone nor anything on this computer's public name can start one; the link key never reaches a browser.
      case 'POST link-device-pair': {
        if (this.guard.isPublic(req)) throw new HttpError(403, 'Pairing through the link starts only on the computer Ledung runs on, in its own page.');
        await this.requirePage(req, url);
        const linked = this.requireLinked();
        const body = await readJson(req);
        const computer = linked.list().find((l) => l.publicName === body.id);
        if (!computer) throw new HttpError(400, 'That computer is not linked with this one.');
        let answer: Record<string, unknown>;
        try {
          answer = await linked.callLinked(computer.id, '/link/device-pair', {});
        } catch (e) {
          if (e instanceof LinkError) throw new HttpError(502, e.message);
          throw e;
        }
        // The address is made here, from the linked computer's own public name: only its code comes from its answer.
        if (typeof answer.code !== 'string' || !/^[0-9a-z]{1,64}$/.test(answer.code)) throw new HttpError(502, `${computer.publicName} gave no usable pairing code.`);
        return { url: `https://${computer.publicName}/p/${answer.code}`, expiresAt: answer.expiresAt };
      }
      case 'POST link-pairings/:id/dismiss':
        this.requireLocal(req);
        this.setLinkPairings(this.linkPairings().filter((p) => p.id !== decodeURIComponent(id)));
        return;
      case 'POST links/:id/remove':
        this.requireLocal(req, LINKED_HERE);
        if (!this.requireLinked().remove(decodeURIComponent(id))) throw new HttpError(400, 'No such linked computer.');
        return;
      case 'POST devices/:id/revoke':
        this.requireLocal(req);
        if (!this.revokeDevice(decodeURIComponent(id))) throw new HttpError(400, 'No such device.');
        return;
      // This device and its passkey (step 5); locally there is no device and nothing changes.
      case 'GET device': {
        const device = this.guard.deviceOf(req);
        if (!device) return { remote: false };
        return {
          remote: true, device: deviceView(device), mayAddPasskey: this.devices.mayRegisterPasskey(device),
          unlockedUntil: this.passkeys?.unlockedUntil(device.id) ?? null,
        };
      }
      // Unlocking this device for ordinary changes for 30 minutes: from its open page, signed with its passkey.
      case 'POST device-unlock': {
        const { device, passkeys } = this.requireDevice(req);
        await this.requirePage(req, url);
        return { unlockedUntil: passkeys.unlock(device.id) };
      }
      // Log out (issue #241): a computer is logged off, a phone locked. Open while locked: it only takes rights away.
      case 'POST device-logout': {
        const { device, passkeys } = this.requireDevice(req);
        passkeys.lock(device.id);
        return { unlockedUntil: null };
      }
      case 'POST device-name': {
        const { device } = this.requireDevice(req);
        const body = await readJson(req);
        this.devices.rename(device.id, deviceName(body.name));
        return deviceView(this.devices.get(device.id)!);
      }
      // Push notifications to this phone (issue #246): through the public name only, a device's own subscription.
      // Changes like any other: unlocked (requireUnlocked), and from this device's open page.
      case 'GET push': {
        const { device } = this.requireDevice(req);
        const push = this.requirePush();
        return { publicKey: push.publicKey(), on: push.subscribed(device.id) };
      }
      case 'POST push': {
        const { device } = this.requireDevice(req);
        const push = this.requirePush();
        if (!this.pageKeyMatches(req, device.id)) throw new HttpError(403, 'Only Ledung\'s open page can do this.');
        const body = await readJson(req);
        try {
          push.subscribe(device.id, body.subscription);
        } catch (e) {
          if (e instanceof PushError) throw new HttpError(400, e.message);
          throw e;
        }
        return { on: true };
      }
      case 'POST push-off': {
        const { device } = this.requireDevice(req);
        this.requirePush().unsubscribe(device.id);
        return { on: false };
      }
      // Setting up the passkey: only in the window after pairing, only once, from this device's open page.
      // A one-time link to set up this device's passkey on this Ledung's own page, at the top level (issue #241):
      // Safari can't create a passkey inside a frame on another site. The code goes in the link's fragment, so it
      // reaches no log and no Referer; the page posts it to /enrol/*.
      case 'POST passkey-enrol-link': {
        const { device, passkeys } = this.requireDevice(req);
        if (!this.pageKeyMatches(req, device.id)) throw new HttpError(403, 'Only Ledung\'s open page can do this.');
        const { code, expiresAt } = await passkeyCall(async () => passkeys.enrolCode(device));
        return { url: `https://${this.publicName}/enrol.html#${code}`, expiresAt };
      }
      case 'POST passkey-options': {
        const { device, passkeys } = this.requireDevice(req);
        if (!this.pageKeyMatches(req, device.id)) throw new HttpError(403, 'Only Ledung\'s open page can do this.');
        return passkeyCall(() => passkeys.registrationOptions(device));
      }
      case 'POST passkey': {
        const { device, passkeys } = this.requireDevice(req);
        if (!this.pageKeyMatches(req, device.id)) throw new HttpError(403, 'Only Ledung\'s open page can do this.');
        const body = await readJson(req);
        await passkeyCall(() => passkeys.register(device, body.response));
        return deviceView(this.devices.get(device.id)!);
      }
      // A challenge for one request the page is about to send: its method, path and exact body (requirePage).
      case 'POST passkey-challenge': {
        const { device, passkeys } = this.requireDevice(req);
        const { method, path: target, body: payload } = await readJson(req);
        if (typeof method !== 'string' || method.toUpperCase() === 'GET' || typeof target !== 'string' || !target.startsWith('/api/') || typeof payload !== 'string') {
          throw new HttpError(400, 'Send method, path (under /api/) and body (the exact text that will be sent).');
        }
        return passkeyCall(() => passkeys.challenge(device, actionOf(method, new URL(target, 'http://127.0.0.1').pathname, payload)));
      }
      case 'GET sessions/:id/messages': {
        const before = Number(url.searchParams.get('before')) || undefined;
        const after = Number(url.searchParams.get('after')) || undefined;
        const limit = Number(url.searchParams.get('limit')) || undefined;
        return store.listMessages(id, { beforeId: before, afterId: after, limit });
      }
      case 'GET usage': {
        if (!this.opts.usage) throw new HttpError(404, 'Usage is not available.');
        const p = url.searchParams;
        const period = (['week', '7d', '30d', '90d', 'all'] as UsagePeriod[]).find((x) => x === p.get('period')) ?? 'week';
        const filter: UsageFilter = {
          period,
          project: p.get('project') || undefined, model: p.get('model') || undefined, branch: p.get('branch') || undefined,
          role: p.get('role') || undefined, trigger: p.get('trigger') || undefined, account: p.get('account') || undefined,
        };
        return this.opts.usage.report(filter, manager.sessions(), store.latestLimits());
      }
      case 'GET sessions/:id/usage':
        if (!this.opts.usage) throw new HttpError(404, 'Usage is not available.');
        return this.opts.usage.session(id);
      case 'GET overview': {
        if (!this.opts.usage) throw new HttpError(404, 'Usage is not available.');
        const per = this.opts.usage.perSession();
        const overview: Overview = { todayTokens: this.opts.usage.todayTotal(), sessions: {} };
        for (const s of manager.sessions()) {
          const last = s.status === 'ended' && !per[s.id] ? null : store.lastReply(s.id);
          overview.sessions[s.id] = {
            today: per[s.id]?.today ?? 0, total: per[s.id]?.total ?? 0, costTotal: per[s.id]?.costTotal ?? 0,
            lastReply: last?.text ?? null, lastReplyAt: last?.at ?? null,
          };
        }
        return overview;
      }
      // Projects (projects and accounts, P1). The project's name is the id in the path.
      case 'GET projects':
        return manager.projects();
      case 'POST projects': {
        const body = await readJson(req);
        // A new project's grant, dev ship command or unasked tools let through what reached the user (issue #107).
        if (manager.gateLoosens(null, body)) await this.requirePage(req, url);
        return manager.addProject(projectFrom(body));
      }
      case 'POST projects/:id': {
        const body = await readJson(req);
        // Opening a locked project up is the user's alone, from the open page, like a sensitive call (issue #109).
        // So is loosening the sensitive gate: a pattern removed, a new grant, unasked tools (issue #107).
        if (manager.lockdownOpensUp(decodeURIComponent(id), body) || manager.gateLoosens(decodeURIComponent(id), body)) await this.requirePage(req, url);
        return manager.updateProject(decodeURIComponent(id), projectFrom(body));
      }
      case 'GET accounts':
        return manager.accountsEvent();
      case 'POST accounts': {
        const body = await readJson(req);
        // Ledung takes no sign-in tokens (issue #342): an account is a login folder, signed in with Claude Code's /login.
        if (body.token !== undefined || body.kind === 'token') {
          throw new HttpError(400, "Ledung doesn't take sign-in tokens. Add the account and sign in to it with Claude Code's own /login.");
        }
        return manager.addAccount({
          name: String(body.name ?? ''),
          configDir: typeof body.configDir === 'string' ? body.configDir : undefined,
          containerDir: typeof body.containerDir === 'string' ? body.containerDir : undefined,
        });
      }
      // The accounts for chats and new projects (issue #283): cookie and origin like every change.
      case 'POST account-choices':
        return manager.setAccountChoices(await readJson(req));
      // Check again on the sign-in banner (issue #333): runs Claude Code's own status, no tokens.
      case 'POST signin-check':
        await manager.checkSignIns();
        return manager.accountsEvent();
      // Open folder (issue #414): opens Finder, Explorer or the like on the computer Ledung runs on, so only from
      // there and from its open page, never from a phone through the relay nor from a manager's tools.
      case 'POST accounts/:id/open-folder':
        this.requireLocal(req, 'Folders are opened');
        await this.requirePage(req, url);
        (this.opts.openFolder ?? openFolder)(manager.accountFolder(decodeURIComponent(id)));
        return { ok: true };
      case 'POST accounts/:id/remove':
        // Says where it signed out, and where not because the folder is another login's too (review of #342, I3).
        return await manager.removeAccount(decodeURIComponent(id));
      case 'GET browse':
        return manager.browse(url.searchParams.get('path') || undefined);
      // The skill picker (#300): the user's own skills where a project's sessions run, and Settings' defaults.
      case 'GET skills':
        return manager.skillList(url.searchParams.get('project') || undefined);
      // Settings' session profiles (#298): where each comes from, and a workflow's file that can't be used.
      case 'GET profiles':
        return manager.profilesView();
      // Settings' Claude Code (#341): which program new sessions run, or why none can; the banner follows it.
      case 'GET claude-code':
        return manager.checkClaude();
      // Macros (issue #410): from the page only, so a session cannot put words in the person's chips.
      case 'POST macros':
        await this.requirePage(req, url);
        return manager.setMacros(await readJson(req));
      case 'POST skill-defaults':
        return manager.setSkillDefaults(await readJson(req));
      case 'GET containers':
        return manager.containers();
      case 'GET browse-container':
        return manager.browseContainer(url.searchParams.get('container') ?? '', url.searchParams.get('user') || undefined, url.searchParams.get('path') || undefined);
      case 'GET workflow-check':
        return manager.workflowCheck(url.searchParams.get('path') || undefined, url.searchParams.get('config') || undefined, url.searchParams.get('workflow') || undefined);
      case 'GET projects-folder':
        return { path: manager.projectsFolder };
      case 'POST projects-new': {
        const body = await readJson(req);
        // A task goes to the new project's manager as the user's words (requirePageForManager).
        // Settings that loosen the sensitive gate need the page and, through the public name, a signature (issue #107).
        if (manager.gateLoosens(null, (body.settings ?? {}) as Record<string, unknown>)) await this.requirePage(req, url);
        else if (typeof body.task === 'string' && body.task.trim()) this.requireOpenPage(req);
        return manager.createProject({
          parent: typeof body.parent === 'string' ? body.parent : undefined,
          github: body.github === true,
          task: typeof body.task === 'string' ? body.task : undefined,
          settings: projectFrom((body.settings ?? {}) as Record<string, unknown>),
        });
      }
      // Name colours (issue #83): the manager's and its sessions', from the manager's ⚙ menu.
      case 'POST projects/:id/colours': {
        const body = await readJson(req);
        return manager.setProjectColours(decodeURIComponent(id), { manager: body.manager, sessions: body.sessions });
      }
      // A new name (issue #116): the user's alone, from the open page; no manager tool renames a project.
      case 'POST projects/:id/rename': {
        await this.requirePage(req, url);
        const body = await readJson(req);
        // The other settings come along, so a refused one leaves the name as it was (review-116 m1).
        return manager.renameProject(decodeURIComponent(id), body.name, body.settings ? projectFrom(body.settings as Record<string, unknown>) : undefined);
      }
      // The sidebar order (issue #88): not under projects/:id or sessions/:id, which a name or an id would match.
      case 'POST projects-order': {
        const body = await readJson(req);
        return manager.setProjectOrder(body.names);
      }
      case 'POST sessions-order': {
        const body = await readJson(req);
        manager.setSessionOrder(body.ids);
        return;
      }
      case 'POST projects/:id/remove':
        // Removing a locked project ends its lockdown too (issue #109).
        if (manager.lockdownOpensUp(decodeURIComponent(id), null)) await this.requirePage(req, url);
        return manager.removeProject(decodeURIComponent(id));
      case 'POST projects/:id/manager': {
        // Always to a manager, as the user's words (requirePageForManager).
        this.requireOpenPage(req);
        const body = await readJson(req);
        return manager.messageManager(decodeURIComponent(id), String(body.text ?? ''), !this.guard.isPublic(req));
      }
      // The message boards (docs/steps/message-board.md, "Per project"): the chip and each project's setting
      // (repo, allowlist, channels, front desk) with who has access to its repo. Behind the same checks as every route above.
      case 'GET board':
        return manager.boardStatus();
      // The Board view (read-only): stored threads and posts; it posts nothing and marks nothing read.
      case 'GET board-threads':
        return manager.requireBoards().viewThreads();
      case 'GET board-thread': {
        const repo = url.searchParams.get('repo');
        const thread = url.searchParams.get('id');
        if (!repo || !thread || thread.length > 100) throw new HttpError(400, 'Send repo (owner/name) and id (the thread).');
        return boardCall(async () => manager.requireBoards().viewThread(repo, thread));
      }
      case 'GET board-projects/:id/people':
        return boardCall(() => manager.requireBoards().people(decodeURIComponent(id)));
      // The repo picker (decision 2026-10-14): what the login can reach, who a board repo can be created under,
      // and the create itself, a POST that needs the page's explicit confirm. Only here: no manager tool calls these.
      case 'GET board-projects/:id/repos':
        return boardCall(() => manager.requireBoards().repoChoices(decodeURIComponent(id), url.searchParams.get('refresh') === '1'));
      case 'GET board-owners':
        return boardCall(() => manager.requireBoards().repoOwners());
      case 'POST board-repos': {
        const body = await readJson(req);
        if (typeof body.owner !== 'string' || typeof body.name !== 'string' || body.confirm !== true) {
          throw new HttpError(400, 'Send owner, name and confirm: true (creating a repository on GitHub needs your confirmation).');
        }
        return boardCall(() => manager.requireBoards().createRepo(body.owner as string, body.name as string, true));
      }
      case 'POST board-projects/:id': {
        const body = await readJson(req);
        const { enabled, repo, allow, channels, frontDesk } = body;
        const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
        if (typeof enabled !== 'boolean' || (repo !== null && typeof repo !== 'string') || !strings(allow) || !strings(channels) || typeof frontDesk !== 'boolean') {
          throw new HttpError(400, 'Send enabled (true or false), repo (owner/name or null), allow (a list of logins), channels (a list of #names) and frontDesk (true or false).');
        }
        return boardCall(async () => manager.requireBoards().setProjectSetting(decodeURIComponent(id), {
          enabled, repo: repo as string | null, allow: allow as string[], channels: channels as string[], frontDesk,
        }));
      }
      // Publishing usage to a shared repo (issue #363). Switching on, the key and removing a computer need the open page:
      // each sends something to GitHub or reveals the key.
      case 'GET usage-publish':
        return this.publisher().view();
      case 'POST usage-publish': {
        await this.requirePage(req, url);
        const body = await readJson(req);
        const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
        if (typeof body.enabled !== 'boolean' || (body.repo !== null && typeof body.repo !== 'string')
          || (body.allAccounts !== undefined && typeof body.allAccounts !== 'boolean') || (body.accounts !== undefined && !strings(body.accounts))) {
          throw new HttpError(400, 'Send enabled (true or false), repo (owner/name or null), and optionally allAccounts (true or false) and accounts (a list of account names).');
        }
        return boardCall(() => this.publisher().configure({
          enabled: body.enabled as boolean, repo: body.repo as string | null,
          ...(body.allAccounts !== undefined ? { allAccounts: body.allAccounts as boolean } : {}), ...(body.accounts !== undefined ? { accounts: body.accounts as string[] } : {}),
        }));
      }
      case 'GET usage-publish-repos':
        return boardCall(() => manager.requireBoards().repoChoices('', url.searchParams.get('refresh') === '1'));
      case 'POST usage-key-reveal':
        await this.requirePage(req, url);
        return { key: this.publisher().key() };
      case 'POST usage-key': {
        await this.requirePage(req, url);
        const body = await readJson(req);
        if (body.fromLinked === true) {
          if (!(await this.publisher().takeLinkedKey())) throw new HttpError(400, 'No linked computer has a usage key, or none answered.');
        } else {
          await boardCall(async () => this.publisher().setKey(body.key));
        }
        return this.publisher().view();
      }
      case 'GET usage-shared':
        return this.publisher().shared(url.searchParams.get('fresh') === '1');
      case 'POST usage-shared-remove': {
        await this.requirePage(req, url);
        const body = await readJson(req);
        if (typeof body.id !== 'string' || body.confirm !== true) throw new HttpError(400, 'Send id and confirm: true (this removes a computer\'s usage from the repository).');
        return boardCall(() => this.publisher().removeStale(body.id as string));
      }
      // Machine resources (step 6).
      case 'GET machine':
        return manager.machine();
      // Away mode (issue #35): until HH:MM, allowing merge, dev ship, computer control (#328); again while away changes it; Back ends it.
      case 'POST away': {
        // It lets a manager's sensitive merges and dev ships through (#104).
        await this.requirePage(req, url);
        const body = await readJson(req);
        const allow = Array.isArray(body.allow) ? body.allow.filter((k): k is AwayKind => AWAY_KINDS.includes(k as AwayKind)) : AWAY_DEFAULT;
        return manager.setAway(String(body.until ?? ''), allow);
      }
      case 'DELETE away':
        manager.away.end();
        return;
      // Usage stops (issue #278): from the page only, so a session cannot raise or lift the stop that holds it.
      case 'POST usage-stops': {
        await this.requirePage(req, url);
        const body = await readJson(req);
        const percent = body.percent === null || body.percent === undefined || body.percent === '' ? null : Number(body.percent);
        return manager.setUsageStop(String(body.account ?? ''), String(body.kind ?? ''), percent);
      }
      case 'POST usage-lift': {
        await this.requirePage(req, url);
        const body = await readJson(req);
        return manager.liftUsageStop(String(body.account ?? ''), String(body.kind ?? ''));
      }
      case 'POST limit': {
        const body = await readJson(req);
        manager.setLimit(Number(body.limit));
        return;
      }
      case 'POST sessions/:id/priority': {
        const body = await readJson(req);
        manager.setPriority(id, String(body.priority ?? '') as Priority, null, manager.userName);
        return;
      }
      // A name of the user's own for any session (issue #223): the sign-in and origin, like every change; no tool renames.
      case 'POST sessions/:id/rename': {
        const body = await readJson(req);
        return manager.renameSession(id, body.title);
      }
      case 'POST sessions/:id/pause': {
        const body = await readJson(req);
        manager.setPaused(id, body.paused !== false);
        return;
      }
      case 'POST sessions/:id/cancel-clear':
        manager.cancelClear(id);
        return;
      case 'POST sessions/:id/start-now':
        manager.startNow(id);
        return;
      case 'GET sessions/:id/turns':
        return store.turnResources({ sessionId: id });
      case 'GET typical-costs': {
        const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
        return typicalCosts(store.turnResources({ since: Date.now() - days * 86400000, role: 'session' }));
      }
      case 'GET sessions/:id/file':
        return manager.readFile(id, url.searchParams.get('path') ?? '', paneFolder(url));
      // The Files pane (issue #225, a test feature): read-only, behind the same sign-in and Host check as the file viewer.
      case 'GET sessions/:id/folders':
        return manager.paneFolders(id);
      case 'GET sessions/:id/tree':
        return manager.listFolder(id, paneFolder(url) ?? 'session', url.searchParams.get('path') ?? '');
      case 'GET sessions/:id/changes':
        return manager.changes(id);
      // Line comments are the user's words: to a manager (or answering a manager's review) they need the open page.
      case 'POST sessions/:id/line-comments': {
        this.requirePageForManager(req, manager.lineCommentsTarget(id).to);
        const body = await readJson(req);
        return manager.sendLineComments(id, body);
      }
      // A review's text file (docs/steps/pr-review.md): only one the review names, read-only.
      case 'GET questions/:id/evidence/:id':
        return manager.readEvidenceText(Number(id), /^\d+$/.test(parts[3] ?? '') ? Number(parts[3]) : -1);
      case 'POST sessions': {
        const body = await readJson(req);
        // A manager's first message is the user's words (requirePageForManager).
        if (body.role === 'manager' && typeof body.text === 'string' && body.text.trim()) this.requireOpenPage(req);
        return manager.start(String(body.project ?? ''), typeof body.text === 'string' ? body.text : undefined, {
          role: body.role === 'manager' ? 'manager' : 'session',
          // The page's New session choice; left out: the project's (#20).
          profile: typeof body.profile === 'string' && body.profile ? body.profile : undefined,
          // Typed here: it can name a manager's Settings action (issue #263).
          here: !this.guard.isPublic(req),
        });
      }
      // Chats (issue #211): sessions with no project. Taking a pattern out of their sensitive list is the user's
      // alone, from the open page, like a project's (issue #107); adding one, or starting a chat, needs the cookie.
      case 'GET chats':
        return manager.chats();
      case 'POST chats': {
        const body = await readJson(req);
        if (manager.chatsLoosen(body)) await this.requirePage(req, url);
        return manager.updateChats(body);
      }
      // Their name colour (issue #222), one for all chats: checked like a project's (#83), cookie and origin.
      case 'POST chats-colour': {
        const body = await readJson(req);
        return manager.setChatsColour(body.colour);
      }
      // A computer tab's name and colour (issue #240): cookie and origin like every change; only computer colours.
      case 'POST computers':
        return this.editComputer(await readJson(req));
      case 'POST chats-new': {
        const body = await readJson(req);
        const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
        return manager.startChat({
          folder: text(body.folder), model: text(body.model), profile: text(body.profile), text: text(body.text),
          permissionMode: text(body.permissionMode) as PermissionMode | undefined,
        });
      }
      case 'POST sessions/:id/messages': {
        this.requirePageForManager(req, id);
        const body = await readJson(req);
        // Typed here, not through the public name: it can name a manager's Settings action (issue #263, Martin's b on question #447).
        await manager.send(id, String(body.text ?? ''), !this.guard.isPublic(req));
        return;
      }
      // A "!" command from the message box (issue #212). People only: no tool reaches these routes.
      case 'GET sessions/:id/shell-check':
        return manager.shellCheck(id, url.searchParams.get('command') ?? '');
      case 'POST sessions/:id/shell': {
        // It runs a command on this computer or in a container: the open page, and through the public name an
        // unlocked device and a passkey signature for each command (decision 2 of #212, Martin 2026-10-18 18:09).
        // A signed request alone passes requireUnlocked, so the unlock is checked here as well.
        const device = this.guard.isPublic(req) ? this.guard.deviceOf(req) : null;
        if (device && this.passkeys?.unlockedUntil(device.id) === null) throw new HttpError(403, device.credentialId ? DEVICE_LOCKED : NO_PASSKEY_LOCKED);
        await this.requirePage(req, url);
        const body = await readJson(req);
        await manager.runShell(id, String(body.command ?? ''), body.confirmed === true);
        return;
      }
      case 'POST sessions/:id/shell-stop':
        return manager.stopShell(id);
      case 'POST sessions/:id/permission-mode': {
        const body = await readJson(req);
        await manager.setPermissionMode(id, String(body.mode ?? ''));
        return;
      }
      case 'POST sessions/:id/interrupt':
        return manager.interrupt(id);
      // Its MCP servers, and restarting one it already has (issue #118).
      case 'GET sessions/:id/mcp':
        return manager.mcpServers(id);
      case 'POST sessions/:id/mcp-reconnect': {
        const body = await readJson(req);
        return manager.reconnectMcp(id, String(body.name ?? ''));
      }
      case 'POST sessions/:id/stop':
        return manager.stop(id);
      case 'POST sessions/:id/resume':
        return manager.resume(id);
      case 'POST sessions/:id/archive':
        return manager.archive(id);
      case 'POST sessions/:id/unarchive':
        return manager.unarchive(id);
      case 'POST questions/:id/answer': {
        // An answer to a question about a sensitive request decides that request (issue #51).
        const question = store.getQuestion(Number(id));
        const about = question?.aboutRequest;
        // A sensitive one is signed for itself; else, to a manager, the page key alone (issue #192).
        if (about && store.getPermission(about)?.sensitive) await this.requirePage(req, url);
        else this.requirePageForManager(req, question?.sessionId);
        const body = await readJson(req);
        return manager.answerQuestion(Number(id), String(body.answer ?? ''), !this.guard.isPublic(req));
      }
      case 'POST questions/:id/withdraw':
        manager.withdrawQuestion(Number(id));
        return;
      case 'POST restart':
        if (!this.opts.onRestart) throw new HttpError(404, 'Restarting is not available.');
        // Answer first; the restart closes this server.
        setTimeout(() => this.opts.onRestart?.(), 100);
        return;
      // Shortcuts on this computer's Desktop, Start menu or Applications (issue #415): only from a page on this computer
      // itself, not a phone or another computer on the network, and changes only from the open page.
      case 'GET shortcuts':
        this.requireThisComputer(req);
        return this.shortcuts().view();
      case 'POST shortcuts': {
        this.requireThisComputer(req);
        await this.requirePage(req, url);
        const action = (await readJson(req)).action;
        if (action !== 'add' && action !== 'remove' && action !== 'decline') throw new HttpError(400, 'The action is add, remove or decline.');
        try {
          return await this.shortcuts().act(action);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
      case 'GET update':
        return this.updater().view();
      case 'POST update-check':
        return this.updater().runCheck();
      case 'POST update':
        return this.updater().startUpdate();
      case 'POST certificate-check':
        if (this.opts.onCertificateCheck) this.opts.onCertificateCheck();
        else if (!this.remoteLink?.checkNow()) throw new HttpError(404, 'This Ledung gets no certificate by ACME.');
        return;
      // Join with a code and Leave this relay (issue #237): this computer's alone, from its open page, like pairing.
      case 'GET remote-link':
        this.requireLocal(req);
        return { source: this.remoteLink?.source() ?? null, publicName: this.publicName };
      case 'POST remote-join': {
        this.requireLocal(req);
        await this.requirePage(req, url);
        if (!this.remoteLink) throw new HttpError(404, 'Joining a relay is not available.');
        const { code } = await readJson(req);
        if (typeof code !== 'string' || !code.trim()) throw new HttpError(400, 'Paste the join code.');
        try {
          return await this.remoteLink.join(code);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
      // Settings → Relay on the relay admin's Ledung (issue #237): local only, and every change from the open page.
      // The admin key and the Cloudflare token never leave the data folder: the view carries a hash and a yes/no.
      case 'GET relay-admin':
        this.requireLocal(req);
        return this.relayAdmin().view();
      case 'POST relay-admin': {
        this.requireLocal(req);
        await this.requirePage(req, url);
        const body = await readJson(req);
        return adminCall(() => this.relayAdmin().update({ relay: body.relay, cloudflareToken: body.cloudflareToken }));
      }
      case 'POST relay-admin-key':
        this.requireLocal(req);
        await this.requirePage(req, url);
        return this.relayAdmin().makeKey();
      case 'GET relay-computers':
        this.requireLocal(req);
        return adminCall(() => this.relayAdmin().list());
      case 'POST relay-invite': {
        this.requireLocal(req);
        await this.requirePage(req, url);
        const body = await readJson(req);
        return adminCall(() => this.relayAdmin().invite(body.owner, body.name));
      }
      case 'POST relay-invites/:id/revoke':
        this.requireLocal(req);
        await this.requirePage(req, url);
        return adminCall(() => this.relayAdmin().revokeInvite(decodeURIComponent(id)));
      case 'POST relay-computers/:id/approve':
        this.requireLocal(req);
        await this.requirePage(req, url);
        return adminCall(() => this.relayAdmin().approve(decodeURIComponent(id)));
      case 'POST relay-computers/:id/added':
        this.requireLocal(req);
        await this.requirePage(req, url);
        return adminCall(() => this.relayAdmin().markAdded(decodeURIComponent(id)));
      case 'POST remote-leave':
        this.requireLocal(req);
        await this.requirePage(req, url);
        if (!this.remoteLink) throw new HttpError(404, 'Leaving a relay is not available.');
        try {
          this.remoteLink.leave();
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        return;
      case 'POST permissions/:id': {
        if (store.getPermission(id)?.sensitive) await this.requirePage(req, url);
        const body = await readJson(req);
        const decision: PermissionDecision = {
          behavior: body.behavior === 'allow' ? 'allow' : 'deny',
          // Without it "Allow for this session" was saved and applied as once (#170).
          scope: body.scope === 'session' ? 'session' : 'once',
          message: typeof body.message === 'string' ? body.message : undefined,
          answers: isStringRecord(body.answers) ? body.answers : undefined,
        };
        manager.decide(id, decision);
        return;
      }
      default:
        throw new HttpError(404, 'Unknown API route.');
    }
  }

  private requirePush(): Push {
    if (!this.push) throw new HttpError(404, 'Push notifications are not available.');
    return this.push;
  }

  private relayAdmin(): RelayAdmin {
    if (!this.opts.relayAdmin) throw new HttpError(404, 'Relay admin is not available.');
    return this.opts.relayAdmin;
  }

  private shortcuts(): Shortcuts {
    if (!this.opts.shortcuts) throw new HttpError(404, 'Shortcuts are not available.');
    return this.opts.shortcuts;
  }

  /** A page opened on this computer itself: not through the public name, nor from another computer on the network. */
  private requireThisComputer(req: IncomingMessage): void {
    this.requireLocal(req, 'Shortcuts are made');
    if (!fromThisComputer(req)) throw new HttpError(403, 'Shortcuts are made in Settings on the computer Ledung runs on.');
  }

  private updater(): Updater {
    if (!this.opts.updater) throw new HttpError(404, 'Updating is not available.');
    return this.opts.updater;
  }

  private serveStatic(pathname: string, res: ServerResponse, signedIn: boolean, remote: boolean): void {
    const root = path.resolve(this.webRoot);
    let file = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(root + path.sep) && file !== root) throw new HttpError(404, 'Not found.');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // The page itself is only served to a signed-in browser; its assets are not secret.
      if (!signedIn) {
        res.writeHead(401, { ...this.headersFor(res), 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>Ledung</title><div style="font-family:sans-serif;max-width:30em;margin:2em auto"><p>${remote ? NOT_PAIRED : 'Not signed in. Open Ledung through the link it prints when it starts.'}</p>${remote ? PAIR_CODE_FORM : ''}</div>`);
        return;
      }
      file = path.join(root, 'index.html');
      if (!fs.existsSync(file)) throw new HttpError(500, 'The page has not been built. Run "npm run build".');
    }
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { ...this.headersFor(res), 'Content-Type': type });
    fs.createReadStream(file).pipe(res);
  }

  /** The security headers for this response: through the public name, the other computers' pages may frame it. */
  private headersFor(res: ServerResponse): Record<string, string> {
    return this.publicResponses.has(res) ? this.publicHeaders : this.headers;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { ...this.headersFor(res), 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private fail(res: ServerResponse, e: unknown): void {
    const status = e instanceof HttpError ? e.status : e instanceof UserError ? 400 : 500;
    if (status === 500) console.error(e);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    this.json(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** A request's body, read once: the passkey check hashes the very bytes the route then parses. */
const bodies = new WeakMap<IncomingMessage, Promise<Buffer>>();
/** A request from this computer itself (loopback), not from another one on the local network (issue #415). */
function fromThisComputer(req: IncomingMessage): boolean {
  const from = req.socket.remoteAddress ?? '';
  return from === '::1' || from.startsWith('127.') || from.startsWith('::ffff:127.');
}

function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  let body = bodies.get(req);
  if (!body) {
    body = (async () => {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > limit) throw new HttpError(413, 'Request too large.');
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    })();
    bodies.set(req, body);
  }
  return body;
}

async function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  const raw = await readBody(req, limit);
  try {
    const value = JSON.parse(raw.toString('utf8') || '{}');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'The request body is not a JSON object.');
  }
}

/** A board call for the page: its own errors become a 400 with the reason, a service that can't be reached a 502. */
async function boardCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BoardError) throw new HttpError(e.kind === 'unreachable' || e.kind === 'limited' ? 502 : 400, e.message);
    throw e;
  }
}

/** A passkey step: its refusals become a 403 with the reason. */
async function passkeyCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PasskeyError) throw new HttpError(403, e.message);
    throw e;
  }
}

/** Which of a session's folders a Files pane request means (issue #225); left out, the file viewer's default. */
function paneFolder(url: URL): PaneFolderKey | undefined {
  const f = url.searchParams.get('in');
  return f === 'session' || f === 'project' ? f : undefined;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
}

/** A project's settings from the page; checked by the project store. */
function projectFrom(body: Record<string, unknown>): ProjectConfig {
  return body as unknown as ProjectConfig;
}

/** A relay admin action (issue #237): its failure, the relay's or Cloudflare's refusal in words, is a 400 for the page. */
async function adminCall<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, (e as Error).message);
  }
}
