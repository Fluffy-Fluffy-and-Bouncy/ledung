// Where the Ledung Helper's links and the step bar's "Do it myself instead" lead (docs/steps/ledung-helper.md):
// pages of Ledung's own, by the page's view ids (App.tsx). Pure, so it can be tested.
import type { ProjectInfo } from '../../../src/shared/protocol.ts';
import type { CardLink } from '../../../src/shared/helper-cards.ts';
import type { SetupStepId } from '../../../src/shared/setup.ts';

const projectGroup = (project: string, group: string) => `ps:${project}/${group}`;

/** A link card's page; null when it names a project that isn't there. */
export function helperLinkView(to: CardLink, project: string | null, projects: Pick<ProjectInfo, 'name' | 'managerId'>[]): string | null {
  const p = project ? projects.find((x) => x.name === project) : undefined;
  switch (to) {
    case 'add-project': return 'add';
    case 'accounts': return 'settings:claude';
    case 'settings': return 'settings';
    case 'devices': return 'settings:remote';
    case 'helper-settings': return 'settings:helper';
    case 'shortcuts': return 'settings:update';
    case 'checkin': return 'settings:about';
    case 'project-settings': return p ? `ps:${p.name}` : null;
    case 'workflow': return p ? `wf:${p.name}` : null;
    case 'manager': return p ? p.managerId ?? `p:${p.name}` : null;
  }
}

/** The plain form for a setup step; null: none (the name is typed in the step bar itself). */
export function myselfView(step: SetupStepId, project: string | null): string | null {
  switch (step) {
    case 'name': return null;
    case 'accounts': return 'settings:claude';
    case 'project': return 'add';
    case 'basics': return project ? projectGroup(project, 'general') : 'add';
    case 'sensitive': return project ? projectGroup(project, 'safety') : 'add';
    case 'grant': return project ? projectGroup(project, 'powers') : 'add';
    case 'workflow': return project ? `wf:${project}` : 'add';
    case 'shortcuts': return 'settings:update';
    case 'phone': return 'settings:remote';
    case 'checkin': return 'settings:about';
  }
}

const MODE: Record<string, string> = { default: 'Ask', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan' };
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Ledung's approval card in the helper's chat, in plain words (Simon's try-out, 2026-11-12): "Add the project "X"?"
 * with what it would do, instead of the tool's name. Null: a request the helper card doesn't word; the usual card shows.
 * Managers' cards elsewhere are unchanged.
 */
export function helperApprovalText(toolName: string, input: Record<string, unknown>, sensitive: string | null): { title: string; lines: string[] } | null {
  const tool = toolName.replace(/^mcp__ledung__/, '');
  const name = str(input.name) ?? str(input.project) ?? 'the project';
  const settings = [
    str(input.model) && `Model: ${str(input.model)}`,
    str(input.effort) && `Effort: ${str(input.effort)}`,
    str(input.permission_mode) && `Permission mode: ${MODE[str(input.permission_mode)!] ?? str(input.permission_mode)}`,
    str(input.manager_grant) && `Its manager may decide: ${str(input.manager_grant)}`,
    str(input.account) && `Claude account: ${str(input.account)}`,
    str(input.lockdown) && input.lockdown !== 'off' && `Lockdown: ${str(input.lockdown)}`,
  ].filter((x): x is string => !!x);
  // What a settings change loosens, as Ledung's own rule says it: the part after its colon, one line each.
  const loosened = () => (sensitive && sensitive.includes(': ') ? sensitive.slice(sensitive.indexOf(': ') + 2).split('; ') : []);
  switch (tool) {
    case 'add_project':
      return { title: `Add the project "${name}"?`, lines: [`Folder: ${str(input.folder) ?? '?'}`, ...settings] };
    case 'create_project':
      return {
        title: `Create the project "${name}"?`,
        lines: [`A new folder with git in ${str(input.parent) ?? 'your projects folder'}${input.github === true ? ', and a private GitHub repository' : ''}`, ...settings],
      };
    case 'set_project_settings':
    case 'set_project_basics':
      return { title: `Change "${name}"?`, lines: loosened().length ? loosened() : ['A change to its settings'] };
  }
  return null;
}
