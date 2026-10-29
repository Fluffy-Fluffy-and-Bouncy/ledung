// Which permission requests are sensitive: they always go to the user, whoever started the session,
// and no manager or grant can allow them (brief section 5; step 4, decision 2 of 2026-10-10).
// Decided by fixed patterns, never by anyone's judgement. There is no hidden built-in list (decision
// of 2026-10-12): the patterns are the config's global ones plus the project's own list, which starts
// out with the suggestions in src/shared/sensitive-suggestions.ts and which the user can edit.
import { suggestionName } from '../shared/sensitive-suggestions.ts';
import { HOLDS_BACK, SETTINGS_RULE, settingsAction } from './word.ts';

export interface SensitiveRules {
  /** Regular expressions (case-insensitive) matched against Bash and PowerShell commands. */
  commandPatterns: string[];
  /** Regular expressions (case-insensitive) matched against file paths of file tools. */
  pathPatterns: string[];
  /** MCP tool names (exact, e.g. mcp__db__query), or a server prefix ending in "__" (e.g. mcp__prod__). */
  mcpTools: string[];
}

export interface SensitiveMatch {
  /** Which rule matched, in plain words where the pattern is a suggested one; for the record and the page. */
  rule: string;
}

function filePaths(input: Record<string, unknown>): string[] {
  return ['file_path', 'path', 'notebook_path'].map((k) => input[k]).filter((v): v is string => typeof v === 'string');
}

/** The rule named for a call that is always the user's to approve, whatever the lists say. */
export const ALWAYS_ASKED_RULE = "a manager's project tool, always yours to approve";

/**
 * The first sensitive rule a request matches in the given rules (global patterns plus the project's).
 * alwaysAsked: full tool names that are sensitive whatever the editable lists say (the managers'
 * project tools, decision of 2026-10-13, issue #37).
 */
export function matchSensitive(
  toolName: string,
  input: Record<string, unknown>,
  rules: Partial<SensitiveRules> = {},
  alwaysAsked: readonly string[] = [],
): SensitiveMatch | null {
  if (alwaysAsked.includes(toolName)) return { rule: settingsAction(toolName) ? SETTINGS_RULE : ALWAYS_ASKED_RULE };
  if ((toolName === 'Bash' || toolName === 'PowerShell') && typeof input.command === 'string') {
    // PowerShell quotes and escapes differently from a POSIX shell, so its commands are matched whole, line
    // by line: more asked than needed rather than a gap (#213: `Start-Process … -Verb RunAs` comes this way).
    const lines = toolName === 'Bash' ? runnableLines(input.command) : input.command.split(/\r?\n/);
    for (const p of rules.commandPatterns ?? []) {
      const re = new RegExp(p, 'i');
      if (lines.some((l) => re.test(l))) return { rule: suggestionName(p, 'command') ?? `command matches /${p}/` };
    }
  }
  for (const file of filePaths(input)) {
    for (const p of rules.pathPatterns ?? []) {
      if (new RegExp(p, 'i').test(file)) return { rule: suggestionName(p, 'path') ?? `path matches /${p}/` };
    }
  }
  if (toolName.startsWith('mcp__')) {
    for (const t of rules.mcpTools ?? []) if (t.endsWith('__') ? toolName.startsWith(t) : toolName === t) return { rule: `MCP tool ${t}` };
  }
  return null;
}

/**
 * How a permission prompt goes (step 4): a sensitive call to the user; otherwise a grant may allow it,
 * or it is asked. Sensitive is checked first, so no grant ever lifts it.
 */
export function routePermission<G>(
  toolName: string,
  input: Record<string, unknown>,
  rules: Partial<SensitiveRules>,
  alwaysAsked: readonly string[],
  grantFor: () => G | null | undefined,
): { sensitive: SensitiveMatch } | { grant: G } | { ask: true } {
  const sensitive = matchSensitive(toolName, input, rules, alwaysAsked);
  if (sensitive) return { sensitive };
  const grant = grantFor();
  return grant ? { grant } : { ask: true };
}

/**
 * What the PreToolUse hook answers for a tool call: "ask" for a sensitive one, so Claude Code hands it to
 * Ledung's permission flow in every mode, whatever rules or classifier would have allowed it
 * (sensitive-always). A check that fails asks too: a gap must not be silent.
 */
export function sensitiveHookOutput(
  toolName: string,
  input: Record<string, unknown>,
  rules: Partial<SensitiveRules>,
  alwaysAsked: readonly string[] = [],
): Record<string, unknown> {
  let reason: string;
  try {
    const match = matchSensitive(toolName, input, rules, alwaysAsked);
    if (!match) return {};
    reason = `Sensitive: ${match.rule}`;
  } catch (e) {
    reason = `Ledung could not check this request (${(e as Error).message}), so it asks.`;
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } };
}

