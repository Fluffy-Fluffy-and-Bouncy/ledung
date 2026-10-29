// The session host, with a small stand-in for Claude Code: replay after reconnecting, re-sending
// waiting requests, stopping, and stopping by itself when Ledung doesn't come back.
//
// Time limits are generous: starting a Node process on a CI machine can take several seconds
// (Windows scans each new script first). They only matter when something is actually broken.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { connectHost, HostConnection, hostSecret } from '../src/host/client.ts';
import { pipePath, type HostSpec } from '../src/host/protocol.ts';
import { removeTemp } from './temp.ts';

// A stop takes longer still: the host lists every process (to record Claude Code's tree, step-1a spike
// finding 2) before it closes Claude Code's input, and on Windows that list is a PowerShell/WMI query
// that took up to 36 s with the machine busy, against under 1 s idle (#384).
const STOP_MS = 120000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-host-test-'));
after(() => removeTemp(dir));

// Stand-in for Claude Code: answers commands on stdin with JSON lines on stdout.
const fake = path.join(dir, 'fake-claude.mjs');
fs.writeFileSync(fake, `
import readline from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.cmd === 'echo') out({ type: 'assistant', text: m.text });
  if (m.cmd === 'later') setTimeout(() => out({ type: 'assistant', text: m.text }), 300);
  if (m.cmd === 'ask') out({ type: 'control_request', request_id: m.id, request: { subtype: 'can_use_tool' } });
  if (m.type === 'control_response') out({ type: 'result', answered: m.response.request_id });
}).on('close', () => process.exit(0));
`);

let counter = 0;
function startTestHost(graceMs = 60000): { spec: HostSpec; file: string; exited: Promise<number | null> } {
  const sessionId = `test-${process.pid}-${++counter}`;
  const spec: HostSpec = {
    sessionId, pipe: pipePath(sessionId), graceMs, logFile: path.join(dir, `${sessionId}.log`),
    command: process.execPath, args: [fake], stop: { kind: 'local' }, secret: `secret-${sessionId}`,
  };
  const file = path.join(dir, `${sessionId}.json`);
  fs.writeFileSync(file, JSON.stringify(spec));
  const host = spawn(process.execPath, [path.join(root, 'src', 'host', 'host.ts'), file], { stdio: 'ignore' });
  const exited = new Promise<number | null>((resolve) => host.on('exit', resolve));
  return { spec, file, exited };
}

interface Client {
  lines: string[];
  send(text: string): void;
  waitFor(pred: (line: string) => boolean, ms?: number): Promise<string>;
  close(): Promise<void>;
  /** Resolves when the connection ends, whoever ended it. */
  closed: Promise<void>;
}

