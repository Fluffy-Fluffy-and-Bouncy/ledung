// Starting suggestions for a project's sensitive list (sensitive-always, decision of 2026-10-12).
// Not enforced from here: they are copied into a project's own list when it is created (and once into
// existing projects), where the user sees them and can delete them. What a project's list shows is
// exactly what it enforces. Used by the core and by the page ("Add suggested").
import { RUNAS_PATTERN, SUDO_PATTERN } from './elevation.ts';

export interface Suggestion {
  /** Plain words, shown in permission prompts and in the project's settings. */
  name: string;
  kind: 'command' | 'path';
  /** A regular expression (case-insensitive): matched against Bash and PowerShell commands, or against file paths. */
  pattern: string;
}

export const SUGGESTIONS: Suggestion[] = [
  // Deploys and infrastructure.
  { name: 'Kubernetes or Helm commands', kind: 'command', pattern: String.raw`\b(kubectl|helm)\b` },
  { name: 'Terraform apply, destroy or state changes', kind: 'command', pattern: String.raw`\bterraform\s+(apply|destroy|import|state\s+(rm|mv|push))\b` },
  { name: 'Pulumi up, destroy or refresh', kind: 'command', pattern: String.raw`\bpulumi\s+(up|destroy|refresh)\b` },
  // Cloud CLIs, except obviously read-only commands.
  { name: 'Cloud CLI commands (aws, az, gcloud) that are not read-only', kind: 'command', pattern: String.raw`\b(aws|az|gcloud)\b(?![^|;&]*\b(describe|list|get|show|ls|version|help)\b)` },
  // Publishing.
  { name: 'Publishing to npm', kind: 'command', pattern: String.raw`\bnpm\s+publish\b` },
  { name: 'Pushing a container image', kind: 'command', pattern: String.raw`\b(docker|podman)\s+push\b` },
  // Pushing to main/master, or force-pushing; also with git's -C and -c options before "push".
  {
    name: 'Pushing to main or master, or force-pushing',
    kind: 'command',
    pattern: String.raw`\bgit\s+(?:-[Cc]\s+\S+\s+)*push\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\bmain\b|\bmaster\b)`,
  },
  // Elevated commands (#213): they raise UAC on the PC's desktop, and run as administrator once allowed there.
  { name: 'Elevated commands with gsudo or sudo', kind: 'command', pattern: SUDO_PATTERN },
  { name: 'Starting a program as administrator (-Verb RunAs, runas)', kind: 'command', pattern: RUNAS_PATTERN },
  // Files named like secrets.
  { name: '.env files', kind: 'path', pattern: String.raw`(^|[\\/])\.env(\.[^\\/]*)?$` },
  { name: 'Files named like credentials', kind: 'path', pattern: String.raw`credentials` },
  { name: 'Key and certificate files (.pem, .key, .p12, .pfx)', kind: 'path', pattern: String.raw`\.(pem|key|p12|pfx)$` },
];

/**
 * Suggestions added after the first copy into existing projects, each batch copied in once more under its
 * own key (the first copy's key is 'sensitive-suggestions-added'). A batch's entry deleted later stays deleted.
 */
export const LATER_SUGGESTIONS: { key: string; commandPatterns: string[] }[] = [
  { key: 'sensitive-suggestions-elevation-added', commandPatterns: [SUDO_PATTERN, RUNAS_PATTERN] },
];

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
