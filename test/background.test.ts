// Ledung in the background (issue #456; Martin, 2026-11-01 21:41, Ledung question #1149): `ledung` starts the
// foreground command detached, its output in the data folder's log, and returns once Ledung answers; a start that
// fails says why from the log. The started program here is a stand-in that answers /running as Ledung does.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { logFile, logTail, rotateLog, startInBackground } from '../src/platform/background.ts';
import { appDir } from '../src/platform/paths.ts';
import { freePort } from './free-port.ts';
import { removeTemp } from './temp.ts';
import { HANG_MS, WAIT_MS } from './limits.ts';

let base: string;
const pids: number[] = [];
/** Process groups a test started, ended after the file whatever happened, so a failed test can't keep it running. */
const groups: number[] = [];

before(() => {
  fs.mkdirSync(path.join(appDir(), '.test'), { recursive: true });
  base = fs.mkdtempSync(path.join(appDir(), '.test', 'background-'));
});

after(() => {
  for (const group of groups) {
    try {
      process.kill(-group, 'SIGKILL');
    } catch {
      // Gone already.
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      // Gone already.
    }
  }
  removeTemp(base);
});

function folder(name: string): { dir: string; data: string; config: string } {
  const dir = path.join(base, name);
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  return { dir, data, config: path.join(dir, 'config.json') };
}

test('a log past its size is moved to ledung.old.log, one copy kept', () => {
  const { data } = folder('rotate');
  const file = logFile(data);
  fs.writeFileSync(file, 'x'.repeat(20));
  rotateLog(file, 100);
  assert.equal(fs.readFileSync(file, 'utf8'), 'x'.repeat(20), 'small: kept');
  fs.writeFileSync(path.join(data, 'ledung.old.log'), 'older');
  fs.writeFileSync(file, 'y'.repeat(101));
  rotateLog(file, 100);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(path.join(data, 'ledung.old.log'), 'utf8'), 'y'.repeat(101));
});

test('a start that fails returns its exit code and shows the end of the log', async () => {
  const { dir, data, config } = folder('fails');
  const script = path.join(dir, 'fails.mjs');
  fs.writeFileSync(script, "console.error('Port 4317 is in use.'); process.exit(2);");
  // A log another start made, readable by everyone: it holds the sign-in link, so the start narrows it.
  fs.writeFileSync(logFile(data), '', { mode: 0o644 });
  const lines: string[] = [];
  const code = await startInBackground({ args: [script], configFile: config, dataDir: data, print: (l) => lines.push(l), readyMs: 20_000 });
  assert.equal(code, 2);
  assert.match(lines[0]!, /Ledung stopped while starting \(exit code 2\)/);
  assert.match(lines[1]!, /Port 4317 is in use\.$/);
  assert.match(logTail(logFile(data)), /Port 4317 is in use\./);
  if (process.platform !== 'win32') assert.equal(fs.statSync(logFile(data)).mode & 0o777, 0o600, 'only this user reads the log');
});

/** A stand-in for Ledung in the folder: it writes its pid and answers /running as Ledung does. Returns its script. */
async function standIn(dir: string, data: string, config: string): Promise<{ script: string; port: number }> {
  const port = await freePort();
  fs.writeFileSync(config, JSON.stringify({ port }));
  const token = 'b'.repeat(64);
  const script = path.join(dir, 'ledung.mjs');
  // Answers /running with the proof of the token (src/platform/running.ts), as Ledung does once it listens.
  fs.writeFileSync(script, [
    "import http from 'node:http';",
    "import fs from 'node:fs';",
    "import crypto from 'node:crypto';",
    `fs.writeFileSync(${JSON.stringify(path.join(dir, 'pid'))}, String(process.pid));`,
    "console.log('log file ' + process.env.LEDUNG_LOG_FILE + ' args ' + process.argv.slice(2).join(' '));",
    `fs.writeFileSync(${JSON.stringify(path.join(data, 'auth-token'))}, '${token}');`,
    'http.createServer((req, res) => {',
    "  const nonce = new URL(req.url, 'http://x').searchParams.get('nonce');",
    `  res.end(JSON.stringify({ proof: crypto.createHmac('sha256', '${token}').update('ledung-running:' + nonce).digest('hex') }));`,
    `}).listen(${port}, '127.0.0.1');`,
    'setTimeout(() => process.exit(0), 60_000);',
  ].join('\n'));
  return { script, port };
}

