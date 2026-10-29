// Issue #213: elevated commands on Windows (Martin, 2026-10-18, question #295, option a). gsudo, sudo,
// `Start-Process … -Verb RunAs` and `runas` are suggested sensitive patterns, so they are asked in every mode
// (also through the PowerShell tool); the permission card says they raise UAC on the PC and offers "Deny: not
// at the PC"; the status line says the command may be waiting for UAC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchSensitive, sensitiveHookOutput } from '../src/sessions/sensitive.ts';
import { LATER_SUGGESTIONS, SUGGESTIONS, withSuggestions } from '../src/shared/sensitive-suggestions.ts';
import { NOT_AT_PC, STOP_NOTE, UAC_HINT, UAC_NOTE, elevates, raisesUac } from '../src/shared/elevation.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { ProjectStore } from '../src/projects/store.ts';

// A new project's list: the suggestions, as ordinary entries.
const rules = withSuggestions({ commandPatterns: [] as string[], pathPatterns: [] as string[], mcpTools: [] as string[] });
const bash = (command: string) => matchSensitive('Bash', { command }, rules)?.rule ?? null;
const ps = (command: string) => matchSensitive('PowerShell', { command }, rules)?.rule ?? null;
const SUDO = 'Elevated commands with gsudo or sudo';
const RUNAS = 'Starting a program as administrator (-Verb RunAs, runas)';

test('the suggestions include elevation: gsudo, sudo, -Verb RunAs and runas', () => {
  const names = SUGGESTIONS.map((s) => s.name);
  assert.ok(names.includes(SUDO));
  assert.ok(names.includes(RUNAS));
});

test('elevated commands in Bash form are sensitive', () => {
  assert.equal(bash('gsudo netstat -abno'), SUDO);
  assert.equal(bash('gsudo.exe whoami'), SUDO);
  assert.equal(bash('sudo apt-get install -y jq'), SUDO);
  assert.equal(bash('cd /tmp && sudo systemctl restart nginx'), SUDO);
  assert.equal(bash('runas /user:Administrator cmd'), RUNAS);
  assert.equal(bash('powershell -Command "Start-Process pwsh -Verb RunAs"'), RUNAS);
});

test('elevated commands in PowerShell form are sensitive, through the PowerShell tool', () => {
  assert.equal(ps("Start-Process pwsh -Verb RunAs -ArgumentList '-NoExit'"), RUNAS);
  assert.equal(ps('Start-Process notepad -Verb:RunAs'), RUNAS);
  assert.equal(ps("saps cmd -verb 'runas'"), RUNAS);
  assert.equal(ps('& "C:\\Program Files\\gsudo\\Current\\gsudo.exe" Get-Service'), SUDO);
  assert.equal(ps('sudo netsh winsock reset'), SUDO);
  assert.equal(ps('runas.exe /user:Administrator cmd'), RUNAS);
});

test('a PowerShell call is checked against every command pattern, not only elevation', () => {
  assert.equal(ps('git push --force origin feature'), 'Pushing to main or master, or force-pushing');
});

test('words that only look like elevation are not', () => {
  assert.equal(bash('cat /etc/sudoers.d/README'), null);
  assert.equal(bash('ls docs/sudo-notes.md'), null);
  assert.equal(bash('visudo -c'), null);
  assert.equal(bash('echo "run gsudo later"'), null);
  assert.equal(ps('Get-ChildItem C:\\pseudocode'), null);
  assert.equal(ps('Start-Process notepad'), null);
});

test('an elevated call is asked in every permission mode (the PreToolUse hook says ask)', () => {
  for (const [tool, command] of [['Bash', 'gsudo whoami'], ['PowerShell', 'Start-Process cmd -Verb RunAs']] as const) {
    const out = sensitiveHookOutput(tool, { command }, rules) as { hookSpecificOutput?: { permissionDecision?: string } };
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'ask', `${tool}: ${command}`);
  }
});

