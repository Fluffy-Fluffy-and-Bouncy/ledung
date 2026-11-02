// The npm channels' publish (issue #461; Martin, 2026-11-02 00:38, Ledung question #1172): a dev build is the next
// X.Y on npm's `dev` tag and never touches `latest`; a public release is the next plain number on `latest`, on the
// owners' word (Martin or FFBuddha); both refuse anything but a clean main that is origin/main. Nothing here talks to npm.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, publishArgs, publishedVersions, refusals, type PublishOptions, type PublishState } from '../scripts/publish.ts';
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
