// Reading files from a container project (issue #122), read-only: for the file viewer, the Files pane, and
// ask_user's screenshots and a review's evidence. Each read is one `docker exec` of a fixed script with every
// value as an argument ("$1" …), never spliced into it, and a time limit. The path is resolved inside the
// container (readlink -f), so a link can't lead out of the project folder; only PNG, JPEG, .md, .txt and .log
// (Simon's approval on question #1626), their size checked before the read and capped while reading.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SECRET_RUNTIME_PATTERN } from '../shared/secrets.ts';
import { bytesKind, type AttachmentKind } from '../board/attachments.ts';
import { FileError, type ProjectFile, type ProjectImage } from './files.ts';
import type { TreeEntry, TreeListing } from '../shared/files-pane.ts';
import { GIT_READ_MAX_BYTES, type GitRead } from './git-read.ts';

/** One script run in the container: `sh -c <script> sh <args…>`, as bytes; a failure of docker itself is `failed`. */
export type ContainerExec = (script: string, args: string[], opts: { input?: string; maxBytes: number; timeoutMs: number }) => Promise<ContainerRun>;
export type ContainerRun = { code: number | null; stdout: Buffer; stderr: string; truncated: boolean } | { failed: string };

/** What a container project's files are read with: its exec, and the rules that hold besides its folder. */
export interface ContainerAccess {
  exec: ContainerExec;
  /**
   * The project folder in the container: the wall. The session's folder (its run worktree) must resolve inside it.
   * Another project that names the same container by another name (its id, an alias) or bind-mounts a locked local
   * folder into it is not known here (security review of #122, finding 8): lockdown names containers by their name.
   */
  project: string;
  /** The container's name, for the messages. */
  container: string;
  /** Other locked projects' folders in this same container (issue #109): never read or listed from here. */
  locked: readonly string[];
  /** The sensitive path patterns (the config's and the project's), matched on the real path as tool calls are. */
  pathPatterns: readonly string[];
}

const READ_TIMEOUT_MS = 30000;
const LIST_TIMEOUT_MS = 20000;
/** The viewer's limits, as for a local project (src/sessions/files.ts). */
export const CONTAINER_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const CONTAINER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const TEXT_NAME = /\.(md|txt|log)$/i;
const IMAGE_NAME = /\.(png|jpe?g)$/i;
const TREE_MAX_ENTRIES = 1000;
const hiddenName = (name: string) => name.startsWith('.') || name.startsWith('$');

/** Plain words for a docker exec that failed: the container stopped or missing, Docker not running, no answer. */
export function containerFailure(container: string, stderr: string, timedOut: boolean, timeoutMs: number): string {
  if (timedOut) return `The container "${container}" gave no answer within ${Math.round(timeoutMs / 1000)} s.`;
  if (/is not running|is paused|is restarting/i.test(stderr)) return `The container "${container}" is not running, so its files can't be shown. Start it and try again.`;
  if (/no such container/i.test(stderr)) return `The container "${container}" was not found, so its files can't be shown.`;
  if (/docker daemon|error during connect|pipe\/docker|docker_engine/i.test(stderr)) return `Docker is not running, so the files of the container "${container}" can't be shown.`;
  const said = stderr.trim().split('\n')[0];
  return `The container "${container}" could not be read${said ? ` (${said})` : ''}.`;
}

/**
 * What every script starts with: `real`, readlink -f that fails for a path with a newline in it (command substitution
 * would drop a trailing one and so name another file; security review of #122, finding 5). It prints with -n, no
 * closing newline of its own: macOS's readlink leaves that newline out when the name already ends in one, so cutting
 * one off took the name's own and named the file without it (issue #127); GNU, busybox, toybox and macOS all have -n,
 * and a readlink without it fails here, which refuses. Then the check that the
 * session's folder ($2) is the project folder ($1) or inside it, so a run worktree the session swapped for a link to
 * elsewhere can't move the root (finding 1). Sets pr, the project folder, and root, the session's folder.
 */
