// Which of the user's own skills a role gets (#300), the same rule for the session start and the page's
// picker. Martin's a on question #659: per project and per role; a skill not chosen follows the role's
// default, on for managers and off for sessions, which he sets in Settings and a project can override.

export type SkillRole = 'manager' | 'session';

/** One role's choices: on and off by name; newSkills for every skill in neither list. */
export interface RoleSkillChoices {
  newSkills?: 'on' | 'off';
  on?: string[];
  off?: string[];
}

export interface SkillChoices {
  manager?: RoleSkillChoices;
  session?: RoleSkillChoices;
}

export type SkillSource = 'personal' | 'claude.ai';

export interface SkillInfo {
  name: string;
  /** The first sentence of its description, for the picker. */
  description: string;
  source: SkillSource;
}

/** Where nothing is chosen at all (Martin, question #659): managers keep what they had, sessions start lean. */
export const BUILT_IN_NEW_SKILLS: Record<SkillRole, 'on' | 'off'> = { manager: 'on', session: 'off' };

/** What newSkills is for a role: the project's, else the defaults', else the built-in one. */
export function newSkillsFor(role: SkillRole, defaults: SkillChoices, project: SkillChoices | undefined): 'on' | 'off' {
  return project?.[role]?.newSkills ?? defaults[role]?.newSkills ?? BUILT_IN_NEW_SKILLS[role];
}

/** The defaults' own choice for a skill, else their newSkills, else the built-in one: what a project follows. */
export function defaultSkillOn(name: string, role: SkillRole, defaults: SkillChoices): boolean {
  return skillOn(name, role, defaults, undefined);
}

/**
 * Whether a skill is on for a role: the project's choice for it, else the defaults' choice for it, else
 * the project's newSkills, else the defaults' newSkills, else the built-in one.
 */
export function skillOn(name: string, role: SkillRole, defaults: SkillChoices, project: SkillChoices | undefined): boolean {
  const p = project?.[role];
  const d = defaults[role];
  if (p?.on?.includes(name)) return true;
  if (p?.off?.includes(name)) return false;
  if (d?.on?.includes(name)) return true;
  if (d?.off?.includes(name)) return false;
  return newSkillsFor(role, defaults, project) === 'on';
}

/**
 * The choices with one skill set for a role, on or off, or with null back to following what is under it.
 * A choice stays even when it equals what is under it, so a later change there doesn't move it.
 */
export function chooseSkill(choices: SkillChoices, role: SkillRole, name: string, on: boolean | null): SkillChoices {
  const r = choices[role] ?? {};
  const without = (l: string[] | undefined) => (l ?? []).filter((n) => n !== name);
  const next: RoleSkillChoices = { ...r, on: on === true ? [...without(r.on), name].sort() : without(r.on), off: on === false ? [...without(r.off), name].sort() : without(r.off) };
  if (!next.on!.length) delete next.on;
  if (!next.off!.length) delete next.off;
  return { ...choices, [role]: next };
}

/** Whether a role has a choice of its own for this skill. */
export const skillChosen = (choices: SkillChoices | undefined, role: SkillRole, name: string): boolean =>
  !!(choices?.[role]?.on?.includes(name) || choices?.[role]?.off?.includes(name));
