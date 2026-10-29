// The skill picker (#300): which of the user's own skills a project's manager and its sessions get.
// Claude Code turns one skill off with skillOverrides {"<name>": "off"} in the session's flag layer
// (checked on Claude Code 2.1.304, 2026-10-23, question #659): for personal skills (~/.claude/skills)
// and claude.ai's synced ones; an unknown name is taken without an error. Plugin skills ignore it (they
// go on and off with their plugin, the profile's plugins), so the picker offers only the user's own.
// Martin's a on question #659: chosen per project and per role; a skill not chosen follows the role's
// default, on for managers and off for sessions, which he sets in Settings and a project can override.
import { z } from 'zod';
import { skillOn, type SkillChoices, type SkillInfo, type SkillRole, type SkillSource } from '../shared/skills.ts';

export type { SkillChoices, SkillInfo };

/** A skill's name as Claude Code matches it: its folder's name. */
export const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

const SkillName = z.string().regex(SKILL_NAME, 'not a skill name');

/** One role's choices: on and off by name; newSkills for every skill in neither list. */
export const RoleSkillsSetting = z.object({
  newSkills: z.enum(['on', 'off']).optional(),
  on: z.array(SkillName).max(500).optional(),
  off: z.array(SkillName).max(500).optional(),
});

export const SkillChoicesSetting = z.object({ manager: RoleSkillsSetting.optional(), session: RoleSkillsSetting.optional() });

/** The skills found on this computer that go off for a role. */
export function skillsOff(found: string[], role: SkillRole, defaults: SkillChoices, project: SkillChoices | undefined): string[] {
  return [...new Set(found)].filter((n) => !skillOn(n, role, defaults, project)).sort();
}

/**
 * The settings with these skills off (skillOverrides), on top of what they already turn off or on.
 * The one place a list of skill names becomes Claude Code's setting, for the picker and later for
 * profiles' skillsOff (#298).
 */
export function withSkillsOff(settings: Record<string, unknown> | undefined, off: string[]): Record<string, unknown> | undefined {
  if (!off.length) return settings;
  const own = settings?.skillOverrides;
  const before = own && typeof own === 'object' && !Array.isArray(own) ? own : {};
  return { ...settings, skillOverrides: { ...before, ...Object.fromEntries(off.map((n) => [n, 'off'])) } };
}

/** A SKILL.md under Claude Code's config folder, as a runner reads it: its path there with "/", and its start. */
export interface SkillFile {
  path: string;
  text: string;
}

/**
 * The user's own skills in Claude Code's config folder: skills/<name>/SKILL.md (personal) and
 * skills/synced/<id>/<name>/SKILL.md (claude.ai's, synced by Claude Code). Sorted by name, one per name.
 */
export function skillsFromFiles(files: SkillFile[]): SkillInfo[] {
  const out = new Map<string, SkillInfo>();
  for (const f of files) {
    const parts = f.path.split('/');
    let name: string | undefined;
    let source: SkillSource;
    if (parts.length === 3 && parts[0] === 'skills' && parts[2] === 'SKILL.md' && parts[1] !== 'synced') {
      name = parts[1];
      source = 'personal';
    } else if (parts.length === 5 && parts[0] === 'skills' && parts[1] === 'synced' && parts[4] === 'SKILL.md') {
      name = parts[3];
      source = 'claude.ai';
    } else continue;
    // Hidden folders (.trash, .last-complete-round) are Claude Code's own.
    if (!name || name.startsWith('.') || !SKILL_NAME.test(name) || out.has(name)) continue;
    out.set(name, { name, description: descriptionOf(f.text), source });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The description in a SKILL.md's front matter, its first sentence or line, or "". */
export function descriptionOf(text: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const m = /^description:[ \t]*(.*)$((?:\r?\n[ \t]+.*)*)/m.exec(front);
  const head = m?.[1]?.trim() ?? '';
  // A folded or literal block (description: >-) is the indented lines after it.
  const line = /^[>|][-+]?$/.test(head) ? (m?.[2] ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ') : head;
  const plain = line.replace(/^(["'])(.*)\1$/, '$2').trim();
  const first = /^(.*?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}

/** How much of each SKILL.md a runner reads: the front matter is at the start. */
export const SKILL_HEAD_BYTES = 4096;
