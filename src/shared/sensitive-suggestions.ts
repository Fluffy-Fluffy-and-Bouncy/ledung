// Starting suggestions for a project's sensitive list (sensitive-always, decision of 2026-10-12).
// Not enforced from here: they are copied into a project's own list when it is created (and once into
// existing projects), where the user sees them and can delete them. What a project's list shows is
// exactly what it enforces. Used by the core and by the page ("Add suggested").
import { RUNAS_PATTERN, SUDO_PATTERN } from './elevation.ts';

/** How a file path entry meets shell commands, shown with the list (#278; Martin, 2026-11-12, Ledung question #838). */
export const FILE_PATH_RULE = 'A file path is also matched against each word of a shell command, except a word that reads as code: it starts with a letter, has no slash or colon, and has a dot inside it (process.env, import.meta.env): so a bare file name such as config.prod.env or server.key in a command is not matched, while .env, ./server.key and config/.env are.';

export interface Suggestion {
  /** Plain words, shown in permission prompts and in the project's settings. */
  name: string;
  kind: 'command' | 'path';
  /** A regular expression (case-insensitive): matched against Bash and PowerShell commands, or against file paths. */
  pattern: string;
}

/**
 * Merging a pull request with GitHub's CLI (issue #208; Martin, 2026-11-10): `gh pr merge`, as a program or a path
 * to one (`gh.exe`), also with `pr`'s own -R/--repo standing before `merge`. Only the merge itself: `gh pr view`,
 * `gh pr checks` and a `--search "merge"` are not it. Away mode and a merge the person's answer named
 * (src/sessions/away.ts, mergeAnswered) still let their merges through; they act on calls this holds.
 */
export const MERGE_NAME = 'Merging a pull request';
export const MERGE_PATTERN = String.raw`(?<![\w.-])gh(?:\.exe)?\s+pr\s+(?:(?:-R|--repo)(?:\s+|=)\S+\s+)?merge(?![\w-])`;

/**
 * Publishing to npm (Project-Ledung#473): `npm publish`, also with npm's options before the word (`npm --tag dev
 * publish`). `npm run publish:dev` is a script, not this.
 */
// Every word below can be read one way only (an option starts with "-" or "--" and a letter, a value or a remote
// never with "-"): these patterns run on every command a session sends, so an option list must not make them
// try every way of splitting it (self-check of Project-Ledung#473: seconds for 16 options before).
/** An option: `-x`, `--name`, `--name=value`. */
const OPTION = String.raw`--?\w[\w-]*(?:=\S+)?`;
export const PUBLISH_PATTERN = String.raw`\bnpm(?:\s+${OPTION}(?:\s[^\s-]\S*)?)*\s+publish\b`;
/** Options git takes before its command: `-C dir`, `-c key=value`, `--git-dir x`, `--no-pager` and the like. */
const GIT_OPTIONS = String.raw`(?:\s+(?:-[Cc]\s+[^\s-]\S*|--(?:git-dir|work-tree|namespace|exec-path|config-env)\s+[^\s-]\S*|${OPTION}))*`;
/** Push options that take their value as the next word (`-o ci.skip`, `--repo origin`), so it is not read as the remote. */
const PUSH_VALUED = String.raw`(?:-o|--push-option|--repo|--receive-pack|--exec)\s+[^\s-]\S*`;
/** Push options, with their values; a valued one is read only with its value, keeping one way of reading each word. */
const PUSH_OPTIONS = String.raw`(?:\s+(?:${PUSH_VALUED}|(?!${PUSH_VALUED})${OPTION}))*`;
/** Output and input redirection, with or without a space before its target (`2>&1`, `> /dev/null`, `&> log`). */
const REDIRECTS = String.raw`(?:\s+\d*(?:>>?|<|&>>?)(?:&[\d-]|\s*[^\s|;&<>]+))*`;
/**
 * Pushing to main or master, or force-pushing (Project-Ledung#473): with git's own options before `push`; a force
 * as `--force…`, a short `-f` among others (`-uf`) or a `+` refspec; and a push that names no branch (`git push`,
 * `git push origin`, `git push -u origin HEAD`), which pushes the current one, main included. A push of a named
 * branch other than main or master (`git push -u origin feature`) is not it.
 */
export const PUSH_PATTERN = String.raw`\bgit${GIT_OPTIONS}\s+push\b(?:[^|;&]*(?:\s--force\b|\s-[A-Za-z]*f[A-Za-z]*\b|\s\+\S|\bmain\b|\bmaster\b)|${PUSH_OPTIONS}(?:\s+[^\s|;&<>-]\S*${PUSH_OPTIONS}(?:\s+(?:HEAD|@)${PUSH_OPTIONS})?)?${REDIRECTS}\s*(?:$|[|;&)]))`;

/** The suggested patterns before Project-Ledung#473, replaced by the ones above in lists that still have them. */
const OLD_PUBLISH_PATTERN = String.raw`\bnpm\s+publish\b`;
const OLD_PUSH_PATTERN = String.raw`\bgit\s+(?:-[Cc]\s+\S+\s+)*push\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\bmain\b|\bmaster\b)`;