const PRELUDE = [
  "nl='",
  "'",
  'real() { _r=$(readlink -n -f -- "$1" && echo x) || return 1; case "$_r" in *x) ;; *) return 1;; esac; _r=${_r%x}; [ -n "$_r" ] || return 1; case "$_r" in *"$nl"*) return 1;; esac; printf %s "$_r"; }',
  'inside() { case "$1" in "$2"|"${2%/}"/*) return 0;; esac; return 1; }',
  'pr=$(real "$1") || { echo noroot; exit 0; }; root=$(real "$2") || { echo noroot; exit 0; }',
  'inside "$root" "$pr" || { echo outside; exit 0; }',
  '[ -d "$root" ] || { echo noroot; exit 0; }',
];

/**
 * The read script: $1 the project folder, $2 the session's folder in it, $3 the file (relative to it, or absolute in the
 * container), $4 the most it may have, then the locked folders. Prints one status word, or "ok", the real root and the
 * real path, each ended by a NUL, and then the file, at most one byte more than $4 (so a file grown since its size was
 * checked is refused), from a descriptor whose own path is checked again where /proc shows it, so a folder on the way
 * swapped for a link after the check is caught. The size check fails closed (finding 6).
 */
export const READ_SCRIPT = [
  ...PRELUDE,
  'case "$3" in /*) p=$3;; *) p="$root/$3";; esac',
  '[ -e "$p" ] || { echo missing; exit 0; }',
  'r=$(real "$p") || { echo outside; exit 0; }',
  'case "$r" in "${root%/}"/*) ;; *) echo outside; exit 0;; esac',
  'max=$4; shift 4',
  'for l in "$@"; do lr=$(real "$l") || continue; inside "$r" "$lr" && { echo locked; exit 0; }; done',
  '[ -d "$r" ] && { echo folder; exit 0; }',
  '{ [ -f "$r" ] && [ -r "$r" ]; } || { echo unreadable; exit 0; }',
  `n=$(wc -c < "$r" | tr -d ' ')`,
  '[ "$n" -le "$max" ] 2>/dev/null || { echo "large $n"; exit 0; }',
  'exec 3< "$r" || { echo unreadable; exit 0; }',
  'if o=$(readlink -f "/proc/$$/fd/3" 2>/dev/null) && [ -n "$o" ] && [ "$o" != "$r" ]; then echo outside; exit 0; fi',
  `printf 'ok\\n%s\\0%s\\0' "$root" "$r"`,
  'head -c "$((max + 1))" <&3',
].join('\n');

/**
 * The listing script: $1 the project folder, $2 the session's folder in it, $3 the folder in that ("" for itself), $4 the
 * most entries, then the locked folders. Prints one status word, or "ok", the real root and the real folder, then per
 * entry its kind (d or f), size, name and real target, each ended by a NUL; a link that leads outside the folder or into
 * a locked one is left out (its size never read), and "more" ends a folder cut at $4. The glob leaves out dot-names,
 * which are not listed anyway.
 */
export const LIST_SCRIPT = [
  ...PRELUDE,
  'case "$3" in "") p=$root;; /*) p=$3;; *) p="$root/$3";; esac',
  '[ -e "$p" ] || { echo missing; exit 0; }',
  'r=$(real "$p") || { echo outside; exit 0; }',
  'inside "$r" "$root" || { echo outside; exit 0; }',
  'max=$4; shift 4',
  'locked() { x=$1; shift; for l in "$@"; do lr=$(real "$l") || continue; inside "$x" "$lr" && return 0; done; return 1; }',
  'locked "$r" "$@" && { echo locked; exit 0; }',
  '[ -d "$r" ] || { echo notfolder; exit 0; }',
  `printf 'ok\\n%s\\0%s\\0' "$root" "$r"`,
  'i=0',
  'for f in "${r%/}"/*; do',
  '  [ -e "$f" ] || continue',
  `  i=$((i + 1)); [ "$i" -gt "$max" ] && { printf 'more\\0'; break; }`,
  '  t=$(real "$f") || continue',
  '  case "$t" in "${root%/}"/*) ;; *) continue;; esac',
  '  locked "$t" "$@" && continue',
  `  if [ -d "$t" ]; then printf 'd\\0\\0%s\\0%s\\0' "\${f##*/}" "$t"`,
  `  elif [ -f "$t" ]; then printf 'f\\0%s\\0%s\\0%s\\0' "$(wc -c < "$t" | tr -d ' ')" "\${f##*/}" "$t"`,
  '  fi',
  'done',
].join('\n');