/** hello: what #hello carries; by default the right secret, the way Ledung connects. */
async function connect(pipe: string, from: number, hello: Record<string, unknown> = { from, secret: secretOf(pipe) }): Promise<Client> {
  let socket: net.Socket | null = null;
  for (let i = 0; i < 200 && !socket; i++) {
    socket = await new Promise<net.Socket | null>((resolve) => {
      const s = net.connect(pipe);
      s.once('connect', () => resolve(s));
      s.once('error', () => resolve(null));
    });
    if (!socket) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(socket, 'host reachable');
  const lines: string[] = [];
  const waiters: Array<() => void> = [];
  readline.createInterface({ input: socket }).on('line', (l) => {
    lines.push(l);
    waiters.splice(0).forEach((w) => w());
  });
  const closed = new Promise<void>((r) => socket!.on('close', () => r()));
  socket.write(`#hello ${JSON.stringify(hello)}\n`);
  return {
    lines,
    send: (text) => socket!.write(text + '\n'),
    async waitFor(pred, ms = 20000) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = lines.find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`timed out; got:\n${lines.join('\n')}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
    },
    async close() {
      socket!.destroy();
      await closed;
    },
    closed,
  };
}

const secretOf = (pipe: string) => `secret-${/ledung-host-(.+?)(\.sock)?$/.exec(pipe)![1]}`;
const seqOf = (line: string) => Number(line.split('\t')[0]);
const jsonOf = (line: string) => JSON.parse(line.split('\t').slice(2).join('\t'));

test('replays what Claude wrote while Ledung was away, exactly once', async () => {
  const { spec, exited } = startTestHost();
  const a = await connect(spec.pipe, 0);
  a.send(JSON.stringify({ cmd: 'echo', text: 'one' }));
  const first = await a.waitFor((l) => l.includes('"one"'));
  a.send(JSON.stringify({ cmd: 'later', text: 'two' }));
  await a.close(); // Ledung restarts; "two" arrives while nobody is connected

  await new Promise((r) => setTimeout(r, 600));
  const b = await connect(spec.pipe, seqOf(first));
  const second = await b.waitFor((l) => l.includes('"two"'));
  assert.equal(seqOf(second), seqOf(first) + 1);
  assert.equal(b.lines.filter((l) => l.includes('"one"')).length, 0, 'already-seen lines are not replayed');

  b.send('#stop');
  await b.waitFor((l) => l.startsWith('#exited '), STOP_MS);
  assert.equal(await exited, 0);
});

test('re-sends a request that was still waiting, and forgets it once answered', async () => {
  const { spec, exited } = startTestHost();
  const a = await connect(spec.pipe, 0);
  a.send(JSON.stringify({ cmd: 'ask', id: 'r1' }));
  const request = await a.waitFor((l) => l.includes('control_request'));
  await a.close(); // restart while the request waits

  const b = await connect(spec.pipe, seqOf(request));
  const again = await b.waitFor((l) => l.includes('control_request'));
  assert.equal(jsonOf(again).request_id, 'r1');
  b.send(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: {} } }));
  const result = await b.waitFor((l) => l.includes('"result"'));
  await b.close();

  const c = await connect(spec.pipe, seqOf(result));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(c.lines.filter((l) => l.includes('control_request')).length, 0, 'answered requests are not re-sent');
  c.send('#stop');
  await c.waitFor((l) => l.startsWith('#exited '), STOP_MS);
  assert.equal(await exited, 0);
});

test('stop ends Claude Code and the host, and removes the host record', async () => {
  const { spec, file, exited } = startTestHost();
  const a = await connect(spec.pipe, 0);
  a.send('#stop');
  const exit = await a.waitFor((l) => l.startsWith('#exited '), STOP_MS);
  assert.equal(JSON.parse(exit.slice(8)).code, 0);
  assert.equal(await exited, 0);
  assert.equal(fs.existsSync(file), false);
});

test('stops the session by itself when no Ledung comes back within the grace time', async () => {
  const { spec, exited } = startTestHost(400);
  const a = await connect(spec.pipe, 0);
  a.send(JSON.stringify({ cmd: 'echo', text: 'hi' }));
  await a.waitFor((l) => l.includes('"hi"'));
  await a.close();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), STOP_MS))]);
  assert.equal(code, 0);
  assert.match(fs.readFileSync(spec.logFile, 'utf8'), /no Ledung connected/);
});

test('a reachability check does not displace the connected Ledung', async () => {
  const { spec, exited } = startTestHost();
  const a = await connect(spec.pipe, 0);
  await new Promise<void>((resolve) => {
    const probe = net.connect(spec.pipe, () => {
      probe.destroy();
      resolve();
    });
  });
  await new Promise((r) => setTimeout(r, 200));
  a.send(JSON.stringify({ cmd: 'echo', text: 'still here' }));
  await a.waitFor((l) => l.includes('"still here"'));
  a.send('#stop');
  await a.waitFor((l) => l.startsWith('#exited '), STOP_MS);
  assert.equal(await exited, 0);
});

// Issue #104: anything else on this machine can connect to the socket; only Ledung knows the secret.
for (const [name, hello] of [
  ['no secret', (from: number) => ({ from })],
  ['a wrong secret', (from: number) => ({ from, secret: 'not-the-secret' })],
] as const) {
  test(`a hello with ${name} is closed, gets nothing, and does not displace Ledung`, async () => {
    const { spec, exited } = startTestHost();
    const a = await connect(spec.pipe, 0);
    a.send(JSON.stringify({ cmd: 'ask', id: 'r1' }));
    await a.waitFor((l) => l.includes('control_request'));

    // From far ahead, so a host that let it in would re-send the waiting request.
    const outsider = await connect(spec.pipe, 0, hello(1_000_000));
    const closed = await Promise.race([outsider.closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('open'), 20000).unref())]);
    await outsider.close();
    assert.equal(closed, 'closed', 'the host closes the connection');
    assert.deepEqual(outsider.lines, [], 'no replay and no waiting request');
    assert.match(fs.readFileSync(spec.logFile, 'utf8'), /refused a connection without the session's secret/);

    // Ledung's own connection is untouched and still answers the waiting request.
    a.send(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: {} } }));
    await a.waitFor((l) => l.includes('"result"'));
    a.send('#stop');
    await a.waitFor((l) => l.startsWith('#exited '), STOP_MS);
    assert.equal(await exited, 0);
  });
}

/** The promise's value, or a failure naming what did not happen within ms (so a regression fails, not hangs). */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Waits until cond holds, checking every 50 ms; fails naming what did not happen, and stops checking then. */
async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`${what} did not happen within ${ms / 1000} s`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Stops a test host whatever state the test left it in; a host already gone is fine. */
function stopQuietly(pipe: string, secret: string | undefined): Promise<void> {
  return new Promise((resolve) => {
    const s = net.connect(pipe);
    s.on('connect', () => s.write(`#hello ${JSON.stringify({ from: 0, secret })}\n#stop\n`));
    s.on('data', () => {});
    s.on('close', () => resolve());
    s.on('error', () => resolve());
    setTimeout(() => {
      s.destroy();
      resolve();
    }, 5000).unref();
  });
}

