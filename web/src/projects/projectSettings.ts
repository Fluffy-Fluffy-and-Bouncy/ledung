// A project's settings as its form edits them, and what goes to the API: moved out of ProjectViews.tsx (issue #366)
// so the project tab's unsaved count and Ledung defaults can be tested. What toApi sends is unchanged.
import type { PermissionMode, ProjectInfo, ProfilesView } from '../../../src/shared/protocol.ts';
import { withSuggestions } from '../../../src/shared/sensitive-suggestions.ts';
import { DEFAULT_TIERS } from '../../../src/shared/questions.ts';
import type { SkillChoices } from '../../../src/shared/skills.ts';

/** The settings every project has, as the form edits them. */
export interface Settings {
  name: string;
  account: string;
  model: string;
  /** Empty: the same as its sessions. */
  managerModel: string;
  permissionMode: PermissionMode | '';
  managerGrant: string;
  /** Its manager's project tools run unasked (decision of 2026-10-14). */
  projectToolsUnasked: boolean;
  /** Its manager reads and changes projects' workflow settings (issue #306). */
  projectSettingsTools: boolean;
  /** Its usage is published by its name (issue #363). */
  publishUsageName: boolean;
  /** The usage repo it publishes to, owner/name (issue #380); empty: the computer's default one. */
  usageRepo: string;
  /** Session profiles (#20); empty: the config's default. */
  managerProfile: string;
  sessionProfile: string;
  /** Its own skill choices over Settings' defaults (#300). */
  skills: SkillChoices;
  /** The project's sensitive list: what is shown is what is enforced (sensitive-always). */
  commandPatterns: string[];
  pathPatterns: string[];
  /** The project's dev ship command, a pattern away mode may let through (issue #35). */
  devShipCommand: string;
  ticketPattern: string;
  ticketUrl: string;
  /** The order of its questions' tiers in Waiting for you, one per line (issue #59). */
  questionTiers: string;
  /** Folders outside the project its sessions may also work in (start_session's cwd), one per line. */
  extraFolders: string;
  /** Whether it follows a configured workflow; null: the default (yes on this computer, no in a container). */
  workflowUse: boolean | null;
  /** Which workflow by name (issue #132); empty: the first configured one. */
  workflowName: string;
  /** Its own path to the project config for the workflow; empty: the configured one. */
  workflowConfig: string;
  /** Lockdown (issue #109): off unless set; the board and Remote Control only if let in. */
  lockdownLevel: 'off' | 'A' | 'B';
  lockdownBoard: boolean;
  lockdownRemoteControl: boolean;
  /** Level B: hosts its shell may reach, one per line; empty: no network. */
  lockdownNetwork: string;
  /** Level B, container project: the Docker network marked as its island network. */
  lockdownDockerNetwork: string;
}

export const emptySettings = (name = ''): Settings => ({
  name, account: '', model: '', managerModel: '', permissionMode: '', managerGrant: '', projectToolsUnasked: false, projectSettingsTools: false, publishUsageName: false, usageRepo: '', managerProfile: '', sessionProfile: '', skills: {}, ...withSuggestions({ commandPatterns: [], pathPatterns: [] }), devShipCommand: '', ticketPattern: '', ticketUrl: '', questionTiers: DEFAULT_TIERS.join('\n'), extraFolders: '', workflowUse: null, workflowName: '', workflowConfig: '',
  lockdownLevel: 'off', lockdownBoard: false, lockdownRemoteControl: false, lockdownNetwork: '', lockdownDockerNetwork: '',
});