/**
 * git in the session's folder in the container: $1 the project folder, $2 the session's folder, $3 how many locked
 * folders follow, then them, then git's arguments. Refused (exit 128) when the folder is outside the project folder or
 * inside a locked one (finding 2), with Ledung's hardening (src/sessions/git-read.ts), the null device the container
 * has, and no GIT_* setting from the container's environment, as gitEnv does here (finding 4).
 */
export const GIT_SCRIPT = [
  ...PRELUDE.map((l) => l.replace(/echo (noroot|outside); exit 0/g, 'echo "the session\'s folder is not inside the project folder" >&2; exit 128')),
  'n=$3; shift 3',
  'while [ "$n" -gt 0 ]; do lr=$(real "$1") && inside "$root" "$lr" && { echo "the folder is in a locked project\'s folder" >&2; exit 128; }; shift; n=$((n - 1)); done',
  'cd -- "$root" || exit 128',
  "for v in $(env | sed -n 's/^\\(GIT_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset \"$v\"; done",
  'GIT_OPTIONAL_LOCKS=0 GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 exec git "$@"',
].join('\n');
export const CONTAINER_GIT_HARDENING: readonly string[] = [
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'core.quotePath=false', '-c', 'protocol.allow=never',
];

/** A link as it appears in a chat: without ?query or #fragment, decoded, forward slashes. */
function wantedPath(link: string): string {
  let wanted = link.replace(/[?#].*$/, '');
  try {
    wanted = decodeURIComponent(wanted);
  } catch {
    // Not encoded; use as is.
  }
  wanted = wanted.replace(/\\/g, '/');
  if (!wanted.trim()) throw new FileError('No file given.');
  if (/[\0\n\r]/.test(wanted)) throw new FileError('That is not a file name.');
  return wanted;
}

/** `real` relative to `root` (both POSIX real paths), or null when it is not inside. */
function insideOf(root: string, real: string): string | null {
  const rel = path.posix.relative(root, real);
  return rel && !rel.startsWith('..') && !path.posix.isAbsolute(rel) ? rel : null;
}

/** Why the real path is never shown from here, or null: a running session's secrets file, or a sensitive path. */
function ruleProblem(access: ContainerAccess, real: string, inside: string): string | null {
  if (SECRET_RUNTIME_PATTERN.test(real)) return 'Only files inside the project folder can be shown.';
  for (const p of access.pathPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(p, 'i');
    } catch {
      continue;
    }
    if (re.test(real) || re.test(inside)) return `${inside} is not shown: it matches a sensitive path pattern.`;
  }
  return null;
}

/** Splits a NUL-ended run of fields. */
function fields(buf: Buffer, from: number, count: number): { parts: string[]; next: number } | null {
  const parts: string[] = [];
  let at = from;
  for (let i = 0; i < count; i++) {
    const end = buf.indexOf(0, at);
    if (end < 0) return null;
    parts.push(buf.subarray(at, end).toString('utf8'));
    at = end + 1;
  }
  return { parts, next: at };
}

/** The status word a script printed, or the reason the exec failed, as a FileError. */
function statusOf(access: ContainerAccess, run: ContainerRun, timeoutMs: number): { status: string; rest: Buffer } {
  if ('failed' in run) throw new FileError(run.failed);
  if (run.code !== 0) throw new FileError(containerFailure(access.container, run.stderr, run.code === null && !run.truncated, timeoutMs));
  const nl = run.stdout.indexOf(10);
  if (nl < 0) throw new FileError(`The container "${access.container}" gave no answer that Ledung understands.`);
  return { status: run.stdout.subarray(0, nl).toString('utf8').trim(), rest: run.stdout.subarray(nl + 1) };
}

/**
 * The bytes of `link` in the container's project folder `root`, read with the rules above; refused above `maxBytes`
 * before it is read. `name` checks the real file's name (its type), so a link named x.png that leads to notes.md
 * is judged as notes.md (review M3 of the board).
 */
export async function readContainerBytes(access: ContainerAccess, root: string, link: string, maxBytes: number, name: (inside: string) => string | null): Promise<{ path: string; bytes: Buffer }> {
  const wanted = wantedPath(link);
  const run = await access.exec(READ_SCRIPT, [access.project, root, wanted, String(Math.floor(maxBytes)), ...access.locked], { maxBytes: maxBytes + 64 * 1024, timeoutMs: READ_TIMEOUT_MS });
  const { status, rest } = statusOf(access, run, READ_TIMEOUT_MS);
  switch (status.split(' ')[0]) {
    case 'ok': break;
    case 'noroot': throw new FileError(`The project folder ${root} is not in the container "${access.container}".`);
    case 'missing': throw new FileError(`There is no file ${wanted} in the project.`);
    case 'outside': throw new FileError('Only files inside the project folder can be shown.');
    case 'locked': throw new FileError("That file is in a locked project's folder.");
    case 'unreadable': throw new FileError(`${wanted} is not a file that can be read.`);
    case 'folder': throw new FileError(`${wanted} is a folder; only files can be shown.`);
    case 'large': throw new FileError(`${wanted} is too large to show (${Math.round(Number(status.split(' ')[1]) / 1024)} KB; the limit is ${Math.round(maxBytes / 1024)} KB).`);
    default: throw new FileError(`${wanted} can't be read in the container.`);
  }
  const head = fields(rest, 0, 2);
  const inside = head && insideOf(head.parts[0]!, head.parts[1]!);
  if (!head || !inside) throw new FileError('Only files inside the project folder can be shown.');
  const problem = ruleProblem(access, head.parts[1]!, inside) ?? name(inside);
  if (problem) throw new FileError(problem);
  const bytes = rest.subarray(head.next);
  // head -c capped it; a file that grew past the limit since its size was checked is refused, not shown cut.
  if (bytes.length > maxBytes || ('truncated' in run && run.truncated)) throw new FileError(`${inside} is too large to show.`);
  return { path: inside, bytes };
}

/** The file viewer's text, from a container: only .md, .txt and .log, as approved. */
export async function readContainerText(access: ContainerAccess, root: string, link: string): Promise<ProjectFile> {
  const f = await readContainerBytes(access, root, link, CONTAINER_TEXT_MAX_BYTES, (inside) => (TEXT_NAME.test(inside) ? null : `${inside} can't be shown from a container: only .md, .txt and .log text files and PNG or JPEG images.`));
  if (f.bytes.subarray(0, 8192).includes(0)) throw new FileError(`${f.path} is not a text file.`);
  return { path: f.path, kind: /\.md$/i.test(f.path) ? 'markdown' : 'text', content: f.bytes.toString('utf8') };
}

/** The file viewer's image, from a container: a PNG or JPEG by its name and its first bytes. */
export async function readContainerImage(access: ContainerAccess, root: string, link: string, maxBytes = CONTAINER_IMAGE_MAX_BYTES): Promise<ProjectImage> {
  const f = await readContainerBytes(access, root, link, maxBytes, (inside) => (IMAGE_NAME.test(inside) ? null : `${inside} is not a PNG or JPEG image.`));
  const kind = bytesKind(f.bytes, f.path);
  if (kind !== 'png' && kind !== 'jpeg') throw new FileError(`${f.path} is not really a ${/\.png$/i.test(f.path) ? 'PNG' : 'JPEG'} image.`);
  return { path: f.path, type: kind === 'png' ? 'image/png' : 'image/jpeg', bytes: f.bytes };
}

/** One folder of a container project's tree, with the local tree's rules (src/sessions/tree.ts). */
export async function listContainerFolder(access: ContainerAccess, root: string, rel: string): Promise<TreeListing> {
  const wanted = rel.replace(/\\/g, '/').replace(/\/+$/g, '');
  if (/[\0\n\r]/.test(wanted)) throw new FileError('That is not a folder name.');
  const run = await access.exec(LIST_SCRIPT, [access.project, root, wanted, String(TREE_MAX_ENTRIES), ...access.locked], { maxBytes: 4 * 1024 * 1024, timeoutMs: LIST_TIMEOUT_MS });
  const { status, rest } = statusOf(access, run, LIST_TIMEOUT_MS);
  switch (status) {
    case 'ok': break;
    case 'noroot': throw new FileError(`The project folder ${root} is not in the container "${access.container}".`);
    case 'missing': throw new FileError(`There is no folder ${wanted} in the session's folder.`);
    case 'outside': throw new FileError("Only folders inside the session's folder can be listed.");
    case 'locked': throw new FileError("That folder is in a locked project's folder.");
    case 'notfolder': throw new FileError(`${wanted} is a file, not a folder.`);
    default: throw new FileError(`${wanted} can't be listed in the container.`);
  }
  const head = fields(rest, 0, 2);
  if (!head) throw new FileError(`The container "${access.container}" gave no answer that Ledung understands.`);
  const [realRoot, real] = head.parts as [string, string];
  const at = real === realRoot ? '' : insideOf(realRoot, real);
  if (at === null) throw new FileError("Only folders inside the session's folder can be listed.");
  if (at.split('/').some(hiddenName)) throw new FileError('Hidden folders and files (names starting with . or $) are not listed.');
  if (at && ruleProblem(access, real, at)) throw new FileError('That folder is not listed: it matches a sensitive path pattern.');
  const entries: TreeEntry[] = [];
  let truncated = false;
  let next = head.next;
  while (next < rest.length) {
    const kind = fields(rest, next, 1);
    if (!kind) break;
    if (kind.parts[0] === 'more') {
      truncated = true;
      break;
    }
    const rec = fields(rest, kind.next, 3);
    if (!rec) break;
    next = rec.next;
    const [size, name, target] = rec.parts as [string, string, string];
    const inside = insideOf(realRoot, target);
    // A link is followed only to somewhere the same rules allow, as in the local tree.
    if (!inside || hiddenName(name) || inside.split('/').some(hiddenName) || SECRET_RUNTIME_PATTERN.test(name) || ruleProblem(access, target, inside)) continue;
    const dir = kind.parts[0] === 'd';
    entries.push({ name, path: at ? `${at}/${name}` : name, dir, size: dir ? null : Number(size) || 0, skipped: dir && name === 'node_modules' ? 'heavy' : null });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.dir ? -1 : 1));
  await markIgnored(access, real, entries);
  return { path: at, entries, truncated };
}

