// scripts/release.ts, run for real on a small source in a temp folder (#100, review of PR #101):
// a release whose check fails leaves current.json pointing at the running release, and one that
// passes points it at the new release and records the commit it was built from. Pruning old
// releases keeps every one something still runs from (#117).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDir } from '../src/platform/paths.ts';
import { releasesToRemove } from '../src/update/releases.ts';
import { removeTemp } from './temp.ts';

let base: string;
let source: string;
let dataDir: string;
const running = JSON.stringify({ dir: '/the/running/release', source: 'x' });

/** A source with Ledung's own src and release script, and a check and build that are quick stand-ins. */
function makeSource(check: string): void {
  removeTemp(source);
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.cpSync(path.join(appDir(), 'src'), path.join(source, 'src'), { recursive: true });
  fs.cpSync(path.join(appDir(), 'scripts', 'release.ts'), path.join(source, 'scripts', 'release.ts'));
  // src imports zod and friends; the release's own install has nothing to fetch.
  fs.symlinkSync(path.join(appDir(), 'node_modules'), path.join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const pkg = {
    name: 'release-test', version: '0.0.0', private: true, type: 'module',
    scripts: { check: check, build: "node -e \"require('fs').mkdirSync('web/dist', { recursive: true })\"" },
  };
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ name: 'release-test', version: '0.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'release-test', version: '0.0.0' } } }));
  fs.writeFileSync(path.join(source, '.gitignore'), 'node_modules\n');
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: source });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'source');
}

function release(data = dataDir) {
  const env: Record<string, string | undefined> = { ...process.env, LEDUNG_DATA_DIR: data, LEDUNG_CONFIG: path.join(base, 'config.json') };
  return spawnSync(process.execPath, [path.join(source, 'scripts', 'release.ts')], { cwd: source, env, encoding: 'utf8' });
}

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-release-'));
  source = path.join(base, 'source');
  dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir);
});

after(() => removeTemp(base));

test('a release whose check fails leaves current.json pointing at the running release', () => {
  makeSource('node -e "process.exit(1)"');
  fs.writeFileSync(path.join(dataDir, 'current.json'), running);
  const r = release();
  assert.notEqual(r.status, 0, 'the release stops');
  assert.equal(fs.readFileSync(path.join(dataDir, 'current.json'), 'utf8'), running);
  assert.ok(!fs.existsSync(path.join(dataDir, 'app')), 'no release folder was made');
});

test('a release that passes points current.json at itself and records its commit', () => {
  makeSource('node -e ""');
  fs.writeFileSync(path.join(dataDir, 'current.json'), running);
  const r = release();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const current = JSON.parse(fs.readFileSync(path.join(dataDir, 'current.json'), 'utf8'));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).stdout.trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(current.commit, head);
  assert.equal(path.dirname(current.dir), path.join(dataDir, 'app'));
  const own = JSON.parse(fs.readFileSync(path.join(current.dir, 'release.json'), 'utf8'));
  assert.equal(own.commit, head);
  // The release names its folder by where its script sits; macOS's temp folder is behind a symlink.
  assert.equal(fs.realpathSync(own.source), fs.realpathSync(source));
});

// Update Ledung runs the release with LEDUNG_DATA_DIR and LEDUNG_CONFIG set to the running Ledung's real ones, so the
// release lands there; the tests the check runs must not see them (issue #435). The stand-in check fails on any.
test('the check runs without the LEDUNG_* settings, which only say where the release lands (#435)', () => {
  makeSource(`node -e "const k = Object.keys(process.env).filter((n) => n.startsWith('LEDUNG_')); if (k.length) { console.log('check saw ' + k.join(' ')); process.exit(1); }"`);
  const r = release();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const current = JSON.parse(fs.readFileSync(path.join(dataDir, 'current.json'), 'utf8'));
  assert.equal(path.dirname(current.dir), path.join(dataDir, 'app'), 'the release is in LEDUNG_DATA_DIR');
  assert.equal(current.config, path.join(base, 'config.json'), 'and runs with LEDUNG_CONFIG');
});

test('a release keeps the old releases a running Ledung or session host runs from (#117)', (t) => {
  makeSource('node -e ""');
  // A data folder reached through a link in another folder, so neither spelling of it contains the other.
  const real = path.join(base, 'real', 'data');
  const link = path.join(base, 'data-link');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  const app = path.join(link, 'app');
  // Five older releases; the oldest runs a Ledung and the next a session host, started the way the
  // launcher and a session start them: node with the release's own script, the launcher's path as
  // current.json has it and the host's by its real path (Node resolves the script it runs).
  const old = ['20200101-000001', '20200101-000002', '20200101-000003', '20200101-000004', '20200101-000005'];
  const scripts = [path.join('src', 'main.ts'), path.join('src', 'host', 'host.ts')];
  for (const name of old) {
    for (const script of scripts) {
      fs.mkdirSync(path.dirname(path.join(app, name, script)), { recursive: true });
      fs.writeFileSync(path.join(app, name, script), 'setInterval(() => {}, 1000);\n');
    }
  }
  const children = [
    spawn(process.execPath, [path.join(app, old[0]!, scripts[0]!)], { stdio: 'ignore' }),
    spawn(process.execPath, [fs.realpathSync(path.join(app, old[1]!, scripts[1]!))], { stdio: 'ignore' }),
  ];
  t.after(() => children.forEach((c) => c.kill()));
  const r = release(link);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const current = path.basename(JSON.parse(fs.readFileSync(path.join(link, 'current.json'), 'utf8')).dir);
  // The newest three folders (the new release and the two newest old ones), plus the two in use.
  const newest = [current, ...[...old].sort().reverse()].slice(0, 3);
  assert.deepEqual(fs.readdirSync(app).sort(), [...new Set([...newest, old[0]!, old[1]!])].sort());
  assert.ok(!fs.existsSync(path.join(app, old[2]!)), 'an old release nothing runs from is removed');
});

test('a release folder counts as in use only by its own path, on Windows in any case and slash', () => {
  const names = ['20200101-000001', '20200101-000002', '20200101-000003', '20200101-000004'];
  // 000001 appears only as the start of a longer name; 000002 is on a command line, quoted.
  const lines = ['node /data/app/20200101-0000019/src/main.ts', 'node "/data/app/20200101-000002/src/host/host.ts" x'];
  assert.deepEqual(releasesToRemove(names, ['/data/app'], lines, 2, 'linux'), ['20200101-000001']);
  // Either spelling of the releases folder counts.
  assert.deepEqual(releasesToRemove(names, ['/link/app', '/data/app'], lines, 2, 'linux'), ['20200101-000001']);
  const winLines = ['"C:\\Program Files\\nodejs\\node.exe" c:/users/A/appdata/roaming/ledung/APP/20200101-000001/src/main.ts'];
  assert.deepEqual(releasesToRemove(names, ['C:\\Users\\a\\AppData\\Roaming\\Ledung\\app'], winLines, 2, 'win32'), ['20200101-000002']);
});
