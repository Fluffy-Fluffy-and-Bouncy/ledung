// The changelogs per release (issue #417; Martin, 2026-11-19, Ledung questions #606 and #613): CHANGELOG-dev.md lists
// every dev build (X.Y), CHANGELOG.md every public release (X), newest first, each under one heading with its version,
// date and time. A PR never edits either: it writes its bullets in docs/changes/<issue>.md, and the publish step folds
// the waiting files in under the version it publishes (this file), then commits and pushes the result to main.
//
// Pure text in, text out, apart from reading and writing the files: the publish script decides when, and restores the
// files when the publish does not go through.
import fs from 'node:fs';
import path from 'node:path';
import { displayVersion, isDevVersion, isPublicVersion, parseVersion } from '../src/shared/version.ts';

export const PUBLIC_FILE = 'CHANGELOG.md';
export const DEV_FILE = 'CHANGELOG-dev.md';
export const CHANGES_DIR = path.join('docs', 'changes');
/** The folder's own guide, which is not a change. */
export const CHANGES_README = 'README.md';

/** The heading's time: "2026-11-19 14:10 CET", in the publishing computer's own time zone unless one is named. */
export function releaseStamp(at: Date, timeZone?: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' })
      .formatToParts(at).map((p) => [p.type, p.value]),
  );
  // en-GB names the zone where it has a short name (CET, CEST, GMT, BST) and gives the offset otherwise (GMT+9).
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

/** The bullets of a text: each `- ` line with the indented lines under it, as one string each. Anything else is left out. */
export function bulletsOf(text: string): string[] {
  const out: string[] = [];
  let open = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('- ')) {
      out.push(line.trimEnd());
      open = true;
    } else if (open && /^\s+\S/.test(line)) {
      out[out.length - 1] += `\n${line.trimEnd()}`;
    } else {
      open = false;
    }
  }
  return out;
}

/** A waiting change file: its name and its bullets. */
export interface Change {
  file: string;
  bullets: string[];
}

/**
 * The waiting change files, newest issue first (a file named for a higher issue number comes first; one with no number,
 * a "no issue" change, after them in name order), so a release reads in roughly the order the work was done.
 */
export function readChanges(root: string): Change[] {
  const dir = path.join(root, CHANGES_DIR);
  if (!fs.existsSync(dir)) return [];
  const num = (f: string) => (/^\d+\.md$/.test(f) ? Number(f.slice(0, -3)) : -1);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== CHANGES_README)
    .sort((a, b) => num(b) - num(a) || a.localeCompare(b))
    .map((file) => ({ file, bullets: bulletsOf(fs.readFileSync(path.join(dir, file), 'utf8')) }));
}

/** One release's section: the heading, then its bullets, or a line saying it has none. */
export function section(version: string, stamp: string, bullets: string[], note?: string): string {
  const lines = [`## ${displayVersion(version)} — ${stamp}`];
  if (note) lines.push(note);
  if (bullets.length) lines.push(...bullets);
  else if (!note) lines.push('Nothing in this release changes what Ledung does.');
  return `${lines.join('\n')}\n`;
}

