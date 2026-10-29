// The Files pane's Changes tab (issue #225, a test feature): what a session changed, as the diff of its folder's
// HEAD against where it left main, parsed into files, hunks and numbered lines so the page can anchor a line
// comment. Read-only, through gitRead's hardening, and only in the session's own folder (--relative).
import type { DiffFile, DiffHunk, SessionChanges } from '../shared/files-pane.ts';
import { gitRead } from './git-read.ts';

export type { DiffFile, SessionChanges };

/** Where to look for the main branch, in order: the remote's default, then the usual names. */
const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master'];

const line1 = (s: string) => s.split('\n')[0]!.trim();

/**
 * The session's changes in `folder`: `git diff <merge-base with main> HEAD`. `hidden` drops files the viewer
 * would not show (a chat's dot-names).
 */
export async function sessionChanges(folder: string, opts: { hidden?: (path: string) => boolean; maxBytes?: number } = {}): Promise<SessionChanges> {
  const empty = (problem: string, rest: Partial<SessionChanges> = {}): SessionChanges => ({
    base: null, baseCommit: null, head: null, branch: null, files: [], truncated: false, problem, ...rest,
  });
  const head = await gitRead(folder, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head.code !== 0) return empty('This folder is not a git repository with a commit, so there are no changes to show.');
  const branch = line1((await gitRead(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout) || null;
  const known = line1((await gitRead(folder, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).stdout);
  let base: string | null = null;
  let baseCommit: string | null = null;
  for (const candidate of [...(known ? [known] : []), ...BASE_CANDIDATES]) {
    // The name comes from the repository; it is an argument of its own, never through a shell.
    const mb = await gitRead(folder, ['merge-base', '--end-of-options', candidate, 'HEAD']);
    if (mb.code === 0 && line1(mb.stdout)) {
      base = candidate;
      baseCommit = line1(mb.stdout);
      break;
    }
  }
  const at = { head: line1(head.stdout), branch };
  if (!baseCommit) return empty('There is no main branch here to compare with.', at);
  const diff = await gitRead(folder, [
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--relative', '-M', '-U3', baseCommit, at.head, '--',
  ], { maxBytes: opts.maxBytes });
  if (diff.code !== 0 && !diff.truncated) return empty(`git diff failed: ${line1(diff.stderr) || `exit ${diff.code}`}`, { ...at, base, baseCommit });
  let files = parseDiff(diff.stdout);
  if (opts.hidden) files = files.filter((f) => !opts.hidden!(f.path) && !(f.oldPath && opts.hidden!(f.oldPath)));
  return { base, baseCommit, ...at, files, truncated: diff.truncated, problem: null };
}

/** A path from a ---/+++ or rename line: without its a/ or b/ and any quotes git put round it. */
function pathOf(s: string, prefix: string): string {
  let p = s.trim();
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\\t/g, '\t');
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** A unified diff from git into files, hunks and numbered lines. A cut-off last hunk keeps what arrived. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.split('\n')) {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (l.startsWith('diff --git ')) {
      // The paths from this line are a fallback; ---/+++ and rename lines say them without doubt.
      const m = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/.exec(l);
      file = { path: m?.[2] ?? '', oldPath: null, status: 'modified', binary: false, added: 0, removed: 0, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (hunk) {
      const c = l[0];
      if (c === '+' || c === '-' || c === ' ') {
        const text = l.slice(1);
        if (c === '+') { hunk.lines.push({ kind: 'add', old: null, new: newNo++, text }); file.added++; }
        else if (c === '-') { hunk.lines.push({ kind: 'del', old: oldNo++, new: null, text }); file.removed++; }
        else hunk.lines.push({ kind: 'ctx', old: oldNo++, new: newNo++, text });
        continue;
      }
      if (c === '\\') continue; // "\ No newline at end of file"
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { header: l, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    hunk = null;
    if (l.startsWith('new file mode')) file.status = 'added';
    else if (l.startsWith('deleted file mode')) file.status = 'deleted';
    else if (l.startsWith('rename from ')) { file.oldPath = pathOf(l.slice('rename from '.length), ''); file.status = 'renamed'; }
    else if (l.startsWith('rename to ')) file.path = pathOf(l.slice('rename to '.length), '');
    else if (l.startsWith('Binary files ')) file.binary = true;
    else if (l.startsWith('+++ ') && !l.startsWith('+++ /dev/null')) file.path = pathOf(l.slice(4), 'b/');
    else if (l.startsWith('--- ') && file.status === 'deleted' && !l.startsWith('--- /dev/null')) file.path = pathOf(l.slice(4), 'a/');
  }
  return files;
}
