// The readable accounts file (issue #425): a "claudeAccounts" block in the config file with plain field names, and an
// ABOUT THIS FOLDER.txt in each account's sign-in folder. Nothing secret in either (#342).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { ABOUT_FILE, aboutText, writeAboutFile } from '../src/accounts/about-file.ts';
import { changedSettings, configProblem, parseConfig, withLiveSettings } from '../src/config.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-accounts-file-')));
// Ledung's data folder is the test's own: the accounts' default sign-in folders are in it.
process.env.LEDUNG_DATA_DIR = path.join(base, 'data');
fs.mkdirSync(process.env.LEDUNG_DATA_DIR, { recursive: true });
const ownFolder = (name: string) => path.join(process.env.LEDUNG_DATA_DIR!, 'accounts', name);
const made: SessionManager[] = [];
after(() => {
  for (const m of made) m.detachAll();
  removeTemp(base);
});

function ledung(store: Store, claudeAccounts: object) {
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', claudeAccounts }), store, () => {}));
  made.push(manager);
  return manager;
}

test('the block reads plain field names, and the "$" notes beside them are only notes', () => {
  const folder = path.join(base, 'signins', 'work');
  const config = parseConfig({
    $claudeAccounts: 'what the block is',
    claudeAccounts: {
      $comment: 'a note in the block',
      work: {
        $whatItIsFor: 'a note', whatItIsFor: 'Company Max plan',
        $signInFolderOnThisComputer: 'a note', signInFolderOnThisComputer: folder,
        $signInFolderInContainers: 'a note', signInFolderInContainers: '/mnt/claude-signins/work',
      },
      personal: {},
    },
  });
  assert.deepEqual(config.claudeAccounts, {
    work: { whatItIsFor: 'Company Max plan', signInFolderOnThisComputer: folder, signInFolderInContainers: '/mnt/claude-signins/work' },
    personal: {},
  });
  assert.deepEqual(parseConfig({}).claudeAccounts, {}, 'a config without the block reads as before');
});

