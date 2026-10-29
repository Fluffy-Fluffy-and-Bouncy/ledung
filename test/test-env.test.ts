// `npm test` (scripts/test.ts) gives the tests a data folder and config of their own (issue #435): Update Ledung runs
// them with LEDUNG_DATA_DIR and LEDUNG_CONFIG set to the running Ledung's real ones, and a test that falls back to
// the defaults must not reach those. Run for real on a probe test file, as the suite runs one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appDir } from '../src/platform/paths.ts';
import { removeTemp } from './temp.ts';

/** Runs scripts/test.ts on one probe test file with the caller's LEDUNG_* set to stand-ins for the real ones. */
function runProbe(base: string, body: string) {
  const file = path.join(base, 'probe.test.ts');
  const paths = pathToFileURL(path.join(appDir(), 'src', 'platform', 'paths.ts')).href;
  fs.writeFileSync(file, `import { test } from 'node:test';\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport { userDataDir } from '${paths}';\n${body}\n`);
  const env: Record<string, string | undefined> = {
    ...process.env, LEDUNG_DATA_DIR: path.join(base, 'real-data'), LEDUNG_CONFIG: path.join(base, 'real.json'), LEDUNG_LAUNCHER: '1', PROBE_OUT: path.join(base, 'seen.json'),
  };
  // A test file as the suite runs one, not as a child of this run.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [path.join(appDir(), 'scripts', 'test.ts'), file], { cwd: appDir(), env, encoding: 'utf8', timeout: 60_000 });
}

test('the tests see a temp data folder and config of their own, never the caller\'s LEDUNG_* (#435)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-test-env-'));
  try {
    const r = runProbe(base, `test('probe', () => {
  const seen = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('LEDUNG_')));
  // A test that forgets its own folder and writes through the default one.
  const marker = path.join(userDataDir(), 'marker');
  fs.writeFileSync(marker, 'x');
  fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify({ seen, marker }));
});`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { seen, marker } = JSON.parse(fs.readFileSync(path.join(base, 'seen.json'), 'utf8')) as { seen: Record<string, string>; marker: string };
    assert.deepEqual(Object.keys(seen).sort(), ['LEDUNG_CONFIG', 'LEDUNG_DATA_DIR'], 'LEDUNG_LAUNCHER is dropped');
    assert.equal(fs.existsSync(path.join(base, 'real-data', 'marker')), false, 'nothing reached the caller\'s data folder');
    const own = path.dirname(seen.LEDUNG_DATA_DIR!);
    assert.equal(marker, path.join(own, 'data', 'marker'), 'the default data folder is the throwaway one');
    assert.equal(path.dirname(own), path.resolve(os.tmpdir()), 'in a folder of its own in the temp folder');
    assert.equal(seen.LEDUNG_DATA_DIR, path.join(own, 'data'));
    assert.equal(seen.LEDUNG_CONFIG, path.join(own, 'config.json'));
    assert.equal(fs.existsSync(own), false, 'removed after the run');
  } finally {
    removeTemp(base);
  }
});

test('a failing test still fails the run (#435)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-test-env-'));
  try {
    const r = runProbe(base, `test('probe', () => { throw new Error('probe failed'); });`);
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /probe failed/);
  } finally {
    removeTemp(base);
  }
});
