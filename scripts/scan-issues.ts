// Scans a repository's issues with the public export's rules before any of them is copied to the
// public repository (#340):
//
//   npm run scan-issues -- --repo <owner/name> --terms <file.json> [--state open|all] [--out <file>]
//
// Reads each issue's title, body and author and every comment with its author through GitHub's
// GraphQL API (gh), fifty issues a page, and scans each of them with scripts/scan-rules.ts, the same
// rules and terms file as `npm run export-public`. It only reads: it never edits, comments on,
// creates or closes an issue. The report goes to --out, or to the screen; it quotes the issues' text,
// so it is for this computer only. A hit no allow entry explains makes the run exit 1.
//
// Allow entries name files; an issue's text is matched as the file `issues/<number>/<field>`, where
// the field is `title`, `body`, `author`, `comment-<n>` or `comment-<n>-author` (comments counted
// from 1). So `"file": "issues/"` explains a match in every issue, `"issues/12/"` in all of issue 12,
// and `"issues/12/comment-3"` in that one comment. No repository folder is called issues/, so an
// entry written for the export's files never explains an issue's text, nor the other way round.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadTerms, scanText, type Hit, type Terms } from './scan-rules.ts';

export interface Comment { author: string; body: string }
export interface Issue { number: number; title: string; body: string; author: string; comments: Comment[] }
export interface IssueHit extends Hit { field: string; excerpt: string }
export interface IssueResult { number: number; title: string; hits: IssueHit[] }

/** Runs gh with these arguments and returns what it printed. Tests pass a fake one. */
export type Gh = (args: string[]) => string;

const realGh: Gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 2 ** 30 });

const COMMENT_FIELDS = 'pageInfo { hasNextPage endCursor } nodes { body author { login } }';

// Fifty issues with their first fifty comments cost about 26 GraphQL points a page; an issue with
// more comments than that gets its own query for the rest, at one point a page.
function issuesQuery(state: 'open' | 'all'): string {
  const states = state === 'open' ? ', states: [OPEN]' : '';
  return `query($owner: String!, $name: String!, $after: String) { repository(owner: $owner, name: $name) {
  issues(first: 50, after: $after${states}, orderBy: { field: CREATED_AT, direction: ASC }) {
    pageInfo { hasNextPage endCursor }
    nodes { number title body author { login } comments(first: 50) { ${COMMENT_FIELDS} } } } } }`;
}

const COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) {
  issue(number: $number) { comments(first: 100, after: $after) { ${COMMENT_FIELDS} } } } }`;

interface Page<T> { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] }
interface RawComment { body: string; author: { login: string } | null }
interface RawIssue { number: number; title: string; body: string; author: { login: string } | null; comments: Page<RawComment> }

// A deleted account comes back as null; GitHub shows it as "ghost".
const login = (a: { login: string } | null) => a?.login ?? 'ghost';
const comment = (c: RawComment): Comment => ({ author: login(c.author), body: c.body });

function graphql(gh: Gh, query: string, vars: Record<string, string | number | undefined>): any {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) continue;
    args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  }
  return JSON.parse(gh(args)).data;
}

/** Every issue of the repository in this state, with all its comments, oldest first. */
export function fetchIssues(repo: string, state: 'open' | 'all', gh: Gh = realGh): Issue[] {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`--repo must be owner/name, not "${repo}".`);
  const issues: Issue[] = [];
  let after: string | undefined;
  for (;;) {
    const page: Page<RawIssue> = graphql(gh, issuesQuery(state), { owner, name, after }).repository.issues;
    for (const raw of page.nodes) {
      const comments = raw.comments.nodes.map(comment);
      let more = raw.comments.pageInfo;
      while (more.hasNextPage) {
        const rest: Page<RawComment> = graphql(gh, COMMENTS_QUERY, { owner, name, number: raw.number, after: more.endCursor ?? undefined }).repository.issue.comments;
        comments.push(...rest.nodes.map(comment));
        more = rest.pageInfo;
      }
      issues.push({ number: raw.number, title: raw.title, body: raw.body, author: login(raw.author), comments });
    }
    if (!page.pageInfo.hasNextPage) return issues;
    after = page.pageInfo.endCursor ?? undefined;
  }
}

/** A short piece of the line around a hit, so the report shows what it is about. */
function excerpt(text: string, hit: Hit, around = 40): string {
  const line = text.split('\n')[hit.line - 1] ?? '';
  const at = hit.column ?? line.indexOf(hit.text);
  const from = Math.max(0, at - around);
  const to = Math.min(line.length, at + hit.text.length + around);
  return `${from > 0 ? '…' : ''}${line.slice(from, to).trim()}${to < line.length ? '…' : ''}`;
}

/** Every hit in one issue, each with the field it is in: title, body, author, comment N or comment N author. */
export function scanIssue(issue: Issue, terms: Terms): IssueResult {
  const fields: [string, string, string][] = [
    ['title', 'title', issue.title],
    ['body', 'body', issue.body],
    ['author', 'author', issue.author],
    ...issue.comments.flatMap((c, i): [string, string, string][] => [
      [`comment ${i + 1}`, `comment-${i + 1}`, c.body],
      [`comment ${i + 1} author`, `comment-${i + 1}-author`, c.author],
    ]),
  ];
  const hits = fields.flatMap(([field, key, text]) =>
    scanText(`issues/${issue.number}/${key}`, text, terms).map((h): IssueHit => ({ ...h, field, excerpt: excerpt(text, h) })));
  return { number: issue.number, title: issue.title, hits };
}

/** The report: per issue clean or each hit, then the summary line. */
export function report(repo: string, results: IssueResult[]): { text: string; summary: string; open: number } {
  const lines = [`# Issue scan of ${repo}`, ''];
  let open = 0;
  let withHits = 0;
  for (const r of results) {
    const unexplained = r.hits.filter((h) => !h.allowed);
    const allowed = r.hits.filter((h) => h.allowed);
    open += unexplained.length;
    if (unexplained.length) withHits++;
    lines.push(`## #${r.number} ${r.title}: ${unexplained.length ? `${unexplained.length} hit(s)` : 'clean'}${allowed.length ? `, ${allowed.length} allowed` : ''}`);
    for (const h of unexplained) lines.push(`- ${h.field}, line ${h.line}: ${h.kind} \`${h.text}\`: ${h.excerpt}`);
    for (const h of allowed) lines.push(`- allowed: ${h.field}, line ${h.line}: ${h.kind} \`${h.text}\` (${h.allowed})`);
    lines.push('');
  }
  const summary = `${results.length} issues: ${results.length - withHits} clean, ${withHits} with hits`;
  lines.push(summary);
  return { text: lines.join('\n') + '\n', summary, open };
}

function main(): void {
  const { values } = parseArgs({
    options: { repo: { type: 'string' }, terms: { type: 'string' }, state: { type: 'string', default: 'open' }, out: { type: 'string' } },
  });
  if (!values.repo) throw new Error('--repo owner/name is required.');
  if (values.state !== 'open' && values.state !== 'all') throw new Error('--state is open or all.');
  if (!values.terms) console.error('No --terms file: only the built-in patterns are scanned.');
  const terms = loadTerms(values.terms);
  const results = fetchIssues(values.repo, values.state).map((i) => scanIssue(i, terms));
  const { text, summary, open } = report(values.repo, results);
  if (values.out) {
    fs.writeFileSync(values.out, text);
    console.log(`Wrote ${values.out}. ${summary}`);
  } else {
    process.stdout.write(text);
  }
  process.exitCode = open ? 1 : 0;
}

if (import.meta.main) main();
