// Project settings that loosen what reaches the user (issue #107). A change that removes a sensitive
// pattern, gives the manager a new grant, lets its project tools run unasked, lets it change projects' settings (#306) or sets a new dev ship
// command lets through what used to reach the user, so the server asks for the open page's key, like a
// sensitive decision (#104). Every other setting, and every tightening, still needs only the cookie
// (issue #107's Done bullet: "Other settings changes still work with the cookie").
import type { ProjectConfig } from '../config.ts';

const LISTS = ['commandPatterns', 'pathPatterns', 'mcpTools'] as const;

/**
 * Whether going from `before` (null: a new project, which starts with none of these) to the settings the
 * page sent loosens the sensitive gate. `after` is the request body, not yet checked: anything that is not
 * a list of patterns counts as an empty one, so a malformed body never counts as harmless.
 */
export function loosensGate(before: ProjectConfig | null, after: Record<string, unknown>): boolean {
  const had = before?.sensitive;
  const sent = record(after.sensitive);
  if (had && LISTS.some((l) => {
    const now = strings(sent[l]);
    return had[l].some((p) => !now.includes(p));
  })) return true;
  if (after.projectToolsUnasked === true && before?.projectToolsUnasked !== true) return true;
  // A manager that may change projects' settings could change its own sensitive list (issue #306).
  if (after.projectSettingsTools === true && before?.projectSettingsTools !== true) return true;
  // Free text and a pattern: a changed one may say more than the old, so any new one counts.
  return newText(after.managerGrant, before?.managerGrant) || newText(after.devShipCommand, before?.devShipCommand);
}

function newText(sent: unknown, had: string | undefined): boolean {
  return typeof sent === 'string' && sent !== '' && sent !== had;
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function strings(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