export function settingsOf(p: ProjectInfo): Settings {
  return {
    name: p.name, account: p.account ?? '', model: p.model ?? '', managerModel: p.managerModel ?? '', permissionMode: p.permissionMode ?? '', managerGrant: p.managerGrant ?? '',
    projectToolsUnasked: p.projectToolsUnasked,
    projectSettingsTools: p.projectSettingsTools === true,
    publishUsageName: p.publishUsageName === true,
    usageRepo: p.usageRepo ?? '',
    managerProfile: p.profiles.manager ?? '', sessionProfile: p.profiles.session ?? '',
    skills: p.skills,
    commandPatterns: p.sensitive.commandPatterns, pathPatterns: p.sensitive.pathPatterns, devShipCommand: p.devShipCommand ?? '',
    ticketPattern: p.tickets?.pattern ?? '', ticketUrl: p.tickets?.url ?? '',
    questionTiers: p.questionTiers.join('\n'),
    extraFolders: p.extraFolders.join('\n'),
    workflowUse: p.workflow?.use ?? null, workflowName: p.workflow?.name ?? '', workflowConfig: p.workflow?.projectConfig ?? '',
    lockdownLevel: p.lockdown.level, lockdownBoard: p.lockdown.board, lockdownRemoteControl: p.lockdown.remoteControl,
    lockdownNetwork: (p.lockdown.network ?? []).join('\n'), lockdownDockerNetwork: p.lockdown.dockerNetwork ?? '',
  };
}

/** The settings as the API takes them; empty fields are left out. */
export function toApi(s: Settings, keep: ProjectInfo | null): Record<string, unknown> {
  return {
    name: s.name.trim(),
    ...(s.model.trim() ? { model: s.model.trim() } : {}),
    ...(s.managerModel.trim() ? { managerModel: s.managerModel.trim() } : {}),
    ...(s.permissionMode ? { permissionMode: s.permissionMode } : {}),
    ...(s.managerGrant.trim() ? { managerGrant: s.managerGrant.trim() } : {}),
    ...(s.projectToolsUnasked ? { projectToolsUnasked: true } : {}),
    ...(s.projectSettingsTools ? { projectSettingsTools: true } : {}),
    ...(s.publishUsageName ? { publishUsageName: true } : {}),
    ...(s.usageRepo.trim() ? { usageRepo: s.usageRepo.trim() } : {}),
    ...(s.managerProfile || s.sessionProfile
      ? { profiles: { ...(s.managerProfile ? { manager: s.managerProfile } : {}), ...(s.sessionProfile ? { session: s.sessionProfile } : {}) } }
      : {}),
    ...(hasSkillChoices(s.skills) ? { skills: s.skills } : {}),
    sensitive: { commandPatterns: s.commandPatterns, pathPatterns: s.pathPatterns, mcpTools: keep?.sensitive.mcpTools ?? [] },
    ...(s.devShipCommand.trim() ? { devShipCommand: s.devShipCommand.trim() } : {}),
    ...(s.ticketPattern.trim() && s.ticketUrl.trim() ? { tickets: { pattern: s.ticketPattern.trim(), url: s.ticketUrl.trim() } } : {}),
    // Left out when it is the five, so a project keeps following the standard ones (issue #96).
    ...(sameTiers(tierLines(s.questionTiers), DEFAULT_TIERS) || !tierLines(s.questionTiers).length ? {} : { questionTiers: tierLines(s.questionTiers) }),
    ...(tierLines(s.extraFolders).length ? { extraFolders: tierLines(s.extraFolders) } : {}),
    ...(s.account ? { account: s.account } : {}),
    ...(s.workflowUse !== null || s.workflowName || s.workflowConfig.trim()
      ? {
        workflow: {
          ...(s.workflowUse !== null ? { use: s.workflowUse } : {}), ...(s.workflowName ? { name: s.workflowName } : {}),
          ...(s.workflowConfig.trim() ? { projectConfig: s.workflowConfig.trim() } : {}),
        },
      }
      : {}),
    // Left out when off, so an unlocked project's settings stay as they were (issue #109).
    ...(s.lockdownLevel !== 'off'
      ? {
        lockdown: {
          level: s.lockdownLevel, ...(s.lockdownBoard ? { board: true } : {}), ...(s.lockdownRemoteControl ? { remoteControl: true } : {}),
          ...(tierLines(s.lockdownNetwork).length ? { network: tierLines(s.lockdownNetwork) } : {}),
          ...(s.lockdownDockerNetwork.trim() ? { dockerNetwork: s.lockdownDockerNetwork.trim() } : {}),
        },
      }
      : {}),
  };
}