test('elevation is copied once into projects that got the first suggestions before it; deleted, it stays deleted', () => {
  const db = new Store(openDatabase(':memory:')).database;
  const projects = new ProjectStore(db);
  // A database from before #213: the first copy ran, and the project's list has the older suggestions.
  db.prepare("INSERT INTO meta (key, value) VALUES ('sensitive-suggestions-added', 'before')").run();
  const elevation = LATER_SUGGESTIONS.flatMap((b) => b.commandPatterns);
  const older = rules.commandPatterns.filter((p) => !elevation.includes(p));
  projects.add({ name: 'old', runner: 'local', path: 'C:/p/old', sensitive: { commandPatterns: ['mine', ...older], pathPatterns: [], mcpTools: [] } });
  assert.equal(projects.addSuggestionsOnce(), 1);
  const list = projects.get('old')!.config.sensitive.commandPatterns;
  assert.deepEqual(list, ['mine', ...older, ...elevation]);
  // The user deletes them; a later start leaves them deleted.
  const config = projects.get('old')!.config;
  projects.update('old', { ...config, sensitive: { ...config.sensitive, commandPatterns: ['mine', ...older] } });
  assert.equal(projects.addSuggestionsOnce(), 0);
  assert.deepEqual(projects.get('old')!.config.sensitive.commandPatterns, ['mine', ...older]);
});

test('UAC is raised only for a session on this PC with Ledung on Windows', () => {
  assert.equal(raisesUac('local', 'win32'), true);
  assert.equal(raisesUac('docker', 'win32'), false);
  assert.equal(raisesUac('local', 'darwin'), false);
  assert.equal(elevates('PowerShell', { command: 'Start-Process cmd -Verb RunAs' }), true);
  assert.equal(elevates('Bash', { command: 'git status' }), false);
  assert.equal(elevates('Read', { file_path: 'C:/gsudo/notes.txt' }), false);
});

test('a permission and a session carry whether an elevation raises UAC on this PC', () => {
  const store = new Store(openDatabase(':memory:'));
  store.createSession({ id: 'pc', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default' });
  store.createSession({ id: 'box', project: 'p', runner: 'docker', title: 't', parentId: null, permissionMode: 'default' });
  const ask = (id: string, sessionId: string, command: string) =>
    store.createPermission({ id, sessionId, toolName: 'Bash', input: { command }, title: null, reason: null, sensitive: SUDO });
  const windows = process.platform === 'win32';
  assert.equal(ask('a', 'pc', 'gsudo whoami').uac, windows);
  assert.equal(ask('b', 'box', 'sudo whoami').uac, false);
  assert.equal(ask('c', 'pc', 'git status').uac, false);
  assert.equal(store.pendingPermissions().find((p) => p.id === 'a')!.uac, windows);
  assert.equal(store.getSession('pc')!.uac, windows);
  assert.equal(store.getSession('box')!.uac, false);
});

test('the words on the card and the status line are the ones the issue asks for', () => {
  assert.equal(UAC_NOTE, "This raises a UAC prompt on the PC's desktop; allow it only when you are at the PC.");
  assert.equal(UAC_HINT, 'may be waiting for UAC on the PC');
  assert.match(STOP_NOTE, /Stop may not end/);
  assert.match(NOT_AT_PC, /not at the PC/);
});

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('the permission card shows the UAC note and a "Deny: not at the PC" answer for such a call', () => {
  const card = read('web/src/components/PermissionCard.tsx');
  assert.match(card, /permission\.uac && \(\s*<p[^>]*>[\s\S]*?\{UAC_NOTE\}[\s\S]*?\{STOP_NOTE\}/);
  assert.match(card, /permission\.uac && \(\s*<button[^>]*onClick=\{\(\) => decide\('deny', 'once', NOT_AT_PC\)\}>\s*Deny: not at the PC/);
});

test('the status line says "may be waiting for UAC on the PC" while such a command runs', () => {
  const line = read('web/src/components/WorkingIndicator.tsx');
  assert.match(line, /uacWait: uac && elevates\(b\.name, b\.input \?\? \{\}\)/);
  assert.match(line, /activity\.uacWait && <span className="uac-hint"> · \{UAC_HINT\}<\/span>/);
  assert.match(line, /currentActivity\(messages, !!session\.uac\)/);
});