export const SUGGESTIONS: Suggestion[] = [
  // Deploys and infrastructure.
  { name: 'Kubernetes or Helm commands', kind: 'command', pattern: String.raw`\b(kubectl|helm)\b` },
  { name: 'Terraform apply, destroy or state changes', kind: 'command', pattern: String.raw`\bterraform\s+(apply|destroy|import|state\s+(rm|mv|push))\b` },
  { name: 'Pulumi up, destroy or refresh', kind: 'command', pattern: String.raw`\bpulumi\s+(up|destroy|refresh)\b` },
  // Cloud CLIs, except obviously read-only commands.
  { name: 'Cloud CLI commands (aws, az, gcloud) that are not read-only', kind: 'command', pattern: String.raw`\b(aws|az|gcloud)\b(?![^|;&]*\b(describe|list|get|show|ls|version|help)\b)` },
  // Publishing.
  { name: 'Publishing to npm', kind: 'command', pattern: PUBLISH_PATTERN },
  { name: 'Pushing a container image', kind: 'command', pattern: String.raw`\b(docker|podman)\s+push\b` },
  // Pushing to main/master (also a push naming no branch), or force-pushing; also with git's options before "push".
  { name: 'Pushing to main or master, or force-pushing', kind: 'command', pattern: PUSH_PATTERN },
  // Merging a pull request (#208): the person's to decide wherever a project has not said otherwise.
  { name: MERGE_NAME, kind: 'command', pattern: MERGE_PATTERN },
  // Elevated commands (#213): they raise UAC on the PC's desktop, and run as administrator once allowed there.
  { name: 'Elevated commands with gsudo or sudo', kind: 'command', pattern: SUDO_PATTERN },
  { name: 'Starting a program as administrator (-Verb RunAs, runas)', kind: 'command', pattern: RUNAS_PATTERN },
  // Files named like secrets.
  { name: '.env files', kind: 'path', pattern: String.raw`(^|[\\/])\.env(\.[^\\/]*)?$` },
  { name: 'Files named like credentials', kind: 'path', pattern: String.raw`credentials` },
  { name: 'Key and certificate files (.pem, .key, .p12, .pfx)', kind: 'path', pattern: String.raw`\.(pem|key|p12|pfx)$` },
];

export interface LaterSuggestions {
  key: string;
  /** Patterns added at the end of a list that lacks them. */
  commandPatterns: string[];
  /** Old suggested patterns and what replaces each, in place; a list without the old one (deleted or edited) is left as it is. */
  replaces?: Record<string, string>;
}

/**
 * Suggestions added or changed after the first copy into existing projects, each batch applied once more under
 * its own key (the first copy's key is 'sensitive-suggestions-added'). A batch's entry deleted later stays deleted.
 */
export const LATER_SUGGESTIONS: LaterSuggestions[] = [
  { key: 'sensitive-suggestions-elevation-added', commandPatterns: [SUDO_PATTERN, RUNAS_PATTERN] },
  // Merges reach projects made before #208 too, once. Taking this one line out leaves them as they are.
  { key: 'sensitive-suggestions-merge-added', commandPatterns: [MERGE_PATTERN] },
  // The wider push and publish patterns (Project-Ledung#473) replace the old ones where a list still has them unchanged.
  { key: 'sensitive-suggestions-push-publish-widened', commandPatterns: [], replaces: { [OLD_PUSH_PATTERN]: PUSH_PATTERN, [OLD_PUBLISH_PATTERN]: PUBLISH_PATTERN } },
];

/** A list's command patterns with a later batch applied: old ones replaced in place, missing ones added at the end. */
export function withLaterBatch(commandPatterns: string[], batch: LaterSuggestions): string[] {
  const replaced: string[] = [];
  for (const p of commandPatterns) {
    // Own keys only: a user's pattern may be any text, "constructor" included.
    const by = batch.replaces && Object.hasOwn(batch.replaces, p) ? batch.replaces[p] : undefined;
    if (by === undefined) replaced.push(p);
    else if (!commandPatterns.includes(by) && !replaced.includes(by)) replaced.push(by);
  }
  return [...replaced, ...batch.commandPatterns.filter((p) => !replaced.includes(p))];
}

/** The plain-words name of a suggested pattern, if this is exactly one. */
export function suggestionName(pattern: string, kind: Suggestion['kind']): string | undefined {
  return SUGGESTIONS.find((s) => s.kind === kind && s.pattern === pattern)?.name;
}

/** The suggestions a list does not contain (compared by pattern), for "Add suggested". */
export function missingSuggestions(commandPatterns: string[], pathPatterns: string[]): Suggestion[] {
  return SUGGESTIONS.filter((s) => !(s.kind === 'command' ? commandPatterns : pathPatterns).includes(s.pattern));
}

/** A list with the missing suggestions added at the end; what was there stays as it is. */
export function withSuggestions<T extends { commandPatterns: string[]; pathPatterns: string[] }>(lists: T): T {
  const missing = missingSuggestions(lists.commandPatterns, lists.pathPatterns);
  return {
    ...lists,
    commandPatterns: [...lists.commandPatterns, ...missing.filter((s) => s.kind === 'command').map((s) => s.pattern)],
    pathPatterns: [...lists.pathPatterns, ...missing.filter((s) => s.kind === 'path').map((s) => s.pattern)],
  };
}
