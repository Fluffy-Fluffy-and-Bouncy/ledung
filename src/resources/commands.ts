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
