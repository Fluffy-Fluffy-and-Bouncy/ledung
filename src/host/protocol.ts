// What Ledung and a session host share: how a session is launched and stopped, where the host listens,
// and the line protocol between them.
//
// Host → Ledung, one line each:
//   <seq>\t<ms>\t<json>    a line Claude Code wrote, numbered, with the time the host received it
//   #exited <json>         Claude Code has exited: {"code": number|null, "stderr": string}
//   #stderr <text>         a line Claude Code wrote to stderr
// Ledung → host, one line each:
//   #hello <json>          first line: {"from": seq, "secret": the session's secret}; the host
//                          replays everything after `from`, then re-sends control requests that are
//                          still unanswered. A wrong or missing secret closes the connection (#104)
//   #ack <seq>             Ledung has stored everything up to `seq`; the host may forget it
//   #stop                  stop Claude Code and everything it started, then exit
//   anything else          passed to Claude Code's stdin (always JSON, so never starts with #)
import os from 'node:os';
import path from 'node:path';

/** How the host stops a session's processes; serialisable, because the host runs it. */
export type StopSpec =
  | { kind: 'local' }
  | { kind: 'docker'; container: string; user?: string; tag: string };

/** What a runner hands the host to start Claude Code. */
export interface LaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  stop: StopSpec;
}

/**
 * Everything a host needs; written to <user data>/hosts/<sessionId>.json, which is also the registry.
 * The environment is not in it (it may hold secrets): the host inherits it when started.
 */
export interface HostSpec extends Omit<LaunchSpec, 'env'> {
  sessionId: string;
  pipe: string;
  /** How long the host waits for Ledung to reconnect before it stops the session itself. */
  graceMs: number;
  logFile: string;
  /**
   * What #hello must carry (#104): only Ledung knows it, from this record in its data folder, which
   * sessions are denied. Never in the environment or the arguments, which Claude Code inherits or
   * other processes can list. Absent in a record from a host started before #104, which checks nothing.
   */
  secret?: string;
}

export interface HostRecord extends HostSpec {
  hostPid: number;
  startedAt: number;
}

export const GRACE_MS = 3 * 60 * 1000;

export function pipePath(sessionId: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\ledung-host-${sessionId}`
    // Unix socket paths are limited to about 100 characters, so not under the (long) user data folder.
    : path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), `ledung-host-${sessionId}.sock`);
}
