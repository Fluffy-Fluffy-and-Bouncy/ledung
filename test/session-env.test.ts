// Sessions never inherit Ledung's own settings (CLAUDE.md, "Rules that exist for a reason"), nor Electron's (#361).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sessionEnv } from '../src/runners/runner.ts';
import { runtimeRefusal } from '../src/platform/runtime.ts';
import { HANG_MS } from './limits.ts';

test('sessions inherit no LEDUNG_* settings', () => {
  const env = sessionEnv({ env: { LEDUNG_CONFIG: 'a', LEDUNG_DATA_DIR: 'b', PATH: 'p' } } as never);
  assert.deepEqual(env, { PATH: 'p' });
});

test('sessions inherit no ELECTRON_* settings (#361)', () => {
  // The two a Ledung started from an Electron program carries (issue #361, Mac spike).
  const env = sessionEnv({ env: { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', PATH: 'p' } } as never);
  assert.deepEqual(env, { PATH: 'p' });
  // Only the prefix: a name that merely contains ELECTRON stays.
  assert.deepEqual(sessionEnv({ env: { MY_ELECTRON_APP: 'x' } } as never), { MY_ELECTRON_APP: 'x' });
});

test('the core refuses Electron and accepts Node (#361)', () => {
  assert.equal(runtimeRefusal({ node: '24.0.0' }), null);
  assert.equal(runtimeRefusal(process.versions), null);
  const refusal = runtimeRefusal({ node: '22.0.0', electron: '39.0.0' });
  assert.ok(refusal);
  assert.match(refusal, /Electron 39\.0\.0/);
  assert.match(refusal, /node/);
  assert.ok(!refusal.includes('\n'), 'one line');
});

test('a core started on Electron stops at once, before it opens the database (#361)', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-electron-'));
  // A port that is taken, so a core that gets past the check stops at its listen instead of running on.
  const busy = net.createServer();
  await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
  try {
    // process.versions as Electron's binary has it, set before the core's own code runs.
    const preload = path.join(base, 'as-electron.mjs');
    fs.writeFileSync(preload, "Object.defineProperty(process, 'versions', { value: { ...process.versions, electron: '39.0.0' } });\n");
    const port = (busy.address() as net.AddressInfo).port;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('LEDUNG_')) env[k] = v;
    const main = path.join(import.meta.dirname, '..', 'src', 'main.ts');
    const run = (name: string, args: string[]) => {
      const dir = path.join(base, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, projects: [] }));
      const r = spawnSync(process.execPath, [...args, main, '--no-open'], {
        encoding: 'utf8',
        env: { ...env, LEDUNG_DATA_DIR: path.join(dir, 'data'), LEDUNG_CONFIG: path.join(dir, 'config.json') },
        timeout: HANG_MS,
      });
      return { ...r, database: fs.existsSync(path.join(dir, 'data', 'ledung.db')) };
    };

    // --import takes a module specifier: a Windows path would read as a URL with the drive as its scheme (CI, PR #364).
    const electron = run('electron', ['--import', pathToFileURL(preload).href]);
    assert.equal(electron.status, 1, electron.stderr);
    const lines = electron.stderr.trim().split(/\r?\n/);
    assert.equal(lines.length, 1, electron.stderr);
    assert.match(lines[0] ?? '', /^Ledung runs on Node\.js, not on Electron's binary \(Electron 39\.0\.0\)/);
    assert.equal(electron.database, false, 'no database was opened');

    // The same start on Node gets past the check, and stops at the taken port, which it claims before it opens the
    // database (#503).
    const node = run('node', []);
    assert.equal(node.status, 1, node.stderr);
    assert.match(node.stderr, /Port \d+ is in use/);
    assert.doesNotMatch(node.stderr, /Electron/);
    assert.equal(node.database, false, 'a start that cannot have the port opens no database');
  } finally {
    busy.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
