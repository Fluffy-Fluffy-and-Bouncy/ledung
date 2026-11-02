// The npm channels' publish (issue #461; Martin, 2026-11-02 00:38, Ledung question #1172): a dev build is the next
// X.Y on npm's `dev` tag and never touches `latest`; a public release is the next plain number on `latest`, on the
// owners' word (Martin or FFBuddha); both refuse anything but a clean main that is origin/main. Nothing here talks to npm.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, publishArgs, publishedVersions, refusals, runPublish, type PublishOptions, type PublishState, type PublishSteps } from '../scripts/publish.ts';
import { stagePackage } from '../scripts/build-package.ts';
import { appDir } from '../src/platform/paths.ts';
import { compareVersions, displayVersion, isDevVersion, isPublicVersion, nextVersion, offeredVersion } from '../src/shared/version.ts';
import { removeTemp } from './temp.ts';

let base: string;
before(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-publish-')); });
after(() => removeTemp(base));

test('the next dev build is X.Y after the newest version, and the next public release the next plain number (decided 2026-10-29, #452)', () => {
  // Today npm has only 1.0.0 (v1): the first dev build is v1.1, and the next public release v2.
  assert.equal(nextVersion('dev', ['1.0.0']), '1.1.0');
  assert.equal(nextVersion('public', ['1.0.0']), '2.0.0');
  // Dev builds count on: v1.1, v1.2 → v1.3; numbers, not text (1.10 is after 1.9).
  assert.equal(nextVersion('dev', ['1.0.0', '1.1.0', '1.2.0']), '1.3.0');
  assert.equal(nextVersion('dev', ['1.0.0', '1.9.0', '1.10.0']), '1.11.0');
  // A public release after dev builds is the next number, and dev builds after it start from it.
  assert.equal(nextVersion('public', ['1.0.0', '1.1.0', '1.2.0']), '2.0.0');
  assert.equal(nextVersion('dev', ['1.0.0', '1.2.0', '2.0.0']), '2.1.0');
  // The clone's own version counts too, in whatever order the list comes; a version that doesn't parse is ignored.
  assert.equal(nextVersion('dev', ['1.2.0', '1.0.0', 'nonsense', '0.9.0']), '1.3.0');
  assert.throws(() => nextVersion('dev', []), /no version/);
  assert.equal(displayVersion(nextVersion('dev', ['1.0.0'])), 'v1.1');
});

test('a plain number is a public release and X.Y a dev build', () => {
  for (const v of ['1.0.0', '2.0.0', '10.0.0']) assert.ok(isPublicVersion(v) && !isDevVersion(v), v);
  for (const v of ['1.1.0', '1.12.0', '2.3.0']) assert.ok(isDevVersion(v) && !isPublicVersion(v), v);
  for (const v of ['1.1.1', '1.0.1', '1.1.0-beta.1', '1.01.0', '']) assert.ok(!isDevVersion(v) && !isPublicVersion(v), v);
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('2.0.0', '1.12.0') > 0);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
});

test('Public offers npm latest; Dev offers dev or latest, whichever is newer', () => {
  assert.equal(offeredVersion('public', { latest: '1.0.0', dev: '1.2.0' }), '1.0.0');
  assert.equal(offeredVersion('dev', { latest: '1.0.0', dev: '1.2.0' }), '1.2.0');
  // A public release after the last dev build reaches Dev without anyone moving the dev tag.
  assert.equal(offeredVersion('dev', { latest: '2.0.0', dev: '1.2.0' }), '2.0.0');
  // Before the first dev build there is only latest.
  assert.equal(offeredVersion('dev', { latest: '1.0.0' }), '1.0.0');
  assert.equal(offeredVersion('public', {}), null);
});

const clean: PublishState = { branch: 'main', dirty: false, head: 'a'.repeat(40), originHead: 'a'.repeat(40), version: '1.1.0', published: ['1.0.0'] };
const dev: PublishOptions = { channel: 'dev', dryRun: false };

test('a dev build of a clean main that is origin/main is not refused', () => {
  assert.deepEqual(refusals(dev, clean), []);
  assert.deepEqual(refusals({ ...dev, dryRun: true }, clean), []);
});

