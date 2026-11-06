// Streams over one WebSocket, shared by the relay (relay/) and Ledung's tunnel client (issue #160,
// docs/steps/relay.md steps 1 and 2). Each phone connection the relay accepts becomes a numbered
// stream over the agent's socket, and its bytes go through untouched in both directions.
//
// The relay's container copies this one file next to its own, so it imports nothing but Node's own
// modules: no 'ws', nothing else from src/.
import type { Duplex } from 'node:stream';

/** Every message on the agent's socket is binary: one byte of kind, four of stream id, then the payload. */
export const FRAME = {
  /** Relay to agent: a new stream; the agent opens a connection to its Ledung. */
  open: 1,
  /** Bytes of the stream, either way. */
  data: 2,
  /** The sender's side ended (a half close); the receiver ends its socket after writing what it has. */
  end: 3,
  /** The stream is gone; the receiver drops its socket at once. */
  reset: 4,
  /** The receiver's socket can't keep up: stop reading the stream until resume. */
  pause: 5,
  resume: 6,
} as const;

/**
 * The link's first message each way is a text hello with the protocol version (docs/steps/relay.md step 1),
 * so status can be added later as more text messages on the same link. Streams are binary; text messages
 * of a type a side doesn't know are ignored.
 */
export const PROTOCOL_VERSION = 1;

export function helloMessage(): string {
  return JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION });
}

/** The version in a hello, or null when the text is not one. */
export function helloVersion(text: string): number | null {
  try {
    const m = JSON.parse(text) as { type?: unknown; version?: unknown };
    return m?.type === 'hello' && typeof m.version === 'number' ? m.version : null;
  } catch {
    return null;
  }
}

const HEADER = 5;
/** Bytes of one data frame at most; larger reads are split, so a frame never exceeds a relay's limit. */
export const MAX_CHUNK = 64 * 1024;
/** Stop reading every stream while this much waits to go out on the agent's socket. */
const SOCKET_HIGH_WATER = 4 * 1024 * 1024;
/**
 * Under a throttle (issue #161), a stream is held once the bytes past exceed the rate by more than this: one second's
 * worth goes through at once, so a short request or message isn't held at all.
 */
const THROTTLE_SLACK_MS = 1000;
/**
 * A peer that keeps sending after it was asked to hold is past this many milliseconds' worth of the rate: its stream
 * is reset. A peer that honours pause never gets near it: what it has in flight is at most its socket's high water,
 * about a minute at 64 KiB/s.
 */
const THROTTLE_MAX_DEBT_MS = 5 * 60_000;

export interface StreamsOptions {
  /** Each stream byte that crosses, either way (issue #161): the relay counts them per owner. Never the bytes themselves. */
  onBytes?: (bytes: number) => void;
}

export function encodeFrame(kind: number, id: number, payload?: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(HEADER + (payload?.length ?? 0));
  frame.writeUInt8(kind, 0);
  frame.writeUInt32BE(id, 1);
  if (payload) payload.copy(frame, HEADER);
  return frame;
}

export function decodeFrame(frame: Buffer): { kind: number; id: number; payload: Buffer } | null {
  if (frame.length < HEADER) return null;
  return { kind: frame.readUInt8(0), id: frame.readUInt32BE(1), payload: frame.subarray(HEADER) };
}

/** The part of a WebSocket the streams need; both ends pass a 'ws' WebSocket. */
export interface FrameSocket {
  send(data: Buffer): void;
  readonly bufferedAmount: number;
}

interface Stream {
  socket: Duplex;
  sentEnd: boolean;
  gotEnd: boolean;
  /** We asked the other side to stop reading this stream. */
  sentPause: boolean;
  /** The other side asked us to stop reading this stream. */
  peerPaused: boolean;
  /** The throttle stopped reading our socket (issue #161). */
  heldIn: boolean;
  /** The throttle asked the other side to stop sending this stream (issue #161). */
  heldOut: boolean;
}

/**
 * The streams of one agent socket. Each stream is a socket on this side: the phone's connection at the
 * relay, a connection handed to Ledung's own server at the agent. Sockets must allow half-open, so one
 * side ending doesn't cut the other side's answer short.
 */
export class Streams {
  private readonly ws: FrameSocket;
  private readonly streams = new Map<number, Stream>();
  private waiting = false;
  private readonly onBytes: ((bytes: number) => void) | undefined;
  /** Bytes a second for all streams together, or null: no throttle (issue #161). */
  private rate: number | null = null;
  /** When the bytes so far have been paid for at the rate. */
  private freeAt = 0;
  private release: NodeJS.Timeout | null = null;

  constructor(ws: FrameSocket, options: StreamsOptions = {}) {
    this.ws = ws;
    this.onBytes = options.onBytes;
  }

  /**
   * Holds every stream together to `bytesPerSecond`, or lets them go at once with null (issue #161): reading our
   * sockets stops, and the other side is asked to pause, with the same pause and resume as backpressure.
   */
  throttle(bytesPerSecond: number | null): void {
    if (bytesPerSecond === this.rate) return;
    this.rate = bytesPerSecond;
    if (bytesPerSecond === null) {
      this.freeAt = 0;
      this.releaseAll();
    }
  }

  get size(): number {
    return this.streams.size;
  }

  has(id: number): boolean {
    return this.streams.has(id);
  }

  /**
   * Whether stream `id`'s socket must stay paused: held by the throttle or by a backed-up agent socket. Their releases
   * resume it, so whoever attached a paused socket resumes it only when this is false (issue #161, round 2: the relay
   * resumed it unconditionally, undoing a hold its first bytes had set, and the upload then ran unthrottled).
   */
  holding(id: number): boolean {
    const stream = this.streams.get(id);
    return !!stream && (stream.heldIn || this.waiting);
  }

