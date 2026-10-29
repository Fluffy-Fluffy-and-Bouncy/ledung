// Live reload of the config file (issue #353): a live change applies at once, a restart-only one is named for the
// page, a bad file is refused with the running settings kept, an editor's temp-file-and-rename save is seen, and
// running sessions keep what they started with.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedSettings, configProblem, parseConfig, SETTING_RELOAD, withLiveSettings, type LedungConfig, type SettingName } from '../src/config.ts';
import { ConfigWatcher } from '../src/config-watch.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import type { ConfigStatus } from '../src/shared/protocol.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

// The real long path (issue #388): plain realpathSync leaves a Windows 8.3 short name such as ADMINI~1 as it is.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-config-watch-')));
const watchers: ConfigWatcher[] = [];
const managers: SessionManager[] = [];
const prepare = LocalRunner.prototype.prepare;
after(() => {
  LocalRunner.prototype.prepare = prepare;
  for (const w of watchers) w.stop();
  for (const m of managers) m.detachAll();
  removeTemp(base);
});

let n = 0;
function setup(raw: object, given?: (real: string) => string, pollMs = 0) {
  let file = path.join(base, `config-${++n}`, 'ledung.config.local.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // The watcher is given the file in another form (through a link, or the temp folder as the system names it).
  if (given) file = given(file);
  const write = (o: object | string) => fs.writeFileSync(file, typeof o === 'string' ? o : JSON.stringify(o, null, 2));
  write(raw);
  const applied: { config: LedungConfig; changed: SettingName[] }[] = [];
  const statuses: ConfigStatus[] = [];
  const logs: string[] = [];
  const watcher = new ConfigWatcher({
    // No backstop unless a test asks for it: the watch tests must prove the watch.
    file, started: parseConfig(raw), debounceMs: 20, pollMs, log: (line) => logs.push(line),
    apply: (config, changed) => applied.push({ config, changed }),
    onStatus: (s) => statuses.push(s),
  });
  watchers.push(watcher);
  return { file, write, watcher, applied, statuses, logs };
}

test('every setting is either live or restart-only, and the restart-only ones are what the server binds at start', () => {
  // The type already makes a new setting pick one; this pins the issue's list of what needs a restart.
  const restart = Object.entries(SETTING_RELOAD).filter(([, how]) => how === 'restart').map(([k]) => k).sort();
  assert.deepEqual(restart, ['board', 'computers', 'lan', 'lanSignIn', 'port', 'relayJoin', 'remote', 'userName']);
  for (const k of ['keepToolResultsDays', 'pluginsOff', 'remoteControl', 'profiles', 'defaultProfiles', 'workflow', 'workflows', 'usageStops', 'idleStopMinutes'] as const) {
    assert.equal(SETTING_RELOAD[k], 'live', k);
  }
});

test('a live change applies at once and the status says when it was reloaded', () => {
  const { write, watcher, applied, statuses } = setup({ port: 4396, keepToolResultsDays: 14 });
  assert.equal(watcher.status().reloaded, false);
  write({ port: 4396, keepToolResultsDays: 3, pluginsOff: ['x@y'] });
  assert.equal(watcher.check(), true);
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0]!.changed, ['keepToolResultsDays', 'pluginsOff']);
  assert.equal(applied[0]!.config.keepToolResultsDays, 3);
  assert.deepEqual(applied[0]!.config.pluginsOff, ['x@y']);
  assert.equal(statuses.at(-1)!.reloaded, true);
  assert.equal(statuses.at(-1)!.problem, null);
  assert.deepEqual(statuses.at(-1)!.restartFor, []);
  assert.equal(watcher.check(), false, 'the same file again is no change');
});

