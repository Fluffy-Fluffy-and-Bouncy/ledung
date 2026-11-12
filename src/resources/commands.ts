// What kind of work a turn did, from the commands it ran (step 6c): the first words of each command,
// so turns can be grouped ("npm run build", "pytest", "cargo test"). Commands that only look around
// (cd, ls, cat, grep, …) say nothing about the cost and are left out.

const TRIVIAL = new Set([
  'cd', 'ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'echo', 'printf', 'grep', 'rg', 'find', 'sed', 'awk', 'wc', 'sort', 'uniq',
  'which', 'where', 'true', 'false', 'test', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'sleep', 'export', 'set', 'source', 'date',
  'get-content', 'get-childitem', 'select-string', 'write-host', 'write-output', 'get-date', 'set-location', 'test-path',
]);

/** Tools that take a subcommand: keep it ("git status", "docker build"); npm-like runners keep the script too. */
const WITH_SUBCOMMAND = new Set(['git', 'docker', 'cargo', 'go', 'dotnet', 'gh', 'kubectl', 'pip', 'uv', 'poetry', 'make', 'npx', 'bunx', 'node', 'python', 'python3', 'deno', 'bun']);
const RUNNERS = new Set(['npm', 'pnpm', 'yarn']);

/** The kinds of command in one shell command line, e.g. "cd app && npm run build | tee x" → ["npm run build"]. */
export function commandKinds(command: string): string[] {
  const out: string[] = [];
  for (const part of command.split(/&&|\|\||;|\||\n/)) {
    const words = (part.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
      .map((w) => w.replace(/^["']|["']$/g, ''))
      .filter((w) => w && !/^[A-Z_][A-Z0-9_]*=/.test(w));
    if (!words.length) continue;
    const first = words[0]!.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    if (TRIVIAL.has(first) || first.startsWith('$') || first.startsWith('-')) continue;
    let kind = first;
    const args = words.slice(1).filter((w) => !w.startsWith('-'));
    if (RUNNERS.has(first)) kind = args[0] === 'run' && args[1] ? `${first} run ${args[1]}` : args[0] ? `${first} ${args[0]}` : first;
    else if (WITH_SUBCOMMAND.has(first) && args[0]) kind = `${first} ${args[0] === '-m' ? args[1] ?? '' : args[0]}`.trim();
    out.push(kind.slice(0, 60));
  }
  return out;
}

/**
 * The kinds of command a shell call really runs, for resource limits' heavy-command check: as commandKinds, also
 * looking inside the usual wrappers (`bash -c "…"`, `sh -c`, `powershell -Command`, `cmd /c`, `nohup`, `time`, `env`,
 * `nice`, `exec`, PowerShell's `&`, a subshell's parentheses), so `nohup python train.py &` is `python train.py`.
 * Still advisory (security review of the resource limits, finding 13): a script file can hide anything, and what really
 * runs is judged by the check of each job's measured share.
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
  return [...new Set([...commandKinds(c), ...commandKinds(command)].filter((k) => /^[\w.]/.test(k) && !/^(bash|sh|zsh|cmd|powershell|pwsh|nohup|time|env|nice|exec)$/.test(k)))];
}