/** Whether any role has a choice of its own; none: the project follows Settings (#300). */
export const hasSkillChoices = (c: SkillChoices) => Object.values(c).some((r) => r && (r.newSkills || r.on?.length || r.off?.length));

export const tierLines = (text: string) => [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))];
const sameTiers = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/** Whether the workflow applies to these settings (issue #21). */
export const followsWorkflow = (s: Settings, container: boolean) => s.workflowUse ?? !container;

/**
 * A choice in the Workflow list (issue #132): none, or a workflow by name. Choosing one switches the
 * project on (a container is off by default); choosing none switches it off, back to the default for a container.
 */
export function chooseWorkflow(s: Settings, name: string, container: boolean): Settings {
  return name ? { ...s, workflowUse: container ? true : null, workflowName: name } : { ...s, workflowUse: container ? null : false, workflowName: '' };
}

/**
 * The project tab's groups each field is in (issue #366, mockup E): which side-menu entry gets the unsaved mark. The
 * Message board's own fields and the name colours (saved at once) are not here.
 */
export const FIELD_GROUP: Record<keyof Settings, string> = {
  name: 'general', account: 'general', model: 'general', managerModel: 'general', permissionMode: 'general', extraFolders: 'general', publishUsageName: 'general', usageRepo: 'general',
  commandPatterns: 'safety', pathPatterns: 'safety',
  managerGrant: 'powers', projectToolsUnasked: 'powers', projectSettingsTools: 'powers', devShipCommand: 'powers',
  lockdownLevel: 'powers', lockdownBoard: 'powers', lockdownRemoteControl: 'powers', lockdownNetwork: 'powers', lockdownDockerNetwork: 'powers',
  skills: 'skills', managerProfile: 'skills', sessionProfile: 'skills',
  workflowUse: 'workflow', workflowName: 'workflow', workflowConfig: 'workflow',
  ticketPattern: 'tickets', ticketUrl: 'tickets', questionTiers: 'tickets',
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields edited and not saved yet, against the saved settings: the Save bar's count and the menu's marks. */
export function changedFields(saved: Settings, edited: Settings): (keyof Settings)[] {
  return (Object.keys(FIELD_GROUP) as (keyof Settings)[]).filter((k) => !same(saved[k], edited[k]));
}

/**
 * What a field shows under its name (issue #366): "Ledung default: X" while the project follows Ledung's default, or
 * "Overrides Ledung (X)" with Reset once it has its own value. An empty value is the default for every field here.
 */
export type Inherit = { follows: true; text: string } | { follows: false; text: string };

export function inherit(value: string | boolean | object, def: string): Inherit {
  const empty = value === '' || (typeof value === 'object' && !hasSkillChoices(value as SkillChoices));
  return empty ? { follows: true, text: `Ledung default: ${def}` } : { follows: false, text: `Overrides Ledung (${def})` };
}

/** The fields Reset sets back to Ledung's default, and the value that means "the default". */
export const RESET: Partial<Record<keyof Settings, Settings[keyof Settings]>> = {
  account: '', model: '', managerModel: '', permissionMode: '', skills: {}, managerProfile: '', sessionProfile: '',
};

/**
 * The profiles Ledung gives a project's manager and sessions when it names none (#298): the defaults of the workflow it
 * follows when that has a profiles file, otherwise this computer's; "full" when nothing is configured.
 */
export function profileDefaults(view: ProfilesView | null, workflow: string | null): { manager: string; session: string } {
  const group = view?.groups.find((g) => g.workflow === workflow) ?? view?.groups.find((g) => g.workflow === null);
  return { manager: group?.defaults.manager ?? 'full', session: group?.defaults.session ?? 'full' };
}
