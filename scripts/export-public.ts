// Dry run of a public export from one squashed commit (#340):
//
//   npm run export-public -- --author "Name <email>" [--ref main] [--out <empty folder>] [--terms <file.json>]
//
// Copies the files a commit tracks (git archive) into a new folder, leaves out local folders and
// configs, makes one commit there with the given author in a new repository, and scans the result,
// commit metadata included. It creates no remote repository and pushes nothing: the export folder
// stays on this computer for a look, and publishing it is a separate decision.
//
// The scan's rules are in scripts/scan-rules.ts, shared with the issue scan (scripts/scan-issues.ts).
// They have generic patterns built in (tokens, private keys, e-mail addresses, home folders,
// public IP addresses, local files). Words that must not appear (people, other projects) are not
// written here, since this file is exported too: they come from --terms, a local JSON file
// { "terms": ["regex", ...], "allow": [{ "file": "path or prefix/", "match": "regex", "why": "...", "kind": "optional" }] }.
// A hit no allow entry explains makes the run exit 1.
//
// Images and other binary files cannot be scanned, so they are not trusted (#411): the screenshots
// under docs/steps/ are review evidence, taken on real machines, and are left out; any other binary
// file is a hit until an allow entry with "kind": "binary", matched on its file name, explains it (the
// page's icons). Only such an entry explains a binary file, so a loose entry written for text cannot
// let an image through (#411 review 1); an entry with another kind explains only hits of that kind.
import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { allowedBy, BINARY, loadTerms, scanText, type Hit, type Terms } from './scan-rules.ts';

export { scanText, type Allow, type Hit, type Terms } from './scan-rules.ts';

/** Never exported, even if a commit tracks them: local data, test folders and per-person configs. */
const EXCLUDED_DIRS = ['.ledung', '.test', '.claude'];
const EXCLUDED_FILES = [/\.local\.(json|md)$/i, /^relay\.config\.json$/i, /\.bak$/i];
/** Review evidence: screenshots of real sessions, which no scan can read (#411). Nothing links to them. */
export const EVIDENCE_IMAGES = /^docs\/steps\/.+\.(png|jpe?g|gif|webp)$/i;

/** A file name that should never be public, whatever is in it. */
export function badFileName(name: string): boolean {
  return /^\.env(\..*)?$/i.test(name) || /\.(pem|key|p12|pfx|sqlite|db)$/i.test(name) || EXCLUDED_FILES.some((re) => re.test(name));
}

function listFiles(root: string, dir = ''): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) return rel === '.git' ? [] : listFiles(root, rel);
    return [rel];
  });
}

/** Removes what is never exported; returns what it removed. */
export function prune(root: string): string[] {
  const removed: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory() && EXCLUDED_DIRS.includes(e.name)) {
        fs.rmSync(path.join(root, rel), { recursive: true, force: true });
        removed.push(`${rel}/`);
      } else if (e.isDirectory()) {
        walk(rel);
      } else if (EXCLUDED_FILES.some((re) => re.test(e.name)) || EVIDENCE_IMAGES.test(rel)) {
        fs.rmSync(path.join(root, rel));
        removed.push(rel);
      }
    }
  };
  walk('');
  return removed;
}

/** Scans every file of the export (binary files by name only) and the commit's metadata. */
export function scanExport(root: string, terms: Terms): { hits: Hit[]; binary: number } {
  const hits: Hit[] = [];
  let binary = 0;
  for (const file of listFiles(root)) {
    if (badFileName(path.basename(file))) hits.push({ file, line: 0, kind: 'file name', text: path.basename(file) });
    const data = fs.readFileSync(path.join(root, file));
    // The whole file decides, so a file with text up front and binary further in is not counted as read (#411 review 1).
    if (data.includes(0) || !isUtf8(data)) {
      binary++;
      const hit: Hit = { file, line: 0, kind: BINARY, text: path.basename(file) };
      const why = allowedBy(hit, terms.allow);
      if (why) hit.allowed = why;
      hits.push(hit);
      continue;
    }
    hits.push(...scanText(file, data.toString('utf8'), terms));
  }
  const meta = execFileSync('git', ['log', '--format=%an <%ae>%n%cn <%ce>%n%B'], { cwd: root, encoding: 'utf8' });
  hits.push(...scanText('(commit)', meta, terms));
  return { hits, binary };
}

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: env ? { ...process.env, ...env } : undefined }).trim();
}

