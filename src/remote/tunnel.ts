// Ledung's side of the relay (issue #160, docs/steps/relay.md step 2): one outgoing WebSocket to the
// relay, and each stream the relay opens on it handed to this Ledung's own server. Outgoing only, so no
// firewall rule and no admin rights. It never holds up or fails Ledung's start: a relay that is down is
// retried in the background, and the local page works as before.
//
// Each stream goes to the server in this process, marked as come through the relay, so the server treats it
// as a phone on the public name whatever Host it claims (Martin, #160, 13:31, question #219); nothing here
// trusts the relay.
import type { Duplex } from 'node:stream';
import WebSocket from 'ws';
import type { RemoteStatus } from '../shared/protocol.ts';
import { decodeFrame, FRAME, helloMessage, helloVersion, PROTOCOL_VERSION, Streams } from './mux.ts';

export interface TunnelOptions {
  /** The relay, wss://host[/path]; /agent when no path is given. */
  relay: string;
  name: string;
  secret: string;
  /** The public name phones use, shown in Settings. */
  publicName: string;
  /** A new connection to this Ledung for one stream (LedungServer.tunnelConnection). */
  connect: () => Duplex;
  onStatus?: (status: RemoteStatus) => void;
  /** Backoff between attempts, for tests. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Called with each wait before the next attempt, for tests. */
  onRetry?: (delayMs: number) => void;
  /** The spread on each wait, 0 to 1 as Math.random gives; for tests. */
  random?: () => number;
}

/** The header the relay reads the agent's name from (relay/relay.ts). */
const AGENT_NAME_HEADER = 'x-ledung-agent';
/** The relay pings every 30 s; this long without one means the connection is dead even if TCP hasn't noticed. */
const SILENCE_MS = 75_000;
const MAX_FRAME = 1024 * 1024;

/** wss://, or ws:// to this computer. */
export function secureRelay(relay: string): boolean {
  try {
    const url = new URL(relay);
    return url.protocol === 'wss:' || (url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}

/** The URL the client dials: the configured one, with /agent when it names no path. */
export function agentUrl(relay: string): string {
  const url = new URL(relay);
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/agent';
  return url.toString();
}

/**
 * The wait before attempt number `attempt` (0 after a connection worked): min, doubled each time, at most
 * max, then spread by ±25 % so several Ledungs don't come back at the same moment.
 */
export function backoffDelay(attempt: number, min: number, max: number, random: number): number {
  return Math.min(max, min * 2 ** attempt) * (0.75 + random * 0.5);
}

export class Tunnel {
  private readonly opts: TunnelOptions;
  private ws: WebSocket | null = null;
  private streams: Streams | null = null;
  private timer: NodeJS.Timeout | null = null;
  private silence: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopped = false;
  private current: RemoteStatus;

  constructor(opts: TunnelOptions) {
    this.opts = opts;
    this.current = { state: 'connecting', publicName: opts.publicName, error: null };
  }

  status(): RemoteStatus {
    return this.current;
  }

  /** Starts connecting in the background; returns at once. */
  start(): void {
    this.stopped = false;
    // The secret goes in the sign-in, so only over TLS; plain ws:// only to this computer, for tests.
    if (!secureRelay(this.opts.relay)) {
      this.set('reconnecting', 'The relay must be a wss:// address (ws:// only to this computer); not connecting.');
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.silence) clearTimeout(this.silence);
    this.ws?.terminate();
    this.ws = null;
    // The close event no longer reaches this Tunnel (this.ws is cleared), so the streams go here.
    this.streams?.closeAll();
    this.streams = null;
  }

  private set(state: RemoteStatus['state'], error: string | null): void {
    if (this.current.state === state && this.current.error === error) return;
    this.current = { state, publicName: this.opts.publicName, error };
    this.opts.onStatus?.(this.current);
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(agentUrl(this.opts.relay), {
        headers: { [AGENT_NAME_HEADER]: this.opts.name, authorization: `Bearer ${this.opts.secret}` },
        maxPayload: MAX_FRAME,
        handshakeTimeout: 15_000,
      });
    } catch (e) {
      this.retry((e as Error).message);
      return;
    }
    this.ws = ws;
    let failure: string | null = null;
    ws.on('unexpected-response', (_req, res) => {
      failure = res.statusCode === 401 ? 'The relay did not accept this name and secret.'
        : res.statusCode === 429 ? 'The relay is refusing this computer for a while after failed sign-ins.'
        : `The relay answered ${res.statusCode}.`;
      ws.terminate();
    });
    // Signed in; connected once the relay answers the hello (docs/steps/relay.md step 1).
    ws.on('open', () => {
      ws.send(helloMessage());
      this.heard();
    });
    ws.on('ping', () => this.heard());
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      this.heard();
      if (!isBinary) {
        // The relay's hello; other text messages are for later (status) and ignored.
        if (this.streams || helloVersion(data.toString('utf8')) !== PROTOCOL_VERSION) return;
        this.attempt = 0;
        this.streams = new Streams(ws);
        this.set('connected', null);
        return;
      }
      const frame = decodeFrame(data);
      if (!frame || !this.streams) return;
      if (frame.kind === FRAME.open) this.open(frame.id);
      else this.streams.receive(frame.kind, frame.id, frame.payload);
    });
    ws.on('error', (e) => {
      failure ??= e.message ? `Could not reach the relay (${e.message}).` : 'Could not reach the relay.';
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.streams?.closeAll();
      this.streams = null;
      if (this.silence) clearTimeout(this.silence);
      this.retry(failure ?? (reason.length ? reason.toString() : `The connection to the relay closed (${code}).`));
    });
  }

  /** A stream from the relay: a connection to this Ledung's server, marked as come through the relay. */
  private open(id: number): void {
    const streams = this.streams!;
    if (streams.has(id)) return;
    streams.attach(id, this.opts.connect());
  }

  private heard(): void {
    if (this.silence) clearTimeout(this.silence);
    this.silence = setTimeout(() => this.ws?.terminate(), SILENCE_MS);
    this.silence.unref();
  }

  private retry(error: string): void {
    if (this.stopped) return;
    this.set('reconnecting', error);
    const min = this.opts.minDelayMs ?? 1000;
    const max = this.opts.maxDelayMs ?? 60_000;
    // 1, 2, 4 … 60 s.
    const delay = backoffDelay(this.attempt, min, max, (this.opts.random ?? Math.random)());
    this.attempt = Math.min(this.attempt + 1, 16);
    this.opts.onRetry?.(delay);
    this.timer = setTimeout(() => this.connect(), delay);
    this.timer.unref();
  }
}