test('a restart-only change is not applied and is named for the page; changing it back clears the note', () => {
  const { write, watcher, applied } = setup({ port: 4396, lan: false });
  write({ port: 4397, lan: '192.168.1.20', idleStopMinutes: 5 });
  watcher.check();
  assert.deepEqual(applied.at(-1)!.changed, ['idleStopMinutes'], 'only the live one');
  assert.equal(applied.at(-1)!.config.port, 4396, 'the running port stays');
  assert.equal(applied.at(-1)!.config.lan, false);
  assert.deepEqual(watcher.status().restartFor, ['port', 'lan']);
  write({ port: 4396, lan: false, idleStopMinutes: 5 });
  watcher.check();
  assert.deepEqual(watcher.status().restartFor, []);
});

test('a bad file is refused: the running settings stay and the page gets one line without the file\'s text', () => {
  const { write, watcher, applied, statuses } = setup({ port: 4396, keepToolResultsDays: 14 });
  write('{\n  "port": 4396,\n  "remote": { "secret": s3cr3t-value }\n}');
  watcher.check();
  assert.equal(applied.length, 0);
  const problem = statuses.at(-1)!.problem!;
  assert.match(problem, /not valid JSON/);
  assert.doesNotMatch(problem, /s3cr3t/, 'V8 quotes the text around the error; the page never gets it');
  assert.doesNotMatch(problem, /\n/);

  write({ port: 4396, keepToolResultsDays: 0 });
  watcher.check();
  assert.equal(applied.length, 0);
  assert.match(watcher.status().problem!, /^The config has problems: keepToolResultsDays: /);
  assert.equal(watcher.status().reloaded, false, 'still the settings read at start');

  // Fixed: applied, and the problem goes.
  write({ port: 4396, keepToolResultsDays: 7 });
  watcher.check();
  assert.equal(applied.at(-1)!.config.keepToolResultsDays, 7);
  assert.equal(watcher.status().problem, null);
});

test('the problem line keeps a JSON error\'s place but not its text', () => {
  const r = configProblem('{\n  "a": 1,\n}');
  assert.ok('problem' in r);
  assert.match(r.problem, /^The config file is not valid JSON at line 3, column 1\.$/);
});

