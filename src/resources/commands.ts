// What kind of work a turn did, from the commands it ran (step 6c): the first words of each command,
// so turns can be grouped ("npm run build", "pytest", "cargo test"). Commands that only look around
// (cd, ls, cat, grep, …) say nothing about the cost and are left out.

const TRIVIAL = new Set([
  'cd', 'ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'echo', 'printf', 'grep', 'rg', 'find', 'sed', 'awk', 'wc', 'sort', 'uniq',
  'which', 'where', 'true', 'false', 'test', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'sleep', 'export', 'set', 'source', 'date',
  'get-content', 'get-childitem', 'select-string', 'write-host', 'write-output', 'get-date', 'set-location', 'test-path',
  // More of the same: reading and shaping text (resource limits round 2, R4: `cut` was refused as "~3.1 GB").
  'cut', 'tr', 'tee', 'jq', 'diff', 'cmp', 'comm', 'paste', 'column', 'nl', 'basename', 'dirname', 'realpath', 'readlink', 'stat',
  'file', 'less', 'more', 'whoami', 'hostname', 'uname', 'type',
]);

/**
 * Light commands (docs/steps/resource-limits-2.md, "Light commands", R4; fixed in the code, open choice 6): never
 * refused and never learned as heavy. Read-only git, and all of `gh`, which waits on the network, not the PC.
 */
const LIGHT_GIT = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'remote', 'fetch', 'worktree list', 'stash list']);

export function isLightKind(kind: string): boolean {
  // A file-reading word is never a kind now, but old records may have one (`cut` before it joined TRIVIAL).
  if (kind === 'gh' || kind.startsWith('gh ') || kind === 'git' || TRIVIAL.has(kind) || SYNTAX.has(kind) || KEYWORD_BEFORE.has(kind)) return true;
  return kind.startsWith('git ') && LIGHT_GIT.has(kind.slice(4));
}

/** Tools that take a subcommand: keep it ("git status", "docker build"); npm-like runners keep the script too. */
const WITH_SUBCOMMAND = new Set(['git', 'docker', 'cargo', 'go', 'dotnet', 'gh', 'kubectl', 'pip', 'uv', 'poetry', 'make', 'npx', 'bunx', 'node', 'python', 'python3', 'deno', 'bun']);
const RUNNERS = new Set(['npm', 'pnpm', 'yarn']);
/** Shell words a command may follow (`do npm test`, `if make`): dropped, and the command after them kept. */
const KEYWORD_BEFORE = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}']);
/** Parts that are only syntax (`for f in *.ts`, `done`), or a line of a script given inline (`node -e "…"`). */
const SYNTAX = new Set(['for', 'select', 'in', 'done', 'fi', 'esac', 'case', 'function', 'const', 'let', 'var', 'import', 'return']);