/** git in the container's folder, as gitRead does it here: hardened, capped, timed; docker's own failure as a FileError. */
export async function containerGit(access: ContainerAccess, folder: string, args: readonly string[], opts: { input?: string; maxBytes?: number; timeoutMs?: number } = {}): Promise<GitRead> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const run = await access.exec(GIT_SCRIPT, [access.project, folder, String(access.locked.length), ...access.locked, ...CONTAINER_GIT_HARDENING, ...args], { input: opts.input, maxBytes: opts.maxBytes ?? GIT_READ_MAX_BYTES, timeoutMs });
  if ('failed' in run) throw new FileError(run.failed);
  if (run.code !== 0 && /error response from daemon|no such container|docker daemon|error during connect/i.test(run.stderr)) {
    throw new FileError(containerFailure(access.container, run.stderr, false, timeoutMs));
  }
  // GIT_SCRIPT's own refusals.
  const refused = /^(the session's folder is not inside the project folder|the folder is in a locked project's folder)$/m.exec(run.stderr);
  if (run.code === 128 && refused) throw new FileError(`Changes can't be shown: ${refused[1]}.`);
  return { code: run.code, stdout: run.stdout.toString('utf8'), stderr: run.stderr, truncated: run.truncated };
}

/**
 * What the Changes tab leaves out of a container session's diff in `folder` (security review of #122, finding 2): files
 * in another locked project's folder, files a sensitive path pattern names and the secrets files, as the viewer does.
 */
