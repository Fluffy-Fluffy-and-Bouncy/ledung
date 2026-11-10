// Issue #208: merging a pull request is on the suggested sensitive list (Martin, 2026-11-10), so a new project holds
// `gh pr merge` for the person from the start and an existing one gets the entry once. The commands and the texts
// that must stay quiet are the issue's own ("Done looks like"); nothing here comes from running the new code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSensitive, mergeAnswered, sensitiveHookOutput } from '../src/sessions/sensitive.ts';
import { LATER_SUGGESTIONS, SUGGESTIONS, missingSuggestions, withSuggestions } from '../src/shared/sensitive-suggestions.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { ProjectStore } from '../src/projects/store.ts';

const NAME = 'Merging a pull request';
// A new project's list: the suggestions, as ordinary entries.
const rules = withSuggestions({ commandPatterns: [] as string[], pathPatterns: [] as string[], mcpTools: [] as string[] });
const bash = (command: string) => matchSensitive('Bash', { command }, rules)?.rule ?? null;
const ps = (command: string) => matchSensitive('PowerShell', { command }, rules)?.rule ?? null;
/** The entry as a project's list holds it: found by its plain-words name. */
const entry = () => SUGGESTIONS.find((s) => s.name === NAME);

test("#208: a new project's command list holds merging a pull request, named in plain words", () => {
  assert.equal(entry()?.kind, 'command');
  assert.ok(rules.commandPatterns.includes(entry()!.pattern), "in a new project's list");
  const merges = [
    'gh pr merge 12 -R owner/name',
    'gh pr merge https://github.com/owner/name/pull/12 --squash',
    'gh.exe pr merge 12 -R owner/name',
    'gh.exe pr merge https://github.com/owner/name/pull/12 --squash',
    // As sessions really send it: after a cd, by a path, with pr's own -R before the word.
    'cd repo && gh pr merge 12 --merge --delete-branch',
    '/usr/bin/gh pr merge 12',
    'gh pr -R owner/name merge 12',
    'gh pr --repo=owner/name merge 12',
  ];
  for (const c of merges) {
    assert.equal(bash(c), NAME, `Bash: ${c}`);
    assert.equal(ps(c), NAME, `PowerShell: ${c}`);
  }
  const out = sensitiveHookOutput('Bash', { command: merges[0] }, rules) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'ask', 'asked in every mode');
  assert.equal(out.hookSpecificOutput?.permissionDecisionReason, `Sensitive: ${NAME}`);
});

test('#208: a command that only mentions a merge is not held', () => {
  // Premise, with the same probes: a real merge is found, so "null" below is not an unreached check.
  assert.equal(bash('gh pr merge 12 -R owner/name'), NAME);
  assert.equal(ps('gh pr merge 12 -R owner/name'), NAME);
  const quiet = [
    'gh pr view 12',
    'gh pr list --search "merge"',
    'gh pr checks 12',
    'gh pr view 12 --json mergeable,mergeStateStatus',
    'gh pr list --search merge',
    'gh pr merged-list',
    'git merge origin/main',
    'ngh pr merge 12',
  ];
  for (const c of quiet) {
    assert.equal(bash(c), null, `Bash: ${c}`);
    assert.equal(ps(c), null, `PowerShell: ${c}`);
  }
  // Text that names the command without running it, as a note or a PR comment does (decided 2026-10-13).
  assert.equal(bash('echo "then gh pr merge 12 -R owner/name"'), null);
  assert.equal(bash("gh pr comment 12 --body 'gh pr merge 12 next'"), null);
  assert.equal(bash("cat > note.md <<'EOF'\ngh pr merge 12 -R owner/name\nEOF"), null);
  // Run by a shell, the same text is a merge.
  assert.equal(bash('bash -c "gh pr merge 12 -R owner/name"'), NAME);
});

test('#208: an existing project gets the merge entry once, through a batch of its own; deleted, it stays deleted', () => {
  const pattern = entry()!.pattern;
  const batch = LATER_SUGGESTIONS.find((b) => b.commandPatterns.includes(pattern));
  assert.ok(batch, 'a later batch carries it');
  assert.deepEqual(batch.commandPatterns, [pattern], 'and nothing else');
  assert.equal(LATER_SUGGESTIONS.filter((b) => b.key === batch.key).length, 1, 'under a key of its own');
  assert.notEqual(batch.key, 'sensitive-suggestions-added');

  const db = new Store(openDatabase(':memory:')).database;
  const projects = new ProjectStore(db);
  // A database from before #208: the first copy and every other batch ran, and the list has the older suggestions.
  for (const key of ['sensitive-suggestions-added', ...LATER_SUGGESTIONS.filter((b) => b !== batch).map((b) => b.key)]) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, 'before');
  }
  const older = rules.commandPatterns.filter((p) => p !== pattern);
  const add = (name: string) => projects.add({ name, runner: 'local', path: `C:/p/${name}`, sensitive: { commandPatterns: ['mine', ...older], pathPatterns: [...rules.pathPatterns], mcpTools: [] } });
  add('old');
  const list = () => projects.get('old')!.config.sensitive.commandPatterns;
  assert.equal(matchSensitive('Bash', { command: 'gh pr merge 12 -R owner/name' }, projects.get('old')!.config.sensitive), null, 'premise: not held before');
  assert.equal(projects.addSuggestionsOnce(), 1);
  assert.deepEqual(list(), ['mine', ...older, pattern], 'added at the end, the rest as it was');
  assert.equal(matchSensitive('Bash', { command: 'gh pr merge 12 -R owner/name' }, projects.get('old')!.config.sensitive)?.rule, NAME);
  assert.ok(db.prepare('SELECT 1 FROM meta WHERE key = ?').get(batch.key), 'recorded under its key');
  // The person deletes it; a later start leaves it deleted, and a project that had it is not given it twice.
  const config = projects.get('old')!.config;
  projects.update('old', { ...config, sensitive: { ...config.sensitive, commandPatterns: ['mine', ...older] } });
  assert.equal(projects.addSuggestionsOnce(), 0);
  assert.deepEqual(list(), ['mine', ...older]);
  // "Add suggested" in the project's settings offers it again, by its name.
  assert.deepEqual(missingSuggestions(list(), rules.pathPatterns).map((s) => s.name), [NAME]);
});

test("#208: with only the suggested entry holding merges, a merge the person's answer named still goes through", () => {
  const yes = { id: 71, question: '**Merge PR #52 (issue #51)?** Both reviews approved.', answer: 'Merge #52 (recommended)', answeredBy: 'user' };
  const held = { id: 72, question: 'Merge PR #53?', answer: 'Hold until the review is in', answeredBy: 'user' };
  // Premise: the merges are sensitive in these rules, so the answer is what lets one through.
  assert.equal(bash('gh pr merge 52 -R o/r --merge'), NAME);
  assert.deepEqual(mergeAnswered('gh pr merge 52 -R o/r --merge', rules, [yes, held]), { pr: 52, questionId: 71 });
  assert.deepEqual(mergeAnswered('gh pr merge 52 --squash --delete-branch', rules, [yes, held]), { pr: 52, questionId: 71 });
  assert.equal(mergeAnswered('gh pr merge 53 -R o/r --merge', rules, [yes, held]), null, 'the answer held it back');
  // A second merge beside the named one is asked, also in a form only the suggested entry recognises.
  assert.equal(mergeAnswered('gh pr merge 52 --merge && gh.exe pr merge 53 --merge', rules, [yes, held]), null);
  assert.equal(mergeAnswered('gh pr merge 52 --merge && gh pr -R o/r merge 53', rules, [yes, held]), null);
});
