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
