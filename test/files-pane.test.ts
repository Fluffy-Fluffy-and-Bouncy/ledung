// The Files pane (issue #225, a test feature): the tree keeps the file viewer's rules, the diff of a session's
// changes runs git hardened, and line comments travel in a form a manager can read and hand on.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listTree } from '../src/sessions/tree.ts';
import { gitEnv, gitRead } from '../src/sessions/git-read.ts';
import { parseDiff, sessionChanges } from '../src/sessions/changes.ts';
import { checkLineComments, formatLineComments, lineCommentsMessage, openReviewFor, reviewAnswerWithComments, type LineComment } from '../src/shared/line-comments.ts';
import { reviewAnswerProblem } from '../src/shared/questions.ts';
import type { QuestionInfo } from '../src/shared/protocol.ts';
import { putLineDraft, readLineDrafts, writeLineDrafts } from '../web/src/lineCommentDrafts.ts';
import { colourDiff, HIGHLIGHT_MAX_LINES, languageOf, splitHighlighted } from '../web/src/highlight.ts';
import { highlight } from '../web/src/highlightCore.ts';
import { removeTemp } from './temp.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-pane-'));
after(() => removeTemp(base));

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
/** A repository on main with one commit, then a branch "work" with a second. */
function repo(name: string, first: Record<string, string>, second: Record<string, string | null>): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.test');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const write = (files: Record<string, string | null>) => {
    for (const [f, text] of Object.entries(files)) {
      const at = path.join(dir, f);
      if (text === null) fs.rmSync(at);
      else {
        fs.mkdirSync(path.dirname(at), { recursive: true });
        fs.writeFileSync(at, text);
      }
    }
  };
  write(first);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'one');
  git(dir, 'switch', '-q', '-c', 'work');
  write(second);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'two');
  return dir;
}
const slash = (p: string) => p.replace(/\\/g, '/');

// --- The tree ---------------------------------------------------------------------------------------

const root = path.join(base, 'project');
const outside = path.join(base, 'outside');
const settings = path.join(base, 'settings-home', 'AppData');
for (const d of ['src/deep', '.claude/worktrees', 'src/.cache', '$Recycle', 'node_modules/pkg', 'dist', 'docs']) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.mkdirSync(path.join(settings, 'Roaming'), { recursive: true });
fs.writeFileSync(path.join(root, 'README.md'), '# r');
fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a');
fs.writeFileSync(path.join(root, 'src', '.hidden.ts'), 'h');
fs.writeFileSync(path.join(root, 'src', 'deep', 'b.ts'), 'b');
fs.writeFileSync(path.join(root, 'dist', 'out.js'), 'o');
fs.writeFileSync(path.join(root, 'debug.log'), 'l');
fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n*.log\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
git(root, 'init', '-q', '-b', 'main');
const rules = { refused: [settings], hiddenFrom: [] as string[] };
const names = async (rel: string, r = rules) => (await listTree(root, rel, r)).entries.map((e) => e.name);

test('the tree lists one folder at a time, folders first, with paths relative to the root', async () => {
  const top = await listTree(root, '', rules);
  assert.equal(top.path, '');
  assert.deepEqual(top.entries.map((e) => [e.name, e.dir]), [
    ['dist', true], ['docs', true], ['node_modules', true], ['src', true], ['debug.log', false], ['README.md', false],
  ]);
  const src = await listTree(root, 'src', rules);
  assert.deepEqual(src.entries.map((e) => e.path), ['src/deep', 'src/a.ts'], 'one level only: deep/b.ts waits for its own request');
});

test('dot- and $-names are hidden at every level, and asking for one is refused', async () => {
  assert.ok(!(await names('')).some((n) => n.startsWith('.') || n.startsWith('$')));
  assert.deepEqual(await names('src'), ['deep', 'a.ts']);
  for (const hidden of ['.claude', '.claude/worktrees', 'src/.cache', '$Recycle', '.git']) {
    await assert.rejects(listTree(root, hidden, rules), /Hidden/, hidden);
  }
});

