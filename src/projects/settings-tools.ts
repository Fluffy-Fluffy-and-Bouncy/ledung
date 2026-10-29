// Managers' project_settings and set_project_settings (issue #306): a project's workflow settings as a manager
// reads and changes them, whether its usage is published under its name (issue #376) and to which repo (#380). Only these fields, never lockdown, the toggles, mode, account, folders, profiles or
// skills. Martin's answer to question #687 (2026-10-23, option a): reads are free under the project's toggle; a
// change that loosens what reaches the user (gate.ts, issue #107) is always the user's to approve in Ledung; any
// other change runs unasked.
import path from 'node:path';
import { z } from 'zod';
import type { ProjectConfig, WorkflowConfig } from '../config.ts';
import { tiersOf } from '../shared/questions.ts';
import { chosenWorkflow } from '../sessions/workflow.ts';
import { loosensGate } from './gate.ts';
import { within } from './lockdown.ts';

const list = z.array(z.string());

/** set_project_settings' input: the project, and only the fields to change; null clears one, a list is replaced whole. */
export const SETTINGS_PATCH = {
  project: z.string().min(1).describe('The project name, as list_projects shows it; your own project too.'),
  managerGrant: z.string().nullable().optional().describe('What its manager may decide on its own; null clears it.'),
  workflow: z.object({
    use: z.boolean().optional(),
    name: z.string().min(1).optional(),
    projectConfig: z.string().min(1).optional(),
  }).strict().nullable().optional().describe('Replaces the whole workflow block: use (follows one or not), name (one of the configured workflows), projectConfig (its config file, relative to the project folder); null: the default for its kind.'),
  questionTiers: z.array(z.string().min(1).max(80)).nullable().optional().describe('Its question tiers in order; null or empty: the five standard ones.'),
  sensitive: z.object({ commandPatterns: list.optional(), pathPatterns: list.optional(), mcpTools: list.optional() }).strict().optional()
    .describe('Each list given replaces that list; one left out stays.'),
  devShipCommand: z.string().nullable().optional().describe('Its dev ship command, a regular expression; null clears it.'),
  tickets: z.object({ pattern: z.string().min(1), url: z.string().min(1) }).strict().nullable().optional().describe('Ticket ids shown as links; null clears it.'),
  publishUsageName: z.boolean().optional().describe("Its usage is published to the shared usage repo under its name (true) or as other# and a hash (false); see usage_publish."),
  usageRepo: z.string().nullable().optional().describe("The usage repository its usage is published to, as owner/name, instead of this computer's default one (usage_publish); null clears it, back to the default."),
};
const Patch = z.object(SETTINGS_PATCH).strict();
export type SettingsPatch = z.infer<typeof Patch>;

/** The fields a patch may name, for the refusal of any other. */
export const SETTINGS_FIELDS = Object.keys(SETTINGS_PATCH).filter((k) => k !== 'project');

/** A tool call's raw input as a patch, or why not. Unknown fields are refused, not dropped, so nothing changes unseen. */
export function parsePatch(raw: unknown): { patch: SettingsPatch } | { problem: string; unknown: boolean } {
  const r = Patch.safeParse(raw);
  if (r.success) return { patch: r.data };
  const unknown = r.error.issues.some((i) => i.code === 'unrecognized_keys');
  return { problem: r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '), unknown };
}

/** The same patch, the same text, whatever order its keys came in: what the hook judged is what the tool runs. */
export function patchKey(managerId: string, patch: SettingsPatch): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
  return `${managerId}\n${JSON.stringify(stable(patch))}`;
}

/** The project's settings with the patch applied, not yet checked (parseProject and updateProject do). */
export function applyPatch(config: ProjectConfig, patch: SettingsPatch): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  const put = (key: string, v: unknown, empty: boolean) => {
    if (v === undefined) return;
    if (v === null || empty) delete next[key];
    else next[key] = v;
  };
  put('managerGrant', patch.managerGrant, patch.managerGrant === '');
  put('workflow', patch.workflow, false);
  put('questionTiers', patch.questionTiers, patch.questionTiers?.length === 0);
  put('devShipCommand', patch.devShipCommand, patch.devShipCommand === '');
  put('tickets', patch.tickets, false);
  // Off is the default, so it is stored as nothing (issue #376).
  put('publishUsageName', patch.publishUsageName, patch.publishUsageName === false);
  put('usageRepo', typeof patch.usageRepo === 'string' ? patch.usageRepo.trim() : patch.usageRepo, patch.usageRepo?.trim() === '');
  if (patch.sensitive) {
    next.sensitive = {
      ...config.sensitive,
      ...Object.fromEntries(Object.entries(patch.sensitive).filter(([, v]) => v !== undefined)),
    };
  }
  return next;
}

