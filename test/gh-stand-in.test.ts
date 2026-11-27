// The stand-in gh, part 2 of issue #513 (docs/steps/project-signature.md "GitHub: the stand-in gh"): which calls it
// records and signs, every body source, the marker, everything else passed through with the same output and exit
// code, and the fallback (no session file, a broken stand-in, Node missing, a journal that can't be written, the real
// gh moved). The shell script runs under sh (Git Bash on Windows) against a fake real gh that echoes what it got; the
// real gh, when installed, is compared on calls that need no network.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiCall, bodySource, classify, marker, signBody, type StandInSession } from '../src/gh/stand-in.ts';
import { findRealGh, installStandIn, pathKey, shellScript, standInRoot, updateStandIn, withStandIn } from '../src/gh/install.ts';
import { ghStandInEntry } from '../src/platform/paths.ts';
import { LEDUNG_DEFAULT_SIGNATURE, standInTexts } from '../src/shared/signature.ts';
import { removeTemp } from './temp.ts';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-standin-test-')));
after(() => {
  try {
    removeTemp(base);
  } catch {
    // Left in the temp folder.
  }
});

// --- What a call is -------------------------------------------------------------------------------------------

test('the four posting commands are signed in their place; edits, pr create and gh api only recorded', () => {
  assert.deepEqual(classify(['issue', 'create', '--title', 't', '--body', 'b']), { kind: 'issue', place: 'newIssue', repo: null });
  assert.deepEqual(classify(['issue', 'comment', '12', '-R', 'o/r', '-b', 'b']), { kind: 'issue-comment', place: 'issueComment', repo: 'o/r' });
  assert.deepEqual(classify(['pr', 'comment', '3', '--body-file', 'x']), { kind: 'pr-comment', place: 'prComment', repo: null });
  assert.deepEqual(classify(['pr', 'review', '3', '--approve', '-b', 'ok']), { kind: 'pr-review', place: 'prComment', repo: null });
  assert.deepEqual(classify(['pr', 'review', '3', '-r', '-b', 'no']), { kind: 'pr-review', place: 'prComment', repo: null });
  // A review without its kind is gh's interactive one: recorded, never signed.
  assert.deepEqual(classify(['pr', 'review', '3']), { kind: 'pr-review', place: null, repo: null });
  assert.deepEqual(classify(['pr', 'create', '--fill']), { kind: 'pr', place: null, repo: null });
  assert.deepEqual(classify(['issue', 'edit', '4', '--body', 'x']), { kind: 'issue-edit', place: null, repo: null });
  assert.deepEqual(classify(['pr', 'edit', '4', '--body', 'x']), { kind: 'pr-edit', place: null, repo: null });
  // Editing or deleting the last comment is an edit: no second signature on an edited post.
  assert.deepEqual(classify(['issue', 'comment', '4', '--edit-last', '-b', 'x']), { kind: 'issue-edit', place: null, repo: null });
  assert.deepEqual(classify(['pr', 'comment', '4', '--delete-last']), { kind: 'pr-edit', place: null, repo: null });
  // -R before the subcommand, as cobra allows.
  assert.deepEqual(classify(['issue', '-R', 'o/r', 'create', '-b', 'b']), { kind: 'issue', place: 'newIssue', repo: 'o/r' });
});

test('read-only and other calls are neither recorded nor signed', () => {
  for (const args of [
    ['pr', 'view', '5'], ['pr', 'checks', '5', '--watch'], ['pr', 'list'], ['pr', 'diff'], ['pr', 'merge', '5'],
    ['issue', 'view', '5', '--comments'], ['issue', 'list'], ['issue', 'close', '5'], ['run', 'watch'], ['auth', 'status'],
    ['repo', 'view'], ['--version'], [], ['api', 'repos/o/r/pulls'], ['api', 'repos/o/r', '--jq', '.name'], ['api', '-X', 'GET', 'user'],
    ['api', 'graphql', '-f', 'query={ viewer { login } }'], ['pr', '--help'],
  ]) assert.equal(classify(args), null, args.join(' '));
});

