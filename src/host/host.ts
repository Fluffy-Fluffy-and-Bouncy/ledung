// The session host: owns one Claude Code process and keeps it running while Ledung restarts.
//
//   node host.ts <spec file>
//
// Started detached by Ledung, one per session. It numbers every line Claude Code writes and keeps it
// until Ledung confirms it is stored, so a reconnecting Ledung gets exactly what it missed, and it
// re-sends permission prompts that are still waiting (docs/steps/host-spike.md). Kept deliberately
// small: a running session keeps the host it started with, whatever Ledung release comes later.
//
// Lifetime: it ends when Claude Code exits, when Ledung sends #stop, or when no Ledung has been
// connected for spec.graceMs (Ledung crashed or was killed and didn't come back).
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import type { HostSpec } from './protocol.ts';
import { stopSession } from './stop.ts';

interface Line {
  seq: number;
  at: number;
  text: string;
}

const specFile = process.argv[2];
if (!specFile) {
  console.error('Usage: node host.ts <spec file>');
  process.exit(2);
}
const spec: HostSpec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const log = (message: string) => {
  try {
    fs.appendFileSync(spec.logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never stop the session.
  }
};

// The environment was given to the host when Ledung started it; Claude Code gets the same.
const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
log(`started Claude Code, pid ${child.pid}`);

const lines: Line[] = [];
/** Control requests from Claude Code still waiting for an answer, by request_id. */
const pending = new Map<string, Line>();
let seq = 0;
let client: net.Socket | null = null;
let exitLine: string | null = null;
let stderrTail: string[] = [];
let graceTimer: NodeJS.Timeout | null = null;
let stopping = false;

/** The parsed line if it is a control message of the given type; cheap for every other line. */
function controlMessage(text: string, type: string): any {
  if (!text.includes(`"${type}"`)) return null;
  try {
    const m = JSON.parse(text);
    return m?.type === type ? m : null;
  } catch {
    return null;
  }
}

const send = (text: string) => {
  if (client && !client.destroyed) client.write(text + '\n');
};

readline.createInterface({ input: child.stdout }).on('line', (text) => {
  const line = { seq: ++seq, at: Date.now(), text };
  lines.push(line);
  const request = controlMessage(text, 'control_request');
  if (request?.request_id) pending.set(request.request_id, line);
  send(`${line.seq}\t${line.at}\t${text}`);
});

readline.createInterface({ input: child.stderr }).on('line', (text) => {
  stderrTail = [...stderrTail, text].slice(-20);
  send(`#stderr ${text}`);
});

child.on('exit', (code) => {
  log(`Claude Code exited with code ${code}`);
  exitLine = `#exited ${JSON.stringify({ code, stderr: stderrTail.join('\n') })}`;
  if (client) {
    send(exitLine);
    client.end();
    finish();
  } else if (!stopping) {
    // Wait for a Ledung to collect the last lines, but not forever.
    armGrace();
  }
});

function finish(): void {
  try {
    fs.rmSync(specFile!, { force: true });
  } catch {}
  setTimeout(() => process.exit(0), 300);
}

async function stop(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${reason}`);
  const ended = await stopSession(child, spec.stop);
  if (ended.length) log(`ended what was still running: ${ended.join(', ')}`);
  if (exitLine) send(exitLine);
  client?.end();
  finish();
}

function armGrace(): void {
  if (graceTimer) clearTimeout(graceTimer);
  graceTimer = setTimeout(() => {
    if (client) return;
    if (exitLine) {
      log('no Ledung collected the exit; ending');
      finish();
    } else {
      void stop(`no Ledung connected for ${Math.round(spec.graceMs / 1000)} s`);
    }
  }, spec.graceMs);
}

function secretMatches(given: unknown): boolean {
  if (!spec.secret || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(spec.secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = net.createServer((socket) => {
  // A connection counts only once it says #hello; a reachability check never displaces Ledung.
  let greeted = false;
  readline.createInterface({ input: socket }).on('line', (text) => {
    if (!greeted) {
      if (!text.startsWith('#hello ')) return socket.destroy();
      let hello: { from?: unknown; secret?: unknown };
      try {
        hello = JSON.parse(text.slice(7)) ?? {};
      } catch {
        return socket.destroy();
      }
      // Only Ledung knows the secret; anything else that connects is refused before it can displace
      // Ledung or see a line (#104).
      if (!secretMatches(hello.secret)) {
        log('refused a connection without the session\'s secret');
        return socket.destroy();
      }
      greeted = true;
      if (client && client !== socket) {
        log('a new Ledung connected; dropping the old connection');
        const old = client;
        client = null;
        old.destroy();
      }
      const from = Number(hello.from) || 0;
      const resend = [...pending.values()].filter((l) => l.seq <= from);
      const replay = lines.filter((l) => l.seq > from);
      log(`Ledung connected from #${from}: replaying ${replay.length}, re-sending ${resend.length} waiting request(s)`);
      client = socket;
      if (graceTimer) clearTimeout(graceTimer);
      for (const l of [...resend, ...replay]) send(`${l.seq}\t${l.at}\t${l.text}`);
      if (exitLine) {
        send(exitLine);
        socket.end();
        finish();
      }
      return;
    }
    if (text.startsWith('#ack ')) {
      const upTo = Number(text.slice(5));
      while (lines.length && lines[0]!.seq <= upTo) lines.shift();
      return;
    }
    if (text === '#stop') {
      void stop('Ledung asked');
      return;
    }
    if (text.startsWith('#')) return;
    const response = controlMessage(text, 'control_response');
    if (response?.response?.request_id) pending.delete(response.response.request_id);
    if (!child.stdin.destroyed) child.stdin.write(text + '\n');
  });
  socket.on('close', () => {
    if (client !== socket) return;
    client = null;
    log('Ledung disconnected');
    if (!stopping) armGrace();
  });
  socket.on('error', () => {});
});

server.on('error', (e) => {
  log(`cannot listen on ${spec.pipe}: ${e.message}`);
  void stop('cannot listen');
});
// A Unix socket left behind by a host that crashed would block listening.
if (process.platform !== 'win32') fs.rmSync(spec.pipe, { force: true });
server.listen(spec.pipe, () => log(`listening on ${spec.pipe}`));
armGrace();
