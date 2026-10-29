// Settings' Update Ledung (#100): what the check reports, every refusal, and that a refusal or a
// failed step leaves the running Ledung alone (no restart, current.json unchanged). Real git
// repositories in a temp folder: an origin, and a source clone one commit behind it.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changelogAdded, readRunningRelease, Updater, type Command, type UpdaterOptions } from '../src/update/updater.ts';
import type { UpdateView } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';

let base: string;
let origin: string;
let source: string;
let other: string;
let appDir: string;
let dataDir: string;
let released: string;
let restarts: number;

// core.autocrlf=false: Git for Windows sets it to true system-wide, and these repos have no
// .gitattributes, so a clone would check CHANGELOG.md out with CRLF and change() would match nothing (#102).
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** Adds a changelog bullet in `repo` and commits it. */
function change(repo: string, bullet: string): void {
  const file = path.join(repo, 'CHANGELOG.md');
  const old = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, old.replace('## 2026-10-15\n', `## 2026-10-15\n- ${bullet}\n`));
  git(repo, 'commit', '-qam', bullet);
}

const ok: Command = { cmd: process.execPath, args: ['-e', ''] };
const fails: Command = { cmd: process.execPath, args: ['-e', 'console.log("Checking types and running tests... "); console.error("1 test failed"); process.exit(3)'] };

function updater(extra: Partial<UpdaterOptions> = {}): Updater {
  return new Updater({ appDir, dataDir, configPath: path.join(base, 'config.json'), onRestart: () => { restarts++; }, install: ok, release: ok, ...extra });
}

/** Waits until the update has stopped running: up to a minute, as under a full check's load git and the process list are slow (#270). */
async function settled(u: Updater): Promise<UpdateView> {
  for (const end = Date.now() + 60_000; Date.now() < end;) {
    const v = u.view();
    if (!v.updating) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the update did not finish');
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-update-'));
  origin = path.join(base, 'origin.git');
  source = path.join(base, 'source');
  other = path.join(base, 'other');
  appDir = path.join(base, 'data', 'app', '20261015-100000');
  dataDir = path.join(base, 'data');
  fs.mkdirSync(appDir, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, source);
  git(source, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(source, 'CHANGELOG.md'), '# Ledung changelog\n\n## 2026-10-15\n- First.\n');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'first');
  git(source, 'push', '-q', 'origin', 'main');
  released = git(source, 'rev-parse', 'HEAD');
  // Another clone lands one change on origin: the source folder is now one commit behind.
  git(base, 'clone', '-q', origin, other);
  change(other, 'Second, from origin. (#7)');
  git(other, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(appDir, 'release.json'), JSON.stringify({ source, commit: released }));
  fs.writeFileSync(path.join(dataDir, 'current.json'), JSON.stringify({ dir: appDir, source, commit: released }));
  restarts = 0;
});

afterEach(() => removeTemp(base));

test('the changelog bullets a diff adds', () => {
  assert.deepEqual(changelogAdded('--- a/CHANGELOG.md\n+++ b/CHANGELOG.md\n@@\n ## 2026-10-15\n+- New thing. (#1)\n-- Old thing.\n- Kept.\n'), ['New thing. (#1)']);
});

test('a Ledung run from a source folder has nothing to update', async () => {
  const u = updater({ appDir: path.join(base, 'elsewhere') });
  assert.equal(u.view().available, false);
  assert.match(u.view().reason!, /not from a release/);
  assert.match(u.startUpdate().refused!, /not from a release/);
  assert.equal(restarts, 0);
});

test('a release built from a folder that is not a git clone shows an unknown commit and offers the update', async () => {
  fs.writeFileSync(path.join(appDir, 'release.json'), JSON.stringify({ source, commit: null }));
  assert.deepEqual(readRunningRelease(appDir), { source, commit: null, releasedAt: undefined });
  const v = await updater().runCheck();
  assert.equal(v.running!.commit, null);
  assert.equal(v.check!.commitKnown, false);
  assert.equal(v.check!.upToDate, false, 'an unknown commit always offers the update');
  assert.equal(v.check!.behind, 1);
});

test('the check counts the new changes since the running commit and lists their bullets', async () => {
  const v = await updater().runCheck();
  assert.equal(v.checkError, null);
  assert.equal(v.check!.upToDate, false);
  assert.equal(v.check!.behind, 1);
  assert.equal(v.check!.latest, git(other, 'rev-parse', 'HEAD'));
  assert.deepEqual(v.check!.changes, ['Second, from origin. (#7)']);
});

test('the check says up to date when the running commit is origin/main', async () => {
  git(source, 'pull', '-q', '--ff-only', 'origin', 'main');
  const head = git(source, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(appDir, 'release.json'), JSON.stringify({ source, commit: head }));
  const v = await updater().runCheck();
  assert.equal(v.check!.upToDate, true);
  assert.equal(v.check!.behind, 0);
  assert.deepEqual(v.check!.changes, []);
});