function main(): void {
  const { values } = parseArgs({
    options: { ref: { type: 'string', default: 'HEAD' }, out: { type: 'string' }, author: { type: 'string' }, terms: { type: 'string' } },
  });
  const author = /^(.+?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(values.author ?? '');
  if (!author) throw new Error('--author "Name <email>" is required: the one commit is made with it.');
  const terms = loadTerms(values.terms);
  if (!values.terms) console.log('No --terms file: only the built-in patterns are scanned.');

  const clone = path.join(import.meta.dirname, '..');
  const sha = git(['rev-parse', '--verify', `${values.ref}^{commit}`], clone);
  const out = path.resolve(values.out ?? path.join(os.tmpdir(), `ledung-public-${sha.slice(0, 8)}-${Date.now()}`));
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new Error(`${out} is not empty; give an empty or new folder.`);
  fs.mkdirSync(out, { recursive: true });

  // git archive honours export-ignore in .gitattributes; tar ships with Windows 10+, macOS and Linux.
  // The archive goes through stdin with tar run in the folder: GNU tar (Git for Windows) reads a
  // drive letter in a path argument as a remote host.
  const archive = execFileSync('git', ['archive', '--format=tar', sha], { cwd: clone, maxBuffer: 2 ** 31 - 1 });
  execFileSync('tar', ['-xf', '-'], { cwd: out, input: archive });
  const removed = prune(out);

  const who = { GIT_AUTHOR_NAME: author[1]!, GIT_AUTHOR_EMAIL: author[2]!, GIT_COMMITTER_NAME: author[1]!, GIT_COMMITTER_EMAIL: author[2]! };
  git(['init', '-q', '-b', 'main'], out);
  git(['add', '-A'], out);
  git(['commit', '-q', '-m', 'Project Ledung'], out, who);

  const { hits, binary } = scanExport(out, terms);
  const open = hits.filter((h) => !h.allowed);
  const allowed = hits.filter((h) => h.allowed);
  console.log(`Exported ${sha.slice(0, 12)} (${values.ref}) to ${out}: ${listFiles(out).length} files, one commit by ${author[1]} <${author[2]}>.`);
  const shots = removed.filter((f) => EVIDENCE_IMAGES.test(f));
  const rest = removed.filter((f) => !EVIDENCE_IMAGES.test(f));
  if (shots.length) console.log(`Left out: ${shots.length} evidence screenshot(s) under docs/steps/.`);
  console.log(rest.length ? `Left out: ${rest.join(', ')}` : 'Left out: no other excluded paths were tracked.');
  console.log(`Scanned: ${listFiles(out).length - binary} text files and the commit; ${binary} binary files by name only.`);
  const byWhy = new Map<string, number>();
  for (const h of allowed) byWhy.set(`${h.kind}: ${h.allowed}`, (byWhy.get(`${h.kind}: ${h.allowed}`) ?? 0) + 1);
  for (const [why, n] of byWhy) console.log(`  allowed ${n}× ${why}`);
  for (const h of open) console.log(`${h.file}:${h.line}: ${h.kind}: ${h.text}`);
  console.log(open.length ? `${open.length} hit(s) to look at.` : 'No hits to look at.');
  console.log('Nothing was pushed and no repository was created anywhere else.');
  process.exitCode = open.length ? 1 : 0;
}

if (import.meta.main) main();