export function diffHidden(access: ContainerAccess, folder: string): (file: string) => boolean {
  const locked = access.locked.map((l) => path.posix.relative(folder, l)).filter((rel) => rel && !rel.startsWith('..') && !path.posix.isAbsolute(rel));
  return (file) => locked.some((l) => file === l || file.startsWith(`${l}/`)) || ruleProblem(access, path.posix.join(folder, file), file) !== null;
}

/** Marks what .gitignore leaves out, by asking git in the container's folder; outside a repository nothing is marked. */
async function markIgnored(access: ContainerAccess, folder: string, entries: TreeEntry[]): Promise<void> {
  const ask = entries.filter((e) => !e.skipped);
  if (!ask.length) return;
  const names = ask.map((e) => (e.dir ? `${e.name}/` : e.name));
  const r = await containerGit(access, folder, ['check-ignore', '--stdin', '-z'], { input: names.join('\0') + '\0', timeoutMs: 10000 }).catch(() => null);
  if (!r || r.code !== 0) return;
  const ignored = new Set(r.stdout.split('\0').filter(Boolean).map((n) => n.replace(/\/$/, '')));
  for (const e of ask) if (ignored.has(e.name)) e.skipped = 'ignored';
}

// --- Copies kept for questions ------------------------------------------------------------------------
// A screenshot or evidence file from a container is read when the question is asked and kept in Ledung's data
// folder (Simon's approval on question #1626), so its page shows it later, with the container stopped too. The
// question names it "container:<hash>/<path>": the hash finds the copy, the path is what the page shows.

