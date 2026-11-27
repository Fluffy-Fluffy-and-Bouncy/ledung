// Puts the stand-in `gh` (stand-in.ts, issue #513 part 2) ahead of the real one in a local session's environment.
//
// Its files are in a temp folder of their own, not Ledung's data folder: the data folder is out of every session's
// reach (#104, boundary.ts), and on macOS and Linux the sandbox's denyRead would stop the shell from even reading the
// script, which would turn `gh` into an error. The same reason the locked secrets' files are there (secrets/runtime.ts).
//
//   <tmp>/ledung-gh-<tag>/gh-<hash>.mjs   the stand-in, one copy per version (a running one is never overwritten)
//   <tmp>/ledung-gh-<tag>/<session>/gh    the shell script Git Bash, zsh and bash find first on PATH
//   <tmp>/ledung-gh-<tag>/<session>/session.json   the real gh, the filled-in texts, recording, the run
//   <tmp>/ledung-gh-<tag>/<session>/journal.jsonl  what went out (the Outbox reads it in part 4)
//
// No .cmd (cmd re-reads %, &, ^ and ! in %*: check 2) and no .ps1 (open choice 3a): cmd and PowerShell find the real
// gh.exe, unsigned but intact. No LEDUNG_* variable is used: the script knows its own session's file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envSetting, ghStandInEntry } from '../platform/paths.ts';
import { writeFileSafely } from '../platform/safe-write.ts';
import type { StandInSession } from './stand-in.ts';

/**
 * The stand-in's folder for this Ledung (by its data folder, so a test Ledung has its own). LEDUNG_GH_STAND_IN_DIR
 * puts it elsewhere: the test run's own temp folder (scripts/test.ts), so the sessions tests start leave nothing.
 */
export function standInRoot(dataDir: string): string {
  const tag = crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 8);
  const override = envSetting('GH_STAND_IN_DIR');
  return path.join(override ? path.resolve(override) : os.tmpdir(), `ledung-gh-${tag}`);
}

/** The PATH variable's name in an environment: Windows keeps "Path", and only one may be set. */
export function pathKey(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}

/**
 * The real gh on an environment's PATH, by full path, never one in the stand-in's own folder (so it can't call
 * itself) nor in any other Ledung's (a test Ledung started inside a session inherits that session's PATH: review of
 * PR #519, finding 5). On Windows only a gh.exe: Node can't start a .cmd or .bat without a shell, which would re-read the
 * arguments. null: not installed, and no stand-in is put in.
 */
export function findRealGh(env: Record<string, string | undefined>, root: string, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = isFile): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const own = p.resolve(root).toLowerCase();
  for (const dir of (env[pathKey(env)] ?? '').split(sep)) {
    if (!dir.trim()) continue;
    const full = p.resolve(dir.replace(/^"(.*)"$/, '$1'));
    if (full.toLowerCase().startsWith(own) || full.split(/[\\/]/).some((part) => part.startsWith('ledung-gh-'))) continue;
    const candidate = p.join(full, platform === 'win32' ? 'gh.exe' : 'gh');
    if (exists(candidate)) return candidate;
  }
  return null;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** A string as one single-quoted shell word. */
