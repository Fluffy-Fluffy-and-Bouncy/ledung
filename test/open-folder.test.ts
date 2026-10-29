// Settings' Open folder (issue #414): Finder on macOS, Explorer on Windows, xdg-open elsewhere, with the folder as
// one argument and no shell in between.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openFolderCommand } from '../src/platform/open-folder.ts';

test('a folder opens in the file manager of each platform, as one argument', () => {
  assert.deepEqual(openFolderCommand('C:\\Users\\a b\\Ledung\\accounts\\work', 'win32'), ['explorer.exe', ['C:\\Users\\a b\\Ledung\\accounts\\work']]);
  assert.deepEqual(openFolderCommand('/Users/a b/Library/Application Support/Ledung/accounts/work', 'darwin'), ['open', ['/Users/a b/Library/Application Support/Ledung/accounts/work']]);
  assert.deepEqual(openFolderCommand('/home/a/.local/share/ledung/accounts/work', 'linux'), ['xdg-open', ['/home/a/.local/share/ledung/accounts/work']]);
});
