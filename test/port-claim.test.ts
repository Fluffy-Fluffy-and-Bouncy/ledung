// The port, claimed before a start touches anything (#503): waiting for it on a restart, giving up without stopping a
// session, and a real start of the core against a busy port with a session host running beside it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { claimPort, listenAddresses } from '../src/platform/port-claim.ts';
import { connectHost, hostReachable, hostSecret, type HostConnection } from '../src/host/client.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { ProjectStore } from '../src/projects/store.ts';
import type { ProjectConfig } from '../src/config.ts';
import { LAUNCHER } from '../src/update/launcher.ts';
import { removeTemp } from './temp.ts';
import { HANG_MS, WAIT_MS } from './limits.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-port-claim-'));
after(() => removeTemp(base));

/** A listener on a free port of 127.0.0.1, standing in for whatever holds Ledung's port. */
async function holder(port = 0): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((s) => s.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('the addresses claimed are the ones the server listens on', () => {
  assert.deepEqual(listenAddresses(undefined), ['127.0.0.1']);
  assert.deepEqual(listenAddresses('0.0.0.0'), ['0.0.0.0']);
  assert.deepEqual(listenAddresses('192.168.1.5'), ['127.0.0.1', '192.168.1.5']);
});

test('a free port is claimed and held until released', async () => {
  const probe = await holder();
  await probe.close();
  const claim = await claimPort({ port: probe.port, addresses: ['127.0.0.1'], waitMs: 0 });
  assert.ok(claim, 'claimed');
  await assert.rejects(holder(probe.port), /EADDRINUSE/, 'nothing else can listen while it is held');
  await claim.release();
  const again = await holder(probe.port);
  await again.close();
});

test('a busy port with no time to wait gives null at once, and says nothing', async () => {
  const busy = await holder();
  const said: string[] = [];
  try {
    const started = Date.now();
    assert.equal(await claimPort({ port: busy.port, addresses: ['127.0.0.1'], waitMs: 0, log: (l) => said.push(l) }), null);
    assert.ok(Date.now() - started < WAIT_MS);
    assert.deepEqual(said, []);
  } finally {
    await busy.close();
  }
});

test('a restart waits for the port and claims it once it is freed, saying once that it waits', async () => {
  const busy = await holder();
  const said: string[] = [];
  const freed = setTimeout(() => void busy.close(), 600);
  try {
    const claim = await claimPort({ port: busy.port, addresses: ['127.0.0.1'], waitMs: WAIT_MS, retryMs: 100, log: (l) => said.push(l) });
    assert.ok(claim, 'claimed after the holder let go');
    await claim.release();
    assert.equal(said.length, 1, said.join('\n'));
    assert.match(said[0]!, new RegExp(`Port ${busy.port} is in use; waiting up to ${WAIT_MS / 1000} s`));
  } finally {
    clearTimeout(freed);
    await busy.close().catch(() => {});
  }
});

test('a port still busy when the wait runs out gives null', async () => {
  const busy = await holder();
  try {
    assert.equal(await claimPort({ port: busy.port, addresses: ['127.0.0.1'], waitMs: 300, retryMs: 100 }), null);
  } finally {
    await busy.close();
  }
});

// Done point 4 of #503: a host-backed session survives a start that fails on a busy port, and the next start, a
// restart that waits while the port is still busy, reconnects it. The core runs for real; Claude Code is a stand-in.
test('a start on a busy port leaves a running session alone, and a restart that waits for the port reconnects it', { timeout: HANG_MS * 2 }, async () => {
  const dataDir = path.join(base, 'data');
  const projectDir = path.join(base, 'project');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  const busy = await holder();
  const configFile = path.join(base, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ port: busy.port, projects: [], trayIcon: false }));

  // Stand-in for Claude Code: answers every control request (the SDK's initialize first) with a success.
  const fake = path.join(base, 'fake-claude.mjs');
  fs.writeFileSync(fake, `
import readline from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_request') out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
}).on('close', () => process.exit(0));
`);

  // The project and a running session, as a Ledung that was restarted leaves them.
  const sessionId = `port-claim-${process.pid}`;
  const db = openDatabase(path.join(dataDir, 'ledung.db'));
  new ProjectStore(db).add({ name: 'p', path: projectDir, runner: 'local' } as ProjectConfig);
  const store = new Store(db);
  store.createSession({ id: sessionId, project: 'p', runner: 'local', title: 'kept running', parentId: null, permissionMode: 'default' });
  store.updateSession(sessionId, { status: 'running' });
  db.close();

  const own = process.env.LEDUNG_DATA_DIR;
  process.env.LEDUNG_DATA_DIR = dataDir;
  let conn: HostConnection | undefined;
  let pipe: string | undefined;
  let secret: string | undefined;
  let core: ReturnType<typeof spawn> | undefined;
  const recordFile = path.join(dataDir, 'hosts', `${sessionId}.json`);
  try {
    // This test is the Ledung that has the port: connected to the session's host, as a running Ledung is.
    const answered: string[] = [];
    conn = connectHost(sessionId, { launch: { command: process.execPath, args: [fake], env: { ...process.env } as Record<string, string>, stop: { kind: 'local' } } }, {
      onLine: (_seq, _at, json) => { answered.push(json); },
      onStderr: () => {},
    });
    conn.on('error', () => {});
    pipe = JSON.parse(fs.readFileSync(recordFile, 'utf8')).pipe as string;
    secret = hostSecret(sessionId);
    const ask = async (id: string) => {
      conn!.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'probe' } })}\n`);
      const end = Date.now() + WAIT_MS;
      while (!answered.some((l) => l.includes(id))) {
        if (Date.now() > end) throw new Error(`no answer to ${id} through the running Ledung's connection`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    await ask('before');

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('LEDUNG_')) env[k] = v;
    Object.assign(env, { LEDUNG_DATA_DIR: dataDir, LEDUNG_CONFIG: configFile });
    const main = path.join(import.meta.dirname, '..', 'src', 'main.ts');

    // A first start: the port is busy, so it gives up at once and touches nothing.
    const first = spawnSync(process.execPath, [main, '--no-open'], { env, encoding: 'utf8', timeout: HANG_MS });
    assert.equal(first.status, 1, first.stdout + first.stderr);
    assert.match(first.stderr, new RegExp(`Port ${busy.port} is in use\\.`));
    assert.match(first.stderr, /No session was stopped/);
    assert.doesNotMatch(first.stdout, /Stopping sessions/);
    // A start that reached the hosts would have taken this one over (a host keeps only its newest Ledung).
    await ask('after');
    assert.ok(await hostReachable(pipe), 'the host still runs');
    assert.ok(fs.existsSync(recordFile), 'its record is kept for the next start');
    const check = openDatabase(path.join(dataDir, 'ledung.db'));
    try {
      assert.equal(new Store(check).getSession(sessionId)?.status, 'running', 'the session is not marked ended');
    } finally {
      check.close();
    }

    // A restart while the port is still busy: it waits, the port is freed, and it reconnects the session. The Ledung
    // before lets go of the host first, as a restart does.
    conn.kill();
    conn = undefined;
    core = spawn(process.execPath, [main, '--no-open'], { env: { ...env, LEDUNG_RESTARTED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    core.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
    core.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
    const until = async (re: RegExp, what: string) => {
      const end = Date.now() + HANG_MS;
      while (!re.test(out)) {
        if (Date.now() > end || core!.exitCode !== null) throw new Error(`no ${what}; got:\n${out}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    await until(/waiting up to 30 s for it to be freed/, 'wait for the port');
    await busy.close();
    await until(/Reconnected to 1 running session\(s\)/, 'reconnect');
    assert.doesNotMatch(out, /Stopping sessions|marked ended/);
  } finally {
    await busy.close().catch(() => {});
    if (core && core.exitCode === null) {
      const gone = new Promise((r) => core!.once('exit', r));
      core.kill();
      await gone;
    }
    conn?.kill();
    if (pipe) await stopQuietly(pipe, secret);
    if (own === undefined) delete process.env.LEDUNG_DATA_DIR;
    else process.env.LEDUNG_DATA_DIR = own;
  }
});

// How the core knows a start is a restart, and so waits for the port: the release launcher says so on the second start
// only. A stand-in core writes what it was told and asks for one restart.
test('the release launcher tells a restarted core it is a restart, and the first start not', () => {
  const release = path.join(base, 'release');
  fs.mkdirSync(path.join(release, 'src'), { recursive: true });
  const seen = path.join(base, 'seen.txt');
  fs.writeFileSync(path.join(release, 'src', 'main.ts'), `
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env.LEDUNG_RESTARTED ?? null) + '\\n');
process.exit(fs.readFileSync(${JSON.stringify(seen)}, 'utf8').trim().split('\\n').length === 1 ? 75 : 0);
`);
  fs.writeFileSync(path.join(base, 'current.json'), JSON.stringify({ dir: release, config: path.join(base, 'none.json') }));
  const launcher = path.join(base, 'launcher.mjs');
  fs.writeFileSync(launcher, LAUNCHER);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('LEDUNG_')) env[k] = v;
  const r = spawnSync(process.execPath, [launcher, '--no-open'], { env, encoding: 'utf8', timeout: HANG_MS });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(fs.readFileSync(seen, 'utf8').trim().split('\n').map((l) => JSON.parse(l)), ['', '1']);
});

// The log says what stopped or restarted Ledung, so a "Stopping sessions" line can be traced (#503). The core's start
// can't be run up to an installed update here, so this reads its wiring: every stop or restart names its own reason,
// and the updater's restart is not logged as the Restart button (code review of PR #505).
test('each way Ledung stops or restarts gives the log its own reason, an installed update included', () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
  const reasons = [...source.matchAll(/shutdown\((?:true|false), '([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...reasons].sort(), [
    'Exit in the tray icon', 'Restart Ledung', 'Restart in the tray icon', 'Stop Ledung in the page, or ledung stop', 'update installed',
  ]);
  const updater = source.slice(source.indexOf('new Updater({'), source.indexOf('});', source.indexOf('new Updater({')));
  assert.match(updater, /onRestart: canRestart \? \(\) => void shutdown\(true, 'update installed'\) : undefined/);
  assert.doesNotMatch(updater, /onRestart,/, 'not the Restart button\'s');
});

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