test('an update pulls, installs, releases and then restarts', async () => {
  const u = updater();
  u.startUpdate();
  const v = await settled(u);
  assert.equal(v.refused, null);
  assert.deepEqual(v.steps.map((s) => s.state), ['done', 'done', 'done', 'done', 'running']);
  assert.equal(v.restarting, true);
  assert.equal(git(source, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'), 'the source folder is at origin/main');
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(restarts, 1);
});

/**
 * Starts an update that must be refused at `step`: no later step runs and Ledung doesn't restart.
 * That a failed release leaves current.json alone is release.ts's to prove (test/release.test.ts).
 */
async function refused(u: Updater, step: number, reason: RegExp): Promise<UpdateView> {
  u.startUpdate();
  const v = await settled(u);
  assert.match(v.refused ?? '', reason);
  assert.match(v.refused ?? '', /The running Ledung was not changed/);
  assert.equal(v.steps[step]!.state, 'failed');
  assert.ok(v.steps.slice(step + 1).every((s) => s.state === 'waiting'), 'no later step ran');
  assert.equal(v.restarting, false);
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(restarts, 0, 'no restart');
  return v;
}

test('an update is refused while a check runs, and a check waits out a running update', async () => {
  const u = updater();
  const checking = u.runCheck();
  const v = u.startUpdate();
  assert.match(v.refused ?? '', /check for updates is still running/);
  assert.deepEqual(v.steps, [], 'no step ran');
  await checking;

  // The other way round: a check while an update runs does not fetch, it only reports.
  const slow: Command = { cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 800)'] };
  // Its own restart callback: the restart comes after this test ends and must not count in the next.
  const u2 = updater({ install: slow, onRestart: () => {} });
  u2.startUpdate();
  const during = await u2.runCheck();
  assert.equal(during.updating, true);
  assert.equal(during.check, null, 'no check ran during the update');
  await settled(u2);
});

// Its own timeout: without the time limit the stub would hang, and the test must fail fast instead (review of PR #101).
// Fast, not tight: two git steps, the 1.5 s limit, a PowerShell process list and the 1.7 s restart wait take 6 s
// on an idle Windows machine, and under the load of a full `npm run check` they went past 10 s (#270).
// A minute still fails well before the real 10-minute install limit.
test('a step that hangs is stopped at its time limit, with everything it started', { timeout: 60_000 }, async () => {
  const pidFile = path.join(base, 'grandchild.pid');
  // npm runs node, which runs more: the stub starts a child of its own and both hang.
  const hang: Command = {
    cmd: process.execPath,
    args: ['-e', `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000)`],
    limitMs: 1500,
  };
  const v = await refused(updater({ install: hang }), 2, /npm install did not finish within 2 seconds and was stopped/);
  assert.equal(v.steps[3]!.state, 'waiting', 'the release never started');
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(grandchild, 0), 'the step\'s own child was stopped too');
});

test('refuses when the source folder has uncommitted changes', async () => {
  fs.appendFileSync(path.join(source, 'CHANGELOG.md'), 'local edit\n');
  const v = await refused(updater(), 0, /uncommitted changes/);
  assert.match(v.steps[0]!.output ?? '', /CHANGELOG\.md/);
  assert.equal(git(source, 'rev-parse', 'HEAD'), released, 'nothing was pulled');
});

test('refuses when the source folder is not on main', async () => {
  git(source, 'checkout', '-q', '-b', 'feature');
  await refused(updater(), 0, /on branch feature, not main/);
});

test('refuses when the pull is not a fast-forward', async () => {
  change(source, 'A local commit not on origin.');
  await refused(updater(), 0, /not a fast-forward/);
});

test('refuses when a step fails, showing its last output lines', async () => {
  const v = await refused(updater({ release: fails }), 3, /npm run release failed \(exit code 3\)/);
  assert.match(v.steps[3]!.output ?? '', /1 test failed/);
  assert.deepEqual(v.steps.slice(0, 3).map((s) => s.state), ['done', 'done', 'done']);
});

test('refuses without the launcher, before touching the source folder', async () => {
  const v = updater({ onRestart: undefined }).startUpdate();
  assert.match(v.refused ?? '', /not started by the launcher/);
  assert.deepEqual(v.steps, []);
  assert.equal(git(source, 'rev-parse', 'HEAD'), released);
});

test("the steps don't inherit this Ledung's settings, only its data folder and config", async () => {
  const seen = path.join(base, 'env.json');
  const dump: Command = { cmd: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env))`] };
  const u = updater({ release: dump, env: { ...process.env, LEDUNG_LAUNCHER: '1', LEDUNG_DATA_DIR: '/wrong' } });
  u.startUpdate();
  await settled(u);
  const env = JSON.parse(fs.readFileSync(seen, 'utf8'));
  assert.equal(env.LEDUNG_LAUNCHER, undefined);
  assert.equal(env.LEDUNG_DATA_DIR, dataDir);
  assert.equal(env.LEDUNG_CONFIG, path.join(base, 'config.json'));
});