const quoted = (v: string | undefined) => (v ? JSON.stringify(v) : 'none');
const repoText = (repo: string | undefined) => (repo ? `the repository ${JSON.stringify(repo)}` : "this computer's default usage repository");
const LISTS = [['commandPatterns', 'command pattern'], ['pathPatterns', 'path pattern'], ['mcpTools', 'MCP tool']] as const;

/**
 * What in going from `before` to `after` loosens what reaches the user, with before and after for the prompt; empty:
 * nothing. The rule is the page's (loosensGate, issue #107): a new grant, its own included, a new dev ship command, a
 * sensitive pattern removed. Anything that rule counts and these lines miss still counts, so nothing loosens unasked.
 */
export function looseningChanges(before: ProjectConfig, after: ProjectConfig): string[] {
  const out: string[] = [];
  if (after.managerGrant && after.managerGrant !== before.managerGrant) out.push(`manager grant ${quoted(before.managerGrant)} → ${quoted(after.managerGrant)}`);
  if (after.devShipCommand && after.devShipCommand !== before.devShipCommand) out.push(`dev ship command ${quoted(before.devShipCommand)} → ${quoted(after.devShipCommand)}`);
  for (const [key, label] of LISTS) {
    const gone = before.sensitive[key].filter((p) => !after.sensitive[key].includes(p));
    if (gone.length) out.push(`sensitive ${label}${gone.length > 1 ? 's' : ''} removed: ${gone.map((p) => quoted(p)).join(', ')}`);
  }
  // Its name then reaches whoever reads the shared usage repo (issue #376).
  if (after.publishUsageName === true && before.publishUsageName !== true) out.push(`usage published under its name ${quoted(after.name)} instead of as other# and a hash`);
  // Either way its usage then reaches the readers of another repo (issue #380): back to the default one too.
  if ((after.usageRepo ?? null) !== (before.usageRepo ?? null)) out.push(`usage published to ${repoText(after.usageRepo)} instead of ${repoText(before.usageRepo)}`);
  if (!out.length && loosensGate(before, after as unknown as Record<string, unknown>)) out.push('a change that loosens what reaches you');
  return out;
}

/** The prompt's text for what a change loosens: built one way, so what the user saw can be compared when it runs. */
export function looseningRule(project: string, changes: string[]): string | null {
  return changes.length ? `a change to "${project}" that loosens what reaches you: ${changes.join('; ')}` : null;
}

/**
 * Why a manager can't give the project this workflow config path, or null (review of #306, M1): its manager is told
 * to follow that file, so one outside the project's folder (absolute, or "../") would let another manager's file
 * steer it, unasked. Inside the folder only, relative.
 */
export function projectConfigProblem(c: ProjectConfig): string | null {
  const file = c.workflow?.projectConfig;
  if (file === undefined) return null;
  const outside = `The workflow's projectConfig must be a path inside the project's folder, relative to it; "${file}" is not.`;
  if (path.isAbsolute(file) || path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) return outside;
  if (c.runner === 'docker') {
    const rel = path.posix.relative(c.pathInContainer, path.posix.resolve(c.pathInContainer, file));
    return rel.startsWith('..') ? outside : null;
  }
  return within(c.path, path.resolve(c.path, file)) ? null : outside;
}

/** The fields a patch changes, by name, for the tool's answer. */
export function changedFields(before: ProjectConfig, after: ProjectConfig): string[] {
  const keys = ['managerGrant', 'workflow', 'questionTiers', 'sensitive', 'devShipCommand', 'tickets', 'publishUsageName', 'usageRepo'] as const;
  // publishUsageName: a stored false is the same as none.
  const value = (c: ProjectConfig, k: typeof keys[number]) => JSON.stringify(k === 'publishUsageName' ? c[k] === true : c[k] ?? null);
  return keys.filter((k) => value(before, k) !== value(after, k));
}

/**
 * A project's workflow settings as project_settings shows them: the fields set_project_settings takes, as stored,
 * and the workflow it follows now, for information: its folder and files are the config's, shared by every project.
 */
export function settingsView(c: ProjectConfig, workflows: readonly WorkflowConfig[]): Record<string, unknown> {
  const use = c.workflow?.use ?? c.runner === 'local';
  const w = use ? chosenWorkflow(workflows, c) : undefined;
  return {
    managerGrant: c.managerGrant ?? null,
    workflow: c.workflow ?? null,
    questionTiers: tiersOf(c.questionTiers),
    sensitive: { commandPatterns: c.sensitive.commandPatterns, pathPatterns: c.sensitive.pathPatterns, mcpTools: c.sensitive.mcpTools },
    devShipCommand: c.devShipCommand ?? null,
    tickets: c.tickets ?? null,
    publishUsageName: c.publishUsageName === true,
    usageRepo: c.usageRepo ?? null,
    followsWorkflow: w
      ? { name: w.name, folder: w.folder, managerFile: w.managerFile, sessionFile: w.sessionFile, projectConfig: c.workflow?.projectConfig ?? w.projectConfig }
      : null,
  };
}