test('a start returns once Ledung answers, which then runs on with its output in the log', async () => {
  const { dir, data, config } = folder('runs');
  const { script, port } = await standIn(dir, data, config);
  const lines: string[] = [];
  const code = await startInBackground({ args: [script, '--foreground', '--no-open'], configFile: config, dataDir: data, print: (l) => lines.push(l), readyMs: 20_000 });
  const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
  pids.push(pid);
  assert.equal(code, 0);
  assert.equal(lines[0], `Ledung is running in the background at http://127.0.0.1:${port}`);
  assert.equal(lines[1], `Log:  ${logFile(data)}`);
  assert.doesNotThrow(() => process.kill(pid, 0), 'still running after the start returned');
  assert.match(fs.readFileSync(logFile(data), 'utf8'), new RegExp(`log file ${logFile(data).replace(/[\\.]/g, '\\$&')} args --foreground --no-open`));
});

// What closing the terminal or Ctrl+C there does: every process in its process group is ended. The started Ledung is
// in a group of its own and lives on (test review of PR #11: with detached false the other tests stayed green).
test('ending the process group of the terminal that started Ledung leaves Ledung running', { skip: process.platform === 'win32' && 'process groups are POSIX', timeout: HANG_MS }, async () => {
  const { dir, data, config } = folder('terminal');
  const { script } = await standIn(dir, data, config);
  const terminal = path.join(dir, 'terminal.ts');
  const background = pathToFileURL(path.join(appDir(), 'src', 'platform', 'background.ts')).href;
  fs.writeFileSync(terminal, [
    `import { startInBackground } from ${JSON.stringify(background)};`,
    `const code = await startInBackground({ args: [${JSON.stringify(script)}], configFile: ${JSON.stringify(config)}, dataDir: ${JSON.stringify(data)}, print: () => {}, readyMs: 20_000 });`,
    `console.log('started ' + code);`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  // The terminal: a process group of its own, which stays open after the start returned.
  const shell = spawn(process.execPath, [terminal], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  groups.push(shell.pid!);
  const gone = new Promise((resolve) => shell.once('exit', resolve));
  try {
    // Its own line, not the first: a run from source prints the EXERCISED line before it (Mac check of PR #11, round 2).
    let out = '';
    const said = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the start never returned; the terminal said: ${out}`)), WAIT_MS);
      shell.stdout.on('data', (b: Buffer) => {
        out += b.toString();
        const line = /^started .*$/m.exec(out)?.[0];
        if (line) {
          clearTimeout(timer);
          resolve(line);
        }
      });
      shell.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`the terminal exited (${code}); it said: ${out}`));
      });
    });
    assert.equal(said, 'started 0');
    const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
    process.kill(-shell.pid!, 'SIGKILL');
    await gone;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.doesNotThrow(() => process.kill(pid, 0), 'Ledung still runs');
  } finally {
    // Never left running, whatever failed: its open pipe would keep this file from ending.
    try {
      process.kill(-shell.pid!, 'SIGKILL');
    } catch {
      // Gone already.
    }
    shell.stdout.destroy();
    // The stand-in Ledung too, if it started (it ends by itself after a minute anyway).
    const pidFile = path.join(dir, 'pid');
    if (fs.existsSync(pidFile)) pids.push(Number(fs.readFileSync(pidFile, 'utf8')));
  }
});