// --- What a command runs (decided 2026-10-13) ---------------------------------------------------------
// The patterns used to be matched against the whole command text, so a review or issue body written with
// `cat > f <<'EOF'`, an `echo "…"` or a `--body '…'` that only mentioned `git push … main`, `gh pr merge`
// or `tools/ship.py` stopped the session for the user: 28 of 40 prompts on 2026-10-13. Now they are
// matched against what runs: heredoc bodies, quoted text and comments are left out, except where they
// are run themselves (a shell reading a heredoc, `bash -c "…"`, `ssh host "…"`, `eval`, `$(…)`).
// Each line is matched on its own. A command that can't be read is matched whole, as before.

/** Shells: a heredoc they read is commands, and so is a quoted argument after RUN_OPTION. */
const SHELL = /^(?:.*[\\/])?(?:bash|sh|zsh|dash|ksh|fish|pwsh|powershell|cmd|ssh)(?:\.exe)?$/i;
/** Interpreters: what they read is code, which runs a command only through a call that starts a program. */
const SCRIPT = /^(?:.*[\\/])?(?:python[\d.]*|py|node|bun|deno|perl|ruby)(?:\.exe)?$/i;
/**
 * Calls by which a script starts a program (or runs code it builds). A script without any of them, as most
 * note and file edits are, names commands only in its strings and can't run one, so its text is only text
 * (2026-10-13 22:47: a python edit of lead notes that mentioned gh pr merge was asked). With one, the whole
 * script is matched.
 */
