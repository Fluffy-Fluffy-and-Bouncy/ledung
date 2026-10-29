// What runs is checked, not what is written (decided 2026-10-13): the real false alarms of that day stay
// quiet, every way of actually running a sensitive command still asks, and a merge the user already said
// yes to goes through once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSensitive, mergeAnswered, runnableLines, type SensitiveRules } from '../src/sessions/sensitive.ts';
import { SUGGESTIONS } from '../src/shared/sensitive-suggestions.ts';

const RULES: SensitiveRules = {
  commandPatterns: [
    ...SUGGESTIONS.filter((s) => s.kind === 'command').map((s) => s.pattern),
    String.raw`\bgh\s+pr\s+merge\b`,
    // As in another project's list: running ship.py, not naming it. `py` must be a word: `update.py tools/ship.py` names it.
    String.raw`(^|[;&|(]\s*|(^|[\s;&|(])(python[\d.]*|py)(\.exe)?\s+(-\S+\s+)*)(\.{0,2}[\\/])?tools[\\/]+ship\.py\b`,
  ],
  pathPatterns: [],
  mcpTools: [],
};
const asks = (command: string) => !!matchSensitive('Bash', { command }, RULES);

test("2026-10-13's false alarms: text that only mentions a sensitive command doesn't ask", () => {
  const quiet = [
    "cat > /tmp/review.md <<'EOF'\n`tools/ship.py` step 7 pushes the branch and the tag in one `git push -q origin main v{ver}`.\nEOF",
    'cat > "$TEMP/finding.md" <<\'EOF\'\n- `git push --force origin main` would lose it\nEOF\ngh issue create --body-file "$TEMP/finding.md"',
    "mkdir -p .githooks && cat > .githooks/pre-push <<'EOF'\n#!/bin/sh\n# `git push --no-verify` skips it\nnpm run check\nEOF",
    'echo "08:30 Martin: \\"merge #45\\". gh pr merge refused: conflicts"',
    "gh pr comment 52 -R o/r --body 'Decision — Martin 17:13: \"Merge #52\". gh pr merge next.'",
    "git ls-tree -r --name-only origin/main | grep -E '^(tools/ship.py|src/x.cpp)'",
    'sed -n 1,75p tools/ship.py; cat .runner.lock',
    'git grep -n "verify_sigs" -- tests/test_port_update.py tools/promote.py tools/ship.py | cut -c1-220',
    'git status # then git push origin main',
    // A script that starts no program can't run the commands its strings name (22:47 the same day).
    "node - <<'EOF'\nassert.equal(await t.settle(t.ask('gh pr merge 31', 'tu1')), 'waiting');\nEOF",
    "python - <<'EOF'\np='.ledung/lead-notes.md'\ns=open(p,encoding='utf-8').read()\ns=s.replace(\"## Q#48 answered\",\"\"\"## In flight (22:46)\n- NB Ledung #55: after Martin's ask_user answer naming #N, `gh pr merge N` passes without a second prompt.\n\n## Q#48 answered\"\"\")\nopen(p,'w',encoding='utf-8').write(s)\nEOF\necho ok",
    "python -c 'print(\"git push origin main\")'",
  ];
  for (const c of quiet) assert.equal(asks(c), false, c);
});

test('every way of running a sensitive command still asks', () => {
  const loud = [
    'git push origin main',
    'git push --force origin am/x',
    'cd repo && git push -q origin main v1.0.120',
    'gh pr merge 45 -R o/r --merge',
    'python tools/ship.py 1.0.120 1.0.119 keep --msg m --notes n',
    "bash -c 'git push origin main'",
    'bash <<EOF\ngit push origin main\nEOF',
    "ssh host 'git push origin main'",
    'eval "git push origin main"',
    'echo "$(git push origin main)"',
    'echo `git push origin main`',
    "python3 -c 'import os; os.system(\"git push origin main\")'",
    'git push \\\n  origin main',
    'npm publish',
    // A script that starts a program is matched whole: it could push through execSync or subprocess.
    "node - <<'EOF'\nconst { execSync } = require('child_process');\nexecSync('git push origin main');\nEOF",
    "python - <<'EOF'\nimport subprocess\nsubprocess.run('git push origin main', shell=True)\nEOF",
    "python3 -c 'import os; os.system(\"gh pr merge 52\")'",
    "node -e \"require('child_process').execSync('npm publish')\"",
    'cat <<EOF\nunclosed heredoc mentions git push origin main',
    "echo 'unclosed quote; git push origin main",
  ];
  for (const c of loud) assert.equal(asks(c), true, c);
});