/** The kinds of command in one shell command line, e.g. "cd app && npm run build | tee x" → ["npm run build"]. */
export function commandKinds(command: string): string[] {
  const out: string[] = [];
  for (const part of command.split(/&&|\|\||;|\||\n/)) {
    const words = (part.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
      .map((w) => w.replace(/^["']|["']$/g, ''))
      .filter((w) => w && !/^[A-Z_][A-Z0-9_]*=/.test(w));
    // Shell syntax isn't a command (`for`, `while`, `do npm test`), nor is a line of a script passed inline (`const x = …`):
    // the old Ledung refused "for" and "const" as "~3.1 GB" (acceptance test of R4, round 1).
    while (words.length && KEYWORD_BEFORE.has(words[0]!)) words.shift();
    if (!words.length || SYNTAX.has(words[0]!)) continue;
    const first = words[0]!.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    if (TRIVIAL.has(first) || first.startsWith('$') || first.startsWith('-')) continue;
    let kind = first;
    // git's own options before the subcommand take a value (`git -C dir status`): not the subcommand.
    const rest = first === 'git' ? words.slice(1).filter((w, i, all) => !/^-[Cc]$/.test(all[i - 1] ?? '')) : words.slice(1);
    const args = rest.filter((w) => !w.startsWith('-'));
    if (first === 'git' && (args[0] === 'worktree' || args[0] === 'stash') && args[1]) kind = `git ${args[0]} ${args[1]}`;
    else if (RUNNERS.has(first)) kind = args[0] === 'run' && args[1] ? `${first} run ${args[1]}` : args[0] ? `${first} ${args[0]}` : first;
    else if (WITH_SUBCOMMAND.has(first) && args[0]) kind = `${first} ${args[0] === '-m' ? args[1] ?? '' : args[0]}`.trim();
    out.push(kind.slice(0, 60));
  }
  return out;
}

/**
 * A shell call that leaves its work running and returns at once (`python train.py &`, `nohup`, `setsid`, `disown`,
 * Windows' `start`, PowerShell's Start-Process / Start-Job): how long it took says nothing about its work, so its
 * duration isn't kept for the 10-second rule (code review of PR #400, round 2). `&&`, redirections (`2>&1`, `&>`) and
 * PowerShell's call operator at the start of a part (`& "x.exe"`) are not a detach.
 */
export function detaches(command: string): boolean {
  if (/(^|[\s;&|(])(nohup|setsid|disown|start-process|start-job)(\s|$)/im.test(command)) return true;
  // `start` only as the command itself (cmd's start), never as an argument (`npm start`).
  if (/(^|[;&|(]|\/[ck])\s*start(\.exe)?\s/im.test(command)) return true;
  const c = command.replace(/&&/g, ' ; ').replace(/\d*>&\d*|&>>?|>>?&/g, ' ');
  return /[^\s;|(&]\s*&(?!&)/.test(c);
}

/**
 * The kinds of command a shell call really runs, for resource limits' heavy-command check: as commandKinds, also
 * looking inside the usual wrappers (`bash -c "…"`, `sh -c`, `powershell -Command`, `cmd /c`, `nohup`, `time`, `env`,
 * `nice`, `exec`, PowerShell's `&`, a subshell's parentheses), so `nohup python train.py &` is `python train.py`.
 * Light kinds (isLightKind) are left out, so a call of only light commands has none. Still advisory (security review of
 * the resource limits, finding 13): a script file can hide anything, and what really runs is judged by the check of
 * each job's measured share.
 */
export function heavyKinds(command: string): string[] {
  let c = command;
  for (let round = 0; round < 3; round++) {
    const before = c;
    c = c
      .replace(/\b(?:ba|z)?sh(?:\.exe)?\s+(?:-\w+\s+)*-c\s+(["'])([\s\S]*?)\1/g, ' ; $2 ; ')
      .replace(/\b(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*-(?:Command|c)\s+(["'])([\s\S]*?)\1/gi, ' ; $2 ; ')
      .replace(/\bcmd(?:\.exe)?\s+\/[cCkK]\s+/g, ' ; ');
    if (c === before) break;
  }
  c = c.replace(/[()]/g, ' ; ');
  // A wrapper word at the start of a part: dropped, with what belongs to it.
  const wrapper = /(^|[;&|\n]\s*)(?:&\s+|nohup\s+|time\s+|exec\s+|nice(?:\s+-n)?\s+-?\d+\s+|nice\s+|env(?:\s+-\w+)*(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S*)*\s+)/g;
  for (let round = 0; round < 3; round++) c = c.replace(wrapper, '$1');
  return [...new Set([...commandKinds(c), ...commandKinds(command)].filter((k) => /^[\w.]/.test(k) && !/^(bash|sh|zsh|cmd|powershell|pwsh|nohup|time|env|nice|exec)$/.test(k) && !isLightKind(k)))];
}

/** Words that end or free work (`emulator-lock.mjs release`, `npm run stop`, `adb emu kill`, `gradle --stop`). */
const FREEING_WORDS = new Set(['release', 'unlock', 'stop', 'kill', 'shutdown', 'terminate', 'quit', 'down']);
/** Commands that only end processes. */
const FREEING_FIRST = new Set(['kill', 'taskkill', 'tskill', 'pkill', 'killall', 'stop-process', 'stop-job']);

/** One part of a shell command (between `&&`, `;`, `|`) frees resources: it ends processes or releases a lock. */
function freeingPart(part: string): boolean {
  const words = (part.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, '')).filter((w) => w && !/^[A-Z_][A-Z0-9_]*=/.test(w));
  while (words.length && /^(nohup|time|exec|env|sudo)$/.test(words[0]!)) words.shift();
  if (!words.length) return false;
  const first = words[0]!.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (FREEING_FIRST.has(first)) return true;
  return words.some((w, i) => {
    if (i > 0 && FREEING_WORDS.has(w.replace(/^-+/, '').toLowerCase())) return true;
    // A script's own name says it (`stop-emulator.sh`, `release_lock.py`): only a word that names a file.
    if (!/[./\\]/.test(w)) return false;
    const name = w.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '').toLowerCase();
    return name.split(/[-_.]/).some((t) => FREEING_WORDS.has(t));
  });
}

/**
 * Every heavy part of a shell call frees resources (issue #356, 2026-11-19: a session held for an emulator over its
 * share was refused `emulator-lock.mjs release`, the one command that would end the load, and deadlocked). Such a
 * call is never refused, held or not. Advisory like every refusal here: what runs is still measured and judged.
 */
export function freesResources(command: string): boolean {
  const heavyParts = command.split(/&&|\|\||;|\||\n/).filter((p) => heavyKinds(p).length > 0);
  return heavyParts.length > 0 && heavyParts.every(freeingPart);
}