test('the tree never leaves the root: not by .., an absolute path, a link or a junction', async () => {
  for (const bad of ['..', '../outside', outside, 'src/../../outside']) {
    await assert.rejects(listTree(root, bad, rules), /inside the session's folder/, bad);
  }
  fs.symlinkSync(outside, path.join(root, 'docs', 'out-link'), 'junction');
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'docs', 'src-link'), 'junction');
  fs.symlinkSync(path.join(root, '.claude'), path.join(root, 'docs', 'claude-link'), 'junction');
  assert.deepEqual(await names('docs'), ['src-link'], 'a link inside the root stays; one out of it or into a dot-folder is left out');
  await assert.rejects(listTree(root, 'docs/out-link', rules), /inside the session's folder/);
  await assert.rejects(listTree(root, 'docs/claude-link', rules), /Hidden/);
});

test('folders where settings and sign-ins are kept are left out, and asking for one is refused', async () => {
  const home = path.join(base, 'settings-home');
  const asHome = { refused: [settings], hiddenFrom: [] };
  assert.deepEqual((await listTree(home, '', asHome)).entries, []);
  await assert.rejects(listTree(home, 'AppData', asHome), /settings and sign-ins/);
  await assert.rejects(listTree(settings, '', asHome), /settings and sign-ins/, 'a chat started inside one lists nothing');
});

test('node_modules and what .gitignore names are greyed: marked, not left to open', async () => {
  const top = Object.fromEntries((await listTree(root, '', rules)).entries.map((e) => [e.name, e.skipped]));
  assert.equal(top.node_modules, 'heavy');
  assert.equal(top.dist, 'ignored', 'a folder pattern ("dist/") matches the folder');
  assert.equal(top['debug.log'], 'ignored');
  assert.equal(top.src, null);
  assert.equal(top['README.md'], null);
});

test("a chat's tree also refuses what sits under a dot-folder above its folder (from the browse root)", async () => {
  const home = path.join(base, 'chat-home');
  fs.mkdirSync(path.join(home, '.ssh', 'keys'), { recursive: true });
  const chat = { refused: [], hiddenFrom: [home] };
  await assert.rejects(listTree(path.join(home, '.ssh'), '', chat), /Hidden/);
  await assert.rejects(listTree(path.join(home, '.ssh'), 'keys', chat), /Hidden/);
});

/** The Windows 8.3 short name of `dir` (for example SSH~1 for .ssh), or null when the volume makes none. */
function shortName(dir: string): string | null {
  const r = spawnSync('cmd', ['/d', '/c', `for %I in ("${dir}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true });
  const s = r.stdout.trim();
  return s && path.basename(s).toLowerCase() !== path.basename(dir).toLowerCase() ? s : null;
}

test("a dot-folder's Windows short name can't get round the dot rule in the tree (#211, #219)", { skip: process.platform !== 'win32' }, async (t) => {
  const short = shortName(path.join(root, '.claude'));
  if (!short) {
    t.skip('this volume makes no 8.3 short names');
    return;
  }
  await assert.rejects(listTree(root, path.basename(short), rules), /Hidden/);
  await assert.rejects(listTree(root, `${path.basename(short)}/worktrees`, rules), /Hidden/);
});

// --- The hardened diff --------------------------------------------------------------------------------

/** A repository whose config and attributes name a program for every channel git has; each writes a marker file. */
function hostileRepo(name: string): { dir: string; markers: () => string[] } {
  const dir = repo(name, { 'a.txt': 'one\n' }, { 'a.txt': 'two\n' });
  const marker = (n: string) => slash(path.join(dir, n));
  git(dir, 'config', 'diff.external', `sh -c 'echo x > "${marker('m-external')}"'`);
  fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '*.txt diff=evil\n');
  git(dir, 'config', 'diff.evil.textconv', `sh -c 'echo x > "${marker('m-textconv')}"; cat "$1"' -`);
  git(dir, 'config', 'core.fsmonitor', `sh -c 'echo x > "${marker('m-fsmonitor')}"'`);
  fs.mkdirSync(path.join(dir, 'hooks'));
  fs.writeFileSync(path.join(dir, 'hooks', 'pre-commit'), `#!/bin/sh\necho x > "${marker('m-hook')}"\n`, { mode: 0o755 });
  git(dir, 'config', 'core.hooksPath', slash(path.join(dir, 'hooks')));
  return { dir, markers: () => fs.readdirSync(dir).filter((f) => f.startsWith('m-')).sort() };
}

/**
 * The positive branch of a marker test: the same git without the hardening does start the program here, so a
 * missing marker means the switch held, not that this machine can't run the probe (test review, finding 5).
 */
function plainGitFires(dir: string, args: string[], marker: string, opts: { env?: NodeJS.ProcessEnv; shell?: boolean } = {}): void {
  spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: opts.env, shell: opts.shell });
  assert.ok(fs.existsSync(path.join(dir, marker)), `plain git ${args.join(' ')} wrote ${marker}`);
  for (const f of fs.readdirSync(dir)) if (f.startsWith('m-') || f === 'pwned') fs.rmSync(path.join(dir, f));
}