test('a save that writes a temp file and renames it over the config is seen and applied', async () => {
  const { file, watcher, applied } = setup({ port: 4396, keepToolResultsDays: 14 });
  watcher.start();
  await saveByRename(file, { port: 4396, keepToolResultsDays: 2 }, applied);
  assert.equal(applied.length, 1, 'the rename was seen');
  assert.equal(applied[0]!.config.keepToolResultsDays, 2);
  // A second save the same way is seen too: the watch is on the folder, not on the file that was replaced. The watch
  // is live by now, so one save is enough.
  const tmp = `${file}.tmp-save`;
  fs.writeFileSync(tmp, JSON.stringify({ port: 4396, keepToolResultsDays: 9 }));
  fs.renameSync(tmp, file);
  for (let i = 0; i < 200 && applied.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(applied.length, 2, 'the second rename was seen');
  assert.equal(applied.at(-1)!.config.keepToolResultsDays, 9);
});

test('a save the watch misses is found by the stat backstop: a rename over the file, then an edit in place', async () => {
  const { file, watcher, applied } = setup({ port: 4396, keepToolResultsDays: 14 }, undefined, 50);
  watcher.start();
  // As if the watch had missed everything (issue #358: macOS drops what is saved before its watch is live).
  (watcher as unknown as { watcher: fs.FSWatcher }).watcher.close();
  const tmp = `${file}.tmp-save`;
  fs.writeFileSync(tmp, JSON.stringify({ port: 4396, keepToolResultsDays: 3 }));
  fs.renameSync(tmp, file);
  for (let i = 0; i < 200 && !applied.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(applied.length, 1, 'the rename was found');
  assert.equal(applied[0]!.config.keepToolResultsDays, 3);
  fs.writeFileSync(file, JSON.stringify({ port: 4396, keepToolResultsDays: 12 }));
  for (let i = 0; i < 200 && applied.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(applied.length, 2, 'the edit in place was found');
  assert.equal(applied[1]!.config.keepToolResultsDays, 12);
});

/**
 * Saves the config the way an editor does, a temp file renamed over it in its real folder, and waits until it applies.
 * On macOS the folder watch goes live a moment after it starts and drops a save made before that (issue #358), so
 * the save is repeated until the watch reports one: the test waits for the watch, not for a fixed time.
 */
async function saveByRename(realFile: string, raw: object, applied: unknown[]) {
  const before = applied.length;
  const tmp = `${realFile}.tmp-save`;
  for (let attempt = 0; attempt < 40 && applied.length === before; attempt++) {
    fs.writeFileSync(tmp, JSON.stringify(raw));
    fs.renameSync(tmp, realFile);
    for (let i = 0; i < 10 && applied.length === before; i++) await new Promise((r) => setTimeout(r, 50));
  }
}

// Issue #388: on Windows a TEMP of C:\Users\ADMINI~1\... made libuv abort the process inside fs.watch. Here the config
// path is the temp folder as the system gives it; on a Mac that is /var/folders/..., a link to /private/var/....
const givenTemp = path.join(os.tmpdir(), path.basename(base));
test('a config path given in another form than its real path is watched at the real path, and a change is seen', {
  skip: givenTemp === base ? `the temp folder is already its real path here (${os.tmpdir()})` : false,
}, async () => {
  const { file, watcher, applied, logs } = setup({ port: 4396, keepToolResultsDays: 14 }, (real) => path.join(givenTemp, path.relative(base, real)));
  assert.notEqual(file, fs.realpathSync.native(file), 'the test gives a path that is not the real one');
  watcher.start();
  assert.deepEqual(watcher.watched(), { dir: path.dirname(fs.realpathSync.native(file)), name: 'ledung.config.local.json' });
  assert.deepEqual(logs, []);
  await saveByRename(fs.realpathSync.native(file), { port: 4396, keepToolResultsDays: 4 }, applied);
  assert.equal(applied.at(-1)?.config.keepToolResultsDays, 4);
});

test('on Windows, a temp folder given by its 8.3 short name is watched by its long name and a change is seen', {
  skip: process.platform !== 'win32' ? 'only Windows has 8.3 short names'
    : !os.tmpdir().includes('~') ? `this PC's temp folder has no 8.3 short name (${os.tmpdir()})` : false,
}, async () => {
  const { file, watcher, applied } = setup({ port: 4396, keepToolResultsDays: 14 }, (real) => path.join(givenTemp, path.relative(base, real)));
  watcher.start();
  assert.ok(!watcher.watched()!.dir.includes('~'), `watched ${watcher.watched()!.dir}`);
  await saveByRename(fs.realpathSync.native(file), { port: 4396, keepToolResultsDays: 5 }, applied);
  assert.equal(applied.at(-1)?.config.keepToolResultsDays, 5);
});

test('a config file given through a link is watched where the file really is, so an edit of the real file is seen', {
  skip: process.platform === 'win32' ? 'a file link needs Developer Mode or an administrator on Windows' : false,
}, async () => {
  const links = path.join(base, 'links');
  fs.mkdirSync(links, { recursive: true });
  let real = '';
  const { file, watcher, applied } = setup({ port: 4396, keepToolResultsDays: 14 }, (r) => {
    real = r;
    const link = path.join(links, `linked-${n}.json`);
    fs.symlinkSync(r, link);
    return link;
  });
  watcher.start();
  assert.deepEqual(watcher.watched(), { dir: path.dirname(real), name: path.basename(real) });
  // Saved in the real file's folder, which a watch on the link's folder never hears about.
  await saveByRename(real, { port: 4396, keepToolResultsDays: 6 }, applied);
  assert.equal(applied.at(-1)?.config.keepToolResultsDays, 6);
  assert.equal(fs.readlinkSync(file), real);
});

test('a config folder whose real path can\'t be found is not watched: one line says changes need a restart, nothing aborts', () => {
  const file = path.join(base, 'no-such-folder', 'ledung.config.local.json');
  const logs: string[] = [];
  const watcher = new ConfigWatcher({ file, started: parseConfig({}), apply: () => {}, log: (line) => logs.push(line) });
  watchers.push(watcher);
  watcher.start();
  assert.equal(watcher.watched(), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^The config file can't be watched, so changes need Restart Ledung: /);
});

test('every fs.watch in the source is given a path resolved by realpathSync.native first (issue #388)', () => {
  // libuv aborts on an 8.3 short name, past any try/catch; a path straight from the caller must never reach it.
  const src = path.join(import.meta.dirname, '..', 'src');
  const files = (fs.readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
  const calls: string[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(src, f), 'utf8');
    for (const m of text.matchAll(/\bfs\.watch(?:File)?\(\s*([^,)]*)/g)) {
      calls.push(f);
      assert.match(text, /realpathSync\.native\(/, `${f} watches without resolving the real path`);
      assert.doesNotMatch(m[1]!, /path\.|opts|\(/, `${f}: fs.watch(${m[1]}) is given an unresolved path`);
    }
  }
  assert.ok(calls.length >= 1, 'the config watcher still uses fs.watch');
});

test('withLiveSettings keeps restart-only values and takes live ones; changedSettings names what differs', () => {
  const running = parseConfig({ port: 4396, userName: 'Simon', remoteControl: true });
  const next = parseConfig({ port: 4000, userName: 'Sam', remoteControl: false });
  const merged = withLiveSettings(running, next);
  assert.equal(merged.port, 4396);
  assert.equal(merged.userName, 'Simon');
  assert.equal(merged.remoteControl, false);
  assert.deepEqual(changedSettings(running, next), ['port', 'userName', 'remoteControl']);
});

test('running sessions keep what they started with; a session started after the change gets the new settings', async () => {
  // The first start hangs in its runner, so that session is still starting while the config changes.
  let calls = 0;
  LocalRunner.prototype.prepare = function () {
    calls++;
    return calls === 1 ? new Promise<never>(() => {}) : Promise.reject(new Error('no Claude Code in tests'));
  };
  const folder = path.join(base, 'project');
  fs.mkdirSync(folder, { recursive: true });
  const raw = { userName: 'Simon', browseRoots: [base], pluginsOff: ['old@x'], sensitive: { commandPatterns: ['\\bold-rule\\b'] }, projects: [{ name: 'p', runner: 'local', path: folder }] };
  const manager = refuseRealSignInStores(new SessionManager(parseConfig(raw), new Store(openDatabase(':memory:')), () => {}));
  managers.push(manager);
  type Live = { pluginsOff: string[]; sensitiveRules: { commandPatterns?: string[] } };
  const live = (manager as unknown as { live: Map<string, Live> }).live;
  void manager.start('p');
  for (let i = 0; i < 100 && !live.size; i++) await new Promise((r) => setTimeout(r, 10));
  const [runningId, running] = [...live.entries()][0]!;

  const next = parseConfig({ ...raw, pluginsOff: ['new@x'], sensitive: { commandPatterns: ['\\bnew-rule\\b'] } });
  manager.applyConfig(withLiveSettings(manager.currentConfig, next), changedSettings(manager.currentConfig, next));
  assert.deepEqual(running.pluginsOff, ['old@x'], 'the running session keeps its plugins');
  // The project's patterns, Ledung's suggestions, come after the config's own.
  assert.equal(running.sensitiveRules.commandPatterns![0], '\\bold-rule\\b', 'and its sensitive patterns');
  assert.ok(!running.sensitiveRules.commandPatterns!.includes('\\bnew-rule\\b'));

  const after = await manager.start('p');
  const fresh = live.get(after.id)!;
  assert.notEqual(after.id, runningId);
  assert.deepEqual(fresh.pluginsOff, ['new@x']);
  assert.equal(fresh.sensitiveRules.commandPatterns![0], '\\bnew-rule\\b');
});
