// Ledung in the background (issue #456; Martin, 2026-11-01 21:41, Ledung question #1149): `ledung` starts the
// foreground command detached, its output in the data folder's log, and returns once Ledung answers; a start that
// fails says why from the log. The started program here is a stand-in that answers /running as Ledung does.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { logFile, logTail, rotateLog, startInBackground } from '../src/platform/background.ts';
import { appDir } from '../src/platform/paths.ts';
import { freePort } from './free-port.ts';
import { removeTemp } from './temp.ts';

let base: string;
const pids: number[] = [];

before(() => {
  fs.mkdirSync(path.join(appDir(), '.test'), { recursive: true });
  base = fs.mkdtempSync(path.join(appDir(), '.test', 'background-'));
});

after(() => {
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
  const lines: string[] = [];
  const code = await startInBackground({ args: [script], configFile: config, dataDir: data, print: (l) => lines.push(l), readyMs: 20_000 });
  assert.equal(code, 2);
  assert.match(lines[0]!, /Ledung stopped while starting \(exit code 2\)/);
  assert.match(lines[1]!, /Port 4317 is in use\.$/);
  assert.match(logTail(logFile(data)), /Port 4317 is in use\./);
});

test('a start returns once Ledung answers, which then runs on with its output in the log', async () => {
  const { dir, data, config } = folder('runs');
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
