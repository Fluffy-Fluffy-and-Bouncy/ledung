// The changelogs per release (issue #417; Martin, 2026-11-19, Ledung questions #606 and #613): a PR's bullets wait in
// docs/changes/<issue>.md; a dev publish folds them into CHANGELOG-dev.md under the new X.Y, a public one writes the new
// X in CHANGELOG.md with every dev build since the last public release. Also the order of Settings → About's links, and
// the site page's drawing of the Markdown (site/assets/changelog.js), including what it shows when GitHub can't be reached.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { applyWrites, bulletsOf, fold, insertSection, NEW_DEV_FILE, readChanges, releasesOf, releaseStamp } from '../scripts/changelog.ts';
import { appDir } from '../src/platform/paths.ts';
import { changelogLinks } from '../src/shared/version.ts';
import { removeTemp } from './temp.ts';

let base: string;
let n = 0;
before(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-changelog-')); });
after(() => removeTemp(base));

/** A folder with the given files. */
function tree(files: Record<string, string>): string {
  const root = path.join(base, `t${++n}`);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (root: string, file: string) => fs.existsSync(path.join(root, file));

test('a release heading carries the date, the time to the minute and the time zone (the issue: "## v3.9 — 2026-11-19 14:10 CET")', () => {
  // 13:10 UTC is 14:10 in Stockholm in November (CET, UTC+1) and 15:10 in July (CEST, UTC+2).
  assert.equal(releaseStamp(new Date('2026-11-19T13:10:00Z'), 'Europe/Stockholm'), '2026-11-19 14:10 CET');
  assert.equal(releaseStamp(new Date('2026-07-19T13:10:00Z'), 'Europe/Stockholm'), '2026-07-19 15:10 CEST');
  // Past midnight the date moves with the zone, and the hour is 00, not 24.
  assert.equal(releaseStamp(new Date('2026-11-19T23:05:00Z'), 'Europe/Stockholm'), '2026-11-20 00:05 CET');
  assert.equal(releaseStamp(new Date('2026-11-19T23:05:00Z'), 'UTC'), '2026-11-19 23:05 UTC');
});

test('bullets are the "- " lines with the indented lines under them; anything else in a change file is left out', () => {
  assert.deepEqual(bulletsOf('A note to the reviewer.\n- One. (#1)\n- Two,\n  wrapped. (#2)\n\nnot a bullet\n-no space\n'), ['- One. (#1)', '- Two,\n  wrapped. (#2)']);
  assert.deepEqual(bulletsOf('nothing here\n'), []);
});

test('the waiting files are read newest issue first, a file with no number after them, and the folder guide never', () => {
  const root = tree({
    'docs/changes/README.md': '- An example in the guide. (#0)\n',
    'docs/changes/9.md': '- Nine. (#9)\n',
    'docs/changes/412.md': '- Four hundred twelve. (#412)\n',
    'docs/changes/fix-typo.md': '- A typo. (no issue)\n',
    'docs/changes/40.md': '- Forty. (#40)\n- Forty again. (#40)\n',
  });
  assert.deepEqual(readChanges(root).map((c) => c.file), ['412.md', '40.md', '9.md', 'fix-typo.md']);
  assert.deepEqual(readChanges(root)[1]!.bullets, ['- Forty. (#40)', '- Forty again. (#40)']);
  assert.deepEqual(readChanges(tree({ 'x.txt': '' })), []);
});

test('a dev publish puts the waiting bullets under the new X.Y at the top of CHANGELOG-dev.md and takes the files away', () => {
  const root = tree({
    'CHANGELOG-dev.md': NEW_DEV_FILE,
    'docs/changes/README.md': '# guide\n',
    'docs/changes/12.md': '- Twelve. (#12)\n',
    'docs/changes/15.md': '- Fifteen. (#15)\n',
  });
  const first = fold(root, '3.10.0', '2026-11-19 15:02 CET');
  applyWrites(root, first.writes);
  assert.equal(first.section, '## v3.10 — 2026-11-19 15:02 CET\n- Fifteen. (#15)\n- Twelve. (#12)\n');
  const dev = read(root, 'CHANGELOG-dev.md');
  // Above the "Earlier" pointer, below the header.
  assert.ok(dev.indexOf('## v3.10 — 2026-11-19 15:02 CET') > dev.indexOf("**Don't edit this file.**"));
  assert.ok(dev.indexOf('## v3.10') < dev.indexOf('## Earlier'));
  assert.ok(!exists(root, 'docs/changes/12.md') && !exists(root, 'docs/changes/15.md'));
  assert.ok(exists(root, 'docs/changes/README.md'), 'the guide stays');
  // CHANGELOG.md is not touched by a dev build.
  assert.ok(!first.writes.has('CHANGELOG.md'));

  // The next dev build goes above it: newest first.
  fs.writeFileSync(path.join(root, 'docs/changes/20.md'), '- Twenty. (#20)\n');
  applyWrites(root, fold(root, '3.11.0', '2026-11-20 09:00 CET').writes);
  assert.deepEqual(releasesOf(read(root, 'CHANGELOG-dev.md')).map((r) => r.version), ['3.11.0', '3.10.0']);

  // With nothing waiting, the build still gets its heading, and says it changes nothing.
  const empty = fold(root, '3.12.0', '2026-11-20 10:00 CET');
  assert.equal(empty.section, '## v3.12 — 2026-11-20 10:00 CET\nNothing in this release changes what Ledung does.\n');
});

test('a public publish writes everything since the last public release in CHANGELOG.md, above the earlier history, and adds the release to the dev changelog', () => {
  const history = '## Earlier, by date\n\n## 2026-11-19\n- An old one. (#1)\n';
  const root = tree({
    'CHANGELOG.md': `# Ledung changelog\n\nHeader.\n\n${history}`,
    'CHANGELOG-dev.md': NEW_DEV_FILE,
  });
  // v2.4 is a dev build after the previous public release: it is not in v4.
  const devFile = insertSection(NEW_DEV_FILE, '## v2.4 — 2026-10-01 10:00 CEST\n- From v2. (#5)\n');
  fs.writeFileSync(path.join(root, 'CHANGELOG-dev.md'), devFile);
  fs.mkdirSync(path.join(root, 'docs/changes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/changes/10.md'), '- Ten. (#10)\n');
  applyWrites(root, fold(root, '3.1.0', '2026-11-19 15:00 CET').writes);
  fs.writeFileSync(path.join(root, 'docs/changes/20.md'), '- Twenty. (#20)\n');
  applyWrites(root, fold(root, '3.2.0', '2026-11-20 15:00 CET').writes);
  fs.writeFileSync(path.join(root, 'docs/changes/30.md'), '- Thirty. (#30)\n');
  const pub = fold(root, '4.0.0', '2026-11-21 12:00 CET');
  applyWrites(root, pub.writes);

  // The dev builds' bullets newest first, then the ones that were still waiting.
  assert.equal(pub.section, '## v4 — 2026-11-21 12:00 CET\n- Twenty. (#20)\n- Ten. (#10)\n- Thirty. (#30)\n');
  const changelog = read(root, 'CHANGELOG.md');
  assert.ok(changelog.startsWith('# Ledung changelog\n\nHeader.\n\n## v4 — 2026-11-21 12:00 CET\n'));
  assert.ok(changelog.endsWith(history), 'the dated history stays at the bottom, unchanged');
  assert.ok(!changelog.includes('From v2'));
  assert.ok(!exists(root, 'docs/changes/30.md'));
  // The dev changelog lists v4 too, so it has every version the Dev channel can get, with what was new in it.
  const dev = releasesOf(read(root, 'CHANGELOG-dev.md'));
  assert.deepEqual(dev.map((r) => r.version), ['4.0.0', '3.2.0', '3.1.0', '2.4.0']);
  assert.deepEqual(dev[0]!.bullets, ['- Thirty. (#30)']);
  assert.match(read(root, 'CHANGELOG-dev.md'), /## v4 — 2026-11-21 12:00 CET\nThe public release\. Everything since v3: v3\.1, v3\.2 and the changes below\.\n- Thirty/);
  assert.throws(() => fold(root, '4.1.1', 'x'), /neither a dev build/);
});

test("the repository's own CHANGELOG.md takes a public release above \"Earlier, by date\" and keeps the history after it byte for byte", () => {
  const real = fs.readFileSync(path.join(appDir(), 'CHANGELOG.md'), 'utf8');
  const history = real.slice(real.indexOf('## Earlier, by date'));
  assert.match(history, /^## Earlier, by date\n\n## 20\d\d-\d\d-\d\d\n- /);
  const root = tree({ 'CHANGELOG.md': real, 'docs/changes/1.md': '- One. (#1)\n' });
  applyWrites(root, fold(root, '4.0.0', '2026-12-01 10:00 CET').writes);
  const after = read(root, 'CHANGELOG.md');
  assert.ok(after.endsWith(history));
  assert.ok(after.indexOf('## v4 — 2026-12-01 10:00 CET\n- One. (#1)\n') < after.indexOf('## Earlier, by date'));
  // And the repository's CHANGELOG-dev.md is the file a first fold would make.
  assert.equal(fs.readFileSync(path.join(appDir(), 'CHANGELOG-dev.md'), 'utf8'), NEW_DEV_FILE);
});

test('applyWrites hands back what was there, so a failed publish can put it back, a new file included', () => {
  const root = tree({ 'CHANGELOG.md': 'old\n', 'docs/changes/1.md': '- One. (#1)\n' });
  const before = applyWrites(root, new Map([['CHANGELOG.md', 'new\n'], ['CHANGELOG-dev.md', 'made\n'], [path.join('docs', 'changes', '1.md'), null]]));
  assert.equal(read(root, 'CHANGELOG.md'), 'new\n');
  assert.ok(!exists(root, 'docs/changes/1.md'));
  applyWrites(root, before);
  assert.equal(read(root, 'CHANGELOG.md'), 'old\n');
  assert.equal(read(root, 'docs/changes/1.md'), '- One. (#1)\n');
  assert.ok(!exists(root, 'CHANGELOG-dev.md'));
});

test("Settings → About links to the running Ledung's channel's changelog first", () => {
  assert.deepEqual(changelogLinks('public'), [
    { channel: 'public', url: 'https://projectledung.com/changelog' },
    { channel: 'dev', url: 'https://projectledung.com/dev-changelog' },
  ]);
  assert.deepEqual(changelogLinks('dev').map((l) => l.url), ['https://projectledung.com/dev-changelog', 'https://projectledung.com/changelog']);
});

// The site page's script, run as the browser would, with the page reduced to what it touches.
interface Page { body: { innerHTML: string }; render(md: string): string; loaded: Promise<void>; fetched: string[] }
function sitePage(fetch: (url: string) => Promise<unknown>, search = ''): Page {
  const body = { innerHTML: '' };
  const fetched: string[] = [];
  let done!: () => void;
  const loaded = new Promise<void>((r) => { done = r; });
  const main = { dataset: { changelog: 'CHANGELOG-dev.md' }, querySelector: () => body };
  const window: Record<string, unknown> = {};
  const context = {
    window,
    document: { readyState: 'complete', querySelector: () => main, getElementById: () => null },
    location: { search, hash: '' },
    URLSearchParams,
    fetch: async (url: string) => {
      fetched.push(url);
      try { return await fetch(url); } finally { setTimeout(done, 0); }
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(appDir(), 'site', 'assets', 'changelog.js'), 'utf8'), context);
  const api = window.ledungChangelog as { render(md: string): string };
  return { body, render: api.render, loaded, fetched };
}

test("the changelog page reads the file from main on GitHub and draws releases, bullets and the earlier history, escaping what is in it", async () => {
  const md = "# Header\n\nFor people editing the file.\n\n## v3.10 — 2026-11-19 15:02 CET\n- Shows `<b>` and **bold**, see [the guide](docs/changes/README.md). (#417)\n- A <script>alert(1)</script> line. (no issue)\n\n## Earlier, by date\n\n## 2026-11-19\n- Old. (#1)\n";
  const page = sitePage(async () => ({ ok: true, text: async () => md }));
  await page.loaded;
  assert.deepEqual(page.fetched, ['https://raw.githubusercontent.com/Fluffy-Fluffy-and-Bouncy/ledung/main/CHANGELOG-dev.md']);
  const html = page.body.innerHTML;
  assert.ok(!html.includes('For people editing'), 'the header above the first release is not shown');
  assert.match(html, /<h2 class="cl-release" id="v3\.10"><a href="#v3\.10">v3\.10<\/a><span class="cl-when">2026-11-19 15:02 CET<\/span><\/h2>/);
  assert.match(html, /<li>Shows <code>&lt;b&gt;<\/code> and <strong>bold<\/strong>, see <a href="https:\/\/github\.com\/Fluffy-Fluffy-and-Bouncy\/ledung\/blob\/main\/docs\/changes\/README\.md">the guide<\/a>\. \(#417\)<\/li>/);
  assert.ok(html.includes('A &lt;script&gt;alert(1)&lt;/script&gt; line.'));
  assert.ok(!html.includes('<script>'));
  assert.match(html, /<h2 class="cl-earlier">Earlier, by date<\/h2>\n<h3 class="cl-date">2026-11-19<\/h3>\n<ul><li>Old\. \(#1\)<\/li><\/ul>/);
  // A file with no release yet says so.
  assert.match(page.render(NEW_DEV_FILE), /No release has been published under this changelog yet/);
  // A link to anything but http(s) or a path in the repository is left as its words.
  const odd = page.render('## x\nsee [it](javascript:alert) and [this](CHANGELOG.md)');
  assert.ok(odd.endsWith('<p>see it and <a href="https://github.com/Fluffy-Fluffy-and-Bouncy/ledung/blob/main/CHANGELOG.md">this</a></p>'), odd);
});

test("when GitHub can't be reached the page says so and links to the file on GitHub; ?src= reads a copy on the site only", async () => {
  const down = sitePage(async () => { throw new Error('Failed to fetch'); });
  await down.loaded;
  assert.equal(down.body.innerHTML, 'The changelog could not be loaded from GitHub just now (Failed to fetch). Read it on GitHub instead: <a href="https://github.com/Fluffy-Fluffy-and-Bouncy/ledung/blob/main/CHANGELOG-dev.md">CHANGELOG-dev.md</a>.'.replace(/^/, '<p class="cl-problem">') + '</p>');
  const missing = sitePage(async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' }));
  await missing.loaded;
  assert.match(missing.body.innerHTML, /^<p class="cl-problem">The changelog could not be loaded from GitHub just now \(404 Not Found\)\. Read it on GitHub instead: <a href="https:\/\/github\.com\/Fluffy-Fluffy-and-Bouncy\/ledung\/blob\/main\/CHANGELOG-dev\.md">/);
  // The page's own copy for a preview, and not an address elsewhere.
  const local = sitePage(async () => ({ ok: true, text: async () => '## v1.1 — x\n- A. (#1)\n' }), '?src=CHANGELOG-dev.md');
  await local.loaded;
  assert.deepEqual(local.fetched, ['CHANGELOG-dev.md']);
  assert.match(local.body.innerHTML, /<li>A\. \(#1\)<\/li>/);
  const elsewhere = sitePage(async () => ({ ok: true, text: async () => '' }), '?src=https://evil.example/x.md');
  await elsewhere.loaded;
  assert.deepEqual(elsewhere.fetched, ['https://raw.githubusercontent.com/Fluffy-Fluffy-and-Bouncy/ledung/main/CHANGELOG-dev.md']);
});
