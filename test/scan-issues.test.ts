import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchIssues, report, scanIssue, type Gh, type Issue } from '../scripts/scan-issues.ts';
import type { Terms } from '../scripts/scan-rules.ts';

const NONE: Terms = { terms: [], allow: [] };
const issue = (over: Partial<Issue> = {}): Issue => ({ number: 7, title: 'A title', body: 'A body', author: 'alice', comments: [], ...over });
const where = (i: Issue, terms = NONE) => scanIssue(i, terms).hits.map((h) => [h.field, h.line, h.kind, h.text, h.allowed]);

test('the issue scan finds terms and built-in patterns, and names the field and line of each', () => {
  // Built at run time, so this file holds no token-shaped string itself.
  const gh = 'ghp' + '_' + 'B'.repeat(36);
  const terms: Terms = { terms: ['secretproject'], allow: [] };
  const i = issue({
    title: 'About SecretProject',
    body: 'line one\nmail jane.doe@company.se',
    comments: [{ author: 'bob', body: 'nothing' }, { author: 'carol', body: `see /Users/jane/x\ntoken ${gh}` }],
  });
  assert.deepEqual(where(i, terms), [
    ['title', 1, 'term', 'SecretProject', undefined],
    ['body', 2, 'e-mail', 'jane.doe@company.se', undefined],
    ['comment 2', 1, 'home folder', '/Users/jane', undefined],
    ['comment 2', 2, 'github token', gh, undefined],
  ]);
});

test('the issue scan scans who wrote the issue and each comment', () => {
  const terms: Terms = { terms: ['^jdoe$'], allow: [] };
  const i = issue({ author: 'jdoe', comments: [{ author: 'bob', body: 'x' }, { author: 'jdoe', body: 'y' }] });
  assert.deepEqual(where(i, terms).map((h) => h[0]), ['author', 'comment 2 author']);
});

test('the issue scan leaves placeholders alone, as the export does', () => {
  assert.deepEqual(where(issue({ body: 'a@example.com at 127.0.0.1 in /home/${name}' })).map((h) => h[4]), ['placeholder', 'placeholder']);
});

test('an allow entry explains an issue hit by issues/<n>/<field>, and an entry for a repository folder does not', () => {
  const body = 'see SecretProject';
  const terms = (file: string): Terms => ({ terms: ['secretproject'], allow: [{ file, match: '^SecretProject$', why: 'quoted on purpose' }] });
  const i = issue({ body, comments: [{ author: 'bob', body }] });
  // Every issue, one issue, one field.
  assert.deepEqual(where(i, terms('issues/')).map((h) => h[4]), ['quoted on purpose', 'quoted on purpose']);
  assert.deepEqual(where(i, terms('issues/7/')).map((h) => h[4]), ['quoted on purpose', 'quoted on purpose']);
  assert.deepEqual(where(i, terms('issues/7/comment-1')).map((h) => [h[0], h[4]]), [['body', undefined], ['comment 1', 'quoted on purpose']]);
  // Another issue's entry, and an entry written for the export's files, explain nothing here.
  assert.deepEqual(where(i, terms('issues/8/')).map((h) => h[4]), [undefined, undefined]);
  assert.deepEqual(where(i, terms('docs/')).map((h) => h[4]), [undefined, undefined]);
});

test('an issue allow entry with a kind explains only hits of that kind', () => {
  const terms: Terms = { terms: ['secretproject'], allow: [{ file: 'issues/7/body', match: '.', why: 'any address here', kind: 'e-mail' }] };
  assert.deepEqual(where(issue({ body: 'SecretProject jane.doe@company.se' }), terms).map((h) => [h[2], h[4]]),
    [['e-mail', 'any address here'], ['term', undefined]]);
});

test('the issue report says clean or lists each hit with its field and an excerpt, then the summary line', () => {
  const terms: Terms = { terms: ['secretproject'], allow: [{ file: 'issues/3/', match: '.', why: 'fine here' }] };
  const long = 'x'.repeat(60);
  const results = [
    issue({ number: 1, title: 'Clean one' }),
    issue({ number: 2, title: 'Dirty one', comments: [{ author: 'bob', body: `${long} SecretProject ${long}` }] }),
    issue({ number: 3, title: 'Explained SecretProject' }),
  ].map((i) => scanIssue(i, terms));
  const { text, summary, open } = report('o/r', results);
  assert.equal(summary, '3 issues: 2 clean, 1 with hits');
  assert.equal(open, 1);
  assert.ok(text.endsWith('3 issues: 2 clean, 1 with hits\n'));
  assert.match(text, /^## #1 Clean one: clean$/m);
  assert.match(text, /^## #2 Dirty one: 1 hit\(s\)$/m);
  // Forty characters each side of the match, cut with an ellipsis.
  assert.match(text, new RegExp(`^- comment 1, line 1: term \`SecretProject\`: …x{39} SecretProject x{39}…$`, 'm'));
  assert.match(text, /^## #3 Explained SecretProject: clean, 1 allowed$/m);
});

test('the issue fetch pages through issues and long comment threads with read-only queries', () => {
  const calls: string[][] = [];
  const page = (hasNextPage: boolean, endCursor: string | null, nodes: unknown[]) => ({ pageInfo: { hasNextPage, endCursor }, nodes });
  const gh: Gh = (args) => {
    calls.push(args);
    const query = args[args.indexOf('-f') + 1]!;
    const after = args.find((a) => a.startsWith('after='))?.slice(6);
    if (query.includes('issue(number')) {
      return JSON.stringify({ data: { repository: { issue: { comments: page(false, null, [{ body: 'c3', author: null }]) } } } });
    }
    const issues = after === 'p1'
      ? page(false, null, [{ number: 2, title: 't2', body: 'b2', author: { login: 'bob' }, comments: page(false, null, []) }])
      : page(true, 'p1', [{ number: 1, title: 't1', body: 'b1', author: { login: 'alice' },
        comments: page(true, 'c2', [{ body: 'c1', author: { login: 'bob' } }, { body: 'c2', author: { login: 'carol' } }]) }]);
    return JSON.stringify({ data: { repository: { issues } } });
  };
  const issues = fetchIssues('o/r', 'open', gh);
  assert.deepEqual(issues, [
    { number: 1, title: 't1', body: 'b1', author: 'alice', comments: [{ author: 'bob', body: 'c1' }, { author: 'carol', body: 'c2' }, { author: 'ghost', body: 'c3' }] },
    { number: 2, title: 't2', body: 'b2', author: 'bob', comments: [] },
  ]);
  assert.equal(calls.length, 3);
  for (const args of calls) {
    assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
    const query = args[3]!.replace(/^query=/, '');
    assert.ok(query.startsWith('query(') && !/mutation/i.test(query), 'only reads');
    assert.ok(args.includes('owner=o') && args.includes('name=r'));
  }
  assert.ok(calls[0]!.join(' ').includes('states: [OPEN]'));
  assert.ok(calls[1]!.includes('number=1') && calls[1]!.includes('after=c2'));
  calls.length = 0;
  fetchIssues('o/r', 'all', gh);
  assert.ok(!calls[0]!.join(' ').includes('states:'), 'all states: no filter');
});