test("the diff runs none of the programs a session's repository names, and still shows the change", async () => {
  const { dir, markers } = hostileRepo('hostile');
  plainGitFires(dir, ['diff', 'main', 'HEAD'], 'm-external');
  plainGitFires(dir, ['diff', '--no-ext-diff', 'main', 'HEAD'], 'm-textconv');
  const changes = await sessionChanges(dir);
  assert.deepEqual(markers(), [], 'no external diff and no textconv ran');
  assert.equal(changes.problem, null);
  assert.equal(changes.base, 'main');
  assert.equal(changes.branch, 'work');
  assert.equal(changes.head, git(dir, 'rev-parse', 'HEAD'));
  assert.equal(changes.baseCommit, git(dir, 'rev-parse', 'main'));
  assert.equal(changes.files.length, 1);
  const f = changes.files[0]!;
  assert.deepEqual([f.path, f.status, f.added, f.removed], ['a.txt', 'modified', 1, 1]);
  assert.deepEqual(f.hunks[0]!.lines, [
    { kind: 'del', old: 1, new: null, text: 'one' },
    { kind: 'add', old: null, new: 1, text: 'two' },
  ]);
});

test('every git the pane runs has fsmonitor, hooks and the external diff switched off on its command line', async () => {
  const { dir, markers } = hostileRepo('hostile-runner');
  plainGitFires(dir, ['diff', 'main', 'HEAD'], 'm-external');
  plainGitFires(dir, ['-c', 'diff.evil.textconv=', 'status', '--porcelain'], 'm-fsmonitor');
  plainGitFires(dir, ['-c', 'diff.evil.textconv=', 'commit', '-q', '--allow-empty', '-m', 'plain'], 'm-hook');
  // Commands the pane never runs, but which would start each program if the switches were missing.
  await gitRead(dir, ['diff', 'main', 'HEAD']); // the external diff, without --no-ext-diff
  await gitRead(dir, ['-c', 'diff.evil.textconv=', 'status', '--porcelain']); // fsmonitor
  await gitRead(dir, ['-c', 'diff.evil.textconv=', 'commit', '-q', '--allow-empty', '-m', 'x']); // the pre-commit hook
  assert.deepEqual(markers(), []);
});

