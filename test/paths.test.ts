// Where Ledung keeps its data (src/platform/paths.ts): the data folder is private to this user on macOS and Linux
// (audit L19), made so and tightened when an older Ledung left it open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateToUser, userDataDir } from '../src/platform/paths.ts';
import { removeTemp } from './temp.ts';

/** userDataDir() with LEDUNG_DATA_DIR pointing at `dir` for the call. */
function dataDirAt(dir: string): string {
  const saved = process.env.LEDUNG_DATA_DIR;
  process.env.LEDUNG_DATA_DIR = dir;
  try {
    return userDataDir();
  } finally {
    if (saved === undefined) delete process.env.LEDUNG_DATA_DIR;
    else process.env.LEDUNG_DATA_DIR = saved;
  }
}

const modeOf = (dir: string) => fs.statSync(dir).mode & 0o777;

test('audit L19: a new data folder is 0700, and one an older Ledung made open is tightened on start', { skip: process.platform === 'win32' && 'Windows has no modes; the profile\'s permissions hold' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-paths-'));
  try {
    const fresh = path.join(base, 'new', 'data');
    assert.equal(dataDirAt(fresh), fresh);
    assert.equal(modeOf(fresh), 0o700, 'made private');
    const old = path.join(base, 'old');
    fs.mkdirSync(old);
    fs.chmodSync(old, 0o755);
    assert.equal(modeOf(old), 0o755, 'the premise: open to group and others');
    dataDirAt(old);
    assert.equal(modeOf(old), 0o700, 'tightened');
    dataDirAt(old);
    assert.equal(modeOf(old), 0o700, 'and left so');
  } finally {
    removeTemp(base);
  }
});

test('audit L19: on Windows the folder\'s mode is left alone', { skip: process.platform === 'win32' && 'checked where modes exist' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-paths-'));
  try {
    fs.chmodSync(base, 0o755);
    privateToUser(base, 'win32');
    assert.equal(modeOf(base), 0o755, 'untouched for win32');
    privateToUser(base, 'linux');
    assert.equal(modeOf(base), 0o700, 'the same folder tightened for linux (the probe reads real modes)');
  } finally {
    removeTemp(base);
  }
});