test('publishing refuses another branch, a dirty tree, a main not pushed or behind, a plain number for dev, and a version npm has', () => {
  const one = (s: Partial<PublishState>, o: PublishOptions = dev) => refusals(o, { ...clean, ...s });
  assert.match(one({ branch: 'agent/x' }).join(), /branch agent\/x, not main/);
  assert.match(one({ branch: 'HEAD' }).join(), /no branch/);
  assert.match(one({ dirty: true }).join(), /uncommitted changes/);
  assert.match(one({ originHead: 'b'.repeat(40) }).join(), /main is not origin\/main/);
  assert.match(one({ version: '2.0.0' }).join(), /2\.0\.0 is not a dev build's X\.Y/);
  assert.match(one({ version: '1.1.1' }).join(), /1\.1\.1 is not a dev build's X\.Y/);
  assert.match(one({ published: ['1.0.0', '1.1.0'] }).join(), /already on npm/);
  // A dry run refuses the same: it shows what would happen.
  assert.match(one({ branch: 'agent/x' }, { ...dev, dryRun: true }).join(), /not main/);
});

test('a public release needs a plain number and the version typed back; a dry run shows it without', () => {
  const pub: PublishOptions = { channel: 'public', dryRun: false };
  const s = { ...clean, version: '2.0.0' };
  assert.match(refusals(pub, s).join(), /owners' word \(Martin or FFBuddha\): run it again with --confirm 2\.0\.0/);
  assert.match(refusals({ ...pub, confirm: '3.0.0' }, s).join(), /--confirm 2\.0\.0/);
  assert.deepEqual(refusals({ ...pub, confirm: '2.0.0' }, s), []);
  assert.deepEqual(refusals({ ...pub, dryRun: true }, s), []);
  assert.match(refusals({ ...pub, confirm: '1.1.0' }, { ...clean, version: '1.1.0' }).join(), /not a plain number/);
});

test("a dev build is published to npm's dev tag only, a public release to latest; no other tag is named", () => {
  assert.deepEqual(publishArgs('dev', 'ledung-1.1.0.tgz'), ['publish', 'ledung-1.1.0.tgz', '--tag', 'dev', '--access', 'public']);
  assert.ok(!publishArgs('dev', 'x.tgz').includes('latest'));
  assert.deepEqual(publishArgs('public', 'ledung-2.0.0.tgz'), ['publish', 'ledung-2.0.0.tgz', '--tag', 'latest', '--access', 'public']);
  // Neither moves a tag by itself.
  assert.ok(!publishArgs('dev', 'x.tgz').includes('dist-tag'));
});

test('the command line: the channel, --dry-run (also npm run ... --dry-run without --) and --confirm', () => {
  assert.deepEqual(parseArgs(['dev'], {}), { channel: 'dev', dryRun: false, confirm: undefined });
  assert.deepEqual(parseArgs(['dev', '--dry-run'], {}), { channel: 'dev', dryRun: true, confirm: undefined });
  assert.equal(parseArgs(['dev'], { npm_config_dry_run: 'true' }).dryRun, true);
  assert.deepEqual(parseArgs(['public', '--confirm', '2.0.0'], {}), { channel: 'public', dryRun: false, confirm: '2.0.0' });
  assert.throws(() => parseArgs(['latest'], {}), /public or dev/);
  assert.throws(() => parseArgs([], {}), /public or dev/);
});

test("npm view's versions: a list, one version, or none", () => {
  assert.deepEqual(publishedVersions('["1.0.0","1.1.0"]'), ['1.0.0', '1.1.0']);
  assert.deepEqual(publishedVersions('"1.0.0"\n'), ['1.0.0']);
  assert.deepEqual(publishedVersions(''), []);
});

test("the package is stamped with the build's version, not the clone's, and the clone's package.json is left alone", async () => {
  const source = path.join(base, 'source');
  fs.mkdirSync(path.join(source, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(source, 'web', 'dist', 'index.html'), '<!doctype html>');
  for (const file of ['package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'ledung.config.example.json', 'LICENSE', 'COMMERCIAL.md']) {
    fs.cpSync(path.join(appDir(), file), path.join(source, file));
  }
  fs.symlinkSync(path.join(appDir(), 'src'), path.join(source, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = fs.readFileSync(path.join(source, 'package.json'), 'utf8');
  const stage = path.join(base, 'stage');
  await stagePackage(source, stage, '1.4.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8')).version, '1.4.0');
  const shrinkwrap = JSON.parse(fs.readFileSync(path.join(stage, 'npm-shrinkwrap.json'), 'utf8'));
  assert.equal(shrinkwrap.version, '1.4.0');
  assert.equal(shrinkwrap.packages[''].version, '1.4.0');
  assert.equal(fs.readFileSync(path.join(source, 'package.json'), 'utf8'), before);
  // Without one, the clone's version as before.
  await stagePackage(source, stage);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8')).version, JSON.parse(before).version);
});

// The whole run on a real clone of a local origin (test review of PR #13, finding 2): a refused clone stops before npm
// is asked or anything is built; a clean main goes on to the build and, unless it is a dry run, the publish.
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** A clone on main that is origin/main, with a package.json at 1.0.0 and a tracked web/public folder. */
function cleanClone(name: string): string {
  const origin = path.join(base, `${name}-origin.git`);
  const clone = path.join(base, name);
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, clone);
  git(clone, 'checkout', '-q', '-B', 'main');
  fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: 'ledung', version: '1.0.0' }));
  fs.mkdirSync(path.join(clone, 'web', 'public'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'web', 'public', 'icon.svg'), '<svg/>');
  // A tracked file the package does not take in: a change to it is still a change (test review of PR #13 round 2).
  fs.mkdirSync(path.join(clone, 'docs'));
  fs.writeFileSync(path.join(clone, 'docs', 'notes.md'), '# notes\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'first');
  git(clone, 'push', '-q', 'origin', 'main');
  return clone;
}

/** Records every step; npm says it has 1.0.0. */
function recorder() {
  const calls: string[] = [];
  const steps: PublishSteps = {
    npmView: () => { calls.push('npm view'); return ['1.0.0']; },
    check: () => { calls.push('check'); },
    build: async (_s, version) => { calls.push(`build ${version}`); return `ledung-${version}.tgz`; },
    publish: (args) => { calls.push(`npm ${args.join(' ')}`); },
    log: () => {},
    error: (line) => { calls.push(line); },
  };
  return { calls, steps };
}

test('a clean main publishes the next dev build to the dev tag; a dry run builds it and publishes nothing', async () => {
  const clone = cleanClone('clean');
  const dry = recorder();
  assert.equal(await runPublish({ channel: 'dev', dryRun: true }, clone, dry.steps), 0);
  assert.deepEqual(dry.calls, ['npm view', 'build 1.1.0']);
  const real = recorder();
  assert.equal(await runPublish({ channel: 'dev', dryRun: false }, clone, real.steps), 0);
  assert.deepEqual(real.calls, ['npm view', 'check', 'build 1.1.0', 'npm publish ledung-1.1.0.tgz --tag dev --access public']);
});

test("a public release from a clean main is refused without --confirm, with nothing checked, built or published, and goes to latest with it", async () => {
  const clone = cleanClone('public');
  const without = recorder();
  assert.equal(await runPublish({ channel: 'public', dryRun: false }, clone, without.steps), 1);
  assert.deepEqual(without.calls, ['npm view', "Refused: A public release is the owners' word (Martin or FFBuddha): run it again with --confirm 2.0.0 to publish v2 to everyone."]);
  const wrong = recorder();
  assert.equal(await runPublish({ channel: 'public', dryRun: false, confirm: '1.1.0' }, clone, wrong.steps), 1);
  assert.ok(!wrong.calls.some((c) => /^(npm publish|check|build)/.test(c)), wrong.calls.join(' | '));
  const confirmed = recorder();
  assert.equal(await runPublish({ channel: 'public', dryRun: false, confirm: '2.0.0' }, clone, confirmed.steps), 0);
  assert.deepEqual(confirmed.calls, ['npm view', 'check', 'build 2.0.0', 'npm publish ledung-2.0.0.tgz --tag latest --access public']);
});

test('a refused clone stops before npm is asked or anything is built: changes, an untracked file the package takes in, another branch, a main not pushed', async () => {
  const clone = cleanClone('refused');
  const tryIt = async () => {
    const r = recorder();
    assert.equal(await runPublish({ channel: 'dev', dryRun: false }, clone, r.steps), 1);
    assert.ok(!r.calls.some((c) => /^(npm|check|build)/.test(c)), r.calls.join(' | '));
    return r.calls.join(' | ');
  };

  fs.appendFileSync(path.join(clone, 'web', 'public', 'icon.svg'), ' ');
  assert.match(await tryIt(), /uncommitted changes/);
  git(clone, 'checkout', '-q', '--', '.');
  fs.appendFileSync(path.join(clone, 'docs', 'notes.md'), 'more\n');
  assert.match(await tryIt(), /uncommitted changes/);
  git(clone, 'checkout', '-q', '--', '.');

  // An untracked file where the page is built from would go into the package (code review of PR #13, minor 2).
  fs.writeFileSync(path.join(clone, 'web', 'public', 'scratch.html'), 'x');
  assert.match(await tryIt(), /uncommitted changes/);
  fs.rmSync(path.join(clone, 'web', 'public', 'scratch.html'));
  // One beside the config, which the package leaves out, does not stop it.
  fs.writeFileSync(path.join(clone, 'ledung.config.local.json.bak'), '{}');
  assert.equal(await runPublish({ channel: 'dev', dryRun: true }, clone, recorder().steps), 0);

  git(clone, 'checkout', '-q', '-b', 'feature');
  assert.match(await tryIt(), /branch feature, not main/);
  git(clone, 'checkout', '-q', 'main');

  fs.writeFileSync(path.join(clone, 'web', 'public', 'new.svg'), '<svg/>');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'not pushed');
  assert.match(await tryIt(), /main is not origin\/main/);
});