test('gh api writes: an explicit method, or fields without one; a GraphQL mutation', () => {
  assert.deepEqual(apiCall(['repos/o/r/issues/1/comments', '-f', 'body=hi']), { kind: 'api', place: null, repo: null, api: { method: 'POST', path: 'repos/o/r/issues/1/comments' } });
  assert.equal(apiCall(['-X', 'PATCH', 'repos/o/r/issues/1', '-f', 'state=closed'])?.api?.method, 'PATCH');
  assert.equal(apiCall(['--method=delete', 'repos/o/r/issues/comments/9'])?.api?.method, 'DELETE');
  assert.equal(apiCall(['-XPUT', 'repos/o/r/pulls/1/merge'])?.api?.method, 'PUT');
  assert.equal(apiCall(['repos/o/r/issues', '--input', 'body.json'])?.api?.method, 'POST');
  assert.equal(apiCall(['graphql', '-f', 'query=mutation { addComment(input: {}) { clientMutationId } }'])?.api?.path, 'graphql');
  assert.equal(apiCall(['repos/o/r/issues', '-X', 'GET', '-f', 'state=open']), null, 'GET with fields is a read');
});

test('the body comes from --body, --body-file or stdin, in every spelling; two sources or none: none', () => {
  const at = (args: string[]) => { const b = bodySource(args); return b && [b.kind, b.value, b.start, b.count]; };
  assert.deepEqual(at(['issue', 'comment', '1', '--body', 'hi']), ['text', 'hi', 3, 2]);
  assert.deepEqual(at(['issue', 'comment', '1', '-b', 'hi']), ['text', 'hi', 3, 2]);
  assert.deepEqual(at(['issue', 'comment', '1', '--body=hi=there']), ['text', 'hi=there', 3, 1]);
  assert.deepEqual(at(['issue', 'comment', '1', '-bhi']), ['text', 'hi', 3, 1]);
  assert.deepEqual(at(['issue', 'comment', '1', '--body-file', 'a.md']), ['file', 'a.md', 3, 2]);
  assert.deepEqual(at(['issue', 'comment', '1', '-F', '-']), ['stdin', '-', 3, 2]);
  assert.deepEqual(at(['issue', 'comment', '1', '--body-file=-']), ['stdin', '-', 3, 1]);
  // A flag's value that looks like --body is its value.
  assert.deepEqual(at(['issue', 'create', '--title', '--body', '--body', 'real']), ['text', 'real', 4, 2]);
  assert.equal(at(['issue', 'create', '-b', 'a', '-F', 'b.md']), null);
  assert.equal(at(['issue', 'create', '--fill']), null);
  assert.equal(at(['issue', 'comment', '1', '--', '--body', 'x']), null, 'after -- it is not a flag');
  // In a review, -a, -c and -r take no value.
  assert.deepEqual(bodySource(['pr', 'review', '1', '-a', '-b', 'ok'], true)?.value, 'ok');
});

test('a body is signed once: the text after a blank line, then the marker; never empty, marked or signed by hand', () => {
  assert.equal(signBody('Fixed.\n', '— via Ledung for Simon', 'run-208'), 'Fixed.\n\n— via Ledung for Simon\n<!-- ledung run-208 -->\n');
  assert.equal(signBody('Fixed.', '— via Ledung for Simon', null), 'Fixed.\n\n— via Ledung for Simon\n<!-- ledung -->\n');
  assert.equal(signBody('Fixed.\n\n— via Ledung for Simon\n<!-- ledung run-1 -->\n', '— via Ledung for Simon', 'run-2'), null);
  assert.equal(signBody('Fixed.\n\n— via Ledung for Simon\n', '— via Ledung for Simon', null), null);
  assert.equal(signBody('  \n', '— via Ledung for Simon', null), null);
  assert.equal(signBody('Fixed.', '', null), null);
  assert.equal(marker('run-3'), '<!-- ledung run-3 -->');
});

test("the stand-in's texts are the project's, filled in; Off empties them", () => {
  const launch = { off: false, texts: { ...LEDUNG_DEFAULT_SIGNATURE, prComment: 'via {project} {run}' }, values: { user: 'Simon', project: 'shop', run: 'run-7', workflow: 'Dev' } };
  assert.deepEqual(standInTexts(launch, 'Claude Haiku 5.5'), { newIssue: '— via Ledung for Simon', issueComment: '', prComment: 'via shop run-7', pr: '— via Ledung for Simon' });
  assert.deepEqual(standInTexts({ ...launch, off: true }, 'x'), { newIssue: '', issueComment: '', prComment: '', pr: '' });
});

// --- Finding the real gh and the environment ---------------------------------------------------------------------

