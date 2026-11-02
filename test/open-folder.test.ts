// Settings' Open folder (issue #414): Finder on macOS, Explorer on Windows, xdg-open elsewhere, with the folder as
// one argument and no shell in between. How it went is looked at (issue #83), with real programs here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { openFolder, openFolderCommand, openRun, runOpener, type OpenRun } from '../src/platform/open-folder.ts';

test('a folder opens in the file manager of each platform, as one argument', () => {
  assert.deepEqual(openFolderCommand('C:\\Users\\a b\\Ledung\\accounts\\work', 'win32'), ['explorer.exe', ['C:\\Users\\a b\\Ledung\\accounts\\work']]);
  assert.deepEqual(openFolderCommand('/Users/a b/Library/Application Support/Ledung/accounts/work', 'darwin'), ['open', ['/Users/a b/Library/Application Support/Ledung/accounts/work']]);
  assert.deepEqual(openFolderCommand('/home/a/.local/share/ledung/accounts/work', 'linux'), ['xdg-open', ['/home/a/.local/share/ledung/accounts/work']]);
});

test('Explorer gets backslashes, which is the only way it opens the folder asked for (issue #83)', () => {
  assert.deepEqual(openFolderCommand('C:/Users/a b/Ledung/accounts/work', 'win32'), ['explorer.exe', ['C:\\Users\\a b\\Ledung\\accounts\\work']]);
});

test("Explorer's exit code is not read and its window is not asked to be hidden (issue #83)", () => {
  assert.equal(openRun('win32').exitCodeCounts, false);
  assert.equal(openRun('win32').windowsHide, false);
  assert.equal(openRun('darwin').exitCodeCounts, true);
  assert.equal(openRun('linux').exitCodeCounts, true);
});

const counts: OpenRun = { exitCodeCounts: true, windowsHide: true, stillRunningMs: 20_000 };
const node = (script: string): [string, string[]] => [process.execPath, ['-e', script]];

test('a program that fails is a failure, in its own words (issue #83)', async () => {
  const [command, args] = node("console.error('No application knows how to open it'); process.exit(1)");
  await assert.rejects(runOpener(command, args, counts), { message: 'No application knows how to open it' });
});

test('a program that fails and says nothing still fails, with its exit code', async () => {
  const [command, args] = node('process.exit(3)');
  await assert.rejects(runOpener(command, args, counts), /stopped with 3/);
});

test('a program that cannot be started is a failure, not a crash', async () => {
  await assert.rejects(runOpener('ledung-no-such-program', [], counts), /ENOENT/);
});

test('a program that exits with 0 worked', async () => {
  const [command, args] = node('process.exit(0)');
  await runOpener(command, args, counts);
});

test('an exit code that does not count is not a failure', async () => {
  const [command, args] = node('process.exit(1)');
  await runOpener(command, args, { ...counts, exitCodeCounts: false });
});

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a program still running after the wait counts as having worked, and is left running', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-open-folder-'));
  const pidFile = path.join(dir, 'pid');
  // It would fail if it were waited for to the end, so only the wait can make this resolve.
  const [command, args] = node(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => process.exit(1), 60000)`);
  const waitMs = 1500;
  const started = Date.now();
  let pid = 0;
  try {
    await runOpener(command, args, { ...counts, stillRunningMs: waitMs });
    const waited = Date.now() - started;
    assert.ok(waited >= waitMs - 50 && waited < 30_000, `resolved after ${waited} ms`);
    // A slow start may not have got as far as its file yet.
    for (let i = 0; i < 300 && !fs.existsSync(pidFile); i++) await sleep(100);
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    // A program stopped at the wait takes a moment to go, and until then it still answers.
    await sleep(1000);
    assert.ok(pid > 0 && isRunning(pid), 'the program is left running');
  } finally {
    if (pid && isRunning(pid)) process.kill(pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs `use` with `script` on the PATH as this platform's opener, and Ledung's data folder (exercised.log) in a temporary one. */
async function withStandIn(script: string, use: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-open-folder-'));
  const saved = { PATH: process.env.PATH, LEDUNG_DATA_DIR: process.env.LEDUNG_DATA_DIR };
  fs.writeFileSync(path.join(dir, openFolderCommand('/x')[0]), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${saved.PATH}`;
  process.env.LEDUNG_DATA_DIR = dir;
  try {
    await use(dir);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.LEDUNG_DATA_DIR === undefined) delete process.env.LEDUNG_DATA_DIR;
    else process.env.LEDUNG_DATA_DIR = saved.LEDUNG_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// No stand-in for Explorer on Windows: it is an .exe, and a script can't take its name there.
const realOpener = { skip: process.platform === 'win32' };

test("openFolder gives the opener's failure back in its words (issue #83)", realOpener, async () => {
  await withStandIn('echo "No application knows how to open $1" >&2\nexit 1', async () => {
    await assert.rejects(openFolder('/a b/work'), { message: 'No application knows how to open /a b/work' });
  });
});

test('openFolder passes the folder as one argument, and logs that it ran (issue #83)', realOpener, async () => {
  await withStandIn('printf %s "$1" > "$0.arg"', async (dir) => {
    await openFolder('/a b/work');
    assert.equal(fs.readFileSync(path.join(dir, `${openFolderCommand('/x')[0]}.arg`), 'utf8'), '/a b/work');
    assert.match(fs.readFileSync(path.join(dir, 'exercised.log'), 'utf8'), /EXERCISED #83 /);
  });
});