/** Puts a section above the newest one: before the first `## ` heading, or at the end of a file that has none. */
export function insertSection(file: string, text: string): string {
  const at = file.search(/^## /m);
  if (at < 0) return `${file.replace(/\n*$/, '\n\n')}${text}`;
  return `${file.slice(0, at)}${text}\n${file.slice(at)}`;
}

/** The sections of a changelog whose heading starts with a version: `## v3.9 — …` → { version: '3.9.0', bullets }. */
export function releasesOf(file: string): { version: string; bullets: string[] }[] {
  const out: { version: string; bullets: string[] }[] = [];
  for (const part of file.split(/^(?=## )/m)) {
    const m = /^## v(\d+)(?:\.(\d+))?\b/.exec(part);
    if (!m) continue;
    out.push({ version: `${m[1]}.${m[2] ?? '0'}.0`, bullets: bulletsOf(part.replace(/^.*\n?/, '')) });
  }
  return out;
}

/** What a fold writes: each file's new text, or null to delete it. */
export type FileWrites = Map<string, string | null>;

const DEV_HEADER = `# Ledung changelog: dev builds

Every dev build (v3.10, v3.11 …), newest first: what Settings → About → Update channel → Dev updates to. Each
build has one heading with its version and when it was published, then terse \`- \` bullets, one per change, each
ending with its issue \`(#12)\` or \`(no issue)\`. Public releases, which fold the dev builds since the last one
together, are in [CHANGELOG.md](CHANGELOG.md). Online: https://projectledung.com/dev-changelog

**Don't edit this file.** A pull request writes its bullets in \`docs/changes/<issue>.md\`
([docs/changes/README.md](docs/changes/README.md)); \`npm run publish:dev\` and \`npm run publish:public\` fold them in
here under the version they publish, and push the result to main.
`;

const DEV_FOOTER = `\n## Earlier\nBefore dev builds had a changelog of their own, every change was listed by date: see "Earlier, by date" in [CHANGELOG.md](CHANGELOG.md).\n`;

/** CHANGELOG-dev.md before its first dev build; the repository starts with this file, and the fold makes it if it is missing. */
export const NEW_DEV_FILE = `${DEV_HEADER}${DEV_FOOTER}`;

/**
 * The fold for a publish of `version` at `stamp`: the waiting bullets go under the new version, and the change files
 * are deleted.
 * - A dev build (X.Y) gets a section in CHANGELOG-dev.md.
 * - A public release (X) gets a section in CHANGELOG.md with everything since the last public release: the bullets of
 *   every dev build of X-1 in CHANGELOG-dev.md, then the ones still waiting. The dev changelog gets the release too,
 *   with the waiting bullets, so it lists every version the Dev channel can update to.
 */
export function fold(root: string, version: string, stamp: string): { writes: FileWrites; section: string } {
  const changes = readChanges(root);
  const waiting = changes.flatMap((c) => c.bullets);
  const read = (f: string) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : null);
  const writes: FileWrites = new Map();
  for (const c of changes) writes.set(path.join(CHANGES_DIR, c.file), null);
  const devFile = read(DEV_FILE) ?? NEW_DEV_FILE;
  let text: string;
  if (isDevVersion(version)) {
    text = section(version, stamp, waiting);
    writes.set(DEV_FILE, insertSection(devFile, text));
  } else if (isPublicVersion(version)) {
    const major = parseVersion(version)![0];
    const devBuilds = releasesOf(devFile).filter((r) => isDevVersion(r.version) && parseVersion(r.version)![0] === major - 1);
    const since = devBuilds.length
      ? `Everything since v${major - 1}: ${devBuilds.map((r) => displayVersion(r.version)).reverse().join(', ')}${waiting.length ? ' and the changes below' : ''}.`
      : undefined;
    text = section(version, stamp, [...devBuilds.flatMap((r) => r.bullets), ...waiting]);
    writes.set(PUBLIC_FILE, insertSection(read(PUBLIC_FILE) ?? '# Ledung changelog\n', text));
    writes.set(DEV_FILE, insertSection(devFile, section(version, stamp, waiting, since ? `The public release. ${since}` : 'The public release.')));
  } else {
    throw new Error(`${version} is neither a dev build (X.Y) nor a public release (X).`);
  }
  return { writes, section: text };
}

/** Writes a fold, and returns what was there before, so the publish can put it back. */
export function applyWrites(root: string, writes: FileWrites): FileWrites {
  const before: FileWrites = new Map();
  for (const [file, text] of writes) {
    const full = path.join(root, file);
    before.set(file, fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null);
    if (text === null) fs.rmSync(full, { force: true });
    else fs.writeFileSync(full, text);
  }
  return before;
}