test('runnable lines blank quoted and heredoc text but keep the commands around them', () => {
  const lines = runnableLines("cat > f <<'EOF'\ngit push origin main\nEOF\ngit status");
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /^cat > f <<'EOF'$/);
  assert.equal(lines[1]!.trim(), '');
  assert.equal(lines[3], 'git status');
});

test("a merge the user said yes to goes through once; anything else is asked as before", () => {
  const yes = { id: 71, question: '**Merge PR #52 (issue #51)?** Both reviews approved.', answer: 'Merge #52 (recommended)', answeredBy: 'user' };
  const other = { id: 70, question: 'Merge PR #50?', answer: 'Merge', answeredBy: 'user' };
  const held = { id: 72, question: 'Merge PR #53?', answer: 'Hold until the review is in', answeredBy: 'user' };
  const managers = { id: 73, question: 'Merge PR #54?', answer: 'Merge', answeredBy: 'manager-x' };
  const qs = [yes, other, held, managers];
  assert.deepEqual(mergeAnswered('gh pr merge 52 -R o/r --merge', RULES, qs), { pr: 52, questionId: 71 });
  // A comment before the merge, as the leads write it, is fine.
  assert.deepEqual(mergeAnswered("gh pr comment 52 -R o/r --body 'Decision — Martin: \"Merge #52\"' && gh pr merge 52 -R o/r --merge", RULES, qs), { pr: 52, questionId: 71 });
  assert.equal(mergeAnswered('gh pr merge 53 --merge', RULES, qs), null, 'held');
  assert.equal(mergeAnswered('gh pr merge 54 --merge', RULES, qs), null, 'answered by a manager, not the user');
  assert.equal(mergeAnswered('gh pr merge 99 --merge', RULES, qs), null, 'no question about #99');
  assert.equal(mergeAnswered('gh pr merge 52 --merge && gh pr merge 50 --merge', RULES, qs), null, 'two merges in one command');
  assert.equal(mergeAnswered('gh pr merge 52 --merge && git push origin main', RULES, qs), null, 'something else sensitive');
  assert.equal(mergeAnswered('gh pr merge 52 --merge || gh api -X PUT repos/o/r/pulls/52/merge', RULES, qs), null, 'a fallback merge');
  assert.equal(mergeAnswered('gh pr merge 52 --admin', RULES, qs), null, 'an option that overrides protections');
  assert.equal(mergeAnswered('for p in 52 50; do gh pr merge $p; done', RULES, qs), null, 'a loop');
});

test('what the user typed to the manager counts, only where "merge" and the PR stand together', () => {
  const typed = (id: number, text: string) => ({ id, question: text, answer: text, answeredBy: 'user', typed: true });
  assert.deepEqual(mergeAnswered('gh pr merge 45 --merge', RULES, [typed(-1, 'merge #45')]), { pr: 45, questionId: -1 });
  assert.deepEqual(mergeAnswered('gh pr merge 53 --merge', RULES, [typed(-1, 'Looks good. #53: merge it, then start #54.')]), { pr: 53, questionId: -1 });
  assert.equal(mergeAnswered('gh pr merge 47 --merge', RULES, [typed(-1, 'CI is slimmed in #47: one Windows run per PR.\nMerged at 08:40 on my word.')]), null, 'mentioned apart');
  assert.equal(mergeAnswered('gh pr merge 45 --merge', RULES, [typed(-1, "don't merge #45 yet")]), null, 'held back');
  assert.equal(mergeAnswered('gh pr merge 45 --merge', RULES, [typed(-1, 'Q54, merge')]), null, 'names no PR');
});