test("Ledung's own GIT_* settings never reach git: no external diff and no config through the environment", async () => {
  const dir = repo('env', { 'a.txt': 'one\n' }, { 'a.txt': 'two\n' });
  const marker = slash(path.join(dir, 'm-env'));
  plainGitFires(dir, ['diff', 'main', 'HEAD'], 'm-env', { env: { ...process.env, GIT_EXTERNAL_DIFF: `sh -c 'echo x > "${marker}"'` } });
  plainGitFires(dir, ['diff', 'main', 'HEAD'], 'm-env', { env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.external', GIT_CONFIG_VALUE_0: `sh -c 'echo x > "${marker}"'` } });
  const saved = { ...process.env };
  try {
    process.env.GIT_EXTERNAL_DIFF = `sh -c 'echo x > "${marker}"'`;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'diff.external';
    process.env.GIT_CONFIG_VALUE_0 = `sh -c 'echo x > "${marker}"'`;
    assert.equal(gitEnv().GIT_EXTERNAL_DIFF, undefined);
    await gitRead(dir, ['diff', 'main', 'HEAD']);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  assert.equal(fs.existsSync(path.join(dir, 'm-env')), false);
});

test('git is started without a shell: a branch name with shell syntax stays a name', async () => {
  const dir = repo('shell', { 'a.txt': 'one\n' }, { 'a.txt': 'two\n' });
  // "&" and ">" are allowed in a branch name; through cmd.exe or sh this would write a file named "pwned".
  const evil = 'x&echo>pwned';
  // In packed-refs, because Windows allows no ">" in a file name.
  fs.writeFileSync(path.join(dir, '.git', 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${git(dir, 'rev-parse', 'main')} refs/remotes/origin/${evil}\n`);
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${evil}`);
  plainGitFires(dir, ['merge-base', `origin/${evil}`, 'HEAD'], 'pwned', { shell: true });
  const changes = await sessionChanges(dir);
  assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
  assert.equal(changes.base, `origin/${evil}`, "the remote's default branch is the base, taken as a name");
  assert.equal(changes.files.length, 1);
});

test('the diff is capped, and says so when it is cut', async () => {
  const big = Array.from({ length: 4000 }, (_, i) => `line ${i}\n`).join('');
  const dir = repo('big', { 'a.txt': 'start\n' }, { 'a.txt': big });
  const whole = await sessionChanges(dir);
  assert.equal(whole.truncated, false);
  assert.equal(whole.files[0]!.added, 4000);
  const cut = await sessionChanges(dir, { maxBytes: 2000 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.files[0]!.added > 0 && cut.files[0]!.added < 4000, `${cut.files[0]!.added} lines arrived before the cut`);
});

test("the diff stays in the session's own folder: a session in a subfolder sees only that folder's changes", async () => {
  const dir = repo('sub', { 'mine/a.txt': 'a\n', 'other/b.txt': 'b\n' }, { 'mine/a.txt': 'a2\n', 'other/b.txt': 'b2\n' });
  const changes = await sessionChanges(path.join(dir, 'mine'));
  assert.deepEqual(changes.files.map((f) => f.path), ['a.txt']);
});

test('a folder that is not a repository, or has no main branch, says why instead of a diff', async () => {
  const plain = path.join(base, 'not-a-repo');
  fs.mkdirSync(plain);
  assert.match((await sessionChanges(plain)).problem ?? '', /not a git repository/);
  const lone = repo('lone', { 'a.txt': 'a\n' }, { 'a.txt': 'b\n' });
  git(lone, 'branch', '-q', '-m', 'main', 'trunk');
  assert.match((await sessionChanges(lone)).problem ?? '', /no main branch/);
});

test('the parser reads added, deleted, renamed and binary files, and numbers each side', () => {
  const files = parseDiff([
    'diff --git a/new.ts b/new.ts', 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,2 @@', '+a', '+b',
    'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-x',
    'diff --git a/old name.ts b/new name.ts', 'similarity index 90%', 'rename from old name.ts', 'rename to new name.ts',
    '--- a/old name.ts', '+++ b/new name.ts', '@@ -10,3 +10,3 @@ fn', ' same', '-was', '+now', ' same', '\\ No newline at end of file',
    'diff --git a/pic.png b/pic.png', 'index 1..2 100644', 'Binary files a/pic.png and b/pic.png differ', '',
  ].join('\n'));
  assert.deepEqual(files.map((f) => [f.path, f.oldPath, f.status, f.binary, f.added, f.removed]), [
    ['new.ts', null, 'added', false, 2, 0],
    ['gone.ts', null, 'deleted', false, 0, 1],
    ['new name.ts', 'old name.ts', 'renamed', false, 1, 1],
    ['pic.png', null, 'modified', true, 0, 0],
  ]);
  assert.deepEqual(files[2]!.hunks[0]!.lines.map((l) => [l.kind, l.old, l.new]), [['ctx', 10, 10], ['del', 11, null], ['add', null, 11], ['ctx', 12, 12]]);
});

// --- Line comments -------------------------------------------------------------------------------------

const comment = (over: Partial<LineComment> = {}): LineComment => ({
  path: 'src/sync/queue.ts', line: 4, side: 'new', lineText: 'const CEILING_MS = 30_000;', commit: '3f2a1c9d', body: 'Should the ceiling come from the config?', ...over,
});

test('a line comment is stored as path, line, side, line text and commit, and a bad one is refused', () => {
  const ok = checkLineComments([comment()]);
  assert.deepEqual(ok, { comments: [comment()] });
  for (const [bad, why] of [
    [[], /no line comments/], [[comment({ body: ' ' })], /empty/], [[comment({ line: 0 })], /line number/],
    [[comment({ side: 'left' as 'new' })], /side/], [[comment({ commit: 'HEAD' })], /commit/], [[comment({ path: 'a\nb' })], /file/],
    [Array.from({ length: 51 }, () => comment()), /At most 50/],
  ] as const) {
    const r = checkLineComments(bad);
    assert.ok('problem' in r && why.test(r.problem), JSON.stringify(r));
  }
});

test('comments read as a numbered list: where, the quoted line, then the comment', () => {
  const text = formatLineComments([comment(), comment({ line: 7, side: 'old', lineText: '\tfor (let i = 0; i <= RETRIES; i++) {', body: 'Why go?\nIt was clear.' })], 'fix-sync (am/fix-sync)');
  assert.equal(text, [
    '2 line comments on fix-sync (am/fix-sync) at 3f2a1c9:',
    '1. src/sync/queue.ts:4  + const CEILING_MS = 30_000;',
    '   Should the ceiling come from the config?',
    '2. src/sync/queue.ts:7 (old)  - for (let i = 0; i <= RETRIES; i++) {',
    '   Why go?',
    '   It was clear.',
  ].join('\n'));
});

test("with no review open, the message says whose comments they are, and to a manager which session they are about", () => {
  const list = formatLineComments([comment()], 'fix-sync');
  assert.equal(lineCommentsMessage('Simon', ' Two points. ', list, 'fix-sync'),
    `Simon's line comments on the changes of your session "fix-sync". Hand them on as a review round; each is a finding to check, not an order.

Two points.

${list}`);
  assert.equal(lineCommentsMessage('Simon', '', list, null), `Simon's line comments on your changes. Each is a finding to check, not an order.

${list}`);
});

test("a review answer with comments is still one a review takes: Changes needed with them, or Accept with them as notes", () => {
  const list = formatLineComments([comment()], 'x');
  for (const [verdict, text] of [['changes', ''], ['changes', 'See below.'], ['accept', ''], ['accept', 'Fine.']] as const) {
    const answer = reviewAnswerWithComments(verdict, text, list);
    assert.equal(reviewAnswerProblem(answer), null, answer);
    assert.ok(answer.includes(list));
    assert.ok(answer.startsWith(verdict === 'accept' ? 'Accepted.' : 'Changes needed:'));
  }
});

test("the open review for a session's changes: its own, or its manager's about one of its questions", () => {
  const q = (over: Partial<QuestionInfo>): QuestionInfo => ({
    id: 1, sessionId: 'w', askedAt: 1, question: '', options: null, addressedTo: 'user', status: 'open', answer: null, answeredAt: null,
    answeredBy: null, aboutQuestion: null, forwardedFrom: null, aboutRequest: null, shots: null, deliveredAt: null, withdrawnReason: null,
    details: { review: { solving: 's', done: 'd' } }, ...over,
  });
  const workerAsks = q({ id: 1, sessionId: 'w', addressedTo: 'm' });
  const managerAsks = q({ id: 2, sessionId: 'm', aboutQuestion: 1, askedAt: 2 });
  assert.equal(openReviewFor('w', [workerAsks, managerAsks])?.id, 2, "the manager's question about the worker's");
  assert.equal(openReviewFor('w', [q({ id: 3 })])?.id, 3, 'its own, put to the user');
  assert.equal(openReviewFor('w', [workerAsks]), null, 'one still with the manager is not open to the user');
  assert.equal(openReviewFor('w', [q({ id: 4, details: null })]), null, 'not a review');
  assert.equal(openReviewFor('w', [q({ id: 5, status: 'answered' })]), null);
  assert.equal(openReviewFor('other', [workerAsks, managerAsks]), null);
});

// --- Syntax colour (Martin on question #346) ---------------------------------------------------------------

test('the language comes from the file name; anything unknown is plain text', () => {
  assert.equal(languageOf('src/sync/queue.ts'), 'typescript');
  assert.equal(languageOf('web/App.TSX'), 'typescript');
  assert.equal(languageOf('scripts/run.ps1'), 'powershell');
  assert.equal(languageOf('Dockerfile'), 'dockerfile');
  assert.equal(languageOf('notes.txt'), null);
  assert.equal(languageOf('LICENSE'), null);
});

test('a span open across a line break is closed and opened again, so every line stands alone', () => {
  assert.deepEqual(splitHighlighted('a <span class="c">/* one\ntwo */</span> b\n<span class="k">x</span>'), [
    'a <span class="c">/* one</span>',
    '<span class="c">two */</span> b',
    '<span class="k">x</span>',
  ]);
});

test('colouring keeps one line per line, escapes the text, and marks keywords and strings', () => {
  const code = 'const a = "<b>";\n/* x\n y */\nif (a) {}';
  const lines = highlight(code, 'typescript');
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /<span class="hljs-keyword">const<\/span>/);
  assert.match(lines[0]!, /<span class="hljs-string">&quot;&lt;b&gt;&quot;<\/span>/);
  assert.ok(!lines.join('').includes('<b>'), 'the text is escaped');
  assert.match(lines[2]!, /^<span class="hljs-comment"> y \*\/<\/span>$/);
  assert.deepEqual(highlight('<i>', 'nope'), ['&lt;i&gt;'], 'an unknown language comes back escaped, uncoloured');
});

test('a diff is coloured per side of each hunk, and a diff past the cap or of an unknown type stays plain', () => {
  const file = parseDiff(['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,2 @@', ' /* start', '-old */', '+new */'].join('\n'))[0]!;
  const coloured = colourDiff(file, highlight)!;
  const [ctx, del, add] = file.hunks[0]!.lines;
  assert.match(coloured.get(ctx!)!, /hljs-comment/);
  assert.match(coloured.get(add!)!, /hljs-comment/, 'the new side continues the comment from the line above');
  assert.equal(coloured.get(del!), 'old */', 'the old side is coloured on its own');
  assert.equal(colourDiff({ ...file, path: 'a.txt' }, highlight), null);
  assert.equal(colourDiff(file, null), null, 'nothing until the colourer has loaded');
  const big = { ...file, hunks: [{ header: '', lines: Array.from({ length: HIGHLIGHT_MAX_LINES + 1 }, (_, i) => ({ kind: 'add' as const, old: null, new: i + 1, text: 'x' })) }] };
  assert.equal(colourDiff(big, highlight), null);
});

test('drafts are kept per session in this browser, one per line, and sending (an empty list) leaves nothing behind', () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  let list = putLineDraft([], { ...comment(), id: 'a' });
  list = putLineDraft(list, { ...comment({ line: 9 }), id: 'b' });
  list = putLineDraft(list, { ...comment({ body: 'Rewritten.' }), id: 'c' });
  assert.deepEqual(list.map((d) => [d.id, d.line, d.body]), [['c', 4, 'Rewritten.'], ['b', 9, 'Should the ceiling come from the config?']], 'the same line is rewritten in place');
  assert.deepEqual(putLineDraft(list, { ...comment({ body: ' ' }), id: 'c' }).map((d) => d.id), ['b'], 'an emptied comment goes');
  writeLineDrafts(store, 's1', list);
  assert.deepEqual(readLineDrafts(store, 's1'), list);
  assert.deepEqual(readLineDrafts(store, 's2'), []);
  writeLineDrafts(store, 's1', []);
  assert.equal(mem.size, 0);
});
