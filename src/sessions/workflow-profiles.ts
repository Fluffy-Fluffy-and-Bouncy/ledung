// Session profiles from the workflow (#298, decided by Martin 2026-10-23, question #700): a workflow's
// profilesFile holds profiles in Ledung's own schema, its defaultProfiles and a pluginsOff list. It is read at
// every session start, so a change to the workflow reaches the next session without a restart. Order, later
// wins: built-in full → the workflow's file → this computer's config → the project's settings → start_session.
// A profile in the config with a workflow profile's name changes it field by field; a new name is this
// computer's own. pluginsOff lists are unioned. A missing or broken file leaves the computer's profiles only,
// with a warning in Settings and in the error of a start that needed it: never a silent full.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WorkflowFiles } from '../config.ts';
import type { ProfileSource } from '../shared/protocol.ts';
import { ProfilePatchSetting, ProfileSetting, RoleProfilesSetting, validateProfiles, withoutComments, type Profile, type ProfilePatch, type RoleProfiles } from './profiles.ts';

const WorkflowProfilesFile = z.preprocess(withoutComments, z.object({
  version: z.literal(1, { message: 'version must be 1' }),
  defaultProfiles: RoleProfilesSetting.optional(),
  pluginsOff: z.array(z.string().min(1)).default([]),
  profiles: z.preprocess(withoutComments, z.record(z.string(), ProfilePatchSetting)),
}));

/**
 * What a workflow file's profile may put in its inline settings (Martin, 2026-10-23, question #708, "a — Allowlist"):
 * the file is written by agents and lands by PR, so its settings may not add hooks, switch hooks off, change the
 * environment, auth helpers or the permission mode. A profile's own MCP servers do run commands (decision #700 point 4);
 * Settings lists them, as it lists allow rules. Any other key makes the file invalid, so the fallback and its warning apply.
 */
const SETTINGS_ALLOWED = ['syncClaudeAiSkills', 'enableArtifact', 'skillOverrides', 'claudeMdExcludes', 'model', 'permissions'];
const PERMISSIONS_ALLOWED = ['allow', 'deny'];

/** The first inline settings key a workflow file's profiles may not use, as "profiles.<name>.settings.<key>", or null. */
function settingsKeyProblem(profiles: Record<string, ProfilePatch>): string | null {
  for (const [name, p] of Object.entries(profiles)) {
    const at = `profiles.${name}.settings`;
    for (const [key, value] of Object.entries(p.settings ?? {})) {
      if (!SETTINGS_ALLOWED.includes(key)) return `${at}.${key} is not allowed in a workflow's profiles file (allowed: ${SETTINGS_ALLOWED.join(', ')}).`;
      if (key !== 'permissions') continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${at}.permissions must be an object.`;
      for (const [inner, rules] of Object.entries(value)) {
        if (!PERMISSIONS_ALLOWED.includes(inner)) return `${at}.permissions.${inner} is not allowed in a workflow's profiles file (allowed: ${PERMISSIONS_ALLOWED.join(', ')}).`;
        if (!Array.isArray(rules) || rules.some((r) => typeof r !== 'string')) return `${at}.permissions.${inner} must be a list of rules.`;
      }
    }
  }
  return null;
}

/** A workflow's profiles file as read: its contents, or what is wrong with it. */
export type WorkflowProfilesRead =
  | { file: string; profiles: Record<string, ProfilePatch>; defaultProfiles: RoleProfiles; pluginsOff: string[]; problem: null }
  | { file: string; problem: string };

/** The file a workflow names, as a full path; null when it names none. */
export function profilesFilePath(workflow: Pick<WorkflowFiles, 'folder' | 'profilesFile'>): string | null {
  return workflow.profilesFile ? path.resolve(workflow.folder, workflow.profilesFile) : null;
}

/** Checks a profiles file's text; `file` is only for the messages. */
export function parseWorkflowProfiles(file: string, text: string | null): WorkflowProfilesRead {
  if (text === null) return { file, problem: `The workflow's profiles file ${file} was not found.` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { file, problem: `The workflow's profiles file ${file} is not valid JSON: ${(e as Error).message}` };
  }
  const result = WorkflowProfilesFile.safeParse(raw);
  if (!result.success) {
    return { file, problem: `The workflow's profiles file ${file} has problems: ${result.error.issues.map((i) => `${i.path.join('.') || '(top level)'}: ${i.message}`).join('; ')}` };
  }
  const { profiles, pluginsOff } = result.data;
  const defaultProfiles = result.data.defaultProfiles ?? {};
  const key = settingsKeyProblem(profiles);
  if (key) return { file, problem: `The workflow's profiles file ${file} has problems: ${key}` };
  try {
    // The same rules as the config's profiles: no "full", Ledung's own tools and server stay, defaults it defines.
    validateProfiles(profiles, defaultProfiles);
  } catch (e) {
    return { file, problem: `The workflow's profiles file ${file} has problems: ${(e as Error).message}` };
  }
  return { file, profiles, defaultProfiles, pluginsOff, problem: null };
}

/** Reads a workflow's profiles file; null when the workflow names none. */
export function readWorkflowProfiles(workflow: Pick<WorkflowFiles, 'folder' | 'profilesFile'>): WorkflowProfilesRead | null {
  const file = profilesFilePath(workflow);
  if (!file) return null;
  let text: string | null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = null;
  }
  return parseWorkflowProfiles(file, text);
}


/** The profiles a session can use, with their defaults, the plugins off for all of them, and a warning when the workflow's file couldn't be used. */
export interface EffectiveProfiles {
  profiles: Record<string, Profile>;
  sources: Record<string, ProfileSource>;
  defaults: RoleProfiles;
  pluginsOff: string[];
  warning: string | null;
}

const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * The workflow's profiles (if any, and readable) overlaid with the computer's: a same-named profile field by field,
 * the computer's defaultProfiles per role over the workflow's, pluginsOff unioned (#298 decisions 5–7).
 */
export function effectiveProfiles(
  computer: { profiles: Record<string, ProfilePatch>; defaultProfiles: RoleProfiles; pluginsOff: string[] },
  workflow: WorkflowProfilesRead | null,
): EffectiveProfiles {
  const ok = workflow && workflow.problem === null ? workflow : null;
  const profiles: Record<string, Profile> = {};
  const sources: Record<string, ProfileSource> = {};
  for (const name of new Set([...Object.keys(ok?.profiles ?? {}), ...Object.keys(computer.profiles)])) {
    const base = ok && Object.hasOwn(ok.profiles, name) ? ok.profiles[name] : undefined;
    const own = Object.hasOwn(computer.profiles, name) ? computer.profiles[name] : undefined;
    profiles[name] = ProfileSetting.parse({ ...base, ...(own ? defined(own) : {}) });
    sources[name] = base && own ? 'workflow+computer' : base ? 'workflow' : 'computer';
  }
  return {
    profiles,
    sources,
    defaults: { ...ok?.defaultProfiles, ...defined(computer.defaultProfiles) },
    pluginsOff: [...new Set([...(ok?.pluginsOff ?? []), ...computer.pluginsOff])],
    warning: workflow?.problem ? `${workflow.problem.replace(/\.?$/, '.')} Sessions use this computer's own profiles until it is fixed.` : null,
  };
}