const STARTS_PROGRAMS = /\b(?:subprocess|os\.(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*)|pty\.spawn|Popen|child_process|exec(?:File)?Sync|spawn(?:Sync)?\s*\(|exec(?:File)?\s*\(|Bun\.(?:spawn|\$)|Deno\.(?:run|Command)|system\s*\(|IPC::|open3|shell_exec|ctypes|__import__|importlib|eval\s*\()|\bqx\s*[({/]|%x[({]/;
/** Options after which a quoted argument is run, not read: `bash -c`, `pwsh -Command`, `cmd /c`, `python -c`, `node -e`. */
const RUN_OPTION = /^(?:-[a-z]*c|-command|--command|\/c|-e|--eval)$/i;
/** Programs whose quoted arguments are commands: `ssh host "…"`, `eval "…"`, `watch "…"`, `xargs sh -c '…'`. */
const RUNS_ARGUMENTS = /^(?:.*[\\/])?(?:ssh|eval|watch|xargs)(?:\.exe)?$/i;

/**
 * The lines of a command that run, with text that is only read (heredoc bodies, quoted strings, comments)
 * blanked out. On anything it can't follow (an unclosed quote or heredoc) it gives back the whole command.
 */
export function runnableLines(command: string): string[] {
  try {
    return blankUnrun(command).replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  } catch {
    return command.split(/\r?\n/);
  }
}

function blankUnrun(src: string): string {
  let out = '';
  let i = 0;
  // Words of the current simple command so far, to tell whether a quote or heredoc is run.
  let words: string[] = [];
  let word = '';
  const pendingHeredocs: { tag: string; strip: boolean; runs: 'shell' | 'script' | false }[] = [];
  const endWord = () => { if (word) { words.push(word); word = ''; } };
  // The program of the current simple command, past `VAR=value` assignments and `sudo`/`env`/`time`/`nohup`.
  const program = () => words.find((x) => !/^\w+=/.test(x) && !/^(?:sudo|env|time|nohup|exec|command)$/i.test(x)) ?? '';
  // A heredoc is run when a shell or interpreter reads it (`bash <<EOF`, `python - <<EOF`, `ssh host <<EOF`).
  const heredocRuns = (): 'shell' | 'script' | false => (SHELL.test(program()) ? 'shell' : SCRIPT.test(program()) ? 'script' : false);
  // A quoted argument is run after `-c`/`-e`/`-Command` of a shell, or of an interpreter when its code starts a
  // program; anywhere for ssh/eval/watch/xargs.
  const quoteRuns = (body: string) => RUNS_ARGUMENTS.test(program())
    || (RUN_OPTION.test(words[words.length - 1] ?? '') && (SHELL.test(program()) || (SCRIPT.test(program()) && STARTS_PROGRAMS.test(body))));
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') {
      endWord();
      out += c;
      i++;
      // Heredoc bodies start on the next line.
      for (const h of pendingHeredocs.splice(0)) {
        // The body up to its closing tag; a script's body is commands only if it starts a program.
        const body: string[] = [];
        let closing: string | null = null;
        while (closing === null) {
          if (i >= src.length) throw new Error('unclosed heredoc');
          const nl = src.indexOf('\n', i);
          const line = src.slice(i, nl < 0 ? src.length : nl);
          i = nl < 0 ? src.length : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line).replace(/\r$/, '') === h.tag) closing = line;
          else body.push(line);
          if (nl < 0 && closing === null) throw new Error('unclosed heredoc');
        }
        const runs = h.runs === 'shell' || (h.runs === 'script' && STARTS_PROGRAMS.test(body.join('\n')));
        for (const line of body) out += (runs ? line : ' '.repeat(line.length)) + '\n';
        out += closing + (src[i - 1] === '\n' ? '\n' : '');
      }
      words = [];
      continue;
    }
    if (c === '\\' && i + 1 < src.length) { out += src.slice(i, i + 2); word += src[i + 1]; i += 2; continue; }
    if (c === '#' && !word && (i === 0 || /\s/.test(src[i - 1]!))) {
      // A comment, to the end of the line.
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      endWord();
      const m = /^<<(-)?\s*(['"]?)([A-Za-z_][\w.-]*)\2/.exec(src.slice(i));
      if (m) {
        pendingHeredocs.push({ tag: m[3]!, strip: !!m[1], runs: heredocRuns() });
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      const end = c === "'" ? src.indexOf("'", i + 1) : closingDouble(src, i + 1);
      if (end < 0) throw new Error('unclosed quote');
      const body = src.slice(i + 1, end);
      out += c + (quoteRuns(body) ? body : c === '"' ? keepSubstitutions(body) : ' '.repeat(body.length)) + c;
      word += 'Q';
      i = end + 1;
      continue;
    }
    if (/\s/.test(c)) { endWord(); out += c; i++; continue; }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')') { endWord(); words = []; out += c; i++; continue; }
    out += c;
    word += c;
    i++;
  }
  if (pendingHeredocs.length) throw new Error('unclosed heredoc');
  return out;
}

/** The index of the `"` that closes a double-quoted string starting at `from`, -1 if none. */
function closingDouble(src: string, from: number): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '"') return i;
  }
  return -1;
}

/** Inside double quotes only `$(…)` and backticks run: keep those, blank the rest. */
function keepSubstitutions(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '$' && body[i + 1] === '(') {
      let depth = 0;
      let j = i;
      for (; j < body.length; j++) {
        if (body[j] === '(') depth++;
        else if (body[j] === ')' && --depth === 0) break;
      }
      out += body.slice(i, j + 1);
      i = j;
    } else if (body[i] === '`') {
      const j = body.indexOf('`', i + 1);
      const end = j < 0 ? body.length - 1 : j;
      out += body.slice(i, end + 1);
      i = end;
    } else {
      out += body[i] === '\n' ? '\n' : ' ';
    }
  }
  return out;
}

// --- A merge Martin already said yes to (decided 2026-10-13) ------------------------------------------
// agent-manager's gate let a merge through when the owner had said "merge #N" in the lead pane; Ledung
// asked twice, once as the manager's question and again as the merge's prompt (6 of 40 on 2026-10-13).

/** An answer that says yes to a merge: it says merge, and nothing that holds it back. */
const SAYS_MERGE = /\bmerge/i;

/**
 * The question whose answer from the user lets this command merge, if any: the command merges exactly one
 * PR (`gh pr merge N`) and runs nothing else that is sensitive, and the user answered one of the manager's
 * questions about #N with a yes to merging it. Null when anything is unclear: then it is asked as before.
 */
export function mergeAnswered(
  command: string,
  rules: Partial<SensitiveRules>,
  questions: { id: number; question: string; answer: string | null; answeredBy: string | null; typed?: boolean }[],
): { pr: number; questionId: number } | null {
  const segments = runnableLines(command).flatMap((l) => l.split(/&&|\|\||;|\|/)).map((s) => s.trim()).filter(Boolean);
  const merges = segments.map((s) => /^gh\s+pr\s+merge\s+(\d+)(?:\s+(?:-R|--repo)\s+\S+|\s+--(?:merge|squash|rebase|delete-branch)|\s+-[msrd])*$/i.exec(s));
  const hits = merges.filter((m): m is RegExpExecArray => !!m);
  if (hits.length !== 1) return null;
  // Everything else in the command must be harmless on its own (a second merge, a push, a ship: asked).
  for (const [k, s] of segments.entries()) {
    if (!merges[k] && (matchSensitive('Bash', { command: s }, rules) || /\bgh\s+(?:pr\s+merge|api\b.*\/merge)\b/i.test(s))) return null;
  }
  const pr = Number(hits[0]![1]);
  const names = new RegExp(`(?:#|PR\\s+|pull/)${pr}\\b`, 'i');
  // Typed text (no question around it) counts only where "merge" and the PR stand together, in one line:
  // "merge #45", "#45: merge it", "Q54, merge" does not name a PR and so doesn't count.
  const together = new RegExp(`\\bmerge\\b[^.\\n]{0,40}(?:#|PR\\s+)${pr}\\b|(?:#|PR\\s+)${pr}\\b[^.\\n]{0,40}\\bmerge`, 'i');
  const q = questions.find((x) => x.answeredBy === 'user' && x.answer !== null
    && (x.typed ? x.answer.split('\n').some((line) => together.test(line) && !HOLDS_BACK.test(line))
      : names.test(x.question) && SAYS_MERGE.test(x.answer) && !HOLDS_BACK.test(x.answer.replace(/\(recommended\)/i, ''))));
  return q ? { pr, questionId: q.id } : null;
}

/** Checks that the project's patterns are valid regular expressions; throws a readable error if not. */
export function validateSensitive(project: Partial<SensitiveRules>): void {
  for (const p of [...(project.commandPatterns ?? []), ...(project.pathPatterns ?? [])]) {
    try {
      new RegExp(p, 'i');
    } catch (e) {
      throw new Error(`The sensitive pattern /${p}/ is not a valid regular expression: ${(e as Error).message}`);
    }
  }
}