  /** Carries a socket as stream `id`; `first` are bytes already read from it (the relay's request head). */
  attach(id: number, socket: Duplex, first?: Buffer): void {
    const stream: Stream = { socket, sentEnd: false, gotEnd: false, sentPause: false, peerPaused: false, heldIn: false, heldOut: false };
    this.streams.set(id, stream);
    if (first?.length) this.sendData(id, first, socket);
    socket.on('data', (chunk: Buffer) => this.sendData(id, chunk, socket));
    socket.on('end', () => {
      if (this.streams.get(id) !== stream || stream.sentEnd) return;
      stream.sentEnd = true;
      this.ws.send(encodeFrame(FRAME.end, id));
    });
    socket.on('drain', () => {
      if (this.streams.get(id) !== stream || !stream.sentPause) return;
      stream.sentPause = false;
      // Still held by the throttle: its release sends the resume.
      if (!stream.heldOut) this.ws.send(encodeFrame(FRAME.resume, id));
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.streams.get(id) !== stream) return;
      this.streams.delete(id);
      // Both sides ended: a clean finish. Anything else is cut short, and the other side is told.
      if (!(stream.sentEnd && stream.gotEnd)) this.ws.send(encodeFrame(FRAME.reset, id));
    });
  }

  /** A frame for an existing stream. False: not a stream frame (open, or unknown kind). */
  receive(kind: number, id: number, payload: Buffer): boolean {
    const stream = this.streams.get(id);
    switch (kind) {
      case FRAME.data:
        if (!stream || stream.gotEnd) return true;
        if (!stream.socket.write(payload) && !stream.sentPause) {
          stream.sentPause = true;
          this.ws.send(encodeFrame(FRAME.pause, id));
        }
        this.charge(id, stream, payload.length, 'out');
        return true;
      case FRAME.end:
        if (stream && !stream.gotEnd) {
          stream.gotEnd = true;
          stream.socket.end();
        }
        return true;
      case FRAME.reset:
        if (stream) {
          this.streams.delete(id);
          stream.socket.destroy();
        }
        return true;
      case FRAME.pause:
        if (stream) {
          stream.peerPaused = true;
          stream.socket.pause();
        }
        return true;
      case FRAME.resume:
        if (stream) {
          stream.peerPaused = false;
          if (!this.waiting && !stream.heldIn) stream.socket.resume();
        }
        return true;
      default:
        return false;
    }
  }

  /** The agent's socket is gone: every stream goes with it. */
  closeAll(): void {
    for (const stream of this.streams.values()) stream.socket.destroy();
    this.streams.clear();
    if (this.release) clearTimeout(this.release);
    this.release = null;
  }

  private sendData(id: number, chunk: Buffer, socket: Duplex): void {
    for (let at = 0; at < chunk.length; at += MAX_CHUNK) this.ws.send(encodeFrame(FRAME.data, id, chunk.subarray(at, at + MAX_CHUNK)));
    if (this.ws.bufferedAmount > SOCKET_HIGH_WATER) {
      socket.pause();
      this.waitForSocket();
    }
    const stream = this.streams.get(id);
    if (stream?.socket === socket) this.charge(id, stream, chunk.length, 'in');
  }

  /**
   * Counts `bytes` of stream `id`, and under a throttle holds it once the bytes so far are ahead of the rate: `in`, our
   * socket's reading stops; `out`, the other side is asked to pause. One timer lets every held stream go together.
   */
  private charge(id: number, stream: Stream, bytes: number, way: 'in' | 'out'): void {
    this.onBytes?.(bytes);
    if (this.rate === null) return;
    const now = Date.now();
    this.freeAt = Math.max(now, this.freeAt) + (bytes * 1000) / this.rate;
    const ahead = this.freeAt - now;
    if (way === 'out' && ahead > THROTTLE_MAX_DEBT_MS && stream.heldOut) {
      // Asked to hold and still sending: the throttle would not hold, so the stream goes.
      this.streams.delete(id);
      stream.socket.destroy();
      this.ws.send(encodeFrame(FRAME.reset, id));
      return;
    }
    if (ahead <= THROTTLE_SLACK_MS) return;
    if (way === 'in' && !stream.heldIn) {
      stream.heldIn = true;
      stream.socket.pause();
    } else if (way === 'out' && !stream.heldOut) {
      stream.heldOut = true;
      if (!stream.sentPause) this.ws.send(encodeFrame(FRAME.pause, id));
    }
    if (!this.release) {
      this.release = setTimeout(() => {
        this.release = null;
        this.releaseAll();
      }, Math.max(0, this.freeAt - THROTTLE_SLACK_MS / 2 - now));
      this.release.unref();
    }
  }

  /** Every stream the throttle holds goes again, unless backpressure holds it too. */
  private releaseAll(): void {
    if (this.release) clearTimeout(this.release);
    this.release = null;
    for (const [id, stream] of this.streams) {
      if (stream.heldIn) {
        stream.heldIn = false;
        if (!stream.peerPaused && !this.waiting) stream.socket.resume();
      }
      if (stream.heldOut) {
        stream.heldOut = false;
        if (!stream.sentPause) this.ws.send(encodeFrame(FRAME.resume, id));
      }
    }
  }

  /** Reading stops while the agent's socket is backed up, and starts again once it has room. */
  private waitForSocket(): void {
    if (this.waiting) return;
    this.waiting = true;
    const check = setInterval(() => {
      if (this.ws.bufferedAmount > SOCKET_HIGH_WATER / 2) return;
      clearInterval(check);
      this.waiting = false;
      for (const stream of this.streams.values()) if (!stream.peerPaused && !stream.heldIn) stream.socket.resume();
    }, 20);
    check.unref();
  }
}
