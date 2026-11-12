// Project-Ledung#473, first Done bullet (Martin, 2026-11-12, Ledung question #2056): Ledung's own data folder is a
// sensitive path in every project, whatever its lists say. A shell command or a file tool call that names it is asked.
// The folders are the platforms' own (src/platform/paths.ts) and the ways of naming them are the shells' own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// This Ledung's data folder, as a test Ledung sets it; before the first check, which reads it once.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-473-'));
process.env.LEDUNG_DATA_DIR = DATA;
const { DATA_FOLDER_RULE, dataFolderPattern, matchSensitive, pathText } = await import('../src/sessions/sensitive.ts');

const names = (re: RegExp, text: string) => re.test(pathText(text));

test('#473: Windows: the data folder is found however a command names it', () => {
  const re = dataFolderPattern({ dir: 'C:\\Users\\m\\AppData\\Roaming\\Ledung', home: 'C:\\Users\\m', appData: 'C:\\Users\\m\\AppData\\Roaming' });
  const loud = [
    'type %APPDATA%\\Ledung\\auth-token',
    'type %appdata%\\ledung\\auth-token',
    'type %APPDATA%\\Led^ung\\auth-token',
    'Get-Content $env:APPDATA\\Ledung\\auth-token',
    'Get-Content "${env:APPDATA}\\Ledung\\secrets.enc"',
    'type "%USERPROFILE%\\AppData\\Roaming\\Ledung\\auth-token"',
    'Get-Content $env:USERPROFILE\\AppData\\Roaming\\Ledung\\auth-token',
    'type C:\\Users\\m\\AppData\\Roaming\\Ledung\\auth-token',
    'cat /c/Users/m/AppData/Roaming/Ledung/auth-token',
    'cat ~/AppData/Roaming/Ledung/auth-token',
    'cat "$APPDATA/Ledung/auth-token"',
    'dir C:\\Users\\m\\AppData\\Roaming\\Ledung',
    'C:/Users/m/AppData/Roaming/Ledung/remote/tls.key',
  ];
  for (const c of loud) assert.ok(names(re, c), c);
  const quiet = [
    'type %APPDATA%\\Ledung-old\\auth-token', 'type %APPDATA%\\Code\\settings.json', 'dir C:\\Users\\m\\claude-project\\ledung',
    'Get-Content C:\\Users\\m\\AppData\\Roaming\\LedungX\\x', 'npm run check',
  ];
  for (const c of quiet) assert.equal(names(re, c), false, c);
});

test('#473: macOS and Linux: the data folder is found however a command names it', () => {
  const mac = dataFolderPattern({ dir: '/Users/m/Library/Application Support/Ledung', home: '/Users/m' });
  for (const c of [
    'cat ~/Library/Application\\ Support/Ledung/auth-token',
    'cat "$HOME/Library/Application Support/Ledung/auth-token"',
    'cat ~/Library/"Application Support"/Ledung/auth-token',
    "ls '/Users/m/Library/Application Support/Ledung'",
    'cat ${HOME}/Library/Application\\ Support/ledung/auth-token',
  ]) assert.ok(names(mac, c), c);
  for (const c of ['cat ~/Library/Application\\ Support/Code/x', 'cd ~/claude-project/project-ledung && npm test', 'cat /Users/other/Library/Application\\ Support/Ledung/x']) {
    assert.equal(names(mac, c), false, c);
  }
  const linux = dataFolderPattern({ dir: '/home/m/.data/ledung', home: '/home/m', xdgData: '/home/m/.data' });
  for (const c of ['cat $XDG_DATA_HOME/ledung/auth-token', 'cat ~/.data/ledung/auth-token', 'cat /home/m/.data/ledung/auth-token']) assert.ok(names(linux, c), c);
  assert.equal(names(linux, 'cat ~/.data/other/x'), false);
});

test("#473: this Ledung's data folder is asked in every project, by shell and file tools, whatever the lists say", () => {
  const empty = { commandPatterns: [], pathPatterns: [], mcpTools: [] };
  const token = path.join(DATA, 'auth-token');
  assert.deepEqual(matchSensitive('Bash', { command: `cat '${token}'` }, empty), { rule: DATA_FOLDER_RULE });
  assert.deepEqual(matchSensitive('Bash', { command: `ls ${DATA}` }, {}), { rule: DATA_FOLDER_RULE });
  assert.deepEqual(matchSensitive('PowerShell', { command: `Get-Content "${token}"` }, empty), { rule: DATA_FOLDER_RULE });
  assert.deepEqual(matchSensitive('Read', { file_path: token }, empty), { rule: DATA_FOLDER_RULE });
  assert.deepEqual(matchSensitive('Grep', { pattern: 'x', path: DATA }, empty), { rule: DATA_FOLDER_RULE });
  // A folder beside it, or any other, is not (positive branch above).
  assert.equal(matchSensitive('Bash', { command: `cat ${DATA}-old/auth-token` }, empty), null);
  assert.equal(matchSensitive('Read', { file_path: path.join(os.tmpdir(), 'other', 'auth-token') }, empty), null);
  assert.equal(matchSensitive('Bash', { command: 'npm run check' }, empty), null);
});
