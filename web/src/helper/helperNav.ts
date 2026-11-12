// Where the Ledung Helper's links and the step bar's "Do it myself instead" lead (docs/steps/ledung-helper.md):
// pages of Ledung's own, by the page's view ids (App.tsx). Pure, so it can be tested.
import type { ProjectInfo } from '../../../src/shared/protocol.ts';
import type { CardLink } from '../../../src/shared/helper-cards.ts';
import type { SetupStepId } from '../../../src/shared/setup.ts';

const projectGroup = (project: string, group: string) => `ps:${project}/${group}`;

/** What the helper is doing, in plain words, for the line above the message box (acceptance round 1, check 16). */
export function helperToolWords(tool: string): string {
  const words: Record<string, string> = {
    add_project: 'Adding the project', create_project: 'Creating the project', list_projects: 'Looking at your projects',
    project_settings: 'Reading the settings', set_project_settings: 'Changing the settings', set_project_basics: 'Changing the settings',
    setup_step: 'Moving the setup on', setup_status: 'Looking at the setup', set_user_name: 'Saving your name',
    workflow_files: 'Reading the workflow', ledung_settings: 'Reading the settings', change_ledung_setting: 'Changing the settings', propose_workflow: 'Preparing the workflow for your review', reply: 'Writing', show_card: 'Preparing a card',
  };
  if (tool === 'Skill') return "Reading Ledung's guide";
  return words[tool.replace(/^mcp__ledung__/, '')] ?? 'Working';
}

/** "Do it myself instead" leaves the setup for a page; the page offers the way back (acceptance round 1, check 18). */
export const BACK_TO_SETUP_KEY = 'ledung.backToSetup';
export function markBackToSetup(): void {
  try { sessionStorage.setItem(BACK_TO_SETUP_KEY, '1'); } catch { /* private mode: no way back offered */ }
}
export function clearBackToSetup(): void {
  try { sessionStorage.removeItem(BACK_TO_SETUP_KEY); } catch { /* as above */ }
}
export function backToSetupMarked(): boolean {
  try { return sessionStorage.getItem(BACK_TO_SETUP_KEY) === '1'; } catch { return false; }
}

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
    case 'change_ledung_setting': {
      // "a change to Ledung's settings that opens up: a; b. Risk: …  Narrower: …" (src/sessions/helper-settings.ts).
      const head = "a change to Ledung's settings that opens up: ";
      if (!sensitive?.startsWith(head)) return null;
      const body = sensitive.slice(head.length);
      const narrow = body.indexOf(' Narrower: ');
      const riskAt = body.indexOf('. Risk: ');
      const opens = body.slice(0, riskAt >= 0 ? riskAt : narrow >= 0 ? narrow : body.length).replace(/\.$/, '').split('; ').filter(Boolean);
      const risk = riskAt >= 0 ? body.slice(riskAt + 2, narrow >= 0 ? narrow : body.length).trim() : null;
      const narrower = narrow >= 0 ? body.slice(narrow + 1).trim() : null;
      if (!opens.length) return null;
      return { title: "Change Ledung's settings?", lines: [...opens, ...(risk ? [risk] : []), ...(narrower ? [`${narrower} (say so to the helper instead)`] : [])] };
    }
    case 'add_project':
      return { title: `Add the project "${name}"?`, lines: [`Folder: ${str(input.folder) ?? '?'}`, ...settings] };
    case 'create_project':
      return {
        title: `Create the project "${name}"?`,
        lines: [`A new folder with git in ${str(input.parent) ?? 'your projects folder'}${input.github === true ? ', and a private GitHub repository' : ''}`, ...settings],
      };
    case 'set_project_settings':
    case 'set_project_basics': {
      // Only a rule Ledung wrote ("a change to "X" that …: a; b") is said plainly; anything else (Ledung could not
      // check the change, a sensitive pattern) gets the usual card with the input shown (code review, finding 2).
      const lines = sensitive?.startsWith('a change to "') ? loosened().filter((l) => l.trim()) : [];
      return lines.length ? { title: `Change "${name}"?`, lines } : null;
    }
  }
  return null;
}
