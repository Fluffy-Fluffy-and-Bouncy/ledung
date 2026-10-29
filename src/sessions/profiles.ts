// Session profiles (#20): what a session gets of the user's own Claude Code setup. Profiles are named
// in the config; "full" is always there and is everything, as before. Measured on a fresh Haiku session
// (2026-10-13, issue #20): plugins off saves about 4.1k tokens on every turn, other MCP servers off 1.8k,
// Workflow, ReportFindings and SendFeedback off 2.3k; all three together 6.4k of 31k.
// Ledung's own tools, hooks and permission handling are never part of a profile.
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { LEDUNG_SERVER } from './tools.ts';
import type { SessionRole } from '../shared/protocol.ts';

/** The profile every session had before profiles: the user's whole setup. Always defined. */
export const FULL_PROFILE = 'full';

export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

const McpServer = z.union([
  z.object({ type: z.literal('stdio').optional(), command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }),
  z.object({ type: z.enum(['http', 'sse']), url: z.string().min(1), headers: z.record(z.string(), z.string()).optional() }),
]);

/** A profile's fields as written, each optional: a computer's profile changes a workflow's of the same name field by field (#298). */
const ProfileFields = {
  about: z.string().optional(),
  /** "all": the user's MCP servers, plugins' and claude.ai connectors; "none": only Ledung's; or only Ledung's plus these. */
  mcpServers: z.union([z.enum(['all', 'none']), z.record(z.string(), McpServer)]),
  /** "all", "none", or the plugin ids to keep (as in Claude Code's enabledPlugins, e.g. "superpowers@claude-plugins-official"). */
  plugins: z.union([z.enum(['all', 'none']), z.array(z.string().min(1))]),
  /** Built-in or MCP tools the session doesn't get. */
  disallowedTools: z.array(z.string().min(1)),
  /** false: the user's own settings file is not read (no user hooks, MCP servers, plugins, and no user allow rules). */
  userSettings: z.boolean(),
  /** A Claude Code settings file inside the project folder, added as the session's own settings layer (--settings). */
  settingsFile: z.string().min(1).optional(),
  /** Claude Code settings written here, in the same layer as settingsFile's, which wins over them (#298). */
  settings: z.record(z.string(), z.unknown()).optional(),
};

export const ProfilePatchSetting = z.object(ProfileFields).partial();
export type ProfilePatch = z.infer<typeof ProfilePatchSetting>;

export const ProfileSetting = z.object({
  ...ProfileFields,
  mcpServers: ProfileFields.mcpServers.default('all'),
  plugins: ProfileFields.plugins.default('all'),
  disallowedTools: ProfileFields.disallowedTools.default([]),
  userSettings: ProfileFields.userSettings.default(true),
});
export type Profile = z.infer<typeof ProfileSetting>;

/** Drops keys starting with "$": they are comments, as elsewhere in the config. */
export const withoutComments = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith('$'))) : v);

/**
 * The config's profiles as written: filled in with the defaults only once they are laid over the workflow's
 * of the same name (effectiveProfiles), so a field the computer leaves out keeps the workflow's (#298).
 */
export const ProfilesSetting = z.preprocess(withoutComments, z.record(z.string(), ProfilePatchSetting)).default({});

/** A profile per role; a name left out falls through to the next place that names one. */
export const RoleProfilesSetting = z.object({ manager: z.string().optional(), session: z.string().optional() });
export type RoleProfiles = z.infer<typeof RoleProfilesSetting>;

const FULL: Profile = { mcpServers: 'all', plugins: 'all', disallowedTools: [], userSettings: true };

const ledungTool = (name: string) => name === `mcp__${LEDUNG_SERVER}` || name.startsWith(`mcp__${LEDUNG_SERVER}__`);

/** Names a rule must not reach: Ledung's server and one of its tools. */
const LEDUNG_NAMES = [`mcp__${LEDUNG_SERVER}`, `mcp__${LEDUNG_SERVER}__ask_user`];

/**
 * A tool rule that would reach Ledung's tools: one of them (with or without a "(…)" part), or a wildcard that matches
 * them ("*", "mcp__*", "mcp__led*", …). Compared without case, so no spelling of it slips through (review of #298).
 */