test('a wrongly written block is a readable config error naming the account and the field, not a crash', () => {
  const problem = (claudeAccounts: unknown) => {
    const read = configProblem(JSON.stringify({ claudeAccounts }));
    assert.ok('problem' in read, `refused: ${JSON.stringify(claudeAccounts)}`);
    return read.problem;
  };
  assert.match(problem({ work: { whatItIsFor: 5 } }), /claudeAccounts\.work\.whatItIsFor/);
  assert.match(problem({ work: { signInFolderOnThisComputer: '' } }), /claudeAccounts\.work\.signInFolderOnThisComputer: give a folder, or leave the field out/);
  assert.match(problem({ work: { signInFolderOnThisComputer: 'relative/work' } }), /signInFolderOnThisComputer: give the whole path/);
  assert.match(problem({ work: { signInFolderOnThisComputer: path.join(os.homedir(), '.claude') } }), /this computer's own Claude Code folder/);
  assert.match(problem({ work: { signInFolderInContainers: 'work' } }), /claudeAccounts\.work\.signInFolderInContainers: starts with ~\/ or \//);
  assert.match(problem({ work: { signInFolderInContainers: '~/.claude/' } }), /the container user's own Claude Code folder/);
  assert.match(problem({ work: { signInFolder: '/x' } }), /claudeAccounts\.work.*signInFolder/, 'a misspelt field is not quietly ignored');
  assert.match(problem({ 'my work': {} }), /an account name is letters, digits/);
  assert.match(problem({ default: {} }), /"default" is this computer's own login/);
  assert.match(problem({ work: 'Max plan' }), /claudeAccounts\.work/);
  assert.match(problem(['work']), /claudeAccounts/);
  const shared = path.join(base, 'shared');
  assert.match(problem({ a: { signInFolderOnThisComputer: shared }, b: { signInFolderOnThisComputer: shared } }), /claudeAccounts\.b\.signInFolderOnThisComputer: the same folder as "a"/);
  assert.match(problem({ a: { signInFolderInContainers: '~/s/x' }, b: { signInFolderInContainers: '~/s/x' } }), /claudeAccounts\.b\.signInFolderInContainers: the same folder as "a"/);
});

test("a sign-in folder that can't be made is a problem line, at start and on a live edit, and the other accounts still go through (C1)", () => {
  // A folder under a regular file can never be made (ENOTDIR), on every platform.
  const file = path.join(base, 'signins-c1', 'a-file');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not a folder');
  const blocked = path.join(file, 'work');
  const expected = new RegExp(`^The account "blocked" in the config file: its sign-in folder ${blocked.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} can't be made \\(ENOTDIR\\)\\.$`);

  const atStart = ledung(new Store(openDatabase(':memory:')), { blocked: { signInFolderOnThisComputer: blocked }, fine: {} });
  assert.equal(atStart.accounts.get('blocked'), undefined);
  assert.ok(atStart.accounts.get('fine'), 'the others are added');
  assert.match(atStart.accountsEvent().configFileProblems![0]!, expected);

  const live = ledung(new Store(openDatabase(':memory:')), { work: {} });
  live.checkSignIns = async () => undefined;
  const next = parseConfig({ userName: 'Simon', claudeAccounts: { work: { signInFolderOnThisComputer: path.join(file, 'work-new') }, blocked: { signInFolderOnThisComputer: blocked }, fresh: {} } });
  live.applyConfig(withLiveSettings(live.currentConfig, next), changedSettings(live.currentConfig, next));
  assert.equal(live.accounts.get('work')!.configDir, ownFolder('work'), 'a folder change that fails leaves the account as it was');
  assert.equal(live.accounts.get('blocked'), undefined);
  assert.ok(live.accounts.get('fresh'));
  const problems = live.accountsEvent().configFileProblems!;
  assert.equal(problems.length, 2);
  assert.match(problems[1]!, expected);
  assert.match(problems[0]!, /^The account "work" in the config file: its sign-in folder .* can't be made \(ENOTDIR\)\.$/);
});

test('the example config explains every field of the block beside it and has a worked example that reads', () => {
  const example = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'ledung.config.example.json'), 'utf8'));
  assert.deepEqual(parseConfig(example).claudeAccounts, {}, 'copying the example adds no account');
  assert.equal(typeof example.$claudeAccounts, 'string');
  const worked = example.$claudeAccountsExample;
  for (const field of ['whatItIsFor', 'signInFolderOnThisComputer', 'signInFolderInContainers']) {
    assert.ok(worked.work[field], `the example fills ${field}`);
    assert.equal(typeof worked.work[`$${field}`], 'string', `${field} has its explanation beside it`);
  }
  const read = parseConfig({ claudeAccounts: worked }).claudeAccounts;
  assert.deepEqual(Object.keys(read), ['work', 'personal']);
  assert.equal(read.work?.whatItIsFor, 'Company Max plan');
});

test('accounts in the block are added at start, shown as from the file, and each sign-in folder gets its note with no sign-in in it', () => {
  const store = new Store(openDatabase(':memory:'));
  const workFolder = path.join(base, 'signins-1', 'work');
  // A sign-in Claude Code left in the folder: the note never carries any of it.
  fs.mkdirSync(workFolder, { recursive: true });
  fs.writeFileSync(path.join(workFolder, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-SECRET"}}');
  const manager = ledung(store, {
    work: { whatItIsFor: 'Company Max plan', signInFolderOnThisComputer: workFolder, signInFolderInContainers: '/mnt/claude-signins/work' },
    personal: {},
  });
  const work = manager.accounts.get('work')!;
  assert.equal(work.configDir, workFolder);
  assert.equal(work.containerDir, '/mnt/claude-signins/work');
  assert.equal(manager.accounts.get('personal')!.configDir, ownFolder('personal'));
  assert.equal(manager.accounts.get('personal')!.containerDir, null, 'left out: ~/.ledung-accounts/<name>');

  const shown = manager.accountsEvent().accounts;
  assert.deepEqual(shown.map((a) => [a.name, a.inConfigFile, a.whatItIsFor]), [['personal', true, null], ['work', true, 'Company Max plan']]);
  assert.deepEqual(manager.accountsEvent().configFileProblems, []);

  const note = fs.readFileSync(path.join(workFolder, ABOUT_FILE), 'utf8');
  assert.match(note, /sign-in folder of the Claude account "work"/);
  assert.match(note, /Company Max plan/);
  assert.ok(note.includes(`CLAUDE_SECURESTORAGE_CONFIG_DIR="${workFolder}"`), 'the exact command to sign in');
  assert.ok(note.includes('CLAUDE_SECURESTORAGE_CONFIG_DIR=/mnt/claude-signins/work exec claude'), 'and in a container');
  const signIn = /sk-ant|SECRET|accessToken/;
  assert.ok(signIn.test(fs.readFileSync(path.join(workFolder, '.credentials.json'), 'utf8')), 'the check finds the planted sign-in where it is');
  assert.ok(!signIn.test(note), 'no sign-in in it');
  assert.ok(fs.existsSync(path.join(ownFolder('personal'), ABOUT_FILE)), "Ledung's own folder gets one too");
  // The sign-in file is Claude Code's, and stays as it was.
  assert.equal(fs.readFileSync(path.join(workFolder, '.credentials.json'), 'utf8'), '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-SECRET"}}');
});

test('an account added in the page and not in the block is not marked, and its folder gets its note at the next start', () => {
  const store = new Store(openDatabase(':memory:'));
  const folder = path.join(base, 'signins-2', 'page');
  fs.mkdirSync(folder, { recursive: true });
  // As one added before #425: a row and a folder, no note.
  store.database.prepare('INSERT INTO accounts (name, kind, config_dir, created_at) VALUES (?, ?, ?, ?)').run('page', 'folder', folder, 1);
  const manager = ledung(store, {});
  assert.ok(fs.existsSync(path.join(folder, ABOUT_FILE)));
  const shown = manager.accountsEvent().accounts.find((a) => a.name === 'page')!;
  assert.ok(!shown.inConfigFile);
});

test('removing an account in the page works; it comes back at the next start only while the block still names it', async () => {
  const store = new Store(openDatabase(':memory:'));
  const first = ledung(store, { keep: {}, drop: {} });
  first.signOutWith = async () => undefined;
  await first.removeAccount('keep');
  await first.removeAccount('drop');
  assert.equal(first.accounts.list().length, 0, 'removed in the page');
  // The next start: "keep" is still in the file, "drop" was taken out of it.
  const next = ledung(store, { keep: {} });
  assert.deepEqual(next.accounts.list().map((a) => a.name), ['keep']);
});

test('a changed block applies without a restart: new accounts added, new folders taken, and what cannot be done shown, the rest still done', () => {
  const store = new Store(openDatabase(':memory:'));
  const manager = ledung(store, { work: {} });
  const checked: string[][] = [];
  manager.checkSignIns = async (names) => void checked.push(names ?? []);
  const taken = path.join(base, 'signins-3', 'taken');
  manager.accounts.add({ name: 'page', configDir: taken });
  const moved = path.join(base, 'signins-3', 'work-new');
  const next = parseConfig({ userName: 'Simon', claudeAccounts: {
    work: { whatItIsFor: 'now with a folder', signInFolderOnThisComputer: moved, signInFolderInContainers: '~/signins/work' },
    clash: { signInFolderOnThisComputer: taken },
    fresh: {},
  } });
  manager.applyConfig(withLiveSettings(manager.currentConfig, next), changedSettings(manager.currentConfig, next));

  assert.equal(manager.accounts.get('work')!.configDir, moved);
  assert.equal(manager.accounts.get('work')!.containerDir, '~/signins/work');
  assert.match(fs.readFileSync(path.join(moved, ABOUT_FILE), 'utf8'), /now with a folder/);
  assert.ok(manager.accounts.get('fresh'), 'added');
  assert.equal(manager.accounts.get('clash'), undefined, 'not added on another account\'s folder');
  assert.deepEqual(manager.accountsEvent().configFileProblems, ['The account "clash" in the config file: that login folder is already the login folder of the account "page"; an account needs a folder of its own.']);
  assert.deepEqual(checked, [['fresh', 'work']], 'the new and moved ones are checked for a sign-in');
});

test('the note says how to sign in on each platform, as its editors expect, and is rewritten only when out of date', () => {
  const account = { name: 'work', configDir: 'C:\\Users\\you\\AppData\\Roaming\\Ledung\\accounts\\work', containerDir: '~/.ledung-accounts/work' };
  const win = aboutText(account, 'win32');
  assert.ok(win.includes('run this in PowerShell:\r\n  $env:CLAUDE_SECURESTORAGE_CONFIG_DIR="C:\\Users\\you\\AppData\\Roaming\\Ledung\\accounts\\work"; claude\r\n'));
  assert.match(win, /in the file \.credentials\.json in this folder/);
  assert.ok(win.includes("sh -c 'CLAUDE_SECURESTORAGE_CONFIG_DIR=$HOME/.ledung-accounts/work exec claude'"));
  const mac = aboutText({ ...account, configDir: '/Users/you/Library/Application Support/Ledung/accounts/work' }, 'darwin');
  assert.ok(mac.includes('CLAUDE_SECURESTORAGE_CONFIG_DIR="/Users/you/Library/Application Support/Ledung/accounts/work" claude\n'));
  assert.match(mac, /macOS Keychain, under "Claude Code-credentials-[0-9a-f]{8}"/);
  assert.ok(!mac.includes('\r'));

  const folder = path.join(base, 'signins-4', 'work');
  const here = { ...account, configDir: folder };
  assert.equal(writeAboutFile(here), false, 'a folder that is not there is not made');
  assert.ok(!fs.existsSync(folder));
  fs.mkdirSync(folder, { recursive: true });
  assert.equal(writeAboutFile(here), true);
  assert.equal(writeAboutFile(here), false, 'the same text is left alone');
  fs.writeFileSync(path.join(folder, ABOUT_FILE), 'old text');
  assert.equal(writeAboutFile(here), true, 'an out-of-date one is written again');
  assert.equal(fs.readFileSync(path.join(folder, ABOUT_FILE), 'utf8'), aboutText(here));
});
