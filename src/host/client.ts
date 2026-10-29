// Ledung's side of a session host: starting one, and a connection to it that the Agent SDK uses as
// if it were the Claude Code process itself (through `spawnClaudeCodeProcess`).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { hostEntry, userDataDir } from '../platform/paths.ts';
import { GRACE_MS, pipePath, type HostRecord, type HostSpec, type LaunchSpec } from './protocol.ts';

export function hostsDir(): string {
  const dir = path.join(userDataDir(), 'hosts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const recordFile = (sessionId: string) => path.join(hostsDir(), `${sessionId}.json`);

/** Hosts Ledung started and that may still be running. */
export function listHostRecords(): HostRecord[] {
  return fs.readdirSync(hostsDir())
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(hostsDir(), f), 'utf8')) as HostRecord];
      } catch {
        return [];
      }
    });
}

/** The secret the session's host wants in #hello (#104); undefined when its record can't be read, and the host refuses the hello. */
export function hostSecret(sessionId: string): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(recordFile(sessionId), 'utf8')) as HostSpec).secret;
  } catch {
    return undefined;
  }
}

export function removeHostRecord(sessionId: string): void {
  fs.rmSync(recordFile(sessionId), { force: true });
}

/** Starts a host for the session, detached so it outlives a Ledung restart. Returns where it listens. */
export function startHost(sessionId: string, launch: LaunchSpec): string {
  const { env, ...rest } = launch;
  const spec: HostSpec = {
    ...rest, sessionId, pipe: pipePath(sessionId), graceMs: GRACE_MS, logFile: path.join(hostsDir(), `${sessionId}.log`),
    secret: crypto.randomBytes(32).toString('hex'),
  };
  const file = recordFile(sessionId);
  const write = (record: HostSpec | HostRecord) => {
    const tmp = `${file}.${process.pid}.tmp`;
    // It holds the host's secret: readable by this user only.
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  write(spec);
  const host = spawn(process.execPath, [hostEntry(), file], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // The host passes this on to Claude Code unchanged.
    env,
  });
  host.unref();
  write({ ...spec, hostPid: host.pid ?? -1, startedAt: Date.now() });
  return spec.pipe;
}

/**
 * Ledung's connection to a session's host: a new host started with `launch`, or (after a restart) the one
 * still running on `attachTo`, from `fromSeq`. Either way it connects with the secret from the host's
 * record (#104).
 */
export function connectHost(
  sessionId: string,
  how: { launch: LaunchSpec } | { attachTo: string; fromSeq: number },
  handlers: ConnectionHandlers,
): HostConnection {
  const pipe = 'attachTo' in how ? how.attachTo : startHost(sessionId, how.launch);
  return new HostConnection(pipe, 'attachTo' in how ? how.fromSeq : 0, handlers, hostSecret(sessionId));
}

/** True if a host answers on the pipe. */
export function hostReachable(pipe: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(pipe);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

export interface ConnectionHandlers {
  /** A numbered line from Claude Code. Return once it is stored; it is then acknowledged to the host. */
  onLine(seq: number, at: number, json: string): void;
  onStderr(text: string): void;
}

/**
 * A connection to a host, shaped like the process the Agent SDK expects. Closing it (the SDK's
 * kill) only disconnects: Claude Code keeps running in the host. Use stop() to end the session.
 */
export class HostConnection extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  /** Set when the host reported that Claude Code exited. */
  exitInfo: { code: number | null; stderr: string } | null = null;
  private socket: net.Socket | null = null;
  private lastSeq: number;
  private readonly handlers: ConnectionHandlers;
  private readonly secret: string | undefined;

  /** secret: the host's, from its record (hostSecret). */
  constructor(pipe: string, fromSeq: number, handlers: ConnectionHandlers, secret?: string) {
    super();
    this.lastSeq = fromSeq;
    this.handlers = handlers;
    this.secret = secret;
    void this.connect(pipe);
  }

  private async connect(pipe: string): Promise<void> {
    // A host that was just started needs a moment before it listens.
    for (let attempt = 0; attempt < 60 && !this.killed; attempt++) {
      const socket = await new Promise<net.Socket | null>((resolve) => {
        const s = net.connect(pipe);
        s.once('connect', () => resolve(s));
        s.once('error', () => resolve(null));
      });
      if (socket) return this.attach(socket);
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!this.killed) this.closed(new Error('The session host could not be reached.'));
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    socket.write(`#hello ${JSON.stringify({ from: this.lastSeq, secret: this.secret })}\n`);
    // What the SDK writes goes to Claude Code. Its end-of-input does not: only stop() ends a session.
    this.stdin.on('data', (chunk) => socket.write(chunk));
    // The reader passes on the socket's errors (EPIPE once a host has closed it, e.g. one that refused the
    // secret, #104); unheard, they would end Ledung. The socket's close ends the connection.
    readline.createInterface({ input: socket }).on('line', (text) => this.onHostLine(text)).on('error', () => {});
    socket.on('close', () => this.closed());
    socket.on('error', () => {});
  }

  private onHostLine(text: string): void {
    if (text.startsWith('#exited ')) {
      this.exitInfo = JSON.parse(text.slice(8));
      return;
    }
    if (text.startsWith('#stderr ')) {
      this.handlers.onStderr(text.slice(8));
      return;
    }
    const tab1 = text.indexOf('\t');
    const tab2 = text.indexOf('\t', tab1 + 1);
    const seq = Number(text.slice(0, tab1));
    const json = text.slice(tab2 + 1);
    // Lines up to lastSeq are already stored; only re-sent waiting requests arrive like that.
    if (seq > this.lastSeq) {
      this.handlers.onLine(seq, Number(text.slice(tab1 + 1, tab2)), json);
      this.lastSeq = seq;
      this.socket?.write(`#ack ${seq}\n`);
    }
    this.stdout.write(json + '\n');
  }

  private closed(error?: Error): void {
    if (this.exitCode !== null) return;
    this.exitCode = this.exitInfo?.code ?? (error ? 1 : 0);
    if (error) this.emit('error', error);
    this.stdout.end();
    this.emit('exit', this.exitCode, null);
  }

  /** Asks the host to stop Claude Code and everything it started. */
  stop(): void {
    this.socket?.write('#stop\n');
  }

  /** Disconnects; Claude Code keeps running in the host (used when Ledung restarts). */
  kill(): boolean {
    this.killed = true;
    this.socket?.destroy();
    return true;
  }
}