test("the real gh is found on PATH by full path, never in the stand-in's own folder; on Windows only gh.exe", () => {
  const root = 'C:\\Temp\\ledung-gh-ab';
  const there = new Set(['C:\\Temp\\ledung-gh-ab\\s1\\gh.exe', 'C:\\Tools\\gh.cmd', 'C:\\Program Files\\GitHub CLI\\gh.exe']);
  const env = { Path: `${root}\\s1;C:\\Tools;"C:\\Program Files\\GitHub CLI";C:\\Windows` };
  assert.equal(findRealGh(env, root, 'win32', (p) => there.has(p)), 'C:\\Program Files\\GitHub CLI\\gh.exe');
  assert.equal(findRealGh({ PATH: '/tmp/ledung-gh-ab/s1:/opt/homebrew/bin:/usr/bin' }, '/tmp/ledung-gh-ab', 'darwin', (p) => p === '/opt/homebrew/bin/gh' || p === '/tmp/ledung-gh-ab/s1/gh'), '/opt/homebrew/bin/gh');
  assert.equal(findRealGh({ PATH: '/usr/bin' }, '/tmp/x', 'linux', () => false), null);
});

test("the stand-in's folder goes first on PATH, under the name the environment already uses", () => {
  assert.equal(pathKey({ Path: 'a' }), 'Path');
  assert.deepEqual(withStandIn({ Path: 'C:\\a', X: '1' }, 'C:\\gh', 'win32'), { Path: 'C:\\gh;C:\\a', X: '1' });
  assert.deepEqual(withStandIn({ PATH: '/usr/bin' }, '/tmp/gh', 'darwin'), { PATH: '/tmp/gh:/usr/bin' });
});

test('a session gets its own script and file; a changed signature rewrites only the file', () => {
  const data = path.join(base, 'data-install');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'gh.exe' : 'gh'), '');
  const session = { texts: { newIssue: 'n', issueComment: '', prComment: '', pr: 'p' }, record: true, run: 'run-1' };
  const dir = installStandIn({ dataDir: data, sessionId: 'abc/1', env: { [pathKey(process.env)]: bin }, session })!;
  try {
    assert.equal(path.dirname(dir), standInRoot(data));
    assert.ok(!dir.startsWith(data), 'not in the data folder, which sessions are kept out of (#104)');
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as StandInSession;
    assert.deepEqual(file, { ...session, real: [path.join(bin, process.platform === 'win32' ? 'gh.exe' : 'gh')] });
    const script = fs.readFileSync(path.join(dir, 'gh'), 'utf8');
    assert.match(script, /^#!\/bin\/sh\n/);
    assert.ok(fs.readdirSync(standInRoot(data)).some((f) => /^gh-[0-9a-f]{12}\.m[jt]s$/.test(f)), 'the stand-in copied by version');
    updateStandIn(data, 'abc/1', { ...session, texts: { ...session.texts, newIssue: 'changed' } });
    assert.equal((JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) as StandInSession).texts.newIssue, 'changed');
    assert.equal(fs.readFileSync(path.join(dir, 'gh'), 'utf8'), script);
    // No real gh: no stand-in.
    assert.equal(installStandIn({ dataDir: data, sessionId: 'x', env: { PATH: path.join(base, 'nothing') }, session }), null);
  } finally {
    removeTemp(standInRoot(data));
  }
});

// --- The script against a fake real gh ---------------------------------------------------------------------------

/** sh where the session's shell is: Git Bash's on Windows. */
function findSh(): string | null {
  if (process.platform !== 'win32') return '/bin/sh';
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files']) {
    const sh = root && path.join(root, 'Git', 'bin', 'sh.exe');
    if (sh && fs.existsSync(sh)) return sh;
  }
  return null;
}
const SH = findSh();
const noSh = SH ? false : 'no sh (Git Bash) on this computer';

// The real gh as a test sees it: it prints what it got (arguments, stdin, the body file's text), a link, and exits
// with FAKE_EXIT; FAKE_ERR goes to stderr.
const fake = path.join(base, 'fake-gh.mjs');
fs.writeFileSync(fake, `import fs from 'node:fs';
const args = process.argv.slice(2);
const i = args.indexOf('--body-file');
const file = i >= 0 && args[i + 1] !== '-' ? args[i + 1] : null;
const stdin = process.env.FAKE_STDIN ? fs.readFileSync(0, 'utf8') : null;
process.stdout.write(JSON.stringify({ args, stdin, body: file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null }) + '\\n');
process.stdout.write('https://github.com/o/r/issues/9\\n');
if (process.env.FAKE_ERR) process.stderr.write(process.env.FAKE_ERR);
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`);