export function shellWord(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A Windows path as Git Bash takes it in a script (C:\x → C:/x); others unchanged. */
const forShell = (p: string, platform: NodeJS.Platform) => (platform === 'win32' ? p.replace(/\\/g, '/') : p);

/**
 * The session's `gh` script. It only starts Node for `gh issue`, `gh pr` and `gh api`; everything else is the real
 * gh at once, by exec, so its output, prompts and exit code are gh's own. Node missing, the stand-in failing to
 * load or asking for it (exit PASS_TO_SHELL): the real gh with the original arguments. The real gh gone too: the
 * next gh on PATH after this folder.
 */
export function shellScript(o: { node: string; standIn: string; session: string; real: string[]; platform?: NodeJS.Platform }): string {
  const platform = o.platform ?? process.platform;
  const real = o.real.map((r) => shellWord(forShell(r, platform))).join(' ');
  // Loads the stand-in and runs it; any failure to load it is the shell's to pass on. In single quotes: no $ in it.
  const boot = "const[m,s,...a]=process.argv.slice(1);import(require('node:url').pathToFileURL(m).href).then(x=>x.main(s,a)).then(c=>process.exit(c),()=>process.exit(197))";
  return [
    '#!/bin/sh',
    "# Ledung's stand-in for gh (issue #513): signs and records issue and PR posts, then runs the real gh.",
    '# Written by Ledung for one session; changing it only changes that session\'s courtesy line.',
    `node=${shellWord(forShell(o.node, platform))}`,
    `standin=${shellWord(forShell(o.standIn, platform))}`,
    `session=${shellWord(forShell(o.session, platform))}`,
    `first=${shellWord(forShell(o.real[0]!, platform))}`,
    'real() {',
    '  if [ -f "$first" ]; then exec ' + real + ' "$@"; fi',
    '  # The real gh moved: the next one on PATH, not this folder.',
    '  self=$0',
    '  IFS=:',
    '  for d in $PATH; do',
    '    [ -n "$d" ] || continue',
    '    for g in "$d/gh" "$d/gh.exe"; do',
    '      if [ -f "$g" ] && [ -x "$g" ] && ! [ "$g" -ef "$self" ]; then',
    '        case "$d" in *ledung-gh-*) ;; *) unset IFS; exec "$g" "$@" ;; esac',
    '      fi',
    '    done',
    '  done',
    '  unset IFS',
    '  echo "gh: command not found" >&2',
    '  exit 127',
    '}',
    'case "$1" in',
    '  issue|pr|api) ;;',
    '  *) real "$@" ;;',
    'esac',
    '[ -f "$node" ] && [ -f "$standin" ] || real "$@"',
    `"$node" --no-warnings -e ${shellWord(boot)} -- "$standin" "$session" "$@"`,
    'code=$?',
    '[ "$code" -eq 197 ] || exit "$code"',
    'real "$@"',
    '',
  ].join('\n');
}

/** The stand-in's code as it runs in a session: this Ledung's own file, copied once per version. */
function copyStandIn(root: string): string {
  const entry = ghStandInEntry();
  const code = fs.readFileSync(entry);
  const hash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 12);
  // .mts from the source (Node strips its types; outside node_modules it may), .mjs from the package's plain JavaScript.
  const target = path.join(root, `gh-${hash}${entry.endsWith('.ts') ? '.mts' : '.mjs'}`);
  if (!isFile(target)) writeFileSafely(target, code);
  return target;
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}

/** A session's folder name: its id, kept to safe characters. */
const sessionFolder = (root: string, sessionId: string) => path.join(root, sessionId.replace(/[^A-Za-z0-9_-]/g, '_'));

/**
 * Writes a session's stand-in and returns its folder, to go first on PATH; null when there is no real gh to stand in
 * for. Throws on a write failure (the session then starts without it, with the real gh).
 */
export function installStandIn(o: { dataDir: string; sessionId: string; env: Record<string, string | undefined>; session: Omit<StandInSession, 'real'> }): string | null {
  const root = standInRoot(o.dataDir);
  const real = findRealGh(o.env, root);
  if (!real) return null;
  privateDir(root);
  const standIn = copyStandIn(root);
  const dir = sessionFolder(root, o.sessionId);
  privateDir(dir);
  const sessionFile = path.join(dir, 'session.json');
  writeSession(sessionFile, { ...o.session, real: [real] });
  const script = path.join(dir, 'gh');
  const text = shellScript({ node: process.execPath, standIn, session: sessionFile, real: [real] });
  // sh reads a script as it runs: one a call is running is only ever replaced whole, and only when it changed.
  if (readOrNull(script) !== text) writeFileSafely(script, text, { mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(script, 0o700);
  return dir;
}

/** A running session's texts again (its signature changed, or {model}): only the file, the script stays. */
export function updateStandIn(dataDir: string, sessionId: string, session: Omit<StandInSession, 'real'>): void {
  const file = path.join(sessionFolder(standInRoot(dataDir), sessionId), 'session.json');
  let real: string[];
  try {
    real = (JSON.parse(fs.readFileSync(file, 'utf8')) as StandInSession).real;
  } catch {
    return; // It has no stand-in.
  }
  writeSession(file, { ...session, real });
}

function writeSession(file: string, session: StandInSession): void {
  writeFileSafely(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

/** An environment with the stand-in's folder first on PATH. */
export function withStandIn(env: Record<string, string>, dir: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const key = pathKey(env);
  const sep = platform === 'win32' ? ';' : ':';
  return { ...env, [key]: env[key] ? `${dir}${sep}${env[key]}` : dir };
}