test("Ledung's side ends cleanly when the host refuses it, also when it writes afterwards (#104)", async () => {
  const { spec, exited } = startTestHost();
  const errors: string[] = [];
  const conn = new HostConnection(spec.pipe, 0, { onLine: () => {}, onStderr: () => {} }, 'not-the-secret');
  conn.on('error', (e: Error) => errors.push(e.message));
  // What the Agent SDK does on attaching: it writes at once, and goes on writing into the closed socket.
  const writes = setInterval(() => conn.stdin.write(JSON.stringify({ cmd: 'echo', text: 'x' }) + '\n'), 20);
  try {
    const code = await within(new Promise<number | null>((resolve) => conn.on('exit', resolve)), 20000, 'the refused connection ending');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(typeof code, 'number', 'it reports the end like a process that exited');
    assert.deepEqual(errors, []);
  } finally {
    clearInterval(writes);
    await stopQuietly(spec.pipe, spec.secret);
  }
  assert.equal(await within(exited, STOP_MS, 'the host exiting'), 0);
});

// Writing into a socket the host has just closed fails with EPIPE; a Ledung from before #104 meeting a
// newer host crashed on it (the error reached a line reader nobody listened to).
test("a socket error on Ledung's side ends the connection like an exit, without crashing Ledung", async () => {
  const { spec, exited } = startTestHost();
  const conn = new HostConnection(spec.pipe, 0, { onLine: () => {}, onStderr: () => {} }, secretOf(spec.pipe));
  conn.on('error', () => {});
  try {
    for (let i = 0; i < 200 && !/Ledung connected/.test(fs.existsSync(spec.logFile) ? fs.readFileSync(spec.logFile, 'utf8') : ''); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const ended = new Promise<number | null>((resolve) => conn.on('exit', resolve));
    const socket = (conn as unknown as { socket: net.Socket }).socket;
    socket.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    assert.equal(typeof (await within(ended, 20000, 'the connection ending')), 'number');
  } finally {
    await stopQuietly(spec.pipe, spec.secret);
  }
  assert.equal(await within(exited, STOP_MS, 'the host exiting'), 0);
});

// The secret's real path (#104 test reviews): Ledung makes it when it starts a host, keeps it only in the
// host's record (this user only), reads it back from there, and connects with it, to a new host and again
// after a restart. connectHost is what a session calls, so a session that lost the secret fails here.
test('a host started by Ledung gets its secret only through its record, and Ledung connects with it, also after a restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(dir, 'data-'));
  const own = process.env.LEDUNG_DATA_DIR;
  process.env.LEDUNG_DATA_DIR = dataDir;
  const sessionId = `test-${process.pid}-real`;
  const recordFile = path.join(dataDir, 'hosts', `${sessionId}.json`);
  let pipe: string | undefined;
  let secret: string | undefined;
  let conn: HostConnection | undefined;
  const lines: { seq: number; json: string }[] = [];
  const handlers = { onLine: (seq: number, _at: number, json: string) => lines.push({ seq, json }), onStderr: () => {} };
  const echo = async (c: HostConnection, text: string) => {
    c.stdin.write(JSON.stringify({ cmd: 'echo', text }) + '\n');
    await until(() => lines.some((l) => l.json.includes(text)), 20000, `"${text}" coming back through the connection`);
  };
  try {
    conn = connectHost(sessionId, { launch: { command: process.execPath, args: [fake], env: { ...process.env } as Record<string, string>, stop: { kind: 'local' } } }, handlers);
    conn.on('error', () => {});
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    pipe = record.pipe as string;
    secret = hostSecret(sessionId);
    assert.match(secret ?? '', /^[0-9a-f]{64}$/, 'Ledung reads a secret back from the record');
    assert.equal(record.secret, secret);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(recordFile).mode & 0o777, 0o600, 'the record is for this user only');
      // What the host was started with: its command line and its environment (ps eww lists both).
      const started = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(record.hostPid)], { encoding: 'utf8' });
      assert.ok(started.includes(recordFile), 'this is the host process');
      assert.ok(started.includes(`LEDUNG_DATA_DIR=${dataDir}`), 'ps shows its environment too, so the next check means something');
      assert.ok(!started.includes(secret!), 'the secret is in neither its arguments nor its environment');
    }
    await echo(conn, 'through a new host');

    // Restart Ledung: let go of the host, then attach to it again as a session does after a restart.
    conn.kill();
    conn = connectHost(sessionId, { attachTo: pipe, fromSeq: lines.at(-1)!.seq }, handlers);
    conn.on('error', () => {});
    await echo(conn, 'after the restart');

    conn.stop();
    // The host removes its record when it ends.
    await until(() => !fs.existsSync(recordFile), STOP_MS, 'the host ending');
  } finally {
    conn?.kill();
    if (pipe) await stopQuietly(pipe, secret);
    if (own === undefined) delete process.env.LEDUNG_DATA_DIR;
    else process.env.LEDUNG_DATA_DIR = own;
  }
});