let made = 0;
/** A session's stand-in folder by hand, with the fake as the real gh. */
function standIn(o: { texts?: Partial<StandInSession['texts']>; record?: boolean; run?: string | null; node?: string; entry?: string; real?: string[]; noFile?: boolean } = {}) {
  const dir = path.join(base, `s${++made}`);
  fs.mkdirSync(dir, { recursive: true });
  const real = o.real ?? [process.execPath, fake];
  const session: StandInSession = {
    real, record: o.record ?? true, run: o.run === undefined ? 'run-208' : o.run,
    texts: { newIssue: '— via Ledung for Simon', issueComment: '— via Ledung', prComment: '— via Ledung', pr: '— via Ledung for Simon', ...o.texts },
  };
  const file = path.join(dir, 'session.json');
  if (!o.noFile) fs.writeFileSync(file, JSON.stringify(session));
  fs.writeFileSync(path.join(dir, 'gh'), shellScript({ node: o.node ?? process.execPath, standIn: o.entry ?? ghStandInEntry(false), session: file, real }), { mode: 0o755 });
  const journal = () => (fs.existsSync(path.join(dir, 'journal.jsonl')) ? fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  return { dir, journal };
}

/** `gh <args>` through the stand-in, as the session's shell runs it. */
function gh(dir: string, args: string[], o: { input?: string; env?: Record<string, string>; cwd?: string } = {}) {
  const r = spawnSync(SH!, [path.join(dir, 'gh'), ...args], { input: o.input ?? '', cwd: o.cwd ?? base, env: { ...process.env, ...o.env }, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** The fake real gh called directly, to compare. */
function direct(args: string[], o: { input?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(process.execPath, [fake, ...args], { input: o.input ?? '', cwd: base, env: { ...process.env, ...o.env }, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const got = (stdout: string) => JSON.parse(stdout.split('\n')[0]!) as { args: string[]; stdin: string | null; body: string | null };

test('gh issue create --body: signed through a body file, removed afterwards, recorded with its link', { skip: noSh }, () => {
  const s = standIn();
  const r = gh(s.dir, ['issue', 'create', '--title', 'T', '--body', 'Broken & <done> "q" 50% !x $HOME']);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const g = got(r.stdout);
  assert.deepEqual(g.args.slice(0, 3), ['issue', 'create', '--title']);
  assert.equal(g.args[4], '--body-file');
  assert.equal(g.body, 'Broken & <done> "q" 50% !x $HOME\n\n— via Ledung for Simon\n<!-- ledung run-208 -->\n');
  assert.equal(fs.existsSync(g.args[5]!), false, 'the signed body file is removed');
  assert.match(r.stdout, /issues\/9/, "gh's own output comes through");
  const [line] = s.journal();
  assert.equal(line!.kind, 'issue');
  assert.equal(line!.signed, true);
  assert.equal(line!.url, 'https://github.com/o/r/issues/9');
  assert.equal(line!.exit, 0);
  assert.equal('body' in line!, false, 'no body is kept');
});

test('gh issue comment --body-file <file>: signed; the file itself is untouched', { skip: noSh }, () => {
  const s = standIn({ run: null });
  const file = path.join(base, 'comment.md');
  fs.writeFileSync(file, 'Looks good.\n');
  const g = got(gh(s.dir, ['issue', 'comment', '12', '-R', 'o/r', '--body-file', file]).stdout);
  assert.equal(g.body, 'Looks good.\n\n— via Ledung\n<!-- ledung -->\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'Looks good.\n');
  assert.equal(s.journal()[0]!.repo, 'o/r');
});

test('gh pr comment -F - (stdin): signed, and gh gets an empty stdin', { skip: noSh }, () => {
  const s = standIn();
  const g = got(gh(s.dir, ['pr', 'comment', '3', '-F', '-'], { input: 'From stdin.\nTwo lines.', env: { FAKE_STDIN: '1' } }).stdout);
  assert.equal(g.body, 'From stdin.\nTwo lines.\n\n— via Ledung\n<!-- ledung run-208 -->\n');
  assert.equal(g.stdin, '');
});

test('gh pr review --approve --body: signed; a review with no kind is passed on unsigned', { skip: noSh }, () => {
  const s = standIn();
  assert.equal(got(gh(s.dir, ['pr', 'review', '3', '--approve', '--body', 'Ship it']).stdout).body, 'Ship it\n\n— via Ledung\n<!-- ledung run-208 -->\n');
  assert.deepEqual(got(gh(s.dir, ['pr', 'review', '3', '--body', 'x']).stdout).args, ['pr', 'review', '3', '--body', 'x']);
  assert.deepEqual(s.journal().map((l) => l.signed), [true, false]);
});

test('a repeated post, or one signed by hand, is not signed twice', { skip: noSh }, () => {
  const s = standIn();
  const once = 'Done.\n\n— via Ledung for Simon\n<!-- ledung run-208 -->\n';
  assert.deepEqual(got(gh(s.dir, ['issue', 'create', '-t', 'T', '-b', once]).stdout).args, ['issue', 'create', '-t', 'T', '-b', once]);
  assert.deepEqual(got(gh(s.dir, ['issue', 'create', '-t', 'T', '-b', 'Done.\n\n— via Ledung for Simon']).stdout).args.at(-1), 'Done.\n\n— via Ledung for Simon');
});

test("pr create and edits are never signed: same arguments; pr create records whether Claude Code's PR line is there", { skip: noSh }, () => {
  const s = standIn();
  for (const args of [['pr', 'create', '-t', 'T', '-b', 'Body\n\n— via Ledung for Simon'], ['pr', 'edit', '3', '-b', 'x'], ['issue', 'edit', '3', '-b', 'x'], ['issue', 'comment', '3', '--edit-last', '-b', 'x']]) {
    assert.deepEqual(got(gh(s.dir, args).stdout).args, args);
  }
  assert.deepEqual(s.journal().map((l) => [l.kind, l.signed, l.prLine]), [['pr', false, true], ['pr-edit', false, undefined], ['issue-edit', false, undefined], ['issue-edit', false, undefined]]);
});

test('a place with no text: the call is only recorded, its stdin untouched', { skip: noSh }, () => {
  const s = standIn({ texts: { issueComment: '' } });
  const args = ['issue', 'comment', '3', '-F', '-'];
  const g = got(gh(s.dir, args, { input: 'kept as it is', env: { FAKE_STDIN: '1' } }).stdout);
  assert.deepEqual(g.args, args);
  assert.equal(g.stdin, 'kept as it is');
  assert.deepEqual(s.journal().map((l) => [l.kind, l.signed]), [['issue-comment', false]]);
});

test('recording off: signed all the same, nothing journalled', { skip: noSh }, () => {
  const s = standIn({ record: false });
  assert.match(got(gh(s.dir, ['issue', 'create', '-t', 'T', '-b', 'x']).stdout).body!, /via Ledung/);
  assert.deepEqual(s.journal(), []);
});

test('gh api writes are recorded by method and path, never signed; reads not recorded', { skip: noSh }, () => {
  const s = standIn();
  const write = ['api', 'repos/o/r/issues/1/comments', '-f', 'body=hi'];
  assert.deepEqual(got(gh(s.dir, write).stdout).args, write);
  gh(s.dir, ['api', 'repos/o/r/pulls', '--jq', '.[].number']);
  assert.deepEqual(s.journal().map((l) => [l.kind, l.api, l.url, l.signed]), [['api', { method: 'POST', path: 'repos/o/r/issues/1/comments' }, null, false]]);
});

test('every other call: the same output, stderr and exit code as the real gh, and not recorded', { skip: noSh }, () => {
  const s = standIn();
  const calls: [string[], Record<string, string>][] = [
    [['pr', 'view', '5'], {}], [['pr', 'checks', '5'], { FAKE_EXIT: '8' }], [['run', 'watch', '77'], {}], [['auth', 'status'], { FAKE_EXIT: '1', FAKE_ERR: 'not logged in\n' }],
    [['api', 'repos/o/r/pulls/5'], {}], [['--version'], {}], [['issue', 'view', '5', '--json', 'title,body'], { FAKE_EXIT: '1', FAKE_ERR: 'no such issue' }],
    [['repo', 'view', 'a b', '50% & <done> "q" !x ^y $HOME'], {}],
  ];
  for (const [args, env] of calls) assert.deepEqual(gh(s.dir, args, { env }), direct(args, { env }), args.join(' '));
  // A call that waits for input gets the caller's stdin.
  assert.deepEqual(gh(s.dir, ['pr', 'merge', '5'], { input: 'y\n', env: { FAKE_STDIN: '1' } }), direct(['pr', 'merge', '5'], { input: 'y\n', env: { FAKE_STDIN: '1' } }));
  assert.deepEqual(s.journal(), []);
});

test("a signed or recorded call's exit code and stderr are the real gh's", { skip: noSh }, () => {
  const s = standIn();
  const r = gh(s.dir, ['issue', 'comment', '9', '-R', 'o/nonexistent', '-b', 'x'], { env: { FAKE_EXIT: '1', FAKE_ERR: 'GraphQL: Could not resolve to a Repository' } });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, 'GraphQL: Could not resolve to a Repository');
  assert.equal(s.journal()[0]!.exit, 1);
});

test('fallback: no session file, a broken stand-in, or Node missing: the real gh with the original call, silently', { skip: noSh }, () => {
  const broken = path.join(base, 'broken.mjs');
  fs.writeFileSync(broken, 'export function main( {{{ not code');
  const args = ['issue', 'comment', '3', '-F', '-'];
  const env = { FAKE_STDIN: '1', FAKE_EXIT: '4' };
  const expected = direct(args, { input: 'piped', env });
  for (const [why, s] of [
    ['no session file', standIn({ noFile: true })],
    ['a broken stand-in', standIn({ entry: broken })],
    ['a missing stand-in', standIn({ entry: path.join(base, 'gone.mjs') })],
    ['Node missing', standIn({ node: path.join(base, 'no-node', 'node.exe') })],
  ] as const) {
    assert.deepEqual(gh(s.dir, args, { input: 'piped', env }), expected, why);
  }
});

test('fallback: a journal that cannot be written changes nothing of the answer', { skip: noSh }, () => {
  const s = standIn();
  fs.mkdirSync(path.join(s.dir, 'journal.jsonl'));
  const r = gh(s.dir, ['issue', 'create', '-t', 'T', '-b', 'x'], { env: { FAKE_EXIT: '0' } });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(got(r.stdout).body!, /via Ledung/);
});

test('fallback: the real gh moved: the next gh on PATH after its own folder', { skip: noSh }, () => {
  const other = path.join(base, 'other-bin');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'gh'), '#!/bin/sh\necho "next gh: $*"\nexit 3\n', { mode: 0o755 });
  const s = standIn({ real: [path.join(base, 'moved', 'gh.exe')] });
  const sep = process.platform === 'win32' ? ';' : ':';
  const r = spawnSync(SH!, ['-c', 'gh pr view 5'], { cwd: base, env: { ...process.env, [pathKey(process.env)]: [s.dir, other, process.env[pathKey(process.env)]].join(sep) }, encoding: 'utf8' });
  assert.equal(r.stdout, 'next gh: pr view 5\n');
  assert.equal(r.status, 3);
});

test('found by name on PATH, the stand-in signs: what a session\'s shell does', { skip: noSh }, () => {
  const s = standIn();
  const sep = process.platform === 'win32' ? ';' : ':';
  const r = spawnSync(SH!, ['-c', "printf 'via the pipe' | gh issue comment 1 --body-file -"], { cwd: base, env: { ...process.env, FAKE_STDIN: '1', [pathKey(process.env)]: `${s.dir}${sep}${process.env[pathKey(process.env)]}` }, encoding: 'utf8' });
  assert.equal(got(r.stdout).body, 'via the pipe\n\n— via Ledung\n<!-- ledung run-208 -->\n');
});

// --- The real gh, where installed: calls that need no network ------------------------------------------------------

const realGh = findRealGh(process.env, standInRoot(path.join(base, 'none')));
test('with the real gh: the same output and exit code through the stand-in', { skip: noSh || (realGh ? false : 'gh is not installed') }, () => {
  const s = standIn({ real: [realGh!] });
  const run = (args: string[]) => spawnSync(realGh!, args, { cwd: base, encoding: 'utf8', env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
  for (const args of [['--version'], ['issue', 'create', '--help'], ['pr', 'review', '--help'], ['api', '--help'], ['no-such-command'], ['issue', 'comment']]) {
    const want = run(args);
    const r = gh(s.dir, args, { env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    assert.deepEqual([r.status, r.stdout, r.stderr], [want.status, want.stdout, want.stderr], args.join(' '));
  }
});
