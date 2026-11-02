// Settings' Open folder (issue #414): Finder on macOS, Explorer on Windows, xdg-open elsewhere, with the folder as
// one argument and no shell in between. How it went is looked at (issue #82), with real programs here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openFolderCommand, openRun, runOpener, type OpenRun } from '../src/platform/open-folder.ts';

test('a folder opens in the file manager of each platform, as one argument', () => {
  assert.deepEqual(openFolderCommand('C:\\Users\\a b\\Ledung\\accounts\\work', 'win32'), ['explorer.exe', ['C:\\Users\\a b\\Ledung\\accounts\\work']]);
  assert.deepEqual(openFolderCommand('/Users/a b/Library/Application Support/Ledung/accounts/work', 'darwin'), ['open', ['/Users/a b/Library/Application Support/Ledung/accounts/work']]);
  assert.deepEqual(openFolderCommand('/home/a/.local/share/ledung/accounts/work', 'linux'), ['xdg-open', ['/home/a/.local/share/ledung/accounts/work']]);
});

test('Explorer gets backslashes, which is the only way it opens the folder asked for (issue #82)', () => {
  assert.deepEqual(openFolderCommand('C:/Users/a b/Ledung/accounts/work', 'win32'), ['explorer.exe', ['C:\\Users\\a b\\Ledung\\accounts\\work']]);
});

test("Explorer's exit code is not read and its window is not asked to be hidden (issue #82)", () => {
  assert.equal(openRun('win32').exitCodeCounts, false);
  assert.equal(openRun('win32').windowsHide, false);
  assert.equal(openRun('darwin').exitCodeCounts, true);
  assert.equal(openRun('linux').exitCodeCounts, true);
});

const counts: OpenRun = { exitCodeCounts: true, windowsHide: true, stillRunningMs: 20_000 };
const node = (script: string): [string, string[]] => [process.execPath, ['-e', script]];

test('a program that fails is a failure, in its own words (issue #82)', async () => {
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

test('a program still running after the wait counts as having worked, and is left running', async () => {
  const [command, args] = node('setTimeout(() => {}, 2000)');
  await runOpener(command, args, { ...counts, stillRunningMs: 100 });
});
