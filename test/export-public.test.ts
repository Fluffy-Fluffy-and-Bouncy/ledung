import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { badFileName, prune, scanExport, scanText, type Terms } from '../scripts/export-public.ts';

const NONE: Terms = { terms: [], allow: [] };
const kinds = (text: string, terms = NONE) => scanText('f.md', text, terms).filter((h) => !h.allowed).map((h) => [h.kind, h.text]);

test('the public export scan finds secrets, addresses and home folders', () => {
  // Built at run time, so this file holds no token-shaped string itself.
  const gh = 'ghp' + '_' + 'A'.repeat(36);
  assert.deepEqual(kinds(`token ${gh}`), [['github token', gh]]);
  assert.deepEqual(kinds('-----BEGIN OPENSSH ' + 'PRIVATE KEY-----'), [['private key', '-----BEGIN OPENSSH PRIVATE KEY-----']]);
  assert.deepEqual(kinds('mail jane.doe@company.se'), [['e-mail', 'jane.doe@company.se']]);
  assert.deepEqual(kinds(String.raw`in C:\Users\jane\proj and /Users/jane/x and /home/jane`), [
    ['home folder', String.raw`C:\Users\jane`], ['home folder', '/Users/jane'], ['home folder', '/home/jane'],
  ]);
  assert.deepEqual(kinds('server 89.1.2.3'), [['ip address', '89.1.2.3']]);
});

test('the public export scan leaves placeholders, private addresses and web addresses alone', () => {
  assert.deepEqual(kinds('a@example.com b@x.test noreply@anthropic.com 1+x@users.noreply.github.com'), []);
  assert.deepEqual(kinds('127.0.0.1 10.1.2.3 192.168.1.1 172.20.0.1 203.0.113.5 999.1.1.1'), []);
  assert.deepEqual(kinds('https://github.com/users/someone/projects/2 and /home/${name} and C:\\Users\\<you>'), []);
});

test('the public export scan finds local terms, and an allow entry explains a hit in its file only', () => {
  const terms: Terms = { terms: ['secretproject'], allow: [{ file: 'docs/', match: '^SecretProject$', why: 'quoted on purpose' }] };
  assert.deepEqual(scanText('src/a.ts', 'see SecretProject', terms).map((h) => [h.kind, h.text, h.allowed]), [['term', 'SecretProject', undefined]]);
  assert.deepEqual(scanText('docs/a.md', 'see SecretProject', terms).map((h) => h.allowed), ['quoted on purpose']);
  assert.equal(scanText('src/a.ts', 'see SecretProject', terms)[0]!.line, 1);
});

test('an allow entry with a kind explains only hits of that kind', () => {
  const terms: Terms = { terms: ['secretproject'], allow: [
    { file: 'docs/a.md', match: '.', why: 'any address here', kind: 'e-mail' },
    { file: 'docs/a.md', match: '^SecretProject$', why: 'quoted on purpose', kind: 'term' },
  ] };
  // In the order the scan checks its patterns: built-in kinds first (e-mail before home folder), then terms.
  const hits = scanText('docs/a.md', 'see SecretProject, /home/jane and jane.doe@company.se', terms);
  assert.deepEqual(hits.map((h) => [h.kind, h.allowed]), [['e-mail', 'any address here'], ['home folder', undefined], ['term', 'quoted on purpose']]);
});

test('the public export leaves out local folders and configs', () => {
  assert.ok(badFileName('.env') && badFileName('.env.production') && badFileName('key.pem') && badFileName('ledung.config.local.json') && badFileName('CLAUDE.local.md'));
  assert.ok(!badFileName('ledung.config.example.json') && !badFileName('environment.ts'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-public-test-'));
  try {
    for (const f of ['.ledung/scan.md', 'a/.test/data/x', '.claude/settings.json', 'CLAUDE.local.md', 'src/keep.ts', 'relay/relay.config.json', 'relay/relay.config.example.json',
      'docs/steps/shots-1/a.png', 'docs/steps/b.JPG', 'docs/steps/shots-1/results.txt', 'web/public/icon.png']) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), 'x');
    }
    // The screenshots under docs/steps/ are review evidence no scan can read (#411); the text beside them stays.
    assert.deepEqual(prune(root).sort(), ['.claude/', '.ledung/', 'CLAUDE.local.md', 'a/.test/', 'docs/steps/b.JPG', 'docs/steps/shots-1/a.png', 'relay/relay.config.json']);
    for (const kept of ['src/keep.ts', 'relay/relay.config.example.json', 'docs/steps/shots-1/results.txt', 'web/public/icon.png']) assert.ok(fs.existsSync(path.join(root, kept)), kept);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the public export scan flags every binary file no allow entry explains', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-public-test-'));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    fs.mkdirSync(path.join(root, 'web/public'), { recursive: true });
    fs.mkdirSync(path.join(root, 'shots'));
    fs.writeFileSync(path.join(root, 'web/public/icon.png'), png);
    fs.writeFileSync(path.join(root, 'shots/screen.png'), png);
    fs.writeFileSync(path.join(root, 'notes.md'), 'nothing here');
    // The reviewer's probe: high bytes and no NUL, so only a whole-file UTF-8 check calls it binary.
    fs.writeFileSync(path.join(root, 'shots/high.bin'), Buffer.alloc(100, 0xff));
    // A NUL past the first 8000 bytes still makes the file binary.
    fs.writeFileSync(path.join(root, 'shots/late.bin'), Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]));
    const who = { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@example.com' };
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: root, env: who });
    // The reviewer's probe: a text entry whose pattern happens to fit an image's name explains nothing.
    fs.mkdirSync(path.join(root, 'test'));
    fs.writeFileSync(path.join(root, 'test/sample.png'), png);
    const terms: Terms = { terms: [], allow: [
      { file: 'web/public/', match: '^icon\\.png$', why: 'the page icon', kind: 'binary' },
      { file: 'test/', match: 'sam', why: 'a fake user' },
    ] };
    const { hits, binary } = scanExport(root, terms);
    assert.equal(binary, 5);
    assert.deepEqual(hits.filter((h) => h.file !== '(commit)').map((h) => [h.file, h.kind, h.allowed]).sort(), [
      ['shots/high.bin', 'unscanned binary', undefined], ['shots/late.bin', 'unscanned binary', undefined], ['shots/screen.png', 'unscanned binary', undefined],
      ['test/sample.png', 'unscanned binary', undefined], ['web/public/icon.png', 'unscanned binary', 'the page icon'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
