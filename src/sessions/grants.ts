// Grants: "allow this for the rest of the session" (step 4, issue #10), in Claude Code's own rule form
// ({ toolName, ruleContent }), so the same rule both goes to Claude Code (repeats don't prompt) and is
// checked by Ledung (grants carried down from a manager to the sessions it starts, want 13).
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

export interface GrantRule {
  toolName: string;
  /** Claude Code's rule content: for Bash a command or "prefix:*", for file tools a path or glob. */
  ruleContent?: string;
}

export function describeRule(rule: GrantRule): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
}

/** The allow rules Claude Code suggested for "don't ask again", if any. */
export function rulesFromSuggestions(suggestions: PermissionUpdate[] | undefined): GrantRule[] {
  return (suggestions ?? [])
    .filter((s): s is Extract<PermissionUpdate, { type: 'addRules' }> => s.type === 'addRules' && s.behavior === 'allow')
    .flatMap((s) => s.rules.map((r) => ({ toolName: r.toolName, ruleContent: r.ruleContent })));
}

/** A rule for exactly this request, when Claude Code suggested none. */
export function exactRule(toolName: string, input: Record<string, unknown>): GrantRule {
  if (toolName === 'Bash' && typeof input.command === 'string') return { toolName, ruleContent: input.command.trim() };
  const file = ['file_path', 'path', 'notebook_path'].map((k) => input[k]).find((v) => typeof v === 'string') as string | undefined;
  return file ? { toolName, ruleContent: file } : { toolName };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/\\/g, '/').replace(/[.+^${}()|[\]]/g, '\\$&');
  const pattern = escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`(^|/)${pattern.replace(/^\/+/, '')}$`, 'i');
}

/** Whether a rule covers a request. Mirrors Claude Code's rule forms closely enough for Ledung's own checks. */
export function ruleMatches(rule: GrantRule, toolName: string, input: Record<string, unknown>): boolean {
  if (rule.toolName !== toolName) return false;
  if (rule.ruleContent === undefined || rule.ruleContent === '') return true;
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    // A prefix rule must not cover a second command chained onto the allowed one.
    if (/[;&|`]|\$\(/.test(command)) return command === rule.ruleContent;
    // "npm test:*" (prefix) and "npm run *" (wildcards); otherwise the exact command.
    if (rule.ruleContent.endsWith(':*')) return command.startsWith(rule.ruleContent.slice(0, -2));
    if (rule.ruleContent.includes('*')) {
      const pattern = rule.ruleContent.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      return new RegExp(`^${pattern}$`).test(command);
    }
    return command === rule.ruleContent;
  }
  const file = ['file_path', 'path', 'notebook_path'].map((k) => input[k]).find((v) => typeof v === 'string') as string | undefined;
  if (!file) return false;
  return globToRegExp(rule.ruleContent).test(file.replace(/\\/g, '/'));
}

/** As Claude Code session rules, for "allow for this session". */
export function asSessionUpdate(rules: GrantRule[]): PermissionUpdate[] {
  return rules.length ? [{ type: 'addRules', rules, behavior: 'allow', destination: 'session' }] : [];
}

/**
 * Who allowed a call, by its tool use id, until the note after the call picks it up (issue #18): a
 * session can't tell a person's Allow from its own permission mode, and once told a merge "ran without
 * a prompt" (2026-10-12). A call with no note was allowed by the session's own mode or settings.
 */
export class AllowedNotes {
  private readonly notes = new Map<string, string>();

  /** Allowed in Ledung by `who`: the user's name, or `your manager "<title>"`. */
  decided(toolUseID: string | undefined, who: string, scope: 'once' | 'session' | null, sensitive: boolean, userName: string): void {
    if (!toolUseID) return;
    const what = scope === 'session' ? 'for the rest of this session' : 'once';
    this.notes.set(toolUseID, `${who} allowed this call in Ledung, ${what}${sensitive ? `; it is on the sensitive list, so only ${userName} could allow it` : ''}.`);
  }

  /** Allowed without asking, by a standing grant from `who`: the user's name, or `manager "<title>"`. */
  granted(toolUseID: string | undefined, who: string, rule: string): void {
    if (toolUseID) this.notes.set(toolUseID, `Ledung allowed this call under a standing grant from ${who} (${rule}); nobody was asked.`);
  }

  /** Allowed without asking by away mode (issue #35); `reason` names the floors that passed. */
  away(toolUseID: string | undefined, reason: string): void {
    if (toolUseID) this.notes.set(toolUseID, `${reason}. Nobody was asked; this is not anyone's approval, and it is recorded for away_log.`);
  }

  /** A merge allowed without a second prompt because the user already said yes to it (`why` says where). */
  answered(toolUseID: string | undefined, why: string): void {
    if (toolUseID) this.notes.set(toolUseID, `Ledung allowed this merge without asking again: ${why}.`);
  }

  /** A Settings action the user's own words named (issue #263); `why` says which words. */
  named(toolUseID: string | undefined, why: string): void {
    if (toolUseID) this.notes.set(toolUseID, `Ledung allowed this call without asking: ${why}.`);
  }

  /** The note for a finished call, once; undefined when nobody in Ledung allowed it. */
  take(toolUseID: string | undefined): string | undefined {
    if (!toolUseID) return undefined;
    const note = this.notes.get(toolUseID);
    this.notes.delete(toolUseID);
    return note;
  }
}