const takesLedungTool = (rule: string) => {
  const tool = rule.trim().replace(/\(.*$/s, '').toLowerCase();
  if (!tool.includes('*')) return ledungTool(tool);
  const glob = new RegExp(`^${tool.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return LEDUNG_NAMES.some((name) => glob.test(name));
};

/** The settings' permissions.deny and permissions.ask rules, whatever else they hold. */
function permissionRules(settings: Record<string, unknown> | undefined): { list: 'deny' | 'ask'; rule: string }[] {
  const p = settings?.permissions;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return [];
  return (['deny', 'ask'] as const).flatMap((list) => {
    const rules = (p as Record<string, unknown>)[list];
    return Array.isArray(rules) ? rules.filter((r): r is string => typeof r === 'string').map((rule) => ({ list, rule })) : [];
  });
}

/** Throws a readable error when the profiles can't be used: bad names, or one that would take Ledung's own tools. */
export function validateProfiles(profiles: Record<string, ProfilePatch>, defaults: RoleProfiles | null): void {
  for (const [name, p] of Object.entries(profiles)) {
    if (!PROFILE_NAME.test(name)) throw new Error(`profiles: "${name}" is not a usable name (letters, digits, ".", "_" or "-", at most 32).`);
    if (name === FULL_PROFILE) throw new Error(`profiles: "${FULL_PROFILE}" is built in (the user's whole setup) and can't be redefined.`);
    // Ledung's tools are present under every profile (#20).
    const taken = (p.disallowedTools ?? []).filter(takesLedungTool);
    if (taken.length) throw new Error(`profiles.${name}.disallowedTools: Ledung's own tools always stay (${taken.join(', ')}).`);
    // Through the profile's own settings too: a deny or ask rule would take them away or put them behind a prompt (review of #298).
    const rules = permissionRules(p.settings).filter((r) => takesLedungTool(r.rule));
    if (rules.length) throw new Error(`profiles.${name}.settings.permissions.${rules[0]!.list}: Ledung's own tools always stay (${rules.map((r) => r.rule).join(', ')}).`);
    if (p.settingsFile !== undefined) {
      const problem = settingsFileProblem(p.settingsFile);
      if (problem) throw new Error(`profiles.${name}.settingsFile: ${problem}`);
    }
    if (typeof p.mcpServers === 'object') {
      const clash = Object.keys(p.mcpServers).filter((k) => k === LEDUNG_SERVER);
      if (clash.length) throw new Error(`profiles.${name}.mcpServers: "${clash[0]}" is Ledung's own server's name.`);
    }
  }
  // null: the defaults may name a workflow's profiles, so they are checked when a session starts (#298).
  for (const role of ['manager', 'session'] as const) {
    if (!defaults) break;
    const name = defaults[role];
    if (name !== undefined && name !== FULL_PROFILE && !profiles[name]) throw new Error(`defaultProfiles.${role}: no profile named "${name}".`);
  }
}

/**
 * Why a profile's settingsFile can't be used, or null. It is read from the project folder, which for a
 * container project is inside the container, so it must be relative and stay inside (on either system).
 */
export function settingsFileProblem(file: string): string | null {
  // "C:x.json" is relative to drive C's current folder, not to the project.
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || /^[A-Za-z]:/.test(file)) return `"${file}" must be relative to the project folder.`;
  const normal = settingsFilePath(file);
  if (normal === '..' || normal.startsWith('../')) return `"${file}" must stay inside the project folder.`;
  if (normal === '.' || normal.endsWith('/')) return `"${file}" is a folder, not a file.`;
  return null;
}

/** The settings file's path below the project folder, with "/" (both runners accept it). */
export const settingsFilePath = (file: string) => path.posix.normalize(file.split('\\').join('/'));

/**
 * The settings a profile's settingsFile holds. Throws a readable error naming the file when it is missing
 * or isn't a JSON object, so a session never starts quietly without it.
 */
export function parseSettingsFile(file: string, text: string | null): Record<string, unknown> {
  if (text === null) throw new Error(`The profile's settings file ${file} was not found in the project folder.`);
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new Error(`The profile's settings file ${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(`The profile's settings file ${file} must hold a JSON object.`);
  return j as Record<string, unknown>;
}

/** The names a session can be started with, "full" first. */
export function profileNames(profiles: Record<string, unknown>): string[] {
  return [FULL_PROFILE, ...Object.keys(profiles)];
}

/**
 * The profile a new session gets: the one asked for, else the project's for its role, else the
 * config's default for the role, else full. Throws a readable error for a name that isn't defined.
 */
export function chooseProfile(
  asked: string | undefined, role: SessionRole, project: RoleProfiles | undefined, defaults: RoleProfiles, profiles: Record<string, Profile>,
): string {
  const name = asked?.trim() || project?.[role] || defaults[role] || FULL_PROFILE;
  profileByName(name, profiles);
  return name;
}

/** The profile with this name; throws a readable error listing the known ones when there is none. */
export function profileByName(name: string, profiles: Record<string, Profile>): Profile {
  if (name === FULL_PROFILE) return FULL;
  const p = Object.hasOwn(profiles, name) ? profiles[name] : undefined;
  if (!p) throw new Error(`There is no session profile named "${name}". Known: ${profileNames(profiles).join(', ')}.`);
  return p;
}

/** Plugin ids named in the given settings texts (enabledPlugins, and installed_plugins.json's plugins). */
export function pluginIdsIn(texts: string[]): string[] {
  const ids = new Set<string>();
  for (const text of texts) {
    try {
      const j = JSON.parse(text) as { enabledPlugins?: unknown; plugins?: unknown };
      for (const key of ['enabledPlugins', 'plugins'] as const) {
        const v = j[key];
        if (v && typeof v === 'object' && !Array.isArray(v)) for (const id of Object.keys(v)) ids.add(id);
      }
    } catch {
      // A file that isn't JSON names no plugins; Claude Code reports it itself.
    }
  }
  return [...ids].sort();
}

/**
 * The Agent SDK options for a profile. Plugins can only be turned off one by one, so it takes the
 * ids found in the session's settings; they go off in the flag layer and the user's files are not changed.
 * The profile's own settings and the settings file's contents (fileSettings) go in the same layer: Claude Code
 * takes only one --settings, so they are merged, the file over the profile's and the profile's plugins choice
 * over both. The pluginsOff lists (issue #265, the workflow's and the config's, #298) go off whatever the profile
 * and the settings say, each only where it is installed: one this computer lacks is skipped (#298 decision 7).
 */
export function profileOptions(p: Profile, pluginIds: string[], fileSettings?: Record<string, unknown>, pluginsOff: string[] = []): Partial<Options> {
  const out: Partial<Options> = {};
  if (p.mcpServers !== 'all') out.strictMcpConfig = true;
  if (typeof p.mcpServers === 'object') out.mcpServers = p.mcpServers as Options['mcpServers'];
  let settings: Record<string, unknown> | undefined = p.settings || fileSettings ? { ...p.settings, ...fileSettings } : undefined;
  const keep = new Set(Array.isArray(p.plugins) ? p.plugins : []);
  const installed = new Set(pluginIds);
  const off = [...new Set([...(p.plugins === 'all' ? [] : pluginIds.filter((id) => !keep.has(id))), ...pluginsOff.filter((id) => installed.has(id))])];
  if (off.length) {
    const own = settings?.enabledPlugins;
    const before = own && typeof own === 'object' && !Array.isArray(own) ? own : {};
    settings = { ...settings, enabledPlugins: { ...before, ...Object.fromEntries(off.map((id) => [id, false])) } };
  }
  if (settings) out.settings = settings as Options['settings'];
  if (p.disallowedTools.length) out.disallowedTools = p.disallowedTools;
  if (!p.userSettings) out.settingSources = ['project', 'local'];
  return out;
}

/** Whether the session's plugin ids must be looked up: to turn off those the profile doesn't keep, or to find which of pluginsOff are there. */
export const needsPluginIds = (p: Profile, pluginsOff: string[] = []) => p.plugins !== 'all' || pluginsOff.length > 0;
/** Whether the profile needs the plugin ids from the session's settings. */
