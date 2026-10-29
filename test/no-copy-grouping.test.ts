// Grouping by copying the group's list for every item (`map.set(k, [...(map.get(k) ?? []), x])`) is quadratic in
// the group's size: it made the usage page take seconds and hold up Ledung (#356). New code adds in place instead.
// The check matches the spread with or without parentheses (`[...m.get(k) ?? [], x]`, `[...m.get(k)!, x]`); a
// `.concat` or a spread split over lines is not matched, and nothing in the source uses those (review of #359).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const COPY = /\.set\([^;]*\[\.\.\.\(?\s*[\w.]+\.get\(/;
/**
 * Sites from before #356 whose groups stay small, with how many each file has. #357 fixes them and lowers these to
 * nothing; a count, not the file alone, so a new site in one of these files is caught too.
 */
const KNOWN: Record<string, number> = {
  'src/board/boards.ts': 1,
  'src/board/store.ts': 1,
  'src/platform/process-tree.ts': 1,
  'src/platform/processes.ts': 1,
  'src/platform/containers.ts': 1,
  'src/resources/monitor.ts': 1,
  'src/sessions/management.ts': 1,
  'src/sessions/pr-poll.ts': 1,
};

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? (e.name === 'node_modules' || e.name === 'dist' ? [] : files(p)) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

test('the check finds every shape of copying a group per item (#356)', () => {
  for (const line of [
    'm.set(k, [...(m.get(k) ?? []), x]);',
    'group.branches.set(t.remoteBranch, [...group.branches.get(t.remoteBranch) ?? [], id]);',
    'm.set(k, [...m.get(k)!, x]);',
    'this.approvedChanges.set(key, [...( this.approvedChanges.get(key) ?? []), shown]);',
  ]) assert.ok(COPY.test(line), line);
  for (const line of ['m.set(k, [x]);', 'const list = m.get(k); if (list) list.push(x); else m.set(k, [x]);', 'm.set(k, [...xs]);']) {
    assert.ok(!COPY.test(line), line);
  }
});

test('no grouping copies the whole group for every item (#356)', () => {
  const found: Record<string, string[]> = {};
  for (const dir of ['src', 'web/src', 'scripts']) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of files(full)) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (COPY.test(line)) (found[rel] ??= []).push(`${rel}:${i + 1}`);
      });
    }
  }
  const counts = Object.fromEntries(Object.entries(found).map(([f, sites]) => [f, sites.length]));
  assert.deepEqual(counts, KNOWN, `add to the group in place (push) instead of copying it; sites found: ${Object.values(found).flat().join(', ')}`);
});