export const CONTAINER_FILE_PREFIX = 'container:';
const COPY_REF = /^container:([0-9a-f]{32})\/(.+)$/;

/** Removes the project's copies no question names (`named`: their hashes) that were kept before `before`. */
export function pruneCopies(dir: string, project: string, named: ReadonlySet<string>, before: number): void {
  const folder = copyFolder(dir, project);
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names) {
    if (named.has(name)) continue;
    const file = path.join(folder, name);
    try {
      if (fs.statSync(file).mtimeMs < before) fs.rmSync(file, { force: true });
    } catch {
      // Gone meanwhile.
    }
  }
}

/** Where a project's kept copies are: one folder per project, by a hash of its name, so no name can leave it. */
function copyFolder(dir: string, project: string): string {
  return path.join(dir, crypto.createHash('sha256').update(project).digest('hex').slice(0, 16));
}

/** Keeps `bytes` as a copy for the project's questions; the name the question stores. */
export function keepCopy(dir: string, project: string, inside: string, bytes: Buffer): string {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  const folder = copyFolder(dir, project);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, hash);
  if (!fs.existsSync(file)) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
  } else {
    // Kept again: not pruned as an old copy no question names yet (pruneCopies).
    const now = new Date();
    fs.utimesSync(file, now, now);
  }
  return `${CONTAINER_FILE_PREFIX}${hash}/${inside}`;
}

/**
 * A kept copy by the name a question stores, only from the project's own folder of copies, and only when its bytes
 * are still what the name's hash says and of the kind its name is (`kinds`).
 */
export function readCopy(dir: string, project: string, ref: string, kinds: readonly AttachmentKind[]): { path: string; kind: AttachmentKind; bytes: Buffer } {
  const m = COPY_REF.exec(ref);
  if (!m) throw new FileError('That is not a file Ledung kept for a question.');
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path.join(copyFolder(dir, project), m[1]!));
  } catch {
    throw new FileError(`Ledung has no copy of ${m[2]} for this project.`);
  }
  if (crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32) !== m[1]) throw new FileError(`Ledung's copy of ${m[2]} has changed; it is not shown.`);
  const kind = bytesKind(bytes, m[2]!);
  if (!kind || !kinds.includes(kind)) throw new FileError(`${m[2]} is not ${kinds.includes('text') ? 'a PNG or JPEG image or a .txt, .log or .md file' : 'a PNG or JPEG image'}.`);
  return { path: m[2]!, kind, bytes };
}
