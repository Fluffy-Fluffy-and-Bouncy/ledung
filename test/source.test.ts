// Settings → About's version and Source link (AGPL section 13, issue #332).
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_REPOSITORY, readRepository, repositoryUrl, sourceOffer } from '../src/server/source.ts';
import { displayVersion } from '../src/shared/version.ts';

const REPO = 'https://github.com/example/ledung';

test('the repository address comes from package.json, as npm writes it or plain', () => {
  assert.equal(repositoryUrl({ repository: { type: 'git', url: 'git+https://github.com/example/ledung.git' } }), REPO);
  assert.equal(repositoryUrl({ repository: 'https://github.com/example/ledung' }), REPO);
  // Not a web address the page can link to.
  assert.equal(repositoryUrl({ repository: 'github:example/ledung' }), null);
  assert.equal(repositoryUrl({}), null);
  assert.equal(repositoryUrl(null), null);
});

test('a release links to the commit it was built from', () => {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(
    sourceOffer({ repository: REPO, packaged: false, version: '0.1.0', release: { source: 'C:/src', commit }, build: '20261027-1110' }),
    { version: 'v0.1, commit 0123456', url: `${REPO}/tree/${commit}` },
  );
});

test('the npm package and a source folder link to the repository', () => {
  assert.deepEqual(sourceOffer({ repository: REPO, packaged: true, version: '0.1.0', release: null, build: 'ledung' }), { version: 'ledung v0.1', url: REPO });
  assert.deepEqual(sourceOffer({ repository: REPO, packaged: false, version: '0.1.0', release: null, build: 'ledung' }), { version: 'v0.1, ledung', url: REPO });
  // A release whose source is not a git clone records no commit.
  assert.deepEqual(sourceOffer({ repository: REPO, packaged: false, version: '0.1.0', release: { source: 'C:/src', commit: null }, build: '20261001-0900' }), { version: 'v0.1, 20261001-0900', url: REPO });
});

test('the default repository is a web address', () => {
  assert.match(DEFAULT_REPOSITORY, /^https:\/\/github\.com\//);
});

test('the Source link goes to the public repository, from the default and from package.json (Ledung question #451)', () => {
  // Martin, 2026-10-29 22:33: "New public Fluffy-Fluffy-and-Bouncy/ledung; development moves there".
  const PUBLIC = 'https://github.com/Fluffy-Fluffy-and-Bouncy/ledung';
  const commit = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(DEFAULT_REPOSITORY, PUBLIC);
  const fromPackage = readRepository(path.resolve(import.meta.dirname, '..'));
  assert.equal(fromPackage, PUBLIC, "this folder's package.json names the public repository");
  assert.equal(sourceOffer({ repository: fromPackage, packaged: false, version: '1.0.0', release: { source: 'C:/src', commit }, build: 'x' }).url, `${PUBLIC}/tree/${commit}`);
});

test('a public release shows as a plain number and a dev build after it as X.Y (Ledung question #452)', () => {
  assert.equal(displayVersion('1.0.0'), 'v1');
  assert.equal(displayVersion('1.1.0'), 'v1.1');
  assert.equal(displayVersion('2.0.0'), 'v2');
  assert.equal(displayVersion('1.12.0'), 'v1.12');
  // Not in the scheme: shown whole rather than guessed at.
  assert.equal(displayVersion('1.1.2'), 'v1.1.2');
  assert.equal(displayVersion('1.0.0-beta.1'), 'v1.0.0-beta.1');
});
